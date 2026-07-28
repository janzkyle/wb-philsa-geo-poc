// Collection-level access policy for the PhilSA catalog.
//
// The POC's governance model is deliberately coarse: sensitivity is a property
// of a COLLECTION, not of individual items. That matches how the data is
// actually licensed (a whole product is open or it isn't) and it keeps
// enforcement cheap — no per-item lookups on the hot path.
//
// The list of restricted collections lives in `RESTRICTED_COLLECTIONS`
// (wrangler.toml var) and is the ENFORCEMENT authority. The matching
// `philsa:access` property on the collection in pgSTAC is DOCUMENTATION — it
// tells a consumer why a collection is missing/refused. Keep them in sync with
// `deploy/scripts/tag-collection-access.sh`.
//
// Everything here is pure, so it unit-tests without a Worker runtime.

const csv = (s) =>
  String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export const restrictedCollections = (env) => new Set(csv(env.RESTRICTED_COLLECTIONS));

/** Object-key prefixes in R2 whose bytes belong to the restricted tier. */
export const restrictedAssetPrefixes = (env) => csv(env.RESTRICTED_ASSET_PREFIXES);

/**
 * Classify a STAC path. Returns the collection the request is scoped to (if
 * any) and whether it's one of the search-style endpoints whose *response* has
 * to be filtered rather than simply refused.
 */
export function classifyStacPath(pathname) {
  const p = pathname.replace(/\/+$/, "") || "/";

  if (p === "/search" || p === "/aggregate") return { route: "search", collection: null };
  if (p === "/collections") return { route: "collections-list", collection: null };

  const m = /^\/collections\/([^/]+)(\/.*)?$/.exec(p);
  if (m) {
    return { route: "collection-scoped", collection: decodeURIComponent(m[1]) };
  }
  return { route: "other", collection: null };
}

/** Strip restricted entries from a GET /collections payload. */
export function filterCollectionsList(body, restricted) {
  if (!body || !Array.isArray(body.collections) || restricted.size === 0) return body;
  const kept = body.collections.filter((c) => !restricted.has(c?.id));
  if (kept.length === body.collections.length) return body;
  return { ...body, collections: kept, numberReturned: kept.length };
}

/** Strip restricted features from a /search (or /aggregate) FeatureCollection. */
export function filterFeatureCollection(body, restricted) {
  if (!body || !Array.isArray(body.features) || restricted.size === 0) return body;
  const kept = body.features.filter((f) => !restricted.has(f?.collection));
  if (kept.length === body.features.length) return body;
  // numberMatched is upstream's pre-filter count; leaving it alone would overstate
  // the result set, so it becomes an upper bound. numberReturned must be exact.
  return { ...body, features: kept, numberReturned: kept.length };
}

/**
 * Which restricted collections did a search request explicitly ask for?
 *
 * Explicitly naming a restricted collection earns a 401 (so the consumer learns
 * the collection exists and needs a credential) rather than a silently empty
 * page. A search that names NOTHING is the dangerous case — it means "every
 * collection", so its response must be filtered. That's the classic bypass and
 * the reason this returns a list rather than a boolean.
 */
export function requestedRestrictedCollections(collectionsParam, restricted) {
  if (restricted.size === 0) return [];
  let asked = [];
  if (Array.isArray(collectionsParam)) asked = collectionsParam.map(String);
  else if (typeof collectionsParam === "string") asked = csv(collectionsParam);
  return asked.filter((c) => restricted.has(c));
}

/**
 * Reduce any asset reference to a bare object key.
 *
 * The same object legitimately appears in several URL shapes across the POC:
 *
 *   https://pub-<id>.r2.dev/02-silver/…            (public bucket, virtual-hosted)
 *   https://<account>.r2.cloudflarestorage.com/<bucket>/02-silver/…   (path-style)
 *   s3://<bucket>/02-silver/…
 *   02-silver/…                                     (bare key)
 *
 * The path-style forms carry a leading bucket segment that the r2.dev form does
 * not, so a naive startsWith() against "02-silver/…" would miss exactly the URLs
 * an object gets AFTER it moves into the private bucket. Returns both the raw
 * path and the bucket-stripped candidate so callers can match either.
 */
function objectKeyCandidates(value) {
  let path = value;
  try {
    if (/^[a-z0-9+.-]+:\/\//i.test(value)) {
      const u = new URL(value);
      // s3://bucket/key puts the bucket in the host, not the path.
      path = u.protocol === "s3:" ? `${u.host}${u.pathname}` : u.pathname;
    }
  } catch {
    /* not a URL — treat the raw value as a path */
  }
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path; // malformed %-escape; match on the literal text instead
  }
  const raw = decoded.replace(/^\/+/, "");
  const slash = raw.indexOf("/");
  const withoutBucket = slash === -1 ? null : raw.slice(slash + 1);
  return [raw, withoutBucket].filter(Boolean);
}

const matchesPrefix = (candidates, prefixes) =>
  candidates.some((c) => prefixes.some((p) => c.startsWith(p.replace(/^\/+/, ""))));

/**
 * Does a TiTiler request point at restricted bytes?
 *
 * TiTiler takes the COG location as a query param (`url`, or `urls`/`url_1…` for
 * mosaic-ish endpoints), so restricting the STAC collection is meaningless unless
 * the tiler refuses to render the same object. Prefix-matching the object key is
 * enough because R2 keys are laid out per product (`02-silver/<product>/…`).
 */
export function tilerTargetsRestricted(searchParams, prefixes) {
  if (!prefixes.length) return false;
  for (const [name, value] of searchParams) {
    if (!/^urls?(_\d+)?$/i.test(name)) continue;
    if (matchesPrefix(objectKeyCandidates(value), prefixes)) return true;
  }
  return false;
}

/**
 * Map an asset reference to the object key to sign in the PRIVATE bucket.
 * Returns null when the target isn't in the restricted tier at all — that's what
 * stops /assets/sign being a general-purpose proxy for the whole bucket.
 */
export function privateObjectKey(target, prefixes) {
  if (!target) return null;
  const candidates = objectKeyCandidates(target);
  // Reject traversal before matching: "…/flood/../../secret.tif" must never sign.
  if (candidates.some((c) => c.split("/").includes(".."))) return null;
  return candidates.find((c) => prefixes.some((p) => c.startsWith(p.replace(/^\/+/, "")))) ?? null;
}
