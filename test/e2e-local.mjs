// Manual end-to-end check against the REAL bundled Desktop Commander (not run by `npm test`):
//   node test/e2e-local.mjs
// Uses a throw-away USERPROFILE so an existing Desktop Commander config on this PC is untouched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-e2e-'));
const prof = path.join(root, 'profile');
const work = path.join(root, 'work');
const secret = path.join(work, 'Secret');
fs.mkdirSync(path.join(secret, 'deep'), { recursive: true });
fs.mkdirSync(prof);
fs.writeFileSync(path.join(work, 'notes.txt'), 'needle in notes\n');
fs.writeFileSync(path.join(secret, 'deep', 'pw.txt'), 'needle password\n');
fs.symlinkSync(secret, path.join(work, 'shortcut'), 'junction');
process.env.USERPROFILE = prof; process.env.HOME = prof;

const { startDesktopCommander } = await import('../src/bridge.mjs');
const dc = await startDesktopCommander({ allowedDirectories: [work], deniedDirectories: [secret] }, () => {});
const text = (r) => (r.content || []).map((c) => c.text).join('\n');
try {
  assert.ok(!dc.tools.some((t) => t.name === 'set_config_value'), 'set_config_value must be hidden');
  const cfg = text(await dc.client.callTool({ name: 'get_config', arguments: {} }));
  assert.ok(cfg.toLowerCase().includes(work.toLowerCase().replace(/\\/g, '\\\\')), 'allowedDirectories pushed into DC');

  assert.match(text(await dc.call('read_file', { path: path.join(work, 'notes.txt') })), /needle in notes/);
  assert.match(text(await dc.call('read_file', { path: path.join(secret, 'deep', 'pw.txt') })), /excluded/);
  assert.match(text(await dc.call('read_file', { path: path.join(work, 'shortcut', 'deep', 'pw.txt') })), /excluded/);
  assert.match(text(await dc.call('read_file', { path: path.join(root, 'profile', 'x') })), /not allowed/i);

  const list = text(await dc.call('list_directory', { path: work, depth: 3 }));
  console.log('--- list_directory ---\n' + list);
  assert.match(list, /notes\.txt/);
  assert.doesNotMatch(list, /pw\.txt/);

  const s = text(await dc.call('start_search', { path: work, pattern: 'needle', searchType: 'content' }));
  const sid = (s.match(/session[^\w]*([\w-]{6,})/i) || [])[1];
  let hits = s;
  if (sid) { await new Promise((r) => setTimeout(r, 2500)); hits += '\n' + text(await dc.call('get_more_search_results', { sessionId: sid })); }
  console.log('--- search ---\n' + hits);
  assert.match(hits, /notes\.txt/);
  assert.doesNotMatch(hits, /pw\.txt/);

  assert.match(text(await dc.call('start_process', { command: `Get-Content "${path.join(secret, 'deep', 'pw.txt')}"`, timeout_ms: 5000 })), /excluded/);
  assert.match(text(await dc.call('set_config_value', { key: 'allowedDirectories', value: [] })), /disabled/);
  console.log('E2E OK');
} finally {
  await dc.close();
  fs.rmSync(root, { recursive: true, force: true });
}
