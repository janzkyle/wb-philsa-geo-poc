#!/usr/bin/env bash
# doctor.sh — read-only environment check for the PhilSA POC.
#
#   bash .claude/skills/philsa-onboarding/doctor.sh           # tools + config + local services
#   bash .claude/skills/philsa-onboarding/doctor.sh --quick   # skip the local service probes
#
# Reports tool versions against what the repo needs, whether the submodules are
# checked out, which keys in the repo-root .env are filled in (NEVER their
# values), and which local services answer on their usual ports. Ends with a
# "what you can run right now" summary.
#
# It changes nothing: no installs, no writes, no containers started. Always
# exits 0 — it's a report, not a gate.
set -uo pipefail

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

# Resolve the repo root the same way the pipeline scripts do: walk up until .git
# or AGENTS.md.
dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while [ "$dir" != "/" ] && [ ! -e "$dir/.git" ] && [ ! -e "$dir/AGENTS.md" ]; do
  dir="$(dirname "$dir")"
done
ROOT="$dir"
cd "$ROOT" || exit 0

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; WARNS=$((WARNS + 1)); }
bad()  { printf '  \033[31m✘\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }
note() { printf '  · %s\n' "$*"; }
hdr()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
WARNS=0 FAILS=0

# ver_ge A B — true when dotted version A >= B (compares up to 3 parts).
ver_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN { split(a, x, "."); split(b, y, ".");
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }'
}
have() { command -v "$1" >/dev/null 2>&1; }

# Capability flags for the summary.
CAN_CORE=1 CAN_REF=0 CAN_SILVER=0 CAN_BRONZE=0 CAN_CHAT=0 CAN_TILER=0

printf '\033[1mPhilSA POC doctor\033[0m — %s\n' "$ROOT"

# ----------------------------------------------------------------------------
hdr "Repository"
if [ -e .git ]; then
  ok "git repo ($(git rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git rev-parse --short HEAD 2>/dev/null))"
else
  warn "no .git here — resolved root via AGENTS.md"
fi
while read -r line; do
  [ -z "$line" ] && continue
  flag="${line:0:1}" name="$(echo "${line:1}" | awk '{print $2}')"
  case "$flag" in
    -) bad "submodule $name not checked out — run: git submodule update --init --recursive"; CAN_CORE=0 ;;
    +) warn "submodule $name is at a different commit than the parent records (local edits or a pending bump?)" ;;
    U) bad "submodule $name has merge conflicts" ;;
    *) ok "submodule $name checked out" ;;
  esac
done < <(git submodule status 2>/dev/null)
# Belt and braces for non-git copies (a zip download has no submodule metadata).
for f in stac-fastapi-pgstac/compose.yml stac-browser/package.json; do
  [ -e "$f" ] || { bad "$f missing — the submodules aren't populated"; CAN_CORE=0; }
done

# ----------------------------------------------------------------------------
hdr "Core tools (catalog API, STAC Browser, webmap)"
if have git; then ok "git $(git --version | awk '{print $3}')"; else bad "git missing"; CAN_CORE=0; fi
if have curl; then ok "curl"; else bad "curl missing"; CAN_CORE=0; fi

if have python3; then
  pv="$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')"
  if ver_ge "$pv" 3.10; then ok "python3 $pv"; else warn "python3 $pv — Dagster needs ≥ 3.10"; fi
else
  bad "python3 missing"; CAN_CORE=0
fi

if have docker; then
  if docker info >/dev/null 2>&1; then
    ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) (daemon running)"
  else
    bad "docker installed but the daemon isn't running — start Docker Desktop / OrbStack / colima"; CAN_CORE=0
  fi
  if docker compose version >/dev/null 2>&1; then ok "docker compose v2"; else bad "docker compose v2 missing"; CAN_CORE=0; fi
else
  bad "docker missing — needed for the local pgSTAC + API"; CAN_CORE=0
fi

