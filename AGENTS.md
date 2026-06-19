# PhilSA POC — agent & contributor guide

**Setup, the repo layout, how to run everything, and current status live in
[`README.md`](./README.md) — read it before running anything.** This file is the
*how we work in here* guide: the conventions and guardrails that aren't obvious
from the code. Read `poc-architecture.mmd` for the target architecture.

The running task list is in [`TODO.md`](./TODO.md) — check it for what's in flight
and tick items off (and update the `README.md` "what's next" narrative) as you
land work.

## Guiding principle: catalog by reference

The single most important convention. Ingest scripts copy **only STAC metadata**
(Collections + Items) into pgSTAC. Asset `href`s keep pointing at their original
storage (PhilSA GCS buckets, public Azure blobs, R2, …); pixels stream to
clients via HTTP range requests (`/vsicurl/`, presigned URLs). **Nothing is
re-hosted.** When you add a new source, preserve this — store the pointer, not
the bytes.

Corollaries every ingest script already follows, and yours should too:

- **Idempotent upserts:** POST first, and on `409 Conflict` fall back to PUT, so
  re-running updates in place. Don't write scripts that error on re-run.
- **Read geo-metadata from the asset at load time** (footprint, bbox, `proj:*`)
  via `gdalinfo` rather than hard-coding it.
- **Skip, don't fail**, on tiles/items that don't exist or fall outside the PH
  bounding box — log a one-line reason and continue.

## Pipelines: layout & conventions

POC logic (ingest, transforms, glue) lives in **`pipelines/`** and `.claude/skills/`
— not in the submodules. Keep submodule edits minimal and POC-specific; prefer
env/config over code. Full detail + script index:
[`pipelines/README.md`](./pipelines/README.md).

- **Medallion tiers.** File each script under the tier of data it *produces*:
  `01-bronze/` (raw, as-acquired), `02-silver/` (cleaned/derived → R2), `03-gold/`
  (served, sensitivity-tagged catalog entries). By-reference loaders (no bytes
  owned) live in `reference/`, outside the tiers. One subfolder per dataset
  (e.g. `01-bronze/copphil-sentinel/`).
- **Self-documenting scripts.** A script's header is its doc — Python module
  docstring + `--help`, or the shell comment block. **No per-script READMEs**
  (they drift out of sync); `pipelines/README.md` is the index + shared conventions.
- **Python vs shell.** Shell when the script mainly orchestrates GDAL / `curl`;
  Python when there's real logic — auth, JSON/OData parsing, SigV4, retries.

## Secrets & credentials

- **Never hard-code or echo secrets.** R2 / S3 credentials come from the
  environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`);
  CopPhil from `COPPHIL_USERNAME` / `COPPHIL_PASSWORD`.
- Put them all in a **single repo-root `.env`** (gitignored); see `.env.example`
  for the key list. Every backend script auto-loads it (override the path with
  `ENV_FILE=…`). `.gitignore` ignores all `.env*`, the generated
  `phl_adm*.parquet`, and the `*.gdb.zip` download cache — keep it that way; don't
  commit generated data or geodatabases. (The webmap's `webmap/.env` is separate —
  it's Vite build-time `VITE_*` config, not secrets.)
- **R2 layout mirrors the tiers:** objects use a medallion-tiered key prefix
  `<tier>/<dataset>/<file>`. Each script hardcodes its own prefix; the shared
  `.env` holds creds only — **never `R2_PREFIX`** (it would override every
  script). Uploads are idempotent (HEAD, then skip if already present at full size).

## Submodule guardrails

Both submodules (`stac-fastapi-pgstac`, `stac-browser`) point at **our forks**.
**Don't reformat or mass-edit them** — they track upstream; keep changes minimal
and POC-specific. The step-by-step edit/push/pin workflow (and why both a
submodule push *and* a parent-repo commit are required) is in
[`README.md` → Working with the submodules](./README.md#working-with-the-submodules).

## Conventions recap (the short version)

1. Reference assets by `href`; never re-host pixels.
1. Idempotent POST→PUT-on-409 upserts.
1. Skip-and-log rather than fail on missing / out-of-bbox data.
1. Secrets via env / the single repo-root `.env`; never committed, never echoed.
1. POC logic in `pipelines/` (and `.claude/skills/`), by medallion tier
   (`01-bronze`/`02-silver`/`03-gold`; `reference/` for by-reference loaders).
1. Scripts self-document in their header (`--help` / comment block) — no
   per-script READMEs; `pipelines/README.md` is the index.
1. R2 objects under tiered keys `<tier>/<dataset>/…`; shared creds in `.env`
   (never `R2_PREFIX`).
1. Tag asset sensitivity (open vs. restricted) as the platform grows — it drives
   which R2 bucket and access path an asset gets.
