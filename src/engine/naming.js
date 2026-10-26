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
function buildName({ artist, title, fallbackBase, outDir, base: given }) {
  const base = given || (artist && title ? `${artist} - ${title}` : fallbackBase);
  let name = safeName(base);
  if (!name) return '';
  const maxLen = Math.max(20, 240 - outDir.length - 30);
  if (name.length > maxLen) name = name.slice(0, maxLen).replace(/[. ]+$/, '');
  // Most Mac/Linux file systems allow 255 bytes per name; leave room for ".mp3" and the temporary suffix.
  name = trimToBytes(name, 200);
  // Checked last: trimming can itself leave a bare reserved name such as "CON".
  if (name && RESERVED.test(name)) name = `_${name}`;
  return name;
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

const DEFAULT_TEMPLATE = '{artist} - {title}';
const PLACEHOLDERS = ['artist', 'title', 'album', 'albumartist', 'track', 'year'];

// A template is plain text plus known {placeholders}; it needs at least one placeholder.
function validTemplate(t) {
  if (typeof t !== 'string' || !t.trim() || t.length > 120) return false;
  const found = [...t.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]);
  if (!found.length || !found.every((k) => PLACEHOLDERS.includes(k))) return false;
  return !/[{}]/.test(t.replace(/\{[^{}]*\}/g, ''));
}

// Fills a template from tag values. Returns '' when any placeholder it uses has no value, so the caller can fall
// back to the original file name instead of producing a half-empty name.
function applyTemplate(template, fields) {
  let missing = false;
  const out = template.replace(/\{([^{}]*)\}/g, (_, k) => {
    const v = String(fields[k] || '').trim();
    if (!v) missing = true;
    return v;
  });
  return missing ? '' : out;
}

// '3/12' -> '03', '7' -> '07', anything else -> ''
function trackNumber(v) {
  const m = /^\s*(\d+)/.exec(String(v || ''));
  return m ? m[1].padStart(2, '0') : '';
}

function yearOf(v) {
  const m = /^\s*(\d{4})/.exec(String(v || ''));
  return m ? m[1] : '';
}

module.exports = { DEFAULT_TEMPLATE, PLACEHOLDERS, validTemplate, applyTemplate, trackNumber, yearOf, joinArtists, safeName, buildName, NameAllocator, pickTag };
