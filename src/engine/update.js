'use strict';
// Manual "is there a newer version?" check. Only runs when the user asks; reads the public GitHub releases API.
const https = require('https');

const LATEST_URL = 'https://api.github.com/repos/bobojuice/tunes-converter/releases/latest';
const REPO_URL = 'https://github.com/bobojuice/tunes-converter';

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// > 0 when a is newer than b, < 0 when older, 0 when equal or either is unreadable.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function describe(release, current) {
  const tag = release && typeof release.tag_name === 'string' ? release.tag_name : '';
  if (!parseVersion(tag)) return { ok: false, error: 'Could not read the latest version.' };
  const url = typeof release.html_url === 'string' && release.html_url.startsWith(REPO_URL)
    ? release.html_url : `${REPO_URL}/releases`;
  return { ok: true, latest: tag.replace(/^v/, ''), newer: compareVersions(tag, current) > 0, url };
}

function fetchLatest(current, { url = LATEST_URL, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'User-Agent': 'TunesConverter', Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, error: `Update check failed (HTTP ${res.statusCode}).` }); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      res.on('end', () => { try { resolve(describe(JSON.parse(body), current)); } catch { resolve({ ok: false, error: 'Could not read the update information.' }); } });
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on('error', () => resolve({ ok: false, error: 'Could not reach GitHub. Check your internet connection.' }));
  });
}

module.exports = { fetchLatest, compareVersions, parseVersion, describe };
