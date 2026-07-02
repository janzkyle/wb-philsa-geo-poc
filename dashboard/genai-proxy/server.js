// Minimal, zero-dependency proxy for the PhilSA POC GenAI assistant.
//
// Why it exists: the OpenRouter API key must never ship to the browser. The
// TerriaJS app POSTs {context, messages} here; this process holds the key, calls
// OpenRouter with our free-model fall-through list, and streams the reply back.
//
// Run:  OPENROUTER_API_KEY=sk-... node genai-proxy/server.js
// Node >= 20 (uses the built-in fetch + web streams). No npm install needed.

import { createServer } from "node:http";

const PORT = Number(process.env.GENAI_PROXY_PORT) || 8084;
const API_KEY = process.env.OPENROUTER_API_KEY;
// Overridable so integration tests can point at a mock upstream (see test/).
const OPENROUTER_URL =
  process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";

// This is the single source of truth for the model fall-through order.
// NOTE: OpenRouter caps this array at 3 items — more is a hard 400.
const MODELS = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-120b:free"
];

const SYSTEM_PROMPT = [
  "You are the assistant for the PhilSA POC Geo Data Dashboard, a TerriaJS map",
  "of Philippine Earth-observation layers (Sentinel-2 NDVI, Sentinel-1 SAR,",
  "ESRI land cover, true-colour imagery, Diwata-2, and administrative boundaries).",
  "",
  "You are given a JSON snapshot of what the user currently has on screen: the",
  "active layers with their STAC metadata (platform, instrument, acquisition date,",
  "resolution, cloud cover, licence, providers), each layer's legend / value range,",
  "and the current map extent. Answer questions about that view in plain language.",
  "",
  "Rules:",
  "- Ground every claim ONLY in the provided context. If something is not in the",
  "  snapshot, say you don't have that information rather than guessing.",
  "- Explain what layers mean (NDVI near 1 = dense healthy vegetation; SAR",
  "  backscatter in dB; land-cover classes) and what the current combination shows.",
  "- When you make an interpretive claim about conditions on the ground, add a brief",
  "  caveat that this is a proof-of-concept and the layers must not be used for",
  "  navigation, emergency response, or precise spatial analysis.",
  "- Be concise. Prefer short paragraphs and bullet points.",
  "- Format replies in light Markdown (bold, bullet/numbered lists, short",
  "  headings, inline code). Do NOT use Markdown tables — the chat panel is",
  "  narrow; present any comparison as a bulleted list instead."
].join("\n");

const CORS = {
  "Access-Control-Allow-Origin": process.env.GENAI_ALLOW_ORIGIN || "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function send(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...CORS,
    ...extraHeaders
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    // guard against oversized payloads (~1MB is plenty for context + chat)
    if (chunks.reduce((n, c) => n + c.length, 0) > 1_000_000) {
      throw new Error("Request body too large");
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// Compose the OpenRouter message list: system prompt, the dashboard snapshot as
// a system-role context turn, then the conversation so far.
function buildMessages({ context, messages }) {
  const convo = Array.isArray(messages)
    ? messages
        .filter((m) => m && typeof m.content === "string" && m.role)
        .map((m) => ({ role: m.role, content: m.content }))
    : [];

  const out = [{ role: "system", content: SYSTEM_PROMPT }];
  if (context) {
    out.push({
      role: "system",
      content:
        "Current dashboard view (JSON snapshot):\n" +
        JSON.stringify(context, null, 2)
    });
  }
  return out.concat(convo);
}

async function handleChat(req, res) {
  if (!API_KEY) {
    return send(res, 500, {
      error: "Proxy misconfigured: OPENROUTER_API_KEY is not set."
    });
  }

  let payload;
  try {
    payload = await readJson(req);
  } catch (e) {
    return send(res, 400, { error: `Bad request: ${e.message}` });
  }

  const orRes = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      // OpenRouter attribution headers (recommended).
      "HTTP-Referer":
        process.env.GENAI_REFERER || "https://philsa-poc.local/dashboard",
      "X-Title": "PhilSA POC Dashboard"
    },
    body: JSON.stringify({
      models: MODELS, // fall-through order; OpenRouter drops to next on error
      messages: buildMessages(payload),
      stream: true,
      temperature: 0.3
    })
  });

  if (!orRes.ok || !orRes.body) {
    const detail = await orRes.text().catch(() => "");
    return send(res, orRes.status || 502, {
      error: "Upstream model request failed.",
      status: orRes.status,
      detail: detail.slice(0, 500)
    });
  }

  // Stream the Server-Sent Events straight through to the browser.
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...CORS
  });

  try {
    for await (const chunk of orRes.body) {
      res.write(chunk);
    }
  } catch {
    // client disconnected or upstream aborted mid-stream
  } finally {
    res.end();
  }
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method === "GET" && req.url === "/health") {
    return send(res, 200, { ok: true, keyConfigured: Boolean(API_KEY) });
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    return handleChat(req, res).catch((e) =>
      send(res, 500, { error: `Proxy error: ${e.message}` })
    );
  }
  send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[genai-proxy] listening on http://localhost:${PORT}`);
  console.log(
    `[genai-proxy] OPENROUTER_API_KEY ${API_KEY ? "set" : "MISSING"}`
  );
});
