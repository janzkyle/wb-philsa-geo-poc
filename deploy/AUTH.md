# Auth & governance — PhilSA POC

How the POC decides **who may see what**, and how to operate it.

Everything is enforced at the **edge gateway** (`deploy/gateway/`), which already
fronts both public origins. Nothing new is deployed, no service is added to the
request path, and open data keeps working with no credential at all — an
anonymous request pays no auth cost whatsoever (no KV read, no JWKS fetch).

## The model in one table

| | **Open tier** | **Restricted tier** |
| --- | --- | --- |
| Who | anyone, anonymous | partner agencies, named |
| Collections | all except those below | `sentinel1-flood` |
| Credential | none | API key **or** Auth0 JWT |
| Asset bytes | public R2, direct download | private R2, presigned URL only |
| Tiles | TiTiler renders freely | TiTiler refuses without the role |

Three roles, carried either by an API-key record or a JWT claim:

- **`public`** — implicit, anonymous. Open data only.
- **`partner`** — the restricted tier. What a partner agency gets.
- **`admin`** — same as partner today; exists so operator tokens aren't locked
  out of their own data as the model grows.

## Two credential types, and why both

The POC serves two consumer shapes that cannot share one mechanism
(`PHILSA_INTEROP_API.md` works through this in detail):

**Server-side consumers can hold a secret** — an agency backend, a cron job,
QGIS, a `pystac-client` script. They get a long-lived **API key**, sent as
`X-API-Key`. Simple, no login dance, revocable individually.

**Browser users cannot hold a secret.** Anything shipped to a browser is public,
so an API key baked into the webmap protects nothing. Those users sign in and
present a short-lived **Auth0 JWT** as `Authorization: Bearer …`.

Both resolve to the same internal principal, so the policy code never branches on
which was used (`lib/auth.js`).

### Why Auth0 rather than something DB-coupled

The catalog moved to **Neon**, and access is enforced at the edge, not in
Postgres — so an auth product that syncs users into your database (Supabase Auth,
Neon Auth) buys a users table the Worker would have to query anyway. Auth0's free
tier gives standard OIDC with a JWKS endpoint and dashboard-assigned roles, with
nothing to run.

Nothing in the code is Auth0-specific: `lib/auth.js` does plain OIDC discovery and
RS256 verification. Pointing at **CopPhil's or PhilSA's Keycloak** later — likely,
since `download_copphil_eodata.py` already authenticates against Keycloak — is a
change to `AUTH0_DOMAIN`/`AUTH0_AUDIENCE` and a redeploy.

---

## Operating it

### Issue an API key to a partner

```bash
cd deploy/gateway
node scripts/mint-key.mjs --name "Partner agency" --roles partner
node scripts/mint-key.mjs --name "Partner agency" --expires 2027-01-01   # optional expiry
node scripts/mint-key.mjs --list                                        # who holds one
node scripts/mint-key.mjs --revoke <hash>
```

The key is printed **once**. KV stores only its SHA-256, so a dump of the
namespace — or of this repo — leaks nothing usable, and lookup-by-hash means
there is no string comparison to time-attack. A lost key is re-issued, never
recovered.

The partner then uses it:

```bash
curl -H "X-API-Key: philsa_…" \
  https://philsa-stac-gateway.philsa.workers.dev/collections/sentinel1-flood
```

### Get a downloadable URL for a restricted asset

Restricted objects live in the private bucket and 403 on direct access. Exchange
an asset href for a short-lived signed URL:

```bash
curl -H "X-API-Key: philsa_…" \
  "https://philsa-stac-gateway.philsa.workers.dev/assets/sign?url=<asset href>"
# -> {"url":"https://…r2.cloudflarestorage.com/…?X-Amz-Signature=…",
#     "expires_in":300,"expires_at":"…"}
```

That URL is what GDAL/QGIS/rasterio range-read, so large COGs never stream
through the Worker. The endpoint will only sign keys under
`RESTRICTED_ASSET_PREFIXES` — a leaked key cannot turn it into a proxy for the
whole bucket. Every signing is logged with the principal and object key; that log
**is** the access record for restricted data (Workers Logs, `[observability]` in
`wrangler.toml`).

