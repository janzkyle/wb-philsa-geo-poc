// PhilSA Open Data API — edge gateway (Cloudflare Worker).
//
// One worker, ONE origin per deploy. It's deployed twice via wrangler
// environments (see wrangler.toml): once in front of the STAC API, once in front
// of TiTiler — each on its own *.workers.dev URL. This POC uses NO custom
// domains, so routing-by-hostname isn't possible and path-prefixing would break
// STAC's self-links; a root-mounted worker per origin keeps the paths clean.
//
// It turns a raw *.onrender.com POC service into a governed public API:
//
//   1. Read-only allowlist  — blocks every write/transaction method at the edge
//      (defense-in-depth; the origin is ALSO read-only now that prod runs
//      ENABLE_TRANSACTIONS_EXTENSIONS=false — see deploy/DEPLOYMENT.md). Only
//      GET/HEAD/OPTIONS pass, plus the body-bearing READS in POST_READ_PATHS
//      (STAC search; TiTiler statistics).
//   2. Open-data CORS       — one consistent CORS contract for browser consumers.
//   3. Auth & governance    — anonymous callers get the OPEN tier; API keys and
//      Auth0 JWTs unlock the RESTRICTED tier (lib/auth.js, lib/access.js), and
//      /assets/sign mints short-lived presigned R2 URLs for restricted objects.
//   4. Edge caching         — GET responses (tiles especially) cached at the POP,
//      so TiTiler doesn't re-render an identical tile for every agency. Cache
//      keys are scoped by access tier so open callers can never be served a
//      restricted response out of cache.
//   5. Rate limiting        — optional Cloudflare rate-limit binding (see
//      wrangler.toml). No-ops gracefully if the binding isn't configured.
//
// Config comes from wrangler.toml [env.*.vars] and secrets:
//   ORIGIN    — the upstream service, e.g. https://philsa-stac-api.onrender.com
//   KIND      — "stac" or "tiler" (controls POST-read allowlist + cache TTL)
//   WARM_PATH — (optional) lightweight health path the keep-warm cron pings;
//               defaults per KIND (see WARM_PATHS). See scheduled() at the bottom.
//   RESTRICTED_COLLECTIONS / RESTRICTED_ASSET_PREFIXES — the governance policy
//   AUTH0_DOMAIN / AUTH0_AUDIENCE / AUTH0_ROLES_CLAIM  — identity provider
//   R2_* (secrets) + R2_PRIVATE_BUCKET                 — presigned-URL minting
//   See deploy/AUTH.md for the whole picture.

import { resolvePrincipal, canReadRestricted, ANONYMOUS } from "./lib/auth.js";
import {
  restrictedCollections,
  restrictedAssetPrefixes,
  classifyStacPath,
  filterCollectionsList,
  filterFeatureCollection,
  requestedRestrictedCollections,
  tilerTargetsRestricted,
  privateObjectKey,
} from "./lib/access.js";
import { presignR2Get } from "./lib/presign.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  // Authorization / X-API-Key must be allow-listed or browsers refuse to send a
  // credential cross-origin — the webmap and STAC Browser both do exactly that.
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  "Access-Control-Max-Age": "86400",
};

// Endpoints that are READS but use POST, per origin kind. Everything else with a
// body-bearing method is a transaction (write) and is refused. Matched against
// the pathname (trailing slash tolerated).
//   stac  — OGC API / STAC search family (query goes in the body).
//   tiler — TiTiler statistics: the AOI geometry is POSTed as GeoJSON, but the
//           call only READS the COGs (zonal stats for the per-area time-series
//           CSV export). Matches /cog/statistics, /mosaicjson/statistics, etc.
const POST_READ_PATHS = {
  stac: [/^\/search\/?$/, /^\/aggregate\/?$/],
  tiler: [/\/statistics\/?$/],
};

const isReadMethod = (m) => m === "GET" || m === "HEAD" || m === "OPTIONS";

// Cache TTL (seconds) by origin kind. Tiles are immutable per-URL → cache hard.
// The STAC catalog changes on ingest → keep it short so new dates show up fast.
const CACHE_TTL = { tiler: 86400, stac: 60 };

// Lightweight health endpoint the keep-warm cron hits, by origin kind. Both
// return 200 cheaply without touching R2 or the DB, so a ping is nearly free at
// the origin. Overridable per env via the WARM_PATH var. (STAC's is the same
// path render.yaml sets as its healthCheckPath.)
const WARM_PATHS = { tiler: "/healthz", stac: "/_mgmt/ping" };

// Gateway-owned route: not proxied, answered here.
const SIGN_PATH = /^\/assets\/sign\/?$/;

