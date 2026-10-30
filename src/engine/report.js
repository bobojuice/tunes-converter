'use strict';
const fs = require('fs');
const path = require('path');

// One CSV cell. Quoted when needed; a cell that starts with = + - @ (or a tab/CR) gets an apostrophe in front so a
// spreadsheet never runs it as a formula.
function cell(value) {
  let t = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// A run with a second copy adds a last column 'output' ('main' or 'second'); other reports keep the original columns.
const COLUMNS = ['status', 'file', 'notes', 'health', 'peak_db', 'duplicate'];

// `results` are the batch 'result' events. Returns CSV text (CRLF rows, UTF-8 BOM so Excel reads accents correctly).
function buildReport(results, { startedAt, summary, format } = {}) {
  const withOutput = (results || []).some((r) => r.second);
  const lines = [(withOutput ? [...COLUMNS, 'output'] : COLUMNS).join(',')];
  for (const r of results || []) {
    const note = r.note || '';
    const peak = typeof r.peak === 'number' && Number.isFinite(r.peak) ? r.peak.toFixed(1) : ''; // a real number, safe as is
    lines.push([
      cell(r.status),
      cell(r.name),
      cell(note),
      r.health ? 'yes' : 'no',
      peak,
      r.duplicate || /duplicate/i.test(note) ? 'yes' : 'no',
      ...(withOutput ? [r.second ? 'second' : 'main'] : [])
    ].join(','));
  }
  lines.push('');
  const when = startedAt instanceof Date ? startedAt.toISOString() : startedAt || '';
  if (when) lines.push(['# started', when].map(cell).join(','));
  if (format) lines.push(['# format', format].map(cell).join(','));
  if (summary) lines.push(['# summary', summary].map(cell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

const pad = (n) => String(n).padStart(2, '0');

// Writes `Tunes Converter report YYYY-MM-DD HHMMSS.csv` into `dir`; never overwrites (adds -2, -3 ...). Returns the full path.
function writeReport(dir, text, now = new Date()) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  for (let n = 1; n < 1000; n++) {
    const file = path.join(dir, `Tunes Converter report ${stamp}${n > 1 ? `-${n}` : ''}.csv`);
    try {
      fs.writeFileSync(file, text, { flag: 'wx' });
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not find a free report file name.');
}

module.exports = { buildReport, writeReport, cell };
