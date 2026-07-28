#!/usr/bin/env node
'use strict';
// skill-manager sync engine.
//
// Clones/updates a user-defined list of GitHub repos into the Claude Code
// skills directory. Cross-platform (macOS / Linux / Windows), Node builtins
// only. The sole external dependency is the `git` CLI.
//
// The platform-specific hardening below is deliberate and each guard states
// the reason it exists. Those comments are load-bearing: if a guard's purpose
// is not obvious, that is a gap in the comment, not evidence the guard is
// unnecessary. Supply the missing reason rather than removing the guard.
//
// Two per-entry modes (auto-selected, override with "mode" in the registry):
//   * clone (default for a whole-repo skill): git-clone the repo DIRECTLY into
//     <skills-dir>/<dir>, keeping .git so you can edit and push in place.
//     Updates are fast-forward only and never discard local work (--force
//     excepted).
//   * copy  (default when "subdir" is set): a subdir of a monorepo cannot be a
//     standalone pushable repo, so the repo is cloned once into a hidden cache
//     and the subdir is copied (.git-excluded) into <skills-dir>/<dir>.
//
// Invocation:
//     node sync.js sync            (manual, any platform)
//     node sync.js auto            (the SessionEnd hook; always exits 0)

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const P = require('./paths');
const R = require('./registry');
const { SyncError } = R;

// ---- runtime floor -------------------------------------------------------
// fs.cpSync landed in 16.7; node --test in 18. Refuse older rather than fail
// deep inside a copy with a confusing error.
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
if (NODE_MAJOR < 18) {
  process.stderr.write('[error] Node 18+ required (found ' + process.versions.node + ')\n');
  process.exit(3);
}

// ---- constants -----------------------------------------------------------
const TMP_SUFFIX = '.skm-tmp'; // staging dir for atomic-ish swap
const OLD_SUFFIX = '.skm-old'; // backup during swap
const GIT_TIMEOUT_MS = 600_000; // manual runs: guard a hung network/auth op
// `auto` runs detached, so nothing is waiting on it and the deadline is a
// runaway guard rather than a latency budget. It was 20s when the pass ran
// inside a SessionEnd hook; that proved far too tight -- session teardown
// killed the hook 1-2s in, before four SSH probes could finish, so unattended
// updates never completed. Detaching removed the need to be stingy.
const AUTO_DEADLINE_MS = 300_000; // 5 min for the whole pass
const AUTO_PER_OP_CAP_MS = 60_000; // 1 min for any single git op
const LOCK_STALE_MS = 10 * 60 * 1000; // a lock older than this is a crash leftover

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;
const EXIT_NOGIT = 3;

// ============ logging (single-line, ASCII-prefixed) ========================
// `auto` swaps in a sink so nothing reaches stdout: a hook must be silent
// unless it has something worth interrupting the user for.
let SINK = null;

function log(tag, msg) {
  const line = `[${tag}] ${msg}`;
  if (SINK) SINK.push(line);
  else process.stdout.write(line + '\n');
}

function vlog(verbose, msg) {
  if (!verbose) return;
  const line = '      ' + msg;
  if (SINK) SINK.push(line);
  else process.stdout.write(line + '\n');
}

// ============ robust tree deletion (Windows read-only .git files) ==========

/** Recursively clear read-only bits so a delete can proceed. */
function chmodTreeWritable(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  try {
    fs.chmodSync(p, 0o700);
  } catch {
    /* best effort */
  }
  if (st.isDirectory()) {
    let kids = [];
    try {
      kids = fs.readdirSync(p);
    } catch {
      return;
    }
    for (const k of kids) chmodTreeWritable(path.join(p, k));
  }
}

/**
 * Recursively remove a tree, tolerating Windows read-only git objects.
 *
 * fs.rmSync's maxRetries handles transient EBUSY/EPERM, but NOT a file that is
 * persistently read-only -- which is exactly what git marks its objects on
 * Windows. So on failure we clear the bits recursively and retry.
 */
function safeRmTree(p) {
  let exists = true;
  try {
    fs.lstatSync(p);
  } catch {
    exists = false;
  }
  if (!exists) return;
  const opts = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
  try {
    fs.rmSync(p, opts);
  } catch {
    chmodTreeWritable(p);
    fs.rmSync(p, opts);
  }
}

// ============ deadline budget =============================================

/**
 * Wall-clock budget for a run.
 *
 * Manual runs get a null deadline and the generous per-op GIT_TIMEOUT. The
 * `auto` path gets a hard total, so a stalled network cannot hold a session
 * open on quit: every git op is capped at min(remaining, per-op cap).
 */
function makeBudget({ totalMs = null, perOpCapMs = null } = {}) {
  const start = Date.now();
  return {
    remainingMs() {
      if (totalMs === null) return Infinity;
      return Math.max(0, totalMs - (Date.now() - start));
    },
    exhausted() {
      return this.remainingMs() <= 0;
    },
    gitTimeoutMs() {
      if (totalMs === null) return GIT_TIMEOUT_MS;
      return Math.max(1, Math.min(this.remainingMs(), perOpCapMs || GIT_TIMEOUT_MS));
    },
  };
}

// ============ GIT PLUMBING ================================================

