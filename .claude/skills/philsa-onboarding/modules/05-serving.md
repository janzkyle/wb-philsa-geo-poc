# Module 5 — Serving the data: API, tiler, Browser, webmap, chat

**Goal:** they know every service between the catalog and a pixel on screen,
can run the webmap locally, and understand how the AI assistant drives the
map. **Time:** ~30–40 min.

## Read first
- `webmap/README.md` (all of it; it's short)
- `INTEGRATION_GUIDE.md` §1 ("What you're integrating") and §4 ("Concepts")
- `deploy/gateway/README.md` → "What it does" (overview only; Elective E2 goes
  deep)
- `webmap/src/state/mapStore.ts` and `webmap/src/ai/executeTool.ts`, skimmed
  for shape
- `webmap/.env.example`

## Why it's built this way (the intent)
- **Discovery and rendering are separate services.** The STAC API answers
  *what exists, where, when*. TiTiler answers *draw it*, rendering tiles from
  COGs on the fly. There's no pre-rendered tile pyramid to rebuild when a
  stretch changes; you change a URL parameter.
- **Every frontend is just a consumer.** The webmap, STAC Browser, and
  `partner-template/` all reach the platform through the same public endpoints
  an agency would use. If the webmap can do it, an agency can too. That's the
  interop promise from Module 1.
- **The webmap has one store and two drivers.** All map state lives in one
  serializable Zustand store. The layer panel mutates it on click, and the AI
  mutates it through **client-executed tools**. The chat server only declares
  tool schemas and streams the model, so the AI can never do anything a user
  couldn't click, and the map never leaves the browser.
- **The chat has one core with two entry points.** `chatCore.mjs` is
  runtime-agnostic. `chat.mjs` (Node, dev) and `worker.mjs` (Cloudflare,
  prod) wrap it, so dev and prod can't drift.
- **Free models with automatic fallback.** If the preferred model fails, the
  server walks down a live-ranked list of free tool-capable models, so a demo
  never dies because of a credit cap. Gemini via OpenRouter BYOK is the
  demo-quality default.
- **STAC Browser is frozen at "demoable".** It's locked to our catalog and
  PhilSA-branded. The webmap is the active frontend.

## Essentials (in order)

1. **The request path:** browser → gateway (Cloudflare edge: cache, read-only,
   auth) → STAC API or TiTiler (Render) → pgSTAC (Neon) or R2. Locally the
   gateway is skipped: the webmap calls :8082 and :8083 directly.
2. **Tile rendering:**
   - For a date with a per-date **MosaicJSON**, render the seamless mosaic.
   - Otherwise, fall back to per-item COG tiles. (Flood has no mosaics yet.)
   - Tiles are WebMercatorQuad at `tilesize=512`.
   - Admin outlines are PMTiles, streamed straight from public R2.
3. **The chat loop:**
   - User message → chat server → model returns a tool call.
   - The tool call is forwarded to the **browser**, where `executeTool.ts`
     runs it against the STAC API and the store.
   - The result goes back to the model, which answers.
   - The tools are `list_collections`, `resolve_region`, `search_catalog`,
     `get_available_dates`, `add_layers`, `remove_layers`, `update_layer`,
     and `set_view`.
4. **`VITE_*` vars are build-time.** The webmap is a static site, so its
   endpoints are baked in at build. The classic trap: an unset
   `VITE_CHAT_API` in a production build makes chat silently do nothing.
5. **`partner-template/`** is a single `index.html` with no build step,
   published to GitHub Pages. It's what an agency forks.

## Adapt
- **GIS first:**
  - The webmap is QGIS in the browser. The layer panel is the Layers dock, and
    the store is the project file.
  - React and Zustand: components draw whatever the store says, and clicking
    or chatting edits the store.
  - Vite is the dev server and bundler.
- **Software first:**
  - A TiTiler URL *is* the styling: `rescale` sets the min/max stretch and
    `colormap_name` sets the palette.
  - MosaicJSON is a small index mapping each map tile to the COGs that cover
    it.
  - PMTiles is a single-file vector tile archive read with range requests.

## Hands-on

Pick the path that matches their credentials (`doctor.sh` says which):

**Path 1: everything local** (needs R2 creds for TiTiler, an OpenRouter key
for chat, and a local catalog with silver items in it):

```bash
docker compose --env-file .env -f compose.viz.yml up -d     # TiTiler :8083
python3 pipelines/03-gold/catalog_silver.py                  # register the silver COGs locally (reads R2)
cd webmap && npm install
npm run chat     # terminal 1 — :8087
npm run dev      # terminal 2 — :5173
```

**Path 2: local webmap against the read-only prod gateway** (no credentials
needed; good for frontend work):

```bash
cd webmap && cat > .env <<'EOF'
VITE_STAC_API=https://philsa-stac-gateway.philsa.workers.dev
VITE_TITILER=https://philsa-tiles-gateway.philsa.workers.dev
VITE_STAC_BROWSER=https://philsa-browser.onrender.com
EOF
npm install && npm run dev    # chat needs `npm run chat` + an OpenRouter key; the map works without it
```

Check whether `webmap/.env` already exists before overwriting it. This works
because prod CORS is open to any origin, which is the open-data contract.

Then, in the browser:
1. **Browse:** add `sentinel2-ndvi` from the layer panel, pick a date, and
   change the opacity.
2. **Ask** (if chat is running): "show NDVI for Iloilo in July". Watch the
   tool calls (`resolve_region` → `search_catalog` → `add_layers` →
   `set_view`).
3. Open DevTools → Network and find one tile request. Read its URL: is it a
   mosaic or an item COG, and what are `rescale` and `colormap_name`?

## Checkpoint
The same layer was added once by clicking and once by chatting (or by
clicking only, without a key). They can point to the line in
`executeTool.ts` that handles `add_layers`, and to the tile URL that carries
the stretch.

## Check understanding
- "Could the assistant delete catalog items?" (No. Its tools only read the
  STAC API and edit the client store, and prod refuses writes anyway.)
- "Chat works in `npm run dev` but does nothing on the deployed site, with no
  error. First suspect?" (`VITE_CHAT_API` unset at build. Then check
  `GET <worker>/health`.)

## Dive deeper (offer as options)
- **Adding a chat tool:** schema in `server/chatCore.mjs`, executor in
  `src/ai/executeTool.ts`. See also `TODO.md` → "Shared tool schemas".
- **Zonal statistics** for uploaded parcels (the PCIC feature) and the
  queued admin-zone stats work in `TODO.md` → "Insurance alignment".
- **The partner template and integration recipes:** `partner-template/`,
  `INTEGRATION_GUIDE.md` §5–7.
- **The gateway and restricted tier:** Elective E2.
