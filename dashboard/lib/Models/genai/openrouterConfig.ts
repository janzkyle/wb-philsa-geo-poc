// Configuration for the PhilSA POC GenAI assistant panel.
//
// The assistant talks to OpenRouter *through a proxy* (genai-proxy/server.js) so
// the API key never reaches the browser. Only the proxy URL, the model
// fall-through order and the system prompt live client-side.

/**
 * Free OpenRouter models, in fall-through order (best first). The proxy passes
 * this whole array to OpenRouter, which automatically drops to the next model on
 * error / rate-limit — important because free-tier models rotate and throttle.
 *
 * NOTE: OpenRouter caps this fallback array at **3 items** — sending more is a
 * hard 400 ("'models' array must have 3 items or fewer.").
 *
 * Ranked for this use case (reasoning over structured EO metadata + open chat):
 *  1. nemotron-3-super-120b — strong reasoning, 1M ctx, MoE (good free-tier uptime)
 *  2. qwen3-next-80b        — excellent instruction-following + multilingual, fast
 *  3. gpt-oss-120b          — clean general chat/reasoning fallback
 * (meta-llama/llama-3.3-70b-instruct:free is a good 4th choice but doesn't fit
 * the 3-item cap; swap it in above if you prefer it.)
 */
export const OPENROUTER_MODELS: string[] = [
  "nvidia/nemotron-3-super-120b-a12b:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "openai/gpt-oss-120b:free"
];

/**
 * Where the browser sends chat requests. This is our own proxy, not OpenRouter
 * directly. Overridable at runtime via `window.GENAI_PROXY_URL` (set in
 * index.html or the console) so the same bundle works across environments
 * without a rebuild; defaults to the local proxy dev port.
 */
export function genaiProxyUrl(): string {
  const override = (globalThis as { GENAI_PROXY_URL?: string }).GENAI_PROXY_URL;
  return override && override.length > 0
    ? override
    : "http://localhost:8084/api/chat";
}

/**
 * System prompt: grounds the model in the PhilSA POC domain and forbids
 * inventing facts not present in the serialized dashboard context.
 */
export const SYSTEM_PROMPT = [
  "You are the assistant for the PhilSA POC Space Data Dashboard, a TerriaJS map",
  "of Philippine Earth-observation layers (Sentinel-2 NDVI, Sentinel-1 SAR,",
  "ESRI land cover, true-colour imagery, Diwata-2, and administrative",
  "boundaries).",
  "",
  "You are given a JSON snapshot of what the user currently has on screen: the",
  "active layers with their STAC metadata (platform, instrument, acquisition",
  "date, resolution, cloud cover, licence, providers), each layer's legend /",
  "value range, and the current map extent. Answer questions about that view in",
  "plain, non-technical language.",
  "",
  "Rules:",
  "- Ground every claim ONLY in the provided context. If something is not in the",
  "  snapshot, say you don't have that information rather than guessing.",
  "- Explain what layers mean (e.g. NDVI near 1 = dense healthy vegetation; SAR",
  "  backscatter in dB; land-cover classes) and what the current combination",
  "  shows, using the metadata given.",
  "- When you make an interpretive claim about conditions on the ground, add a",
  "  brief caveat that this is a proof-of-concept and the layers must not be used",
  "  for navigation, emergency response, or precise spatial analysis.",
  "- Be concise. Prefer short paragraphs and bullet points.",
  "- Format replies in light Markdown (bold, bullet/numbered lists, short",
  "  headings, inline code). Do NOT use Markdown tables — the chat panel is",
  "  narrow; present any comparison as a bulleted list instead."
].join("\n");
