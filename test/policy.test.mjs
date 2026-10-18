import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPolicy } from '../src/policy.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgerator-'));
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
  assert.match(text, /2 line\(s\) hidden/);
});

test('a listing of the parent hides the excluded child entries', () => {
  const r = p.filter({ content: [{ type: 'text', text: '[DIR] Secret\n[DIR] Secret\\deep\n[DIR] Secretive\n[FILE] a.txt' }] }, 'list_directory', { path: root });
  const text = r.content[0].text;
  assert.doesNotMatch(text, /Secret(\n|\\|$)/);
  assert.match(text, /Secretive/);
  assert.match(text, /a\.txt/);
});