### Change what's restricted

Two places, deliberately:

1. **`deploy/gateway/wrangler.toml`** — `RESTRICTED_COLLECTIONS` and
   `RESTRICTED_ASSET_PREFIXES`, then `wrangler deploy -e stac && wrangler deploy -e tiles`.
   This is the **enforcement authority**.
2. **The catalog** — `deploy/scripts/tag-collection-access.sh prod <id> restricted`
   writes a `philsa:access` property on the collection. This is **documentation**:
   it tells a consumer or an auditor which tier a collection is in.

They're separate on purpose. Enforcement must keep working when the database is
unreachable, and someone who can write to the catalog must not be able to quietly
open the restricted tier. `tag-collection-access.sh prod --list` shows every
collection's tag.

### Make a restriction real (the part that's easy to miss)

Tagging a collection and listing it in `RESTRICTED_COLLECTIONS` stops the
**catalog** and the **tiler** from serving it. It does **not** stop anyone from
fetching the COG straight off the public `r2.dev` host — those objects are
world-readable and the gateway isn't in that path. Until the bytes move, the
restriction is metadata only:

```bash
deploy/scripts/move-assets-private.sh prod sentinel1-flood            # dry run
deploy/scripts/move-assets-private.sh prod sentinel1-flood --apply
```

It copies to the private bucket, verifies the count, repoints the STAC hrefs, and
only then deletes the public copies — so a failure part-way leaves the data
reachable rather than gone.

---

## Setting up the Auth0 tenant

The gateway ships with `AUTH0_DOMAIN = ""`. In that state bearer JWTs are
rejected ("identity provider is not configured") and everything falls back to
anonymous — **API-key auth and the restricted tier work regardless**, so this is
safe to leave until browser logins are wanted.

1. **Create the tenant.** <https://auth0.com> → sign up → note the domain, e.g.
   `philsa-poc.eu.auth0.com`. Free tier; no card.

