// The bridge's own call path with the REAL bundled engine: folders (no list = all except the
// always-blocked ones), the settings / setup tools that must not lower protection without Apply on
// the PC, queue clear, pause, the confirm gate on real commands, UTF-8 terminal output (ru-RU).
// LOGIC: critical-logic/bridge.md §2, §2a, §2b. No windows: the question on the PC is a fake, and the
// notifications' PowerShell is intercepted (recorded, never started).
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
  if (/powershell\.exe$/i.test(String(file))) { shown.push({ env: opts?.env || {}, args }); setImmediate(() => cb?.(null, 'deny', '')); return { on() {}, kill() {} }; }
  return realExecFile(file, args, opts, cb);
};
syncBuiltinESMExports();

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-tools-'));
const fakeHome = path.join(root, 'Иван Петров');
const APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
Object.assign(process.env, { USERPROFILE: fakeHome, APPDATA, LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') });
const DIR = path.join(APPDATA, 'Bridgerator');
const work = path.join(root, 'Работа'), other = path.join(root, 'Другое'), ro = path.join(root, 'Архив');
for (const d of [DIR, work, other, ro, path.join(fakeHome, '.ssh')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_rsa'), 'SECRET-KEY-MATERIAL');
fs.writeFileSync(path.join(work, 'заметки.txt'), 'иголка в стоге\n');
fs.writeFileSync(path.join(other, 'b.txt'), 'other folder\n');
fs.writeFileSync(path.join(ro, 'old.txt'), 'archived\n');

const { startDesktopCommander } = await import('../src/bridge.mjs');
const { ensureIni, setIni, readSettings, readSettingsStrict } = await import('../src/confirm.mjs');
const CONFIG = path.join(DIR, 'config.json'), INI = path.join(DIR, 'confirm.ini');
const base = { askSettings: true, relay: 'wss://relay.invalid/link', token: 't', allowedDirectories: [], deniedDirectories: [], readOnlyDirectories: [ro], telemetryEnabled: false, localHistory: false, setupDone: false };
fs.writeFileSync(CONFIG, JSON.stringify(base, null, 2));
ensureIni(INI); setIni(INI, 'confirm', 'enabled', 'true');

let answer = 'deny';
const asked = [];
const autostart = [];
let dc;
const text = (r) => (r.content || []).map((c) => c.text).join('\n');
const disk = () => [fs.readFileSync(CONFIG, 'utf8'), fs.readFileSync(INI, 'utf8')];
const settings = (s) => dc.call('bridgerator_settings', { action: 'set', settings: s });

before(async () => {
  dc = await startDesktopCommander({ ...base, dcConfigDir: path.join(DIR, 'dc'), configDir: DIR, confirmIni: INI, configFile: CONFIG }, () => {},
    { ask: async (q) => { asked.push(q); return answer; } });
  dc.hooks = { autostart: async (on) => { autostart.push(on); } };
});
after(async () => { await dc?.close(); });

test('no folder list = every folder except the always-blocked ones', async () => {
  assert.match(text(await dc.call('read_file', { path: path.join(work, 'заметки.txt') })), /иголка/);
  assert.match(text(await dc.call('read_file', { path: path.join(other, 'b.txt') })), /other folder/);
  for (const p of [path.join(fakeHome, '.ssh', 'id_rsa'), path.join(DIR, 'config.json'), path.join(DIR, 'confirm.ini'), `\\??\\${path.join(fakeHome, '.ssh', 'id_rsa')}`]) {
    const r = text(await dc.call('read_file', { path: p }));
    assert.doesNotMatch(r, /SECRET-KEY-MATERIAL|"token"|\[confirm\]/, p);
  }
  assert.match(text(await dc.call('write_file', { path: path.join(ro, 'old.txt'), content: 'x' })), /read-only/);
  assert.match(text(await dc.call('read_file', { path: path.join(ro, 'old.txt') })), /archived/);
});

test('bridgerator_settings: nothing that lowers protection or widens access changes the disk without Apply', async () => {
  answer = 'deny';
  // Narrowing is direct: all folders → only "Работа".
  const n0 = asked.length;
  assert.match(text(await settings({ allowedDirectories: [work] })), /^Applied/);
  assert.equal(asked.length, n0, 'no question for narrowing');
  assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).allowedDirectories, [work]);
  assert.match(text(await dc.call('read_file', { path: path.join(other, 'b.txt') })), /not allowed|outside/i, 'the engine follows the list');
  const before = disk();
  const k = asked.length;
  const r0 = await settings({ confirm: { enabled: false } });
  assert.equal(r0.notConfirmed, true);
  assert.equal(asked.length, k + 1, 'asked on the PC');
  assert.match(asked.at(-1).text, /Confirmations: off/);
  assert.deepEqual(disk(), before);
  // After a Deny: a 10-minute cool-down, every further weakening is refused without a new question.
  for (const s of [{ confirm: { delete: false } }, { confirm: { dangerous_commands: false } }, { allowedDirectories: [work, other] }, { allowedDirectories: [] },
    { readOnlyDirectories: [] }, { autostart: false }, { telemetryEnabled: true }, { localHistory: true }]) {
    const r = await settings(s);
    assert.equal(r.notConfirmed, true, JSON.stringify(s)); assert.match(text(r), /declined a few minutes ago/);
    assert.deepEqual(disk(), before, JSON.stringify(s));
  }
  assert.equal(asked.length, k + 1);
  assert.deepEqual(autostart, [], 'autostart never touched');
  assert.equal(readSettings(INI).enabled, true);
});

test('bridgerator_settings: safe changes apply at once; a mixed set applies only the safe part; unknown keys refused', async () => {
  const k = asked.length;
  assert.match(text(await settings({ theme: 'dark', language: 'ru', notify: { sound: false } })), /^Applied/);
  assert.equal(asked.length, k);
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(c.theme, 'dark'); assert.equal(c.language, 'ru'); assert.equal(c.notify.sound, false);
  const r = await settings({ theme: 'light', confirm: { enabled: false } });
  assert.equal(r.notConfirmed, true);
  assert.equal(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).theme, 'light', 'safe part applied');
  assert.equal(readSettings(INI).enabled, true, 'risky part not');
  for (const bad of [{ blockedCommands: [] }, { deniedDirectories: [] }, { disabledTools: [] }, { telemetry: true }, { allowedDirectories: ['\\\\srv\\share'] }]) {
    const x = await settings(bad);
    assert.equal(x.isError, true, JSON.stringify(bad)); assert.match(text(x), /^Not changed/);
  }
  assert.equal((await dc.call('bridgerator_settings', { action: 'delete' })).isError, true);
  assert.equal(asked.length, k, 'no question for refused input; the risky part hit the cool-down');
});

test('bridgerator_setup cannot widen without Apply; unknown keys refused; read-only removal is Apply-only', async () => {
  const before = disk();
  for (const s of [{ blockedCommands: [] }, { telemetryEnabled: true }, { deniedDirectories: [] }, { allowedDirectories: ['relative'] }]) {
    const r = await dc.call('bridgerator_setup', s);
    assert.equal(r.isError, true, JSON.stringify(s));
  }
  assert.deepEqual(disk(), before);
  answer = 'allow';
  assert.match(text(await dc.call('bridgerator_setup', { readOnlyDirectories: [] })), /Applied on the PC/);
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.deepEqual(c.readOnlyDirectories, []); assert.equal(c.setupDone, true);
  assert.equal(dc.mode().setupDone, true);
  answer = 'deny';
  const now = disk();
  const r = await dc.call('bridgerator_setup', { allowedDirectories: [], readOnlyDirectories: [ro], confirm: { enabled: false } });
  assert.equal(r.notConfirmed, true);
  assert.deepEqual(disk(), now, 'Cancel: nothing written');
});

test('the person at the PC changes settings in the window without a question; turning off is announced', async () => {
  const k = asked.length;
  assert.equal(await dc.rpc('setSetting', { key: 'confirm.delete', value: false }), true);
  assert.equal(asked.length, k, 'no question for the person themselves');
  assert.equal(readSettings(INI).ask.delete, false);
  assert.ok(shown.some((s) => /protection turned off/.test(s.env.BR_TOAST || '')), 'protection_off notification');
  assert.equal(await dc.rpc('setSetting', { key: 'confirm.delete', value: true }), true);
  await assert.rejects(dc.rpc('setSetting', { key: 'deniedDirectories', value: [] }), /unknown setting/);
  await assert.rejects(dc.rpc('setSetting', { key: 'confirm.timeout', value: 5 }), /unknown setting/);
  assert.equal(await dc.rpc('setSetting', { key: 'allowedDirectories', value: [] }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).allowedDirectories, []);
});

test('confirm gate on real commands: Deny keeps the file, Allow deletes it', async () => {
  const f = path.join(work, 'удалить меня.txt');
  fs.writeFileSync(f, 'x');
  answer = 'deny';
  const r = await dc.call('start_process', { command: `Remove-Item -LiteralPath "${f}"`, timeout_ms: 8000 });
  assert.equal(r.notConfirmed, true);
  assert.ok(fs.existsSync(f));
  assert.match(asked.at(-1).head, /delete files/);
  answer = 'allow';
  await dc.call('start_process', { command: `Remove-Item -LiteralPath "${f}"`, timeout_ms: 8000 });
  assert.equal(fs.existsSync(f), false);
  assert.equal(dc.recent.list()[1].outcome, 'not confirmed', 'local history shows the refusal');
});

test('regression 1.0.1: terminal output on non-English Windows comes back as UTF-8 (no 866/1251 garbage)', async () => {
  const out = text(await dc.call('start_process', { command: 'Write-Output "Привет, мир — ёЁ №5"; Get-ChildItem -Name -LiteralPath "' + work + '"', timeout_ms: 10000 }));
  assert.match(out, /Привет, мир — ёЁ №5/);
  assert.match(out, /заметки\.txt/);
});

test('queue_clear all needs the OK on the PC; parallel queue_next through the call path never double-takes', async () => {
  for (let i = 0; i < 12; i++) await dc.call('queue_add', { title: `задача ${i}` });
  answer = 'deny';
  const r = await dc.call('queue_clear', { status: 'all' });
  assert.equal(r.notConfirmed, true);
  assert.match(asked.at(-1).head, /clear 12 tasks/);
  assert.equal(dc.queue.list().length, 12);
  const got = await Promise.all(Array.from({ length: 16 }, (_, i) => dc.call('queue_next', { worker: `чат ${i}` })));
  const ids = got.map((x) => JSON.parse(text(x)).item?.id).filter(Boolean);
  assert.equal(ids.length, 12); assert.equal(new Set(ids).size, 12);
  assert.deepEqual(fs.readdirSync(DIR).filter((x) => x.endsWith('.tmp')), []);
});

test('paused: every call answers "paused" (engine, queue, setup tools) and nothing runs', async () => {
  dc.paused = true;
  try {
    for (const [n, a] of [['read_file', { path: path.join(work, 'заметки.txt') }], ['queue_list', {}], ['bridgerator_setup', { allowedDirectories: [] }], ['bridgerator_settings', { action: 'get' }], ['request_confirm_off', {}]]) {
      const r = await dc.call(n, a);
      assert.equal(r.paused, true, n); assert.equal(r.isError, true);
    }
  } finally { dc.paused = false; }
  assert.equal(dc.mode().paused, false);
});

test('YB-1: the tray on/off toggle takes the value it wrote; a missing / unreadable / broken confirm.ini keeps protection on', async () => {
  setIni(INI, 'confirm', 'enabled', 'true'); dc.acceptConfirm({ enabled: true });
  assert.equal(dc.mode().confirm, 'on');
  const n0 = asked.length;
  setIni(INI, 'confirm', 'enabled', 'false'); dc.acceptConfirm({ enabled: false });   // tray: off
  assert.equal(dc.mode().confirm, 'off', 'the person switched it off in the tray: no question');
  setIni(INI, 'confirm', 'enabled', 'true'); dc.acceptConfirm({ enabled: true });     // tray: on
  assert.equal(dc.mode().confirm, 'on');
  const keep = fs.readFileSync(INI, 'utf8');
  try {
    fs.rmSync(INI); dc.acceptConfirm();                                               // missing
    assert.equal(dc.mode().confirm, 'on', 'missing file: protection stays on');
    assert.equal(readSettingsStrict(INI)?.enabled, true, 'V-1: recreated with the applied state');
    fs.rmSync(INI); fs.mkdirSync(INI); dc.acceptConfirm();                                            // unreadable (EISDIR)
    assert.equal(dc.mode().confirm, 'on', 'unreadable file: protection stays on');
    fs.rmdirSync(INI); fs.writeFileSync(INI, 'garbage\n'); dc.acceptConfirm();        // no valid [confirm] enabled
    assert.equal(dc.mode().confirm, 'on', 'broken file: protection stays on');
  } finally { fs.rmSync(INI, { recursive: true, force: true }); fs.writeFileSync(INI, keep); }
  assert.equal(asked.length, n0, 'nothing asked on the PC');
  assert.equal(dc.mode().confirm, 'on');
});

test('YB-6: a computer name given offline is kept in config.json until the relay accepted it', async () => {
  assert.match(text(await settings({ deviceName: 'Ноутбук Ивана' })), /^Applied/);
  const cfgNow = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(cfgNow().deviceName, 'Ноутбук Ивана');
  assert.equal(cfgNow().namePending, 'Ноутбук Ивана', 'survives a restart (read back into cfg by the CLI)');
  assert.equal(dc.namePending, 'Ноутбук Ивана');
  dc.nameSent('Другое имя');                       // an older name accepted: the newer one still waits
  assert.equal(cfgNow().namePending, 'Ноутбук Ивана');
  dc.nameSent('Ноутбук Ивана');                    // welcome after the hello that carried it
  assert.equal(dc.namePending, '');
  assert.ok(!('namePending' in cfgNow()), 'cleared on disk too');
  assert.equal(cfgNow().deviceName, 'Ноутбук Ивана');
});

test('V-10: after a re-pair the window shows the name the relay gave (welcome), unless a local rename still waits', async () => {
  const cfgNow = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  assert.equal(cfgNow().deviceName, 'Ноутбук Ивана');
  dc.relayName('LAB-W10-02');                       // welcome of the new device
  assert.equal(cfgNow().deviceName, 'LAB-W10-02');
  assert.equal((await dc.rpc('getState')).name, 'LAB-W10-02');
  assert.match(text(await settings({ deviceName: 'Мой ПК' })), /^Applied/);   // renamed here, not sent yet
  dc.relayName('LAB-W10-02');
  assert.equal(cfgNow().deviceName, 'Мой ПК', 'a pending local name wins');
  dc.nameSent('Мой ПК'); dc.relayName('x\u0007y'); dc.relayName('');
  assert.equal(cfgNow().deviceName, 'Мой ПК', 'empty / control characters ignored');

  // VR-10: renamed here after the hello, the live mode message already sent it (not pending any more):
  // the welcome of that older hello carries the old name and must not undo the rename.
  const gen = dc.nameGen;
  assert.match(text(await settings({ deviceName: 'Новое имя' })), /^Applied/);
  dc.nameSent('Новое имя');
  dc.relayName('Мой ПК', gen);
  assert.equal(cfgNow().deviceName, 'Новое имя', 'a welcome older than the rename is ignored');
  dc.relayName('Из кабинета', dc.nameGen);
  assert.equal(cfgNow().deviceName, 'Из кабинета', 'a welcome after the rename is taken');
});

test('V-9: the window toggle with confirm.ini held by another program: nothing changes, the person is told', { skip: process.platform !== 'win32' }, async () => {
  const before = dc.mode().confirm, n0 = shown.length;
  const text0 = fs.readFileSync(INI, 'utf8');
  // Another program opens the file without sharing (as on the W10 VM).
  const holder = cp.spawn('powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${INI.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('held'); Start-Sleep -Seconds 30`], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  try {
    await new Promise((r) => holder.stdout.on('data', (d) => { if (/held/.test(String(d))) r(); }));
    await assert.rejects(dc.rpc('setSetting', { key: 'confirm.enabled', value: before !== 'on' }), /CONFIRM_LOCKED/);
    await assert.rejects(dc.rpc('setSetting', { key: 'confirm.delete', value: false }), /CONFIRM_LOCKED/);
    assert.equal(dc.mode().confirm, before, 'state kept');
    assert.ok(shown.slice(n0).some((x) => /the setting was not changed/.test(x.env.BR_TOAST || '')), 'a notification on the PC');
  } finally { holder.kill(); await new Promise((r) => holder.on('exit', r)); }
  assert.equal(fs.readFileSync(INI, 'utf8'), text0, 'file untouched');
  assert.equal((await dc.rpc('getState')).settings.confirm.ask.delete, true);
});
