// Caller identity for the PhilSA gateway — two credential types, one result.
//
// The gateway serves two very different consumers (see PHILSA_INTEROP_API.md):
//
//   • server-side consumers (an agency's backend, a cron job, QGIS) CAN hold a
//     secret  -> long-lived **API key**, verified against Workers KV;
//   • browser users signing in to the webmap / STAC Browser CANNOT hold a secret
//     -> short-lived **Auth0 JWT**, verified against the tenant's JWKS.
//
// Both collapse into one `Principal` so the policy code downstream never has to
// care which was used. Anonymous requests are a Principal too (role `public`) —
// open data stays open with no credential at all, which is the entire point.
//
// Swapping Auth0 for PhilSA's or CopPhil's Keycloak later is a change to
// AUTH0_ISSUER/AUTH0_AUDIENCE, not a change to this file: everything below is
// plain OIDC discovery + RS256 verification.

const enc = new TextEncoder();

const ROLE_PUBLIC = "public";
const ROLE_PARTNER = "partner";
const ROLE_ADMIN = "admin";

// Roles that may see the restricted tier. `admin` is included so an operator
// token isn't locked out of its own data.
const RESTRICTED_ROLES = new Set([ROLE_PARTNER, ROLE_ADMIN]);

export const ANONYMOUS = Object.freeze({
  kind: "anon",
  id: "anonymous",
  roles: Object.freeze([ROLE_PUBLIC]),
});

/** Does this principal get the restricted tier? */
export const canReadRestricted = (principal) =>
  (principal?.roles ?? []).some((r) => RESTRICTED_ROLES.has(r));

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(s) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s))));
}

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

// ---------------------------------------------------------------- API keys --
//
// KV stores only the SHA-256 of each key, never the key itself: a dump of the
// namespace leaks nothing usable. Lookup is by hash, so there's no string
// comparison to time-attack — the key either exists or it doesn't.
//
//   KV key   : `key:<sha256-hex>`
//   KV value : {"name":"PCIC","roles":["partner"],"created":"2026-07-28","note":"…"}
//
// Mint them with `node scripts/mint-key.mjs` (see that file).

const KEY_PREFIX = "key:";

function readKeyMaterial(request) {
  const direct = request.headers.get("X-API-Key");
  if (direct) return direct.trim();
  const authz = request.headers.get("Authorization") ?? "";
  const m = /^ApiKey\s+(.+)$/i.exec(authz.trim());
  return m ? m[1].trim() : null;
}

async function verifyApiKey(request, env) {
  const raw = readKeyMaterial(request);
  if (!raw) return null;
  if (!env.API_KEYS) return null; // KV not bound — no keys can be valid

  const record = await env.API_KEYS.get(KEY_PREFIX + (await sha256Hex(raw)), "json");
  if (!record) return null;
  if (record.revoked) return null;
  if (record.expires && Date.parse(record.expires) <= Date.now()) return null;

  return {
    kind: "key",
    id: record.name ?? "unnamed-key",
    roles: Array.isArray(record.roles) && record.roles.length ? record.roles : [ROLE_PARTNER],
  };
}

// -------------------------------------------------------------- Auth0 JWTs --

// JWKS cache. Module scope survives across requests in a warm isolate, which is
// the common case; the TTL bounds how long a rotated-out key stays trusted.
const JWKS_TTL_MS = 10 * 60 * 1000;
let jwksCache = { url: null, keys: null, fetchedAt: 0 };

function issuerOf(env) {
  // Accept either a full issuer URL or a bare tenant domain.
  const raw = env.AUTH0_ISSUER || env.AUTH0_DOMAIN;
  if (!raw) return null;
  const url = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  return url.endsWith("/") ? url : url + "/";
}

