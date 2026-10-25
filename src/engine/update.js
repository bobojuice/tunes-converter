'use strict';
// Manual "is there a newer version?" check. Only runs when the user asks; reads the public GitHub releases API.
const https = require('https');
const http = require('http');

const LATEST_URL = 'https://api.github.com/repos/bobojuice/tunes-converter/releases/latest';
const REPO_URL = 'https://github.com/bobojuice/tunes-converter';
const MAX_BYTES = 1_000_000;

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

// Always settles: on success, HTTP error, network error, aborted or oversized response, and timeout.
// (`url` may be http only so tests can use a local server; the app always uses the https default.)
function fetchLatest(current, { url = LATEST_URL, timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { if (req) req.destroy(); } catch { /* already closed */ }
      resolve(result);
    };
    const fail = (error) => finish({ ok: false, error });
    timer = setTimeout(() => fail('The update check timed out.'), timeoutMs);

    try {
      req = (url.startsWith('http:') ? http : https).get(url, { headers: { 'User-Agent': 'TunesConverter', Accept: 'application/vnd.github+json' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); fail(`Update check failed (HTTP ${res.statusCode}).`); return; }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          body += d;
          if (body.length > MAX_BYTES) fail('The update information was too large.');
        });
        res.on('end', () => {
          try { finish(describe(JSON.parse(body), current)); } catch { fail('Could not read the update information.'); }
        });
        res.on('aborted', () => fail('The connection was interrupted.'));
        res.on('error', () => fail('The connection was interrupted.'));
        res.on('close', () => fail('The connection closed early.'));
      });
      req.on('error', () => fail('Could not reach GitHub. Check your internet connection.'));
    } catch {
      fail('Could not reach GitHub. Check your internet connection.');
    }
  });
}

module.exports = { fetchLatest, compareVersions, parseVersion, describe };
