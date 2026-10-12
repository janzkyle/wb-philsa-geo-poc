# Module 8 — Handover: open decisions & where to start

**Goal:** they know which questions are still open (and which ones only PhilSA
can answer), what's half-built, and they leave with a first concrete task.
**Time:** ~20 min.

## Read first
- `TODO.md`: the header (the audit date and legend) and every `[ ]` / `[~]`
  item. Read it live, because it changes.
- `README.md` → "Status & what's next"
- `poc-architecture.mmd`: every 🟡 and ⏳ badge
- `.onboarding/progress.md`: their focus and any open questions parked
  earlier

## Why it matters (the intent)
A POC is a set of answered questions plus a set of deliberately deferred ones.
The deferred ones weren't forgotten; they were left for the people who will
own the system, because they depend on PhilSA policy, accounts, or
partnerships. Make that distinction explicit, so they don't mistake a
decision for an oversight.

## Essentials (in order)

1. **Decisions only PhilSA can make.** Present these as decisions, not tasks:
   - **Which collections are restricted.** The tier machinery is built and
     proven, and nothing is restricted today (`TODO.md` → Auth & governance).
   - **Identity provider:** create the Auth0 tenant, or point the gateway at
     CopPhil's or PhilSA's **Keycloak**. The code is plain OIDC (`deploy/AUTH.md`
     → "Why Auth0").
   - **Where it runs long-term:** stay on the free stack, move to Azure or
     on-prem, or mix them (Module 7 / `philsa-deploy-bootstrap`).
   - **Custom domains** (`stac.philsa.gov.ph`): only the hosts change, and
     every consumer recipe stays the same.
   - **Which agency onboards first.** The `partner-template/` fork with a
     crop insurer (PCIC) is queued.
2. **Security items to close before any external exposure:**
   - the STAC API origin still serves restricted *metadata* directly (the
     "last bypass")
   - chat server hardening (auth or a shared secret, plus a rate limit)
   - the gateway rate-limit binding
3. **Half-built (🟡) work, by track.** Summarize only their focus track and
   name the rest:
   - **Ingest:** EMS/GFM authoritative flood, Sentinel-3, Copernicus DEM, OSM,
     Earth Search.
   - **Silver quality:** cloud masking for NDVI, the DEM slope mask, flood and
     ratio backfill.
   - **Webmap** (the PCIC priority queue): admin-zone stats, the index-history
     chart, compare mode, the trigger console, permalinks.
   - **Geospatial AI** (exploratory): foundation-model flood, TerraMind,
     Clay embeddings.
4. **How to keep it honest as they go:** tick `TODO.md`, update the README's
   status list, and re-badge the diagram (Module 6, rule 10).

## Picking a first task
Match their focus and size it to a day or two:

| Focus | Good first task | Why it's a good first task |
|---|---|---|
| Any | Fix a doc drift they noticed during onboarding | Touches the "keep it honest" rule; low risk |
| Pipelines | The Earth Search loader (`reference/`) | Exercises catalog-by-reference, upserts, and validation end to end |
| Pipelines | Smoke-test the prod ingest path (`TODO.md`) | Exercises `prod-ingest.sh`, and inspecting the result teaches gold |
| Webmap | Shared tool schemas between `chatCore.mjs` and `executeTool.ts` | Small and self-contained; teaches the chat loop |
| Ops | Enable the gateway rate-limit binding | One config block plus a deploy; teaches wrangler environments |

Confirm the choice with them, then write it into `.onboarding/progress.md` as
"First task". If they want to start right away, leave the onboarding frame
and work the task normally.

## Hands-on
Go through the live `TODO.md` together, filtered to their focus track. For
each open item, ask: *is this a PhilSA decision, a known task, or
exploratory?*

## Checkpoint
They can name two decisions only PhilSA can make, and they have a first task
recorded.

## Wrap-up (end of the core path)
- Mark the core path complete in the progress file.
- Offer any electives they haven't taken (E1 Dagster, E2 Auth).
- Remind them this skill stays useful. They can ask it to re-teach any module
  or answer "how does X work" later. The task skills (`philsa-deploy`,
  `collection-tier`, `submodule-bump`, …) take over for real operations.
- Ask for one piece of feedback on the onboarding itself (what was missing,
  what was too much) and note it in the progress file for whoever maintains
  this skill.

## Dive deeper (offer as options)
- **The PCIC process mapping:** `PCIC_WEBMAP_USE_CASES.md`, covering which
  queued webmap feature relieves which bottleneck.
- **The rollout plan for agencies:** `PHILSA_INTEROP_API.md` → rollout phases.
- **Geospatial AI ideas:** `TODO.md` → "Geospatial AI".
