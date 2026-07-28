// Unit tests for the gateway's access policy + presigner.
//
//   cd deploy/gateway && node --test test/
//
// Everything under test is pure (or Web Crypto only), so this runs in plain Node
// with no Worker runtime, no network, and no Cloudflare account.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  restrictedCollections,
  restrictedAssetPrefixes,
  classifyStacPath,
  filterCollectionsList,
  filterFeatureCollection,
  requestedRestrictedCollections,
  tilerTargetsRestricted,
  privateObjectKey,
} from "../lib/access.js";
import { presignR2Get } from "../lib/presign.js";

const ENV = {
  RESTRICTED_COLLECTIONS: "sentinel1-flood",
  RESTRICTED_ASSET_PREFIXES: "02-silver/sentinel1-flood/",
};
const RESTRICTED = restrictedCollections(ENV);
const PREFIXES = restrictedAssetPrefixes(ENV);

test("config parsing tolerates spacing and empty values", () => {
  assert.deepEqual([...restrictedCollections({ RESTRICTED_COLLECTIONS: " a , b ,, " })], ["a", "b"]);
  assert.equal(restrictedCollections({}).size, 0);
  assert.deepEqual(restrictedAssetPrefixes({}), []);
});

test("classifyStacPath identifies the routes that need policing", () => {
  assert.deepEqual(classifyStacPath("/collections"), { route: "collections-list", collection: null });
  assert.deepEqual(classifyStacPath("/collections/"), { route: "collections-list", collection: null });
  assert.deepEqual(classifyStacPath("/search"), { route: "search", collection: null });
  assert.deepEqual(classifyStacPath("/aggregate"), { route: "search", collection: null });
  assert.equal(classifyStacPath("/collections/sentinel1-flood").route, "collection-scoped");
  assert.equal(classifyStacPath("/collections/sentinel1-flood").collection, "sentinel1-flood");
  // Every sub-route of a collection is scoped to it — items, a single item, and
  // queryables all have to be refused, not just the collection document.
  for (const p of [
    "/collections/sentinel1-flood/items",
    "/collections/sentinel1-flood/items/some-scene-id",
    "/collections/sentinel1-flood/queryables",
  ]) {
    assert.equal(classifyStacPath(p).collection, "sentinel1-flood", p);
  }
  // A URL-encoded id must resolve to the same collection, or encoding it would
  // walk straight past the check.
  assert.equal(classifyStacPath("/collections/sentinel1%2Dflood").collection, "sentinel1-flood");
  assert.equal(classifyStacPath("/conformance").route, "other");
});

test("filterCollectionsList removes restricted entries and fixes the count", () => {
  const body = {
    collections: [{ id: "sentinel2-ndvi" }, { id: "sentinel1-flood" }, { id: "esri-10m-lulc" }],
    numberReturned: 3,
    links: [{ rel: "self" }],
  };
  const out = filterCollectionsList(body, RESTRICTED);
  assert.deepEqual(out.collections.map((c) => c.id), ["sentinel2-ndvi", "esri-10m-lulc"]);
  assert.equal(out.numberReturned, 2);
  assert.deepEqual(out.links, body.links, "untouched fields survive");
  // Nothing to strip → the very same object, so we never re-serialize for free.
  const clean = { collections: [{ id: "sentinel2-ndvi" }] };
  assert.equal(filterCollectionsList(clean, RESTRICTED), clean);
  assert.equal(filterCollectionsList(body, new Set()), body);
});

test("filterFeatureCollection removes restricted items from an unscoped search", () => {
  const body = {
    type: "FeatureCollection",
    features: [
      { id: "a", collection: "sentinel2-ndvi" },
      { id: "b", collection: "sentinel1-flood" },
    ],
    numberReturned: 2,
    numberMatched: 2,
  };
  const out = filterFeatureCollection(body, RESTRICTED);
  assert.deepEqual(out.features.map((f) => f.id), ["a"]);
  assert.equal(out.numberReturned, 1);
});