/** Exit early with actionable guidance if the git CLI is not on PATH. */
function requireGit() {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['git'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (probe.status === 0) return;
  log(
    'error',
    'git not found on PATH. Install Git and reopen your terminal -- ' +
      'macOS: xcode-select --install (or brew install git); ' +
      'Linux: apt/dnf install git; ' +
      'Windows: https://git-scm.com/download/win'
  );
  process.exit(EXIT_NOGIT);
}

/** Common spawn options: no auth prompts, no popup console on Windows. */
function gitSpawnOpts(cwd, timeoutMs, inherit) {
  return {
    cwd: cwd ? String(cwd) : undefined,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    windowsHide: true,
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  };
}

/**
 * Run a git command (argv array, never a shell). Throws SyncError on failure.
 *
 * core.autocrlf=false: copy bytes verbatim, avoid spurious drift on Windows.
 * core.longpaths=true: tolerate deep cache paths past the 260-char MAX_PATH.
 */
function runGit(args, cwd, ctx, { check = true } = {}) {
  const show = Boolean(ctx.verbose);
  vlog(ctx.verbose, 'git ' + args.join(' '));
  const argv = ['-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', ...args];
  const p = spawnSync('git', argv, gitSpawnOpts(cwd, ctx.budget.gitTimeoutMs(), show));
  if (p.error && p.error.code === 'ETIMEDOUT') {
    throw new SyncError(`git ${args[0]} timed out`);
  }
  if (p.error) {
    throw new SyncError(`git ${args[0]} failed to start: ${p.error.message}`);
  }
  const combined = show ? '' : `${p.stdout || ''}${p.stderr || ''}`;
  if (check && p.status !== 0) {
    let tail = '';
    const lines = combined.trim().split('\n').filter(Boolean).slice(-4);
    if (lines.length) tail = ': ' + lines.join(' / ');
    throw new SyncError(`git ${args[0]} failed (rc=${p.status})${tail}`);
  }
  return { status: p.status, out: combined };
}

/** Boolean probe of a git command; never throws, never streams. */
function gitOk(args, cwd, ctx) {
  try {
    const quiet = { ...ctx, verbose: false };
    return runGit(args, cwd, quiet, { check: false }).status === 0;
  } catch {
    return false;
  }
}

/** Run git and return { status, out }; captures regardless of verbose. */
function gitCapture(args, cwd, ctx) {
  const quiet = { ...ctx, verbose: false };
  return runGit(args, cwd, quiet, { check: false });
}

/** True if `p` looks like a working git checkout. */
function isGitRepo(p, ctx) {
  return fs.existsSync(path.join(p, '.git')) && gitOk(['rev-parse', '--is-inside-work-tree'], p, ctx);
}

/** URL of the 'origin' remote, or null if there is no origin. */
function remoteUrl(repo, ctx) {
  const { status, out } = gitCapture(['remote', 'get-url', 'origin'], repo, ctx);
  const t = out.trim();
  return status === 0 && t ? t : null;
}

/** Current branch name, or '' when detached / unknown. */
function currentBranch(repo, ctx) {
  const { status, out } = gitCapture(['rev-parse', '--abbrev-ref', 'HEAD'], repo, ctx);
  const name = out.trim();
  return status !== 0 || name === 'HEAD' ? '' : name;
}

/** Resolved HEAD commit, or '' if unknown. */
function headSha(repo, ctx) {
  const { status, out } = gitCapture(['rev-parse', 'HEAD'], repo, ctx);
  return status === 0 ? out.trim() : '';
}

/**
 * True if there are staged/unstaged edits to tracked files.
 *
 * Untracked files are ignored: a fast-forward/checkout never silently discards
 * them (git refuses if one would be overwritten).
 */
function hasTrackedChanges(repo, ctx) {
  const { status, out } = gitCapture(['status', '--porcelain', '--untracked-files=no'], repo, ctx);
  return status === 0 && Boolean(out.trim());
}

/** True if `ref` names a branch on origin (vs a tag or commit SHA). */
function refIsBranch(repo, ref, ctx) {
  return gitOk(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${ref}`], repo, ctx);
}

/**
 * True if the local checkout has commits absent from every remote.
 *
 * Refreshes the remote-tracking refs first. `--not --remotes` compares against
 * CACHED refs, so a stale cache reports "everything is pushed" for commits that
 * exist nowhere else -- precisely the false negative this guard must never make,
 * since its only caller is about to delete the folder.
 *
 * When the refresh fails (offline, dead remote, revoked key) or the log cannot
 * be read, we cannot prove the commits are safe, so we answer TRUE and let the
 * caller refuse. A repo with no remote at all also answers TRUE: nothing in it
 * is pushed anywhere. Fail safe, never fail open.
 */
function hasUnpushedCommits(repo, ctx) {
  const fetched = gitCapture(['fetch', '--all', '--prune'], repo, ctx);
  if (fetched.status !== 0) {
    log('warn', `${path.basename(repo)}: cannot reach the remote to verify commits are pushed`);
    return true;
  }
  const { status, out } = gitCapture(['log', '--branches', '--not', '--remotes', '--oneline'], repo, ctx);
  if (status !== 0) return true;
  return Boolean(out.trim());
}

/**
 * Resolve `ref` on origin WITHOUT fetching objects -- the cheap probe.
 *
 * Returns the commit SHA, or null when the remote has no such ref. For an
 * annotated tag the peeled `^{}` line is the commit a checkout would land on,
 * so it wins over the tag-object line.
 */
function lsRemoteSha(repo, ref, ctx) {
  const { status, out } = gitCapture(['ls-remote', 'origin', ref], repo, ctx);
  if (status !== 0) throw new SyncError(`git ls-remote failed for ref '${ref}'`);
  const rows = out
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha, name] = l.split(/\s+/);
      return { sha, name };
    });
  if (!rows.length) return null;
  const pick =
    rows.find((r) => r.name === `refs/tags/${ref}^{}`) ||
    rows.find((r) => r.name === `refs/heads/${ref}`) ||
    rows.find((r) => r.name === `refs/tags/${ref}`) ||
    rows[0];
  return pick ? pick.sha : null;
}

/** Check out `ref` in `repo`: track the branch, or detach a tag/SHA. */
function checkoutRef(repo, ref, ctx, force = false) {
  if (refIsBranch(repo, ref, ctx)) {
    if (force) {
      // --force on the checkout is load-bearing: a bare `checkout -B` REFUSES
      // when tracked files are modified, which is exactly the situation
      // --force exists to resolve. Untracked files are still preserved
      // (neither checkout --force nor reset --hard removes them), as
      // documented.
      runGit(['checkout', '--force', '-B', ref, `origin/${ref}`], repo, ctx);
      runGit(['reset', '--hard', `origin/${ref}`], repo, ctx);
    } else {
      runGit(['checkout', ref], repo, ctx);
    }
    return;
  }
  if (!gitOk(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo, ctx)) {
    throw new SyncError(`ref '${ref}' not found (not a branch/tag/commit on origin)`);
  }
  const argv = ['checkout', '--detach'];
  if (force) argv.push('--force');
  argv.push(ref);
  runGit(argv, repo, ctx);
}

// ============ REPO CACHE: clone-or-fetch (once per repo per run) ============

/** Clone (if missing) or fetch (if present) the repo into its cache dir. */
function ensureRepoFetched(cacheRoot, repo, ctx) {
  const slug = R.repoSlug(repo);
  const cache = path.join(cacheRoot, slug);
  if (ctx.dryRun) {
    const action = isGitRepo(cache, ctx) ? 'fetch' : 'clone';
    log('skip', `(dry-run) would ${action} ${repo} -> cache/${slug}`);
    return cache;
  }
  if (fs.existsSync(cache) && !isGitRepo(cache, ctx)) {
    vlog(ctx.verbose, `cache ${slug} corrupt (no valid .git); removing`);
    safeRmTree(cache);
  }
  if (!fs.existsSync(cache)) {
    log('sync', `cloning ${repo}`);
    fs.mkdirSync(cacheRoot, { recursive: true });
    // Clone into a temp dir, then atomically move into place so an interrupted
    // clone never poisons the cache. --no-single-branch so arbitrary
    // branches/tags are available as origin/*.
    const tmp = path.join(cacheRoot, slug + TMP_SUFFIX);
    safeRmTree(tmp);
    try {
      runGit(['clone', '--no-single-branch', repo, tmp], null, ctx);
      fs.renameSync(tmp, cache);
    } finally {
      safeRmTree(tmp);
    }
  } else {
    vlog(ctx.verbose, `fetching ${repo}`);
    runGit(['fetch', 'origin', '--tags', '--prune', '--force'], cache, ctx);
  }
  return cache;
}

// ============ HARD-SYNC to a ref (branch vs tag vs SHA) ====================

/** Check out `ref` in the cache; force-match a branch, detach a tag/SHA. */
function hardSync(cache, ref, ctx) {
  if (ctx.dryRun) {
    log('skip', `(dry-run) would checkout ${ref} in ${path.basename(cache)}`);
    return;
  }
  const isBranch = gitOk(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${ref}`], cache, ctx);
  if (isBranch) {
    // Move the local branch onto the remote tip and discard any local drift.
    runGit(['checkout', '-B', ref, `origin/${ref}`], cache, ctx);
    runGit(['reset', '--hard', `origin/${ref}`], cache, ctx);
    runGit(['clean', '-xdf'], cache, ctx);
    return;
  }
  // Tag or commit SHA -> detached checkout (reset --hard is meaningless).
  if (!gitOk(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cache, ctx)) {
    throw new SyncError(`ref '${ref}' not found (not a branch/tag/commit on origin)`);
  }
  runGit(['checkout', '--force', '--detach', ref], cache, ctx);
  runGit(['clean', '-xdf'], cache, ctx);
}

