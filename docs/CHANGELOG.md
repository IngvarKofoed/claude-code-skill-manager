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

2. `status` now summarizes unregistered folders as a single count; `--drift` lists them.
   With a small registry the per-folder lines outnumbered the status itself, burying the counts and
   check times that are the point of the command.
   Most unregistered folders are local-only skills that will never be registered, so the list is
   rarely the answer to why someone ran `status`.

3. `status` now shows each skill's short SHA and when it last changed.
   The SHA is read live from the checkout so it stays true even after a hand pull; the timestamp is
   persisted to `updates.json` as updates are applied, because git cannot say when *this tool* last
   moved a checkout.
   Records are pruned to the registry on write, and every write is best-effort — losing the file
   costs a dash in `status`, so it must never turn a successful update into a reported failure.
   A `(moved since)` marker appears when the live SHA disagrees with the recorded one, so the
   timestamp can never imply the current checkout came from that update.

4. The update pass now runs as a **detached child spawned at session start**; the `SessionEnd` hook
   is gone.
   Inline in `SessionEnd` it never completed: teardown killed it 1–2s in, before four `ls-remote`
   probes finished, leaving no log, no stamp and a leaked lock — silently. Startup now pays only the
   spawn (~26 ms) and the pass inherits the session's lifetime, so the deadline could go 20s → 5 min.
   The lock now reclaims on a **dead owner**, not just age: a killed pass leaves it behind, and an
   age-only rule blocked every retry for the whole window.

5. The session-start line now names the skills updated since it last spoke, exactly once.
   Updates land for a later session by construction, so this is the only place the user finds out one
   happened; a `last-report` marker is stamped as the line prints, making anything newer news.

6. `/clear` now shows the line too, but only as news — the updated skill names alone, and nothing
   when nothing changed.
   Mid-work the counts and timings are noise, yet an unannounced update still deserves a line;
   compaction stays fully silent because it can fire repeatedly inside one task.
   The report marker is stamped only when a line was actually shown, so a quiet `clear` cannot
   swallow updates a later startup should announce.

7. New read-only `discover` command: reports unregistered folders in the skills dir that could be
   tracked, with the exact `add` flags each needs.
   It computes `--dir` when the repo name differs from the folder — without it an add would install a
   second copy instead of adopting what is there — and `--ref` for a non-`main` branch.
   Deliberately reports rather than adopts, matching the standing non-goal, and stays offline: origin
   URL, branch and folder name are all local. A `copy`-mode skill has no `.git`, so it cannot be
   distinguished from a local-only folder and needs `--subdir` by hand.

8. `RECOMMENDED_SKILLS.md` gives new users a starting registry — `spec`, `scaffold`, `fix-code`,
   `git`, plus the FOSS-internal `foss-design-system` — as copy-pasteable prompts.
   The registry starts empty by design, which leaves a first-run blank page; this fills it without
   seeding anything automatically.
   Public repos are listed over HTTPS so they clone with no key setup, with the SSH forms kept for
   anyone who will edit and push a skill back.

9. The registry now lives at `~/.claude/skill-manager/skills.json`, beside the skills it lists.
   In `~/.config` a restored `~/.claude` backup brought back the clones but silently lost the list.
   Rejected `${CLAUDE_PLUGIN_DATA}`: keyed by install source and deleted on uninstall.
   A registry at the old XDG path is moved over automatically; an existing new file always wins.
   State stays XDG and machine-local — a lock pid or throttle stamp must not travel between machines.

10. `$CLAUDE_CONFIG_DIR` now relocates both the registry and the default skills dir.
    Previously the skills dir was hardcoded to `~/.claude/skills`, so with it set, skills were
    installed where Claude Code never looked.
