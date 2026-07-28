# claude-code-skill-manager

A Claude Code plugin that keeps a user-defined set of skill repos installed as editable git clones you can push from, and refreshes them automatically when a session ends.

## Always read first

Before doing any work in this repo, **always read all** of these:

- @docs/CONCEPT.md — why this exists alongside Claude Code's own plugin marketplace (editable working clones you can author in place), the measured "hooks run after skill discovery" constraint and the next-session contract that follows from it, the design commitments, and the retained alternatives.
- @docs/ARCHITECTURE.md — Node + git stack, plugin layout, XDG config/state path resolution, the `clone` vs `copy` install modes, the `ls-remote` probe, the `auto` state machine and its deadline, and the Windows-specific handling.
- @docs/CHANGELOG.md — running log of changes to this project.

`CONCEPT.md` and `ARCHITECTURE.md` are the source of truth for *what* we're building, what we've built, and *how* it's structured. If something in the code contradicts them, either the code or the doc is wrong — flag it rather than guessing.

## Changelog discipline

Every change you make to this repository must be recorded in `docs/CHANGELOG.md`.

- Each entry is numbered with a monotonically increasing integer (1, 2, 3, ...). Never reuse or reorder numbers.
- Append new entries to the end of the file.
- Write each entry as **durable project memory, not a recap of the diff**: record what is now *true that wasn't before* — new behavior, state, or rule — plus, in a clause and only when it isn't obvious, the *why*, the alternative you rejected (so a future agent doesn't re-introduce it), or a known limit / deferred follow-up. Skip filenames, mechanical edits, and refactors with no behavior change; the diff and commit already hold those. Self-check: *if a future agent reads this entry before the code, does it learn what changed, why it matters, or what's now safe to assume?* If not, it's noise.
- Keep each entry to **1–5 lines, ~20 words per line at most**. The changelog is read at session start to orient — that only works if it stays scannable. The failure mode to avoid is cramming everything onto one unbroken line: a 40-word run-on isn't a short entry, it just hides the bulk on a single line. Break it into a few short lines instead; and if it sprawls past ~5 lines, that's a signal it's really several changes — give each its own numbered entry.
- Write the entry as part of the same change. Do not batch multiple changes into one entry, and do not skip entries.
- When a phase/increment completes, its per-task entries move to `docs/CHANGELOG-archive.md`, leaving only the milestone summary in `docs/CHANGELOG.md`. Numbers are globally unique across both files — never reuse one that already appears in either.

Same change, bad vs. good entry:

- **Bad** (short, but just recaps the diff — zero orientation value): `42. Updated auth files, reworked middleware, added tests, renamed AuthHelper.`
- **Good** (states what's now true, with the why in a clause):
  ```
  42. Auth now rejects expired refresh tokens before session lookup; stale sessions can no longer silently renew.
      Validated at the middleware boundary so handlers can assume requests are current.
  ```

## Nested guidance

- `scripts/CLAUDE.md` — the Node engine: path resolution, registry validation, git plumbing, the two install modes, and the `SessionEnd` auto path. All executable code lives here.

The remaining directories are small enough to be governed by this file: `.claude-plugin/` (two JSON manifests), `commands/` and `skills/skill-manager/` (agent-facing markdown), `hooks/` (one JSON file), `docs/`.

## Releasing and versions

The version is declared in **three** files and only two are read by Claude Code. Nothing keeps them in sync automatically, so bump them together:

- `.claude-plugin/plugin.json` → `version` — the real version. Names the install cache dir, reported by `claude plugin list` / `details`, recorded in `installed_plugins.json`.
- `.claude-plugin/marketplace.json` → `plugins[0].version` — the marketplace's claim about the plugin. **Must match `plugin.json`.**
- `package.json` → `version` — read by nothing in Claude Code; kept for parity and `npm test`.

Before releasing, run **`claude plugin validate .`** (manifest shape) and **`claude plugin tag`** — the latter creates the `skill-manager--v<version>` git tag *and validates that `plugin.json` and the marketplace entry agree*. That check is the guard against the drift this is prone to: `claude-code-cockpit` currently declares `0.39.0` in `plugin.json` and `0.2.0` in `marketplace.json`. Do not hand-create release tags and skip the gate.

Do **not** add git-describe-style versioning. There is no build step to bake a version into, and Claude Code reads the version as a literal from `plugin.json`; `claude plugin tag` derives the tag *from* that literal, which is the opposite direction.

While this repo is installed from a `directory`-source marketplace, `${CLAUDE_PLUGIN_ROOT}` resolves to the working tree, so commands and hooks run the live code and edits take effect on `/reload-plugins` — no version bump needed to test. The version only becomes load-bearing once the marketplace source is a published GitHub repo.

## After making changes

After a non-trivial edit, **give the change a real review automatically — code-review quality, self-initiated** — so every change gets reviewed without anyone having to invoke anything. The `/code-review` skill is user-invoke-only (`disable-model-invocation`); you cannot call it, so *you* run the review — never skip it, and never apologize for not running the skill.

Scale the review to the change:

- **Small, contained edits** — read the diff yourself in one careful pass.
- **Substantial or complex changes** — fan the review out across **subagents via the Agent tool** (individual agents; this needs no ultracode opt-in — that gate is only for the Workflow tool), **one per dimension that's actually at risk in this diff (typically 2–4)**, then **verify each finding before acting on it**. Review finders run on the strong model; verification can drop a tier (the same tiering as *Multi-agent workflows* below). If the Agent tool isn't available, do the same review yourself in one thorough pass.

Check, across the diff: **correctness, security & data-integrity, edge cases & tests, reuse / duplication, clarity, performance, and conformance to this repo's own conventions** (the CLAUDE.md rules and established patterns). Then **apply every fix to the working tree automatically.**

Once the fixes are applied, report what changed:

1. **Group the applied fixes by severity** — blockers (correctness bugs, data loss, security), should-fix (clear improvements, missed reuse), nits (style, naming, minor clarity).
2. **Summarize each bucket in one line** so the user can see what was fixed without expanding every finding.
3. Do not stop to ask which to fix — all findings are fixed by default. The user can review the diff and revert anything they disagree with.

### Suggesting a user-run `/code-review`

**Default: say nothing.** Most turns end with the self-review report and no suggestion. The review already happened; a reflexive "you may also want to run `/code-review`" on every diff is noise, and trains the user to ignore it on the one change where it mattered. Suggest a pass only when you can **name the trigger that fired**. Can't name one? Don't suggest.

**Triggers — any one is enough:**

- **Heavy self-review** — you fixed a genuine blocker (a real correctness, security, or data-integrity bug), or applied should-fix changes across most of the files you touched. A handful of nits is not churn.
- **High-consequence surface** — the diff touches authn/authz, permissions, secrets or crypto, money/billing, schema migrations or data deletion/backfill, concurrency or locking, or a published API / wire contract.
- **Large and non-mechanical** — roughly >400 changed lines or >10 files of real logic. A rename, a formatting sweep, or generated files of the same size do not count.
- **Multi-agent fan-out produced the diff** — no single agent ever saw the whole combined change.
- **Genuine uncertainty** — you guessed at intent, left a known gap, or couldn't verify the change (nothing covers it, or you couldn't run it).

**Level — choose it, don't default to one:**

- **`/code-review medium`** — the ordinary triggered case: a large refactor, a heavy self-review, or a workflow-produced diff on ordinary code.
- **`/code-review high`** — when the high-consequence-surface trigger fired, when you fixed **more than one** blocker, or when two or more triggers fired at once. It's slower and costlier, so it needs one of those reasons — size alone isn't one.
- Never suggest above `high`; going deeper than that is the user's call to make unprompted.

**These do *not* trigger it:** docs- or changelog-only edits, formatting and lint fixes, dependency bumps, adding tests to existing code, a contained single-function change with tests passing, or a self-review that turned up only nits on ordinary code.

When you do suggest: **one sentence** at the end of the turn — the code is already self-reviewed with fixes applied, a fresh independent pass would add assurance, and **which trigger fired**. Frame it as optional reassurance, not a warning that something is wrong. `/code-review` is user-invoke-only, so only they can run it. Only claim the code was already reviewed if you actually ran the self-review above.

## Multi-agent workflows

When you fan a task out across subagents — the Workflow tool ("ultracode") — tier each agent's model and reasoning effort to the work, so cost tracks value instead of every agent defaulting to the strongest (most expensive) model:

- **Strongest model** (the session model) — contracts, correctness-critical implementation, adversarial review (finding unknown problems), and any verification or synthesis that needs design judgment or where a wrong call silently drops a real defect (security, data-integrity, correctness blockers). Never downgrade these; they are where quality is won or lost.
- **Mid model** — build/test runners, straightforward mechanical implementation, verifying concrete already-stated findings (the review did the catching), and applying already-decided fixes.
- **Cheapest model + low effort** — docs/changelog, i18n, styling, and other boilerplate.

The guardrail: the stage that *catches* an unknown problem (review) stays strong; a stage that only *checks* or *applies* an already-identified one drops a tier by default — escalate a verifier back to the strong model only for subtle or security-/data-integrity-critical findings. For a small finding set, fold verification into the fix-apply agent (verify-and-fix in one pass) rather than one strong agent per finding. Set this per `agent()` call (`model` / `effort`); an agent that omits `model` inherits the session model, which is why an untiered fan-out silently runs everything on the most expensive tier.

**Invoking a named workflow is not authoring one.** The tiers above are yours to set only when *you* write the `agent()` calls. A built-in or named workflow — e.g. `Workflow({ name: 'code-review' })` — runs its own stages on the session model; nothing tiers them for you, so a wide fan-out (the review's per-`(file,line)` verifiers most of all) silently bills every agent at the top tier. Before launching one at `high`+ effort or over a broad diff, check the `scriptPath` the run reports: if a large *checking* stage isn't tiered, edit that script to drop those agents to the mid model (leaving the finders and final synthesis strong) and re-invoke with `{ scriptPath }` instead. Keep them strong only when the diff is security-/data-integrity-critical. For `code-review` specifically: its verifier agents default to the mid model.

**When a workflow returns, self-review its aggregate diff.** A fan-out edits files across several subagents — often in separate worktrees — so no single agent ever saw the whole combined change. The moment control returns to you, the `## After making changes` self-review applies to the **entire diff the workflow produced**: read it as one coherent change, not per-agent, and apply fixes. A multi-agent change has no single author who saw the whole thing, so it fires the *multi-agent fan-out* trigger in **Suggesting a user-run `/code-review`** above — make the suggestion, and pick the level by the rule there (`high` if it also touched a high-consequence surface or the self-review fixed more than one blocker). (Any review stage *inside* the workflow checks its findings/outputs; it does not replace this pass over the landed diff.)

This section is inert unless you actually run a multi-agent workflow.

## Git workflow

**Direct to `main`** — when you commit, commit straight to `main`; don't open branches or PRs unless asked. **Pushing is left to the user** — never push. This repo is published and others install from it, so nothing reaches the remote without an explicit human action.

**This setting only chooses *where* commits go — not *when* to make them.** Commit only when the user asks; finishing a change is not a cue to commit it. When you do commit, each commit is one complete change including its `docs/CHANGELOG.md` entry — never leave the tree half-committed.

<!-- Add additional sections below as the project develops:
  - Project-specific forcing rules (e.g., "Check in with the user before making CSS / layout / UX changes")
  - Destructive-operation guidance if the agent's defaults aren't enough
  - Naming conventions, code-organization rules
-->
