import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPolicy, debrandResult } from '../src/policy.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgerator-'));
// The test folders live in %TEMP% (inside AppData, which is always excluded): point the built-in
// excluded folders at a fake profile instead.
const fakeHome = path.join(root, 'fakehome');
const realHome = os.homedir();
Object.assign(process.env, { USERPROFILE: fakeHome, APPDATA: path.join(fakeHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') });
const secret = path.join(root, 'Secret');
fs.mkdirSync(path.join(secret, 'deep'), { recursive: true });
fs.mkdirSync(path.join(root, 'Secretive'));
const link = path.join(root, 'shortcut');
fs.symlinkSync(secret, link, 'junction');
const p = createPolicy({ deniedDirectories: [secret], disabledTools: ['kill_process'] });

test('paths inside an excluded folder are refused, any case / slash style', () => {
  assert.match(p.check('read_file', { path: path.join(secret, 'a.txt') }), /excluded/);
  assert.match(p.check('read_file', { path: secret.toUpperCase() + '\\deep\\x' }), /excluded/);
  assert.match(p.check('list_directory', { path: secret.replace(/\\/g, '/') }), /excluded/);
  assert.match(p.check('read_multiple_files', { paths: [path.join(root, 'ok.txt'), path.join(secret, 'b')] }), /excluded/);
  assert.match(p.check('move_file', { source: path.join(root, 'x'), destination: path.join(secret, 'x') }), /excluded/);
  assert.match(p.check('edit_block', { file_path: path.join(secret, 'c') }), /excluded/);
});

test('a junction pointing into the excluded folder is refused too', () => {
  assert.match(p.check('read_file', { path: path.join(link, 'deep', 'f.txt') }), /excluded/);
});

test('siblings with a common prefix stay allowed', () => {
  assert.equal(p.check('read_file', { path: path.join(root, 'Secretive', 'x') }), null);
  assert.equal(p.check('list_directory', { path: root }), null);
});

test('commands naming the excluded folder are refused', () => {
  assert.match(p.check('start_process', { command: `type "${secret}\\a.txt"` }), /excluded/);
  assert.equal(p.check('start_process', { command: 'Get-Date' }), null);
});

test('set_config_value and disabledTools are hidden and refused', () => {
  assert.equal(p.visible({ name: 'set_config_value' }), false);
  assert.equal(p.visible({ name: 'kill_process' }), false);
  assert.equal(p.visible({ name: 'read_file' }), true);
  assert.match(p.check('set_config_value', { key: 'allowedDirectories', value: [] }), /disabled/);
});

test('result lines revealing the excluded folder are dropped', () => {
  const r = p.filter({ content: [{ type: 'text', text: [
    `${path.join(root, 'ok.txt')}:1: hello`,
    `${path.join(secret, 'deep', 'pw.txt')}:3: password`,
    `"${secret.replace(/\\/g, '\\\\')}\\\\x.txt"`,
    `${path.join(root, 'Secretive', 'y.txt')}`,
  ].join('\n') }] }, 'start_search', { path: root });
  const text = r.content.map((c) => c.text).join('\n');
  assert.match(text, /ok\.txt/);
  assert.match(text, /Secretive/);
  assert.doesNotMatch(text, /pw\.txt|x\.txt/);
  assert.match(text, /2 line\(s\) naming an excluded folder were left out; everything else above is complete — not an error/);
  // The text of an allowed file is the person's own: a line naming the excluded folder stays (E2E 26.10).
  const doc = { content: [{ type: 'text', text: `notes\nlogs are in ${path.join(secret, 'deep')}\nend` }] };
  for (const t of ['read_file', 'read_multiple_files']) assert.deepEqual(p.filter(doc, t, { path: path.join(root, 'notes.md') }), doc, t);
});

test('a listing of the parent hides the excluded child entries', () => {
  const r = p.filter({ content: [{ type: 'text', text: '[DIR] Secret\n[DIR] Secret\\deep\n[DIR] Secretive\n[FILE] a.txt' }] }, 'list_directory', { path: root });
  const text = r.content[0].text;
  assert.doesNotMatch(text, /Secret(\n|\\|$)/);
  assert.match(text, /Secretive/);
  assert.match(text, /a\.txt/);
});

test('engine texts in results: get_prompts debranded, get_config shows the bridge version; other results untouched', () => {
  const pr = debrandResult('get_prompts', { content: [{ type: 'text', text: '📚 **Desktop Commander Prompt Categories**' }] }, '9.9.9');
  assert.equal(pr.content[0].text, '📚 **Bridgerator Prompt Categories**');
  const cfg = { version: '0.2.52', telemetryEnabled: false };
  const gc = debrandResult('get_config', { content: [{ type: 'text', text: `Current configuration:\n${JSON.stringify(cfg, null, 2)}` }], structuredContent: { config: cfg } }, '9.9.9');
  assert.match(gc.content[0].text, /"version": "9\.9\.9"/);
  assert.equal(gc.structuredContent.config.version, '9.9.9');
  const file = { content: [{ type: 'text', text: 'Desktop Commander notes "version": "0.2.52"' }] };
  assert.equal(debrandResult('read_file', file, '9.9.9'), file);
});

test('hardening: URL reads, PDF export, call log and UNC/device paths refused; nested path args checked; built-in exclusions', () => {
  assert.equal(p.visible({ name: 'write_pdf' }), false);
  assert.equal(p.visible({ name: 'get_recent_tool_calls' }), false);
  assert.match(p.check('read_file', { path: 'https://example.com/x', isUrl: true }), /URLs/);
  for (const u of ['\\\\server\\share\\a.txt', '//server/share', '\\\\?\\C:\\x', '\\\\.\\PhysicalDrive0']) assert.match(p.check('read_file', { path: u }), /network and device/);
  assert.match(p.check('some_tool', { options: { outputPath: path.join(secret, 'o.pdf') } }), /excluded/);
  assert.match(p.check('some_tool', { items: [{ file: path.join(secret, 'a') }] }), /excluded/);
  for (const d of [path.join(process.env.APPDATA, 'Bridgerator', 'config.json'), path.join(fakeHome, '.ssh', 'id_rsa'), path.join(fakeHome, '.gitconfig'), path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'x.lnk')]) {
    assert.match(createPolicy({ deniedDirectories: [] }).check('read_file', { path: d }), /excluded/, d);
  }
});

test('read-only folders: reads allowed, every write tool refused (move_file on either side)', () => {
  const ro = path.join(root, 'Archive');
  const q = createPolicy({ readOnlyDirectories: [ro] });
  assert.equal(q.check('read_file', { path: path.join(ro, 'a.txt') }), null);
  assert.equal(q.check('list_directory', { path: ro }), null);
  for (const [n, a] of [['write_file', { path: path.join(ro, 'a.txt') }], ['edit_block', { file_path: path.join(ro, 'a.txt') }], ['create_directory', { path: path.join(ro, 'new') }],
    ['move_file', { source: path.join(ro, 'a'), destination: path.join(root, 'b') }], ['move_file', { source: path.join(root, 'b'), destination: path.join(ro, 'a') }]]) {
    assert.match(q.check(n, a), /read-only/, n);
  }
  assert.equal(q.check('write_file', { path: path.join(root, 'ArchiveX', 'a.txt') }), null);
  assert.match(q.check('start_process', { command: 'bridgerator.cmd confirm off' }), /person at this PC/);
  for (const c of ['notepad %APPDATA%\\Bridgerator\\confirm.ini', 'Get-Content $env:APPDATA\\Bridgerator\\config.json', 'type ${env:APPDATA}\\Bridgerator\\queue.json',
    'Stop-Process -Name BRIDGERATOR', 'schtasks /Delete /TN Bridgerator-S-1-5', 'cat ~/.ssh/id_rsa']) assert.match(q.check('start_process', { command: c }), /Bridgerator|excluded/, c);
  assert.equal(q.check('start_process', { command: 'Get-ChildItem D:\\Work' }), null);
});

test('variables in commands are expanded before the folder check', async () => {
  const { expandVars } = await import('../src/policy.mjs');
  assert.equal(expandVars('%FOO%\\x $env:foo ${env:FOO} ~\\y', { FOO: 'C:\\F' }, 'C:\\H'), 'C:\\F\\x C:\\F C:\\F C:\\H\\y');
  assert.equal(expandVars('%NOPE% a~b', {}, 'C:\\H'), '%NOPE% a~b');
  assert.match(createPolicy({}).check('start_process', { command: 'type %USERPROFILE%\\.ssh\\id_rsa' }), /excluded/);
});

test('hard-linked files are never written; deep / huge arguments refused', () => {
  const q = createPolicy({});
  const a = path.join(root, 'orig.txt'), b = path.join(root, 'link.txt');
  fs.writeFileSync(a, 'x'); fs.linkSync(a, b);
  assert.match(q.check('write_file', { path: b }), /hard-linked/);
  assert.match(q.check('edit_block', { file_path: a }), /hard-linked/);
  assert.equal(q.check('read_file', { path: b }), null, 'reading is fine');
  assert.equal(q.check('write_file', { path: path.join(root, 'new.txt') }), null);
  let deep = { path: 'x' }; for (let i = 0; i < 20; i++) deep = { a: deep };
  assert.match(q.check('some_tool', deep), /too deeply nested/);
  assert.match(q.check('some_tool', { items: Array.from({ length: 6000 }, () => 'x') }), /too large/);
});
