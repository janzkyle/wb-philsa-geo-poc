---
name: collection-tier
description: Move a STAC collection between the open and restricted tiers — the asset bytes between the public and private R2 buckets, the item hrefs, the gateway policy, and the catalog tag. Use when restricting a collection, returning a restricted one to open, or diagnosing a collection that is half-restricted (hidden in the catalog but still downloadable, or visible but 401ing on tiles).
---

# Change a collection's access tier

Ships **`move_assets_tier.sh`**, which moves the bytes and repoints the hrefs in
either direction. The bytes are only one of four places the tier is declared —
this skill exists because getting them out of step is what produces every
half-restricted failure mode.

`deploy/AUTH.md` remains the policy document; this is the procedure.

## The four places, and who wins

| Place | What it does | Authority |
| --- | --- | --- |
| `RESTRICTED_COLLECTIONS` in `deploy/gateway/wrangler.toml` | Catalog RBAC — hides/refuses the collection | **Enforcement** |
| `RESTRICTED_ASSET_PREFIXES` in the same file | Gates tiles, bounds `/assets/sign` | **Enforcement** |
| Which bucket the objects live in, and the item hrefs | Whether the bytes are reachable at all | **Reality** |
| `philsa:access` on the collection | Tells consumers and auditors which tier it's in | Documentation only |
| `"access": "restricted"` in `pipelines/03-gold/catalog_silver.py` | Where the *next* pipeline run writes | Future runs |

Enforcement and reality are independent. That is deliberate — the gateway can't
reach into R2 — but it means a change to one without the other leaves a state
that looks fine from one angle and broken from another.

## Run it

```bash
bash .claude/skills/collection-tier/move_assets_tier.sh prod <collection> restrict          # DRY RUN
bash .claude/skills/collection-tier/move_assets_tier.sh prod <collection> restrict --apply
bash .claude/skills/collection-tier/move_assets_tier.sh prod <collection> open    --apply
```

Flags: `--keep-source` copies and repoints but doesn't delete the origin copies
(rehearsal, or a demo you intend to flip back). `--yes` skips the confirmation
prompt that `open` requires, for non-interactive use. `--keep-public` is still
accepted as the old name for `--keep-source`.

Needs the repo-root `.env` (R2 credentials, `R2_BUCKET`, `R2_PUBLIC_BASE`) and
either `psql` or Docker. Dry run is the default — nothing moves without `--apply`.

The script prints the remaining steps when it finishes; it deliberately does not
run them itself, because they redeploy live Workers.

## Then finish the switch

Bytes alone don't change the tier. The script's closing message lists these, in
this order:

1. **Gateway vars, then deploy both workers.** `RESTRICTED_COLLECTIONS` goes in
   `[env.stac.vars]` **only** — collection RBAC is a catalog concept. But
   `RESTRICTED_ASSET_PREFIXES` must appear in **both** `[env.stac.vars]` and
   `[env.tiles.vars]`, because wrangler does not inherit vars across environments.
   Then `npx wrangler deploy -e stac && npx wrangler deploy -e tiles`.
2. `deploy/scripts/tag-collection-access.sh prod <collection> restricted|open`.
3. Add or drop `"access": "restricted"` in `pipelines/03-gold/catalog_silver.py`,
   or the next pipeline run undoes the migration. `catalog_silver.py` also reads a
   `RESTRICTED_COLLECTIONS` **env var** of the same name and unions it with the
   hardcoded list, so the tier can be widened for one run without a code edit.

**Ordering matters, in opposite directions.** Restricting: move the bytes *first*,
then tighten the gateway — otherwise the collection is refused while still sitting
downloadable on the public host. Opening: loosen the gateway *last*, or you
advertise a collection whose bytes aren't reachable yet.

## Traps

- **R2 has no object-tagging API, and `aws s3 cp` insists on tagging.** All three
  `--copy-props` modes fail per-object against R2, leaving a partial copy. The
  script uses low-level `s3api copy-object`, which sends only the headers given.
- **Restricted hrefs must be `s3://`, never the bucket's https endpoint.** TiTiler
  reads through GDAL, and only `s3://` makes it use `/vsis3/` and sign with its own
  R2 credentials. Handed the https endpoint it does an unsigned range GET and R2
  rejects it — the tiler returns 500. Verified both ways.
- **Iterate with `while read`, not `for key in $keys`.** Unquoted word-splitting is
  a bash-ism; zsh passes the whole listing as one word and every key is
  concatenated into a single `InvalidObjectName` call.
- **The R2 API token must cover both buckets.** R2 masks a missing object as
  `AccessDenied`, so a token scoped to one bucket is indistinguishable from a
  missing object. If a copy 403s, check the token's scope before the key.
- **Deleting is the only irreversible step**, and it happens last, after the
  destination is verified on both object count and total bytes and after the
  catalog is repointed. `--keep-source` skips it.

## Half-switched states, and what they look like

| Symptom | Cause |
| --- | --- |
| Hidden from `/collections`, but the COG still downloads from `r2.dev` | Gateway tightened, bytes never moved |
| Collection and dates visible, tiles return **401** | `RESTRICTED_COLLECTIONS` removed but `RESTRICTED_ASSET_PREFIXES` still set, or `-e tiles` not redeployed |
| Catalog fine, tiles return **500** | Hrefs are the https R2 endpoint instead of `s3://` |
| Visible and renders, but nothing can download it | Prefix removed from the gateway while the bytes are still private — `/assets/sign` only signs keys *inside* `RESTRICTED_ASSET_PREFIXES`, so removing the prefix removes the download path too |
| Restriction silently undone after a pipeline run | `catalog_silver.py` still writes that product to the public bucket |
