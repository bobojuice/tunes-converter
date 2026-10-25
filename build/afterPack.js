'use strict';
// Keeps only the English Chromium locale on Windows and Linux (saves about 40 MB; the app UI is English anyway).
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName;
  if (platform !== 'win32' && platform !== 'linux') return;
  const dir = path.join(context.appOutDir, 'locales');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.pak') && file !== 'en-US.pak') fs.rmSync(path.join(dir, file));
  }
};
