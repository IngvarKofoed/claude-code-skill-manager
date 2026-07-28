---
description: List every registered skill with its repo, ref, subdir, mode, and installed state.
---

Show the user what is in their registry.

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" list
   ```

   Add `--only <name>` if they asked about a single skill.

2. Present the result as a readable table rather than raw log lines — one row per entry with its
   target folder, installed yes/no, mode, ref, subdir, and repo URL.

3. If the registry is empty the engine says so; tell them to add one with `/skill-manager:add
   <repo-url>`.

Useful context if they ask: `mode=clone` means the folder is a real editable git checkout they can
commit and push from; `mode=copy` means it is a clean `.git`-free copy of a subdirectory of a
monorepo, because a subdirectory cannot be a standalone pushable repo.
