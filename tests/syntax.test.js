'use strict';
// A syntax slip in the window script would leave a blank, dead window; catch it before packaging.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

for (const file of ['main.js', 'preload.js', 'src/renderer/renderer.js', 'src/engine/playback.js']) {
  test(`syntax: ${file} parses`, () => {
    const r = spawnSync(process.execPath, ['--check', path.join(__dirname, '..', file)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });
}
