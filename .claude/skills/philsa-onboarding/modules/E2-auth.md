# Elective E2 — Auth & governance: open vs. restricted

**Goal:** they understand who can see what, where that's enforced, and how
data moves between tiers. **Time:** ~25 min. Best taken after Module 5.

## Read first
- `deploy/AUTH.md`: "The model in one table", "Two credential types",
  "What the gateway actually enforces", "Locking the origins to the gateway",
  "Known limits"
- `deploy/gateway/README.md` → "What it does", "Restricted collections"
- `.claude/skills/collection-tier/SKILL.md` → "The four places, and who wins"
- `deploy/gateway/wrangler.toml`: the current `RESTRICTED_*` values (commented
  out means nothing is restricted)

## Why it's built this way (the intent)
- **Open by default, restricted by exception.** Open data must cost
  anonymous users nothing: no key, no login, no extra latency. The gateway
  skips auth entirely when no credential header is present.
- **Enforce at the edge, not in the database.** The gateway already fronts
  both origins, so access rules live there. No new service sits in the
  request path, and the DB doesn't need a users table.
- **Two credential types for two consumer shapes.** Servers can hold a secret
  and get an **API key**. Browsers can't hold a secret, so users log in and
  present a short-lived **JWT**. Both collapse to one principal, so the policy
  code never branches on which was used.
- **Restrict the pixels, not just the listing.**
  - Restricted bytes live in a **private** bucket and are reached only via
    short-lived presigned URLs.
  - TiTiler refuses restricted tiles without the role.
  - TiTiler's own origin is locked to the gateway by a shared secret.
  - Hiding a collection from `/collections` alone would be theatre.
- **Hashes, not keys.** KV stores SHA-256 of each API key, so a dump of the
  namespace or the repo leaks nothing usable.

## Essentials (in order)
1. **The table:** open vs. restricted × who, credential, bytes, tiles.
2. **The three roles:** `public` (implicit), `partner`, `admin`.
3. **What enforcement looks like** for a restricted collection:
   - hidden from anonymous `/collections`
   - refused on its own routes
   - filtered out of unscoped `/search`
   - unrenderable by TiTiler
4. **Tier membership is declared in four places**, and they must agree:
   - gateway `RESTRICTED_COLLECTIONS`
   - gateway `RESTRICTED_ASSET_PREFIXES`
   - which bucket the objects live in, and the item hrefs
   - `philsa:access`, plus `catalog_silver.py`'s `access` (for future runs)

   The `collection-tier` skill keeps them in step.
5. **Known gaps:**
   - the STAC origin still serves restricted metadata directly
   - the Auth0 tenant isn't created yet (API keys work meanwhile)
   - both frontends are anonymous today

## Adapt
- **GIS first:** explain a presigned URL as "a download link that expires in 5
  minutes and only works for one file", and a JWT as "a signed ID card the
  browser shows on every request".
- **Software first:** go straight to `lib/access.js` (pure policy, unit-tested
  in `test/access.test.mjs`) and the tier-scoped cache keys, which stop a
  privileged response from being replayed to an anonymous caller.

## Hands-on (read-only, against prod)

```bash
G=https://philsa-stac-gateway.philsa.workers.dev
curl -s "$G/collections/sentinel1-flood" | grep -o '"philsa:access":"[^"]*"'   # tier tag
curl -s -X OPTIONS -i "$G/collections" -H 'Origin: https://example.org' \
  -H 'Access-Control-Request-Method: GET' | grep -i '^access-control'       # the open CORS contract
cd deploy/gateway && node --test test/*.test.mjs                                    # the policy's unit tests, locally
```

Then read `lib/access.js` together and find the function that decides whether
an anonymous caller may see a collection.

## Checkpoint
They can explain why restricting a collection requires *both* moving its bytes
and a gateway change, and what goes wrong if only one happens (hidden but
still downloadable, or visible but 401ing on tiles).

## Check understanding
- "Why not just give the webmap an API key for restricted layers?" (Anything
  shipped to a browser is public. Browsers need a user login, i.e. a JWT.)
- "A partner's key leaks. What do you do?" (`mint-key.mjs --revoke <hash>`
  and issue a new key. Keys are never recoverable, only re-issued.)

## Dive deeper (offer as options)
- **Restrict a collection end to end** in a scratch environment, with the
  `collection-tier` skill and `DRY_RUN=1` first.
- **Swapping Auth0 for Keycloak:** what changes (`AUTH0_DOMAIN` /
  `AUTH0_AUDIENCE` and the roles claim) and what doesn't.
- **Closing the origin bypass:** the options in `TODO.md` → "Close the last
  bypass".
