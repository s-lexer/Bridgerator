// Plan card (src/batch.mjs, tool bridgerator_plan): one approval on the PC for many similar actions.
// The question on the PC is a fake; the confirm gate and the folder policy are the real ones.
// LOGIC: critical-logic/bridge.md ("Plan card").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-batch-'));
const photos = path.join(root, 'Фото 2025'), sorted = path.join(root, 'Разобрано'), secret = path.join(root, 'Секрет'), ro = path.join(root, 'Архив');
for (const d of [photos, sorted, secret, ro]) fs.mkdirSync(d, { recursive: true });
for (let i = 1; i <= 5; i++) fs.writeFileSync(path.join(photos, `IMG_${i}.jpg`), 'x');
fs.writeFileSync(path.join(sorted, 'IMG_5.jpg'), 'already there');

const B = await import('../src/batch.mjs');
const { createPolicy } = await import('../src/policy.mjs');
const { createGate, ensureIni, setIni } = await import('../src/confirm.mjs');
const { createExtra } = await import('../src/extra-tools.mjs');
const extra = createExtra([B]);

let n = 0;
function setup({ confirm = true, move = true, now } = {}) {
  const ini = path.join(root, `c${++n}.ini`);
  ensureIni(ini);
  if (confirm) setIni(ini, 'confirm', 'enabled', 'true');
  if (move) setIni(ini, 'ask', 'move', 'true');
  const asked = [], opened = [];
  const box = { answer: 'allow' };
  const gate = createGate({ ini, ask: async (q) => { asked.push(q); return box.answer; } });
  const cfg = { allowedDirectories: [], deniedDirectories: [secret], readOnlyDirectories: [ro], protectSensitive: false }; // the default since 21.10 (temp is under AppData)
  const clock = { t: Date.now() };
  const batch = B.attachBatch(cfg, B.createBatch({ now: now || (() => clock.t), openWindow: (p) => opened.push(p) }));
  const ctx = { cfg, policy: createPolicy(cfg), gate, log: () => {}, popup: () => ({ theme: 'light' }) };
  const call = (args) => extra.call('bridgerator_plan', args, ctx);
  return { cfg, ctx, gate, batch, call, asked, opened, box, clock, ini };
}
const moves = (k = 5) => Array.from({ length: k }, (_, i) => ({ tool: 'move_file', args: { source: path.join(photos, `IMG_${i + 1}.jpg`), destination: path.join(sorted, `IMG_${i + 1}.jpg`) } }));
const body = (r) => JSON.parse(r.content[0].text);
const tick = () => new Promise((r) => setTimeout(r, 10));

test('the headline counts the actions in plain words', () => {
  const r = (tool, k) => Array.from({ length: k }, () => ({ tool }));
  assert.equal(B.headline(r('move_file', 214)), 'ChatGPT wants to move 214 files');
  assert.equal(B.headline(r('move_file', 1)), 'ChatGPT wants to move 1 file');
  assert.equal(B.headline(r('start_process', 3)), 'ChatGPT wants to run 3 commands');
  assert.equal(B.headline([...r('move_file', 200), ...r('start_process', 14)]), 'ChatGPT wants to do 214 actions (200 moves, 14 commands)');
});

test('an item is the tool + its paths (case, slashes, trailing separator do not matter) or the exact command', () => {
  const a = B.itemKey('move_file', { source: 'C:\\Фото\\a.jpg', destination: 'D:\\X\\' });
  assert.equal(a, B.itemKey('move_file', { source: 'c:/фото/A.JPG', destination: 'd:\\x' }));
  assert.notEqual(a, B.itemKey('move_file', { source: 'C:\\Фото\\a.jpg', destination: 'D:\\Y' }));
  assert.equal(B.itemKey('write_file', { path: 'C:\\a.txt', content: 'one' }), B.itemKey('write_file', { path: 'C:\\a.txt', content: 'two' }), 'any content for an approved file');
  assert.notEqual(B.itemKey('start_process', { command: 'del a.txt' }), B.itemKey('start_process', { command: 'del b.txt' }));
  assert.equal(B.itemKey('start_process', { command: '  del a.txt ' }), B.itemKey('start_process', { command: 'del a.txt' }));
  assert.equal(B.itemKey('read_file', { path: 'C:\\a.txt' }), null, 'only tools a confirmation can stop');
  assert.equal(B.itemKey('move_file', { source: 'C:\\a' }), null);
});