// ============ COPY into target: exclude .git + drop stale ==================

/** Publish `subdir` (or repo root) into `target` via an atomic-ish swap. */
function copyEntry(cache, subdir, target, ctx) {
  const src = subdir ? path.join(cache, subdir) : cache;
  if (ctx.dryRun) {
    const what = subdir || '<repo root>';
    if (!isGitRepo(cache, ctx)) {
      // Nothing cloned yet -- can't inspect the subtree, so don't claim a
      // missing subdir. This is the common "preview before first run" case.
      log('skip', `(dry-run) would copy ${what} -> ${target} (repo not yet cloned)`);
    } else if (!fs.existsSync(src)) {
      log('skip', `(dry-run) WOULD FAIL: subdir '${subdir}' missing in repo`);
    } else {
      log('skip', `(dry-run) would copy ${what} -> ${target}`);
    }
    return;
  }
  let srcStat = null;
  try {
    srcStat = fs.statSync(src);
  } catch {
    /* handled below */
  }
  if (!srcStat || !srcStat.isDirectory()) {
    throw new SyncError(`subdir '${subdir}' not found in repo checkout`);
  }
  if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) {
    throw new SyncError(`target '${target}' exists and is not a directory`);
  }

  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const tmp = path.join(parent, path.basename(target) + TMP_SUFFIX);
  const old = path.join(parent, path.basename(target) + OLD_SUFFIX);
  for (const stale of [tmp, old]) safeRmTree(stale);
  try {
    // Stage a clean copy: exclude .git at every depth. dereference:true turns
    // symlinks into real files so we never create one -- Windows needs
    // admin/Developer Mode for that -- and the stat guard tolerates broken
    // links instead of throwing on them.
    fs.cpSync(src, tmp, {
      recursive: true,
      force: true,
      dereference: true,
      filter: (from) => {
        if (path.basename(from) === '.git') return false;
        try {
          fs.statSync(from); // follows the link: throws on a dangling symlink
          return true;
        } catch {
          return false;
        }
      },
    });
    vlog(ctx.verbose, `staged ${src} -> ${path.basename(tmp)}`);
    if (fs.existsSync(target)) fs.renameSync(target, old); // atomic within one fs
    fs.renameSync(tmp, target); // publish the new tree
    safeRmTree(old);
  } catch (err) {
    // Rollback: restore the backup if we already moved the target away.
    if (!fs.existsSync(target) && fs.existsSync(old)) fs.renameSync(old, target);
    throw err;
  } finally {
    for (const stale of [tmp, old]) safeRmTree(stale);
  }
}

// ============ CLONE mode: direct editable working checkout =================

/**
 * Install/adopt `repo` as an editable working checkout at `target`.
 *
 * Returns "new" (freshly cloned), "ok" (existing, fetched/updated), or
 * "skipped" (left untouched to protect local work; reason already logged).
 * Throws SyncError on a genuine failure. Keeps .git so the user can commit and
 * push from the folder; updates fast-forward only unless ctx.force.
 */
function cloneSync(repo, ref, target, ctx) {
  if (ctx.dryRun) {
    if (!fs.existsSync(target)) {
      log('skip', `(dry-run) would clone ${repo} -> ${target} @ ${ref}`);
    } else if (isGitRepo(target, ctx)) {
      const verb = ctx.force ? 'hard-reset' : 'fast-forward';
      log('skip', `(dry-run) would fetch + ${verb} ${path.basename(target)} @ ${ref}`);
    } else {
      log('skip', `(dry-run) WOULD FAIL: ${target} exists, not a git checkout`);
    }
    return 'ok';
  }

  // -- fresh install: clone into a temp dir, then move into place -----------
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    log('sync', `cloning ${repo}`);
    const tmp = target + TMP_SUFFIX;
    safeRmTree(tmp);
    try {
      runGit(['clone', '--no-single-branch', repo, tmp], null, ctx);
      checkoutRef(tmp, ref, ctx);
      fs.renameSync(tmp, target);
    } finally {
      safeRmTree(tmp);
    }
    return 'new';
  }

  // -- adopt / update an existing folder -----------------------------------
  if (!isGitRepo(target, ctx)) {
    throw new SyncError(
      `'${path.basename(target)}' exists but is not a git checkout; remove or move it aside, then sync`
    );
  }
  const existing = remoteUrl(target, ctx);
  if (existing === null) {
    throw new SyncError(`'${path.basename(target)}' is a git repo with no 'origin' remote`);
  }
  if (R.normalizeRepoUrl(existing) !== R.normalizeRepoUrl(repo)) {
    throw new SyncError(
      `'${path.basename(target)}' origin is ${existing}, not the registered ${repo}; refusing to touch it`
    );
  }

  runGit(['fetch', 'origin', '--tags', '--prune'], target, ctx);

  if (ctx.force) {
    checkoutRef(target, ref, ctx, true);
    return 'ok';
  }

  // Safe update: never discard the user's in-progress work.
  if (hasTrackedChanges(target, ctx)) {
    log(
      'skip',
      `${path.basename(target)}: uncommitted local changes -- not updating (commit/stash, or use --force)`
    );
    return 'skipped';
  }

  if (refIsBranch(target, ref, ctx)) {
    if (currentBranch(target, ctx) !== ref) {
      // Switch to the target branch (safe: no tracked changes above).
      runGit(['checkout', ref], target, ctx);
    }
    const { status } = gitCapture(['merge', '--ff-only', `origin/${ref}`], target, ctx);
    if (status !== 0) {
      log(
        'skip',
        `${path.basename(target)}: local '${ref}' diverged from origin -- not updating (push/rebase, or use --force)`
      );
      return 'skipped';
    }
    return 'ok';
  }

  // Tag or commit SHA: a detached checkout is safe with a clean tree.
  checkoutRef(target, ref, ctx);
  return 'ok';
}

