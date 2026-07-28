# Architecture

Node 18+ and the `git` CLI. No npm dependencies. See `CONCEPT.md` for why the project exists and
which alternatives were retained.

## Layout

```
.claude-plugin/plugin.json       plugin manifest (name = command namespace)
.claude-plugin/marketplace.json  single-plugin marketplace, "source": "./"
commands/*.md                    one per verb -> /skill-manager:<verb>
                                 (sync, list, status, discover, add, remove)
hooks/hooks.json                 one SessionStart entry (line + detached update)
scripts/paths.js                 XDG config/state resolution
scripts/registry.js              pure helpers + registry read/validate/write
scripts/sync.js                  git plumbing, install modes, commands, CLI
scripts/registry.test.js         node --test
skills/skill-manager/SKILL.md    natural-language triggering
```

The plugin name (`skill-manager`) is the slash-command namespace. The marketplace and the XDG
application name both use the full repo name (`claude-code-skill-manager`).

The repo is its own marketplace, so it can be installed from a working copy during development:

```
/plugin marketplace add /path/to/claude-code-skill-manager
/plugin install skill-manager@claude-code-skill-manager
```

## File locations

Resolved by `scripts/paths.js`, mirroring the convention used by `claude-code-notifier` and
`claude-code-cockpit`.