if have node; then
  nv="$(node -v | tr -d v)"
  # Vite 8 (webmap) needs Node 20.19+ or 22.12+.
  if { ver_ge "$nv" 22.12; } || { ver_ge "$nv" 20.19 && ! ver_ge "$nv" 21.0; }; then
    ok "node $nv"
  else
    bad "node $nv — the webmap's Vite needs 20.19+ or 22.12+"
  fi
  have npm && ok "npm $(npm -v)" || bad "npm missing"
else
  bad "node missing — needed for STAC Browser and the webmap"
fi

# ----------------------------------------------------------------------------
hdr "Pipeline tools"
if have gdalinfo; then
  gv="$(gdalinfo --version | sed -E 's/^GDAL ([0-9.]+).*/\1/')"
  if ver_ge "$gv" 3.11; then
    ok "GDAL $gv (≥ 3.11: loaders + Sentinel silver builders)"; CAN_REF=1; CAN_SILVER=1
  elif ver_ge "$gv" 3.8; then
    warn "GDAL $gv — fine for the loaders (≥ 3.8); the Sentinel silver builders need ≥ 3.11"; CAN_REF=1
  else
    bad "GDAL $gv — the loaders need ≥ 3.8"
  fi
  fmts="$(ogrinfo --formats 2>/dev/null)"
  for d in Parquet OpenFileGDB; do
    if grep -q "$d" <<<"$fmts"; then ok "GDAL driver: $d"; else warn "GDAL driver $d missing (admin-boundary build needs it)"; fi
  done
else
  warn "GDAL missing — needed for the ESRI loader, admin boundaries, and all silver builders"
fi
have uv && ok "uv $(uv --version | awk '{print $2}') (recommended; Dagster + pypgstac use it)" \
         || note "uv not installed (optional, recommended — https://docs.astral.sh/uv/)"
have aws && ok "aws CLI (mosaics, PMTiles, R2 CORS)" \
         || note "aws CLI not installed (optional: build_raster_mosaics.sh, build_ph_admin_pmtiles.sh, deploy/r2/apply-cors.sh)"
have tippecanoe && ok "tippecanoe (admin PMTiles)" \
                || note "tippecanoe not installed (optional: build_ph_admin_pmtiles.sh only)"
have wrangler && ok "wrangler $(wrangler --version 2>/dev/null | head -1)" \
              || note "wrangler not installed globally (optional, deploy only — 'npx wrangler' works too)"

