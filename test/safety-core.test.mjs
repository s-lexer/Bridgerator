// Safety core on the bridge's real call path (REAL bundled engine), review 21.10 (B1-*, VM10/VM11):
// relative paths checked where the engine opens them, a plan-approved delete not counted by the fuse,
// blockedCommands not bypassed by the Recycle Bin, parallel writes to one file each get their own
// snapshot, the log says who changed settings, a new computer name reaches the relay.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-core-'));
const fakeHome = path.join(root, 'Иван Петров');
const APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
Object.assign(process.env, { USERPROFILE: fakeHome, APPDATA, LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') });
const DIR = path.join(APPDATA, 'Bridgerator');
const work = path.join(root, 'Рабочая папка');
for (const d of [DIR, work]) fs.mkdirSync(d, { recursive: true });

const { startDesktopCommander } = await import('../src/bridge.mjs');
const { ensureIni, setIni } = await import('../src/confirm.mjs');
const CONFIG = path.join(DIR, 'config.json'), INI = path.join(DIR, 'confirm.ini');
const base = { relay: 'wss://relay.invalid/link', token: 't', allowedDirectories: [work, fakeHome], deniedDirectories: [], readOnlyDirectories: [], telemetryEnabled: false, localHistory: false, setupDone: true, protectSensitive: false, blockedCommands: ['erase'], fuse: { enabled: true, limit: 1 } };
fs.writeFileSync(CONFIG, JSON.stringify(base, null, 2));
ensureIni(INI); setIni(INI, 'confirm', 'enabled', 'true');
fs.writeFileSync(path.join(DIR, 'secret.txt'), 'KEY');

const logs = [], modes = [], binned = [];
const SID = path.join(root, '$Recycle.Bin', 'S-1-5-21-9');
fs.mkdirSync(SID, { recursive: true });
const binInfo = (p, ms) => {
  const name = Buffer.from(`${p}\0`, 'utf16le'), b = Buffer.alloc(28 + name.length);
  b.writeBigInt64LE(2n, 0); b.writeBigInt64LE(1n, 8); b.writeBigInt64LE(BigInt(ms + 11644473600000) * 10000n, 16); b.writeUInt32LE(p.length + 1, 24); name.copy(b, 28);
  return b;
};
let dc;
const text = (r) => (r.content || []).map((c) => c.text).join('\n');
const W = (...x) => path.join(work, ...x);

before(async () => {
  dc = await startDesktopCommander({ ...base, dcConfigDir: path.join(DIR, 'dc'), configDir: DIR, confirmIni: INI, configFile: CONFIG, snapshotsDir: path.join(DIR, 'snapshots') }, (l) => logs.push(l), {
    ask: async () => 'allow',
    // A fake Recycle Bin folder: each item becomes a $I/$R pair, its $R path reported like recycle.ps1 does.
    recycle: async (paths) => paths.map((p) => {
      binned.push(p);
      const id = `X${binned.length}`, r = path.join(SID, `$R${id}.txt`);
      fs.renameSync(p, r); fs.writeFileSync(path.join(SID, `$I${id}.txt`), binInfo(p, Date.now()));
      return { p, r: 'recycled', bin: r };
    }),
    drives: () => ['C:\\'],
  });
  dc.onMode = (m) => modes.push(m);
});
after(async () => { await dc?.close(); });

test('B1-1: a relative path is checked against the engine\'s folder (first allowed folder), where the engine opens it', async () => {
  const rel = path.relative(work, path.join(DIR, 'secret.txt'));
  assert.match(rel, /^\.\.[\\/]/);
  for (const [tool, args] of [['read_file', { path: rel }], ['write_file', { path: rel, content: 'x' }], ['get_file_info', { path: rel }]]) {
    const r = await dc.call(tool, args);
    assert.equal(r.refused, true, tool); assert.match(text(r), /excluded/);
  }
  assert.equal(fs.readFileSync(path.join(DIR, 'secret.txt'), 'utf8'), 'KEY');
});

test('B1-16: deletes approved in a plan go to the Recycle Bin without tripping the fuse', async () => {
  for (const f of ['p1.txt', 'p2.txt']) fs.writeFileSync(W(f), f);
  const cmds = ['p1.txt', 'p2.txt'].map((f) => `Remove-Item "${W(f)}"`);
  const plan = await dc.call('bridgerator_plan', { action: 'propose', title: 'cleanup', items: cmds.map((command) => ({ tool: 'start_process', args: { command } })) });
  assert.ok(!plan.isError, text(plan));
  for (const command of cmds) { const r = await dc.call('start_process', { command, timeout_ms: 5000 }); assert.ok(!r.paused, text(r)); assert.match(text(r), /Recycle Bin/); }
  assert.deepEqual(binned.slice(-2), [W('p1.txt'), W('p2.txt')]);
  assert.equal(dc.paused, false);
});

test('X1-6 / X1-3: a blocked word that is only the last part of a path does not hand the delete to the engine; Undo removes exactly its bin copy', async () => {
  assert.match(text(await dc.call('bridgerator_settings', { action: 'set', settings: { fuse: { limit: 50 } } })), /Applied/); // two deletes in this minute
  fs.mkdirSync(W('старое'), { recursive: true });
  const f = W('старое', 'erase');            // a file named like the blocked word: the last part of its path
  fs.writeFileSync(f, 'x');
  const n = binned.length;
  const r = await dc.call('start_process', { command: `del "${f}"`, timeout_ms: 5000 });
  assert.equal(binned.length, n + 1, text(r));
  assert.match(text(r), /moved 1 item to the Recycle Bin/);
  // The person deletes a file of the same name later: their bin copy stays after the Undo.
  fs.writeFileSync(path.join(SID, '$IPERSON.txt'), binInfo(f, Date.now() + 1000)); fs.writeFileSync(path.join(SID, '$RPERSON.txt'), 'mine');
  const id = /bridgerator_undo id (\w+)/.exec(text(r))[1];
  assert.deepEqual(JSON.parse(text(await dc.call('bridgerator_undo', { id }))).restored, [f]);
  const mine = `X${n + 1}.`;
  assert.deepEqual(fs.readdirSync(SID).filter((x) => x.includes('PERSON') || x.includes(mine)).sort(), ['$IPERSON.txt', '$RPERSON.txt']);
});

test('B1-19: a delete command on blockedCommands is left to the engine (refused), not recycled by Bridgerator', async () => {
  setIni(INI, 'confirm', 'enabled', 'false');
  fs.writeFileSync(W('blocked.txt'), 'x');
  const n = binned.length;
  const r = await dc.call('start_process', { command: `erase "${W('blocked.txt')}"`, timeout_ms: 5000 });
  assert.equal(binned.length, n);
  assert.match(text(r), /blocked|not allowed/i);
  assert.equal(fs.existsSync(W('blocked.txt')), true);
});

test('B1-23: two parallel writes to one file each record their own before/after (Undo goes back one step)', async () => {
  const f = W('parallel.txt');
  fs.writeFileSync(f, 'original');
  const rs = await Promise.all([dc.call('write_file', { path: f, content: 'first', mode: 'rewrite' }), dc.call('write_file', { path: f, content: 'second', mode: 'rewrite' })]);
  for (const r of rs) assert.ok(!r.isError, text(r));
  const last = fs.readFileSync(f, 'utf8');
  JSON.parse(text(await dc.call('bridgerator_undo', {})));
  assert.equal(fs.readFileSync(f, 'utf8'), last === 'second' ? 'first' : 'second', 'one step back, not to the original');
});

test('VM10-10 / B1-6: the log says the AI changed settings; a new computer name goes to the relay', async () => {
  const r = await dc.call('bridgerator_settings', { action: 'set', settings: { allowedDirectories: [work] } });
  assert.match(text(r), /^Applied/);
  assert.ok(logs.some((l) => /settings applied \(bridgerator_settings\)/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => /settings applied \(Bridgerator window\)/.test(l)));
  await dc.call('bridgerator_settings', { action: 'set', settings: { deviceName: 'Ноутбук Ивана' } });
  assert.equal(modes.at(-1).deviceName, 'Ноутбук Ивана');
});

test('B1-18: the drive list is read off the event loop too (same answer as the direct check)', async () => {
  const { localDrives, localDrivesAsync } = await import('../src/bridge.mjs');
  assert.deepEqual(await localDrivesAsync(), localDrives());
});