test("requestedRestrictedCollections catches explicit asks in both shapes", () => {
  assert.deepEqual(requestedRestrictedCollections("sentinel1-flood", RESTRICTED), ["sentinel1-flood"]);
  assert.deepEqual(
    requestedRestrictedCollections("sentinel2-ndvi,sentinel1-flood", RESTRICTED),
    ["sentinel1-flood"],
  );
  assert.deepEqual(requestedRestrictedCollections(["sentinel1-flood"], RESTRICTED), ["sentinel1-flood"]);
  assert.deepEqual(requestedRestrictedCollections("sentinel2-ndvi", RESTRICTED), []);
  // The bypass that matters: naming NOTHING means "all collections". It must not
  // read as an explicit ask (that's what response filtering is for), but it must
  // also never be treated as safe to pass through unfiltered.
  assert.deepEqual(requestedRestrictedCollections(undefined, RESTRICTED), []);
  assert.deepEqual(requestedRestrictedCollections("", RESTRICTED), []);
});

test("tilerTargetsRestricted spots restricted COGs in every url param shape", () => {
  const q = (s) => new URLSearchParams(s);
  const pub = "https://pub-17ab60a2ca7142a48ae8e2685cd853f7.r2.dev";

  assert.equal(tilerTargetsRestricted(q(`url=${pub}/02-silver/sentinel1-flood/scene.tif`), PREFIXES), true);
  assert.equal(tilerTargetsRestricted(q(`url=${pub}/02-silver/sentinel2-ndvi/scene.tif`), PREFIXES), false);
  // s3:// URIs and bare keys are both legal TiTiler inputs.
  assert.equal(tilerTargetsRestricted(q("url=s3://bucket/02-silver/sentinel1-flood/x.tif"), PREFIXES), true);
  assert.equal(tilerTargetsRestricted(q("url=02-silver/sentinel1-flood/x.tif"), PREFIXES), true);
  // Mosaic-style params must be covered too, or the restriction is one query
  // parameter away from being bypassed.
  assert.equal(tilerTargetsRestricted(q("urls=02-silver/sentinel1-flood/x.tif"), PREFIXES), true);
  assert.equal(tilerTargetsRestricted(q("url_1=02-silver/sentinel1-flood/x.tif"), PREFIXES), true);
  // Percent-encoded separators still resolve to the same path.
  assert.equal(tilerTargetsRestricted(q(`url=${pub}%2F02-silver%2Fsentinel1-flood%2Fx.tif`), PREFIXES), true);
  assert.equal(tilerTargetsRestricted(q("expression=b1"), PREFIXES), false);
  assert.equal(tilerTargetsRestricted(q("url=anything"), []), false, "no policy → nothing restricted");

  // Once an object MOVES into the private bucket its URL gains a bucket segment
  // (path-style R2). If that stopped matching, the tiler would happily render the
  // very objects the move was meant to protect.
  const priv = "https://acct.r2.cloudflarestorage.com/world-bank-philsa-geo-private";
  assert.equal(tilerTargetsRestricted(q(`url=${priv}/02-silver/sentinel1-flood/x.tif`), PREFIXES), true);
  assert.equal(tilerTargetsRestricted(q(`url=${priv}/02-silver/sentinel2-ndvi/x.tif`), PREFIXES), false);
  assert.equal(tilerTargetsRestricted(q("url=s3://some-bucket/02-silver/sentinel1-flood/x.tif"), PREFIXES), true);
});

