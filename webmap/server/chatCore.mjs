// Runtime-agnostic core of the map assistant's chat backend.
//
// Everything here works on BOTH Node (server/chat.mjs, the dev server) and the
// Cloudflare Workers runtime (server/worker.mjs, what prod actually serves) -
// so there is exactly one copy of the tool schemas, the system prompt and the
// free-model fallback chain. Nothing in this file may import node:* built-ins
// or read process.env: all config arrives as arguments, because a Worker gets
// its config per-request from `env`, not from the process.
//
// The two entry points are thin: they parse a request, call createChatStream(),
// and adapt the returned UI-message stream to their runtime's response type.
//
// Every tool is schema-only (no `execute`): the AI SDK forwards calls to the
// browser, where src/ai/executeTool.ts runs them against the STAC API and the
// map's layer store, then the chat auto-continues with the results. Keep the
// schemas in sync with that file.

import { streamText, convertToModelMessages } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

// qwen/qwen3-coder:free was depaywalled by OpenRouter (now errors "unavailable
// for free") - nemotron is the current best free tool-caller in the catalog.
export const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b:free";

// --- free-model fallback chain ------------------------------------------------
// Hand-ranked free models with solid multi-step tool calling (best first);
// catalog models not listed here rank after these, by context length.
// Super 120B leads (fast enough for interactive use), Ultra 550B next (most
// capable free model, but slower / tighter rate limits). qwen3-coder,
// gpt-oss-120b, and llama-3.3-70b were dropped from OpenRouter's free tier.
const PREFERRED_FREE = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "tencent/hy3:free",
  "poolside/laguna-m.1:free",
  "google/gemma-4-31b-it:free",
];

// Models that are free but a poor fit: router aliases (unpredictable) and
// small/reasoning-only variants that fumble tool chains.
const EXCLUDE_FREE = /^openrouter\/|nano|mini|\b\d+(\.\d+)?b-thinking|-1\.2b/;

let freeCache = { at: 0, list: [] };

// Free + tools-capable model ids from OpenRouter's live catalog, ranked.
// Cached 10 min; falls back to PREFERRED_FREE if the catalog is unreachable.
// The cache is per-isolate, which is right on both runtimes: a Node process
// keeps it for its lifetime, a Worker isolate for as long as it stays warm.
export async function freeToolModels() {
  if (freeCache.list.length && Date.now() - freeCache.at < 10 * 60_000) {
    return freeCache.list;
  }
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) throw new Error(`models catalog ${res.status}`);
    const { data } = await res.json();
    const rank = (id) => {
      const i = PREFERRED_FREE.indexOf(id);
      return i === -1 ? PREFERRED_FREE.length : i;
    };
    const free = (data ?? [])
      .filter(
        (m) =>
          m?.pricing?.prompt === "0" &&
          (m.supported_parameters ?? []).includes("tools") &&
          !EXCLUDE_FREE.test(m.id),
      )
      .sort(
        (a, b) =>
          rank(a.id) - rank(b.id) ||
          (b.context_length ?? 0) - (a.context_length ?? 0),
      )
      .map((m) => m.id);
    if (free.length) freeCache = { at: Date.now(), list: free };
  } catch (e) {
    console.warn(`[chat] free-model catalog fetch failed: ${e.message}`);
  }
  return freeCache.list.length ? freeCache.list : PREFERRED_FREE;
}

// The models to try for one request, in order: configured default first, then
// the ranked free list (deduped). Length-capped - each retry costs a round trip.
export async function candidateModels(defaultModel = DEFAULT_MODEL) {
  const free = await freeToolModels();
  return [defaultModel, ...free.filter((id) => id !== defaultModel)].slice(0, 5);
}

// Chunk types that prove the model is actually answering - an error before
// any of these means "try the next model"; an error after them streams to the
// user (can't cleanly retry a half-delivered answer).
const SUBSTANTIVE = new Set([
  "text-start",
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
]);

