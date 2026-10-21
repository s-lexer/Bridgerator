import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateSetup, summarizeSetup, applySetup } from '../src/setup-tool.mjs';
import { ensureIni, readSettings } from '../src/confirm.mjs';
import { ASK_PS } from '../src/ask.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-setup-'));
const work = path.join(dir, 'Work'), photos = path.join(dir, 'Photos');
fs.mkdirSync(work); fs.mkdirSync(photos);

test('bridgerator_setup input is validated strictly', () => {
  assert.deepEqual(validateSetup({ allowedDirectories: [work, photos], readOnlyDirectories: [photos], confirm: { enabled: true, delete: true } }).value,
    { allowedDirectories: [work, photos], readOnlyDirectories: [photos], confirm: { enabled: true, delete: true } });
  for (const [bad, re] of [
    [{ blockedCommands: [] }, /unknown setting/], [{ telemetryEnabled: false }, /unknown setting/], [{ deniedDirectories: [] }, /unknown setting/],
    [{ allowedDirectories: ['\\\\server\\share'] }, /network/], [{ allowedDirectories: ['https://x.y/'] }, /network paths and URLs/],
    [{ allowedDirectories: ['relative\\dir'] }, /absolute/], [{ allowedDirectories: [path.join(dir, 'nope')] }, /existing folder/],
    [{ allowedDirectories: Array(21).fill(work) }, /at most 20/],
    [{ confirm: { enabled: 'yes' } }, /non-boolean/], [{ confirm: { format_disk: true } }, /unknown/], [{}, /nothing to change/], [null, /object/],
  ]) assert.match(validateSetup(bad).error, re, JSON.stringify(bad));
});

test('apply writes only folders, setupDone and confirm.ini; summary is one short line', () => {
  const cfgFile = path.join(dir, 'config.json'), ini = path.join(dir, 'confirm.ini');
  fs.writeFileSync(cfgFile, JSON.stringify({ relay: 'wss://r', token: 't', allowedDirectories: ['C:\\Users\\x'], blockedCommands: ['format'], telemetryEnabled: true }));
  ensureIni(ini);
  const v = validateSetup({ allowedDirectories: [work, photos], readOnlyDirectories: [photos], confirm: { enabled: true } }).value;
  assert.equal(summarizeSetup({}, ini, v), `Folders: ${work}, ${photos} (read-only) · confirm deletions, system commands: on`);
  const next = applySetup(cfgFile, ini, v);
  assert.deepEqual(next, { relay: 'wss://r', token: 't', allowedDirectories: [work, photos], blockedCommands: ['format'], telemetryEnabled: true, readOnlyDirectories: [photos], setupDone: true });
  assert.equal(readSettings(ini).enabled, true);
});

test('the question script: texts only through environment variables, toast buttons via a compiled event sink', () => {
  assert.doesNotMatch(ASK_PS, /\$\{/); // nothing interpolated by JS
  assert.match(ASK_PS, /\$env:BR_HEAD/);
  assert.match(ASK_PS, /scenario='reminder'/);
  assert.match(ASK_PS, /placement='contextMenu'/);
  assert.match(ASK_PS, /History\.Remove/);
});

test('settings proposal as a diff: added / removed folders with counts, confirm switches; long → window review', async () => {
  const { diffSetup } = await import('../src/setup-tool.mjs');
  const ini = path.join(dir, 'diff.ini'); ensureIni(ini);
  const d = diffSetup({ allowedDirectories: [work, 'C:\\Old'] }, ini, { allowedDirectories: [work, photos], confirm: { enabled: true } });
  assert.deepEqual(d.lines, ['Folders: 2 → 2', `  + ${photos}`, '  − C:\\Old', 'Confirmations: on']);
  assert.equal(d.short, `Folders: +${photos}, −C:\\Old · Confirmations: on`);
  const many = Array.from({ length: 15 }, (_, i) => `C:\\Folder-number-${i}`);
  assert.ok(diffSetup({ allowedDirectories: [] }, ini, { allowedDirectories: many }).short.length > 180, 'too long for a notification → reviewed in the window');
});

test('empty folder list = all folders (except always-blocked); diff says so', async () => {
  const { diffSetup } = await import('../src/setup-tool.mjs');
  assert.deepEqual(validateSetup({ allowedDirectories: [] }).value, { allowedDirectories: [] });
  const ini = path.join(dir, 'all.ini'); ensureIni(ini);
  assert.equal(diffSetup({ allowedDirectories: [work] }, ini, { allowedDirectories: [] }).short, 'Folders: all (except always-blocked)');
  assert.equal(diffSetup({ allowedDirectories: [] }, ini, { allowedDirectories: [work] }).short, `Folders: only ${work}`);
});
