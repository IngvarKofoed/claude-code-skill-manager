'use strict';
// Registry parsing, validation, and the pure naming/slug helpers.
//
// Everything in here is either pure or does one trivial file read/write, so it
// is all directly unit-testable — see registry.test.js. Keep it that way: the
// git-touching code belongs in sync.js, and this is where the naming and
// validation rules can be proved cheaply.
//
// Validation policy (deliberate): a structurally-invalid entry is
// COLLECTED as an error and skipped, it does not abort the run. Valid sibling
// entries still install. The caller reports every error and forces a nonzero
// exit code.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIRNAME = '.skill-manager-cache';
const DEFAULT_REF = 'main';

// Defaults for the settings that live alongside `skills` in the registry file.
const DEFAULT_SETTINGS = {
  autoUpdate: true,
  checkIntervalHours: 6,
  mode: 'apply', // 'apply' | 'notify'
  sessionStatus: true, // one-line summary at session start
};

// Windows reserved device names (case-insensitive), illegal as folder names.
const WIN_RESERVED = new Set(['con', 'prn', 'aux', 'nul']);
for (const p of ['com', 'lpt']) {
  for (let n = 1; n < 10; n++) WIN_RESERVED.add(`${p}${n}`);
}

/** Recoverable per-repo / per-entry failure. */
class SyncError extends Error {}

// ============ dir / subdir / repo-name / slug helpers =====================

/** Canonicalize a subdir to slash-free posix form; reject escapes ('..'). */
function normalizeSubdir(raw) {
  if (!raw) return '';
  const s = String(raw).replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new SyncError(`subdir escapes repo: ${raw}`);
  }
  return parts.join('/');
}

/** Extract the bare repo name from an https or scp-style git URL. */
function repoNameFromUrl(url) {
  const u = String(url).trim().replace(/\/+$/, '');
  // Split on both / and : so git@host:owner/repo.git works too.
  const segments = u.split(/[/:]/);
  let last = segments[segments.length - 1] || '';
  if (last.endsWith('.git')) last = last.slice(0, -4);
  return last || 'repo';
}

/**
 * Resolve entry mode: explicit if given, else 'copy' for a subdir, 'clone'.
 *
 * 'clone' installs the whole repo as an editable working checkout, so it is
 * incompatible with 'subdir' (a subdirectory is not a standalone repo).
 */
function resolveMode(explicit, subdir, label) {
  if (explicit === null || explicit === undefined) return subdir ? 'copy' : 'clone';
  const m = String(explicit).trim().toLowerCase();
  if (m !== 'clone' && m !== 'copy') {
    throw new SyncError(`${label}: mode must be "clone" or "copy", got ${JSON.stringify(explicit)}`);
  }
  if (m === 'clone' && subdir) {
    throw new SyncError(`${label}: mode "clone" cannot be combined with "subdir"`);
  }
  return m;
}

/** Resolve the target folder name (explicit > subdir tail > repo name). */
function resolveDir(repo, subdir, explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  if (subdir) return subdir.split('/').pop();
  return repoNameFromUrl(repo);
}

/** Reject dir names that would traverse paths, hide, or hit Windows rules. */
function validateDirName(name, label) {
  if (name === '' || name === '.' || name === '..' ||
      name.includes('/') || name.includes('\\') || name.startsWith('.')) {
    throw new SyncError(`${label}: illegal target dir name '${name}'`);
  }
  // Characters legal on POSIX but rejected by Windows -- reject on all
  // platforms so a name resolves to the same folder everywhere.
  if (/[<>:"|?*]/.test(name)) {
    throw new SyncError(`${label}: illegal character in target dir name '${name}'`);
  }
  // Windows silently strips a trailing '.' or space, which would desync the
  // installed/drift check from the folder actually created on disk.
  const lastChar = name[name.length - 1];
  if (lastChar === '.' || lastChar === ' ') {
    throw new SyncError(`${label}: target dir name may not end with '.' or space: '${name}'`);
  }
  const stem = name.split('.')[0].toLowerCase();
  if (WIN_RESERVED.has(stem)) {
    throw new SyncError(`${label}: reserved (Windows) target dir name '${name}'`);
  }
}

/** Normalize a URL for de-dup: strip trailing slash and a single '.git'. */
function normalizeRepoUrl(url) {
  let u = String(url).trim().replace(/\/+$/, '');
  if (u.endsWith('.git')) u = u.slice(0, -4);
  return u;
}

/** Filesystem-safe cache id: short readable prefix + stable short hash. */
function repoSlug(url) {
  const h = crypto.createHash('sha256')
    .update(normalizeRepoUrl(url), 'utf8')
    .digest('hex')
    .slice(0, 12);
  const safe = (repoNameFromUrl(url).replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40)) || 'repo';
  return `${safe}-${h}`;
}

