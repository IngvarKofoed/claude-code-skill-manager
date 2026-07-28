'use strict';
// Tests for the pure helpers in registry.js.
//
// Each case corresponds to a guard that exists for a specific reason — a
// Windows filesystem rule, a case-insensitive filesystem, a path-traversal
// escape. So a case whose name reads like trivia ('com10 is not reserved') is
// load-bearing: it pins a rule that is invisible on the platform most of this
// gets developed on. Do not delete one without establishing why its guard no
// longer matters.
//
//   node --test scripts/*.test.js

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const R = require('./registry');

test('normalizeSubdir canonicalizes to slash-free posix form', () => {
  assert.equal(R.normalizeSubdir(undefined), '');
  assert.equal(R.normalizeSubdir(''), '');
  assert.equal(R.normalizeSubdir('skills/foo'), 'skills/foo');
  assert.equal(R.normalizeSubdir('/skills/foo/'), 'skills/foo');
  assert.equal(R.normalizeSubdir('skills\\foo'), 'skills/foo', 'windows separators normalize');
  assert.equal(R.normalizeSubdir('./skills//foo'), 'skills/foo', 'empty and . segments drop');
});

test('normalizeSubdir rejects escapes', () => {
  assert.throws(() => R.normalizeSubdir('../evil'), R.SyncError);
  assert.throws(() => R.normalizeSubdir('skills/../../evil'), R.SyncError);
});

test('repoNameFromUrl handles https and scp-style URLs', () => {
  assert.equal(R.repoNameFromUrl('https://github.com/owner/repo.git'), 'repo');
  assert.equal(R.repoNameFromUrl('https://github.com/owner/repo'), 'repo');
  assert.equal(R.repoNameFromUrl('git@github.com:owner/repo.git'), 'repo');
  assert.equal(R.repoNameFromUrl('https://github.com/owner/repo/'), 'repo', 'trailing slash');
  assert.equal(R.repoNameFromUrl(''), 'repo', 'degenerate input gets a fallback');
});

test('normalizeRepoUrl makes ssh/https variants comparable for identity checks', () => {
  assert.equal(
    R.normalizeRepoUrl('https://github.com/owner/repo.git'),
    R.normalizeRepoUrl('https://github.com/owner/repo/')
  );
});

test('resolveMode defaults by shape and rejects clone+subdir', () => {
  assert.equal(R.resolveMode(null, '', 'e'), 'clone', 'whole repo defaults to an editable clone');
  assert.equal(R.resolveMode(null, 'skills/foo', 'e'), 'copy', 'a subdir defaults to copy');
  assert.equal(R.resolveMode('COPY', '', 'e'), 'copy', 'case-insensitive');
  // A subdirectory is not a standalone pushable repo, so the combination is
  // meaningless rather than merely unusual.
  assert.throws(() => R.resolveMode('clone', 'skills/foo', 'e'), R.SyncError);
  assert.throws(() => R.resolveMode('symlink', '', 'e'), R.SyncError);
});

test('resolveDir precedence: explicit > subdir tail > repo name', () => {
  assert.equal(R.resolveDir('git@github.com:o/claude-code-spec.git', '', null), 'claude-code-spec');
  assert.equal(R.resolveDir('git@github.com:o/mono.git', 'skills/foo', null), 'foo');
  assert.equal(R.resolveDir('git@github.com:o/mono.git', 'skills/foo', 'bar'), 'bar');
});

test('validateDirName rejects traversal, hidden, and Windows-illegal names', () => {
  assert.doesNotThrow(() => R.validateDirName('spec', 'e'));
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', '.hidden']) {
    assert.throws(() => R.validateDirName(bad, 'e'), R.SyncError, `should reject ${JSON.stringify(bad)}`);
  }
  // Legal on POSIX, rejected by Windows -- rejected everywhere so a name
  // resolves to the same folder on every platform.
  for (const bad of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
    assert.throws(() => R.validateDirName(bad, 'e'), R.SyncError, `should reject ${bad}`);
  }
  // Windows silently strips these, which would desync installed/drift checks.
  assert.throws(() => R.validateDirName('trailing.', 'e'), R.SyncError);
  assert.throws(() => R.validateDirName('trailing ', 'e'), R.SyncError);
  // Reserved device names, including with an extension.
  for (const bad of ['con', 'NUL', 'com1', 'lpt9', 'aux.txt']) {
    assert.throws(() => R.validateDirName(bad, 'e'), R.SyncError, `should reject ${bad}`);
  }
  assert.doesNotThrow(() => R.validateDirName('com10', 'e'), 'com10 is not reserved');
});

test('repoSlug is stable, filesystem-safe, and url-normalizing', () => {
  const a = R.repoSlug('https://github.com/owner/repo.git');
  const b = R.repoSlug('https://github.com/owner/repo');
  assert.equal(a, b, '.git and trailing slash must not fork the cache');
  assert.match(a, /^repo-[0-9a-f]{12}$/);
  assert.notEqual(a, R.repoSlug('https://github.com/other/repo.git'), 'different owners differ');
});

test('isCommitSha only matches a full 40-hex sha', () => {
  assert.ok(R.isCommitSha('a'.repeat(40)));
  assert.ok(R.isCommitSha('A'.repeat(40)), 'case-insensitive');
  assert.ok(!R.isCommitSha('a'.repeat(39)));
  assert.ok(!R.isCommitSha('main'));
  assert.ok(!R.isCommitSha('v1.2.3'));
});

