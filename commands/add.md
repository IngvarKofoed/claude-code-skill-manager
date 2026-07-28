---
description: Register a new skill repo and install it immediately.
---

Add a skill repo to the registry and install it in one step.

The user's request is in `$ARGUMENTS`. Extract the git clone URL from it (HTTPS or SSH both work).

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" add <repo-url>
   ```

   Add flags only when the user's request actually calls for them:

   - `--ref <branch|tag|sha>` — pin to something other than `main`.
   - `--subdir <path>` — the skill lives in a subdirectory of a monorepo, not at the repo root.
   - `--dir <name>` — install under a folder name different from the repo name. **Required** when
     the repo name doesn't match the skill's `name:` field, because Claude Code discovers skills by
     folder name.
   - `--mode clone|copy` — rarely needed; whole-repo defaults to `clone`, `--subdir` to `copy`.
   - `--no-sync` — register without installing.

2. The engine validates the entry **before** writing anything, so an illegal folder name, a
   `clone`+`subdir` combination, or a collision with an existing entry is rejected with the
   registry untouched. If that happens, relay the error and suggest the fix (usually `--dir`).

3. On success it prints `[ok] added <name> ...` and then syncs that one entry. Report both the
   registration and the install result.

4. Tell the user the new skill becomes available **after a restart or `/reload-skills`** — Claude
   Code discovers skills at session start, so a skill installed mid-session isn't loaded yet.

If several repos were named, add them one at a time so a failure on one doesn't obscure the others.