| what | macOS / Linux | Windows |
|---|---|---|
| registry | `$XDG_CONFIG_HOME/claude-code-skill-manager/skills.json` → `~/.config/…` | `%APPDATA%\claude-code-skill-manager\skills.json` |
| stamp / lock / log | `$XDG_STATE_HOME/claude-code-skill-manager/` → `~/.local/state/…` | `%LOCALAPPDATA%\claude-code-skill-manager\` |
| skills dir | `$CLAUDE_SKILLS_DIR`, else `~/.claude/skills` | same |

State files: `last-check` (mtime is the throttle stamp), `last-report` (mtime is the cutoff for
what has already been announced), `skill-manager.lock` (holds the owning pid),
`skill-manager.log`, `updates.json`.

`updates.json` holds `{ dir: { sha, at } }` — the last update the engine *applied* per skill. It has
to be written as it happens: git can say what a checkout is at, but not when this tool last moved it.
Records are pruned to the current registry on every write, so removing a skill cleans up after
itself. It is derived state — deleting it costs a dash in `status`, nothing more, which is why every
write is best-effort and a failure never turns a successful update into a reported one.

Override order — registry: `--registry` → config path. Skills dir: `--skills-dir` →
`$CLAUDE_SKILLS_DIR` → default.

**The registry must live outside the plugin.** A marketplace-installed plugin lives in a
version-pinned cache directory that Claude Code replaces on update; a registry shipped inside the
payload would be destroyed every time the plugin upgraded.

## The registry

```json
{
  "autoUpdate": true,
  "checkIntervalHours": 6,
  "mode": "apply",
  "skills": [{ "repo": "git@github.com:owner/repo.git", "ref": "main", "dir": "spec" }]
}
```

Settings sit at the top level beside `skills` rather than in a separate config file, so there is one
file to hand-edit. Absent file, absent keys, and an empty `skills` array are all valid and all mean
"do nothing" — there is no seeding.

Per entry: `repo` (required), `ref` (default `main`), `subdir`, `dir`, `mode`. `dir` defaults to the
last segment of `subdir`, else the repo name minus `.git`. Since Claude Code discovers skills by
folder name, `dir` is required whenever the repo name differs from the skill's `name:`.

Writes go through `writeRegistryFile`: temp file plus `fs.renameSync`, preserving unknown top-level
keys so hand-edits and `_comment` survive tooling.

Invalid entries are **collected and skipped**, not fatal: valid siblings still install, every error
is reported, and the process exits nonzero.

## Install modes

**`clone`** (default for a whole-repo skill) — `git clone` directly into `<skills-dir>/<dir>`,
keeping `.git`. An existing checkout of the same repo is adopted in place (fetch + update), never
re-cloned. Updates are fast-forward only; a folder with uncommitted changes or a diverged branch is
skipped with a reason. Refuses a target that exists but is not a git checkout, or whose `origin`
points elsewhere. `--force` hard-resets to the ref (untracked files survive).

**`copy`** (default when `subdir` is set) — a subdirectory cannot be a standalone pushable repo, so
the repo is cloned once into `<skills-dir>/.skill-manager-cache/<slug>`, hard-synced to the ref, and
the subdir is copied into place with `.git` excluded. `<slug>` is a readable prefix plus a 12-char
hash of the normalized URL, so repos shared by several entries are cloned once. Publishing is a
staged swap (`.skm-tmp` → rename old aside → rename new in → delete old) with rollback, so a reader
sees the old tree or the new one, never a partial one.

Copy rather than symlink is deliberate: Windows requires admin or Developer Mode for symlinks.

## The probe

Answering "is this entry behind?" without transferring objects:

- **SHA-pinned** — a commit SHA is immutable, so `rev-parse HEAD` matching the pinned value is proof
  of currency. **Zero network.**
- **Branch or tag** — one `git ls-remote origin <ref>` compared against local `HEAD`. Tags are
  probed rather than trusted, since a tag can be force-moved. For an annotated tag the peeled
  `refs/tags/<ref>^{}` line wins, because that is the commit a checkout lands on.
- **`copy` mode** — the target has no `.git`, so the comparison uses the *cache* `HEAD`. A missing
  or corrupt cache counts as behind, which makes an interrupted earlier run self-healing.

**Known imprecision (deliberate).** The `copy`-mode probe compares the repo *commit*, not the subdir
*tree*. So a commit touching only `skills/alpha` marks `skills/beta` as behind too, and beta gets a
redundant (idempotent, local) re-copy — and in `notify` mode is reported as having an update it does
not really have. Fixing it properly would mean comparing subdir tree SHAs, which requires the remote
objects, which requires a fetch — defeating the point of a cheap probe. Repo-granularity plus a
harmless re-copy is the better trade.

## What `status` reports

```
[info] 4 registered, 4 installed
[info] auto-update: on (mode=apply, every 6h)
[info] last auto check: 34m ago (next due in 5.4h)
[skill] scaffold            f80a65c        updated 3d ago
[skill] foss-design-system  0802c49        no update recorded
[info] 9 unregistered folders (--drift to list)
```

The per-skill SHA is read **live** from the entry's checkout, not from `updates.json` — so it stays
truthful even when a skill was moved outside this tool by a hand pull or a local commit. For a
`copy`-mode entry it comes from the cache, since the target has no `.git`. The timestamp is the
opposite: it can only come from the record.

`no update recorded` is the honest answer for a skill adopted at its current tip and never moved
since — not an error, and the expected state right after registering existing folders.

`updated 3d ago (moved since)` means the live SHA and the recorded one disagree: something moved that
checkout outside this tool — a hand pull, a reset, a local commit. Without the marker the timestamp
would imply the current state came from that update, which is exactly the kind of quiet lie the
live-SHA choice exists to avoid.

Drift is summarized to a count; `--drift` lists it. With a small registry the per-folder lines
outnumbered everything else and buried the counts and check times that are the point of the command.

## The two destructive paths

Only two operations can lose work, and both are reachable solely from an explicit manual flag —
never from `auto`.

**`sync --force`** hard-resets a `clone`-mode checkout to its pinned ref, discarding modifications to
tracked files and local commits. `checkoutRef(..., force)` issues
`git checkout --force -B <ref> origin/<ref>` followed by `reset --hard`. The `--force` on the
*checkout* is load-bearing and easy to drop by mistake: a bare `checkout -B` **refuses** when tracked
files are modified, which is exactly the situation the flag exists to resolve. Untracked files
survive — neither `checkout --force` nor `reset --hard` removes them.

**`remove --purge`** deletes the folder. Because that is unrecoverable, it is gated on
`hasUnpushedCommits`, which **refreshes remote-tracking refs before deciding**. This matters more
than it looks: `git log --branches --not --remotes` compares against *cached* refs, so a stale cache
happily reports "everything is pushed" for commits that exist nowhere else. If the refresh fails —
offline, dead remote, revoked key — or the log cannot be read, the answer is "unpushed" and the purge
is refused. A repo with no remote at all also answers "unpushed", since nothing in it is pushed
anywhere. **Fail safe, never fail open.** `--force` overrides all of it.

## The `auto` path (a detached background pass)

`auto` is not wired to a hook. It is spawned as a **detached child** by the `SessionStart` hook,
which returns without waiting for it:

```js
spawn(process.execPath, [__filename, 'auto'], { detached: true, stdio: 'ignore' }).unref()
```

**Why detached rather than inside a hook.** `auto` originally ran inline in a `SessionEnd` hook. That
failed in practice: teardown killed it one to two seconds in, before four `ls-remote` probes
finished — no log line, no stamp, and a leaked lock, all silently. A hook running while its session
is dismantled has no reliable time budget. Detached from session *start*, the pass inherits the
session's lifetime; startup pays only the spawn (~26 ms measured).

1. Registry missing / unreadable / `autoUpdate: false` / no entries → exit 0, silent. No lock, no
   stamp, no log. This is the fresh-install path. (The parent also checks, to avoid spawning at all.)
2. Stamp younger than `checkIntervalHours` → exit 0, silent. **The common path; it stays one stat.**
3. Acquire `skill-manager.lock` (`open` with `wx`, atomic). Held → exit 0.
4. Start the deadline. Per entry, while budget remains: probe; if behind, fetch and apply. Every git
   op is capped at `min(remaining, 60s)`. Exhausted → stop and log what was skipped.
5. Write the stamp **unconditionally**, including on failure — so a dead network or an expired
   credential degrades to one retry per interval, not one per session.
6. Record each applied update in `updates.json`; the next session start announces it.
7. **Exit 0 on every path**, including an unhandled exception.

`AUTO_DEADLINE_MS` is 5 minutes and the per-op cap 60s — a runaway guard, not a latency budget, since
nothing waits on the pass. Both were an order of magnitude tighter when this ran inline, which is
precisely why it never completed.

`--force` is unreachable from `auto`. `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` mean a
passphrase-locked key fails to the log instead of hanging a background process forever.

### The lock, and why a dead owner beats an age threshold

The lock file holds the owning pid. `acquireLock` reclaims it when **the owner is dead**, falling
back to a 10-minute age threshold only when the pid is unreadable or may have been recycled.

Age alone was not enough, and this was observed rather than theorised: a killed pass leaves the lock
behind (its `finally` never runs), and waiting out the window blocks every subsequent attempt for its
duration. If something kills the pass consistently, an age-only rule means nothing ever updates —
and says nothing about it.

### Output channels

`systemMessage` is used, never `additionalContext` — the latter is injected into the model's context,
a per-session token cost for a message the model has no use for. A detached pass has no session to
speak to at all, so **the log file is the real channel**: findings go there, and the *next* session
start reports what changed (see below). `/skill-manager:status` is where history is read.

During `auto` all logging is redirected into a sink and flushed to the log file, so stdout carries
only the `systemMessage` JSON, if any.

## The `session-status` path (the SessionStart hook)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" session-status      timeout: 10
```