// Tool schemas only - execution happens in the browser (src/ai/executeTool.ts).
export const tools = {
  list_collections: {
    description:
      "List the STAC collections in the PhilSA catalog (id, title, description, temporal extent). Use when the user asks what data exists or you need to verify a collection id.",
    inputSchema: z.object({}),
  },
  resolve_region: {
    description:
      "Resolve a Philippine place name (region, province, city/municipality) to its bounding box using the official admin-boundary index. ALWAYS use this for place names - never guess coordinates.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("Place name, e.g. 'Central Luzon' or 'Pampanga'"),
      level: z
        .number()
        .int()
        .min(0)
        .max(3)
        .optional()
        .describe(
          "Restrict to an admin level: 0=country 1=region 2=province 3=city/municipality",
        ),
    }),
  },
  resolve_point: {
    description:
      "Convert an explicit coordinate the user supplied (WGS84 latitude/longitude in decimal degrees) into a bounding box for search_catalog and set_view. Use this - NOT resolve_region - whenever the user gives raw coordinates instead of a place name. radius_km sets the half-size of the square box around the point (default 5).",
    inputSchema: z.object({
      lat: z
        .number()
        .min(-90)
        .max(90)
        .describe("Latitude in decimal degrees (Philippines is ~5–20°N)"),
      lon: z
        .number()
        .min(-180)
        .max(180)
        .describe("Longitude in decimal degrees (Philippines is ~117–127°E)"),
      radius_km: z
        .number()
        .positive()
        .max(500)
        .optional()
        .describe(
          "Half-size of the bounding box around the point, in km (default 5)",
        ),
    }),
  },
  highlight_location: {
    description:
      "Draw a highlight on the map for a location the user mentioned: a translucent rectangle over the bounding box plus a marker at its center. Pass the bbox from resolve_region or resolve_point. Use it when the user asks where a place is, or alongside a display request so they can see exactly where you focused. A new highlight replaces the previous one; remove_layers(['highlight']) clears it.",
    inputSchema: z.object({
      bbox: z
        .array(z.number())
        .length(4)
        .describe(
          "[west, south, east, north] in WGS84 degrees (from resolve_region/resolve_point)",
        ),
      label: z
        .string()
        .optional()
        .describe(
          "Name of the place, shown as the layer label, e.g. 'Pampanga'",
        ),
    }),
  },
  search_catalog: {
    description:
      "Search the STAC catalog for imagery/data items. Filter by collections, a bounding box, and/or a datetime range. Returns matched items grouped by acquisition date; when nothing matches the date range it returns each collection's available dates instead - offer the nearest to the user.",
    inputSchema: z.object({
      collections: z
        .array(z.string())
        .optional()
        .describe("STAC collection ids, e.g. ['sentinel1-flood']"),
      bbox: z
        .array(z.number())
        .length(4)
        .optional()
        .describe(
          "[west, south, east, north] in WGS84 degrees (from resolve_region)",
        ),
      datetime: z
        .string()
        .optional()
        .describe(
          "ISO date or range: '2026-06-01/2026-06-07', or a single 'YYYY-MM-DD'",
        ),
      limit: z.number().int().positive().max(200).optional(),
    }),
  },
  get_available_dates: {
    description:
      "List every acquisition date available in one collection (sorted ascending). Cheaper than search_catalog when you only need dates. Also returns multi_pass_dates: dates whose per-date mosaic combines several satellite passes (different orbit/look geometry) - warn the user those aren't a single coherent observation.",
    inputSchema: z.object({
      collection: z.string(),
    }),
  },
  add_layers: {
    description:
      "Add raster layers to the map. Each layer is one collection, and for per-date collections one acquisition date (YYYY-MM-DD) found via search_catalog. The map styles each collection appropriately (flood mask, NDVI ramp, SAR grayscale, true colour, land-cover classes). Adding an already-present layer refreshes it.",
    inputSchema: z.object({
      layers: z
        .array(
          z.object({
            collection: z.string(),
            date: z
              .string()
              .optional()
              .describe(
                "YYYY-MM-DD; required for per-date collections, omit for esri-10m-lulc",
              ),
          }),
        )
        .min(1),
    }),
  },
  remove_layers: {
    description:
      "Remove layers from the map by id (ids are listed in the current map state).",
    inputSchema: z.object({
      ids: z.array(z.string()).min(1),
    }),
  },
  update_layer: {
    description:
      "Toggle a layer's visibility or set its opacity (0–1) without removing it. Layer ids are in the current map state (admin outlines: adm0, adm1, adm2).",
    inputSchema: z.object({
      id: z.string(),
      visible: z.boolean().optional(),
      opacity: z.number().min(0).max(1).optional(),
    }),
  },
  set_view: {
    description:
      "Fly the map to a bounding box [west, south, east, north] - typically the bbox from resolve_region after adding layers there.",
    inputSchema: z.object({
      bbox: z.array(z.number()).length(4),
    }),
  },
};

export const SYSTEM_PROMPT = `You are the map assistant for the PhilSA POC geospatial platform - a STAC catalog of Earth-observation data over the Philippines, shown on an interactive web map that you control through tools.

The user can also drive the map manually; you both mutate the same layer state, which is provided to you each turn as "Current map state".

Data collections you can display (ids for search_catalog / add_layers):
- sentinel1-flood - radar-derived open-water/flood mask. POC proxy, NOT a validated flood product; for real decisions point users to Copernicus EMS/GFM.
- sentinel1-sar - Sentinel-1 VV backscatter (grayscale radar; works through cloud).
- sentinel1-ratio - radar vegetation index (VH/VV ratio; rises with crop canopy, works through cloud - use for crop/vegetation questions in cloudy weeks when NDVI has no clear view).
- sentinel2-truecolor - natural-colour Sentinel-2 imagery.
- sentinel2-ndvi - vegetation greenness index.
- esri-10m-lulc - annual land-cover classes (date-independent: no date needed).
Other catalog collections (diwata-2, mula, planetscope, skysat) are metadata-only references - searchable but not displayable as map layers.

How to fulfil a display request like "show flood data for <place> between <dates>":
1. resolve_region for the place name (never guess coordinates). If several plausible matches, pick the best and mention the choice. If the user instead gives an explicit coordinate (latitude/longitude), use resolve_point - not resolve_region - to turn it into a bbox.
2. search_catalog with the collection(s), the bbox, and the datetime range.
3. add_layers for the date(s) found - prefer the most relevant few, not all.
4. set_view to the region's bbox (the bbox from resolve_region or resolve_point).
Then summarize in one or two sentences what is now on the map, including the acquisition date(s).

If the user simply asks where a place is (no data to display), resolve it and call highlight_location with the bbox, then set_view - that marks the spot without adding any raster. You may also highlight_location alongside a data display so the focus area is obvious.

Rules:
- Ground every factual claim in tool results or the map state - never invent dates, coverage, or place names.
- If the requested date range has no data, say so and offer the nearest available dates (search_catalog returns them).
- Interpretive claims about ground conditions get a brief caveat: this is a proof-of-concept, not for navigation or emergency response.
- Be concise. Plain text with simple dashes for lists - no markdown headings or tables.
- Dates are ISO (YYYY-MM-DD); the map covers the Philippines only.`;

