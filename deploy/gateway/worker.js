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
//      GET/HEAD/OPTIONS pass, plus POST to the STAC search endpoints.
//   2. Open-data CORS       — one consistent CORS contract for browser consumers.
//   3. Edge caching         — GET responses (tiles especially) cached at the POP,
//      so TiTiler doesn't re-render an identical tile for every agency.
//   4. Rate limiting        — optional Cloudflare rate-limit binding (see
//      wrangler.toml). No-ops gracefully if the binding isn't configured.
//
// Later (Phase 3) this is also where per-key auth for RESTRICTED collections and
// presigned-R2 minting hangs — see the API_KEYS hook near the bottom.
//
// Config comes from wrangler.toml [env.*.vars]:
//   ORIGIN  — the upstream service, e.g. https://philsa-stac-api.onrender.com
//   KIND    — "stac" or "tiler" (controls POST-read allowlist + cache TTL)

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// STAC endpoints that are READS but use POST (OGC API / STAC search family).
// Everything else with a body-bearing method is a transaction (write) and is
// refused. Matched against the pathname (trailing slash tolerated).
const POST_READ_PATHS = [/^\/search\/?$/, /^\/aggregate\/?$/];

const isReadMethod = (m) => m === "GET" || m === "HEAD" || m === "OPTIONS";

// Cache TTL (seconds) by origin kind. Tiles are immutable per-URL → cache hard.
// The STAC catalog changes on ingest → keep it short so new dates show up fast.
const CACHE_TTL = { tiler: 86400, stac: 60 };

function withCors(resp) {
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

function deny(status, message) {
  return withCors(
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
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
        method === "POST" && kind === "stac" && POST_READ_PATHS.some((re) => re.test(url.pathname));
      if (!isPostRead) {
        return deny(
          405,
          "This is a read-only open-data API. Write/transaction methods are not permitted. " +
            "See deploy/DEPLOYMENT.md for the operator ingest path.",
        );
      }
    }

    // Forward to origin, preserving the path + query.
    const originUrl = new URL(env.ORIGIN);
    originUrl.pathname = url.pathname;
    originUrl.search = url.search;

    // Edge cache for GET, checked BEFORE the rate limiter: a cache hit costs the
    // origin nothing, so it shouldn't burn the client's budget (map panning easily
    // exceeds any per-IP limit on already-cached tiles). Cache key is the full
    // origin URL (path+query), so two agencies requesting the same tile share one
    // render.
    const cacheable = method === "GET";
    const cache = caches.default;
    const cacheKey = new Request(originUrl.toString(), { method: "GET" });

    if (cacheable) {
      const hit = await cache.match(cacheKey);
      if (hit) return withCors(hit);
    }

    // Optional rate limiting (Cloudflare rate-limit binding; see wrangler.toml).
    // Only cache misses reach here — the requests that actually cost the origin.
    // Keyed by client IP so one agency's bulk pull can't starve the rest.
    if (env.RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "anon";
      const { success } = await env.RATE_LIMITER.limit({ key: `${kind}:${ip}` });
      if (!success) return deny(429, "Rate limit exceeded — slow down or request an API key.");
    }

    // --- Phase 3 hook: per-key auth for restricted collections ---------------
    // if (routeIsRestricted(url) && !(await validKey(request, env))) {
    //   return deny(401, "Restricted collection — a valid API key is required.");
    // }
    // (open collections stay anonymous; keys only gate the private/licensed tier)

    // Tell the origin its public host is THIS worker, so stac-fastapi's
    // ProxyHeaderMiddleware builds self/next links pointing at the gateway
    // (not the onrender origin) — otherwise paginated STAC link-following would
    // walk clients straight off the gateway.
    const fwdHeaders = new Headers(request.headers);
    fwdHeaders.set("X-Forwarded-Host", url.host);
    fwdHeaders.set("X-Forwarded-Proto", "https");

    const init = { method, headers: fwdHeaders };
    if (!isReadMethod(method)) {
      // POST /search forwards the client's body stream; the fetch spec requires
      // duplex for stream bodies (harmless where the runtime doesn't enforce it).
      init.body = request.body;
      init.duplex = "half";
    }
    const originResp = await fetch(originUrl.toString(), init);

    if (cacheable && originResp.ok) {
      const ttl = CACHE_TTL[kind] ?? 60;
      const toCache = new Response(originResp.clone().body, originResp);
      toCache.headers.set("Cache-Control", `public, max-age=${ttl}`);
      ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
      return withCors(toCache);
    }

    return withCors(originResp);
  },
};