2. **Create an API** (this is the *audience* — what tokens are minted *for*).
   Applications → APIs → **Create API**:
   - Name: `PhilSA STAC API`
   - Identifier: `https://api.philsa-poc.example/stac` — an identifier, not a
     URL that has to resolve. It must match `AUTH0_AUDIENCE` exactly.
   - Signing algorithm: **RS256** (the gateway rejects anything else — accepting
     the token's own `alg` is the classic JWT forgery).
   - Enable **RBAC** and **Add Permissions in the Access Token**.
   - Add a permission: `read:restricted`.

3. **Create an application** for the browser clients (webmap / STAC Browser):
   Applications → **Create Application** → *Single Page Application*. Set the
   allowed callback/logout/web origins to the deployed frontends.

4. **Define the roles.** User Management → Roles → create `partner`, grant it the
   `read:restricted` permission on the API above. Assign it to users by hand —
   for a POC with a handful of accounts that's the right amount of process.

5. **Emit the roles claim.** Actions → Library → **Build Custom** → *Login /
   Post Login*:

   ```js
   exports.onExecutePostLogin = async (event, api) => {
     const ns = 'https://philsa.gov.ph/roles';
     api.accessToken.setCustomClaim(ns, event.authorization?.roles ?? []);
   };
   ```

   Deploy it and add it to the Login flow. The namespace must match
   `AUTH0_ROLES_CLAIM`. (If you'd rather not use an Action, the gateway also
   accepts the `permissions` array Auth0's RBAC emits: a `read:restricted`
   permission is treated as the `partner` role.)

6. **Point the gateway at it** — in `deploy/gateway/wrangler.toml`, set
   `AUTH0_DOMAIN` (both `[env.stac.vars]` and `[env.tiles.vars]`) and confirm
   `AUTH0_AUDIENCE` matches the API identifier. Then:

   ```bash
   cd deploy/gateway
   npx wrangler deploy -e stac && npx wrangler deploy -e tiles
   ```

7. **Verify** with a token from Auth0's API → Test tab:

   ```bash
   curl -H "Authorization: Bearer <token>" \
     https://philsa-stac-gateway.philsa.workers.dev/collections/sentinel1-flood
   ```

---

## Configuration reference

Set in `deploy/gateway/wrangler.toml` per environment (`vars` are **not**
inherited across wrangler environments — each `[env.*]` repeats what it needs):

| Var | Meaning |
| --- | --- |
| `RESTRICTED_COLLECTIONS` | Comma-separated collection ids. Enforcement authority. |
| `RESTRICTED_ASSET_PREFIXES` | R2 key prefixes whose bytes are restricted. Gates tiles and bounds `/assets/sign`. |
| `AUTH0_DOMAIN` | Tenant domain, or empty to disable JWT auth. |
| `AUTH0_AUDIENCE` | API identifier the token must be minted for. |
| `AUTH0_ROLES_CLAIM` | Namespaced claim carrying the roles array. |
| `R2_PRIVATE_BUCKET` | Bucket presigned URLs point into. |
| `PRESIGN_TTL_SECONDS` / `PRESIGN_MAX_TTL_SECONDS` | Default / ceiling lifetime (300 / 900). |

Secrets — set once per environment, never committed:

```bash
cd deploy/gateway
npx wrangler secret put R2_ACCOUNT_ID        -e stac
npx wrangler secret put R2_ACCESS_KEY_ID     -e stac
npx wrangler secret put R2_SECRET_ACCESS_KEY -e stac
```

Only the STAC gateway signs URLs, so the tiles gateway needs no R2 secrets.

> ### ⚠️ The R2 token must cover the private bucket
>
> The credentials currently in the repo-root `.env` are scoped to
> **`world-bank-philsa-geo`** (the public bucket) only. They sign correctly — a
> presigned URL against the public bucket returns `206` with a working Range
> request — but every presigned URL into `world-bank-philsa-geo-private` comes
> back `403 AccessDenied`, because the token has no rights there. R2 masks a
> missing object as `AccessDenied` too, so the two look identical; the way to
> tell them apart is `aws s3 ls` on the private bucket, which fails outright when
> it's a scope problem.
>
> **Fix (one time, dashboard only — there's no wrangler command for it):**
> Cloudflare dashboard → **R2** → **Manage API Tokens** → give a token
> **Object Read & Write** on *both* `world-bank-philsa-geo` and
> `world-bank-philsa-geo-private`.
>
> **Whether you then have to touch the Worker depends on how you did it:**
>
> - **Widened the existing token's scope** — nothing else to do. R2 evaluates a
>   token's permissions server-side on every request, so the same access-key pair
>   simply starts working. The Worker's stored secrets are still correct.
> - **Created a *new* token** — the key pair changed, so re-run the three
>   `wrangler secret put` commands above with the new values.
>
> Either way there is **no redeploy**: `wrangler secret put` updates the live
> Worker immediately. A `wrangler deploy` is only needed when *code* or a
> `vars`/binding entry in `wrangler.toml` changes.
>
> Update the repo-root `.env` to match whichever token you use, so
> `move-assets-private.sh` can write to the private bucket too.
>
> Until this is sorted, `/assets/sign` returns a correctly-signed URL that R2
> refuses. Nothing else in the auth layer depends on it.

## What the gateway actually enforces

| Request | Anonymous | `partner` |
| --- | --- | --- |
| `GET /collections` | restricted entries stripped from the list | full list |
| `GET /collections/sentinel1-flood[/…]` | `401` | `200` |
| `GET/POST /search` naming a restricted collection | `401` | `200` |
| `GET/POST /search` naming **nothing** | restricted features filtered out of the response | unfiltered |
| TiTiler `?url=` a restricted object | `401` | rendered |
| `GET /assets/sign?url=…` | `401` | signed URL |
| Any write method | `405` (unchanged — the API is read-only) | `405` |

`401` when no usable credential was presented, `403` when a valid credential
simply lacks the role.

**The unscoped-search case is the one that matters.** A `/search` naming no
collections means "every collection", and passing it through unfiltered is the
classic way a collection-level restriction leaks. Naming a restricted collection
explicitly earns a `401` (so a partner learns it exists and needs a credential)
rather than a silently short page.

Edge-cache keys are scoped by access tier, so a cached privileged response can
never be replayed to an anonymous caller. Responses carry
`Vary: Authorization, X-API-Key` for the same reason downstream. Credentials are
stripped before the request is forwarded — the origins never see them.

## Locking the origins to the gateway

Everything above is enforced at the edge — which only means anything if the edge
is the *only* way in. It wasn't. Render gives each origin a public
`*.onrender.com` hostname, and TiTiler holds R2 credentials that can read the
private bucket, so before this landed an anonymous request to
`philsa-titiler.onrender.com/cog/tiles/...?url=s3://<private>/...` returned a
real PNG tile of a restricted scene. Moving the bytes closed the direct-download
hole and opened a rendering one.

The fix is a shared secret. The gateway injects `X-Gateway-Auth` on every request
it forwards; TiTiler (`deploy/titiler/gateway_guard.py`) refuses anything without
it. Health paths stay exempt so Render's probes and the keep-warm cron still work.

**It fails open when the secret is unset** — a missing env var degrades to the old
behaviour rather than 403-ing every tile, including open ones. That also fixes the
rollout order:

```bash
# 1. gateway first — it starts sending the header; the origin still ignores it
cd deploy/gateway
npx wrangler secret put ORIGIN_SHARED_SECRET -e stac
npx wrangler secret put ORIGIN_SHARED_SECRET -e tiles
npx wrangler deploy -e stac && npx wrangler deploy -e tiles

# 2. then the origin — enforcement switches on here
#    Render ▸ philsa-titiler ▸ Environment ▸ GATEWAY_SHARED_SECRET = <same value>
#    Save; Render redeploys automatically.
```

Do it in the other order and tiles 403 in the window between.

Verify afterwards: a direct hit on the origin should give `403` with a message
pointing at the gateway, while the same request through the gateway still works.

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  "https://philsa-titiler.onrender.com/cog/info?url=s3://world-bank-philsa-geo-private/…"   # 403
curl -s -o /dev/null -w '%{http_code}\n' -H "X-API-Key: philsa_…" \
  "https://philsa-tiles-gateway.philsa.workers.dev/cog/info?url=s3://…"                     # 200
```

**The STAC API origin is not covered.** `philsa-stac-api.onrender.com` still
serves the restricted collection and its items to anyone. That leaks *metadata*
— scene ids, footprints, dates — not imagery, which is why it's ranked below the
tiler. Closing it needs the same guard inside the STAC API image, and that image
builds from the submodule (`deploy/stac-api/Dockerfile`, build context is the
submodule root), so the guard has to be injected rather than `COPY`ed. Left for
after the POC; noted in the limits below.

## Known limits (POC-appropriate, worth stating)

- **Sensitivity is per collection, not per item.** That matches how the data is
  licensed and keeps enforcement off the hot path. Item-level rules would want
  `stac-auth-proxy`'s CQL2 filter injection instead.
- **Filtered search pages can be short.** Removing restricted features from a
  page of results doesn't refill it, and `numberMatched` stays upstream's
  pre-filter count — an upper bound. Acceptable for a POC; a real fix means
  pushing the filter into the query.
- **All partners see the same restricted data.** Roles, not per-key data scoping.
  The shared privileged cache bucket depends on that staying true.
- **API keys don't expire by default.** Pass `--expires`, or revoke.
- **`workers.dev` has no custom domain**, so Cloudflare Access can't front these
  hostnames. Revisit for internal tools (the Dagster UI) once
  `stac.philsa.gov.ph` exists.
- **The STAC API origin is still directly reachable**, so restricted *metadata*
  (ids, footprints, dates) is readable by anyone who knows the `onrender.com`
  hostname. Imagery is not — see "Locking the origins to the gateway".
- **One shared secret for all origins**, not per-service, and rotating it means
  updating both sides in the order above.