// The system prompt for one turn: the static instructions plus today's date and
// the live map state the browser sent with the request.
export function buildSystem(mapState) {
  return (
    SYSTEM_PROMPT +
    `\n\nToday's date: ${new Date().toISOString().slice(0, 10)}` +
    (mapState
      ? `\n\nCurrent map state (live):\n${JSON.stringify(mapState)}`
      : "")
  );
}

// Thrown when every candidate model failed; carries the HTTP status the entry
// points should return so they don't have to classify the failure themselves.
export class ChatError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "ChatError";
    this.status = status;
  }
}

// Run one chat turn against the candidate models, returning a UI-message stream
// from the first model that actually produces output.
//
// The peek-then-replay dance is the fallback mechanism: we read the head of each
// model's stream until it either errors (-> try the next model) or emits a
// substantive chunk (-> commit to it, replaying what we consumed). A model that
// half-answers and then dies is NOT retried; that error streams to the user.
export async function createChatStream({
  apiKey,
  model: defaultModel = DEFAULT_MODEL,
  messages,
  mapState,
}) {
  if (!apiKey) {
    throw new ChatError(
      "Chat server misconfigured: OPENROUTER_API_KEY is not set.",
      500,
    );
  }

  const openrouter = createOpenAICompatible({
    name: "openrouter",
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
  });

  const system = buildSystem(mapState);
  // The browser sends AI SDK *UI* messages (with tool-call parts); the model
  // wants model messages. Convert once, outside the candidate loop.
  const modelMessages = await convertToModelMessages(messages ?? []);
  const candidates = await candidateModels(defaultModel);
  let lastError = "no models attempted";

  for (const model of candidates) {
    const result = streamText({
      model: openrouter(model),
      system,
      messages: modelMessages,
      tools,
      temperature: 0.2,
      // the candidate chain IS the retry - don't also retry per model, and
      // don't let the SDK dump full stack traces (we log one line ourselves)
      maxRetries: 0,
      onError: () => {},
    });
    const uiStream = result.toUIMessageStream({
      onError: (e) => (e instanceof Error ? e.message : String(e)),
    });

    // Peek until the stream proves itself (substantive chunk) or fails.
    const reader = uiStream.getReader();
    const peeked = [];
    let ok = false;
    let failText = "";
    while (peeked.length < 20) {
      const { value, done } = await reader.read();
      if (done) break; // ended without substance - treat as failure
      peeked.push(value);
      if (value.type === "error") {
        failText = value.errorText ?? "unknown model error";
        break;
      }
      if (SUBSTANTIVE.has(value.type)) {
        ok = true;
        break;
      }
    }

    if (!ok) {
      lastError = failText || "stream ended without output";
      console.warn(`[chat] ${model} failed (${lastError}) - trying next`);
      reader.cancel().catch(() => {});
      continue;
    }

    if (model !== candidates[0]) console.log(`[chat] fell back to ${model}`);
    // Replay the peeked chunks, then hand the rest of the stream through.
    return new ReadableStream({
      async start(controller) {
        for (const chunk of peeked) controller.enqueue(chunk);
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } finally {
          controller.close();
        }
      },
    });
  }

  console.error(`[chat] all ${candidates.length} models failed: ${lastError}`);
  throw new ChatError(
    `All models failed (tried ${candidates.length}). Last error: ${lastError}`,
  );
}

// --- CORS ---------------------------------------------------------------------
// Prod pins this to the webmap's origin (CHAT_ALLOW_ORIGIN) so a stray visitor
// can't spend the OpenRouter key from their own page. The value is a
// comma-separated allowlist; "*" keeps the old open behaviour for local dev.
// We echo back the matching Origin rather than the whole list, because
// Access-Control-Allow-Origin accepts exactly one value - hence Vary: Origin so
// caches don't serve one origin's answer to another.
export function corsHeaders(allowOrigin, requestOrigin) {
  const list = (allowOrigin || "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const open = list.includes("*");
  const allowed = open
    ? "*"
    : list.includes(requestOrigin)
      ? requestOrigin
      : list[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...(open ? {} : { Vary: "Origin" }),
  };
}
