---
description: Show registered/installed counts, auto-update state, and last check age.
---

Report the state of the user's managed skills.

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" status
   ```

   Add `--drift` **only if** the user asked which folders are unregistered. By default the count is
   summarized on one line, because most unregistered folders are local-only skills that will never
   be registered and listing them buries the rest of the output.

2. Relay what it prints: the skills directory and registry paths, how many entries are registered
   versus installed, whether auto-update is on (with its mode and interval), how long ago the
   automatic check last ran, one `[skill]` line per tracked skill (short SHA plus when it last
   changed), and the unregistered-folder count if there is one.

   Present the `[skill]` lines as a table — name, SHA, last update — rather than as raw log lines.

3. Explain the three things users usually ask about:

   - **`no update recorded`** — that skill has not moved since it was registered. Normal, and the
     expected state right after adopting folders that were already at their latest commit. It does
     **not** mean the check is broken; `last auto check` is the line that says whether checking
     works. The SHA next to it is read live from the checkout, so it is accurate regardless.
   - **`(moved since)`** — the checkout is at a different commit than the last update this tool
     applied, so someone pulled, reset, or committed there by hand. Usually intentional; mention it
     as information, not a fault. `/skill-manager:sync` brings it back to the pinned ref (and will
     refuse if there is uncommitted work).

   - **unregistered folders** — folders under the skills directory that no registry entry claims.
     Perfectly normal: a skill installed by hand, or one maintained elsewhere. Offer
     `/skill-manager:status --drift` to see which, then `/skill-manager:add` for any they want
     tracked. Do not present the count as a problem needing fixing.
   - **`last auto check`** — auto-update runs as a detached background pass launched at
     session start, throttled. If it says `never` or the age far exceeds the interval, the pass is
     failing to complete — check `skill-manager.log` in the state dir. `/skill-manager:sync` is the
     manual catch-up.

Note that updates fetched automatically become active from the **next** session, because Claude
Code discovers skills before hooks run. This is expected — don't report it as a problem.
