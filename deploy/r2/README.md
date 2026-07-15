# R2 configuration

Config for the **public** Cloudflare R2 bucket that serves the open COGs,
mosaics, and PMTiles.

## CORS (`cors.json` + `apply-cors.sh`)

The public `r2.dev` bucket ships with **no CORS headers**, so a browser `fetch`/
`HEAD` to a mosaic is blocked. Both the PhilSA webmap and the partner template
then fall back from the single-source per-date **mosaic** to rendering each
date's COGs individually — correct, just less efficient. (Raster *tiles* served
by TiTiler are unaffected; this only bites browser calls that hit R2 directly.)

Apply the policy once (reads `R2_BUCKET` etc. from the repo-root `.env`; needs the
AWS CLI):

```bash
deploy/r2/apply-cors.sh          # apply cors.json
deploy/r2/apply-cors.sh --show   # print the current policy
```

`cors.json` grants **read** cross-origin from any origin (`GET`/`HEAD`, `Range`
allowed, range headers exposed) — safe for a public open-data bucket, and it does
not expose writes (the R2 API-token creds still gate `PUT`).

> **Permissions gotcha.** `PutBucketCors` is a **bucket-admin** operation. The
> usual R2 token in `.env` is scoped **Object Read & Write**, which authenticates
> but is **not allowed to change CORS** — the script then fails with
> `AccessDenied`. Two fixes:
>
> - **Dashboard (easiest, no new token):** **R2 ▸ the bucket ▸ Settings ▸ CORS
>   Policy**, and paste the rules **as a bare JSON array** — the contents of
>   `cors.json`'s `CORSRules`, i.e. `[ { "AllowedOrigins": ["*"], … } ]` — not the
>   `{"CORSRules": …}` wrapper (that wrapper is only for the `aws s3api` CLI).
> - **Admin token + this script:** create an R2 token with **Admin Read & Write**
>   and run `AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=… deploy/r2/apply-cors.sh`.
>
> `--show` (get-bucket-cors) is often permitted even when `put` isn't, so use it
> to verify after either path.

After applying, the mosaic fast-path activates automatically — no code change in
the webmap or template.
