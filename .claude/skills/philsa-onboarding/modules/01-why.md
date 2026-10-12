# Module 1 — Why this exists: mission, principles, architecture

**Goal:** they can explain what the platform is for, the handful of decisions
that shape everything else, and trace a request across the architecture
diagram. **Time:** ~20 min.

## Read first
- `PHILSA_INTEROP_API.md` → "The core realisation" and "Two consumer profiles"
- `AGENTS.md` → "Guiding principle: catalog by reference"
- `poc-architecture.mmd` (the whole thing, including the status legend)
- `PCIC_WEBMAP_USE_CASES.md` → "Context & priorities"

## Why it's built this way (the intent)

Teach these as **decisions with reasons**. Each one recurs in later modules.

1. **Publish on open standards; don't build a bespoke API.** PhilSA shouldn't
   build N integrations for N agencies. It publishes one catalog that speaks
   STAC + COG + XYZ tiles, and each agency plugs in QGIS, `pystac-client`,
   MapLibre, or Leaflet. The webmap and `partner-template/` exist to *prove*
   this: they are ordinary external consumers of the same public endpoints.
2. **Catalog by reference.** Copy only metadata; leave pixels where they live,
   and stream them with HTTP range requests. That keeps storage and egress
   near zero and avoids re-hosting someone else's data. The exception is
   anything we *derive* (silver products), which we own and store in R2.
3. **Medallion tiers for the bytes we do own.** Bronze is raw, silver is
   derived, gold is cataloged. Each script is filed by the tier it produces,
   so the repo layout *is* the data lineage.
4. **The public surface is read-only; writes happen privately.** Prod refuses
   writes at the API origin *and* at the edge gateway, and ingest runs through
   a throwaway local API bound to the prod database. Nothing writable is ever
   internet-reachable.
5. **Free tiers, and repeatable.** It's a POC on a World Bank engagement:
   Neon + Render + Cloudflare cost $0 and are scripted (`render.yaml`,
   `deploy/scripts/`). Cold starts are the accepted trade-off. Module 7 covers
   moving to other platforms.
6. **Scripts first, orchestration optional.** Every pipeline runs standalone
   from a terminal. Dagster only wraps them, so nobody needs Dagster to
   understand or fix a pipeline.
7. **Honest status.** Every box in the diagram is badged ✅ / 🟡 / ⏳ against
   `TODO.md`. Keeping those badges honest is part of the job.

**The anchor use case** makes the abstractions concrete. PCIC (crop insurance)
runs **parametric** policies where a satellite index over each insured farm's
polygon triggers the payout. That is why NDVI, the S1 VH/VV ratio (works
through cloud), and the flood proxy exist, and why "zonal stats over an
uploaded parcel" is a webmap feature.

## Essentials (in order)

1. The pitch, plus decisions 1 and 2 above. These are the most important.
2. **Walk the diagram left to right.** Render it first: paste
   `poc-architecture.mmd` into <https://mermaid.live>, or use a Mermaid
   preview extension in their editor. Then trace two paths:
   - **Data in:** CopPhil → bronze → silver → R2 + gold → writable API →
     pgSTAC.
   - **Data out:** agency browser → gateway → STAC API (finds an item) →
     gateway → TiTiler (renders it from R2) → map tile.
3. Decisions 3–7, briefly. Each gets its own module later.
4. **Read the badges.** What's ✅, what's 🟡, and which ⏳ items matter most.
   Keep this to a teaser; Module 8 covers it properly.

## Adapt
- **Software first:** a 60-second Earth-observation primer. Sentinel-1 is
  radar: it sees through cloud, and water reads dark. Sentinel-2 is optical,
  with 10 m bands including red and NIR (hence NDVI). Then: a **STAC Item** is
  one scene's JSON record with links ("assets") to its files; a **COG** is a
  GeoTIFF laid out so a client can fetch just the bytes for one tile.
- **GIS first:** a 60-second web primer. The STAC API is a searchable catalog
  over HTTP. TiTiler turns a COG into map tiles on request, so there are no
  pre-rendered tile pyramids. The gateway is a thin proxy at Cloudflare's edge
  that adds caching and access rules.

## Hands-on
No setup needed. Use the **live prod** endpoints (public and read-only, so
this is safe; the first call may take ~30–60 s while the origin wakes):

```bash
curl -s "https://philsa-stac-gateway.philsa.workers.dev/collections?limit=200" \
  | python3 -c 'import json,sys; c=json.load(sys.stdin)["collections"]; print(len(c), "collections"); [print(" -", x["id"]) for x in c if "philsa:mirrored_from" not in x]'
```

This lists the collections PhilSA owns (the ones *without*
`philsa:mirrored_from`). Then open the live webmap and STAC Browser (URLs in
`INTEGRATION_GUIDE.md` §1 and `render.yaml`) and find the same collections
there.

## Checkpoint
They can say in their own words: (a) what "catalog by reference" means and
why it matters, and (b) which box in the diagram answers "what imagery exists
over Iloilo in June?" (the STAC API) and which one draws it (TiTiler).

## Check understanding
- "An agency wants our NDVI in their own Leaflet map. What do *we* build for
  them?" (Nothing. They point Leaflet at our tile URLs; see
  `INTEGRATION_GUIDE.md`.)
- "Why can't someone POST a fake item to the prod catalog?" (The origin runs
  read-only, and the gateway re-blocks writes.)

## Dive deeper (offer as options)
- **The interoperability strategy:** `PHILSA_INTEROP_API.md` in full, covering
  consumer profiles, rollout phases, and why the gateway exists.
- **The PCIC use cases:** `PCIC_WEBMAP_USE_CASES.md`, covering underwriting,
  claims, and inspections, and which webmap features serve each.
- **Partner integration from the agency's side:** `INTEGRATION_GUIDE.md` §3–5,
  plus opening `partner-template/index.html` in a browser.
