# PhilSA POC - Geo webmap

MapLibre webmap for the PhilSA POC catalog with two ways to drive it:

- **Browse** - a layer panel listing the raster collections (pick an
  acquisition date, add, toggle, restyle) and the admin-boundary overlays.
- **Ask** - a chat assistant ("show flood data for Central Luzon in early
  June") that resolves the region, searches the STAC catalog, adds the layers,
  and flies the map there.

## Architecture: one store, two drivers

All map content lives in a single serializable Zustand store
(`src/state/mapStore.ts`). The layer panel mutates it on click; the AI mutates
it through **client-executed tools**. The chat server only declares tool
schemas and streams the model (Vercel AI SDK) - every tool call is forwarded to
the browser and executed in `src/ai/executeTool.ts` against the STAC API + the
store. The map itself never leaves the client.

The chat server is **one core with two entry points**, so dev and prod can't
drift apart:
- `server/chatCore.mjs` - tool schemas, system prompt, model fallback chain.
  Runtime-agnostic: no `node:*` imports, no `process.env`.
- `server/chat.mjs` - Node wrapper, **dev** (`npm run chat`, :8087).
- `server/worker.mjs` - Cloudflare Worker wrapper, **prod** (deployed from
  `deploy/chat/`; see `deploy/DEPLOYMENT.md` Step 4b).

Tools: `list_collections` · `resolve_region` (name→bbox via the R2
`ph_admin_index.json` the dashboard search uses) · `search_catalog` (pgSTAC
`/search`; on zero hits returns each collection's available dates) ·
`get_available_dates` · `add_layers` · `remove_layers` · `update_layer` ·
`set_view`.

Rendering: rasters via TiTiler - per-date **MosaicJSON** when
`build_raster_mosaics.sh` has built one, falling back to per-item COG tiles
(the flood collection has no mosaics yet); admin outlines stream PMTiles from
public R2. Collection styling (rescales/colormaps/legends) is in
`src/config.ts` and mirrors `pipelines/03-gold/catalog_silver.py`.

## Run

Needs the local STAC API (:8082) and TiTiler (:8083) up - see the repo README.

```bash
npm install
npm run chat   # terminal 1 - chat backend on :8087
npm run dev    # terminal 2 - Vite dev server (proxies /api → :8087)
```

The chat backend reads `OPENROUTER_API_KEY` from the **repo-root `.env`**
(same convention as the pipelines; never committed). Without a key, the map +
manual browsing still work; only chat is disabled.

**Models - free by default, with automatic fallback.** The default is
`chatCore.DEFAULT_MODEL`; if a model's stream errors before producing anything
(rate limit, offline, credit cap), the server transparently retries down a
ranked list of **tool-capable free models fetched live from OpenRouter's
catalog** (cached 10 min; hand-ranked favourites first, then by context
length). This also means a key over its credit limit keeps working - free
models cost nothing. `GENAI_MODEL` overrides the *first* model tried (e.g. a
paid one when you have credit); the free fallbacks still apply behind it.
`GET :8087/health` shows the current chain.

Frontend endpoints (STAC/TiTiler/R2/chat) are Vite build-time `VITE_*` vars -
see `.env.example`. In dev, `VITE_CHAT_API` is left at `/api/chat` and Vite
proxies it to :8087. **In a production build it must be set to the deployed
chat URL** - this is a static site, so the relative default resolves to the
static host, which answers with an empty 200 and the chat silently does nothing.
`render.yaml` sets it for `philsa-webmap`.

## Next

- deck.gl overlay (`MapboxOverlay`) for GPU date-range scrubbing
  (`DataFilterExtension`) and GeoArrow vector layers.
- Restricted/authenticated layers once the private bucket + presigned flow
  land.
- Surface Copernicus EMS/GFM flood as the authoritative layer next to the
  radar-derived proxy.
