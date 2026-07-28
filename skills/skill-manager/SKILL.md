---
name: skill-manager
description: Install, sync, and update the user's Claude Code skills from their own registry of GitHub repos. Use when the user says things like "update my skills", "sync skills", "install a skill from github", "add this repo as a skill", "refresh my skills", "check my skill status", "list my registered skills", or "stop tracking that skill". Skills are installed as editable git clones under the skills directory and also refresh automatically on session end.
---

# Skill Manager

Keeps a user-defined list of GitHub repositories installed as skills under the Claude Code skills
directory. The list lives in a JSON registry the user owns; a bundled Node engine clones missing
repos and updates existing ones.

A whole-repo skill is installed as a real, editable **git working clone** — its `.git` is kept, so
the user can edit and `git push` straight from the skills folder — and updates are **fast-forward
only**, never discarding local work. A skill that lives in a **subdirectory of a monorepo** is
copied in instead (no `.git`), because a subdirectory cannot be a standalone pushable repo.

## Prefer the slash commands

This plugin ships one command per verb. When the user's intent maps to one, use it — the commands
carry the flag guidance and the safety rules:

| intent | command |
|---|---|
| update / sync / install my skills | `/skill-manager:sync` |
| what's registered? | `/skill-manager:list` |
| what's installed, is auto-update working, what's drifting? | `/skill-manager:status` |
| track a new repo | `/skill-manager:add <repo-url>` |
| stop tracking one | `/skill-manager:remove <name>` |

Underneath, every command runs the same engine:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" <sync|list|status|add|remove> [flags]
```

## Reading the output

The engine prints single prefixed lines. Surface them verbatim or summarize faithfully:

- `[ok] foo @ main` — updated (a ` (new)` suffix means first install).
- `[skip] foo: uncommitted local changes` — **not a failure.** The folder has edits or diverged
  commits, and sync deliberately protected them. Committing and pushing resolves it; `--force`
  discards the work and should only be used on an explicit request.
- `[error] foo: ...` — a genuine failure. The engine continues past it and exits nonzero, so read
  the whole output and name **every** entry that failed.
- `[drift] foo (present but not in registry)` — a folder no entry claims. Expected for skills the
  user installed by hand.

## Automatic updates

A `SessionEnd` hook runs the same engine in a throttled `auto` mode: at most once every
`checkIntervalHours` (default 6), bounded by a hard 20-second deadline so a stalled network can
never hold a session open on quit. It probes with `git ls-remote` — one round-trip per entry, and
none at all for a SHA-pinned one — and only fetches what is actually behind.

**Updates become active from the next session.** Claude Code discovers skills *before* hooks run,
so no hook can refresh the session it fires in. This is a property of the design, not a bug — if
the user wants a skill live immediately, they need `/reload-skills` or a restart after syncing.

The hook is deliberately silent when nothing changed, and never passes `--force`. Its history goes
to a log in the state directory; `/skill-manager:status` reports when it last ran.

A second `SessionStart` hook prints a one-line summary at the start of each new or resumed session —
`[skill-manager] 4 skills · checked 15m ago · next in 5.8h`. It is purely local (registry plus one
`stat`, no network, no git), stays silent when nothing is registered, and is switched off with
`sessionStatus: false`. If the user asks why they are seeing it, or wants it gone, that setting is
the answer — not disabling `autoUpdate`, which is a different thing.

## The registry

`skills.json` lives in the user's config directory (`~/.config/claude-code-skill-manager/` on
macOS and Linux, `%APPDATA%\claude-code-skill-manager\` on Windows) — deliberately **outside** the
plugin, which is replaced wholesale whenever the plugin updates.

```json
{
  "autoUpdate": true,
  "checkIntervalHours": 6,
  "mode": "apply",
  "sessionStatus": true,
  "skills": [
    { "repo": "git@github.com:owner/my-skill.git", "ref": "main" },
    { "repo": "https://github.com/owner/mono.git", "subdir": "skills/foo", "dir": "foo" }
  ]
}
```

Per-entry fields: `repo` (required clone URL), `ref` (branch/tag/SHA, default `main`), `subdir`
(path within the repo that IS the skill), `dir` (target folder name — default is the last segment
of `subdir`, else the repo name), `mode` (`clone` or `copy`).

`dir` matters more than it looks: Claude Code discovers skills by **folder name**, so if a repo is
called `claude-code-spec` but the skill's `name:` is `spec`, the entry needs `"dir": "spec"`.

Settings: `autoUpdate` (false disables the update hook), `checkIntervalHours`, `mode` — `apply`
installs updates, `notify` only reports that they exist — and `sessionStatus` (false silences the
session-start line).

Prefer `/skill-manager:add` over hand-editing this file; it validates the entry before writing.

## Dependencies

**Node 18+** (already required to run this plugin) and the **`git`** CLI. The engine checks for
`git` up front and exits with install guidance if it is missing. No npm packages.
