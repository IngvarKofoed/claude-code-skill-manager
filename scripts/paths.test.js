'use strict';
// Tests for paths.js: where the registry and skills resolve to.
//
// The registry must sit inside Claude's config dir, beside the skills, so a
// backup of that dir carries it along -- a registry left in ~/.config was lost
// on exactly such a restore. These pin that it stays there and follows
// $CLAUDE_CONFIG_DIR together with the skills.
//
//   node --test scripts/*.test.js

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const P = require('./paths');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('registry and skills default to ~/.claude, side by side', () => {
  withEnv({ CLAUDE_CONFIG_DIR: undefined, CLAUDE_SKILLS_DIR: undefined }, () => {
    const claude = path.join(os.homedir(), '.claude');
    assert.equal(P.registryPath(), path.join(claude, 'skill-manager', 'skills.json'));
    assert.equal(P.skillsDir(), path.join(claude, 'skills'));
  });
});

test('$CLAUDE_CONFIG_DIR moves the registry and the skills together', () => {
  const root = path.join(os.tmpdir(), 'skm-claude');
  withEnv({ CLAUDE_CONFIG_DIR: `  ${root}  `, CLAUDE_SKILLS_DIR: undefined }, () => {
    assert.equal(P.registryPath(), path.join(root, 'skill-manager', 'skills.json'));
    assert.equal(P.skillsDir(), path.join(root, 'skills'));
  });
  withEnv({ CLAUDE_CONFIG_DIR: '   ', CLAUDE_SKILLS_DIR: undefined }, () => {
    assert.equal(P.claudeDir(), path.join(os.homedir(), '.claude'), 'blank is unset');
  });
});

test('$CLAUDE_SKILLS_DIR moves only the skills, never the registry', () => {
  const skills = path.join(os.tmpdir(), 'skm-skills');
  withEnv({ CLAUDE_CONFIG_DIR: undefined, CLAUDE_SKILLS_DIR: skills }, () => {
    assert.equal(P.skillsDir(), skills);
    assert.equal(P.registryPath(), path.join(os.homedir(), '.claude', 'skill-manager', 'skills.json'));
  });
});

test('the legacy registry path is the old XDG one, distinct from the new one', () => {
  withEnv({ XDG_CONFIG_HOME: path.join(os.tmpdir(), 'xdg'), CLAUDE_CONFIG_DIR: undefined }, () => {
    if (process.platform !== 'win32') {
      assert.equal(
        P.legacyRegistryPath(),
        path.join(os.tmpdir(), 'xdg', 'claude-code-skill-manager', 'skills.json'),
      );
    }
    assert.notEqual(P.legacyRegistryPath(), P.registryPath());
  });
});
