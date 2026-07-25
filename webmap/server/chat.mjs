// PhilSA map assistant — chat backend for local development (DEV entry point).
//
// A thin Node wrapper over chatCore.mjs, which holds the tool schemas, the
// system prompt and the free-model fallback chain. Prod serves the SAME core
// from a Cloudflare Worker (worker.mjs, deployed via deploy/chat/) — keeping
// both entry points thin is what stops dev and prod drifting apart.
//
// This server holds the OpenRouter key (never shipped to the browser) and
// streams model output back as an AI SDK UI-message stream. Vite proxies
// /api → :8087 in dev so the browser talks same-origin (see vite.config.ts).
//
// Run:  npm run chat        (reads OPENROUTER_API_KEY from the repo-root .env)
// Env:  GENAI_MODEL        OpenRouter model id tried first; free fallbacks
//                          still apply (default: see chatCore.DEFAULT_MODEL)
//       CHAT_PORT          listen port (default 8087)
//       CHAT_ALLOW_ORIGIN  CORS allowlist (default "*" — prod pins this)

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeUIMessageStreamToResponse } from "ai";
import {
  createChatStream,
  candidateModels,
  corsHeaders,
  DEFAULT_MODEL as CORE_DEFAULT_MODEL,
} from "./chatCore.mjs";

// --- env: same convention as the pipelines - secrets live in repo-root .env --
function loadRepoRootEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== dirname(dir)) {
    const candidate = join(dir, ".env");
    if (existsSync(join(dir, "AGENTS.md")) || existsSync(join(dir, ".git"))) {
      if (existsSync(candidate)) {
        for (const line of readFileSync(candidate, "utf8").split("\n")) {
          const t = line.trim();
          if (!t || t.startsWith("#") || !t.includes("=")) continue;
          const [k, ...rest] = t.split("=");
          const v = rest
            .join("=")
            .trim()
            .replace(/^['"]|['"]$/g, "");
          process.env[k.trim()] ??= v;
        }
      }
      return;
    }
    dir = dirname(dir);
  }
}
loadRepoRootEnv();

const PORT = Number(process.env.CHAT_PORT) || 8087;
const DEFAULT_MODEL = process.env.GENAI_MODEL || CORE_DEFAULT_MODEL;
const API_KEY = process.env.OPENROUTER_API_KEY;
const ALLOW_ORIGIN = process.env.CHAT_ALLOW_ORIGIN || "*";

const cors = (req) => corsHeaders(ALLOW_ORIGIN, req.headers.origin);

function sendJson(req, res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", ...cors(req) });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
    if (chunks.reduce((n, c) => n + c.length, 0) > 2_000_000) {
      throw new Error("Request body too large");
    }
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function handleChat(req, res) {
  const { messages, mapState } = await readJson(req);
  const stream = await createChatStream({
    apiKey: API_KEY,
    model: DEFAULT_MODEL,
    messages,
    mapState,
  });
  return pipeUIMessageStreamToResponse({
    response: res,
    stream,
    headers: cors(req),
  });
}

const server = createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors(req));
    return res.end();
  }
  if (req.method === "GET" && req.url === "/health") {
    return candidateModels(DEFAULT_MODEL)
      .then((models) =>
        sendJson(req, res, 200, {
          ok: true,
          keyConfigured: Boolean(API_KEY),
          models,
        }),
      )
      .catch((e) => sendJson(req, res, 500, { error: e.message }));
  }
  if (req.method === "POST" && req.url === "/api/chat") {
    return handleChat(req, res).catch((e) =>
      // ChatError carries its own status (500 misconfigured / 502 all models
      // down); anything else is an unexpected server fault.
      sendJson(
        req,
        res,
        e?.status ?? 500,
        {
          error:
            e?.name === "ChatError"
              ? e.message
              : `Chat server error: ${e.message}`,
        },
      ),
    );
  }
  sendJson(req, res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`[chat] listening on http://localhost:${PORT}`);
  console.log(`[chat] default model: ${DEFAULT_MODEL} (+ free fallbacks)`);
  console.log(`[chat] OPENROUTER_API_KEY ${API_KEY ? "set" : "MISSING"}`);
  // warm the free-model cache so the first chat doesn't pay the catalog fetch
  candidateModels(DEFAULT_MODEL).then((l) =>
    console.log(`[chat] free fallbacks ready: ${l.slice(0, 4).join(", ")}…`),
  );
});
