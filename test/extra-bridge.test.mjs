// The extra tools inside the REAL bridge (bundled engine started): they are listed in hello, routed
// to their module with the bridge's current folder rules, their settings show up in getState /
// bridgerator_settings, lowering them waits for Apply on the PC, and a tool the person turned off is
// gone. No windows: the PC question is a fake, notification PowerShell is intercepted.
// LOGIC: critical-logic/bridge.md §2d.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const shown = [];
const realExecFile = cp.execFile;
cp.execFile = (file, args, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (/powershell\.exe$/i.test(String(file))) { shown.push({ env: opts?.env || {} }); setImmediate(() => cb?.(null, '', '')); return { on() {}, kill() {} }; }
  return realExecFile(file, args, opts, cb);
};
syncBuiltinESMExports();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-extra-'));
const fakeHome = path.join(root, 'Мария Иванова');
const APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
Object.assign(process.env, { USERPROFILE: fakeHome, APPDATA, LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') });
const DIR = path.join(APPDATA, 'Bridgerator');
const work = path.join(root, 'Отчёты 2026'), ro = path.join(root, 'Архив');
for (const d of [DIR, work, ro]) fs.mkdirSync(d, { recursive: true });

const { startDesktopCommander } = await import('../src/bridge.mjs');
const { ensureIni } = await import('../src/confirm.mjs');
const CONFIG = path.join(DIR, 'config.json'), INI = path.join(DIR, 'confirm.ini');
const base = { askSettings: true, relay: 'wss://relay.invalid/link', token: 't', allowedDirectories: [], deniedDirectories: [], readOnlyDirectories: [ro], telemetryEnabled: false, localHistory: false, setupDone: true, disabledTools: ['pc_health'] };
fs.writeFileSync(CONFIG, JSON.stringify(base, null, 2));
ensureIni(INI);

let answer = 'deny';
const asked = [];
let dc;
const text = (r) => (r.content || []).map((c) => c.text).join('\n');

before(async () => {
  dc = await startDesktopCommander({ ...base, dcConfigDir: path.join(DIR, 'dc'), configDir: DIR, confirmIni: INI, configFile: CONFIG }, () => {},
    { ask: async (q) => { asked.push(q); return answer; } });
});
after(async () => { await dc?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('the extra tools are in the tool list (hello); a tool in disabledTools is not, and a call to it is refused', async () => {
  const names = dc.tools.map((t) => t.name);
  for (const n of ['bridgerator_doctor', 'create_document', 'fast_search', 'photos', 'software', 'screen']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('pc_health'));
  const r = await dc.call('pc_health', { action: 'summary' });
  assert.equal(r.isError, true);
  assert.match(text(r), /disabled on this computer/);
});

test('a document is created in an allowed folder; the read-only folder is refused with a plain reason', async () => {
  const p = path.join(work, 'Итоги.docx');
  const r = await dc.call('create_document', { action: 'docx', path: p, markdown: '# Итоги\n\nВсё готово.' });
  assert.ok(!r.isError, text(r));
  assert.ok(fs.statSync(p).size > 1000);
  const bad = await dc.call('create_document', { action: 'docx', path: path.join(ro, 'Новое.docx'), markdown: 'x' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /read-only.*\(code ACCESS_DENIED\)/s);
  assert.ok(!fs.existsSync(path.join(ro, 'Новое.docx')));
  assert.doesNotMatch(text(bad), /\n\s+at /, 'no stack trace');
});

test('the Bridgerator folder stays closed to the extra tools too', async () => {
  const r = await dc.call('create_document', { action: 'docx', path: path.join(DIR, 'x.docx'), markdown: 'x' });
  assert.equal(r.isError, true);
  assert.ok(!fs.existsSync(path.join(DIR, 'x.docx')));
});

test('tool settings: in getState (values + labels for the window) and in bridgerator_settings get (current + defaults)', async () => {
  const st = await dc.rpc('getState');
  assert.deepEqual(st.settings.screen, { enabled: true, notify: true });
  assert.ok(st.extraSettings.some((s) => s.key === 'screen.notify' && s.label.ru && s.value === true));
  const g = JSON.parse(text(await dc.call('bridgerator_settings', { action: 'get' })));
  assert.deepEqual(g.current.screen, { enabled: true, notify: true });
  assert.deepEqual(g.defaults.screen, { enabled: true, notify: true });
});

test('turning the screenshot notification off from ChatGPT waits for Apply on the PC; turning screenshots off is direct', async () => {
  answer = 'deny';
  const n0 = asked.length;
  const r = await dc.call('bridgerator_settings', { action: 'set', settings: { screen: { notify: false } } });
  assert.equal(r.notConfirmed, true);
  assert.equal(asked.length, n0 + 1);
  assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).screen?.notify, undefined, 'nothing written without Apply');
  const off = await dc.call('bridgerator_settings', { action: 'set', settings: { screen: { enabled: false } } });
  assert.match(text(off), /^Applied/);
  assert.equal(asked.length, n0 + 1, 'raising protection asks nothing');
  assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).screen.enabled, false);
  const shot = await dc.call('screen', { action: 'capture' });
  assert.equal(shot.isError, true);
  assert.match(text(shot), /SCREEN_OFF/);
  // The window (the person) turns it back on directly.
  await dc.rpc('setSetting', { key: 'screen.enabled', value: true });
  assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).screen.enabled, true);
  await assert.rejects(dc.rpc('setSetting', { key: 'screen.enabled', value: 'yes' }), /true or false/);
});
