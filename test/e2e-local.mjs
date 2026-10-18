// End-to-end check against the REAL bundled Desktop Commander (also part of `npm test`):
//   node test/e2e-local.mjs
// Proves isolation: a Desktop Commander config the user already has must stay byte-identical.
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
const userDc = path.join(os.homedir(), '.claude-server-commander', 'config.json');
const before = fs.existsSync(userDc) ? fs.readFileSync(userDc, 'utf8') : null;

const { startDesktopCommander } = await import('../src/bridge.mjs');
const dc = await startDesktopCommander({ allowedDirectories: [work], deniedDirectories: [secret], dcConfigDir: path.join(prof, 'dc') }, () => {});
const text = (r) => (r.content || []).map((c) => c.text).join('\n');
try {
  assert.ok(!dc.tools.some((t) => t.name === 'set_config_value'), 'set_config_value must be hidden');
  const cfg = text(await dc.client.callTool({ name: 'get_config', arguments: {} }));
  assert.ok(cfg.toLowerCase().includes(work.toLowerCase().replace(/\\/g, '\\\\')), 'allowedDirectories pushed into DC');

  assert.match(text(await dc.call('read_file', { path: path.join(work, 'notes.txt') })), /needle in notes/);
  // MCP Apps widgets of the original plugin: tools keep their ui:// template, resources are served.
  assert.equal(dc.tools.find((t) => t.name === 'read_file')?._meta?.['openai/outputTemplate'], 'ui://desktop-commander/file-preview');
  assert.ok(dc.resources.some((r) => r.uri === 'ui://desktop-commander/file-preview'));
  const w = await dc.readResource('ui://desktop-commander/file-preview');
  assert.match(w.result.contents[0].text, /<html|<!doctype/i);
  assert.equal((await dc.readResource('file:///etc/passwd')).error, 'unknown resource');
  // No trace of the bundled engine's brand or site in anything the user/assistant sees.
  assert.doesNotMatch(JSON.stringify(dc.tools), /Desktop Commander|desktopcommander\.app/);
  assert.doesNotMatch(w.result.contents[0].text, /Desktop Commander|desktopcommander\.app/);
  // Desktop Commander's default command blocklist stays in force (we don't replace it).
  const cfgNow = text(await dc.client.callTool({ name: 'get_config', arguments: {} }));
  for (const c of ['reg', 'net', 'runas', 'diskpart']) assert.ok(cfgNow.includes(JSON.stringify(c)), 'default blockedCommands keeps ' + c);
  assert.match(text(await dc.call('read_file', { path: path.join(secret, 'deep', 'pw.txt') })), /excluded/);
  assert.match(text(await dc.call('read_file', { path: path.join(work, 'shortcut', 'deep', 'pw.txt') })), /excluded/);
  assert.match(text(await dc.call('read_file', { path: path.join(root, 'outside.txt') })), /not allowed/i);

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
  assert.ok(fs.existsSync(path.join(prof, 'dc', 'config.json')), 'bridge DC config written to its own folder');
  assert.equal(fs.existsSync(userDc) ? fs.readFileSync(userDc, 'utf8') : null, before, 'user Desktop Commander config must be untouched');
  // Remote feature flags (welcome page, promo injections) never fetched: the cache holds our empty set.
  const flags = path.join(prof, 'dc', 'feature-flags.json');
  if (fs.existsSync(flags)) assert.deepEqual(JSON.parse(fs.readFileSync(flags, 'utf8')).flags || {}, {});
  console.log('E2E OK');
} finally {
  await dc.close();
  fs.rmSync(root, { recursive: true, force: true });
}