async function fetchJwks(env, { force = false } = {}) {
  const issuer = issuerOf(env);
  if (!issuer) return null;
  const url = `${issuer}.well-known/jwks.json`;

  const fresh = jwksCache.url === url && jwksCache.keys && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  if (fresh && !force) return jwksCache.keys;

  const resp = await fetch(url, { cf: { cacheTtl: 600, cacheEverything: true } });
  if (!resp.ok) throw new Error(`JWKS fetch failed: ${resp.status}`);
  const { keys } = await resp.json();
  jwksCache = { url, keys: keys ?? [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

async function importJwk(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

function rolesFromClaims(claims, env) {
  const claimName = env.AUTH0_ROLES_CLAIM || "https://philsa.gov.ph/roles";
  const out = new Set();
  const direct = claims[claimName];
  if (Array.isArray(direct)) direct.forEach((r) => out.add(String(r)));
  else if (typeof direct === "string") direct.split(/[\s,]+/).filter(Boolean).forEach((r) => out.add(r));

  // Auth0 RBAC-on-API also emits `permissions`; treat a `read:restricted`
  // permission as equivalent to the partner role so either tenant setup works.
  if (Array.isArray(claims.permissions) && claims.permissions.includes("read:restricted")) {
    out.add(ROLE_PARTNER);
  }
  out.add(ROLE_PUBLIC);
  return [...out];
}

/**
 * Verify a bearer JWT. Returns a principal, or throws with a reason string.
 * Clock skew of 60 s is allowed on exp/nbf, the usual OIDC tolerance.
 */
async function verifyJwt(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts;

  let header, claims;
  try {
    header = b64urlToJson(h);
    claims = b64urlToJson(p);
  } catch {
    throw new Error("malformed token");
  }

  // Pin the algorithm. Accepting `alg` from the token is the classic JWT
  // vulnerability (alg:none, or HS256 signed with the public key).
  if (header.alg !== "RS256") throw new Error("unsupported token algorithm");

  let keys = await fetchJwks(env);
  if (!keys) throw new Error("identity provider is not configured");
  let jwk = keys.find((k) => k.kid === header.kid && (k.alg ?? "RS256") === "RS256");
  if (!jwk) {
    // Unknown kid usually means the tenant rotated its signing key — refetch once.
    keys = await fetchJwks(env, { force: true });
    jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error("unknown signing key");
  }

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    await importJwk(jwk),
    b64urlToBytes(s),
    enc.encode(`${h}.${p}`),
  );
  if (!ok) throw new Error("bad token signature");

  const now = Date.now() / 1000;
  const skew = 60;
  if (typeof claims.exp === "number" && claims.exp + skew < now) throw new Error("token expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new Error("token not yet valid");

  const issuer = issuerOf(env);
  if (claims.iss !== issuer) throw new Error("wrong token issuer");

  const audience = env.AUTH0_AUDIENCE;
  if (audience) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(audience)) throw new Error("wrong token audience");
  }

  return { kind: "jwt", id: claims.sub ?? "unknown-subject", roles: rolesFromClaims(claims, env) };
}

// ------------------------------------------------------------------ public --

/**
 * Resolve the caller. Never throws: a bad credential degrades to anonymous with
 * `error` set, so open data keeps working and the caller still gets told why
 * their credential was ignored when they ask for something restricted.
 */
export async function resolvePrincipal(request, env) {
  try {
    const key = await verifyApiKey(request, env);
    if (key) return key;

    const authz = request.headers.get("Authorization") ?? "";
    const bearer = /^Bearer\s+(.+)$/i.exec(authz.trim());
    if (bearer) return await verifyJwt(bearer[1].trim(), env);

    // A credential was offered in a shape we recognise but couldn't validate.
    if (readKeyMaterial(request)) return { ...ANONYMOUS, error: "invalid API key" };

    return ANONYMOUS;
  } catch (err) {
    return { ...ANONYMOUS, error: String(err.message ?? err) };
  }
}

export const __test = { verifyJwt, rolesFromClaims, issuerOf, b64urlToJson, RESTRICTED_ROLES };
