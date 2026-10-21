// Access presets, the new settings of bridgerator_settings / bridgerator_setup, and the cut-down
// always-blocked list with the "Protect sensitive folders" switch.
// LOGIC: critical-logic/bridge.md ("Access presets", "Settings"), security-privacy.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-presets-'));
const fakeHome = path.join(root, 'Иван Петров');
Object.assign(process.env, { USERPROFILE: fakeHome, APPDATA: path.join(fakeHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') });
const { presetOf, presetChanges, expandPresets, validateSettings, widens, describe, DEFAULTS } = await import('../src/settings-tool.mjs');
const { validateSetup, applySetup, diffSetup, terminalTools } = await import('../src/setup-tool.mjs');
const { createPolicy, builtinDenied, ownDenied, TERMINAL_TOOLS } = await import('../src/policy.mjs');

const A = path.join(root, 'Работа'), B = path.join(root, 'Фото');
fs.mkdirSync(A); fs.mkdirSync(B);
const drives = ['C:\\', 'D:\\'];
const st = (o = {}) => ({ terminal: true, allowedDirectories: [], readOnlyDirectories: [], ...o });

test('presets: what the settings amount to, and what each preset changes', () => {
  assert.equal(presetOf(st(), drives), 'full');
  assert.equal(presetOf(st({ terminal: false }), drives), 'files');
  assert.equal(presetOf(st({ terminal: false, readOnlyDirectories: ['C:\\', 'D:\\'] }), drives), 'read_only');
  assert.equal(presetOf(st({ terminal: false, allowedDirectories: [A, B], readOnlyDirectories: [A] }), drives), 'files', 'one of two folders read-only');
  assert.equal(presetOf(st({ terminal: false, allowedDirectories: [path.join(A, 'sub')], readOnlyDirectories: [A] }), drives), 'read_only', 'inside a read-only folder counts');
  // Read only with no folder list: every drive becomes read-only, own entries kept.
  assert.deepEqual(presetChanges('read_only', st({ readOnlyDirectories: [B] }), drives), [{ key: 'terminal', value: false }, { key: 'readOnlyDirectories', value: [B, 'C:\\', 'D:\\'] }]);
  assert.deepEqual(presetChanges('read_only', st({ allowedDirectories: [A] }), drives), [{ key: 'terminal', value: false }, { key: 'readOnlyDirectories', value: [A] }]);
  // Leaving Read only: only the folders it added go back; the person's own read-only folder stays.
  const ro = st({ terminal: false, readOnlyDirectories: [B, 'C:\\', 'D:\\'] });
  assert.deepEqual(presetChanges('full', ro, drives), [{ key: 'terminal', value: true }, { key: 'readOnlyDirectories', value: [B] }]);
  assert.deepEqual(presetChanges('files', st({ terminal: false }), drives), [{ key: 'terminal', value: false }]);
});

test('widening through a preset needs the person: its parts are judged, not the name', () => {
  const cur = { ...st({ terminal: false, readOnlyDirectories: ['C:\\', 'D:\\'] }), confirm: { enabled: false, ask: {} } };
  const ch = expandPresets([{ key: 'preset', value: 'full' }], cur, drives);
  assert.deepEqual(ch.map((c) => widens(cur, c)), [true, true], 'terminal on + read-only removed');
  const down = expandPresets([{ key: 'preset', value: 'read_only' }], { ...st(), confirm: { enabled: false, ask: {} } }, drives);
  assert.deepEqual(down.map((c) => widens({ ...st(), confirm: { enabled: false, ask: {} } }, c)), [false, false], 'narrowing is direct');
});

test('new settings: strict validation, defaults, what lowers protection', () => {
  const v = validateSettings({ preset: 'files', recycleBin: false, keepAwake: false, protectSensitive: true, terminal: true, snapshots: { enabled: false, days: 3, maxMb: 100, maxFileMb: 10 }, fuse: { enabled: true, limit: 50 }, confirm: { timeoutSeconds: 300 } });
  assert.deepEqual(v.changes.map((c) => c.key), ['preset', 'terminal', 'protectSensitive', 'recycleBin', 'keepAwake', 'confirm.timeout', 'snapshots.enabled', 'snapshots.days', 'snapshots.maxMb', 'snapshots.maxFileMb', 'fuse.enabled', 'fuse.limit']);
  for (const bad of [{ preset: 'admin' }, { snapshots: { days: 0 } }, { snapshots: { days: 1.5 } }, { snapshots: { maxMb: 99999 } }, { fuse: { limit: 1 } }, { fuse: { nuke: true } }, { confirm: { timeoutSeconds: 5 } }, { recycleBin: 'no' }]) assert.ok(validateSettings(bad).error, JSON.stringify(bad));
  assert.equal(DEFAULTS.preset, 'full'); assert.equal(DEFAULTS.recycleBin, true); assert.equal(DEFAULTS.snapshots.enabled, true);
  assert.equal(DEFAULTS.fuse.enabled, false); assert.equal(DEFAULTS.fuse.limit, 20); assert.equal(DEFAULTS.keepAwake, true);
  assert.equal(DEFAULTS.protectSensitive, false); assert.equal(DEFAULTS.confirm.enabled, false);
  const cur = { confirm: { enabled: false, ask: {} }, terminal: false, protectSensitive: true, recycleBin: true, snapshots: { enabled: true, days: 7, maxMb: 500, maxFileMb: 50 }, fuse: { enabled: true, limit: 20 }, keepAwake: true };
  const w = (key, value) => widens(cur, { key, value });
  for (const [k, v2] of [['terminal', true], ['protectSensitive', false], ['recycleBin', false], ['snapshots.enabled', false], ['snapshots.days', 3], ['fuse.enabled', false], ['fuse.limit', 100]]) assert.equal(w(k, v2), true, `${k}=${v2} needs OK`);
  for (const [k, v2] of [['terminal', false], ['protectSensitive', true], ['recycleBin', true], ['snapshots.days', 14], ['fuse.limit', 10], ['keepAwake', false], ['keepAwake', true], ['confirm.timeout', 60]]) assert.equal(w(k, v2), false, `${k}=${v2} direct`);
  assert.equal(describe(cur, { key: 'recycleBin', value: false }), 'Recycle Bin instead of deleting: off');
  assert.equal(describe(cur, { key: 'fuse.limit', value: 50 }), 'Mass-action limit per minute: 50');
});

test('bridgerator_setup: preset accepted; the terminal is written as disabledTools; diff says it', () => {
  assert.deepEqual(validateSetup({ preset: 'read_only' }).value, { preset: 'read_only' });
  assert.match(validateSetup({ preset: 'root' }).error, /preset/);
  assert.deepEqual(terminalTools(['write_pdf'], false), ['write_pdf', ...TERMINAL_TOOLS]);
  assert.deepEqual(terminalTools(['write_pdf', ...TERMINAL_TOOLS], true), ['write_pdf']);
  const cfgFile = path.join(root, 'config.json'), ini = path.join(root, 'confirm.ini');
  fs.writeFileSync(cfgFile, JSON.stringify({ token: 't', disabledTools: [] }));
  assert.match(diffSetup({ disabledTools: [] }, ini, { terminal: false }).short, /Terminal: off/);
  const next = applySetup(cfgFile, ini, { terminal: false, readOnlyDirectories: [A] });
  assert.deepEqual(next.disabledTools, TERMINAL_TOOLS);
  assert.equal(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).token, 't', 'other keys kept');
});

test('always blocked = Bridgerator only; sensitive folders blocked only with the switch on', () => {
  const ssh = path.join(fakeHome, '.ssh', 'id_rsa'), startup = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'x.lnk');
  const own = [path.join(process.env.APPDATA, 'Bridgerator', 'config.json'), path.join(process.env.LOCALAPPDATA, 'Bridgerator', 'snapshots', 'x'), path.join(process.env.APPDATA, 'npm', 'node_modules', 'bridgerator', 'src', 'policy.mjs'), path.join(process.env.APPDATA, 'npm', 'bridgerator.cmd')];
  const off = createPolicy({ protectSensitive: false }), on = createPolicy({ protectSensitive: true });
  for (const p of own) { assert.match(off.check('read_file', { path: p }), /excluded/, p); assert.match(off.check('write_file', { path: p, content: '' }), /excluded/, p); }
  for (const p of [ssh, startup, path.join(fakeHome, 'AppData', 'Local', 'Google', 'x')]) { assert.equal(off.check('read_file', { path: p }), null, p); assert.match(on.check('read_file', { path: p }), /excluded/, p); }
  assert.equal(off.check('read_file', { path: path.join(process.env.APPDATA, 'npm', 'node_modules', 'other', 'x.js') }), null, 'other global packages are not ours');
  assert.match(createPolicy({}).check('read_file', { path: ssh }), /excluded/, 'a caller that does not say → protected (the CLI always says)');
  assert.ok(ownDenied().length < builtinDenied().length);
  assert.ok(!builtinDenied(process.env, fakeHome, { protectSensitive: false }).some((d) => /\.ssh$/.test(d)));
  // The terminal off: a clear refusal, the tool itself stays in the list (no restart to turn it on).
  assert.match(createPolicy({ disabledTools: TERMINAL_TOOLS }).check('start_process', { command: 'dir' }), /terminal is off/);
});
