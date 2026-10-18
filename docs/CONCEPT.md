# Concept

## What this is

A Claude Code plugin that keeps a user-defined set of GitHub repositories installed as skills,
under the user's own skills directory, and refreshes them without being asked.

The list of repos lives in a registry file the user owns. A bundled Node engine clones what is
missing and updates what is behind. A `SessionStart` hook launches the same engine as a detached
background pass, on a throttle, so staying current is not something the user has to remember to do.

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
"which moment costs the user least, and actually completes".

Session *end* looked like the answer — nobody is waiting, and the tree is left settled before the
next session starts. **In practice it did not survive contact.** Session teardown killed the hook
one to two seconds in, before four `ls-remote` probes could finish: no log line, no stamp, and a
leaked lock. Unattended updates silently never completed. That is not a tuning problem; a hook that
runs while its session is being dismantled has no reliable time budget at all.

So the work is **spawned detached at session start** and the hook returns immediately. Startup pays
only the spawn (measured at ~26 ms), the child inherits the whole session's lifetime instead of a
teardown race, and freshness is unchanged. It does mutate the tree mid-session — but that objection
was always weaker than it looked, because running several sessions at once means *any* moment is
mid-session for somebody. What actually protects readers is that each skill is replaced atomically.

The contract, therefore: **an update is live from the next session onward.** Anyone wanting a skill
live immediately syncs manually and reloads.

Because the update lands for a later session, session start is also the only place the user
naturally learns it happened — so the one-line banner names what changed, once.

## Design commitments

- **Never destroy local work.** Updates fast-forward only. A folder with uncommitted changes or
  commits that diverged from the pinned ref is skipped and reported, never overwritten. `--force`
  exists but is unreachable from the automatic path.
- **Never hang, never nag.** The automatic pass is bounded by a hard wall-clock deadline and cannot
  prompt for git credentials. It prints nothing when nothing changed.
- **The registry belongs to the user.** It lives in `~/.claude` beside the skills it lists, not in
  the plugin — so a plugin update cannot destroy it, and backing up `~/.claude` carries the list
  along with the clones. It is plain JSON, hand-editable, and hand-edits survive tooling.
- **Windows is a real target.** Not an afterthought — reserved device names, read-only git objects,
  long paths, and the absence of symlink permissions are all handled explicitly.
- **One runtime.** Node and `git`, nothing else. No npm packages.

## Retained alternatives

Recorded because they were considered seriously and may become right later.

**Running the pass inside a `SessionEnd` hook.** The original design, and the reasoning behind it
still holds in the abstract: nothing waits on it, and the tree is settled before the next session.
It was abandoned on evidence rather than taste — teardown killed it before it could finish even one
pass, and the failure was completely silent. Kept on record because the *timing* argument is sound
and might be revived if a future runtime guaranteed hooks a shutdown window.

**A synchronous pass at session start.** Simplest possible: no child process, no lock contention, and
the strongest contract — when the hook returns, the tree is current. Rejected because it charges
every session start for network latency (and a stalled remote would stall startup) to buy freshness
that, given discovery precedes hooks, the user cannot use until the next session anyway.

**Two-phase: fetch at session end, apply at session start.** Splitting the network work from the
mutation looks appealing, and was the original plan before the ordering was measured. It is in fact
the worst option available: an update fetched at the end of session N is applied at the start of
N+1, *after* that session's discovery, so it goes live only in N+2. The pending-marker machinery
buys nothing.

**A staleness backstop.** If detached spawning ever proves unreliable too, the cheap fallback is a
synchronous catch-up at session start, but only when the stamp is *much* older than the interval
(say 3×) — paying latency rarely instead of always. Not built, because there is now no evidence it
is needed; `/skill-manager:status` surfaces a stale check age, and `/skill-manager:sync` is the
manual escape hatch.

## Non-goals

- Converting the managed skills into plugins.
- Managing skills the registry does not list. Unregistered folders are reported as drift, never
  adopted automatically.
- A GUI. If visual management is ever wanted, a panel inside an existing dashboard is cheaper than
  a second web surface here.
- Importing whatever is already in the skills directory. The registry starts empty and is built by
  explicit `add` calls; nothing is adopted on the user's behalf.
