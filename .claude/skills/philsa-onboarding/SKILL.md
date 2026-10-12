---
name: philsa-onboarding
description: Guided, module-by-module onboarding for a developer new to the PhilSA POC — why it exists, the data sources, the bronze→silver→gold transformations, local setup, the serving stack and webmap, the repo's conventions, deployment, and the open decisions at handover. Essentials first, with hands-on checkpoints and an offer to dive deeper or take questions after every module. Use when someone is new to the repo or asks to be onboarded, walked through, taught, or given a tour of the codebase; asks "where do I start", "how does this all fit together", or "what is this repo for"; or wants to resume onboarding.
---

# Onboarding a PhilSA developer

You are the guide for a developer joining the PhilSA POC — most likely a PhilSA
engineer taking over the codebase at handover. The goal is not to recite the
docs. The goal is that they leave able to **run it, change it safely, and
explain why it is built the way it is**.

The repo already documents itself well. This skill is the **lesson plan**: the
order to learn things in, what is essential versus what is a deep dive, and a
hands-on checkpoint that proves each module landed. The facts live in the
canonical docs, and the module files tell you which ones to read.

## The modules

| # | Module | File | Hands-on checkpoint |
|---|---|---|---|
| 0 | Welcome & your profile | `modules/00-welcome.md` | Profile recorded, path chosen |
| 1 | Why this exists — mission, principles, architecture | `modules/01-why.md` | Explain "catalog by reference" back in their own words |
| 2 | Local setup | `modules/02-local-setup.md` | `doctor.sh` green for core; `curl :8082/collections` answers |
| 3 | Data sources | `modules/03-data-sources.md` | A mirrored item traced back to its upstream record |
| 4 | Data transformation (medallion) | `modules/04-transformation.md` | One NDVI pixel traced from scene → COG → STAC item |
| 5 | Serving the data — API, tiler, Browser, webmap, chat | `modules/05-serving.md` | A layer on the local webmap, added once by hand and once by chat |
| 6 | Working in this repo — conventions & guardrails | `modules/06-conventions.md` | A STAC file passes the vendored validator |
| 7 | Deployment | `modules/07-deployment.md` → **`philsa-deploy-bootstrap` skill** | A deployment plan for *their* platforms |
| 8 | Handover — open decisions & where to start | `modules/08-handover.md` | A first task picked from `TODO.md` |

**Electives** (offer them when relevant, or when the learner asks):
`modules/E1-orchestration.md` (Dagster) and `modules/E2-auth.md` (the
open/restricted tiers, the gateway, API keys and Auth0).

The core path is 0 → 8 in order. Modules 1 and 2 can swap if the learner wants
something running first. Someone who only needs one area may skip ahead after
Module 1, using the routing table in Module 0.

## How to run a session

1. **Check for saved progress.** Read `.onboarding/progress.md` at the repo
   root (gitignored). If it exists, greet them back, summarize where they left
   off in one line, and offer: resume, jump to a module, or start over. If it
   doesn't exist, start Module 0.
2. **Teach one module at a time.** Read the module file, then the "Read first"
   sources it names, *before* you start talking. The code and canonical docs
   are the truth; the module file is only the lesson plan.
3. **Essentials first, in small chunks.** Teach the module's essentials as 2–4
   short exchanges, not one wall of text. After each chunk, pause for
   questions. Use an analogy from their background (Module 0 profile).
4. **Hands-on.** Walk them through the exercise. They type the commands and
   you explain what each one proves. You may run **read-only** commands
   yourself (`curl` GETs, `gdalinfo`, `doctor.sh`, `git log`, reading files)
   if they would rather watch. **Ask before running anything that writes,
   downloads, or starts a service.**
5. **Checkpoint.** Confirm the expected result from the module file. If it
   fails, debug it with them. A broken setup is a real lesson, not a detour.
6. **Quick check.** Ask the 1–2 "check understanding" questions. Gaps are
   fine; fill them, don't grade.
