// End to end on one machine: the REAL relay (sibling repo, in this process, https/wss with a test
// certificate) ↔ a REAL bridge process with the bundled engine ↔ a fake "ChatGPT" talking MCP over
// HTTP with an OAuth token. Covers key-less pairing, tool calls with Cyrillic paths and output, the
// deny list, a confirmation answered on the PC (Deny, then Allow), pause, widgets, and the link
// dropping mid-call with the bridge coming back by itself. No relay next to this repo → loud skip.
// LOGIC: see critical-logic/architecture.md, bridge.md, relay.md; engineering-process.md §2.2 item 5.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { selfSignedCert } from './helpers/tls.mjs';
import { relayMissing, startRelay, textOf } from './helpers/relay.mjs';
import { startBridgeChild } from './helpers/bridge-proc.mjs';

const missing = relayMissing();
const EMAIL = 'ivan.petrov@example.com', PW = 'ivan-password-2026';
let relay, pc, tok, work, secret, notes;
const answers = [];          // what the person at the PC clicks, in order
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  if (missing) return;
  const pem = selfSignedCert();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem.cert]);
  relay = await startRelay({ tls: pem });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-e2e-relay-'));
  work = path.join(root, 'Документы Ивана');
  secret = path.join(work, 'Секретное');
  fs.mkdirSync(secret, { recursive: true });
  notes = path.join(work, 'заметки 2026.txt');
  fs.writeFileSync(notes, 'Привет из заметок\n');
  fs.writeFileSync(path.join(secret, 'пароли.txt'), 'nope\n');
  pc = startBridgeChild({ pair: true, site: relay.base, relay: relay.wsUrl, name: 'Ноутбук Ивана', allowedDirectories: [work], deniedDirectories: [secret] }, {
    cert: pem.cert,
    root: path.join(root, 'pc'),
    onOpen: (url) => { const code = new URL(url).searchParams.get('code'); relay.confirmPair(EMAIL, PW, code).catch((e) => console.error(e)); },
    onAsk: () => answers.shift() ?? 'deny',
  });
});
after(async () => { await pc?.stop(); await relay?.close(); });

test('key-less pairing: the code page is opened, the owner confirms it, the PC gets its key and comes online', { skip: missing || false }, async () => {
  const opened = await pc.waitFor(() => pc.events.find((e) => e.ev === 'open'), 'pairing page');
  assert.match(opened.url, new RegExp(`^${relay.base}/pair\\?code=[A-Z0-9]{4}-[A-Z0-9]{4}$`));
  const paired = await pc.waitFor(() => pc.events.find((e) => e.ev === 'paired'), 'paired');
  assert.deepEqual(paired, { ev: 'paired', name: 'Ноутбук Ивана', email: EMAIL });
  await pc.online();
  assert.equal(relay.store.devicesOf(EMAIL).length, 1);
  assert.equal(relay.store.devicesOf(EMAIL)[0].name, 'Ноутбук Ивана');
  tok = await relay.token(EMAIL, PW);
});

