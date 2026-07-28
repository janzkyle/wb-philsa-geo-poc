// AWS Signature Version 4 — presigned GET URLs for Cloudflare R2.
//
// Why hand-rolled: the AWS SDK is far too heavy for a Worker bundle, and all we
// need is the query-string ("presigned URL") flavour of SigV4 for a single verb.
// Everything here is Web Crypto, so it runs on the Workers runtime unmodified.
//
// The URLs this mints are what a restricted consumer actually downloads with —
// GDAL/QGIS/rasterio range-read them directly from R2, so large COGs never
// stream through the Worker (no CPU time, no egress, and Range requests keep
// working, which is the whole point for cloud-optimized formats).
//
// R2 specifics: region is always "auto", and we sign PATH-style
// (https://<account>.r2.cloudflarestorage.com/<bucket>/<key>) to match the
// AWS_VIRTUAL_HOSTING=FALSE convention the rest of the POC uses (see
// render.yaml's TiTiler service).

const enc = new TextEncoder();

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(data) {
  const buf = await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data);
  return hex(new Uint8Array(buf));
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

// AWS's URI encoding is stricter than encodeURIComponent: only A-Z a-z 0-9 - _ . ~
// stay literal. encodeURIComponent leaves !'()* alone, so patch those up.
const uriEncode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

// Object keys keep their "/" separators unencoded (they're path structure), but
// every segment is otherwise encoded.
const encodeKey = (key) => key.split("/").map(uriEncode).join("/");

// "20260728T031500Z" and "20260728" — SigV4's two date formats.
function amzDates(nowMs) {
  const iso = new Date(nowMs).toISOString();
  const amzDate = iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Mint a presigned GET URL for an R2 object.
 *
 * @param {object} o
 * @param {string} o.accountId      Cloudflare account id (the r2.cloudflarestorage.com subdomain)
 * @param {string} o.bucket         Bucket name (path-style, so it's the first path segment)
 * @param {string} o.key            Object key, e.g. "02-silver/sentinel1-flood/scene.tif"
 * @param {string} o.accessKeyId    R2 access key id
 * @param {string} o.secretAccessKey R2 secret
 * @param {number} o.expiresIn      Lifetime in seconds (SigV4 caps this at 604800 = 7 days)
 * @param {number} [o.nowMs]        Clock override, for tests
 * @returns {Promise<string>} the signed URL
 */
export async function presignR2Get({
  accountId,
  bucket,
  key,
  accessKeyId,
  secretAccessKey,
  expiresIn = 300,
  nowMs = Date.now(),
}) {
  if (!accountId || !bucket || !key) throw new Error("presignR2Get: accountId, bucket and key are required");
  if (!accessKeyId || !secretAccessKey) throw new Error("presignR2Get: R2 credentials are not configured");

  const expires = Math.min(Math.max(Math.floor(expiresIn), 1), 604800);
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const region = "auto";
  const service = "s3";
  const { amzDate, dateStamp } = amzDates(nowMs);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = `/${uriEncode(bucket)}/${encodeKey(key)}`;

  // Query params must be sorted by key for the canonical request. All five are
  // already in sorted order below, but we sort explicitly so future additions
  // can't silently break the signature.
  const params = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join("&");

  const canonicalRequest = [
    "GET",
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  // Derive the signing key: kSecret -> kDate -> kRegion -> kService -> kSigning.
  let signing = enc.encode(`AWS4${secretAccessKey}`);
  for (const part of [dateStamp, region, service, "aws4_request"]) {
    signing = await hmac(signing, part);
  }
  const signature = hex(await hmac(signing, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export const __test = { uriEncode, encodeKey, amzDates, sha256Hex };
