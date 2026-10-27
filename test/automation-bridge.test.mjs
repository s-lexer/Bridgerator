// Automations, plan cards, the usage forecast and the relay notification fields inside the REAL
// bridge (src/bridge.mjs with the bundled engine) and over a real wss:// link to a hand-played relay.
// No Task Scheduler task is made (nothing here sets a schedule), no window or notification appears
// (PowerShell started through execFile is intercepted; questions are a fake).
// LOGIC: critical-logic/bridge.md ("Automations and recipes", "Plan card", "Relay notifications").
import { shown } from './helpers/no-popups.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { selfSignedCert } from './helpers/tls.mjs';
import { startFakeRelay } from './helpers/fake-relay.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-autobr-'));
const fakeHome = path.join(root, 'Иван Петров');
const APPDATA = path.join(fakeHome, 'AppData', 'Roaming'), LOCAL = path.join(fakeHome, 'AppData', 'Local');
Object.assign(process.env, { USERPROFILE: fakeHome, APPDATA, LOCALAPPDATA: LOCAL });
const DIR = path.join(APPDATA, 'Bridgerator'), SCRIPTS = path.join(LOCAL, 'Bridgerator', 'scripts');
const photos = path.join(root, 'Фото'), sorted = path.join(root, 'Разобрано');
for (const d of [DIR, photos, sorted]) fs.mkdirSync(d, { recursive: true });
for (let i = 1; i <= 4; i++) fs.writeFileSync(path.join(photos, `IMG_${i}.jpg`), `photo ${i}`);

const pem = selfSignedCert();
const relay = await startFakeRelay(pem);
tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem.cert]);
const { startEngine, connect } = await import('../src/bridge.mjs');
const { ensureIni, setIni } = await import('../src/confirm.mjs');
const CONFIG = path.join(DIR, 'config.json'), INI = path.join(DIR, 'confirm.ini');
const base = { askSettings: true, relay: relay.url, token: 't', allowedDirectories: [], deniedDirectories: [], readOnlyDirectories: [], telemetryEnabled: false, localHistory: false, setupDone: true, fuse: { enabled: true, limit: 2 } };
fs.writeFileSync(CONFIG, JSON.stringify(base, null, 2));
ensureIni(INI); setIni(INI, 'confirm', 'enabled', 'true'); setIni(INI, 'ask', 'move', 'true');

const asked = [];
let answer = () => 'deny';
let dc, link, ws;
const text = (r) => (r.content || []).map((c) => c.text).join('\n');
const body = (r) => JSON.parse(r.content[0].text);
const src = (i) => path.join(photos, `IMG_${i}.jpg`), dst = (i) => path.join(sorted, `IMG_${i}.jpg`);

before(async () => {
  dc = await startEngine({ ...base, dcConfigDir: path.join(DIR, 'dc'), configDir: DIR, confirmIni: INI, configFile: CONFIG, scriptsDir: SCRIPTS }, () => {}, { ask: async (q) => { asked.push(q); return answer(q); } });
  ws = connect({ ...base }, dc, () => {});
  link = await relay.next();
});
after(async () => { try { if (ws) ws._down = true; /* no reconnect loop after the test */ ws?.terminate(); } catch { /* gone */ } await dc?.close(); await relay.close(); });

