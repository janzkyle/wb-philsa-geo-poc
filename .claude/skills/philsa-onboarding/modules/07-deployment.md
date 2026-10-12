# Module 7 — Deployment

**Goal:** they understand what a deployment of this platform consists of, why
the reference deployment looks the way it does, and leave with a deployment
plan for the platforms PhilSA actually has. **Time:** ~20 min here. Doing the
deployment is its own session.

This module is the **on-ramp**. The full from-scratch procedure lives in the
**`philsa-deploy-bootstrap`** skill, which interviews them about their
platforms and maps each component onto them. Teach the shape here, then hand
off.

## Read first
- `deploy/DEPLOYMENT.md`: "What we deploy, and why these services" and "The
  two database environments"
- `render.yaml`: skim the comments; they explain every non-obvious setting
- `.claude/skills/philsa-deploy-bootstrap/SKILL.md` → "The components"

## Why it's built this way (the intent)
- **$0 and repeatable was the brief.** Neon (Postgres), Render (containers +
  static sites, one `render.yaml` Blueprint), Cloudflare (R2 storage + Workers
  for the gateway and chat), and OpenRouter (LLM). Each was chosen for a
  reason recorded in `deploy/DEPLOYMENT.md`. Neon was chosen over Supabase
  because pgSTAC's migration needs a real IPv4 session. Render was chosen
  because one file deploys four services from their own Dockerfiles.
- **The components are standard; the vendors aren't load-bearing.** Postgres +
  PostGIS + pgSTAC, two containers, two static sites, S3-compatible storage,
  an edge proxy, an LLM endpoint. Any platform that provides those can host
  this. A few places do assume Cloudflare R2 and OpenRouter, and the bootstrap
  skill lists exactly which.
- **Writable never faces the internet.** Prod ingest runs a throwaway local
  API bound to the prod DB (`deploy/scripts/prod-ingest.sh`). Whatever
  platform they pick, this rule carries over.
- **Free tier means cold starts** (Render ~30–60 s, Neon ~1 s). That was
  accepted for a POC, and it's the first thing to change for production use.

## Essentials (in order)
1. **The component list** (the table in the bootstrap skill): what each
   component does and what the reference deployment uses for it.
2. **The two environments:** `local` (Docker) and `prod`, configured in
   `deploy/environments/*.env`. Every deploy script takes the env name as its
   first argument.
3. **The order things must go up in** (storage → DB → API/TiTiler → ingest →
   gateway → frontends → chat → lock origins → auth), and why: frontends bake
   in URLs at build time, and the origin lock must come *after* the gateway
   sends the secret.
4. **Two skills, two jobs:** `philsa-deploy-bootstrap` stands up a new
   environment, possibly on different platforms. `philsa-deploy` operates the
   one that exists (redeploy, ingest, debug).

## Adapt
- **GIS first:** spend the time on what each hosted piece *is*: a container
  service vs. a static site vs. an edge worker vs. a managed database.
- **Software / DevOps first:** skip that. Go straight to the platform-specific
  assumptions (R2 endpoint hardcoding, the Cloudflare-specific gateway APIs)
  and the security posture (read-only origin, the origin-lock shared secret).

## Hands-on
Read-only checks of the live reference deployment:

```bash
curl -s https://philsa-stac-gateway.philsa.workers.dev/ | python3 -c 'import json,sys; print(json.load(sys.stdin)["title"])'
curl -s -o /dev/null -w 'tiles gateway: %{http_code}\n' https://philsa-tiles-gateway.philsa.workers.dev/healthz
curl -s https://philsa-chat.philsa.workers.dev/health    # keyConfigured + the model chain
```

Then **hand off**:
- Their profile (Module 0) already lists the platforms they have, so pass that
  along.
- Ask whether they want to plan the deployment now (invoke
  `philsa-deploy-bootstrap` in planning mode, about 20 minutes, writes a plan,
  touches nothing) or later.
- If now, invoke it and return here afterwards to record progress.

## Checkpoint
They have a deployment plan from `philsa-deploy-bootstrap`, or they've
consciously deferred it. Either way, they can explain why prod ingest runs
through a local ephemeral API.

## Check understanding
- "Why can't the webmap's API URL be changed after deploy without a rebuild?"
  (`VITE_*` vars are baked in at build time.)
- "You set `GATEWAY_SHARED_SECRET` on TiTiler before deploying the gateway
  with the secret. What happens?" (Every tile 403s until the gateway sends the
  header. That's why the order is gateway first.)

## Dive deeper (offer as options)
- **Run the bootstrap skill now** (planning mode).
- **Operating the reference deployment:** the `philsa-deploy` skill's traps
  list.
- **Costs beyond free tier:** what to upgrade first (Render instance size and
  `TITILER_MAX_CONCURRENT_RENDERS`, per the comments in `render.yaml`).