test('confirmations off, or nothing in the list would ask: no card, the AI is told it needs none', async () => {
  const off = setup({ confirm: false });
  const r = body(await off.call({ action: 'propose', items: moves() }));
  assert.equal(r.needed, false); assert.match(r.note, /Confirmations are off/); assert.equal(off.asked.length, 0);
  const quiet = setup({ move: false });
  assert.equal(body(await quiet.call({ action: 'propose', items: moves() })).needed, false);
  assert.equal(quiet.asked.length, 0);
});

test('Allow all: ONE question for the list; then exactly those moves pass the confirmation without their own question — each once, for 30 minutes', async () => {
  const s = setup();
  const r = body(await s.call({ action: 'propose', title: 'Разобрать фото', items: moves() }));
  assert.equal(s.asked.length, 1);
  const q = s.asked[0];
  assert.equal(q.head, 'ChatGPT wants to move 5 files');
  assert.match(q.text, /^Разобрать фото: .*IMG_1\.jpg .* … .*IMG_5\.jpg$/); assert.ok(q.text.length <= 160);
  assert.deepEqual(q.buttons.map((b) => b[0]), ['allow', 'review', 'deny']);
  assert.equal(q.theme, 'light');
  assert.equal(r.approved, true); assert.equal(r.allowed, 5); assert.match(r.planId, /^[0-9a-f]{8}$/);
  const [m1, m2] = moves(2);
  assert.equal(s.batch.covers('move_file', m1.args, s.gate), true);
  assert.equal(s.batch.covers('move_file', m1.args, s.gate), false, 'used up: listed once');
  assert.equal(s.batch.covers('move_file', { ...m2.args, destination: path.join(root, 'elsewhere.jpg') }, s.gate), false, 'another target = not in the plan');
  assert.equal(s.batch.covers('move_file', m2.args, s.gate), true);
  assert.deepEqual(body(await s.call({ action: 'status', planId: r.planId })), { planId: r.planId, active: true, left: 3, used: 2, expiresAt: r.expiresAt });
  s.clock.t += B.PLAN_TTL_MS + 1;
  assert.equal(s.batch.covers('move_file', moves(3)[2].args, s.gate), false, 'expired');
  assert.equal(body(await s.call({ action: 'status', planId: r.planId })).active, false);
});

test('a covered call keeps its use when the gate would not ask anyway (confirmations turned off meanwhile)', async () => {
  const s = setup();
  await s.call({ action: 'propose', items: moves(1) });
  setIni(s.ini, 'confirm', 'enabled', 'false'); s.gate.accept(); // as the window / tray writes it
  assert.equal(s.batch.covers('move_file', moves(1)[0].args, s.gate), false);
  setIni(s.ini, 'confirm', 'enabled', 'true');
  assert.equal(s.batch.covers('move_file', moves(1)[0].args, s.gate), true);
});

