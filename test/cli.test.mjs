import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-cli-'));
process.env.BRIDGERATOR_HOME = path.join(tmp, 'home');
const cwd = process.cwd();
const { hiddenVbs, stopPs, webviewStopPs, isOurDir, trayConfirm } = await import('../src/cli.mjs'); // no command: prints usage only
process.chdir(cwd);
const { checkRelay, cleanEnv, replacedDelay } = await import('../src/bridge.mjs');

test('autostart script: backoff up to 30 min, quits when node/package missing, no WSH error boxes', () => {
  const v = hiddenVbs('C:\\Users\\Иван\\node.exe', 'C:\\p\\cli.mjs');
  assert.match(v, /^On Error Resume Next\r\n/);
  assert.match(v, /node = "C:\\Users\\Иван\\node\.exe"/);
  assert.match(v, /If Not fso\.FileExists\(node\) Or Not fso\.FileExists\(app\) Then WScript\.Quit 3/);
  assert.match(v, /If wait > 1800 Then wait = 1800/);
  assert.match(v, /If rc = 0 Then WScript\.Quit 0/);
});

test('process matcher: package dir with trailing backslash, same session, self excluded', () => {
  const s = stopPs('C:\\npm\\node_modules\\bridgerator', 'C:\\A\\Bridgerator\\run-hidden.vbs', 42);
  assert.ok(s.includes("$pkg = 'c:\\npm\\node_modules\\bridgerator\\'"));
  assert.ok(s.includes('$_.SessionId -eq $me') && s.includes('$_.ProcessId -ne 42'));
});

// V-8: the old window's msedgewebview2 processes (our user data folder) and their children are stopped;
// another app's WebView2 is left alone. Fake "msedgewebview2.exe" = a copy of node.exe.
test('V-8: stop ends msedgewebview2 with our user data folder and its children, not others', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const { spawn, execFileSync } = await import('node:child_process');
  const bin = path.join(tmp, 'wv', 'msedgewebview2.exe');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.copyFileSync(process.execPath, bin);
  const js = path.join(tmp, 'wv', 'idle.cjs');
  // The "browser" starts one child without the flag (like a renderer), then idles.
  fs.writeFileSync(js, `if (process.argv.includes('--parent')) require('child_process').spawn(process.execPath, [__filename, '--type=renderer'], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
  const ours = path.join(tmp, 'Local', 'Bridgerator', 'webview');
  const a = spawn(bin, [js, '--parent', `--user-data-dir=${ours}\\EBWebView`], { stdio: 'ignore', windowsHide: true });
  const b = spawn(bin, [js, `--user-data-dir=${path.join(tmp, 'Other', 'EBWebView')}`], { stdio: 'ignore', windowsHide: true });
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const kids = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${a.pid} AND Name='msedgewebview2.exe'" | ForEach-Object { $_.ProcessId }) -join ','`], { encoding: 'utf8', windowsHide: true }).trim().split(',').filter(Boolean).map(Number);
  let child = [];
  try {
    for (let i = 0; i < 50 && !child.length; i++) { await new Promise((r) => setTimeout(r, 200)); child = kids(); }
    assert.equal(child.length, 1, 'the fake browser started its child');
    execFileSync('powershell.exe', ['-NoProfile', '-Command', webviewStopPs(ours)], { windowsHide: true, timeout: 60000 });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(alive(a.pid), false, 'our WebView2 browser process stopped');
    assert.equal(alive(child[0]), false, 'its child stopped');
    assert.equal(alive(b.pid), true, 'another app\'s WebView2 left alone');
  } finally { for (const p of [a.pid, b.pid, ...child]) try { process.kill(p); } catch { /* gone */ } }
  assert.ok(stopPs('C:\\pkg', 'C:\\v.vbs', 1, ours).includes(webviewStopPs(ours)), 'bridgerator.cmd stop runs it');
});

test('uninstall deletes only a folder that is clearly ours', () => {
  const roots = [path.join(tmp, 'Roaming')];
  const ours = path.join(roots[0], 'Bridgerator');
  fs.mkdirSync(ours, { recursive: true });
  assert.equal(isOurDir(ours, roots), true);
  assert.equal(isOurDir(path.join(tmp, 'Docs'), roots), false);
  assert.equal(isOurDir(path.join(tmp, 'x', 'Bridgerator'), roots), false);
  const custom = path.join(tmp, 'custom');
  fs.mkdirSync(custom);
  fs.writeFileSync(path.join(custom, 'config.json'), JSON.stringify({ relay: 'wss://r', token: 't' }));
  assert.equal(isOurDir(custom, roots), true);
});