test('validateAndNormalize skips bad entries but keeps valid siblings', () => {
  const { records, errors } = R.validateAndNormalize([
    { repo: 'git@github.com:o/good.git' },
    { ref: 'main' }, // missing repo
    'not-an-object',
    { repo: 'git@github.com:o/other.git', dir: 'a/b' }, // illegal dir
  ]);
  assert.equal(records.length, 1, 'the one valid entry survives');
  assert.equal(records[0].dir, 'good');
  assert.equal(errors.length, 3);
  assert.match(errors[0], /missing required "repo"/);
});

test('validateAndNormalize applies defaults', () => {
  const { records } = R.validateAndNormalize([{ repo: 'git@github.com:o/x.git' }]);
  assert.deepEqual(records[0], {
    repo: 'git@github.com:o/x.git',
    ref: 'main',
    subdir: '',
    dir: 'x',
    mode: 'clone',
  });
});

test('validateAndNormalize detects dir collisions case-insensitively', () => {
  // macOS and Windows filesystems are case-insensitive, so Spec and spec would
  // fight over one folder.
  const { records, errors } = R.validateAndNormalize([
    { repo: 'git@github.com:o/a.git', dir: 'spec' },
    { repo: 'git@github.com:o/b.git', dir: 'Spec' },
  ]);
  assert.equal(records.length, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /collides with/);
});

test('one repo may appear under several subdirs', () => {
  const { records, errors } = R.validateAndNormalize([
    { repo: 'git@github.com:o/mono.git', subdir: 'skills/a' },
    { repo: 'git@github.com:o/mono.git', subdir: 'skills/b' },
  ]);
  assert.equal(errors.length, 0);
  assert.deepEqual(records.map((r) => r.dir), ['a', 'b']);
  assert.ok(records.every((r) => r.mode === 'copy'));
});

test('resolveSettings layers the file over defaults and ignores junk', () => {
  assert.deepEqual(R.resolveSettings({}), R.DEFAULT_SETTINGS);
  assert.deepEqual(R.resolveSettings(null), R.DEFAULT_SETTINGS);
  assert.equal(R.resolveSettings({ autoUpdate: false }).autoUpdate, false);
  assert.equal(R.resolveSettings({ checkIntervalHours: 0 }).checkIntervalHours, 0);
  assert.equal(R.resolveSettings({ mode: 'NOTIFY' }).mode, 'notify');
  // Junk must fall back rather than disable auto-update by accident.
  assert.equal(R.resolveSettings({ mode: 'nonsense' }).mode, R.DEFAULT_SETTINGS.mode);
  assert.equal(R.resolveSettings({ checkIntervalHours: -5 }).checkIntervalHours, R.DEFAULT_SETTINGS.checkIntervalHours);
  assert.equal(R.resolveSettings({ autoUpdate: 'yes' }).autoUpdate, true, 'non-boolean ignored');
  // sessionStatus and autoUpdate are independent: silencing the session-start
  // line must not stop updates, and vice versa.
  assert.equal(R.resolveSettings({ sessionStatus: false }).sessionStatus, false);
  assert.equal(R.resolveSettings({ sessionStatus: false }).autoUpdate, true);
  assert.equal(R.resolveSettings({ autoUpdate: false }).sessionStatus, true);
  assert.equal(R.resolveSettings({ sessionStatus: 'off' }).sessionStatus, true, 'non-boolean ignored');
});

test('computeDrift ignores dotfolders and matches case-insensitively', () => {
  const drift = R.computeDrift(
    ['spec', 'Git', 'stray', '.skill-manager-cache', '.DS_Store_dir'],
    new Set(['spec', 'git'])
  );
  assert.deepEqual(drift, ['stray']);
});

test('pruneUpdates keeps only registered skills', () => {
  const updates = {
    spec: { sha: 'aaaaaaa', at: '2026-07-01T00:00:00Z' },
    gone: { sha: 'bbbbbbb', at: '2026-07-01T00:00:00Z' },
  };
  const kept = R.pruneUpdates(updates, ['spec', 'git']);
  assert.deepEqual(Object.keys(kept), ['spec'], 'a removed skill drops out');
  assert.equal(kept.spec.sha, 'aaaaaaa', 'surviving records are untouched');
  // Case-sensitive on purpose: these keys are the resolved dir names the
  // registry already de-duplicated case-insensitively, so an exact match is
  // correct and avoids two records collapsing into one.
  assert.deepEqual(R.pruneUpdates({ Spec: {} }, ['spec']), {});
  assert.deepEqual(R.pruneUpdates(null, ['spec']), {}, 'missing state is not an error');
  assert.deepEqual(R.pruneUpdates({ a: {} }, []), {}, 'empty registry prunes everything');
});

test('readRegistryFile rejects a misshaped top level', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-test-'));
  const f = path.join(dir, 'skills.json');

  fs.writeFileSync(f, '{ not json');
  assert.throws(() => R.readRegistryFile(f), /invalid JSON/);

  fs.writeFileSync(f, '[]');
  assert.throws(() => R.readRegistryFile(f), /expected top-level object/);

  fs.writeFileSync(f, '{"skills": {}}');
  assert.throws(() => R.readRegistryFile(f), /expected top-level object/);

  assert.throws(() => R.readRegistryFile(path.join(dir, 'nope.json')), /registry not found/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeRegistryFile round-trips and preserves unknown keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skm-test-'));
  const f = path.join(dir, 'nested', 'skills.json');

  // _comment is the schema note users hand-edit; it must survive an add.
  R.writeRegistryFile(f, { _comment: 'keep me', autoUpdate: false, skills: [{ repo: 'x' }] });
  const back = R.readRegistryFile(f);
  assert.equal(back._comment, 'keep me');
  assert.equal(back.autoUpdate, false);
  assert.equal(back.skills.length, 1);

  fs.rmSync(dir, { recursive: true, force: true });
});