/**
 * Copy-mode: fetch the repo once into the cache, hard-sync, copy the subdir.
 *
 * Fetch failures are memoized per repo so several entries sharing one repo
 * don't re-probe a dead remote.
 */
function copySync(e, target, cacheRoot, repoState, ctx) {
  const slug = R.repoSlug(e.repo);
  if (!repoState.has(slug)) {
    try {
      ensureRepoFetched(cacheRoot, e.repo, ctx);
      repoState.set(slug, 'ok');
    } catch (err) {
      if (!(err instanceof SyncError)) throw err;
      repoState.set(slug, err);
      log('error', `${e.repo}: ${err.message}`);
    }
  }
  if (repoState.get(slug) !== 'ok') throw new SyncError('skipped (repo update failed)');
  const cache = path.join(cacheRoot, slug);
  hardSync(cache, e.ref, ctx);
  const existed = fs.existsSync(target);
  copyEntry(cache, e.subdir, target, ctx);
  return existed ? 'ok' : 'new';
}

// ============ PROBE: is this entry behind? =================================

/**
 * The git checkout that speaks for an entry.
 *
 * For `clone` mode that is the installed folder itself. For `copy` mode the
 * target has no .git, so the cache holds the real checkout -- which is why the
 * SHA of a copied skill has to be read from the cache, not from what the user
 * sees on disk.
 */
function entryRepoDir(e, target, cacheRoot) {
  return e.mode === 'copy' ? path.join(cacheRoot, R.repoSlug(e.repo)) : target;
}

/** Resolved HEAD of an entry's checkout, or '' when there isn't one yet. */
function entrySha(e, target, cacheRoot, ctx) {
  const repoDir = entryRepoDir(e, target, cacheRoot);
  return isGitRepo(repoDir, ctx) ? headSha(repoDir, ctx) : '';
}

/**
 * Cheap "does this entry need updating" check.
 *
 * One `git ls-remote` round-trip at most, and none at all for a SHA-pinned
 * entry -- a commit SHA is immutable, so a matching local HEAD is proof of
 * being current. Never mutates anything.
 */
function probeEntry(e, target, cacheRoot, ctx) {
  const isCopy = e.mode === 'copy';
  const repoDir = entryRepoDir(e, target, cacheRoot);

  if (!fs.existsSync(target)) return { behind: true, why: 'not installed' };
  if (!isGitRepo(repoDir, ctx)) {
    return { behind: true, why: isCopy ? 'cache missing' : 'not a git checkout' };
  }

  const local = headSha(repoDir, ctx);
  if (!local) return { behind: true, why: 'local HEAD unknown' };

  if (R.isCommitSha(e.ref)) {
    const same = local.toLowerCase() === e.ref.trim().toLowerCase();
    return same ? { behind: false, why: 'pinned SHA matches (no network)' } : { behind: true, why: 'pinned SHA differs' };
  }

  const remote = lsRemoteSha(repoDir, e.ref, ctx);
  if (!remote) throw new SyncError(`ref '${e.ref}' not found on origin`);
  if (remote === local) return { behind: false, why: 'up to date' };
  return { behind: true, why: `${local.slice(0, 7)} -> ${remote.slice(0, 7)}`, from: local, to: remote };
}

// ============ COMMANDS ====================================================

/** Filter entries to the one whose resolved dir === `only` (exact match). */
function applyOnly(entries, only) {
  if (!only) return entries;
  const sel = entries.filter((e) => e.dir === only);
  if (!sel.length) {
    const near = entries.filter((e) => e.dir.toLowerCase() === only.toLowerCase()).map((e) => e.dir);
    const hint = near.length ? ` (did you mean '${near[0]}'?)` : '';
    throw new SyncError(`--only '${only}': no registry entry resolves to that dir${hint}`);
  }
  return sel;
}

/** Install/update every entry: clone-mode directly, copy-mode via the cache. */
function cmdSync(entries, ctx) {
  const cacheRoot = path.join(ctx.skillsDir, R.CACHE_DIRNAME);
  if (!ctx.dryRun) fs.mkdirSync(ctx.skillsDir, { recursive: true });
  const selected = applyOnly(entries, ctx.only);
  const repoState = new Map(); // slug -> "ok" | SyncError
  const regDirs = entries.map((x) => x.dir);
  let failures = 0;
  for (const e of selected) {
    const target = path.join(ctx.skillsDir, e.dir);
    // Read the SHA before applying so an update can be distinguished from a
    // no-op fetch -- `sync` otherwise has no idea whether anything moved.
    const before = ctx.dryRun ? '' : entrySha(e, target, cacheRoot, ctx);
    let status;
    try {
      status = e.mode === 'clone' ? cloneSync(e.repo, e.ref, target, ctx) : copySync(e, target, cacheRoot, repoState, ctx);
    } catch (err) {
      if (!(err instanceof SyncError)) throw err;
      log('error', `${e.dir}: ${err.message}`);
      failures += 1;
      continue;
    }
    if (!ctx.dryRun && status !== 'skipped') {
      const after = entrySha(e, target, cacheRoot, ctx);
      if (after && after !== before) recordUpdate(e.dir, after, regDirs);
      log('ok', `${e.dir} @ ${e.ref}${status === 'new' ? ' (new)' : ''}`);
    }
  }
  if (failures) {
    log('warn', `${failures} ${failures === 1 ? 'entry' : 'entries'} failed`);
  }
  return failures ? EXIT_FAIL : EXIT_OK;
}

