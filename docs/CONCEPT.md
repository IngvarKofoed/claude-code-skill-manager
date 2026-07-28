# Concept

## What this is

A Claude Code plugin that keeps a user-defined set of GitHub repositories installed as skills,
under the user's own skills directory, and refreshes them without being asked.

The list of repos lives in a registry file the user owns. A bundled Node engine clones what is
missing and updates what is behind. A `SessionEnd` hook runs the same engine on a throttle, so
staying current is not something the user has to remember to do.

## Why it exists alongside the plugin marketplace

Claude Code already has a system for distributing and auto-updating things from git: the plugin
marketplace. Anything this tool does for *distribution* it does redundantly.

The reason it exists anyway is **editability**.

A marketplace-installed plugin lands in a version-pinned, machine-managed cache directory
(`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`) that Claude Code replaces wholesale
on every update. That is the right design for consuming someone else's plugin. It is the wrong place
to *author* one: edits there are throwaway, and there is nothing to push.

This tool installs each whole-repo skill as an ordinary **git working clone, `.git` intact, in the
skills directory where it actually runs**. You can open a skill, change it, commit, and push from
exactly where Claude Code is loading it. Updates are fast-forward only and refuse to touch a folder
with uncommitted or diverged work.

So the dividing line is:

- **Consuming** a skill someone else maintains → publish it as a plugin, let the marketplace do it.
- **Authoring** skills you own and edit in place, across several machines → this tool.

That is also why the managed skills are deliberately *not* converted into plugins. Turning them
into plugins would be a complete solution to a problem this project does not have.

## The constraint that shapes everything

**Claude Code discovers skills before hooks run.** Measured, not assumed: a `SessionStart` hook that
writes a skill into the skills directory produces a skill that is *not* visible to the session that
just ran the hook, but *is* visible to the next one. The same file, unchanged, discovered fine when
it was already on disk beforehand.

The consequence is unavoidable and worth stating plainly: **no hook can refresh the session it fires
in.** Any automatic update lands in a later session.

Once that is accepted, the design question stops being "how do we make updates instant" and becomes
"which moment costs the user least". Session *end* is the answer: nobody is waiting on it, the
skills tree is left settled before the next session starts, and the mutation happens when this
session has stopped reading skills. Session start would pay a latency cost for identical freshness.

The contract, therefore: **an update fetched when a session ends is live from the next session
onward.** Anyone wanting a skill live immediately syncs manually and reloads.

## Design commitments

- **Never destroy local work.** Updates fast-forward only. A folder with uncommitted changes or
  commits that diverged from the pinned ref is skipped and reported, never overwritten. `--force`
  exists but is unreachable from the automatic path.
- **Never hang, never nag.** The automatic pass is bounded by a hard wall-clock deadline and cannot
  prompt for git credentials. It prints nothing when nothing changed.
- **The registry belongs to the user.** It lives in the config directory, not in the plugin, so a
  plugin update cannot destroy it. It is plain JSON, hand-editable, and hand-edits survive tooling.
- **Windows is a real target.** Not an afterthought — reserved device names, read-only git objects,
  long paths, and the absence of symlink permissions are all handled explicitly.
- **One runtime.** Node and `git`, nothing else. No npm packages.

## Retained alternatives

Recorded because they were considered seriously and may become right later.

**A `SessionStart` staleness backstop.** `SessionEnd` delivery is best-effort: a `kill -9`, a closed
terminal, or a sleeping laptop skips it, and a machine that never ends a session cleanly never
auto-updates. The mitigation today is visibility — `/skill-manager:status` reports the age of the
last check — plus the manual `/skill-manager:sync`. If that proves to bite, the fix is a cheap
`SessionStart` check that does nothing unless the stamp is *much* older than the interval (say 3×),
and only then pays for a synchronous pass. Deliberately deferred rather than built on speculation.

**Two-phase: fetch at session end, apply at session start.** Splitting the network work from the
mutation looks appealing, and was the original plan. Given that discovery precedes hooks it is
actually the worst option available: an update fetched at the end of session N would be applied at
the start of session N+1, *after* that session's discovery, so it would not go live until session
N+2. The pending-marker machinery buys nothing. Retained only as the shape to revisit if the
backstop above is ever built — its `SessionStart` half is the natural home for it.

**A detached background worker.** Spawning a child from `SessionStart` that outlives the hook. Gets
the work off the critical path, which `SessionEnd` also does, but costs a cross-session lock and
the fiddliest cross-platform code in the design, and still cannot report until the next session.
No advantage left once `SessionEnd` is on the table.

## Non-goals

- Converting the managed skills into plugins.
- Managing skills the registry does not list. Unregistered folders are reported as drift, never
  adopted automatically.
- A GUI. If visual management is ever wanted, a panel inside an existing dashboard is cheaper than
  a second web surface here.
- Importing whatever is already in the skills directory. The registry starts empty and is built by
  explicit `add` calls; nothing is adopted on the user's behalf.
