# Recommended skills

A starting registry. These five are the skills worth having installed on day one — they cover the
whole loop of a change: **spec it → scaffold the repo → build → review the diff → commit it**.

Every block below is meant to be **copy-pasted straight into Claude Code**. Nothing here needs to be
typed by hand or adapted.

**Before you start:** the `skill-manager` plugin has to be installed. If it isn't, paste this first:

```
/plugin marketplace add IngvarKofoed/claude-code-skill-manager
/plugin install skill-manager@claude-code-skill-manager
```

---

## Install all of them at once

Paste this one prompt:

```
Install these skills with skill-manager, one at a time:

- https://github.com/IngvarKofoed/claude-code-spec.git      as dir "spec"
- https://github.com/IngvarKofoed/claude-code-scaffold.git  as dir "scaffold"
- https://github.com/IngvarKofoed/claude-code-fix-code.git  as dir "fix-code"
- https://github.com/IngvarKofoed/claude-code-git.git       as dir "git"

Then show me the status.
```

Then reload so Claude picks them up:

```
/reload-skills
```

> **`--dir` is not optional.** Claude Code discovers skills by **folder name**, and every one of
> these repos is named `claude-code-<skill>` while the skill inside is named `<skill>`. Without
> `--dir` you get `~/.claude/skills/claude-code-git/` — a folder whose name doesn't match the skill,
> so it never loads.

The fifth skill, `foss-design-system`, is FOSS-internal — [see below](#foss-design-system).

---

## One at a time

Each skill on its own, if you'd rather pick.

### `spec` — write the design doc before the code

Turns an idea into a written spec *before* anything is implemented. Strictly read-only: it researches
the codebase freely but the only file it may write is the spec markdown. Offers you 2–3 design
approaches to choose between, drafts to `docs/specs/YYYY-MM-DD-<slug>.md`, asks you to mark it up
with inline `////` comments, integrates them, and closes with an implementation strategy.

```
/skill-manager:add https://github.com/IngvarKofoed/claude-code-spec.git --dir spec
```

Use it with: `/spec add rate limiting to the ingest endpoint`

### `scaffold` — bootstrap a repo's CLAUDE.md

Run it on a repo that already has `docs/CONCEPT.md` and `docs/ARCHITECTURE.md`. Writes the root and
per-subtree `CLAUDE.md` files, seeds `docs/CHANGELOG.md`, and stops there. On a repo that already has
CLAUDE.md files it never overwrites blind — it audits them against current conventions and offers
surgical, additive updates.

```
/skill-manager:add https://github.com/IngvarKofoed/claude-code-scaffold.git --dir scaffold
```

Use it with: `/scaffold` — or `audit my CLAUDE.md files`

### `fix-code` — review the diff you're about to commit

Reviews your **uncommitted working tree**, finds real defects, rates each 1–5 by consequence. This is
the one that fills the gap `/code-review` leaves: that needs a pull request to exist and only posts a
comment, while this reads the live working tree and can repair what it finds. Report-only by default.

```
/skill-manager:add https://github.com/IngvarKofoed/claude-code-fix-code.git --dir fix-code
```

Use it with: `/fix-code` to report, `/fix-code --fix` to also apply the repairs.

### `git` — commit and push, cheaply

Hands the commit/push work to a cheap Haiku subagent, so reading the diff and writing the message
never lands in your main session's context. It matches the repo's existing commit-message style and
returns a short summary. Commit/push only — not rebasing, branching, or conflict resolution.

```
/skill-manager:add https://github.com/IngvarKofoed/claude-code-git.git --dir git
```

Use it with: `/git commit`, `/git push`, `/git commitandpush`

### `foss-design-system`

The FOSS Design System — component specs, design tokens, icons, usage guidelines, and inline lint
rules for FOSS instrument UI. Once installed it applies itself: any UI code written in the session is
validated against `rules/lint.md` before you see it.

**Internal to FOSS** — hosted on Azure DevOps, so this one needs an SSH key with access to the
`FossAnalytical/SoftwareInnovation` project. It will fail for everyone else, which is expected.

```
/skill-manager:add git@ssh.dev.azure.com:v3/FossAnalytical/SoftwareInnovation/claude-skills-foss-design-system --dir foss-design-system
```

Use it with: `build the sample-history screen using the FOSS design system`

---

## If you plan to edit and push these skills

The URLs above are HTTPS — read-only clones that work with no setup, which is what you want if you're
just consuming the skills.

If you intend to change a skill and push it back, register it over **SSH** instead. That's the point
of skill-manager: each skill is an ordinary git working clone with `.git` intact, sitting in the
folder Claude actually loads it from, so you can edit, commit and push from right there.

```
/skill-manager:add git@github.com:IngvarKofoed/claude-code-spec.git     --dir spec
/skill-manager:add git@github.com:IngvarKofoed/claude-code-scaffold.git --dir scaffold
/skill-manager:add git@github.com:IngvarKofoed/claude-code-fix-code.git --dir fix-code
/skill-manager:add git@github.com:IngvarKofoed/claude-code-git.git      --dir git
```

Push access isn't required to register over SSH — but if you'll never push, HTTPS is one less thing
to configure.

---

## After installing

```
/reload-skills
```

Claude Code discovers skills at **session start**, so a skill installed mid-session isn't loaded
until you reload or restart.

From then on skill-manager keeps them current: a throttled background pass at session start (every 6
hours by default) fetches what's behind, fast-forward only, and **skips any folder where you have
uncommitted or diverged work** — it will never overwrite something you're in the middle of. Updates
go live from your *next* session, and the session-start line names each one exactly once.

Check on them any time:

```
/skill-manager:status
```

---

## Already installed some of these by hand?

Don't re-add them — that would install a second copy under the repo's name. Ask skill-manager to
adopt what's already there:

```
/skill-manager:discover
```

It reads each folder's `origin` and branch off disk, offline, and prints the exact `add` line each
one needs — including the `--dir` that makes it adopt the existing folder instead of cloning beside
it. It reports only; nothing is adopted without you saying so.

## Not using skill-manager?

Plain clones work too — you just lose the automatic updates. Note the explicit target directory; drop
it and git names the folder after the repo, and the skill won't load:

```bash
git clone https://github.com/IngvarKofoed/claude-code-spec     ~/.claude/skills/spec
git clone https://github.com/IngvarKofoed/claude-code-scaffold ~/.claude/skills/scaffold
git clone https://github.com/IngvarKofoed/claude-code-fix-code ~/.claude/skills/fix-code
git clone https://github.com/IngvarKofoed/claude-code-git      ~/.claude/skills/git
```