/** Print each entry: dir, installed?, mode, ref, subdir, repo. */
function cmdList(entries, ctx) {
  const selected = applyOnly(entries, ctx.only);
  if (!selected.length) {
    log('info', 'registry is empty -- add one with /skill-manager:add');
    return EXIT_OK;
  }
  for (const e of selected) {
    const installed = isDir(path.join(ctx.skillsDir, e.dir)) ? 'yes' : 'no';
    log(
      'info',
      `${e.dir.padEnd(24)} installed=${installed.padEnd(3)} mode=${e.mode.padEnd(5)} ` +
        `ref=${e.ref} subdir=${e.subdir || '-'} repo=${e.repo}`
    );
  }
  return EXIT_OK;
}

/** Print summary counts, auto-update state, plus drift. */
function cmdStatus(entries, ctx) {
  const regDirs = new Set(entries.map((e) => e.dir));
  const installed = [...regDirs].filter((d) => isDir(path.join(ctx.skillsDir, d))).length;
  log('info', `skills-dir: ${ctx.skillsDir}`);
  log('info', `registry:   ${ctx.registryFile}`);
  log('info', `${entries.length} registered, ${installed} installed`);

  const s = ctx.settings;
  const auto = s.autoUpdate ? `on (mode=${s.mode}, every ${s.checkIntervalHours}h)` : 'off';
  log('info', `auto-update: ${auto}`);
  const age = stampAgeMs();
  if (age === null) {
    log('info', 'last auto check: never');
  } else {
    const hrs = age / 3_600_000;
    const due = s.checkIntervalHours - hrs;
    log(
      'info',
      `last auto check: ${fmtAge(age)} ago` +
        (s.autoUpdate ? ` (next due ${due <= 0 ? 'now' : `in ${fmtAge(due * 3_600_000)}`})` : '')
    );
  }

  // Per-skill: the SHA is read LIVE rather than from the update record, so it
  // is the truth even when a skill was moved outside this tool (a hand pull, a
  // local commit). The timestamp can only come from the record -- git cannot
  // say when *we* last moved a checkout.
  if (entries.length) {
    const cacheRoot = path.join(ctx.skillsDir, R.CACHE_DIRNAME);
    const updates = readUpdates();
    const width = Math.max(...entries.map((e) => e.dir.length));
    for (const e of entries) {
      const target = path.join(ctx.skillsDir, e.dir);
      let sha = '';
      try {
        sha = entrySha(e, target, cacheRoot, ctx);
      } catch {
        sha = '';
      }
      const rec = updates[e.dir];
      let when = 'no update recorded';
      if (rec && rec.at) {
        const age = Date.now() - Date.parse(rec.at);
        when = Number.isFinite(age) ? `updated ${fmtAge(age)} ago` : 'no update recorded';
        // The live SHA is truth; the record says where the last *applied* update
        // left it. When they disagree, something moved the checkout outside this
        // tool -- a hand pull, reset, or local commit -- and reporting the
        // timestamp alone would imply the current state came from that update.
        if (sha && rec.sha && sha.slice(0, 7) !== rec.sha) when += ' (moved since)';
      }
      // padEnd must exceed the longest value ('not installed', 13) or the
      // columns run together.
      const shaCol = (sha ? sha.slice(0, 7) : 'not installed').padEnd(15);
      log('skill', `${e.dir.padEnd(width)}  ${shaCol}${when}`);
    }
  }

  // Drift is summarized, not listed. Most unregistered folders are local-only
  // skills that will never be registered, so listing them every time buries the
  // lines above -- and a status command nobody reads is worse than a terse one.
  const drift = driftNames(ctx.skillsDir, regDirs);
  if (drift.length) {
    if (ctx.drift) {
      for (const name of drift) log('drift', `${name}  (present but not in registry)`);
    } else {
      log('info', `${drift.length} unregistered folder${drift.length === 1 ? '' : 's'} (--drift to list)`);
    }
  }
  return EXIT_OK;
}

/** Add an entry to the registry, then install just that one. */
function cmdAdd(ctx) {
  const repo = ctx.positionals[0];
  if (!repo) throw new SyncError('add: a git clone URL is required');

  // Read the existing file if there is one, so unknown keys and _comment
  // survive; otherwise start from an empty registry (no seeding, by design).
  let data;
  try {
    data = R.readRegistryFile(ctx.registryFile);
  } catch (err) {
    if (!(err instanceof SyncError)) throw err;
    if (fs.existsSync(ctx.registryFile)) throw err; // real parse error: don't clobber
    data = R.emptyRegistry();
  }

  // Build the entry with only the fields the user actually supplied, so the
  // file stays as small and readable as what they'd have written by hand.
  const entry = { repo };
  if (ctx.ref) entry.ref = ctx.ref;
  if (ctx.subdir) entry.subdir = ctx.subdir;
  if (ctx.dir) entry.dir = ctx.dir;
  if (ctx.mode) entry.mode = ctx.mode;

  // Validate the WHOLE resulting list before touching the file, so a bad entry
  // is rejected with the same message the loader would give -- and rejected
  // before anything is written.
  const candidate = [...data.skills, entry];
  const { records, errors } = R.validateAndNormalize(candidate);
  if (errors.length) {
    for (const m of errors) log('error', m);
    throw new SyncError('add: refusing to write an invalid registry');
  }
  const added = records[records.length - 1];

  data.skills = candidate;
  R.writeRegistryFile(ctx.registryFile, data);
  log('ok', `added ${added.dir} (${added.mode}, ref=${added.ref}) -> ${ctx.registryFile}`);

  if (ctx.noSync) return EXIT_OK;
  return cmdSync(records, { ...ctx, only: added.dir });
}