test('Review: the window shows the list with checkboxes; only the ticked items are allowed', async () => {
  const s = setup();
  s.box.answer = 'review';
  const p = s.call({ action: 'propose', items: moves() });
  await tick();
  assert.deepEqual(s.opened, ['home']);
  const card = s.batch.pending();
  assert.equal(card.head, 'ChatGPT wants to move 5 files'); assert.equal(card.rows.length, 5); assert.equal(card.rows[0].cat, 'move');
  assert.equal(s.batch.decide('wrong-id', [0]), false);
  assert.equal(s.batch.decide(card.id, [0, 2, 99, 'x']), true);
  const r = body(await p);
  assert.equal(r.allowed, 2); assert.equal(r.notAllowed, 3); assert.deepEqual(r.notAllowedIndexes, [1, 3, 4]);
  assert.equal(s.batch.pending(), null);
  assert.equal(s.batch.covers('move_file', moves(1)[0].args, s.gate), true);
  assert.equal(s.batch.covers('move_file', moves(2)[1].args, s.gate), false);
});

test('Deny (or no answer, or nothing ticked): not approved, and no new card for 10 minutes', async () => {
  const s = setup();
  s.box.answer = 'deny';
  const r = await s.call({ action: 'propose', items: moves() });
  assert.equal(r.isError, true); assert.equal(r.notConfirmed, true); assert.equal(body(r).approved, false);
  const again = await s.call({ action: 'propose', items: moves() });
  assert.match(again.content[0].text, /declined a plan a few minutes ago/); assert.equal(s.asked.length, 1);
  s.clock.t += B.DENY_COOLDOWN_MS + 1;
  s.box.answer = 'review';
  const p = s.call({ action: 'propose', items: moves() });
  await tick();
  s.batch.decide(s.batch.pending().id, []);
  assert.equal((await p).notConfirmed, true);
  assert.equal(s.batch.covers('move_file', moves(1)[0].args, s.gate), false);
});

test('the folder rules still apply: refused items are reported and never put on the card', async () => {
  const s = setup();
  const items = [...moves(2), { tool: 'move_file', args: { source: path.join(secret, 'a.txt'), destination: path.join(sorted, 'a.txt') } }, { tool: 'write_file', args: { path: path.join(ro, 'x.txt'), content: '1' } }];
  const r = body(await s.call({ action: 'propose', items }));
  assert.deepEqual(r.refused.map((x) => x.index), [2, 3]);
  assert.match(r.refused[0].reason, /excluded folder/); assert.match(r.refused[1].reason, /read-only/);
  assert.equal(s.asked[0].head, 'ChatGPT wants to move 2 files');
  assert.equal(s.batch.covers('move_file', items[2].args, s.gate), false);
});

test('dry run: what would be refused / ask / run freely and what it meets on disk — nothing asked, nothing approved', async () => {
  const s = setup();
  const items = [...moves(5), { tool: 'move_file', args: { source: path.join(photos, 'нет.jpg'), destination: path.join(sorted, 'нет.jpg') } }, { tool: 'move_file', args: { source: path.join(secret, 'a'), destination: path.join(sorted, 'a') } }, { tool: 'create_directory', args: { path: path.join(sorted, 'Новая') } }];
  const r = body(await s.call({ action: 'propose', items, dryRun: true }));
  assert.equal(s.asked.length, 0);
  assert.equal(r.dryRun, true); assert.equal(r.total, 8); assert.equal(r.wouldAsk, 6); assert.deepEqual(r.askFor, { 'moves and renames': 6 }); assert.equal(r.runsFreely, 1);
  assert.deepEqual(r.refused.map((x) => x.index), [6]);
  assert.equal(r.items[4].note, 'target exists'); assert.equal(r.items[5].note, 'source missing'); assert.equal(r.items[6].refused, true);
  assert.match(r.note, /Nothing was asked or run/);
  assert.equal(s.batch.covers('move_file', moves(1)[0].args, s.gate), false);
});

