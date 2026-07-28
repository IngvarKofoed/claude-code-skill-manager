---
description: Show registered/installed counts, auto-update state, last check age, and drift.
---

Report the state of the user's managed skills.

1. Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" status
   ```

2. Relay what it prints: the skills directory and registry paths, how many entries are registered
   versus installed, whether auto-update is on (with its mode and interval), how long ago the
   automatic check last ran, and any `[drift]` lines.

3. Explain the two things users usually ask about:

   - **`[drift]`** — a folder under the skills directory that no registry entry claims. On a fresh
     registry every pre-existing skill shows as drift; that is correct, not a bug. Either add a
     matching entry with `/skill-manager:add`, or leave it as an untracked local skill.
   - **`last auto check`** — auto-update runs on **session end**, throttled. If it says `never` or
     the age is much larger than the interval, sessions are probably not ending cleanly (a killed
     terminal skips the hook). `/skill-manager:sync` is the manual catch-up.

Note that updates fetched automatically become active from the **next** session, because Claude
Code discovers skills before hooks run. This is expected — don't report it as a problem.
