'use strict';
const { cleanPresets, MAX_PRESETS } = require('./settings');

const MAX_FILE_BYTES = 256 * 1024;
const KIND = 'presets';

// The text of an export file for a list of presets.
function serialize(presets) {
  return `${JSON.stringify({ app: 'Tunes Converter', kind: KIND, version: 1, presets: cleanPresets(presets || []) }, null, 2)}\n`;
}

// Text of an import file -> a cleaned list of presets. Throws an Error with a plain message when it is not a preset file.
function parse(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error('That file is too large to be a preset file.');
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch { throw new Error('That file is not a preset file.'); }
  if (!data || typeof data !== 'object' || data.app !== 'Tunes Converter' || data.kind !== KIND || !Array.isArray(data.presets)) {
    throw new Error('That file is not a Tunes Converter preset file.');
  }
  return cleanPresets(data.presets);
}

// Adds `incoming` to `existing`: name clashes (ignoring case) are skipped, the total never passes MAX_PRESETS.
function merge(existing, incoming) {
  const list = existing.slice();
  const names = new Set(list.map((p) => p.name.toLowerCase()));
  let added = 0;
  let skipped = 0;
  for (const p of incoming) {
    if (list.length >= MAX_PRESETS || names.has(p.name.toLowerCase())) { skipped += 1; continue; }
    names.add(p.name.toLowerCase());
    list.push(p);
    added += 1;
  }
  return { presets: list, added, skipped };
}

module.exports = { serialize, parse, merge, MAX_FILE_BYTES };
