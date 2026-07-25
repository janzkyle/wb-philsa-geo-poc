// PhilSA map assistant — chat backend as a Cloudflare Worker (PROD entry point).
//
// This is what the deployed webmap talks to. The Node server next door
// (chat.mjs) is the DEV entry point; both are thin wrappers over chatCore.mjs,
// so the tool schemas and system prompt can't drift between dev and prod.
//
// Why a Worker and not a 5th Render service: the free Render tier sleeps after
// ~15 min idle, and the first chat message of a demo would eat a 30–60 s cold
// start. A Worker is always-on, sits next to the two gateway workers already in
// deploy/gateway/, and keeps the OpenRouter key in a Worker secret rather than
// in a container env.
//
// Deploy:  cd deploy/chat && wrangler deploy
// Config:  see deploy/chat/wrangler.toml
//   OPENROUTER_API_KEY  (secret) wrangler secret put OPENROUTER_API_KEY
//   CHAT_ALLOW_ORIGIN   (var)    comma-separated origin allowlist, NOT "*" in prod
//   GENAI_MODEL         (var)    optional; overrides the first model tried

import { createUIMessageStreamResponse } from "ai";
import { createChatStream, candidateModels, corsHeaders } from "./chatCore.mjs";

const MAX_BODY = 2_000_000;

function json(status, body, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(
      env.CHAT_ALLOW_ORIGIN,
      request.headers.get("Origin"),
    );

    // CORS preflight — the browser sends this before every POST /api/chat.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Health check: proves the key is wired and shows the model chain that a
    // real request would try, without spending a token on it.
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        return json(
          200,
          {
            ok: true,
            keyConfigured: Boolean(env.OPENROUTER_API_KEY),
            allowOrigin: env.CHAT_ALLOW_ORIGIN ?? "*",
            models: await candidateModels(env.GENAI_MODEL || undefined),
          },
          cors,
        );
      } catch (e) {
        return json(500, { error: e.message }, cors);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      try {
        // Guard the body size the same way the Node server does. Workers cap
        // request size upstream too, but a bad client shouldn't get as far as
        // JSON.parse on a huge string.
        const raw = await request.text();
        if (raw.length > MAX_BODY) {
          return json(413, { error: "Request body too large" }, cors);
        }
        const { messages, mapState } = JSON.parse(raw || "{}");

        const stream = await createChatStream({
          apiKey: env.OPENROUTER_API_KEY,
          model: env.GENAI_MODEL || undefined,
          messages,
          mapState,
        });
        return createUIMessageStreamResponse({ stream, headers: cors });
      } catch (e) {
        // ChatError carries the right status (500 misconfigured / 502 all
        // models down); anything else is an unexpected server fault.
        const status = e?.status ?? 500;
        const message =
          e?.name === "ChatError" ? e.message : `Chat server error: ${e.message}`;
        console.error(`[chat] ${message}`);
        return json(status, { error: message }, cors);
      }
    }

    return json(404, { error: "Not found" }, cors);
  },
};
