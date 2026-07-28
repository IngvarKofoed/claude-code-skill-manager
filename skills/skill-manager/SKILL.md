---
name: skill-manager
description: Install, sync, and update the user's Claude Code skills from their own registry of GitHub repos. Use when the user says things like "update my skills", "sync skills", "install a skill from github", "add this repo as a skill", "refresh my skills", "check my skill status", "list my registered skills", or "stop tracking that skill". Skills are installed as editable git clones under the skills directory and also refresh automatically via a background pass.
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
| which existing folders could I track? | `/skill-manager:discover` |
| what's installed, is auto-update working, what's drifting? | `/skill-manager:status` |
| track a new repo | `/skill-manager:add <repo-url>` |
| stop tracking one | `/skill-manager:remove <name>` |

Underneath, every command runs the same engine:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/sync.js" <sync|list|status|discover|add|remove> [flags]
```

## Reading the output

The engine prints single prefixed lines. Surface them verbatim or summarize faithfully:

- `[ok] foo @ main` — updated (a ` (new)` suffix means first install).
- `[skip] foo: uncommitted local changes` — **not a failure.** The folder has edits or diverged
  commits, and sync deliberately protected them. Committing and pushing resolves it; `--force`
  discards the work and should only be used on an explicit request.
- `[error] foo: ...` — a genuine failure. The engine continues past it and exits nonzero, so read
  the whole output and name **every** entry that failed.
- `[info] 9 unregistered folders (--drift to list)` — folders no registry entry claims. Expected for
  skills installed by hand or maintained elsewhere; `status --drift` lists them individually as
  `[drift]` lines. Never present the count as a problem to fix.
- `[skill] spec  cad9a29  updated 3d ago` — from `status`: the skill's current short SHA (read live
  from its checkout, so always accurate) and when this tool last moved it. `no update recorded` means
  it hasn't changed since it was registered — normal, not a fault.

## Automatic updates

There is **one** hook, on `SessionStart`. It does two things and returns immediately:

1. **Prints a one-line summary** — `[skill-manager] 4 skills · git updated · checked 2m ago · next in
   5.9h`. Purely local (registry plus one `stat`); silent when nothing is registered. On `/clear` it
   prints **only** news (`[skill-manager] b updated`) and nothing when there is none; a compaction
   prints nothing at all.
2. **Spawns a detached background pass** if the throttle (`checkIntervalHours`, default 6) is due.
   That pass probes with `git ls-remote` — one round-trip per entry, none at all for a SHA-pinned one
   — fetches only what is behind, and never passes `--force`.

**Updates become active from the next session.** Claude Code discovers skills *before* hooks run, so
no hook can refresh the session it fires in. That is why the line reports what changed: it is the
first moment the user can act on it. Each update is announced exactly once. If the user wants a skill
live immediately they need `/reload-skills` or a restart after syncing.

The pass runs detached rather than in a `SessionEnd` hook because that was tried and failed — session
teardown killed it before it finished, silently. Its history goes to a log in the state directory;
`/skill-manager:status` reports when it last ran.

To silence the line, `sessionStatus: false`. That is the answer if the user asks why they are seeing
it — **not** `autoUpdate: false`, which stops updates entirely and is a different thing.

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
