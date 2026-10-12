# Module 6 — Working in this repo: conventions & guardrails

**Goal:** they can make a change without breaking an invariant they didn't
know existed: a new script, a catalog write, a submodule edit, or a doc
update. **Time:** ~25 min.

## Read first
- `AGENTS.md`, all of it. It *is* the rulebook. (`CLAUDE.md` is a symlink to
  it.)
- `pipelines/README.md` → "Conventions", "Python or shell?"
- `README.md` → "Working with the submodules"
- `pipelines/lib/` (`r2.py`, `stac_write.py`, `load_env.sh`): skim the
  docstrings

## Why it's built this way (the intent)
Every rule here exists because breaking it once cost a full run, a confused
collaborator, or a security hole. Teach each rule **with its reason**; a rule
without its reason gets "simplified" away by the next person.

## Essentials (in order). Group them; don't read the list out.

1. **Scripts are standalone. That's the contract.**
   - Every pipeline runs from a terminal, from any working directory (paths
     resolve to the repo root).
   - Dagster wraps scripts by shelling out and never imports them.
   - Never reshape a script to suit an orchestrator. Add a parameter instead.
2. **A script's header is its doc.** Use the Python docstring plus `--help`,
   or the shell comment block. There are **no per-script READMEs**, because
   they drift; `pipelines/README.md` is the index.
3. **Reuse `pipelines/lib/`.** `r2.py` (SigV4 client + `load_env_file`),
   `stac_write.py` (`ensure_writable`), `load_env.sh`. All stdlib, imported
   via `sys.path`.
4. **Writing to STAC: the four traps.**
   - Call `ensure_writable()` first. Prod is read-only, so writing to it gives
     a wall of 405s.
   - `datetime` must be non-null. Use a midpoint, and keep the real span in
     `start_`/`end_datetime`.
   - Collections need `item_assets` (the render extension requires it), plus
     `providers` and `summaries`.
   - Don't ship `gdalinfo`'s guessed `eo:bands`. Curate them.

   **Validate before committing:**
   `stac-browser/node_modules/.bin/stac-node-validator <file-or-url>`.
5. **Ingest is idempotent and forgiving.**
   - Upserts: POST, then PUT on 409.
   - Read geo-metadata from the asset with `gdalinfo`; don't hard-code it.
   - Skip-and-log missing or out-of-PH items, and already-present ones.
   - Tag sensitivity (open/restricted) as you add a collection.
6. **Secrets.**
   - Everything goes in the repo-root `.env` (gitignored), loaded only from
     there.
   - Never print or commit secrets.
   - Extend `.gitignore` when you add a generated artifact.
7. **R2 layout mirrors the tiers.** Prefixes are `<tier>/<dataset>/`,
   hardcoded per script and never env-configurable.
8. **Render params live in five places** (Module 4). Change all five or none.
9. **Submodules take two commits.**
   - `stac-fastapi-pgstac` and `stac-browser` point at **our forks**.
   - Commit and push inside the submodule, *then* commit the new gitlink in
     the parent repo. The `submodule-bump` skill scripts both steps.
   - Keep submodule edits minimal; they track upstream.
10. **Keep the status honest.** When you land work:
    - tick it in `TODO.md`
    - update `README.md` → "Status & what's next"
    - re-badge the box in `poc-architecture.mmd`
11. **Don't move or rename `AGENTS.md`.** Scripts find the repo root by
    walking up to `.git` *or* `AGENTS.md`.
12. **Skills** live in `.claude/skills/`, the single list for every agent.
    Codex reads it through the `.agents/skills` symlink, so never copy a skill
    into `.agents/`. A skill earns its place only by
    consolidating traps spread across several docs, or by shipping a script.
    A skill that just points at one doc doesn't qualify.

## Adapt
- **GIS first:** focus on rules 1, 4, 5, and 9; these are the ones a
  script-writer trips on. Explain idempotency as "safe to run twice", and 409
  as the server saying "already exists".
- **Software first:** focus on rules 4, 5, and 8 (the STAC- and EO-specific
  ones) and rule 10. The generic hygiene (secrets, standalone scripts) they'll
  absorb from code review.

## Hands-on

```bash
# 1. validate a live collection and a local file
stac-browser/node_modules/.bin/stac-node-validator https://philsa-stac-gateway.philsa.workers.dev/collections/sentinel2-ndvi
curl -s localhost:8082/collections/sentinel-2-l2a > /tmp/c.json && stac-browser/node_modules/.bin/stac-node-validator /tmp/c.json

# 2. break it on purpose and watch the validator catch it
python3 -c 'import json; c=json.load(open("/tmp/c.json")); c.pop("extent"); json.dump(c, open("/tmp/bad.json","w"))'
stac-browser/node_modules/.bin/stac-node-validator /tmp/bad.json

# 3. see why prod is read-only, the way ensure_writable() sees it
G=https://philsa-stac-gateway.philsa.workers.dev
curl -s "$G/conformance" | grep -ci transaction            # 0 → no Transaction extension advertised
curl -s localhost:8082/conformance | grep -ci transaction  # >0 locally (transactions ON)
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' "$G/collections"   # 405, refused at the edge
```

Then watch the loaders' own guard make the same check and refuse:

```bash
python3 -c 'import sys; sys.path.insert(0,"pipelines/lib"); from stac_write import ensure_writable; ensure_writable("https://philsa-stac-gateway.philsa.workers.dev")'
```

Read `ensure_writable()` in `pipelines/lib/stac_write.py` together. Point out
that it **fails open, with a warning,** on network errors, so that the writer's
own first request reports the real error. Also point out why it sends its own
User-Agent: Cloudflare 403s Python's default one, which once made this guard
pass silently against prod.

**Code-reading exercise:** open `load_esri_lulc.sh` and find, in order:
- where it resolves the repo root
- where it reads geo-metadata from the asset
- where it upserts (POST → PUT on 409)
- where it skips tiles outside PH

That's four conventions in one file.

## Checkpoint
The validator passed the real collection and failed the broken one. They saw
prod refuse a write (405), and `ensure_writable` refuse prod before any write. They found all four conventions in the ESRI
loader.

## Check understanding
- "You wrote a new loader and it works under Dagster but not from the
  terminal. What's wrong?" (It broke the standalone contract. Make it work
  standalone, then let Dagster call it.)
- "You edited `stac-browser/config.js`, committed, and pushed the parent repo.
  A teammate pulls and sees nothing. Why?" (The submodule commit wasn't pushed
  to the fork, or the gitlink wasn't recorded. Use `submodule-bump`.)

## Dive deeper (offer as options)
- **The submodule workflow, hands-on:** walk through the `submodule-bump`
  skill with `DRY_RUN=1`.
- **Writing a new pipeline script:** design one together against these rules.
  Good candidate: the Earth Search loader in `TODO.md`.
- **The repo's skills:** what each one in `.claude/skills/` automates, and when
  to reach for it.
