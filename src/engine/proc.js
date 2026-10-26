'use strict';
const { spawn } = require('child_process');

// Runs a program without a shell (arguments are never re-parsed, so odd file names are safe).
// Resolves when the process ends; if `signal` aborts, the process is killed and `aborted` is true.
// `binary: true` returns stdout as one Buffer; `maxBytes` stops runaway output.
const MAX_STDERR = 256 * 1024;

function run(exe, args, { signal, binary = false, maxBytes = 64 * 1024 * 1024, stdinNull = true } = {}) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve({ code: null, stdout: binary ? Buffer.alloc(0) : '', stderr: '', aborted: true, truncated: false });
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, shell: false, stdio: [stdinNull ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: -1, stdout: binary ? Buffer.alloc(0) : '', stderr: String(err.message), aborted: false, truncated: false });
    }
    const out = [];
    const errChunks = [];
    let errSize = 0;
    let size = 0;
    let truncated = false;
    let aborted = false;
    const kill = () => { try { child.kill(); } catch { /* already gone */ } };
    const onAbort = () => { aborted = true; kill(); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d) => {
      size += d.length;
      if (size > maxBytes) { truncated = true; kill(); return; }
      out.push(d);
    });
    // keep the most recent stderr (the end holds the final error or the astats summary), bounded in size
    child.stderr.on('data', (d) => {
      errChunks.push(d);
      errSize += d.length;
      while (errSize > MAX_STDERR && errChunks.length > 1) errSize -= errChunks.shift().length;
    });
    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ code: -1, stdout: binary ? Buffer.alloc(0) : '', stderr: String(err.message), aborted, truncated });
    });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      const buf = Buffer.concat(out);
      resolve({
        code,
        stdout: binary ? buf : buf.toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        aborted,
        truncated
      });
    });
  });
}

module.exports = { run };
