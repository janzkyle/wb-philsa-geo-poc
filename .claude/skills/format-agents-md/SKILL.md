---
name: format-agents-md
description: Autoformat AGENTS.md (or another markdown file) with mdformat + the GFM plugin, normalizing markdown style while preserving the file's manual line wrapping. Use when the user asks to format, lint, tidy, clean up, or normalize AGENTS.md or other project markdown.
---

# Format AGENTS.md

Autoformats `AGENTS.md` with [mdformat](https://mdformat.readthedocs.io/) and the
GFM plugin (`mdformat-gfm` — tables, task lists, strikethrough, autolinks).

The bundled script **`format_agents.sh`** does everything: it resolves a runner,
formats the file, and reports whether anything changed.

## How to run

Invoke the script with Bash from the repo root:

```bash
bash .claude/skills/format-agents-md/format_agents.sh            # formats ./AGENTS.md
bash .claude/skills/format-agents-md/format_agents.sh path/to/other.md   # any md file
```

## What it does / does not change

- **Preserves line wrapping** (`--wrap keep`) — the file's manual ~80-column
  wrapping is left intact. Only markdown *style* is normalized: list markers
  (→ `-`), heading style, emphasis markers, code-fence style, and **table column
  padding/alignment** (why the GFM plugin is required — core mdformat would
  otherwise mangle tables).
- **Idempotent** — running it twice produces no further changes.

## Runner resolution (handled automatically)

First available wins, so no global install is forced:

1. **`uvx`** — ephemeral, nothing installed: `uvx --with mdformat-gfm mdformat`.
2. **`mdformat` on PATH** — used directly (assumes the gfm plugin is present).
3. **`pipx`** — installs `mdformat` and injects `mdformat-gfm`.
4. **`pip3 --user`** — last resort.

On this machine `uvx` is present, so the default path installs nothing.

## Instructions for the assistant

- Default target is `AGENTS.md` in the current directory; pass a path only if the
  user names a different file.
- Run from the repo root so the relative `AGENTS.md` resolves; the script errors
  clearly if the file isn't found.
- **Do not point this at the submodules** (`stac-fastapi-pgstac/`,
  `stac-browser/`) — they track upstream and shouldn't be reformatted.
- After running, report whether the file changed (the script prints this) and, if
  it did, optionally show the user the diff with `git diff AGENTS.md`.
