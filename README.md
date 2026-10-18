# skill-manager

A Claude Code **plugin** that keeps a set of GitHub repos installed as skills — as **editable git
clones you can push from** — and refreshes them automatically in the background.

You list the repos you want in one registry file. The plugin clones what's missing, updates what's
behind, and never touches a folder where you have uncommitted work.

Requires **Node 18+** and the **`git`** CLI. No npm packages — install the plugin and it works.

## Install

```
/plugin marketplace add IngvarKofoed/claude-code-skill-manager
/plugin install skill-manager@claude-code-skill-manager
```

For local development, point the marketplace at a working copy instead:

```
/plugin marketplace add /path/to/claude-code-skill-manager
/plugin install skill-manager@claude-code-skill-manager
```

The registry starts **empty** — nothing is seeded and nothing already in your skills directory is
adopted. Existing skills simply show up as unregistered until you register the ones you want, and
`/skill-manager:discover` tells you which of them *can* be.

## Use

```
/skill-manager:add <repo-url>     register a repo and install it now
/skill-manager:list               what's registered
/skill-manager:discover           find already-installed skills worth tracking
/skill-manager:status             per-skill SHA + last update, auto-update state, next check
/skill-manager:sync               update everything now
/skill-manager:remove <name>      stop tracking one
```

Start with `add`:

```
/skill-manager:add git@github.com:you/claude-code-spec.git --dir spec
```

`--dir` matters: Claude Code discovers skills by **folder name**, so if the repo is
`claude-code-spec` but the skill's `name:` is `spec`, the folder has to be `spec`.

New skills load at session start, so `/reload-skills` or a restart after adding one.

Nothing to register yet? [`RECOMMENDED_SKILLS.md`](RECOMMENDED_SKILLS.md) is a starting set —
copy-paste prompts for `spec`, `scaffold`, `fix-code` and `git`.

## Adopting skills you already have

If you were installing skills by hand before, `discover` tells you which of them can be tracked:

```
$ /skill-manager:discover
[candidate] reconcile-docs  git@github.com:you/claude-code-reconcile-docs.git  (--dir reconcile-docs)
[skip] nes-rom-builder: not a git checkout -- nothing to track
[skip] scratch-dir: not a git checkout -- nothing to track, and no SKILL.md
[info] 1 candidate; add with:
[info]   add git@github.com:you/claude-code-reconcile-docs.git --dir reconcile-docs
```

Read-only and offline — it reads each folder's `origin` and branch from disk and writes nothing, so
you choose what to adopt. Mostly a one-time command after installing.

It works out the flags for you, which matters most for `--dir`: without it an `add` would install a
*second* copy under the repo's name instead of adopting the folder already there. It also suggests
`--ref` when a checkout sits on a branch other than `main`.

What it can't see: a **monorepo-subdir skill** has no `.git`, so it's indistinguishable from a
local-only folder and shows as `not a git checkout` — those need `--subdir` by hand.

## Automatic updates

At session start the plugin launches a **detached background pass** and immediately gets out of the
way — startup pays only the spawn (~26 ms). The pass is throttled to once every `checkIntervalHours`
(default 6). It probes with `git ls-remote` — one round-trip per entry, none at all for a SHA-pinned
one — fetches only what's actually behind, never passes `--force`, and skips any folder where you
have uncommitted or diverged work.

**Updates go live from your next session.** Claude Code discovers skills *before* hooks run — this
was measured, not assumed — so no hook can refresh the session it fires in. That's also why the
session-start line tells you what changed: it's the first moment you can actually use it.

It runs detached rather than inside a `SessionEnd` hook because that was tried and doesn't work:
session teardown killed the hook a second or two in, before the probes could finish, leaving nothing
updated and nothing said about it. A detached child gets the whole session to work in.

`/skill-manager:status` shows how long ago the last check ran, and `/skill-manager:sync` is the
manual catch-up.

## What `status` shows

```
[info] 4 registered, 4 installed
[info] auto-update: on (mode=apply, every 6h)
[info] last auto check: 34m ago (next due in 5.4h)
[skill] scaffold            f80a65c        updated 3d ago
[skill] foss-design-system  0802c49        no update recorded
[info] 9 unregistered folders (--drift to list)
```

Each skill's short SHA is read **live** from its checkout, so it's true even if you pulled or
committed there by hand. The "last update" is when *this tool* last moved it — that can't be
recovered from git, so it's recorded as it happens. `no update recorded` means the skill hasn't
changed since you registered it, which is the normal state after adopting folders already at their
latest commit.

`--drift` expands the unregistered-folder count into a list.

## Session-start line

Each new or resumed session opens with a one-liner — the only place the plugin volunteers anything:

```
[skill-manager] 4 skills · git updated · checked 2m ago · next in 5.9h
```

`git updated` is the important part. Because updates land for a *later* session, this is where you
find out one happened — and each is announced **exactly once**, then never again.