test('relay must be wss://; TLS checks never off; 4004 backoff 1 → 30 min', () => {
  assert.equal(checkRelay('wss://mcp.bridgerator.recondeck.com/link'), 'wss://mcp.bridgerator.recondeck.com/link');
  for (const u of ['ws://x/link', 'https://x', '', undefined]) assert.throws(() => checkRelay(u), /wss:/);
  assert.equal(cleanEnv({ NODE_TLS_REJECT_UNAUTHORIZED: '0', A: '1' }).NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.deepEqual([1, 2, 3, 10].map(replacedDelay), [60000, 120000, 240000, 1800000]);
});

test('status line in plain words; device-key revoke URL from the relay', async () => {
  const { statusLine, revokeUrl } = await import('../src/cli.mjs');
  assert.equal(statusLine(true, ['x [bridgerator] linked to relay', 'y [bridgerator] registered as "HOME-PC"']), 'Bridgerator is running — online as HOME-PC');
  assert.match(statusLine(false, ['y [bridgerator] registered as "HOME-PC"']), /not running/);
  assert.match(statusLine(true, ['registered as "A"', '[bridgerator] disconnected (close 1006); reconnecting in 5s']), /not connected yet/);
  assert.match(statusLine(false, ['[bridgerator] This computer is no longer linked to your Bridgerator account.']), /key rejected/);
  assert.equal(revokeUrl('wss://mcp.bridgerator.recondeck.com/link'), 'https://mcp.bridgerator.recondeck.com/device/revoke');
});

test('call limit: 8 at once, the 9th waits for a free slot, gives up (busy) after the wait', async () => {
  const { createLimiter, MAX_CALLS } = await import('../src/bridge.mjs');
  assert.equal(MAX_CALLS, 8);
  const l = createLimiter(2, 50);
  assert.equal(await l.slot(), true); assert.equal(await l.slot(), true);
  const third = l.slot();
  l.release();
  assert.equal(await third, true, 'got the freed slot');
  assert.equal(await l.slot(), false, 'busy after waiting');
});

test('uninstall removes only Bridgerator files; anything else in the folder stays', async () => {
  const { removeOurFiles } = await import('../src/cli.mjs');
  const d = path.join(tmp, 'Bridgerator-u');
  fs.mkdirSync(path.join(d, 'dc'), { recursive: true });
  for (const f of ['config.json', 'confirm.ini', 'queue.json', 'bridge.log', 'config.json.123.tmp', 'dc/config.json']) fs.writeFileSync(path.join(d, f), 'x');
  fs.writeFileSync(path.join(d, 'my-notes.txt'), 'keep me');
  removeOurFiles(d);
  assert.deepEqual(fs.readdirSync(d), ['my-notes.txt']);
  fs.rmSync(path.join(d, 'my-notes.txt'));
  fs.mkdirSync(path.join(d, 'dc')); removeOurFiles(d);
  assert.equal(fs.existsSync(d), false, 'empty folder removed');
});

test('uninstall finds npm.cmd by absolute path only: next to node.exe, then the PATH without the current / home folder', async () => {
  const { findNpm } = await import('../src/cli.mjs');
  const node = 'C:\\Program Files\\nodejs\\node.exe', home = 'C:\\Users\\Иван Петров', cwd = 'D:\\Проект';
  const has = (...files) => (f) => files.map((x) => x.toLowerCase()).includes(f.toLowerCase());
  assert.equal(findNpm({ execPath: node, pathEnv: '', cwd, home, exists: has('C:\\Program Files\\nodejs\\npm.cmd') }), 'C:\\Program Files\\nodejs\\npm.cmd');
  const planted = has(`${cwd}\\npm.cmd`, `${home}\\npm.cmd`, '.\\npm.cmd', 'C:\\Tools\\npm.cmd');
  assert.equal(findNpm({ execPath: node, pathEnv: `.;${cwd};"${home}\\";relative\\bin;C:\\Tools`, cwd, home, exists: planted }), 'C:\\Tools\\npm.cmd', 'a planted npm.cmd in the current / home folder or a relative PATH entry is never used');
  assert.equal(findNpm({ execPath: node, pathEnv: `${cwd};${home}`, cwd, home, exists: planted }), null, 'nothing safe found → null (the caller explains)');
});

test('B1-35: TLS checks can not be switched off with a lower-case variable name either', () => {
  const e = cleanEnv({ node_tls_reject_unauthorized: '0', Node_Tls_Reject_Unauthorized: '0', A: '1' });
  assert.deepEqual(Object.keys(e), ['A']);
});

test('VR-5: tray confirm toggle — only a failed write is "not written" + confirm_locked; a gate error is logged as itself', () => {
  const logs = [], notices = [], told = [];
  const ok = (on) => trayConfirm(on, { ini: 'x.ini', log: (l) => logs.push(l), notice: (n) => notices.push(n.kind), set: () => {}, dc: { acceptConfirm: (c) => { told.push(c); throw new Error('gate boom'); } } });
  assert.equal(ok(true), true);
  assert.deepEqual(told, [{ enabled: true }]); assert.deepEqual(notices, []);
  assert.match(logs[0], /tray confirm toggle: gate boom/); assert.doesNotMatch(logs[0], /not written/);
  logs.length = 0; told.length = 0;
  const r = trayConfirm(false, { ini: 'x.ini', log: (l) => logs.push(l), notice: (n) => notices.push(n.kind), set: () => { const e = new Error('locked'); e.code = 'EBUSY'; throw e; }, dc: { acceptConfirm: (c) => told.push(c) } });
  assert.equal(r, false); assert.deepEqual(told, [], 'the gate is not told');
  assert.deepEqual(notices, ['confirm_locked']); assert.match(logs[0], /confirm.ini not written \(EBUSY\)/);
});
