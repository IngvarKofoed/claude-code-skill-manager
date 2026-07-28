# claude-code-skill-manager — scripts

The whole engine. Everything executable in this repo lives here; see `docs/ARCHITECTURE.md` for how it fits the plugin around it.

Contents: `paths.js` (XDG config/state resolution), `registry.js` (pure helpers + registry read/validate/write), `sync.js` (git plumbing, install modes, commands, CLI), `registry.test.js`.

Node 18+, CommonJS, **Node builtins only — no npm dependencies, ever.** Adding one changes the plugin's install story (today: install it and it works), so it needs a decision in `docs/ARCHITECTURE.md` first, not a `package.json` edit.

## Required tools

- **`LSP`** — use it for symbol navigation and finding references across `paths.js` / `registry.js` / `sync.js`. The port deliberately spread helpers across three files, so callers of a helper are rarely in the file you're editing; grep under-reports. Provided by the `typescript-lsp` plugin, which handles `.js` as well as `.ts`.

## Testing

`node --test scripts/*.test.js` (or `npm test`). Tests target the **pure** helpers in `registry.js` — naming, validation, slug stability, settings layering, drift, registry round-tripping. Each case corresponds to a guard that exists for a specific reason, so a test name that reads like trivia (`com10 is not reserved`) is load-bearing: do not delete a case without establishing why the guard it covers no longer matters.

The git-touching paths have **no unit coverage** and are verified by running `sync`, `add`, and `remove` against real repositories with `--registry` / `--skills-dir` / `XDG_STATE_HOME` pointed at scratch paths. Never smoke-test against the real `~/.claude/skills` or `~/.config/claude-code-skill-manager`. Do not introduce a different test framework, or any test dependency, without updating the architecture doc.

## Invariants — do not break these

These are the rules the design rests on. Each one exists because violating it produces a bad failure, not a slightly worse one.

- **Both hook entry points — `auto` and `session-status` — exit 0 on every path**, including unhandled exceptions. A nonzero exit is user-visible noise from a tool whose whole job is to be unobtrusive.
- **`session-status` never touches the network or git.** It runs at session start, the one moment the user is actively waiting, and it deliberately runs *before* `requireGit()` so a missing git cannot turn a status line into an error. Adding a fetch here would also be pointless: discovery precedes hooks, so nothing fetched could apply to this session.
- **`auto` writes the throttle stamp unconditionally**, including on failure and on deadline exhaustion. Otherwise a dead network or an expired credential retries on *every* session instead of once per interval.
- **`--force` must stay unreachable from `auto`.** Unattended code may never discard the user's work. The dirty-tree and diverged-branch skips are the point of the tool, not an inconvenience.
- **The deadline is what makes the synchronous design safe.** Never let the `auto` path use the plain `GIT_TIMEOUT`; every git op takes `min(remaining budget, per-op cap)`. Without it a stalled network holds a session open on quit.
- **`GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` on every git invocation.** A hook that can prompt is a hook that can hang. A passphrase-locked key must fail to the log.
- **Git is invoked as an argv array, never through a shell.** Registry values are user-supplied strings.
- **Publishing a `copy`-mode target is a staged swap** (`.skm-tmp` → move old aside → move new in) with rollback. A reader must see the old tree or the new one, never a partial one — other sessions read these folders while this runs.
- **Stdout is a protocol in both hook paths.** Only a `{"systemMessage":...}` line may reach it — never `additionalContext`, which would tax every session's model context. `auto` speaks only when something changed or was skipped and routes everything else to the log sink; `session-status` speaks only when there is something registered to report. Silence on a no-op is a feature.

## Windows guards

Every one of these exists for a specific failure, and several are invisible on macOS — do not "simplify" them away. `docs/ARCHITECTURE.md` lists the full set with reasons; the ones most likely to be mistaken for paranoia:

- Reserved device names (`con`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`) and trailing `.`/space rejected as folder names — Windows silently strips the latter, which desyncs the installed/drift check from what is actually on disk.
- `<>:"|?*` rejected on **all** platforms, so a name resolves to the same folder everywhere.
- Case-insensitive collision detection — `spec` and `Spec` fight over one folder on both Windows and macOS.
- Deletion clears read-only bits and retries: `fs.rmSync`'s `maxRetries` covers transient `EBUSY`/`EPERM` but not the persistently read-only files git creates in `.git`.
- `dereference: true` when copying, so a symlink is never *created* (Windows needs admin/Developer Mode), plus a stat guard so a dangling link is skipped rather than fatal.

## Changing a guard

The guards in this engine are the accumulated result of specific failures, and several of them are invisible on macOS. **There is no second implementation to check behavior against** — this is the only one, so the inline comment is the whole record of why a guard exists.

That makes one rule absolute: **do not remove or "simplify" a guard because its purpose isn't obvious.** A missing rationale is a gap in the comment, not evidence the guard is unnecessary. Work out the reason and write it down, or leave the guard alone.

Where the reasons live: inline comments in `sync.js` and `registry.js`, the *Invariants* and *Windows guards* sections above, `docs/ARCHITECTURE.md` for the Windows handling with causes, and `registry.test.js` for the ones cheap enough to pin with a test. When you change behavior deliberately, record it in `docs/ARCHITECTURE.md` rather than letting it become folklore.
