import { open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { platform } from 'node:os';
import path from 'node:path';
const execute = promisify(execFile);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export function appPids(processList, appPath) {
  const prefix = `${path.resolve(appPath)}/Contents/MacOS/`;
  return processList.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    return match && match[2].startsWith(prefix) && !match[2].slice(prefix.length).includes('/') ? [Number(match[1])] : [];
  });
}

export function createProgress(output = process.stderr) {
  const animated = Boolean(output.isTTY) && process.env.TERM !== 'dumb';
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let timer;
  let label;
  let index = 0;
  const clear = () => { clearInterval(timer); timer = undefined; if (animated && label) output.write('\r\x1b[2K'); };
  return {
    stage(message) {
      if (message === label) return;
      if (label) { clear(); output.write(`  ✓ ${label}\n`); }
      label = message;
      if (!animated) { output.write(`  → ${message}\n`); return; }
      const draw = () => output.write(`\r\x1b[2K  ${frames[index++ % frames.length]} ${label}`);
      draw(); timer = setInterval(draw, 90); timer.unref();
    },
    finish(success = true) {
      clear();
      if (label && animated) output.write(`  ${success ? '✓' : '×'} ${label}\n`);
      label = undefined;
    },
  };
}

export async function confirmInTerminal(message) {
  let terminal;
  try { terminal = await open('/dev/tty', 'r+'); }
  catch { throw new Error('T3 is open. Close it and rerun the installer in a terminal; no app files have been changed.'); }
  try {
    await terminal.write(message);
    const byte = Buffer.alloc(1);
    let answer = '';
    while (answer.length < 128) {
      const { bytesRead } = await terminal.read(byte, 0, 1, null);
      if (!bytesRead || byte[0] === 10 || byte[0] === 13) break;
      answer += byte.toString();
    }
    return /^(y|yes)$/i.test(answer.trim());
  } finally { await terminal.close(); }
}

export async function withMacAppClosed(appPath, work, options = {}) {
  if ((options.hostPlatform ?? platform()) !== 'darwin') throw new Error('macOS installation must run on macOS.');
  const run = options.run ?? execute;
  const confirm = options.confirm ?? confirmInTerminal;
  const sleep = options.sleep ?? pause;
  const progress = options.progress ?? createProgress();
  const running = async () => appPids((await run('/bin/ps', ['-axo', 'pid=,comm='])).stdout, appPath).length > 0;
  const wasOpen = await running();
  let closed = false;
  let successful = false;
  if (wasOpen) {
    const name = path.basename(appPath, '.app');
    if (!await confirm(`\n${name} is open. Close it and install Mods? [y/N] `)) throw new Error('Installation cancelled. T3 and your app files were left unchanged.');
    progress.stage('Closing T3 normally');
    const quoted = appPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    try {
      await run('/usr/bin/osascript', ['-e', `tell application "${quoted}" to quit`]);
      for (let attempt = 0; attempt < 120; attempt++) {
        if (!await running()) { closed = true; break; }
        await sleep(250);
      }
      if (!closed) throw new Error('T3 is still open. Finish any save or confirmation dialog, close T3, then rerun the installer.');
    } catch (error) { progress.finish(false); throw error; }
  }
  try {
    progress.stage('Checking the installed T3 app');
    const result = await work(message => progress.stage(message));
    successful = true;
    progress.finish();
    return result;
  } finally {
    if (!successful) progress.finish(false);
    if (closed) {
      // Restore the user's previously open app, including after a rolled-back failure.
      try {
        await run('/usr/bin/open', [appPath]);
        process.stderr.write('\nReopened your existing T3 app.\n');
      } catch (error) { process.stderr.write(`\nReopen T3 using its normal icon: ${error.message}\n`); }
    }
  }
}
