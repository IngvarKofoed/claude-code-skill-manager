---
description: Unregister a skill, optionally deleting its folder.
---

Remove a skill from the registry.

The skill name the user wants removed is in `$ARGUMENTS` — it is the **target folder name**, which
is what `/skill-manager:list` shows in the first column.

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" remove <name>
   ```

2. By default this only drops the registry entry and **leaves the folder on disk**, where it
   becomes untracked (it will start showing up as `[drift]` in `/skill-manager:status`). Say so, so
   the user isn't surprised that the skill still loads.

3. Add `--purge` **only if the user clearly wants the folder deleted too.** The engine refuses to
   purge a clone with uncommitted changes or commits absent from every remote — and also refuses
   when it cannot reach the remote to check, since it then can't prove the work is safe. If it
   refuses:

   - Relay exactly which condition tripped, including "couldn't reach the remote" as its own case —
     that one usually means offline or an expired credential, not that work is actually at risk.
   - Offer to commit/push the work first (`/git` handles that).
   - Only pass `--force` if the user explicitly confirms they want the work destroyed. Don't
     suggest `--force` as the first option.

4. Report what happened: whether the entry was removed, and whether the folder was deleted or
   left in place.

If the name doesn't match any entry, the engine says so and suggests a near-match. Relay that
rather than guessing at a different name.