function withCors(resp, { vary = true } = {}) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  // Responses differ by credential, so any shared cache downstream must key on
  // it too. (Our own edge cache handles this with a tier-scoped key instead.)
  if (vary) h.set("Vary", "Authorization, X-API-Key");
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function json(status, body, extraHeaders = {}) {
  return withCors(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...extraHeaders },
    }),
  );
}

const deny = (status, message, extra = {}) => json(status, { error: message, ...extra });

// 401 vs 403: no usable credential at all is "authenticate yourself"; a valid
// credential without the role is "you, specifically, may not have this".
function denyRestricted(principal, what) {
  if (principal.kind === "anon") {
    return json(
      401,
      {
        error: `${what} is part of the PhilSA restricted tier and requires a credential.`,
        detail: principal.error,
        how_to_get_access: "see deploy/AUTH.md",
      },
      { "WWW-Authenticate": 'Bearer realm="philsa", error="invalid_token"' },
    );
  }
  return json(403, {
    error: `${what} requires the 'partner' role; the credential presented does not have it.`,
    principal: principal.id,
  });
}

export default {
  async fetch(request, env, ctx) {
    if (!env.ORIGIN) return deny(500, "Gateway misconfigured: ORIGIN is unset.");
    const kind = env.KIND === "tiler" ? "tiler" : "stac";
    const url = new URL(request.url);

    // CORS preflight — answer at the edge, never hit the origin.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Read-only allowlist. GET/HEAD always OK; POST only for STAC search reads.
    const method = request.method.toUpperCase();
    if (!isReadMethod(method)) {
      const isPostRead =
        method === "POST" &&
        (POST_READ_PATHS[kind] ?? []).some((re) => re.test(url.pathname));
      if (!isPostRead) {
        return deny(
          405,
          "This is a read-only open-data API. Write/transaction methods are not permitted. " +
            "See deploy/DEPLOYMENT.md for the operator ingest path.",
        );
      }
    }

    // --- Who's asking? -------------------------------------------------------
    // Anonymous is the fast path: with no credential header we skip
    // resolvePrincipal entirely, so open-data traffic pays nothing (no KV read,
    // no JWKS fetch) for the auth layer existing.
    const hasCredential =
      request.headers.has("Authorization") || request.headers.has("X-API-Key");
    const principal = hasCredential ? await resolvePrincipal(request, env) : ANONYMOUS;
    const privileged = canReadRestricted(principal);

    const restricted = restrictedCollections(env);
    const assetPrefixes = restrictedAssetPrefixes(env);

    // --- Gateway-owned route: presigned URLs for restricted objects ----------
    if (kind === "stac" && SIGN_PATH.test(url.pathname)) {
      return handleSign({ url, env, principal, privileged, assetPrefixes });
    }

    // --- Policy: refuse what this caller may not see -------------------------
    let stacRoute = { route: "other", collection: null };
    if (kind === "stac") {
      stacRoute = classifyStacPath(url.pathname);

      if (
        stacRoute.route === "collection-scoped" &&
        restricted.has(stacRoute.collection) &&
        !privileged
      ) {
        return denyRestricted(principal, `Collection '${stacRoute.collection}'`);
      }

      if (stacRoute.route === "search" && !privileged) {
        // GET /search?collections=a,b — the body-bearing POST form is checked
        // after we read the body, below.
        const asked = requestedRestrictedCollections(
          url.searchParams.getAll("collections").join(","),
          restricted,
        );
        if (asked.length) return denyRestricted(principal, `Collection '${asked[0]}'`);
      }
    } else if (!privileged && tilerTargetsRestricted(url.searchParams, assetPrefixes)) {
      // Restricting the STAC collection is theatre unless the tiler refuses to
      // render the same object for an anonymous caller.
      return denyRestricted(principal, "This raster");
    }

    // POST /search with the query in the body — same rule, but we must buffer the
    // body to inspect it (and then forward the buffered copy, not the stream).
    let bufferedBody = null;
    if (kind === "stac" && method === "POST" && stacRoute.route === "search") {
      bufferedBody = await request.text();
      if (!privileged) {
        let parsed = null;
        try {
          parsed = JSON.parse(bufferedBody || "{}");
        } catch {
          return deny(400, "Malformed JSON body.");
        }
        const asked = requestedRestrictedCollections(parsed?.collections, restricted);
        if (asked.length) return denyRestricted(principal, `Collection '${asked[0]}'`);
      }
    }

    // Forward to origin, preserving the path + query.
    const originUrl = new URL(env.ORIGIN);
    originUrl.pathname = url.pathname;
    originUrl.search = url.search;

    // Edge cache for GET, checked BEFORE the rate limiter: a cache hit costs the
    // origin nothing, so it shouldn't burn the client's budget (map panning easily
    // exceeds any per-IP limit on already-cached tiles). Cache key is the full
    // origin URL (path+query) PLUS the access tier, so two agencies requesting the
    // same tile share one render while an anonymous caller can never be handed a
    // privileged (unfiltered) response out of cache. Everyone in the privileged
    // tier sees the same bytes — access is role-based, not per-key — so one shared
    // "priv" bucket is correct.
    const cacheable = method === "GET";
    const cache = caches.default;
    const cacheKey = new Request(tierScopedCacheUrl(originUrl, privileged), { method: "GET" });

    try {
      if (cacheable) {
        const hit = await cache.match(cacheKey);
        if (hit) return withCors(hit);
      }

      // Optional rate limiting (Cloudflare rate-limit binding; see wrangler.toml).
      // Only cache misses reach here — the requests that actually cost the origin.
      // Keyed by principal for credentialed callers (so one agency's bulk pull is
      // measured against its own key, not the NAT it happens to share) and by
      // client IP for anonymous ones.
      if (env.RATE_LIMITER) {
        const bucket =
          principal.kind === "anon"
            ? (request.headers.get("CF-Connecting-IP") ?? "anon")
            : `${principal.kind}:${principal.id}`;
        const { success } = await env.RATE_LIMITER.limit({ key: `${kind}:${bucket}` });
        if (!success) return deny(429, "Rate limit exceeded — slow down or request an API key.");
      }

      const fwdHeaders = new Headers(request.headers);
      // Drop the inbound Host (…workers.dev) so the subrequest's Host is derived
      // from originUrl — Render routes by Host, and forwarding the gateway's Host
      // would 404 at the origin.
      fwdHeaders.delete("host");
      // The origin has no idea what our credentials mean and must never see them
      // (it would echo them into its logs at best, act on them at worst).
      fwdHeaders.delete("authorization");
      fwdHeaders.delete("x-api-key");
      // Tell the origin its public host is THIS worker, so stac-fastapi's
      // ProxyHeaderMiddleware builds self/next links pointing at the gateway (not
      // the onrender origin) — otherwise paginated STAC link-following would walk
      // clients straight off the gateway.
      fwdHeaders.set("X-Forwarded-Host", url.host);
      fwdHeaders.set("X-Forwarded-Proto", "https");

      const init = { method, headers: fwdHeaders };
      if (!isReadMethod(method)) {
        // POST /search: we buffered the body to police `collections`, so forward
        // the buffer. Anything else still streams (duplex is required for that).
        init.body = bufferedBody ?? request.body;
        if (bufferedBody === null) init.duplex = "half";
      }
      const originResp = await fetch(originUrl.toString(), init);

      // Redact restricted entries from list-shaped responses. A caller without the
      // role must not learn a restricted collection exists by seeing it in
      // /collections, nor receive its items from an unscoped /search.
      const filtered = await filterResponse({
        resp: originResp,
        kind,
        route: stacRoute.route,
        restricted,
        privileged,
      });

      if (cacheable && filtered.ok) {
        const ttl = CACHE_TTL[kind] ?? 60;
        const toCache = new Response(filtered.body, filtered);
        toCache.headers.set("Cache-Control", `public, max-age=${ttl}`);
        ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
        return withCors(toCache);
      }

      return withCors(filtered);
    } catch (err) {
      // The free-tier Render origin sleeps and takes ~30–60 s to wake; a cold
      // start can exceed the subrequest timeout, and DNS/network blips throw too.
      // Return a CORS'd 502 so browser consumers see the real cause, not an opaque
      // CORS error from an unhandled exception (which would omit CORS headers).
      console.error(JSON.stringify({
        msg: "gateway origin error", kind, method, path: url.pathname, error: String(err),
      }));
      return deny(502, "Upstream service is unavailable or waking up — please retry in ~30–60 s.");
    }
  },

  // Keep-warm cron. The free-tier Render origins sleep after ~15 min idle, so the
  // first real request after a lull eats a ~30–60 s cold start (the one visible
  // wart in a demo — see the fetch() catch above). A Cloudflare Cron Trigger
  // (wrangler.toml [env.*.triggers]) fires this every ~10 min to ping the origin's
  // lightweight health endpoint, keeping it warm. Free, same account, no new
  // service. NB: only a warm/paid origin removes cold starts — a custom domain or
  // the edge cache would NOT (the cache serves hits without waking the origin, but
  // the first miss still pays the wake cost).
  async scheduled(event, env, ctx) {
    if (!env.ORIGIN) {
      console.error(JSON.stringify({ msg: "keep-warm skipped: ORIGIN unset", cron: event.cron }));
      return;
    }
    const kind = env.KIND === "tiler" ? "tiler" : "stac";
    const path = env.WARM_PATH ?? WARM_PATHS[kind] ?? "/";
    const target = new URL(env.ORIGIN);
    target.pathname = path;

    ctx.waitUntil(
      (async () => {
        const t0 = Date.now();
        try {
          // cf.cacheTtl:0 so the warm-up always reaches the origin (a cached ping
          // would wake nothing). Redirect-manual: a health 200 shouldn't redirect,
          // but don't chase one if it does.
          const resp = await fetch(target.toString(), {
            method: "GET",
            redirect: "manual",
            cf: { cacheTtl: 0 },
          });
          console.log(JSON.stringify({
            msg: "keep-warm ping", kind, path, status: resp.status, ms: Date.now() - t0,
          }));
        } catch (err) {
          console.error(JSON.stringify({
            msg: "keep-warm ping failed", kind, path, ms: Date.now() - t0, error: String(err),
          }));
        }
      })(),
    );
  },
};

