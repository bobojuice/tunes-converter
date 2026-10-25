'use strict';

const RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i;

// "A;B" (how ffprobe reports repeated ARTIST tags) -> "A, B"
function joinArtists(value) {
  if (!value) return '';
  return String(value).split(';').map((s) => s.trim()).filter(Boolean).join(', ');
}

// Characters Windows does not allow become "-"; control characters go; spaces collapse; no trailing dots/spaces.
function safeName(s) {
  return String(s)
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

function trimToBytes(s, maxBytes) {
  while (Buffer.byteLength(s, 'utf8') > maxBytes) s = Array.from(s).slice(0, -1).join('');
  return s.replace(/[. ]+$/, '');
}

// Final file-name stem (no extension) for a track, or '' when nothing usable is left.
function buildName({ artist, title, fallbackBase, outDir }) {
  const base = artist && title ? `${artist} - ${title}` : fallbackBase;
  let name = safeName(base);
  if (!name) return '';
  if (RESERVED.test(name)) name = `_${name}`;
  const maxLen = Math.max(20, 240 - outDir.length - 30);
  if (name.length > maxLen) name = name.slice(0, maxLen).replace(/[. ]+$/, '');
  // Most Mac/Linux file systems allow 255 bytes per name; leave room for ".mp3" and the temporary suffix.
  return trimToBytes(name, 200);
}

// Hands out unique names for one batch: "Name", "Name (2)", ... Independent of any quality verdict.
class NameAllocator {
  constructor() { this.used = new Set(); }
  // Marks a name as taken without handing it out (e.g. a mirrored sub-folder with the same name).
  reserve(name) { this.used.add(name.toLowerCase()); }
  allocate(name) {
    let candidate = name;
    let n = 1;
    while (this.used.has(candidate.toLowerCase())) { n += 1; candidate = `${name} (${n})`; }
    this.used.add(candidate.toLowerCase());
    return { name: candidate, duplicate: n > 1 };
  }
}

// Case-insensitive tag lookup across several tag objects (format tags, stream tags).
function pickTag(tagSets, key) {
  for (const tags of tagSets) {
    if (!tags) continue;
    for (const k of Object.keys(tags)) {
      if (k.toLowerCase() === key && tags[k]) return String(tags[k]);
    }
  }
  return '';
}

module.exports = { joinArtists, safeName, buildName, NameAllocator, pickTag };
