import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appPids, withMacAppClosed } from '../src/mac-session.ts';
const app = '/Applications/T3 Code (Nightly).app';
const output = `  21 ${app}/Contents/MacOS/T3 Code (Nightly)\n 22 ${app}/Contents/Frameworks/Helper.app/Contents/MacOS/Helper\n 23 /Applications/Other.app/Contents/MacOS/Other\n`;
const progress = { stage() {}, finish() {} };

test('detects the main app process without confusing Electron helpers or other apps', () => {
  assert.deepEqual(appPids(output, app), [21]);
});

test('declining the close prompt never quits or patches T3', async () => {
  const calls = [];
  await assert.rejects(withMacAppClosed(app, () => { throw Error('must not patch'); }, {
    hostPlatform: 'darwin', progress, confirm: async () => false,
    run: async (binary) => { calls.push(binary); return { stdout: output }; },
  }), /cancelled/);
  assert.deepEqual(calls, ['/bin/ps']);
});

test('approval gracefully closes T3 before patching and reopens the same app', async () => {
  const events = []; let opened = true;
  const result = await withMacAppClosed(app, async stage => { events.push('patch'); stage('Signing'); return { installedApp: app }; }, {
    hostPlatform: 'darwin', progress,
    confirm: async message => { assert.match(message, /Close it and install Mods/); events.push('approve'); return true; },
    run: async (binary, args) => {
      if (binary === '/bin/ps') return { stdout: opened ? output : '' };
      if (binary === '/usr/bin/osascript') { opened = false; events.push('quit'); assert.match(args[1], /T3 Code \(Nightly\)\.app/); }
      if (binary === '/usr/bin/open') { events.push('reopen'); assert.deepEqual(args, [app]); }
      return { stdout: '' };
    },
  });
  assert.equal(result.installedApp, app);
  assert.deepEqual(events, ['approve', 'quit', 'patch', 'reopen']);
});

test('a failed graceful close never patches or force-kills the app', async () => {
  const calls = [];
  await assert.rejects(withMacAppClosed(app, () => { throw Error('must not patch'); }, {
    hostPlatform: 'darwin', progress, confirm: async () => true, sleep: async () => {},
    run: async binary => { calls.push(binary); return { stdout: output }; },
  }), /still open/);
  assert.equal(calls.includes('/usr/bin/osascript'), true);
  assert.equal(calls.every(binary => ['/bin/ps', '/usr/bin/osascript'].includes(binary)), true);
});
