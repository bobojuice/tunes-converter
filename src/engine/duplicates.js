'use strict';
// Same-song detection within one run: normalized artist + title, and (when both lengths are known) similar length.
const LENGTH_TOLERANCE = 3; // seconds

function normalize(s) {
  return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// '' when artist or title is missing (then nothing can be said about it).
function songKey(artist, title) {
  const a = normalize(artist);
  const t = normalize(title);
  return a && t ? `${a}\u0000${t}` : '';
}

class SeenSongs {
  constructor() { this.map = new Map(); }

  // Name of the output file of the first matching song, or null.
  find(key, length) {
    const e = this.findEntry(key, length);
    return e ? e.name : null;
  }

  // Same, with the folder the output file went to ({ name, dir }), so the window can play it.
  findEntry(key, length) {
    for (const s of this.map.get(key) || []) {
      if (!length || !s.length || Math.abs(s.length - length) <= LENGTH_TOLERANCE) return s;
    }
    return null;
  }

  add(key, length, name, dir = '') {
    if (!this.map.has(key)) this.map.set(key, []);
    this.map.get(key).push({ length, name, dir });
  }
}

module.exports = { songKey, SeenSongs, LENGTH_TOLERANCE };