test('ChatGPT sees the PC tools (engine + Bridgerator own); a PC on defaults is not interviewed (owner 21.10)', { skip: missing || false }, async () => {
  const list = (await relay.mcp(tok, 'tools/list')).result.tools.map((t) => t.name);
  for (const t of ['read_file', 'start_process', 'bridgerator_setup', 'bridgerator_settings', 'request_confirm_off', 'queue_next']) assert.ok(list.includes(t), t);
  for (const t of ['set_config_value', 'write_pdf', 'get_recent_tool_calls']) assert.ok(!list.includes(t), `${t} hidden`);
  const init = await relay.mcp(tok, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-chatgpt', version: '1' } });
  assert.match(init.result.instructions, /has the default settings.*Nothing needs setting up/s);
});

test('tool calls through the relay: Cyrillic file names and UTF-8 command output come back intact', { skip: missing || false }, async () => {
  assert.match(textOf(await relay.callTool(tok, 'read_file', { path: notes })), /Привет из заметок/);
  const out = textOf(await relay.callTool(tok, 'start_process', { command: 'Write-Output "Здравствуй, мир — ёЁ"', timeout_ms: 15000 }));
  assert.match(out, /Здравствуй, мир — ёЁ/, 'no code-page garbage (1.0.1 fix)');
  const ls = textOf(await relay.callTool(tok, 'list_directory', { path: work }));
  assert.match(ls, /заметки 2026\.txt/);
  assert.doesNotMatch(ls, /пароли/, 'the excluded child folder is hidden from the listing');
});

test('the deny list holds end to end: file tools and commands naming the excluded folder are refused, not counted', { skip: missing || false }, async () => {
  const month = new Date().toISOString().slice(0, 7);
  const before = relay.store.usage(EMAIL).calls;
  const r = await relay.callTool(tok, 'read_file', { path: path.join(secret, 'пароли.txt') });
  assert.equal(r.isError, true); assert.match(textOf(r), /excluded folder/);
  assert.match(textOf(await relay.callTool(tok, 'start_process', { command: `Get-Content "${path.join(secret, 'пароли.txt')}"`, timeout_ms: 5000 })), /excluded folder/);
  assert.match(textOf(await relay.callTool(tok, 'read_file', { path: path.join(pc.home, 'AppData', 'Roaming', 'Bridgerator', 'config.json') })), /excluded folder/, 'its own key and settings');
  assert.equal(relay.store.usage(EMAIL).calls, before, `refusals are refunded (${month})`);
});

test('confirmation on the PC: Deny keeps the file, Allow deletes it; the question shows the command', { skip: missing || false }, async () => {
  assert.match(textOf(await relay.callTool(tok, 'confirm_on', {})), /Confirmations are on/);
  const victim = path.join(work, 'старый отчёт.txt');
  fs.writeFileSync(victim, 'x');
  answers.push('deny');
  const denied = await relay.callTool(tok, 'start_process', { command: `Remove-Item -LiteralPath "${victim}"`, timeout_ms: 10000 });
  assert.equal(denied.isError, true); assert.match(textOf(denied), /did not allow/);
  assert.ok(fs.existsSync(victim), 'denied: nothing ran');
  const q = pc.asks.at(-1);
  assert.equal(q.head, 'ChatGPT wants to delete files');
  assert.match(q.text, /старый отчёт\.txt/);
  answers.push('allow');
  await relay.callTool(tok, 'start_process', { command: `Remove-Item -LiteralPath "${victim}"`, timeout_ms: 10000 });
  assert.ok(!fs.existsSync(victim), 'allowed: deleted');
  // The AI can only ASK to turn confirmations off; the person says no.
  answers.push('deny');
  assert.match(textOf(await relay.callTool(tok, 'request_confirm_off', {})), /^declined/);
  assert.match(fs.readFileSync(path.join(pc.home, 'AppData', 'Roaming', 'Bridgerator', 'confirm.ini'), 'utf8'), /enabled = true/);
});

test('paused on the PC: calls are refused with a clear text and not counted; resume works', { skip: missing || false }, async () => {
  pc.child.send({ cmd: 'pause', on: true });
  await sleep(200);
  const before = relay.store.usage(EMAIL).calls;
  const r = await relay.callTool(tok, 'read_file', { path: notes });
  assert.equal(r.isError, true); assert.match(textOf(r), /paused/);
  assert.equal(relay.store.usage(EMAIL).calls, before);
  pc.child.send({ cmd: 'pause', on: false });
  await sleep(200);
  assert.match(textOf(await relay.callTool(tok, 'read_file', { path: notes })), /Привет/);
});

test('the file-preview widget is read from the PC', { skip: missing || false }, async () => {
  const r = await relay.mcp(tok, 'resources/read', { uri: 'ui://desktop-commander/file-preview' });
  assert.match(r.result.contents[0].text, /<html|<!doctype/i);
});

test('the link drops mid-call: ChatGPT gets "PC disconnected" at once, the bridge reconnects by itself and works again', { skip: missing || false }, async () => {
  const slow = relay.callTool(tok, 'start_process', { command: 'Start-Sleep -Seconds 20; "finished"', timeout_ms: 30000 });
  await sleep(1500);
  const t0 = Date.now();
  relay.dropAll();
  const r = await slow;
  assert.equal(r.isError, true); assert.match(textOf(r), /PC disconnected/);
  assert.ok(Date.now() - t0 < 3000, 'answered at once, not after the 10-minute timeout');
  await pc.waitFor(() => pc.logs.some((l) => /disconnected \(close 1006\); reconnecting in 5s/.test(l)), 'reconnect scheduled');
  const n = pc.events.filter((e) => e.ev === 'link' && e.state === 'online').length;
  await pc.waitFor(() => pc.events.filter((e) => e.ev === 'link' && e.state === 'online').length > n, 'online again', 20000);
  assert.match(textOf(await relay.callTool(tok, 'read_file', { path: notes })), /Привет/);
  assert.equal(pc.notices.length, 0, 'no notification was needed');
});