The only hook. It does two things and returns:

1. **Prints one line** — what is tracked, what changed since last time, when the next check is due.
2. **Spawns the detached `auto` pass** if the throttle is due.

```
[skill-manager] 4 skills · git updated · checked 2m ago · next in 5.9h
```

`git updated` is the load-bearing part. Updates land for a *later* session by construction, so this
is the only place the user finds out one happened. Each is announced **exactly once**: anything in
`updates.json` newer than the `last-report` marker is news, and the marker is stamped as the line is
printed. Three names at most, then `+N`.

The two halves are gated differently, on purpose.

The **spawn** fires for every source: a clear or a compaction is a free extra chance to catch up, and
the throttle makes it cost one `stat`.

The **line** has three behaviours by source:

| source | line |
|---|---|
| `startup`, `resume` (and an absent source, i.e. run by hand) | full — counts, news, timings |
| `clear` | **news only** — `[skill-manager] b updated`, and nothing at all when there is none |
| `compact` | nothing |

`clear` gets the terse form because the user is mid-work and already knows their own state; counts and
timings would be pure noise, but an update they haven't heard about is still worth one line. `compact`
gets nothing because it can fire repeatedly inside a single long task.

The report marker is stamped **only when a line was actually shown**. Otherwise a `clear` with no news
would consume updates that a later `startup` should have announced.

**Strictly local.** Two reads: the registry, and a `stat` of the stamp. It never shells out to git —
which is why it runs *before* `requireGit()`, so a missing git cannot turn a status line into an
error at session start. Network work here would be pointless anyway: discovery precedes hooks, so
nothing fetched now could apply to this session.

Silent when there is nothing worth saying: no registry, an empty registry, or
`sessionStatus: false`. Variants: `never checked`, `next check due` when overdue, `auto-update off`,
and `N not installed` when a registered entry has no folder.

**Fires only on `startup` and `resume`.** `hooks.json` registers no matcher, so the script reads the
hook's stdin JSON and gates on `source` itself — more robust than relying on matcher syntax, and it
keeps `clear` and `compact` quiet, since those happen mid-work where an unsolicited banner is noise.
The stdin read is guarded on `isTTY` so running the subcommand by hand doesn't block. An absent or
unparseable `source` is allowed through, which keeps it testable from a terminal.

`systemMessage` only, never `additionalContext`, and **exit 0 on every path** -- including when the
spawn fails. A background pass that never starts is a missed update; a session start that errors is a
user-visible fault, and the second is worse.

## Windows-specific handling

Every item exists for a specific failure, and the reasons are worth keeping:

- **Reserved device names** (`con`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`) rejected as folder names.
- **Trailing `.` or space** rejected — Windows silently strips them, which would desync the
  installed/drift check from the folder actually created.
- **`<>:"|?*`** rejected on all platforms so a name resolves to the same folder everywhere.
- **Case-insensitive collision detection** — `spec` and `Spec` would fight over one folder on both
  Windows and macOS.
- **`core.autocrlf=false`** on every git call — copy bytes verbatim, no spurious drift.
- **`core.longpaths=true`** — cache paths can exceed the 260-char `MAX_PATH`.
- **Read-only `.git` objects** — `fs.rmSync`'s `maxRetries` handles transient `EBUSY`/`EPERM` but not
  a persistently read-only file, so deletion falls back to clearing the bits recursively and
  retrying.
- **`dereference: true`** when copying — never create a symlink, since that needs admin or Developer
  Mode; a stat guard skips dangling links rather than throwing.
- **`windowsHide: true`** — no popup console per git invocation.

## Testing

```
npm test      # node --test scripts/*.test.js
```

Covers the pure helpers: subdir normalization and traversal rejection, URL parsing and
normalization, mode/dir resolution, the full `validateDirName` rule set, slug stability, SHA
detection, settings layering, drift computation, and registry read/write round-tripping.

The git-touching paths are not unit-tested; they are verified by running `sync`, `add`, and `remove`
against real repositories.