# ----------------------------------------------------------------------------
hdr "Config (.env values are never printed)"
# is_set FILE KEY — true when KEY has a non-empty, non-placeholder value.
is_set() {
  local v
  v="$(grep -E "^[[:space:]]*$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']$//")"
  [ -n "$v" ] && [[ "$v" != your-* ]] && [[ "$v" != *xxxxxxxx* ]] && [[ "$v" != \<* ]]
}
check_group() {  # check_group LABEL FLAGVAR KEY...
  local label="$1" flag="$2"; shift 2
  local missing=()
  for k in "$@"; do is_set .env "$k" || missing+=("$k"); done
  if [ ${#missing[@]} -eq 0 ]; then ok "$label: all set"; eval "$flag=1"
  else warn "$label: not set — ${missing[*]}"; fi
}
R2_OK=0 COP_OK=0 OR_OK=0
if [ -f .env ]; then
  ok ".env present (repo root)"
  check_group "R2 storage (silver builds, local TiTiler, catalog_silver)" R2_OK \
    R2_BUCKET R2_ACCOUNT_ID AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY R2_PUBLIC_BASE
  check_group "CopPhil (bronze downloads)" COP_OK COPPHIL_USERNAME COPPHIL_PASSWORD
  check_group "OpenRouter (map assistant chat)" OR_OK OPENROUTER_API_KEY
else
  warn ".env missing — cp .env.example .env (fill only what you have; the catalog + Browser need none of it)"
fi
[ -f deploy/environments/local.env ] && ok "deploy/environments/local.env present" \
  || warn "deploy/environments/local.env missing — cp deploy/environments/local.env.example deploy/environments/local.env"
[ -f deploy/environments/prod.env ] && note "deploy/environments/prod.env present (prod DB creds — handle with care)"
[ -f webmap/.env ] && note "webmap/.env present (Vite build-time URLs, not secrets)" \
  || note "webmap/.env absent — the webmap defaults to the local services"

[ "$R2_OK" = 1 ] || CAN_SILVER=0
[ "$R2_OK" = 1 ] && CAN_TILER=1
[ "$COP_OK" = 1 ] && CAN_BRONZE=1
[ "$OR_OK" = 1 ] && CAN_CHAT=1

# ----------------------------------------------------------------------------
if [ "$QUICK" = 0 ]; then
  hdr "Local services"
  port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
  probe() {  # probe LABEL URL HOW-TO-START
    if curl -fsS -m 4 -o /dev/null "$2" 2>/dev/null; then ok "$1 — $2"; else note "$1 not answering — $3"; fi
  }
  if port_open 5439; then ok "Postgres/pgSTAC on :5439"; else note "Postgres not on :5439 — cd stac-fastapi-pgstac && ENABLE_TRANSACTIONS_EXTENSIONS=true docker compose up -d"; fi
  if body="$(curl -fsS -m 4 'http://localhost:8082/collections?limit=500' 2>/dev/null)"; then
    n="$(python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("collections", [])))' <<<"$body" 2>/dev/null || echo '?')"
    ok "STAC API on :8082 — $n collections"
    if curl -fsS -m 4 http://localhost:8082/conformance 2>/dev/null | grep -qi transaction; then
      ok "  transactions ON (loaders can write)"
    else
      warn "  transactions OFF — loaders will 405; restart with ENABLE_TRANSACTIONS_EXTENSIONS=true"
    fi
  else
    note "STAC API not on :8082 — cd stac-fastapi-pgstac && ENABLE_TRANSACTIONS_EXTENSIONS=true docker compose up -d"
  fi
  probe "TiTiler :8083"      http://localhost:8083/healthz "docker compose --env-file .env -f compose.viz.yml up -d (needs R2 creds)"
  probe "STAC Browser :8080" http://localhost:8080/        "cd stac-browser && npm install && npm start"
  probe "webmap :5173"       http://localhost:5173/        "cd webmap && npm install && npm run dev"
  probe "chat backend :8087" http://localhost:8087/health  "cd webmap && npm run chat (needs OPENROUTER_API_KEY)"
  port_open 3000 && note "something on :3000 (dagster dev?)"
  port_open 3030 && note "something on :3030 (Dagster compose UI?)"
fi

# ----------------------------------------------------------------------------
hdr "What you can run right now"
yn() { [ "$1" = 1 ] && printf '\033[32myes\033[0m' || printf '\033[33mnot yet\033[0m'; }
printf '  %-58s %b\n' "Local catalog + STAC Browser + PhilSA mirror"            "$(yn $CAN_CORE)"
printf '  %-58s %b\n' "Reference loaders (ESRI LULC), admin boundaries"         "$(yn $((CAN_CORE & CAN_REF)))"
printf '  %-58s %b\n' "Local TiTiler (rasters on the local webmap)"             "$(yn $((CAN_CORE & CAN_TILER)))"
printf '  %-58s %b\n' "Sentinel silver builds + catalog_silver (GDAL 3.11 + R2)" "$(yn $((CAN_CORE & CAN_SILVER)))"
printf '  %-58s %b\n' "Bronze downloads from CopPhil"                            "$(yn $CAN_BRONZE)"
printf '  %-58s %b\n' "Map assistant chat"                                       "$(yn $CAN_CHAT)"
printf '\n  %d problem(s), %d warning(s). Webmap without R2 creds: point webmap/.env at the\n' "$FAILS" "$WARNS"
printf '  read-only prod gateway (VITE_STAC_API / VITE_TITILER) — see the onboarding Module 5.\n'
exit 0
