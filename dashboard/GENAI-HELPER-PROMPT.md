# GenAI Assistant Panel — Build Prompt

A self-contained loop prompt to build the GenAI assistant panel for the PhilSA POC
TerriaJS dashboard. Feed the block below to `/loop`.

## Best free OpenRouter models for this use case (ranked)

The job: reason over structured EO metadata (workbench layers, STAC fields, camera
extent, TiTiler pixel stats) and answer free-form questions. Rewards
instruction-following, reasoning, and a large context window. Vision only matters if
you add the screenshot path.

| # | Model id (`:free`) | Ctx | Vision | Why |
|---|---|---|---|---|
| 1 | `nvidia/nemotron-3-super-120b-a12b` | 1.0M | No | Best balance — strong reasoning, MoE-efficient (better free-tier availability), 1M ctx fits whole catalog + workbench. **Default.** |
| 2 | `qwen/qwen3-next-80b-a3b-instruct` | 262K | No | Excellent instruction-following + multilingual (PH place names / Filipino), fast. Primary fallback. |
| 3 | `openai/gpt-oss-120b` | 131K | No | Clean, well-behaved general chat/reasoning. |
| 4 | `meta-llama/llama-3.3-70b-instruct` | 131K | No | Reliable workhorse; last-resort text fallback. |
| 5 | `nvidia/nemotron-3-ultra-550b-a55b` | 1.0M | No | Most capable but heaviest → slower / more rate-limited on free tier. |

Vision path (if added): `google/gemma-4-31b-it` (262K), then `nvidia/nemotron-nano-12b-v2-vl` (128K).

Free tier: ~20 req/min, 50–1000 req/day; free models rotate — send a `models` fallback
array so OpenRouter auto-falls-through. `openrouter/free` (200K, vision) is an
auto-routed safety net.

---

## Loop prompt

```
Build a GenAI assistant panel for the PhilSA POC TerriaJS dashboard (dashboard/).
Work iteratively: each iteration, make ONE coherent chunk of progress, run `yarn gulp
build` (or tsc) to prove it compiles, report what changed, then continue. Stop when all
acceptance criteria pass.

## Goal
An in-app chat panel where a user can (a) click "Explain this view" to get a plain-language
interpretation of what's currently on the map, and (b) ask free-form follow-up questions
about the displayed data. It reasons over Terria's live app state — NOT a DOM scrape.

## Architecture (match existing patterns)
- Frontend: new React panel in dashboard/lib/Views/ (follow AboutButton.jsx / UserInterface.jsx
  and the MobX/observer conventions already used). Register it in index.js the same way
  PhilSAAdminSearchProvider is wired in. TerriaJS 8.12.2, React + MobX.
- State serializer: a helper (dashboard/lib/Models/) that snapshots the dashboard into a
  compact JSON context object:
    * workbench items: name, type, STAC metadata already injected by build_catalog_from_stac.py
      (platform, instrument, acquisition date, GSD, cloud cover, licence, providers), and the
      layer's legend / value range.
    * camera extent (bbox) from terria.currentViewer, and any selected admin-area focus.
    * catalog collection descriptions for the active layers.
  Keep it small and token-efficient; omit empty fields (same philosophy as the generator).
- Backend proxy: the API key MUST NOT ship to the browser. Add a small proxy endpoint (extend
  the terriajs-server, or a minimal standalone Node/serverless handler) that holds
  OPENROUTER_API_KEY (env var, documented in README-PHILSA.md, added to .gitignore'd .env),
  receives {context, messages}, calls OpenRouter chat completions, and streams the reply back.
  Add its host to serverconfig.json proxy whitelist if needed.

## OpenRouter config
- Endpoint: https://openrouter.ai/api/v1/chat/completions, Authorization: Bearer key,
  plus HTTP-Referer + X-Title headers per OpenRouter norms.
- Use a fallback model array so free-tier availability swings don't break it:
    ["nvidia/nemotron-3-super-120b-a12b:free",
     "qwen/qwen3-next-80b-a3b-instruct:free",
     "openai/gpt-oss-120b:free",
     "meta-llama/llama-3.3-70b-instruct:free"]
  (all :free). Make the array a config constant so it's easy to edit. Handle 429/5xx with a
  friendly in-panel message and let OpenRouter's native model-fallback do the rest.
- System prompt: the model is an Earth-observation dashboard assistant for the PhilSA POC. It
  explains layers, dates, NDVI/SAR/LULC value ranges, coverage, and licensing in plain language
  grounded ONLY in the provided context; it must say when something isn't in the context rather
  than invent, and include the POC "not for navigation/emergency/precise analysis" caveat when
  giving interpretive claims.

## UX
- A toggle button in the UI (map controls or menu) opens a side/bottom chat panel.
- Panel shows a chat transcript, a text input, and a canned "Explain this view" button that
  seeds the first message. Streaming responses. Loading + error states. PhilSA styling
  (reuse lib/Styles variables). Keep it unobtrusive on mobile.
- Each request re-snapshots current state so answers reflect the live map.

## Acceptance criteria
1. `yarn gulp build` succeeds; no TS errors in new files.
2. Panel opens/closes; "Explain this view" returns a coherent description of the actual active
   layers and dates currently in the workbench.
3. Free-form follow-up questions work in the same session with retained context.
4. No API key is present in any client bundle (grep the build output to confirm).
5. Falls through the model list gracefully; a down/rate-limited model shows a friendly message,
   not a crash.
6. README-PHILSA.md documents setup (env var, proxy, model list) and adds this to the feature
   list; note it as a new capability alongside the admin search.

## Nice-to-have (only after 1–6 pass)
- "Interpret pixel values": on click/current view, call TiTiler /cog/point or /statistics for
  active raster layers and feed the numbers into context so the model explains actual values
  (this also addresses the dashboard's known "no click-to-read pixel values" gap).
```
