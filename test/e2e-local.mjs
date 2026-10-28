// End-to-end check against the REAL bundled engine (also part of `npm test`):
//   node test/e2e-local.mjs
// Proves isolation: an engine config the user already has (own copy of the engine) must stay byte-identical.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-e2e-'));
// The test folders live in %TEMP% (inside AppData, which is always excluded): point the built-in
// excluded folders at a fake profile instead.
const fakeHome = path.join(root, 'fakehome');
const realHome = os.homedir();
Object.assign(process.env, { USERPROFILE: fakeHome, APPDATA: path.join(fakeHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') });
const prof = path.join(root, 'profile');
const work = path.join(root, 'work');
const secret = path.join(work, 'Secret');
fs.mkdirSync(path.join(secret, 'deep'), { recursive: true });
fs.mkdirSync(prof);
fs.writeFileSync(path.join(work, 'notes.txt'), 'needle in notes\n');
fs.writeFileSync(path.join(secret, 'deep', 'pw.txt'), 'needle password\n');
fs.symlinkSync(secret, path.join(work, 'shortcut'), 'junction');
const userDc = path.join(realHome, '.claude-server-commander', 'config.json');
const before = fs.existsSync(userDc) ? fs.readFileSync(userDc, 'utf8') : null;
const userHist = path.join(realHome, '.claude-server-commander', 'tool-history.jsonl');
const histBefore = fs.existsSync(userHist) ? fs.statSync(userHist).size : -1;

const { startEngine } = await import('../src/bridge.mjs');
const dc = await startEngine({ allowedDirectories: [work], deniedDirectories: [secret], dcConfigDir: path.join(prof, 'dc') }, () => {});
const text = (r) => (r.content || []).map((c) => c.text).join('\n');
try {
  assert.ok(!dc.tools.some((t) => t.name === 'set_config_value'), 'set_config_value must be hidden');
  const cfg = text(await dc.client.callTool({ name: 'get_config', arguments: {} }));
  assert.ok(cfg.toLowerCase().includes(work.toLowerCase().replace(/\\/g, '\\\\')), 'allowedDirectories pushed into DC');

  assert.match(text(await dc.call('read_file', { path: path.join(work, 'notes.txt') })), /needle in notes/);
  // MCP Apps widgets of the original plugin: tools keep their ui:// template, resources are served.
  assert.equal(dc.tools.find((t) => t.name === 'read_file')?._meta?.['openai/outputTemplate'], 'ui://bridgerator/file-preview');
  assert.ok(dc.resources.some((r) => r.uri === 'ui://bridgerator/file-preview'));
  const w = await dc.readResource('ui://bridgerator/file-preview');
  assert.match(w.result.contents[0].text, /<html|<!doctype/i);
  assert.equal((await dc.readResource('file:///etc/passwd')).error, 'unknown resource');
  // The config widget can't save (set_config_value hidden): its read-only message points to ChatGPT (owner 27.10).
  const ce = dc.resources.find((r) => /config/.test(r.uri));
  assert.match((await dc.readResource(ce.uri)).result.contents[0].text, /ask ChatGPT: it changes Bridgerator settings/);
  // Product rule (audit 27.10): every engine tool a widget calls must be listed AND widget-accessible, else a
  // button fails silently in ChatGPT. Known dead calls are in the ledger (FINDINGS_2026_10_27_PRODUCT_AUDIT.md).
  const KNOWN_DEAD = { set_config_value: 'neutralized: get_config entries read-only' };
  const engineTools = (await dc.client.listTools()).tools.map((t) => t.name);
  for (const r of dc.resources) {
    const html = (await dc.readResource(r.uri)).result.contents[0].text;
    assert.doesNotMatch(html, /"track_ui_event"|Open in Finder/, `${r.uri}: analytics call / Mac wording left`);
    for (const n of engineTools.filter((x) => html.includes(`"${x}"`))) {
      const t = dc.tools.find((x) => x.name === n);
      assert.ok((t && t._meta?.['openai/widgetAccessible'] === true) || KNOWN_DEAD[n], `${r.uri} calls ${n}: not listed / not widget-accessible`);
    }
  }
  // No trace of the bundled engine's brand or site in anything the user/assistant sees.
  assert.doesNotMatch(JSON.stringify(dc.tools), /Desktop ?Commander|"DC: |desktopcommander\.app/);
  assert.doesNotMatch(JSON.stringify(dc.resources), /Desktop Commander|desktop-commander/);
  assert.doesNotMatch(JSON.stringify(dc.tools), /desktop-commander/, 'widget URIs carry our name');
  assert.doesNotMatch(w.result.contents[0].text, /desktop-commander/, 'widget page: no engine name');
  assert.doesNotMatch(w.result.contents[0].text, /Desktop Commander|desktopcommander\.app/);
  // The engine's default command blocklist stays in force (we don't replace it).
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
  assert.equal(fs.existsSync(userDc) ? fs.readFileSync(userDc, 'utf8') : null, before, 'the user\'s own engine config must be untouched');
  assert.equal(fs.existsSync(userHist) ? fs.statSync(userHist).size : -1, histBefore, 'user engine tool history untouched');
  // Remote feature flags (welcome page, promo injections) never fetched: the cache holds our empty set.
  const flags = path.join(prof, 'dc', 'feature-flags.json');
  if (fs.existsSync(flags)) assert.deepEqual(JSON.parse(fs.readFileSync(flags, 'utf8')).flags || {}, {});
  // Nothing written to the shared engine folder; no Chrome pre-download.
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!fs.existsSync(path.join(prof, 'dc', 'tool-history.jsonl')), 'no on-disk tool history (arguments, output)');
  assert.ok(!fs.existsSync(path.join(prof, 'dc', 'puppeteer-cache')), 'no Chrome pre-download');
  // The terminal starts in the first allowed folder and sees no Bridgerator variables.
  const envOut = text(await dc.call('start_process', { command: '(Get-Location).Path; "DC=" + $env:BRIDGERATOR_DC_CONFIG_DIR; "BR=" + (Get-ChildItem env: | Where-Object Name -like "BR*" | ForEach-Object Name)', timeout_ms: 8000 }));
  assert.ok(envOut.toLowerCase().includes(work.toLowerCase()), `terminal cwd = allowed folder: ${envOut}`);
  assert.match(envOut, /DC=\s*(\r?\n|$)/); assert.doesNotMatch(envOut, /BRIDGERATOR_/);
  // Several chats at once: a slow command doesn't hold up the reads of other chats.
  const t0 = Date.now(), done = {};
  const mark = (k) => (r) => { done[k] = Date.now() - t0; return r; };
  const [slow, r1, r2] = await Promise.all([
    dc.call('start_process', { command: 'Start-Sleep -Seconds 2; "slept"', timeout_ms: 8000 }).then(mark('slow')),
    dc.call('read_file', { path: path.join(work, 'notes.txt') }).then(mark('r1')),
    dc.call('read_file', { path: path.join(work, 'notes.txt') }).then(mark('r2')),
  ]);
  console.log('--- parallel ---', done);
  assert.match(text(r1), /needle/); assert.match(text(r2), /needle/); assert.match(text(slow), /slept/);
  assert.ok(done.r1 < done.slow && done.r2 < done.slow && done.slow >= 1900, 'fast calls finish before the slow one');
  // Hardening: no PDF export / call-log tools, no URL reads, no UNC; no local log of call arguments.
  for (const t of ['write_pdf', 'get_recent_tool_calls']) assert.ok(!dc.tools.some((x) => x.name === t), `${t} hidden`);
  assert.match(text(await dc.call('read_file', { path: 'https://example.com/', isUrl: true })), /URLs/);
  assert.match(text(await dc.call('list_directory', { path: '\\\\127.0.0.1\\c$' })), /network and device/);
  assert.ok(!fs.existsSync(path.join(prof, 'dc', 'claude_tool_call.log')), 'no tool-argument log');
  assert.ok(!fs.existsSync(path.join(fakeHome, '.claude-server-commander-logs')), 'fuzzy-search log not in the home folder');
  console.log('E2E OK');
} finally {
  await dc.close();
  fs.rmSync(root, { recursive: true, force: true });
}
