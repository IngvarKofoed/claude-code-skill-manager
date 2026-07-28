# skill-manager

A Claude Code **plugin** that keeps a set of GitHub repos installed as skills — as **editable git
clones you can push from** — and refreshes them automatically when a session ends.

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
adopted. Existing skills simply show up as drift until you register the ones you want.

## Use

```
/skill-manager:add <repo-url>     register a repo and install it now
/skill-manager:list               what's registered
/skill-manager:status             what's installed, auto-update state, drift
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

## Automatic updates

A `SessionEnd` hook runs the engine in a throttled mode: at most once every `checkIntervalHours`
(default 6), bounded by a hard 20-second deadline so a stalled network can't hold a session open
when you quit. It probes with `git ls-remote` — one round-trip per entry, none at all for a
SHA-pinned one — and only fetches what's actually behind. It's silent when nothing changed, and it
never passes `--force`.

**Updates go live from your next session.** Claude Code discovers skills *before* hooks run — this
was measured, not assumed — so no hook can refresh the session it fires in. Session end is simply
the cheapest moment to do the work: nothing is waiting on it, and the tree is settled before the
next session starts.

`SessionEnd` is best-effort. A killed terminal or a sleeping laptop skips it, so
`/skill-manager:status` shows how long ago the last check ran and `/skill-manager:sync` is the
manual catch-up.

## Session-start line

Each new or resumed session opens with a one-liner, so staleness is visible without asking:

```
[skill-manager] 4 skills · checked 15m ago · next in 5.8h
```

Purely local — the registry and one `stat`, no network, no git. It stays quiet when there's nothing
to say (no registry, or nothing registered) and reports the states that matter: `never checked`,
`next check due` when overdue, `auto-update off`, and `N not installed`. It doesn't fire on `/clear`
or a compaction, which happen mid-work. Set `sessionStatus: false` to turn it off.

## The registry

`~/.config/claude-code-skill-manager/skills.json` (`%APPDATA%\claude-code-skill-manager\` on
Windows) — deliberately outside the plugin, which gets replaced wholesale on every plugin update.

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

**Everything shows as `[drift]`.** Drift is any folder in the skills directory that no registry
entry claims. On a fresh registry that's every skill you already had — expected. Add entries for the
ones you want managed.

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