Purely local otherwise — the registry and one `stat`, no network, no git. It stays quiet when there's
nothing to say (no registry, nothing registered) and reports the states that matter: `never checked`,
`next check due` when overdue, `auto-update off`, `N not installed`.

**On `/clear` you get news only:**

```
[skill-manager] b updated
```

…and nothing at all if nothing changed. You're mid-work there and already know your own state, so
the counts and timings would just be noise — but an update you haven't heard about still earns a
line. A compaction shows nothing, since it can fire repeatedly inside one long task. Both still get
a free chance to run the background update.

Set `sessionStatus: false` to silence the line everywhere.

## The registry

`~/.claude/skill-manager/skills.json` (under `$CLAUDE_CONFIG_DIR` if you set it) — beside your
skills, so backing up `~/.claude` keeps the list with the clones, and deliberately outside the
plugin, which gets replaced wholesale on every plugin update. Up to 0.3.0 it lived in
`~/.config/claude-code-skill-manager/` (`%APPDATA%\…` on Windows); a registry there is moved over
automatically the first time the plugin runs.

```json
{
  "autoUpdate": true,
  "checkIntervalHours": 6,
  "mode": "apply",
  "skills": [
    { "repo": "git@github.com:you/my-skill.git", "ref": "main" },
    { "repo": "https://github.com/you/mono.git", "subdir": "skills/foo", "dir": "foo" }
  ]
}
```

| field | required | meaning |
|---|---|---|
| `repo` | yes | git clone URL (HTTPS or SSH) |
| `ref` | no | branch, tag, or commit SHA. Default `main` |
| `subdir` | no | path inside the repo that IS the skill. Omit for the repo root |
| `dir` | no | target folder name. Default: last segment of `subdir`, else the repo name |
| `mode` | no | `clone` or `copy`. Default: `clone` for a whole repo, `copy` when `subdir` is set |

| setting | default | meaning |
|---|---|---|
| `autoUpdate` | `true` | `false` disables the update hook entirely |
| `checkIntervalHours` | `6` | throttle for the automatic check |
| `mode` | `"apply"` | `"notify"` reports available updates without installing them |
| `sessionStatus` | `true` | one-line summary at session start; `false` to silence it |

`add` validates before writing, and hand-edits (including a `_comment`) survive it.

**One repo, several skills:** add one entry per skill with the same `repo` and different
`subdir`/`dir`. The repo is cloned once and shared.

## How it installs

**`clone` mode** (whole-repo skills, the default) — cloned straight into `<skills-dir>/<dir>`,
`.git` and all. It's an ordinary checkout: edit, commit, push from there.

- An existing checkout of the same repo is **adopted in place**, not re-cloned.
- Updates **fast-forward only**. Uncommitted edits or a diverged branch → **skipped and reported**,
  never overwritten. `--force` hard-resets to the ref (untracked files survive).
- Refuses a target that isn't a git checkout, or whose `origin` is a different repo.

**`copy` mode** (a skill inside a monorepo) — a subdirectory can't be a standalone pushable repo, so
the repo is cloned once into a hidden cache, hard-synced to the ref, and the subdir is copied in with
`.git` excluded. Copy rather than symlink, because Windows requires admin rights for symlinks.

## Flags

| flag | effect |
|---|---|
| `--only NAME` | restrict `sync`/`list` to one entry |
| `--drift` | `status`: list the unregistered folders instead of just counting them |
| `--dry-run` | print planned actions, change nothing |
| `--force` | `clone` mode: hard-reset to the ref, **discarding local commits and edits** |
| `--purge` | `remove`: also delete the folder. Refuses on uncommitted or unpushed work — and refuses if the remote can't be reached to check — unless `--force` |
| `--no-sync` | `add`: register without installing |
| `--skills-dir` / `--registry` | override paths |
| `-v` | show git output |

## Troubleshooting

**A skill was skipped ("uncommitted local changes" / "diverged").** Working as intended — that
folder is a real checkout and you have work in it. Commit and push, or `--force` to discard.

**"exists but is not a git checkout" / "origin is … not the registered …".** Something else is in
the way. Move it aside and re-run; sync won't overwrite it.

**"N unregistered folders".** Any folder in the skills directory that no registry entry claims — on a
fresh registry, every skill you already had. Expected, not a fault. `/skill-manager:status --drift`
lists them; register the ones you want managed and ignore the rest.

**`last auto check: never`.** Either `autoUpdate` is off, the registry is empty, or your sessions
aren't ending cleanly. `/skill-manager:sync` works regardless.

**`git` not found.** macOS: `xcode-select --install`. Linux: `apt install git`. Windows:
`winget install Git.Git`.

## Development

```
npm test        # node --test scripts/*.test.js
```

`docs/CONCEPT.md` covers why this exists next to the plugin marketplace and which alternatives were
retained. `docs/ARCHITECTURE.md` covers the layout, path resolution, the probe, the `auto` state
machine, and the Windows-specific handling.

## License

MIT