test('the new tools are listed with their own short descriptions and honest hints', () => {
  const by = Object.fromEntries(dc.tools.map((t) => [t.name, t]));
  assert.ok(by.bridgerator_automation && by.bridgerator_plan);
  assert.deepEqual(by.bridgerator_automation.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  assert.deepEqual(by.bridgerator_plan.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  assert.match(by.bridgerator_plan.description, /^One approval on the PC/);
});

test('hello carries the queue counts with done / failed and the automation counts (for the relay\'s notifications)', async () => {
  const hello = await link.next((m) => m.type === 'hello');
  assert.deepEqual(hello.queue, { todo: 0, doing: 0, done: 0, failed: 0 });
  assert.deepEqual(hello.automations, { count: 0, enabled: 0, failing: 0 });
});

test('a plan the person allowed: its moves run without their own question and are not counted by the mass-action fuse; others still ask', async () => {
  answer = (q) => (q.buttons.some((b) => b[0] === 'review') ? 'allow' : 'deny'); // the plan card: Allow all; a single move: Deny
  const items = [1, 2, 3].map((i) => ({ tool: 'move_file', args: { source: src(i), destination: dst(i) } }));
  const p = body(await dc.call('bridgerator_plan', { action: 'propose', title: 'Разобрать фото', items }));
  assert.equal(p.approved, true); assert.equal(p.allowed, 3);
  assert.equal(asked.length, 1); assert.equal(asked[0].head, 'ChatGPT wants to move 3 files');
  for (const i of [1, 2, 3]) {
    const r = await dc.call('move_file', { source: src(i), destination: dst(i) });
    assert.ok(!r.isError, text(r));
    assert.equal(fs.readFileSync(dst(i), 'utf8'), `photo ${i}`);
  }
  assert.equal(asked.length, 1, 'no question per move');
  assert.equal(dc.paused, false, 'three moves over the fuse limit of 2: not counted, no pause');
  const other = await dc.call('move_file', { source: src(4), destination: dst(4) });
  assert.equal(other.notConfirmed, true, 'not in the plan → asks (fake says Deny)');
  assert.equal(asked.length, 2); assert.equal(asked[1].head, 'ChatGPT wants to move or rename');
  assert.ok(fs.existsSync(src(4)));
});

test('Review in the window: the card is in getState (pendingBatch) until the person decides there', async () => {
  answer = () => 'review';
  const items = [{ tool: 'move_file', args: { source: src(4), destination: dst(4) } }, { tool: 'move_file', args: { source: path.join(photos, 'нет.jpg'), destination: dst(9) } }];
  const p = dc.call('bridgerator_plan', { action: 'propose', items });
  let st;
  for (let i = 0; i < 100 && !(st = await dc.rpc('getState')).pendingBatch; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(st.pendingBatch.rows.length, 2);
  assert.equal(await dc.rpc('batch.decide', { id: st.pendingBatch.id, allow: [0] }), true);
  const r = body(await p);
  assert.equal(r.allowed, 1); assert.equal((await dc.rpc('getState')).pendingBatch, null);
  answer = () => 'deny';
  assert.ok(!(await dc.call('move_file', { source: src(4), destination: dst(4) })).isError);
});

test('automations in the bridge: save via the tool, the window lists / runs / deletes with Undo; mode tells the relay the counts', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const saved = body(await dc.call('bridgerator_automation', { action: 'save', name: 'Отчёт', recipe: 'disk-report', params: { Folder: photos, Top: 5 } })).saved;
  assert.equal(saved.recipe, 'disk-report'); assert.equal(saved.scheduled, false);
  assert.ok(fs.existsSync(path.join(SCRIPTS, `${saved.id}.ps1`)), 'inside %LOCALAPPDATA%\\Bridgerator\\scripts');
  // The folder is Bridgerator's own: the file tools can't touch it.
  assert.match(text(await dc.call('write_file', { path: path.join(SCRIPTS, `${saved.id}.ps1`), content: 'evil' })), /excluded folder/);
  let st = await dc.rpc('getState');
  assert.equal(st.automations.length, 1); assert.equal(st.automations[0].name, 'Отчёт');
  assert.equal(await dc.rpc('automation.run', { id: saved.id }), true);
  let g;
  for (let i = 0; i < 200; i++) { g = await dc.rpc('automation.get', { id: saved.id }); if (g.runs.length) break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(g.runs[0].code, 0, g.runs[0]?.tail); assert.equal(g.runs[0].trigger, 'manual'); assert.match(g.runs[0].tail, /Biggest files/);
  assert.match(g.script, /\$P = @\{/);
  const removed = await dc.rpc('automation.remove', { id: saved.id });
  assert.equal((await dc.rpc('getState')).automations.length, 0);
  await dc.rpc('automation.restore', { removed });
  st = await dc.rpc('getState');
  assert.equal(st.automations[0].id, saved.id);
  assert.deepEqual(dc.mode().automations, { count: 1, enabled: 0, failing: 0 });
});

test('queue events go to the relay with whole numbers only (task_failed, queue_done); mode carries done / failed', async () => {
  const added = body(await dc.call('queue_add', { items: [{ title: 'Секретная задача 1' }, { title: 'Секретная задача 2' }] })).items;
  for (const it of added) { await dc.call('queue_next', { worker: 'chat' }); await dc.call('queue_update', { id: it.id, status: it === added[0] ? 'done' : 'failed', note: 'итог' }); }
  const tf = await link.next((m) => m.type === 'event' && m.kind === 'task_failed');
  assert.deepEqual(tf, { type: 'event', kind: 'task_failed', n: 1, failed: 1 });
  const ev = await link.next((m) => m.type === 'event' && m.kind === 'queue_done');
  assert.deepEqual(ev, { type: 'event', kind: 'queue_done', done: 1, failed: 1 });
  for (const m of [tf, ev]) for (const [k, v] of Object.entries(m)) if (!['type', 'kind'].includes(k)) assert.ok(Number.isSafeInteger(v), `${k} is a whole number`);
  const mode = await link.next((m) => m.type === 'mode' && m.queue?.failed === 1);
  assert.deepEqual(mode.queue, { todo: 0, doing: 0, done: 1, failed: 1 });
  assert.doesNotMatch(JSON.stringify(link.msgs.concat(tf, ev, mode)), /Секретная|итог/, 'no titles or notes to the relay');
});

test('usage forecast reaches the window from the relay\'s plan numbers', () => {
  dc.onPlanMsg({ plan: 'free', calls: 9000, limit: 10000, month: new Date().toISOString().slice(0, 7) });
  return dc.rpc('getState').then((st) => { assert.equal(st.usage.calls, 9000); assert.ok(['enough', 'runs_out'].includes(st.usage.state)); });
});

test('settings: the "Scheduled scripts" confirmation and the schedule notice are readable and settable like every window setting', async () => {
  const got = text(await dc.call('bridgerator_settings', { action: 'get' }));
  assert.match(got, /scheduled_scripts/); assert.match(got, /notifySchedule/);
  answer = () => 'deny';
  const n0 = asked.length;
  const off = await dc.call('bridgerator_settings', { action: 'set', settings: { automations: { notifySchedule: false } } });
  assert.equal(asked.length, n0 + 1, 'turning the notice off asks on the PC'); assert.equal(off.notConfirmed, true);
  const on = await dc.call('bridgerator_settings', { action: 'set', settings: { confirm: { scheduled_scripts: true } } });
  assert.ok(!on.isError, text(on)); assert.equal(asked.length, n0 + 1, 'turning a confirmation on is direct');
  assert.match(fs.readFileSync(INI, 'utf8'), /scheduled_scripts = true/);
  assert.equal(shown.filter((s) => s.head).length, 0, 'no question window was started');
});
