# Architecture

Node 18+ and the `git` CLI. No npm dependencies. See `CONCEPT.md` for why the project exists and
which alternatives were retained.

## Layout

```
.claude-plugin/plugin.json       plugin manifest (name = command namespace)
.claude-plugin/marketplace.json  single-plugin marketplace, "source": "./"
commands/*.md                    one per verb -> /skill-manager:<verb>
hooks/hooks.json                 SessionStart (status line) + SessionEnd (update)
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

State files: `last-check` (mtime is the throttle stamp), `skill-manager.lock`, `skill-manager.log`.

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

## The `auto` path (the SessionEnd hook)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" auto      timeout: 30
```

No matcher, so it fires on every `SessionEnd` reason (`clear`, `logout`, `prompt_input_exit`,
`other`). Frequent firing is harmless because the work is throttled — extra firings cost one `stat`.

1. Registry missing / unreadable / `autoUpdate: false` / no entries → exit 0, silent. No lock, no
   stamp, no log. This is the fresh-install path.
2. Stamp younger than `checkIntervalHours` → exit 0, silent. **The common path; it stays one stat.**
3. Acquire `skill-manager.lock` (`open` with `wx`, atomic). Held → exit 0. A lock older than 10
   minutes is treated as a crash leftover and reclaimed once.
4. Start the deadline. Per entry, while budget remains: probe; if behind, fetch and apply. Every git
   op is capped at `min(remaining, 10s)`. Exhausted → stop and log what was skipped.
5. Write the stamp **unconditionally**, including on failure — so a dead network or an expired
   credential degrades to one retry per interval, not one per session.
6. Emit a `systemMessage` only if something changed or was skipped.
7. **Exit 0 on every path**, including an unhandled exception.

`AUTO_DEADLINE_MS` is 20s against a hook `timeout` of 30s, so the engine's own limit fires first and
stops cleanly rather than being killed mid-operation.

`--force` is unreachable from `auto`. `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` mean a
passphrase-locked key fails to the log instead of holding the session open.

### Output channels

`systemMessage` is used, never `additionalContext` — the latter is injected into the model's context,
a per-session token cost for a message the model has no use for. Since a `SessionEnd` message may not
be surfaced at all, **the log file is the real channel** and `/skill-manager:status` is where history
is read.

During `auto` all logging is redirected into a sink and flushed to the log file, so stdout carries
only the `systemMessage` JSON, if any.

## The `session-status` path (the SessionStart hook)

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" session-status      timeout: 10
```

A one-line summary of what is tracked and when the next check is due — the counterpart to `auto`,
and the only place the plugin volunteers information rather than waiting to be asked:

```
[skill-manager] 4 skills · checked 15m ago · next in 5.8h
```

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

Like `auto`: `systemMessage` only, never `additionalContext`, and **exit 0 on every path**.

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
