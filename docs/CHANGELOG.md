# Changelog

Each entry is numbered with a monotonically increasing integer. Append new entries to the end. Never reuse or reorder numbers. Numbers are globally unique across this file and any future `CHANGELOG-archive.md` — never reused. Write each entry as durable project memory: what is now true that wasn't before, plus the why in a clause when not obvious — not a recap of the diff (filenames and mechanical edits live there). Keep it to 1–5 lines, ~20 words per line at most; never one packed run-on line.

1. Initial release. Keeps a user-owned registry of skill repos installed as editable git clones in
   the skills directory, so a skill can be edited and pushed from where it runs.
   Updates run unattended on `SessionEnd` — throttled, deadline-bounded, `--force` unreachable, and
   skipping any checkout with uncommitted or diverged work. A `SessionStart` line reports what is
   tracked and when the next check is due.
   Hooks were measured to run *after* skill discovery, so no hook can refresh its own session; that
   is why the update work sits at session end, where it costs nothing, rather than session start.
   The registry lives in the XDG config dir, deliberately outside the plugin payload, which Claude
   Code replaces wholesale on every plugin update.
