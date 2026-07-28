#!/usr/bin/env node
// Mint a partner API key for the PhilSA restricted tier.
//
//   node scripts/mint-key.mjs --name "PCIC" [--roles partner] [--expires 2027-01-01]
//   node scripts/mint-key.mjs --name "PCIC" --dry-run     # show, don't write
//   node scripts/mint-key.mjs --list                      # who holds a key
//   node scripts/mint-key.mjs --revoke <sha256-of-key>
//
// The key is printed ONCE and never stored: KV holds only its SHA-256, so a dump
// of the namespace (or of this repo's history) leaks nothing usable. If a partner
// loses their key, mint a new one and revoke the old — it cannot be recovered.
//
// Run from deploy/gateway/. Requires an authenticated wrangler.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const BINDING = "API_KEYS";
const KEY_PREFIX = "key:";

function arg(flag, fallback = null) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : (process.argv[i + 1] ?? true);
}
const has = (flag) => process.argv.includes(flag);

// `wrangler kv key put` needs to know which namespace; --binding resolves it from
// wrangler.toml, but bindings live under an environment, so pass one through.
const ENVIRONMENT = arg("--env", "stac");

function wrangler(args) {
  return execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

const kvArgs = ["--binding", BINDING, "--env", ENVIRONMENT, "--remote"];

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function listKeys() {
  const out = wrangler(["kv", "key", "list", ...kvArgs]);
  const keys = JSON.parse(out).filter((k) => k.name.startsWith(KEY_PREFIX));
  if (!keys.length) return console.log("No API keys issued yet.");
  console.log(`${keys.length} key(s) issued:\n`);
  for (const k of keys) {
    const value = wrangler(["kv", "key", "get", k.name, ...kvArgs]);
    const rec = JSON.parse(value);
    const state = rec.revoked ? "REVOKED" : rec.expires && Date.parse(rec.expires) <= Date.now() ? "EXPIRED" : "active";
    console.log(`  ${k.name.slice(KEY_PREFIX.length)}  ${state.padEnd(8)} ${rec.name}  roles=${(rec.roles ?? []).join(",")}`);
  }
}

function revoke(hash) {
  const kvKey = KEY_PREFIX + hash;
  const existing = JSON.parse(wrangler(["kv", "key", "get", kvKey, ...kvArgs]));
  const updated = { ...existing, revoked: true, revoked_at: new Date().toISOString() };
  wrangler(["kv", "key", "put", kvKey, JSON.stringify(updated), ...kvArgs]);
  console.log(`Revoked key for '${existing.name}' (${hash}).`);
}

function mint() {
  const name = arg("--name");
  if (!name || name === true) {
    console.error("Missing --name (the organisation the key is issued to).");
    process.exit(1);
  }
  const roles = String(arg("--roles", "partner")).split(",").map((r) => r.trim()).filter(Boolean);
  const expires = arg("--expires");

  // 32 random bytes, base64url. The `philsa_` prefix makes a leaked key
  // greppable in logs and recognisable in a support ticket.
  const secret = `philsa_${randomBytes(32).toString("base64url")}`;
  const hash = sha256(secret);
  const record = {
    name,
    roles,
    created: new Date().toISOString(),
    ...(expires && expires !== true ? { expires: String(expires) } : {}),
  };

  if (has("--dry-run")) {
    console.log("DRY RUN — nothing written.\n");
  } else {
    wrangler(["kv", "key", "put", KEY_PREFIX + hash, JSON.stringify(record), ...kvArgs]);
  }

  console.log(`
  Issued to : ${name}
  Roles     : ${roles.join(", ")}
  ${expires && expires !== true ? `Expires   : ${expires}` : "Expires   : never (revoke with --revoke)"}
  Hash      : ${hash}

  API KEY (shown once — copy it now):

      ${secret}

  Give it to the partner over a secure channel. They use it as:

      curl -H "X-API-Key: ${secret}" \\
        https://philsa-stac-gateway.philsa.workers.dev/collections/sentinel1-flood
`);
}

if (has("--list")) listKeys();
else if (has("--revoke")) revoke(String(arg("--revoke")));
else mint();