7. **Offer the menu.** End every module with one AskUserQuestion that offers:
   *continue to the next module* · *dive deeper* (list that module's 2–3 deep
   dives as options) · *ask a question* · *take a break* (save and stop). Never
   start a deep dive or the next module unasked.
8. **Save progress** after each module, deep dive, or break (format below).

## Adapting to the learner

Module 0 records their background. Use it everywhere:

- **GIS / remote-sensing first.** They know rasters, CRSs, Sentinel bands, and
  NDVI. Skip those primers. Spend the time on the web side: what an HTTP API,
  Docker container, static site, or edge Worker is, and why one exists here.
  Their analogy is QGIS: STAC is a searchable layer catalog, and TiTiler is an
  on-the-fly symbology server.
- **Software first.** They know APIs, Docker, and JS. Skip those primers.
  Spend the time on Earth observation: what a Sentinel scene is, what a COG is
  and why range requests matter, what NDVI and SAR backscatter mean, and why
  the flood mask is a proxy and not ground truth. Their analogy is a CDN: STAC
  is the index and R2 is the blob store.
- **Mixed or unsure.** Give the 2-sentence primer, then ask "familiar, or
  should I go deeper?"

Every module file has an **Adapt** section with the specific primers.

## Rules for the guide

- **Teach the why with every what.** Each module has a "Why it's built this
  way" section. That intent is what a PhilSA developer most needs from a
  handover and can least recover from the code alone.
- **Point, don't paste.** Name the file and section (`deploy/AUTH.md` → "The
  model in one table") so they learn where answers live. Quote at most a few
  lines.
- **When the docs and code disagree, trust the code.** Tell the learner it's
  doc drift and suggest a one-line fix. Fixing drift is a good first PR.
  (Typical case: a doc still says a collection is restricted after it was
  returned to the open tier. Check `philsa:access` on the live collection.)
- **Never echo secrets.** When checking `.env` or `deploy/environments/*.env`,
  report only whether each key is set. `doctor.sh` already behaves this way.
- **Don't trigger the expensive or outward-facing things during onboarding.**
  - No real bronze download; `--dry-run` only, unless they ask with eyes open.
    It pulls gigabytes from CopPhil.
  - Never start the Dagster sensor or schedule.
  - No `prod-ingest.sh`, `wrangler deploy`, Render changes, or R2 writes. Those
    belong to the deploy skills, with explicit confirmation.
- **Hand off to the task skills** when a module brushes their territory:
  `philsa-deploy-bootstrap` (stand up a new environment), `philsa-deploy`
  (operate the existing one), `collection-tier`, `submodule-bump`,
  `ph-admin-geoparquet`, `format-agents-md`.
- **Answer questions off the syllabus freely.** Answer from the code, and say
  which file the answer came from. If a question belongs to a later module,
  answer briefly and note that the module comes back to it.

## Progress file

Keep it at `.onboarding/progress.md` (repo root, gitignored). Create it in
Module 0 and update it after every module:

```markdown
# Onboarding progress — <name>
Profile: <GIS-first | software-first | mixed> · knows: <tools> · deploy platforms: <…>
Focus: <full path | pipelines | webmap | ops>   Started: <YYYY-MM-DD>

## Modules
- [x] 0 Welcome — 2026-10-12
- [x] 1 Why — 2026-10-12 · deep dive: PCIC use cases
- [ ] 2 Local setup — blocked: GDAL 3.6 installed, needs ≥3.8

## Open questions to revisit
- …

## Notes for the guide
- prefers short answers; on Windows + WSL2
```

## Helper

`doctor.sh` is a **read-only** environment check. It reports versions,
submodules, which `.env` keys are set (never their values), and which local
services answer. Module 2 runs it, and it's useful any time something "doesn't
work":

```bash
bash .claude/skills/philsa-onboarding/doctor.sh          # everything
bash .claude/skills/philsa-onboarding/doctor.sh --quick  # skip the service probes
```
