# PhilSA POC — agent & contributor guide

**Setup, repo layout, how to run everything, and current status live in
[`README.md`](./README.md) — read it before running anything.** This file is the
*how we work in here* guide: the conventions, guardrails, and traps that aren't
obvious from the code. [`poc-architecture.mmd`](./poc-architecture.mmd) is the
target architecture; [`TODO.md`](./TODO.md) is the running task list — tick items
off and update the README's "what's next" narrative as you land work.

**Don't rename or move this file.** It doubles as a filesystem marker: every
pipeline script resolves the repo root by walking up until it finds `.git` or
`AGENTS.md`, so relocating it silently breaks path resolution repo-wide.

## Where to work — start here

Each area owns its own doc; the cross-cutting rules follow below.

| Working on…                               | Read                                                                                                                                                           | Notes                                                                                                                                                              |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Data pipelines (ingest, transforms, glue) | [`pipelines/README.md`](./pipelines/README.md)                                                                                                                 | Medallion tiers, script index, R2 key layout, data lineage.                                                                                                        |
| Dagster orchestration                     | [`pipelines/orchestration/`](./pipelines/orchestration/) + the same README                                                                                     | **Optional** layer. It shells out to scripts via Pipes subprocesses — it never imports or edits them.                                                              |
| The MapLibre webmap / chat assistant      | [`webmap/README.md`](./webmap/README.md)                                                                                                                       | One Zustand store, two drivers (layer panel + AI tools). Layer styling in `src/config.ts` mirrors `pipelines/03-gold/catalog_silver.py` — change one, change both. |
| Deployment (Neon, Render, Workers)        | [`deploy/DEPLOYMENT.md`](./deploy/DEPLOYMENT.md)                                                                                                               | Prod DB on Neon, app tier on one `render.yaml` Blueprint, repeatable scripts in `deploy/scripts/`.                                                                 |
| The catalog API or Browser UI             | [`README.md` → Working with the submodules](./README.md#working-with-the-submodules)                                                                           | Both are **git submodules** pointing at our forks. See the guardrails below.                                                                                       |
| Reusable agent tooling                    | [`.claude/skills/`](./.claude/skills/)                                                                                                                         | Skills live here (not `.agents/`).                                                                                                                                 |
| Partner integration / API surface         | [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md), [`PHILSA_INTEROP_API.md`](./PHILSA_INTEROP_API.md), [`PCIC_WEBMAP_USE_CASES.md`](./PCIC_WEBMAP_USE_CASES.md) | Interop contract and the anchor-agency use cases.                                                                                                                  |

## Guiding principle: catalog by reference

The single most important convention. Ingest scripts copy **only STAC metadata**
(Collections + Items) into pgSTAC. Asset `href`s keep pointing at their original
storage (PhilSA GCS buckets, public Azure blobs, R2, …); pixels stream to
clients via HTTP range requests (`/vsicurl/`, presigned URLs). **Nothing is
re-hosted.** When you add a new source, preserve this — store the pointer, not
the bytes. The one exception is the bronze→silver→gold path, which owns the
bytes it derives (raw scenes in, derived COGs out to R2).

Corollaries every ingest script already follows, and yours should too:

- **Idempotent upserts:** POST first, and on `409 Conflict` fall back to PUT, so
  re-running updates in place.
- **Read geo-metadata from the asset at load time** (footprint, bbox, `proj:*`)
  via `gdalinfo` rather than hard-coding it.
- **Skip, don't fail**, on tiles/items that don't exist or fall outside the PH
  bounding box — log a one-line reason and continue.
- **Tag asset sensitivity** (open vs. restricted) as you add collections — it
  drives which R2 bucket and access path an asset gets.

## Writing to the STAC API — the traps

Four failure modes, each of which otherwise costs a full run to discover.

- **Prod is read-only on purpose.** `render.yaml` sets
  `ENABLE_TRANSACTIONS_EXTENSIONS=false`, so POST/PUT against the public API
  return a wall of **405**s. Prod writes go through the private, ephemeral API
  that `deploy/scripts/prod-ingest.sh` stands up on localhost. Any script that
  writes must call `ensure_writable()` from
  [`pipelines/lib/stac_write.py`](./pipelines/lib/stac_write.py) first — it asks
  the target's advertised conformance classes, so the check holds for any host.
  Locally, bring the API up with `ENABLE_TRANSACTIONS_EXTENSIONS=true` (:8082).
- **`datetime` must be non-null.** pgSTAC drops a null on output, and the item
  then fails the core schema. Use a midpoint and keep the real span in
  `start_datetime` / `end_datetime`.
- **`item_assets` is required by the render extension.** Omit it and the
  collection fails validation. Collections also carry `providers` and
  `summaries`.
- **Don't ship `gdalinfo`'s guessed `eo:bands`** (`b1` / `Gray`). Declare only the
  `eo` / `classification` extensions you actually use, with curated band
  metadata.

Validate before you commit — the validator is already vendored:

```bash
stac-browser/node_modules/.bin/stac-node-validator <file-or-url>
```

Provenance is explicit: derived items link `rel=derived_from` to their source and
carry `processing:lineage`; the PhilSA mirror adds `rel=via` to the upstream
record.

## Pipelines: layout & conventions

POC logic (ingest, transforms, glue) lives in **`pipelines/`** and
`.claude/skills/` — not in the submodules. Keep submodule edits minimal and
POC-specific; prefer env/config over code.

- **Medallion tiers.** File each script under the tier of data it *produces*:
  `01-bronze/` (raw, as-acquired), `02-silver/` (cleaned/derived → R2), `03-gold/`
  (served, sensitivity-tagged catalog entries). By-reference loaders (no bytes
  owned) live in `reference/`, outside the tiers. One subfolder per dataset
  (e.g. `01-bronze/copphil-sentinel/`).
- **Scripts stay runnable standalone — that's the contract.** Dagster wraps them
  as assets by shelling out, so a script that only works under an orchestrator
  breaks the layer above it. Resolve repo-relative paths (`.env`, `eodata/`) to
  the **repo root** so they run from any working directory.
- **Self-documenting scripts.** A script's header is its doc — Python module
  docstring + `--help`, or the shell comment block. **No per-script READMEs**
  (they drift out of sync); `pipelines/README.md` is the index + shared
  conventions.

**Reuse the shared helpers in [`pipelines/lib/`](./pipelines/lib/)** rather than
reimplementing them — all stdlib, imported via `sys.path` so scripts stay
standalone: `r2.py` (SigV4 R2 client + `load_env_file()`), `stac_write.py`
(`ensure_writable()`), `load_env.sh` (shell `.env` loader that never evaluates
the file, so passwords containing `$` or backticks survive `set -euo pipefail`).

## Secrets & credentials

- **Credentials come from the environment** — `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID` for R2 / S3; `COPPHIL_USERNAME` /
  `COPPHIL_PASSWORD` for CopPhil.
- Put them all in a **single repo-root `.env`** (gitignored); see `.env.example`
  for the key list. Every backend script auto-loads that file **and only that
  file** (override with `ENV_FILE=…`) — a `.env` in the cwd is deliberately
  ignored so `webmap/.env` can't shadow the creds. That webmap file is separate
  on purpose: it's Vite build-time `VITE_*` config, not secrets.
- `.gitignore` already covers all `.env*`, the generated `phl_adm*.parquet`, and
  the `*.gdb.zip` download cache — extend it when you add generated artifacts.
- **R2 layout mirrors the tiers:** objects use a medallion-tiered key prefix
  `<tier>/<dataset>/<file>`. Each script hardcodes its own prefix — not
  env-configurable, so a stray env var can't silently redirect a tier; the shared
  `.env` holds creds only. Uploads are idempotent: HEAD-then-skip for the bronze
  downloader and Sentinel builders (`FORCE=1` rebuilds), overwrite-in-place for
  the rest.

## Submodule guardrails

Both submodules (`stac-fastapi-pgstac`, `stac-browser`) point at **our forks**.
**Don't reformat or mass-edit them** — they track upstream; keep changes minimal
and POC-specific. Landing a change takes **two commits**: push inside the
submodule, *then* commit the new gitlink in the parent repo — skip the second and
your edit is invisible to everyone else. Full workflow in
[`README.md` → Working with the submodules](./README.md#working-with-the-submodules).