/** True when `ref` is a full 40-hex commit SHA (immutable — no probe needed). */
function isCommitSha(ref) {
  return /^[0-9a-f]{40}$/i.test(String(ref).trim());
}

// ============ registry load + validation ==================================

/** Read and shape-check the registry file, returning the whole object. */
function readRegistryFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new SyncError(`registry not found: ${file}`);
    throw new SyncError(`cannot read ${file}: ${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new SyncError(`invalid JSON in ${file}: ${e.message}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.skills)) {
    throw new SyncError(`${file}: expected top-level object with a "skills" array`);
  }
  return data;
}

/** Resolve effective settings by layering the file over DEFAULT_SETTINGS. */
function resolveSettings(data) {
  const out = { ...DEFAULT_SETTINGS };
  if (!data || typeof data !== 'object') return out;
  if (typeof data.autoUpdate === 'boolean') out.autoUpdate = data.autoUpdate;
  if (typeof data.sessionStatus === 'boolean') out.sessionStatus = data.sessionStatus;
  const hrs = Number(data.checkIntervalHours);
  if (Number.isFinite(hrs) && hrs >= 0) out.checkIntervalHours = hrs;
  const mode = String(data.mode || '').trim().toLowerCase();
  if (mode === 'apply' || mode === 'notify') out.mode = mode;
  return out;
}

/**
 * Validate raw entries; return { records, errors }.
 *
 * An invalid entry lands in `errors` and is skipped; it does NOT abort the
 * run, so valid siblings still install.
 */
function validateAndNormalize(entries) {
  const seenDirs = new Map(); // casefolded dir -> label of first claimant
  const records = [];
  const errors = [];
  entries.forEach((e, i) => {
    let label = `entry #${i}`;
    if (e && typeof e === 'object' && e.dir) label += ` (dir=${e.dir})`;
    try {
      if (e === null || typeof e !== 'object' || Array.isArray(e)) {
        throw new SyncError(`${label}: not an object`);
      }
      const repo = e.repo;
      if (!repo || typeof repo !== 'string' || !repo.trim()) {
        throw new SyncError(`${label}: missing required "repo"`);
      }
      let ref = e.ref === null || e.ref === undefined ? DEFAULT_REF : e.ref;
      ref = (typeof ref === 'string' ? ref.trim() : '') || DEFAULT_REF;
      const subdir = normalizeSubdir(e.subdir);
      const mode = resolveMode(e.mode, subdir, label);
      const dirn = resolveDir(repo, subdir, e.dir);
      validateDirName(dirn, label);
      const key = dirn.toLowerCase(); // case-insensitive (Windows/macOS)
      if (seenDirs.has(key)) {
        throw new SyncError(`${label}: target dir '${dirn}' collides with ${seenDirs.get(key)}`);
      }
      seenDirs.set(key, label);
      records.push({ repo: repo.trim(), ref, subdir, dir: dirn, mode });
    } catch (err) {
      if (!(err instanceof SyncError)) throw err;
      errors.push(err.message);
    }
  });
  return { records, errors };
}

// ============ registry writing ============================================

/**
 * Write the registry atomically, preserving unknown top-level keys.
 *
 * Hand-edits (including the "_comment" schema note) survive an `add`, because
 * the caller passes the object it read and only `skills` is replaced.
 */
function writeRegistryFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file); // atomic within one filesystem
}

/** An empty registry, used when `add` has to create the file from nothing. */
function emptyRegistry() {
  return { skills: [] };
}

/**
 * Return sorted dir names present but not registered.
 *
 * Pure: the caller supplies the directory listing. Dotfolders (including the
 * cache) are ignored. Comparison is case-insensitive so a folder is never
 * counted as both installed and drift on a case-insensitive filesystem.
 */
function computeDrift(childDirNames, registryDirs) {
  const regCi = new Set([...registryDirs].map((d) => d.toLowerCase()));
  return childDirNames
    .filter((n) => !n.startsWith('.'))
    .filter((n) => !regCi.has(n.toLowerCase()))
    .sort();
}

module.exports = {
  CACHE_DIRNAME,
  DEFAULT_REF,
  DEFAULT_SETTINGS,
  SyncError,
  normalizeSubdir,
  repoNameFromUrl,
  resolveMode,
  resolveDir,
  validateDirName,
  normalizeRepoUrl,
  repoSlug,
  isCommitSha,
  readRegistryFile,
  resolveSettings,
  validateAndNormalize,
  writeRegistryFile,
  emptyRegistry,
  computeDrift,
};