/** Remove an entry from the registry; optionally delete its folder. */
function cmdRemove(ctx) {
  const name = ctx.positionals[0];
  if (!name) throw new SyncError('remove: a skill name (target dir) is required');

  const data = R.readRegistryFile(ctx.registryFile);
  const { records } = R.validateAndNormalize(data.skills);
  const idx = records.findIndex((e) => e.dir === name);
  if (idx === -1) {
    const near = records.filter((e) => e.dir.toLowerCase() === name.toLowerCase()).map((e) => e.dir);
    throw new SyncError(
      `remove: no registry entry resolves to '${name}'` + (near.length ? ` (did you mean '${near[0]}'?)` : '')
    );
  }
  const target = path.join(ctx.skillsDir, name);

  if (ctx.purge) {
    // Deleting an editable clone with unpushed work is the one genuinely
    // unrecoverable thing this tool can do, so it is gated hard.
    if (isDir(target) && isGitRepo(target, ctx) && !ctx.force) {
      if (hasTrackedChanges(target, ctx)) {
        throw new SyncError(`remove --purge: '${name}' has uncommitted changes (commit them, or add --force)`);
      }
      if (hasUnpushedCommits(target, ctx)) {
        throw new SyncError(`remove --purge: '${name}' has commits not on any remote (push them, or add --force)`);
      }
    }
  }

  data.skills.splice(idx, 1);
  R.writeRegistryFile(ctx.registryFile, data);
  log('ok', `removed ${name} from ${ctx.registryFile}`);

  if (ctx.purge) {
    if (isDir(target)) {
      safeRmTree(target);
      log('ok', `deleted ${target}`);
    } else {
      log('info', `${target} was not present`);
    }
  } else if (isDir(target)) {
    log('info', `${target} left in place -- it will now show as drift (use --purge to delete)`);
  }
  return EXIT_OK;
}

/**
 * The SessionEnd hook entry point. Throttled, deadline-bounded, always exit 0.
 *
 * Silent unless something actually happened: stdout from a hook is either
 * noise or token cost, so the log file is the real channel and
 * /skill-manager:status is where the user reads history.
 */
function cmdAuto(ctx, entries) {
  const s = ctx.settings;
  if (!s.autoUpdate) return { lines: [], message: null };
  if (!entries.length) return { lines: [], message: null };

  // Throttle: one stat in the overwhelmingly common case.
  const age = stampAgeMs();
  if (age !== null && age < s.checkIntervalHours * 3_600_000) {
    return { lines: [], message: null };
  }

  if (!acquireLock()) return { lines: [], message: null };

  const changed = [];
  const skipped = [];
  const failed = [];
  let ranOut = 0;
  try {
    const cacheRoot = path.join(ctx.skillsDir, R.CACHE_DIRNAME);
    const repoState = new Map();
    const regDirs = entries.map((x) => x.dir);
    for (const e of entries) {
      if (ctx.budget.exhausted()) {
        ranOut += 1;
        continue;
      }
      const target = path.join(ctx.skillsDir, e.dir);
      try {
        const p = probeEntry(e, target, cacheRoot, ctx);
        if (!p.behind) {
          log('ok', `${e.dir}: ${p.why}`);
          continue;
        }
        if (s.mode === 'notify') {
          log('info', `${e.dir}: update available (${p.why})`);
          changed.push(`${e.dir} (available)`);
          continue;
        }
        const before = entrySha(e, target, cacheRoot, ctx);
        const status =
          e.mode === 'clone' ? cloneSync(e.repo, e.ref, target, ctx) : copySync(e, target, cacheRoot, repoState, ctx);
        if (status === 'skipped') {
          skipped.push(e.dir);
        } else {
          const after = entrySha(e, target, cacheRoot, ctx);
          if (after && after !== before) recordUpdate(e.dir, after, regDirs);
          log('ok', `${e.dir} @ ${e.ref}${status === 'new' ? ' (new)' : ''} [${p.why}]`);
          changed.push(`${e.dir}${status === 'new' ? ' (new)' : ''}`);
        }
      } catch (err) {
        if (!(err instanceof SyncError)) throw err;
        log('error', `${e.dir}: ${err.message}`);
        failed.push(e.dir);
      }
    }
    if (ranOut) log('warn', `deadline reached -- ${ranOut} entr${ranOut === 1 ? 'y' : 'ies'} not checked this pass`);
  } finally {
    // Stamp unconditionally: a dead network or an expired credential must
    // degrade to one retry per interval, not one per session.
    writeStamp();
    releaseLock();
  }

  const parts = [];
  if (changed.length) parts.push(`${s.mode === 'notify' ? 'updates for' : 'updated'} ${changed.join(', ')}`);
  if (skipped.length) parts.push(`skipped ${skipped.join(', ')} (local changes)`);
  if (failed.length) parts.push(`failed ${failed.join(', ')}`);
  let message = null;
  if (parts.length) {
    message = `[skill-manager] ${parts.join('; ')}`;
    if (changed.length && s.mode === 'apply') message += ' -- live from your next session';
  }
  return { lines: [], message };
}

/**
 * The SessionStart hook entry point: one line, or nothing.
 *
 * Local reads only -- registry plus a stat of the stamp. It must never touch
 * the network: session start is the one moment the user is actively waiting,
 * and refreshing here would buy nothing anyway (skills are already discovered
 * by the time hooks run, so an update could not apply to this session).
 *
 * Returns the line to show, or null to stay silent.
 */
function cmdSessionStatus(ctx, entries, { updatesOnly = false } = {}) {
  const s = ctx.settings;
  if (!s.sessionStatus) return null;
  if (!entries.length) return null; // nothing registered: say nothing at all

  // Updates land for the *next* session by construction, so a session boundary
  // is the only place the user naturally finds out about them. Report each one
  // exactly once: anything recorded after the last report marker is news.
  const unreported = unreportedUpdates(entries);

  // On `clear` the user is mid-work and already knows their own state, so the
  // counts and timings would be pure noise. News, or nothing.
  if (updatesOnly) {
    return unreported.length ? `[skill-manager] ${fmtUpdated(unreported)}` : null;
  }

  const installed = entries.filter((e) => isDir(path.join(ctx.skillsDir, e.dir))).length;
  const missing = entries.length - installed;
  const parts = [`${entries.length} skill${entries.length === 1 ? '' : 's'}`];
  if (missing > 0) parts.push(`${missing} not installed`);
  if (unreported.length) parts.push(fmtUpdated(unreported));

  if (!s.autoUpdate) {
    parts.push('auto-update off');
  } else {
    const age = stampAgeMs();
    if (age === null) {
      parts.push('never checked');
    } else {
      parts.push(`checked ${fmtAge(age)} ago`);
      const dueMs = s.checkIntervalHours * 3_600_000 - age;
      parts.push(dueMs <= 0 ? 'next check due' : `next in ${fmtAge(dueMs)}`);
    }
  }
  return `[skill-manager] ${parts.join(' · ')}`;
}

