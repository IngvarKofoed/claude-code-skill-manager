---
description: Clone any missing registered skills and update all of them to their pinned ref.
---

Sync the user's registered skills now, without waiting for the automatic session-end check.

1. Run the engine:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" sync
   ```

   If the user asked about one skill in particular, add `--only <name>`. If they want to preview
   without changing anything, add `--dry-run`. Pass `-v` only if they ask for git detail.

2. **Surface the output verbatim** (or a faithful summary). The engine prints prefixed lines:
   `[sync] cloning X`, `[ok] foo @ main` (with ` (new)` on a first install), `[skip] ...`,
   `[error] ...`, `[warn] N entries failed`.

3. A `[skip]` is **not a failure** — it means the folder has uncommitted edits or local commits
   that diverged from the pinned ref, and sync deliberately left the user's work alone. Say so,
   and mention that committing/pushing resolves it, or `--force` discards it.

   Only use `--force` if the user explicitly says they want their local changes thrown away. It
   hard-resets the checkout to the pinned ref.

4. On a nonzero exit, report **exactly which entries failed and why** — the engine continues past
   a failing entry, so read its output and name each one.

If the registry doesn't exist yet, the engine says so and points at `/skill-manager:add`. Relay
that rather than treating it as an error.
