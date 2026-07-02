// End-to-end test of the proxy's streaming path WITHOUT a real OpenRouter key.
//
// It stands up a fake "OpenRouter" upstream, points the real proxy at it via
// OPENROUTER_URL, then drives a two-turn conversation through /api/chat and
// checks that:
//   1. the proxy forwards the free-model `models` fallback array,
//   2. it injects the dashboard context snapshot as a system turn,
//   3. it retains the full conversation history (the mechanic behind
//      free-form follow-up questions), and
//   4. it streams the upstream SSE back verbatim so the client can reassemble
//      the assistant reply.
//
// Run:  node genai-proxy/test/mock-upstream-test.mjs   (exit 0 = pass)

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "server.js");
const UPSTREAM_PORT = 8091;
const PROXY_PORT = 8092;

let received; // the request body the proxy forwarded to "OpenRouter"

function startUpstream() {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received = JSON.parse(body);
        // Respond exactly like OpenRouter's streaming API.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":"world"}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    srv.listen(UPSTREAM_PORT, () => resolve(srv));
  });
}

function startProxy() {
  const proc = spawn("node", [SERVER], {
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_URL: `http://localhost:${UPSTREAM_PORT}`,
      GENAI_PROXY_PORT: String(PROXY_PORT)
    },
    stdio: "ignore"
  });
  return proc;
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://localhost:${PROXY_PORT}/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("proxy did not become healthy");
}

function assert(cond, msg) {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok - ${msg}`);
}

async function main() {
  const upstream = await startUpstream();
  const proxy = startProxy();
  try {
    await waitForHealth();

    // A two-turn conversation, with a dashboard context snapshot.
    const payload = {
      context: {
        activeLayers: [{ name: "Sentinel-2 NDVI", type: "url-template-imagery" }]
      },
      messages: [
        { role: "user", content: "What is on the map?" },
        { role: "assistant", content: "An NDVI layer." },
        { role: "user", content: "Is it recent?" }
      ]
    };

    const res = await fetch(`http://localhost:${PROXY_PORT}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    assert(res.ok, "proxy returns 200 for a valid chat request");
    assert(
      (res.headers.get("content-type") || "").includes("text/event-stream"),
      "proxy responds as an SSE stream"
    );

    // Reassemble the streamed assistant text the way the frontend does.
    const raw = await res.text();
    let assistant = "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (d === "[DONE]") continue;
      assistant += JSON.parse(d)?.choices?.[0]?.delta?.content ?? "";
    }
    assert(assistant === "Hello world", "client reassembles streamed reply");

    // Now check what the proxy forwarded upstream.
    assert(Array.isArray(received.models), "forwards a models fallback array");
    assert(
      received.models[0] === "nvidia/nemotron-3-super-120b-a12b:free",
      "top free model is first in the fallback order"
    );
    assert(received.stream === true, "requests a streamed completion");

    const roles = received.messages.map((m) => m.role);
    assert(roles[0] === "system", "system prompt leads the messages");
    assert(
      received.messages.some(
        (m) => m.role === "system" && m.content.includes("Sentinel-2 NDVI")
      ),
      "dashboard context snapshot is injected"
    );
    const userTurns = received.messages.filter((m) => m.role === "user");
    assert(
      userTurns.length === 2 &&
        userTurns[1].content === "Is it recent?" &&
        received.messages.some(
          (m) => m.role === "assistant" && m.content === "An NDVI layer."
        ),
      "full conversation history is retained (follow-up context)"
    );

    console.log("\nPASS — proxy streaming path verified end-to-end (no real key).");
  } finally {
    proxy.kill();
    upstream.close();
  }
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
