---
description: Scan the skills directory for unregistered folders that could be tracked.
---

Find skills the user already has installed by hand that could be brought under management. Mostly a
one-time command, run after installing the plugin — or occasionally after cloning a skill manually.

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" discover
   ```

   It is **read-only and offline** — it reads each folder's `origin` and branch from disk, and writes
   nothing. Nothing is adopted on the user's behalf.

2. Present the `[candidate]` lines as a table: folder name, repo URL, and any flags the entry needs.
   Then list the `[skip]` lines separately with their reason, so the user can see *why* something
   wasn't offered rather than wondering if it was missed.

3. **Ask which to add**, then run `/skill-manager:add` for each chosen one, using the exact flags
   `discover` printed. Add them one at a time so a failure on one doesn't obscure the others. Never
   add them all without asking.

## Reading the flags it suggests

- **`--dir <name>`** — the repo name differs from the folder name. **Required**, not cosmetic: Claude
  Code discovers skills by folder name, so without it the add would install a *second* copy under the
  repo's name instead of adopting the folder that's already there.
- **`--ref <branch>`** — the checkout is on a branch other than `main`, so the default would be wrong.

## What it cannot detect

- **Monorepo-subdir skills.** A `copy`-mode skill has no `.git`, so it looks identical to a
  local-only folder and shows up as `not a git checkout`. If the user knows a folder came from a
  subdirectory of a larger repo, that entry needs `--subdir <path>` added by hand.
- **Whether the remote still exists.** The URL is read from local config; `add` is what actually
  contacts it and will fail clearly if it's gone.

`[no SKILL.md]` on a candidate means the folder may not be a skill at all — scratch output or a
workspace directory. Worth pointing out rather than tracking blindly.