/** "git updated" / "git, spec updated" / "a, b, c +2 updated". */
function fmtUpdated(dirs) {
  const shown = dirs.slice(0, 3).join(', ');
  const more = dirs.length > 3 ? ` +${dirs.length - 3}` : '';
  return `${shown}${more} updated`;
}

/**
 * Registered skills whose recorded update is newer than the last report.
 *
 * No marker file yet means nothing has ever been reported, so everything
 * recorded counts as news -- correct for a first run, and it means an update
 * applied before this feature existed still gets announced once.
 */
function unreportedUpdates(entries) {
  let since = 0;
  try {
    since = fs.statSync(P.reportPath()).mtimeMs;
  } catch {
    since = 0;
  }
  const updates = readUpdates();
  return entries
    .filter((e) => {
      const rec = updates[e.dir];
      if (!rec || !rec.at) return false;
      const at = Date.parse(rec.at);
      return Number.isFinite(at) && at > since;
    })
    .map((e) => e.dir);
}

/** Mark everything currently recorded as reported. Best-effort. */
function markReported() {
  try {
    const f = P.reportPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, new Date().toISOString() + '\n', 'utf8');
  } catch {
    /* worst case an update is announced twice */
  }
}

/**
 * Launch the update pass as a detached background process.
 *
 * The pass must outlive the hook that starts it. Running it inline in a
 * SessionEnd hook failed in practice -- teardown killed it 1-2s in, before the
 * probes finished, so nothing ever updated and nothing said so. Spawned
 * detached from SessionStart it has the whole session to work in, and startup
 * pays nothing but the spawn.
 *
 * stdio is discarded because the parent exits immediately: the child's findings
 * go to the log, and the next session start reports them.
 */
function spawnDetachedAuto(ctx) {
  try {
    const args = [__filename, 'auto'];
    // Forward the overrides so a scratch/test invocation stays isolated.
    if (ctx.registry) args.push('--registry', ctx.registryFile);
    if (ctx.skillsDir) args.push('--skills-dir', ctx.skillsDir);
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false; // a failed spawn must never disturb session start
  }
}

/**
 * Parse the JSON a hook receives on stdin. Returns {} when there is none.
 *
 * Guarded on isTTY so running the subcommand by hand in a terminal does not
 * block on a read that will never see EOF.
 */
function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    const raw = fs.readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// ============ state helpers ===============================================

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function driftNames(skillsDir, registryDirs) {
  let kids = [];
  try {
    kids = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = kids.filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => d.name);
  return R.computeDrift(dirs, registryDirs);
}

/** Read the per-skill update records; {} on any problem (it is only state). */
function readUpdates() {
  try {
    const data = JSON.parse(fs.readFileSync(P.updatesPath(), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Record that `dir` moved to `sha`, pruning skills no longer registered.
 *
 * Best-effort: this is derived state, so a failure here must never turn a
 * successful update into a reported failure.
 */
function recordUpdate(dir, sha, registryDirs) {
  try {
    const f = P.updatesPath();
    const updates = R.pruneUpdates(readUpdates(), registryDirs);
    updates[dir] = { sha: sha.slice(0, 7), at: new Date().toISOString() };
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(updates, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, f);
  } catch {
    /* derived state; losing it costs a dash in `status` */
  }
}

function stampAgeMs() {
  try {
    return Date.now() - fs.statSync(P.stampPath()).mtimeMs;
  } catch {
    return null;
  }
}

function writeStamp() {
  try {
    const f = P.stampPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, new Date().toISOString() + '\n', 'utf8');
  } catch {
    /* a missing stamp only costs an extra check next time */
  }
}

function fmtAge(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = ms / 3_600_000;
  if (hrs < 48) return `${hrs.toFixed(1)}h`;
  return `${Math.round(hrs / 24)}d`;
}

/** True if a process with this pid exists (signal 0 tests without sending). */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists but belongs to someone else -- still alive.
    return e.code === 'EPERM';
  }
}

/**
 * Non-blocking cross-session mutex, with stale-lock recovery.
 *
 * Reclaims on a DEAD OWNER first, and only falls back to age. This matters
 * because `auto` runs from a SessionEnd hook, which can be killed by session
 * teardown before its `finally` releases the lock -- observed in practice, not
 * hypothetically. Waiting out an age threshold in that case would silently
 * block every subsequent run for the whole window; if teardown kills the hook
 * every time, nothing would ever update and nothing would say so.
 *
 * The age fallback stays for the case where the pid is unreadable or has been
 * recycled by an unrelated process.
 */
function acquireLock(depth = 0) {
  const f = P.lockPath();
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const fd = fs.openSync(f, 'wx'); // atomic create-or-fail
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST' || depth > 0) return false;
    try {
      const owner = Number.parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
      const dead = Number.isInteger(owner) ? !pidAlive(owner) : true;
      const old = Date.now() - fs.statSync(f).mtimeMs > LOCK_STALE_MS;
      if (dead || old) {
        fs.unlinkSync(f);
        return acquireLock(depth + 1);
      }
    } catch {
      /* raced with another holder */
    }
    return false;
  }
}

function releaseLock() {
  try {
    fs.unlinkSync(P.lockPath());
  } catch {
    /* already gone */
  }
}

function appendLog(lines) {
  if (!lines.length) return;
  try {
    const f = P.logPath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const ts = new Date().toISOString();
    fs.appendFileSync(f, lines.map((l) => `${ts} ${l}`).join('\n') + '\n', 'utf8');
  } catch {
    /* logging must never break a hook */
  }
}

// ============ CLI =========================================================

const COMMANDS = new Set(['sync', 'list', 'status', 'add', 'remove', 'auto', 'session-status']);

const USAGE = `skill-manager sync engine

  node sync.js <command> [flags]

Commands:
  sync                 clone missing entries + update all to their pinned ref
  list                 print each entry: dir, repo, ref, subdir, installed?
  status               summary, auto-update state, unregistered-folder count
  add <repo-url>       add an entry to the registry, then install it
  remove <name>        drop an entry from the registry
  auto                 throttled SessionEnd hook entry point (always exits 0)
  session-status       one-line SessionStart summary (local reads only, exits 0)

Flags:
  --skills-dir PATH    override target skills dir
  --registry PATH      override the registry file
  --only NAME          restrict sync/list to one resolved dir
  --dry-run            print planned actions; change nothing
  --force              hard-reset a clone to its ref, discarding local work
  -v, --verbose        show git command output
  --ref / --subdir / --dir / --mode    (add) entry fields
  --no-sync            (add) register only, don't install
  --purge              (remove) also delete the folder
  --drift              (status) list the unregistered folders instead of counting
`;

