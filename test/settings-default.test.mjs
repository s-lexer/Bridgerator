// Owner 21.10: settings the AI changes apply at once — no question on the PC — unless the person turned
// on "Ask before the AI changes settings" (askSettings, off by default). Real bundled engine, fake ask.
// LOGIC: critical-logic/bridge.md §2 ("Settings"), decisions.md 2026-10-21.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-setdef-'));
const fakeHome = path.join(root, 'Иван Петров');
const APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
Object.assign(process.env, { USERPROFILE: fakeHome, APPDATA, LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') });
const DIR = path.join(APPDATA, 'Bridgerator');
const work = path.join(root, 'Работа');
for (const d of [DIR, work]) fs.mkdirSync(d, { recursive: true });

const { startEngine } = await import('../src/bridge.mjs');
const { ensureIni, readSettings } = await import('../src/confirm.mjs');
const CONFIG = path.join(DIR, 'config.json'), INI = path.join(DIR, 'confirm.ini');
const base = { relay: 'wss://relay.invalid/link', token: 't', allowedDirectories: [work], deniedDirectories: [], readOnlyDirectories: [work], telemetryEnabled: false, localHistory: false, setupDone: false };
fs.writeFileSync(CONFIG, JSON.stringify(base, null, 2));
ensureIni(INI);

const asked = [];
let dc;
const text = (r) => (r.content || []).map((c) => c.text).join('\n');
const conf = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
before(async () => {
  dc = await startEngine({ ...base, dcConfigDir: path.join(DIR, 'dc'), configDir: DIR, confirmIni: INI, configFile: CONFIG }, () => {},
    { ask: async (q) => { asked.push(q); return 'deny'; } });
  dc.hooks = { autostart: async () => {} };
});
after(async () => { await dc?.close(); });

test('default (askSettings off): widening and weakening by the AI apply at once, nobody is asked', async () => {
  const r = await dc.call('bridgerator_settings', { action: 'set', settings: { allowedDirectories: [], readOnlyDirectories: [], confirm: { delete: false } } });
  assert.match(text(r), /^Applied/);
  assert.equal(r.notConfirmed, undefined);
  assert.deepEqual(conf().allowedDirectories, []);
  assert.deepEqual(conf().readOnlyDirectories, []);
  assert.equal(readSettings(INI).ask.delete, false);
  const s = await dc.call('bridgerator_setup', { readOnlyDirectories: [work] });
  assert.match(text(s), /Applied on the PC/);
  assert.deepEqual(conf().readOnlyDirectories, [work]);
  assert.deepEqual(asked, [], 'no question on the PC');
});

test('askSettings on: the next weakening waits for Apply on the PC (here: denied → nothing changes)', async () => {
  assert.match(text(await dc.call('bridgerator_settings', { action: 'set', settings: { askSettings: true } })), /^Applied/, 'turning it on is direct');
  const r = await dc.call('bridgerator_settings', { action: 'set', settings: { readOnlyDirectories: [] } });
  assert.equal(r.notConfirmed, true);
  assert.equal(asked.length, 1);
  assert.deepEqual(conf().readOnlyDirectories, [work]);
  const g = JSON.parse(text(await dc.call('bridgerator_settings', { action: 'get' })));
  assert.equal(g.current.askSettings, true);
  assert.equal(g.defaults.askSettings, false);
});