// The edge cache is keyed by URL, so the access tier has to be *in* the URL. This
// synthetic param never reaches the origin — it only partitions the cache.
function tierScopedCacheUrl(originUrl, privileged) {
  const keyUrl = new URL(originUrl.toString());
  keyUrl.searchParams.set("__tier", privileged ? "priv" : "open");
  return keyUrl.toString();
}

// Rewrite list-shaped JSON responses to drop restricted entries. Anything that
// isn't a 2xx JSON list passes through untouched, so error bodies and tile bytes
// are never parsed.
async function filterResponse({ resp, kind, route, restricted, privileged }) {
  const needsFilter =
    kind === "stac" &&
    !privileged &&
    restricted.size > 0 &&
    (route === "collections-list" || route === "search") &&
    resp.ok &&
    (resp.headers.get("Content-Type") ?? "").includes("json");

  if (!needsFilter) return resp;

  let body;
  try {
    body = await resp.clone().json();
  } catch {
    return resp; // not the JSON we expected — pass it through rather than mangle it
  }

  const out =
    route === "collections-list"
      ? filterCollectionsList(body, restricted)
      : filterFeatureCollection(body, restricted);

  const headers = new Headers(resp.headers);
  headers.delete("Content-Length"); // the body length just changed
  return new Response(JSON.stringify(out), {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

// GET /assets/sign?url=<asset href|object key>[&expires=<seconds>]
//
// Mints a short-lived presigned URL into the PRIVATE R2 bucket. Deliberately
// narrow: it only signs keys under RESTRICTED_ASSET_PREFIXES, so a leaked partner
// key can't turn the gateway into an open proxy for the whole bucket.
async function handleSign({ url, env, principal, privileged, assetPrefixes }) {
  if (!privileged) return denyRestricted(principal, "Presigned asset access");

  const target = url.searchParams.get("url") ?? url.searchParams.get("key");
  if (!target) return deny(400, "Missing required query parameter: url (or key).");

  const key = privateObjectKey(target, assetPrefixes);
  if (!key) {
    return deny(
      404,
      "That object is not part of the restricted tier. Open assets are served directly " +
        "from public R2 — they need no signing.",
    );
  }

  if (!env.R2_PRIVATE_BUCKET || !env.R2_ACCOUNT_ID || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    return deny(503, "Presigned asset access is not configured on this gateway.");
  }

  const maxTtl = Number(env.PRESIGN_MAX_TTL_SECONDS ?? 900);
  const requested = Number(url.searchParams.get("expires") ?? env.PRESIGN_TTL_SECONDS ?? 300);
  const expiresIn = Math.min(Math.max(Number.isFinite(requested) ? requested : 300, 30), maxTtl);

  try {
    const signed = await presignR2Get({
      accountId: env.R2_ACCOUNT_ID,
      bucket: env.R2_PRIVATE_BUCKET,
      key,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      expiresIn,
    });
    // Audit trail: who signed for what. Workers Logs retains these (see
    // wrangler.toml [observability]) — this IS the access log for restricted data.
    console.log(JSON.stringify({
      msg: "presigned restricted asset",
      principal: principal.id,
      via: principal.kind,
      key,
      expiresIn,
    }));
    return json(
      200,
      {
        url: signed,
        key,
        expires_in: expiresIn,
        expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      },
      { "Cache-Control": "no-store" },
    );
  } catch (err) {
    console.error(JSON.stringify({ msg: "presign failed", key, error: String(err) }));
    return deny(500, "Could not sign that object.");
  }
}
