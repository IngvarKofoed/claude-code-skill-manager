'use strict';
// Path resolution for skill-manager.
//
// The registry lives in Claude Code's own config dir, beside the skills it
// lists: whoever backs up or syncs ~/.claude carries the list along with the
// clones. It used to sit in the XDG config dir, which a ~/.claude backup
// silently left behind -- the clones restored, the registry did not.
//
// It MUST stay outside the plugin payload: a plugin installed from a
// marketplace lives in a version-pinned cache dir that Claude Code replaces
// wholesale on update, which would destroy a registry shipped inside it.
// ${CLAUDE_PLUGIN_DATA} is no better: it is keyed by install source and
// deleted on uninstall.
//
// State stays XDG and machine-local on purpose (mirroring
// claude-code-notifier/scripts/paths.js): a lock pid, a throttle stamp and an
// "already announced" marker restored onto another machine would be wrong.

const path = require('path');
const os = require('os');

const APP_NAME = 'claude-code-skill-manager';

/** Claude Code's config dir: $CLAUDE_CONFIG_DIR, else ~/.claude. */
function claudeDir() {
  const raw = process.env.CLAUDE_CONFIG_DIR;
  if (raw && raw.trim()) return path.resolve(expandHome(raw.trim()));
  return path.join(os.homedir(), '.claude');
}

function stateDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, APP_NAME);
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, APP_NAME);
}

/** The skill registry. Resolution order is applied by the caller. */
function registryPath() {
  return path.join(claudeDir(), 'skill-manager', 'skills.json');
}

/**
 * Where the registry lived up to 0.3.0. Read only to migrate it to
 * registryPath(); nothing writes here any more.
 */
function legacyRegistryPath() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, APP_NAME, 'skills.json');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, APP_NAME, 'skills.json');
}

/** Throttle stamp: mtime is the last time `auto` completed a pass. */
function stampPath() {
  return path.join(stateDir(), 'last-check');
}

/** Cross-session mutex so two sessions ending together don't both sync. */
function lockPath() {
  return path.join(stateDir(), 'skill-manager.lock');
}

/** Append-only log. The real output channel for unattended runs. */
function logPath() {
  return path.join(stateDir(), 'skill-manager.log');
}

/**
 * Per-skill record of the last applied update: { dir: { sha, at } }.
 *
 * State, not config: it is derived from what the engine did and is safe to
 * delete. "When did this skill last change" cannot be recovered after the fact
 * from git alone, which is why it has to be written down as it happens.
 */
function updatesPath() {
  return path.join(stateDir(), 'updates.json');
}

/**
 * Marker for "everything recorded before this was already shown to the user".
 *
 * Its mtime is the cutoff: an update whose timestamp is newer has not been
 * reported at a session start yet. Kept separate from updates.json so the
 * per-skill records stay a clean map that can be pruned without special cases.
 */
function reportPath() {
  return path.join(stateDir(), 'last-report');
}

/**
 * Target skills directory: $CLAUDE_SKILLS_DIR, else <claudeDir>/skills --
 * which is where Claude Code discovers personal skills when $CLAUDE_CONFIG_DIR
 * relocates its config. A --skills-dir flag overrides this at the call site.
 */
function skillsDir() {
  const raw = process.env.CLAUDE_SKILLS_DIR;
  if (raw && raw.trim()) return path.resolve(expandHome(raw.trim()));
  return path.join(claudeDir(), 'skills');
}

/** Expand a leading ~ so hand-edited config values behave as users expect. */
function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

module.exports = {
  APP_NAME,
  claudeDir,
  stateDir,
  registryPath,
  legacyRegistryPath,
  stampPath,
  lockPath,
  logPath,
  updatesPath,
  reportPath,
  skillsDir,
  expandHome,
};
