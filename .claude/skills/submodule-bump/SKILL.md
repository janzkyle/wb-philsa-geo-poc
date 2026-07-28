---
name: submodule-bump
description: Land a change in the stac-fastapi-pgstac or stac-browser git submodule the two-commit way — commit and push inside the submodule to our fork, then record the new gitlink in the parent repo. Use when editing, committing, pushing, or updating either submodule, when pulling in upstream changes to one, or when a submodule edit isn't showing up for collaborators.
---

# Bumping a submodule

Both submodules point at **our forks** (`origin`), with the real upstream kept as
the `upstream` remote. That's what lets POC edits be shared — a plain clone of an
upstream-pointed submodule can't carry local commits, but a fork can.

**Landing a change takes two commits.** Push inside the submodule (publishes the
code), *then* commit the new gitlink in the parent repo (records *which* commit
collaborators check out). Skip the second and your edit is invisible to everyone
else. The bundled script does both.

## How to run

From the repo root:

```bash
S=.claude/skills/submodule-bump/bump_submodule.sh
bash "$S" stac-browser -m "fix catalog title"   # commit + push + record gitlink
bash "$S" stac-fastapi-pgstac                   # already committed inside — push + record
DRY_RUN=1 bash "$S" stac-browser -m "..."       # show what would run
```

`-m` is required only when the submodule worktree is dirty. The script validates
the name against `.gitmodules`, pushes to `origin` (never `upstream`), and skips
the parent commit if the gitlink is already current. It deliberately **does not
push the parent repo** — review, then `git push` yourself.

Pulling upstream's updates into a submodule is still manual:

```bash
git -C stac-browser fetch upstream && git -C stac-browser merge upstream/main
bash "$S" stac-browser        # then push to our fork + record the gitlink
```

## Instructions for the assistant

- **Keep submodule edits minimal and POC-specific.** They track upstream — never
  reformat or mass-edit them, and prefer env/config over code changes. POC logic
  belongs in `pipelines/` and `webmap/`, not in a submodule.
- **Don't point `format-agents-md` or any repo-wide formatter at a submodule.**
- Confirm with the user before pushing — this publishes to a shared fork.
- If a collaborator reports "your submodule change isn't there", the diagnosis is
  almost always the missing parent gitlink commit: check `git status` in the parent
  for a modified submodule entry, then run this script.
- Fresh clones need `git clone --recurse-submodules`, or
  `git submodule update --init --recursive` after the fact. Both forks are public
  and cloned over HTTPS — no SSH key or auth needed.
