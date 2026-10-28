import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSettings, widens, describe } from '../src/settings-tool.mjs';

const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-set-'));
const A = path.join(d, 'A'), B = path.join(d, 'B');
fs.mkdirSync(A); fs.mkdirSync(B);
const cur = { confirm: { enabled: true, ask: { delete: true, dangerous_commands: true, write_files: false, move: false, any_command: false } }, autostart: true, telemetry: false, localHistory: false, allowedDirectories: [A], readOnlyDirectories: [B] };
const w = (key, value) => widens(cur, { key, value });

test('bridgerator_settings: strict validation', () => {
  assert.deepEqual(validateSettings({ theme: 'dark', notify: { sound: false }, confirm: { delete: false } }).changes, [{ key: 'theme', value: 'dark' }, { key: 'notify.sound', value: false }, { key: 'confirm.delete', value: false }]);
  for (const [bad, re] of [[{ blockedCommands: 'rm' }, /list/], [{ confirm: { patterns: ['('] } }, /regular expressions/], [{ deniedDirectories: [] }, /unknown/], [{ theme: 'pink' }, /one of/], [{ confirm: { nuke: true } }, /unknown/], [{ autostart: 'yes' }, /true or false/], [{ deviceName: 'x'.repeat(41) }, /40/], [{ allowedDirectories: ['\\\\srv\\x'] }, /network/], [{}, /nothing/]]) assert.match(validateSettings(bad).error, re, JSON.stringify(bad));
});

test('what needs the person: lowering protection / widening access — and what does not', () => {
  // direct
  for (const [k, v] of [['theme', 'light'], ['language', 'ru'], ['popupStyle', 'popup'], ['notify.sound', false], ['deviceName', 'X'], ['localHistory', false], ['telemetryEnabled', false], ['confirm.write_files', true], ['confirm.enabled', true], ['readOnlyDirectories', [B, A]]]) assert.equal(w(k, v), false, `${k} direct`);
  assert.equal(widens({ ...cur, allowedDirectories: [] }, { key: 'allowedDirectories', value: [A] }), false, 'all → a list narrows');
  assert.equal(widens({ ...cur, allowedDirectories: [A, B] }, { key: 'allowedDirectories', value: [A] }), false, 'removing a folder narrows');
  // needs OK
  for (const [k, v] of [['confirm.enabled', false], ['confirm.delete', false], ['allowedDirectories', [A, B]], ['allowedDirectories', []], ['readOnlyDirectories', []], ['autostart', false], ['telemetryEnabled', true], ['localHistory', true]]) assert.equal(w(k, v), true, `${k}=${JSON.stringify(v)} needs OK`);
  assert.equal(describe(cur, { key: 'allowedDirectories', value: [] }), 'Folders: all (except always-blocked)');
  assert.equal(describe(cur, { key: 'confirm.delete', value: false }), 'Confirm deletions: off');
});

test('VM10-9: the answer timeout is described as such, not as "Confirm undefined"', () => {
  assert.equal(describe(cur, { key: 'confirm.timeout', value: 300 }), 'No answer = Deny after: 300 s');
});

test('B1-21: a preset is expanded against the folder list of the same request', async () => {
  const { expandPresets } = await import('../src/settings-tool.mjs');
  const s = { terminal: true, allowedDirectories: [], readOnlyDirectories: [] };
  const out = expandPresets([{ key: 'preset', value: 'read_only' }, { key: 'allowedDirectories', value: [A] }], s, ['C:\\', 'D:\\']);
  assert.deepEqual(out.at(-1), { key: 'readOnlyDirectories', value: [A] }, 'the new folder, not every drive');
  assert.deepEqual(out[0], { key: 'allowedDirectories', value: [A] });
});

test('turning the settings-changed notice off is a lowering (asks with askSettings on); on is not (review 26.10)', async () => {
  const { widens } = await import('../src/settings-tool.mjs');
  assert.equal(widens({ notify: { settingsChanged: true } }, { key: 'notify.settingsChanged', value: false }), true);
  assert.equal(widens({ notify: { settingsChanged: false } }, { key: 'notify.settingsChanged', value: true }), false);
  assert.equal(widens({ notify: { sound: true } }, { key: 'notify.sound', value: false }), false);
});

test('review R1/R2/R6: confirm patterns are one line, without nested repeats, and an unchanged list is not a removal', async () => {
  const { safePattern } = await import('../src/settings-tool.mjs');
  for (const bad of ['(a+)+$', '(\\w*)*x', '(x+){2,}', 'a\nb', 'a\r[confirm]', '(']) assert.equal(safePattern(bad), false, JSON.stringify(bad));
  for (const ok of ['\\bgit\\s+push\\b', 'rm -rf', '(foo|bar)+', 'C:/Секрет']) assert.equal(safePattern(ok), true, ok);
  assert.match(validateSettings({ confirm: { patterns: ['x\r\n[confirm]\r\nenabled = false'] } }).error, /one-line/);
  const c = { ...cur, confirm: { ...cur.confirm, patterns: [new RegExp('a/b', 'i')] } };
  assert.equal(widens(c, { key: 'confirm.patterns', value: ['a/b'] }), false, 'same pattern as written');
  assert.equal(widens(c, { key: 'confirm.patterns', value: [] }), true);
  assert.equal(widens(c, { key: 'update', value: true }), true, 'update asks when askSettings is on');
});