test('bad input is refused in plain words; cancel ends a plan', async () => {
  const s = setup();
  for (const [args, re] of [[{ action: 'propose', items: [] }, /1–1000/], [{ action: 'propose', items: [{ tool: 'read_file', args: { path: 'C:\\a' } }] }, /tool must be one of/], [{ action: 'propose', items: [{ tool: 'move_file', args: { source: 'C:\\a' } }] }, /need source and destination/], [{ action: 'propose', items: [{ tool: 'move_file' }] }, /args must be/]]) {
    const r = await s.call(args);
    assert.equal(r.isError, true); assert.match(r.content[0].text, re);
  }
  const id = body(await s.call({ action: 'propose', items: moves(1) })).planId;
  assert.deepEqual(body(await s.call({ action: 'cancel', planId: id })), { planId: id, cancelled: true });
  assert.equal(s.batch.covers('move_file', moves(1)[0].args, s.gate), false);
  assert.equal(B.PLAN_TOOL.annotations.destructiveHint, false);
  assert.doesNotMatch(B.PLAN_TOOL.description, /\b(MUST|ALWAYS|NEVER|IMPORTANT)\b/);
});

test('VM11-9: one action of a kind in a mixed list is singular', () => {
  const r = (tool, k) => Array.from({ length: k }, () => ({ tool }));
  assert.equal(B.headline([...r('move_file', 2), ...r('start_process', 1)]), 'ChatGPT wants to do 3 actions (2 moves, 1 command)');
  assert.equal(B.headline([...r('move_file', 1), ...r('create_directory', 1)]), 'ChatGPT wants to do 2 actions (1 move, 1 new folder)');
});

test('B2-2 / X1-5: a dry run looks on disk only for allowed rows with a full path on the system drive (no network / device paths)', async () => {
  const other = String(process.env.SystemDrive || 'C:')[0].toUpperCase() === 'Q' ? 'R' : 'Q';
  const s = setup();
  const seen = [];
  const orig = fs.promises.stat;
  fs.promises.stat = async (p, ...a) => { seen.push(String(p)); return orig(p, ...a); };
  try {
    const items = [...moves(1), { tool: 'move_file', args: { source: path.join(secret, 'a.txt'), destination: path.join(sorted, 'a.txt') } },
      { tool: 'write_file', args: { path: '\\\\server\\share\\x.txt', content: '1' } }, { tool: 'write_file', args: { path: path.join(sorted, 'новый.txt'), content: '1' } },
      { tool: 'write_file', args: { path: `${other}:\\Архив\\x.txt`, content: '1' } }];
    const r = body(await s.call({ action: 'propose', dryRun: true, items }));
    assert.equal(r.items[0].note, undefined, 'source there, target free');
    assert.ok(seen.some((p) => p.startsWith(photos)), 'allowed rows are looked at');
    assert.equal(r.items[3].note, 'new file');
    assert.ok(!seen.some((p) => p.startsWith(secret)), 'a refused row is never looked at');
    assert.ok(!seen.some((p) => p.startsWith('\\\\')), 'never a UNC path');
    // X1-5: another drive letter may be a mapped network drive (a stat there can hold a libuv thread): no look, no note.
    assert.ok(!seen.some((p) => p.toUpperCase().startsWith(`${other}:`)), 'never another drive'); assert.equal(r.items[4].note, undefined);
    assert.equal(r.items[1].refused, true); assert.equal(r.items[1].note, undefined);
  } finally { fs.promises.stat = orig; }
});

test('B2-11: a second plan under review replaces the first card; the first propose answers "replaced", no cool-down', async () => {
  const s = setup();
  s.box.answer = 'review';
  const p1 = s.call({ action: 'propose', items: moves(2) });
  await tick();
  const first = s.batch.pending().id;
  const p2 = s.call({ action: 'propose', items: moves(3) });
  await tick();
  const r1 = await p1;
  assert.equal(r1.notConfirmed, true); assert.equal(body(r1).replaced, true);
  const card = s.batch.pending();
  assert.notEqual(card.id, first); assert.equal(card.rows.length, 3);
  assert.equal(s.batch.decide(first, [0]), false, 'the old card is gone');
  s.batch.decide(card.id, [0, 1, 2]);
  assert.equal(body(await p2).allowed, 3);
});
