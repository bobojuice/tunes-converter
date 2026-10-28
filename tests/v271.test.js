'use strict';
// Open folder mode, BPM read from existing tags, and the PlayNext setting.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openMode } = require('../src/engine/guards');
const { bpmFromTags, readBpm } = require('../src/engine/playback');
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

test('bpmFromTags: accepts 40..250 from bpm / tbpm / tempo, any case', () => {
  assert.equal(bpmFromTags({ BPM: '128' }), 128);
  assert.equal(bpmFromTags({ bpm: '127.6' }), 127.6);
  assert.equal(bpmFromTags({ TBPM: '174.0' }), 174);
  assert.equal(bpmFromTags({ tempo: 90 }), 90);
  assert.equal(bpmFromTags({ bpm: '127.64' }), 127.6);
});

test('bpmFromTags: rejects zero, text, out of range and missing', () => {
  assert.equal(bpmFromTags({ bpm: '0' }), 0);
  assert.equal(bpmFromTags({ bpm: 'abc' }), 0);
  assert.equal(bpmFromTags({ bpm: '300' }), 0);
  assert.equal(bpmFromTags({ bpm: '39.9' }), 0);
  assert.equal(bpmFromTags({ bpm: '64' }), 64); // no doubling or guessing
  assert.equal(bpmFromTags({ title: 'x' }), 0);
  assert.equal(bpmFromTags({}), 0);
  assert.equal(bpmFromTags(null), 0);
  assert.equal(bpmFromTags(undefined), 0);
});

test('bpmFromTags: reads format and stream tags as ffprobe prints them', () => {
  assert.equal(bpmFromTags({ format: { tags: { TBPM: '128' } } }), 128);
  assert.equal(bpmFromTags({ streams: [{ tags: { title: 'a' } }, { tags: { BPM: '140' } }] }), 140);
  assert.equal(bpmFromTags({ format: { tags: { bpm: 'x' } }, streams: [{ tags: { bpm: '100' } }] }), 100);
});

test('readBpm: a missing ffprobe or file gives 0 and never throws', async () => {
  assert.equal(await readBpm('', 'x.mp3'), 0);
  assert.equal(await readBpm('no-such-ffprobe-binary', 'x.mp3'), 0);
});

test('PlayNext: default true, rejects non-boolean, not a preset key', () => {
  assert.equal(settings.defaults('/d').PlayNext, true);
  const base = settings.defaults('/d');
  assert.equal(settings.merge(base, { PlayNext: false }).PlayNext, false);
  assert.equal(settings.merge(base, { PlayNext: 'no' }).PlayNext, true);
  assert.equal(settings.merge(base, { PlayNext: 0 }).PlayNext, true);
  assert.ok(!settings.PRESET_KEYS.includes('PlayNext'));
});
