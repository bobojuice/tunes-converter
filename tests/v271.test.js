'use strict';
// Open folder mode and the PlayNext setting.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openMode } = require('../src/engine/guards');
const settings = require('../src/engine/settings');

test('openMode: only a .app on macOS is revealed, everything else is opened', () => {
  assert.equal(openMode('/Applications/Foo.app', 'darwin'), 'reveal');
  assert.equal(openMode('/Applications/FOO.APP', 'darwin'), 'reveal');
  assert.equal(openMode('/Applications/Foo.app/', 'darwin'), 'reveal');
  assert.equal(openMode('/Users/me/Music', 'darwin'), 'open');
  assert.equal(openMode('/Users/me/app', 'darwin'), 'open');
  assert.equal(openMode('C:\\Music\\Foo.app', 'win32'), 'open');
  assert.equal(openMode('/home/me/Foo.app', 'linux'), 'open');
});

test('PlayNext: default true, rejects non-boolean, not a preset key', () => {
  assert.equal(settings.defaults('/d').PlayNext, true);
  const base = settings.defaults('/d');
  assert.equal(settings.merge(base, { PlayNext: false }).PlayNext, false);
  assert.equal(settings.merge(base, { PlayNext: 'no' }).PlayNext, true);
  assert.equal(settings.merge(base, { PlayNext: 0 }).PlayNext, true);
  assert.ok(!settings.PRESET_KEYS.includes('PlayNext'));
});
