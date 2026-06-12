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

## Where code goes

POC logic (ingest, transforms, glue) belongs in the **repo root scripts and
`.claude/skills/`** — not inside the submodules. Keep any submodule edits minimal
and obviously POC-specific; prefer env/config over code changes.

## Secrets & credentials

- **Never hard-code or echo secrets.** R2 / S3 credentials come from the
  environment (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`).
- Put them in **`.env.r2`** (gitignored). `.gitignore` ignores all `.env*`, the
  generated `phl_adm*.parquet`, and the `*.gdb.zip` download cache — keep it that
  way; don't commit generated data or geodatabases.

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
1. Secrets via env / `.env.r2`; never committed, never echoed.
1. POC logic in root scripts/skills, not in the submodules.
1. Tag asset sensitivity (open vs. restricted) as the platform grows — it drives
   which R2 bucket and access path an asset gets.