test("privateObjectKey only resolves keys inside the restricted tier", () => {
  const pub = "https://pub-abc.r2.dev";
  const priv = "https://acct.r2.cloudflarestorage.com/world-bank-philsa-geo-private";
  const KEY = "02-silver/sentinel1-flood/scene.tif";

  // Every legal way of naming the same object resolves to the same bare key.
  assert.equal(privateObjectKey(`${pub}/${KEY}`, PREFIXES), KEY);
  assert.equal(privateObjectKey(`${priv}/${KEY}`, PREFIXES), KEY, "bucket segment is stripped");
  assert.equal(privateObjectKey(`s3://world-bank-philsa-geo-private/${KEY}`, PREFIXES), KEY);
  assert.equal(privateObjectKey(KEY, PREFIXES), KEY);
  assert.equal(privateObjectKey(`${pub}/02-silver/sentinel1-flood/a%20b.tif`, PREFIXES), "02-silver/sentinel1-flood/a b.tif");

  // Open data is not signable — it needs no signature, and signing it would turn
  // the endpoint into a proxy for the whole bucket.
  assert.equal(privateObjectKey(`${pub}/02-silver/sentinel2-ndvi/x.tif`, PREFIXES), null);
  // Path traversal must not escape the prefix check.
  assert.equal(privateObjectKey("02-silver/sentinel1-flood/../../secret.tif", PREFIXES), null);
  assert.equal(privateObjectKey(`${priv}/02-silver/sentinel1-flood/../../../secret.tif`, PREFIXES), null);
  assert.equal(privateObjectKey("", PREFIXES), null);
  assert.equal(privateObjectKey(null, PREFIXES), null);
});

// --------------------------------------------------------------- presigning --

const CREDS = {
  accountId: "abc123",
  bucket: "world-bank-philsa-geo-private",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  nowMs: Date.parse("2026-07-28T03:15:00Z"),
};

test("presignR2Get builds a well-formed SigV4 URL", async () => {
  const signed = await presignR2Get({ ...CREDS, key: "02-silver/sentinel1-flood/scene.tif", expiresIn: 300 });
  const u = new URL(signed);

  assert.equal(u.host, "abc123.r2.cloudflarestorage.com");
  assert.equal(u.pathname, "/world-bank-philsa-geo-private/02-silver/sentinel1-flood/scene.tif");
  assert.equal(u.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(u.searchParams.get("X-Amz-Credential"), `${CREDS.accessKeyId}/20260728/auto/s3/aws4_request`);
  assert.equal(u.searchParams.get("X-Amz-Date"), "20260728T031500Z");
  assert.equal(u.searchParams.get("X-Amz-Expires"), "300");
  assert.equal(u.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.match(u.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
});

test("presignR2Get is deterministic and credential-sensitive", async () => {
  const opts = { ...CREDS, key: "02-silver/sentinel1-flood/scene.tif" };
  const a = await presignR2Get(opts);
  const b = await presignR2Get(opts);
  assert.equal(a, b, "same inputs → same signature");

  const other = await presignR2Get({ ...opts, secretAccessKey: "different-secret-entirely" });
  assert.notEqual(
    new URL(a).searchParams.get("X-Amz-Signature"),
    new URL(other).searchParams.get("X-Amz-Signature"),
  );

  // The signature must cover the key, or one signed URL would unlock the bucket.
  const elsewhere = await presignR2Get({ ...opts, key: "02-silver/sentinel1-flood/other.tif" });
  assert.notEqual(
    new URL(a).searchParams.get("X-Amz-Signature"),
    new URL(elsewhere).searchParams.get("X-Amz-Signature"),
  );
});

test("presignR2Get clamps the lifetime and rejects missing config", async () => {
  const key = "02-silver/sentinel1-flood/scene.tif";
  const tooLong = await presignR2Get({ ...CREDS, key, expiresIn: 99_999_999 });
  assert.equal(new URL(tooLong).searchParams.get("X-Amz-Expires"), "604800", "SigV4's 7-day ceiling");

  await assert.rejects(() => presignR2Get({ ...CREDS, key, accessKeyId: "", secretAccessKey: "" }), /credentials/);
  await assert.rejects(() => presignR2Get({ ...CREDS, key: "" }), /required/);
});

test("presignR2Get encodes keys the way AWS expects", async () => {
  // Spaces and parentheses appear in real scene filenames; getting their encoding
  // wrong yields a URL that signs cleanly and then 403s at R2.
  const signed = await presignR2Get({ ...CREDS, key: "02-silver/sentinel1-flood/a b (1).tif" });
  assert.ok(new URL(signed).pathname.endsWith("/a%20b%20%281%29.tif"), new URL(signed).pathname);
});
