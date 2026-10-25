'use strict';
// Manual smoke test: `electron tests/gui-smoke.js` with TC_DATA_DIR pointing at a folder whose settings.json holds
// the test In/Out folders. Starts the real window, clicks START, waits for the summary, prints the log, saves a
// screenshot to TC_SHOT (default: gui-smoke.png) and exits non-zero if nothing converted.
process.env.TC_NO_AUTOSTART = '1';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { start } = require('../main.js');

const shot = process.env.TC_SHOT || path.join(process.cwd(), 'gui-smoke.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A closed output pipe (e.g. when piped into head) must not pop up an Electron error dialog.
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
const say = (text) => { try { process.stdout.write(`\n`); } catch { /* ignore */ } };

start().then(async (win) => {
  try {
    await new Promise((r) => win.webContents.once('did-finish-load', r));
    await sleep(800);
    const js = (code) => win.webContents.executeJavaScript(code);
    if (process.env.TC_SHOT_IDLE) {
      fs.writeFileSync(process.env.TC_SHOT_IDLE, (await win.webContents.capturePage()).toPNG());
    }
    if (process.env.TC_CLICK_CHIPS) {
      await js("document.getElementById('chipMin').click()");
      await sleep(300);
    }
    await js("document.getElementById('start').click()");
    let status = '';
    for (let i = 0; i < 240; i++) {
      await sleep(500);
      status = await js("document.getElementById('status').textContent");
      if (/^Done:|^ERROR/.test(status)) break;
    }
    await sleep(500);
    if (process.env.TC_SHOT_NEUTRAL) {
      await js(`(() => { document.getElementById('inDir').value = 'C:\\\\Music\\\\Incoming'; document.getElementById('outDir').value = 'C:\\\\Music\\\\MP3'; document.getElementById('dataDir').textContent = ''; })()`);
      await sleep(600);
    }
    fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
    const log = await js("document.getElementById('log').innerText");
    say(`STATUS: ${status}\n${log}`);
    const settings = await js('window.tc.getState().then((s) => JSON.stringify(s.settings))');
    say(`SETTINGS: ${settings}`);
    app.exit(/^Done:/.test(status) ? 0 : 1);
  } catch (err) {
    say(String(err));
    app.exit(2);
  }
});
