// The safety features on the bridge's real call path (REAL bundled engine): short tool descriptions,
// snapshots + bridgerator_undo, Recycle Bin for plain delete commands (the bin itself is a fake here —
// the real one is checked on the lab VMs), the mass-action fuse, access presets, Protect sensitive
// folders, every setting through bridgerator_settings, and config.json changed from outside.
// LOGIC: critical-logic/bridge.md. No windows: questions and notifications are fakes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const realExecFile = cp.execFile;
cp.execFile = (file, args, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (/powershell\.exe$/i.test(String(file))) { setImmediate(() => cb?.(null, 'deny', '')); return { on() {}, kill() {} }; }
  return realExecFile(file, args, opts, cb);
};
syncBuiltinESMExports();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-safety-'));
const fakeHome = path.join(root, 'Иван Петров');
const APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
Object.assign(process.env, { USERPROFILE: fakeHome, APPDATA, LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') });
const DIR = path.join(APPDATA, 'Bridgerator');
const work = path.join(root, 'Рабочая папка'), ro = path.join(root, 'Архив');
for (const d of [DIR, work, ro, path.join(fakeHome, '.ssh')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_rsa'), 'KEY');

const { startDesktopCommander } = await import('../src/bridge.mjs');
const { ensureIni } = await import('../src/confirm.mjs');
const CONFIG = path.join(DIR, 'config.json'), INI = path.join(DIR, 'confirm.ini');
// What the CLI passes: protectSensitive explicit (off by default since 21.10).
const base = { askSettings: true, relay: 'wss://relay.invalid/link', token: 't', allowedDirectories: [work, ro, fakeHome], deniedDirectories: [], readOnlyDirectories: [], telemetryEnabled: false, localHistory: false, setupDone: true, protectSensitive: false };
fs.writeFileSync(CONFIG, JSON.stringify(base, null, 2));
ensureIni(INI);

const asked = [];
let answer = 'deny';
const binned = [];
let bin = 'recycled';
let dc;
const text = (r) => (r.content || []).map((c) => c.text).join('\n');
const W = (...x) => path.join(work, ...x);
const settings = (s) => dc.call('bridgerator_settings', { action: 'set', settings: s });
const state = async () => (await dc.rpc('getState')).settings;
// A Deny of a settings change starts a 10-minute cool-down (confirm.mjs): the tests below answer
// Allow and count the questions; the Deny cases are the last test.
const askedNow = () => asked.length;
const until = async (f, ms = 6000) => { const t0 = Date.now(); while (!(await f())) { if (Date.now() - t0 > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 100)); } };

before(async () => {
  dc = await startDesktopCommander({ ...base, dcConfigDir: path.join(DIR, 'dc'), configDir: DIR, confirmIni: INI, configFile: CONFIG, snapshotsDir: path.join(DIR, 'snapshots') }, () => {}, {
    ask: async (q) => {
      asked.push(q);
      const a = typeof answer === 'function' ? answer(q) : answer;
      // A long proposal is reviewed in the window: the person answers there (setup.decide).
      if (/review them in the Bridgerator window/.test(q.text || '')) { setTimeout(async () => { const p = (await dc.rpc('getState')).pendingSetup; if (p) await dc.rpc('setup.decide', { id: p.id, apply: (await a) === 'allow' }); }, 10); return 'closed'; }
      return a;
    },
    // The Recycle Bin: a fake that removes the item (as the shell would) or reports "no bin".
    recycle: async (paths) => paths.map((p) => { binned.push(p); if (bin === 'recycled') fs.rmSync(p, { recursive: true, force: true }); return { p, r: bin }; }),
    drives: () => ['C:\\'],
  });
});
after(async () => { await dc?.close(); });

test('tool descriptions are short and plain; the engine\'s annotations stay; Undo is listed', () => {
  const byName = new Map(dc.tools.map((t) => [t.name, t]));
  for (const t of dc.tools) {
    assert.doesNotMatch(t.description || '', /\b(IMPORTANT|ALWAYS|NEVER|MUST|MANDATORY|ONLY|CRITICAL)\b/, t.name);
    assert.doesNotMatch(t.description || '', /Desktop ?Commander/i, t.name);
    assert.ok((t.description || '').length <= 700, `${t.name}: ${t.description.length} chars`);
  }
  assert.ok(dc.tools.reduce((n, t) => n + (t.description || '').length, 0) < 12000, 'the whole list stays small');
  assert.equal(byName.get('read_file').annotations.readOnlyHint, true);
  assert.equal(byName.get('write_file').annotations.destructiveHint, true);
  assert.equal(byName.get('queue_list').annotations.readOnlyHint, true);
  assert.equal(byName.get('bridgerator_undo').annotations.destructiveHint, true);
  for (const n of ['start_process', 'interact_with_process', 'kill_process']) assert.ok(byName.has(n), n);
});

test('a write is undone with bridgerator_undo; the result and Recent say it can be undone', async () => {
  fs.writeFileSync(W('план.txt'), 'исходный текст');
  const r = await dc.call('write_file', { path: W('план.txt'), content: 'текст от ИИ', mode: 'rewrite' });
  assert.equal(r.isError, undefined, text(r));
  assert.match(text(r), /can be undone — bridgerator_undo id \w+/);
  assert.equal(r.undoId, undefined, 'internal id not sent to the relay');
  assert.equal(fs.readFileSync(W('план.txt'), 'utf8'), 'текст от ИИ');
  assert.ok(dc.recent.list()[0].undo, 'Recent links the action');
  const list = JSON.parse(text(await dc.call('bridgerator_undo', { action: 'list' })));
  assert.equal(list.changes[0].tool, 'write_file');
  const u = JSON.parse(text(await dc.call('bridgerator_undo', {})));
  assert.deepEqual(u.restored, [W('план.txt')]);
  assert.equal(fs.readFileSync(W('план.txt'), 'utf8'), 'исходный текст');
  assert.match(text(await dc.call('bridgerator_undo', {})), /Nothing to undo/);
});

test('a plain delete command goes to the Recycle Bin (the command is not run) and can be undone', async () => {
  fs.writeFileSync(W('отчёт 1.docx'), 'отчёт');
  binned.length = 0; bin = 'recycled';
  const r = await dc.call('start_process', { command: `Remove-Item -Force "${W('отчёт 1.docx')}"`, timeout_ms: 5000 });
  assert.deepEqual(binned, [W('отчёт 1.docx')]);
  assert.match(text(r), /moved 1 item to the Recycle Bin/);
  assert.equal(fs.existsSync(W('отчёт 1.docx')), false);
  const id = /bridgerator_undo id (\w+)/.exec(text(r))[1];
  assert.deepEqual(JSON.parse(text(await dc.call('bridgerator_undo', { id }))).restored, [W('отчёт 1.docx')]);
  assert.equal(fs.readFileSync(W('отчёт 1.docx'), 'utf8'), 'отчёт');
  // A command Bridgerator can't read for sure is not touched by it.
  binned.length = 0;
  await dc.call('start_process', { command: `Get-ChildItem "${work}" | Select-Object -First 1`, timeout_ms: 5000 });
  assert.deepEqual(binned, []);
});

test('no Recycle Bin on the drive → asked on the PC; Delete removes it for good, Keep leaves it', async () => {
  fs.writeFileSync(W('сетевой.txt'), 'x');
  bin = 'nobin'; answer = 'allow';
  const r0 = await dc.call('start_process', { command: `del "${W('сетевой.txt')}"`, timeout_ms: 5000 });
  assert.match(text(r0), /Deleted for good after the person's OK/);
  assert.equal(fs.existsSync(W('сетевой.txt')), false);
  fs.writeFileSync(W('на флешке.txt'), 'x');
  answer = 'deny';
  const n = asked.length;
  const r = await dc.call('start_process', { command: `del "${W('на флешке.txt')}"`, timeout_ms: 5000 });
  assert.match(asked[n].head, /delete 1 item for good/);
  assert.equal(r.notConfirmed, true); assert.match(text(r), /kept them/);
  assert.equal(fs.existsSync(W('на флешке.txt')), true);
  answer = 'allow';
  bin = 'recycled';
});

test('Recycle Bin off → the delete command runs as written', async () => {
  const n = askedNow();
  const ok = await settings({ recycleBin: false });
  assert.equal(askedNow(), n + 1, 'turning it off needs the person');
  assert.match(text(ok), /after the person's OK: Recycle Bin instead of deleting: off/);
  fs.writeFileSync(W('удалить.txt'), 'x');
  binned.length = 0;
  await dc.call('start_process', { command: `Remove-Item "${W('удалить.txt')}"`, timeout_ms: 10000 });
  assert.deepEqual(binned, []);
  await until(() => !fs.existsSync(W('удалить.txt')));
  assert.match(text(await settings({ recycleBin: true })), /^Applied/, 'turning it back on is direct');
});

test('mass-action fuse: over the limit → paused + question; Continue resumes', async () => {
  assert.match(text(await settings({ fuse: { enabled: true, limit: 3 } })), /^Applied/, 'turning the fuse on is direct');
  for (let i = 0; i < 5; i++) fs.writeFileSync(W(`m${i}.txt`), String(i));
  let release;
  answer = () => new Promise((r) => { release = r; });
  const n = asked.length;
  for (let i = 0; i < 3; i++) assert.equal((await dc.call('move_file', { source: W(`m${i}.txt`), destination: W(`moved${i}.txt`) })).isError, undefined);
  const r = await dc.call('move_file', { source: W('m3.txt'), destination: W('moved3.txt') });
  assert.equal(r.paused, true); assert.match(text(r), /more than 3 files/);
  assert.equal(fs.existsSync(W('m3.txt')), true, 'the 4th move did not run');
  assert.match(asked[n].head, /deleted or moved 4 files in a minute/);
  assert.equal((await dc.call('read_file', { path: W('m4.txt') })).paused, true, 'everything waits while paused');
  release('allow');
  await until(() => !dc.paused);
  assert.equal((await dc.call('move_file', { source: W('m3.txt'), destination: W('moved3.txt') })).isError, undefined, 'counting starts again');
  answer = 'allow';
  const k = askedNow();
  assert.match(text(await settings({ fuse: { enabled: false } })), /after the person's OK/);
  assert.equal(askedNow(), k + 1, 'turning the fuse off needs the person');
});

test('access presets: Files turns the terminal off at once; back to Full needs the person', async () => {
  assert.match(text(await settings({ preset: 'files' })), /^Applied/);
  assert.equal((await state()).preset, 'files');
  assert.match(text(await dc.call('start_process', { command: 'Get-Date', timeout_ms: 3000 })), /terminal is off/);
  // Read only: every folder of the list read-only; writes refused.
  await settings({ preset: 'read_only' });
  assert.equal((await state()).preset, 'read_only');
  assert.match(text(await dc.call('write_file', { path: W('x.txt'), content: 'x' })), /read-only/);
  const n = askedNow();
  await settings({ preset: 'full' });
  assert.equal(askedNow(), n + 1, 'widening asks (once for both parts)');
  const s = await state();
  assert.equal(s.preset, 'full'); assert.deepEqual(s.readOnlyDirectories, []);
  assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).disabledTools.length, 0);
});

test('bridgerator_settings get: every value in the names "set" takes, and the defaults', async () => {
  const g = JSON.parse(text(await dc.call('bridgerator_settings', { action: 'get' })));
  for (const k of ['preset', 'terminal', 'protectSensitive', 'recycleBin', 'snapshots', 'fuse', 'keepAwake', 'confirm', 'allowedDirectories', 'readOnlyDirectories', 'theme', 'telemetryEnabled']) {
    assert.ok(k in g.current, `current.${k}`); assert.ok(k in g.defaults, `defaults.${k}`);
  }
  assert.equal(typeof g.current.confirm.timeoutSeconds, 'number');
  assert.equal(g.defaults.preset, 'full');
});

test('Protect sensitive folders: off → readable; on is direct; off again needs the person', async () => {
  assert.match(text(await dc.call('read_file', { path: path.join(fakeHome, '.ssh', 'id_rsa') })), /KEY/);
  assert.match(text(await settings({ protectSensitive: true })), /^Applied/);
  assert.match(text(await dc.call('read_file', { path: path.join(fakeHome, '.ssh', 'id_rsa') })), /excluded/);
  assert.match(text(await dc.call('read_file', { path: path.join(DIR, 'config.json') })), /excluded/, 'own folder always');
});

test('config.json changed outside: a safe change shows at once; a weakening one waits for Apply, Keep writes it back', async () => {
  const cfg0 = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  fs.writeFileSync(CONFIG, JSON.stringify({ ...cfg0, theme: 'light', keepAwake: false }, null, 2));
  await until(async () => (await state()).theme === 'light');
  assert.equal((await state()).keepAwake, false);
  // A hand edit that removes protection: asked, Keep → the file gets the applied value back.
  answer = 'deny';
  const n = asked.length;
  const cfg1 = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  fs.writeFileSync(CONFIG, JSON.stringify({ ...cfg1, protectSensitive: false, recycleBin: false }, null, 2));
  await until(() => asked.length > n);
  assert.match(asked[n].head, /settings file changed/);
  await dc.settled();
  assert.equal((await state()).protectSensitive, true);
  assert.equal((await state()).recycleBin, true);
  await until(() => { const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); return c.protectSensitive === true && c.recycleBin === true; });
  // Window ↔ AI: what the window sets is what the AI reads.
  await dc.rpc('setSetting', { key: 'snapshots.days', value: 14 });
  assert.equal(JSON.parse(text(await dc.call('bridgerator_settings', { action: 'get' }))).current.snapshots.days, 14);
});

test('keep awake: wanted while / right after calls; the window sees it with undo stats', async () => {
  await dc.rpc('setSetting', { key: 'keepAwake', value: true });
  await dc.call('read_file', { path: W('план.txt') });
  const st = await dc.rpc('getState');
  assert.equal(st.awake.want, true);
  assert.equal(typeof st.undo.count, 'number');
  const u = await dc.rpc('undo.list');
  assert.ok(Array.isArray(u.actions) && Array.isArray(u.groups));
});

test('a Deny on the PC keeps everything as it was; during the cool-down nothing is asked again', async () => {
  answer = 'deny';
  const before0 = await state();
  const n = askedNow();
  const r = await settings({ preset: 'files', protectSensitive: false });
  assert.equal(r.notConfirmed, true);
  assert.match(text(r), /Applied: Terminal \(commands\): off/, 'the narrowing part applies');
  assert.equal(askedNow(), n + 1);
  assert.equal((await state()).protectSensitive, before0.protectSensitive);
  for (const s of [{ preset: 'full' }, { recycleBin: false }, { snapshots: { enabled: false } }, { fuse: { limit: 500 } }]) {
    const x = await settings(s);
    if (x.notConfirmed) assert.match(text(x), /declined a few minutes ago/, JSON.stringify(s));
  }
  assert.equal(askedNow(), n + 1, 'no new question in the cool-down');
  const s1 = await state();
  assert.equal(s1.terminal, false); assert.equal(s1.recycleBin, true); assert.equal(s1.snapshots.enabled, true);
  assert.match(text(await dc.call('read_file', { path: path.join(fakeHome, '.ssh', 'id_rsa') })), /excluded/);
});