function parseArgs(argv) {
  const out = {
    command: null,
    positionals: [],
    skillsDir: null,
    registry: null,
    only: null,
    dryRun: false,
    force: false,
    verbose: false,
    noSync: false,
    purge: false,
    drift: false,
    ref: null,
    subdir: null,
    dir: null,
    mode: null,
  };
  const takesValue = {
    '--skills-dir': 'skillsDir',
    '--registry': 'registry',
    '--only': 'only',
    '--ref': 'ref',
    '--subdir': 'subdir',
    '--dir': 'dir',
    '--mode': 'mode',
  };
  const flags = {
    '--dry-run': 'dryRun',
    '--force': 'force',
    '--verbose': 'verbose',
    '-v': 'verbose',
    '--no-sync': 'noSync',
    '--purge': 'purge',
    '--drift': 'drift',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.prototype.hasOwnProperty.call(takesValue, a)) {
      const v = argv[++i];
      if (v === undefined) throw new SyncError(`${a} needs a value`);
      out[takesValue[a]] = v;
    } else if (Object.prototype.hasOwnProperty.call(flags, a)) {
      out[flags[a]] = true;
    } else if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      process.exit(EXIT_OK);
    } else if (a.startsWith('-')) {
      throw new SyncError(`unknown flag: ${a}`);
    } else if (!out.command && COMMANDS.has(a)) {
      out.command = a;
    } else {
      out.positionals.push(a);
    }
  }
  return out;
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    log('error', e.message);
    return EXIT_USAGE;
  }
  if (!args.command) {
    process.stdout.write(USAGE);
    return EXIT_USAGE;
  }
  const isAuto = args.command === 'auto';
  const isSessionStatus = args.command === 'session-status';
  // Both hook entry points must be silent on stdout except for a deliberate
  // systemMessage, and must exit 0 on every path.
  const isHook = isAuto || isSessionStatus;

  const budget = isAuto
    ? makeBudget({ totalMs: AUTO_DEADLINE_MS, perOpCapMs: AUTO_PER_OP_CAP_MS })
    : makeBudget();

  const registryFile = args.registry
    ? path.resolve(P.expandHome(args.registry))
    : P.registryPath();
  const skillsDir = args.skillsDir ? path.resolve(P.expandHome(args.skillsDir)) : P.skillsDir();

  const ctx = {
    ...args,
    registryFile,
    skillsDir,
    budget,
    settings: { ...R.DEFAULT_SETTINGS },
  };

  // `add` is the one command that legitimately runs with no registry file.
  let data = null;
  let entries = [];
  let regErrors = [];
  try {
    data = R.readRegistryFile(registryFile);
    ctx.settings = R.resolveSettings(data);
    const v = R.validateAndNormalize(data.skills);
    entries = v.records;
    regErrors = v.errors;
  } catch (err) {
    if (!(err instanceof SyncError)) throw err;
    if (isHook) return EXIT_OK; // no registry / broken registry: silent no-op
    if (args.command !== 'add') {
      log('error', err.message);
      if (!fs.existsSync(registryFile)) {
        log('info', 'no registry yet -- create one with: /skill-manager:add <repo-url>');
      }
      return EXIT_USAGE;
    }
  }

  if (isSessionStatus) {
    // Deliberately before requireGit(): the status half never shells out to
    // git, so a missing git must not turn a session start into an error.
    let line = null;
    let src = '';
    try {
      src = String(readHookInput().source || '');
      // Full banner on a genuinely new or resumed session (and when run by hand,
      // so it stays testable). On `clear` the user is mid-work: news only, and
      // silence when there is none. `compact` gets nothing at all -- it can fire
      // repeatedly inside one long task.
      const full = !src || src === 'startup' || src === 'resume';
      if (full || src === 'clear') {
        line = cmdSessionStatus(ctx, entries, { updatesOnly: !full });
        // Only mark when something was actually shown, or a `clear` with no news
        // would silently consume updates a later startup should have announced.
        if (line) markReported();
      }
    } catch {
      line = null; // never disturb a session start
    }
    if (line) process.stdout.write(JSON.stringify({ systemMessage: line }) + '\n');

    // Then hand the update pass to a detached child and get out of the way.
    // Unlike the banner this runs for EVERY source: `clear` and `compact` are
    // free extra chances to catch up, and the throttle makes them nearly free.
    try {
      const s = ctx.settings;
      const age = stampAgeMs();
      const due = age === null || age >= s.checkIntervalHours * 3_600_000;
      if (s.autoUpdate && entries.length && due) spawnDetachedAuto(ctx);
    } catch {
      /* startup must succeed regardless */
    }
    return EXIT_OK;
  }

  requireGit();

  if (isAuto) {
    // Route all logging into the file; stdout carries only a systemMessage.
    SINK = [];
    let message = null;
    try {
      const res = cmdAuto(ctx, entries);
      message = res.message;
    } catch (err) {
      SINK.push(`[error] auto: ${err && err.message ? err.message : String(err)}`);
    }
    appendLog(SINK);
    SINK = null;
    if (message) process.stdout.write(JSON.stringify({ systemMessage: message }) + '\n');
    return EXIT_OK; // never disturb a session
  }

  // Per-entry problems are reported but do not abort valid siblings.
  for (const m of regErrors) log('error', m);

  let rc;
  try {
    switch (args.command) {
      case 'sync':
        rc = cmdSync(entries, ctx);
        break;
      case 'list':
        rc = cmdList(entries, ctx);
        break;
      case 'status':
        rc = cmdStatus(entries, ctx);
        break;
      case 'add':
        rc = cmdAdd(ctx);
        break;
      case 'remove':
        rc = cmdRemove(ctx);
        break;
      default:
        return EXIT_USAGE;
    }
  } catch (err) {
    if (!(err instanceof SyncError)) throw err;
    log('error', err.message);
    return EXIT_USAGE;
  }
  // A malformed entry makes the run nonzero even if valid entries succeeded.
  if (regErrors.length && rc === EXIT_OK) return EXIT_FAIL;
  return rc;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    log('error', e && e.stack ? e.stack : String(e));
    process.exit(EXIT_FAIL);
  }
}

module.exports = { main, makeBudget, probeEntry, lsRemoteSha, safeRmTree };
