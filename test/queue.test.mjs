// Task queue edge cases: broken files, limits, Undo, order, atomic writes, Cyrillic.
// LOGIC: critical-logic/bridge.md §2 (task queue) and §2b.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue, queueTool, QUEUE_TOOL_DEFS } from '../src/queue.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-queue-'));
let n = 0;
const file = (content) => { const f = path.join(dir, `q${++n}`, 'queue.json'); fs.mkdirSync(path.dirname(f)); if (content !== undefined) fs.writeFileSync(f, content); return f; };
const res = (r) => JSON.parse(r.content[0].text);

test('a broken, empty or odd queue.json is an empty queue, never a crash; the next save repairs it', () => {
  for (const c of ['', 'not json', '{"items": "x"}', '[1,2]', 'null', '\ufeff{"items":[]}', Buffer.from('{"items":[]}', 'utf16le')]) {
    const f = file(c);
    const q = createQueue(f);
    assert.deepEqual(q.list(), [], JSON.stringify(String(c)));
    q.add({ title: 'после сбоя' });
    assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).items[0].title, 'после сбоя');
  }
  assert.deepEqual(createQueue(path.join(dir, 'missing', 'queue.json')).list(), []);
});

test('limits: 500 items, title / details / note / paths lengths; strict statuses', () => {
  const q = createQueue(file());
  assert.match(queueTool(q, 'queue_add', { title: '   ' }).content[0].text, /title is required/);
  assert.match(queueTool(q, 'queue_add', { title: 'x', details: 'd'.repeat(4001) }).content[0].text, /longer than 4000/);
  assert.match(queueTool(q, 'queue_add', { title: 'x', paths: Array(21).fill('C:\\a') }).content[0].text, /at most 20/);
  assert.match(queueTool(q, 'queue_add', { title: 'x', paths: ['C:\\a', 5] }).content[0].text, /paths must be/);
  assert.match(queueTool(q, 'queue_add', { title: 42 }).content[0].text, /must be text/);
  for (let i = 0; i < 5; i++) queueTool(q, 'queue_add', { items: Array.from({ length: 100 }, (_, j) => ({ title: `t${i}-${j}` })) });
  assert.equal(q.list().length, 500);
  assert.match(queueTool(q, 'queue_add', { title: 'one more' }).content[0].text, /full \(500/);
  assert.match(queueTool(q, 'queue_add', { items: [{ title: 'x' }] }).content[0].text, /over 500/);
  const id = q.list()[0].id;
  assert.match(queueTool(q, 'queue_update', { id, status: 'done', note: 'n'.repeat(1001) }).content[0].text, /longer than 1000/);
  assert.match(queueTool(q, 'queue_list', { status: 'DONE' }).content[0].text, /status must be/);
  assert.match(queueTool(q, 'queue_clear', { status: 'everything' }).content[0].text, /status must be/);
  assert.match(queueTool(q, 'queue_frobnicate', {}).content[0].text, /unknown queue tool/);
  assert.ok(QUEUE_TOOL_DEFS.every((t) => t.inputSchema.additionalProperties === false), 'tool schemas are strict');
});

test('a bad item in a bulk add adds nothing', () => {
  const q = createQueue(file());
  assert.match(queueTool(q, 'queue_add', { items: [{ title: 'ok' }, { title: '' }] }).content[0].text, /items\[1\]\.title is required/);
  assert.equal(q.list().length, 0);
  // A chat that gets an error retries: a half-added list would then be added twice.
  assert.equal(queueTool(q, 'queue_add', { items: [{ title: 'ok' }, { title: 'x', details: 'd'.repeat(4001) }] }).isError, true);
  assert.equal(queueTool(q, 'queue_add', { items: [{ title: 'ok' }, { title: 'x', paths: 'C:\\not-a-list' }] }).isError, true);
  assert.equal(q.list().length, 0, 'nothing added when any item is bad');
});

test('Undo: restoring an id that already exists, a bad status or no title is refused', () => {
  const q = createQueue(file());
  const a = q.add({ title: 'a' });
  assert.throws(() => q.restore({ item: { ...a } }), /nothing to restore/, 'duplicate id');
  assert.throws(() => q.restore({ item: { id: 'zz', title: 'x', status: 'exploded' } }), /bad item/);
  assert.throws(() => q.restore({ item: { id: 'zz', status: 'todo' } }), /title is required/);
  assert.throws(() => q.restore({ item: null }), /nothing to restore/);
  assert.equal(q.list().length, 1);
});

test('reorder: an unknown id is refused and nothing moves; duplicates in the list are harmless', () => {
  const q = createQueue(file());
  const [a, b, c] = ['a', 'b', 'c'].map((t) => q.add({ title: t }));
  assert.match(queueTool(q, 'queue_reorder', { ids: [c.id, 'nope'] }).content[0].text, /no queue item nope/);
  assert.deepEqual(q.list().map((x) => x.id), [a.id, b.id, c.id]);
  q.reorder({ ids: [c.id, c.id, a.id] });
  assert.deepEqual(q.list().map((x) => x.id), [c.id, a.id, b.id]);
  assert.deepEqual(q.list().map((x) => x.order), [1, 2, 3]);
});

test('updates of an unknown id, and a worker that is not text, are refused', () => {
  const q = createQueue(file());
  q.add({ title: 'a' });
  assert.match(queueTool(q, 'queue_update', { id: 'nope', status: 'done' }).content[0].text, /no queue item/);
  assert.match(queueTool(q, 'queue_edit', { id: 'nope', title: 'x' }).content[0].text, /no queue item/);
  assert.match(queueTool(q, 'queue_next', { worker: { evil: true } }).content[0].text, /worker must be text/);
});

test('atomic writes: many changes leave only queue.json (no temp files); Cyrillic titles and paths survive a reload', () => {
  const f = file();
  const q = createQueue(f);
  for (let i = 0; i < 50; i++) q.add({ title: `Разобрать папку №${i}`, paths: [`C:\\Users\\Иван Петров\\Фото ${i}`] });
  for (const it of q.list().slice(0, 20)) { q.next({ worker: 'чат «Фото»' }); q.update({ id: it.id, status: 'done', note: 'готово ✓' }); }
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['queue.json']);
  const again = createQueue(f);
  assert.equal(again.list()[49].title, 'Разобрать папку №49');
  assert.equal(again.list('done')[0].note, 'готово ✓');
  assert.equal(again.list()[0].paths[0], 'C:\\Users\\Иван Петров\\Фото 0');
});

test('parallel chats on one queue: 40 takes in one tick never give the same item twice', async () => {
  const q = createQueue(file());
  for (let i = 0; i < 30; i++) q.add({ title: `t${i}` });
  const got = await Promise.all(Array.from({ length: 40 }, (_, i) => Promise.resolve().then(() => res(queueTool(q, 'queue_next', { worker: `chat ${i}` })).item)));
  const ids = got.filter(Boolean).map((x) => x.id);
  assert.equal(ids.length, 30);
  assert.equal(new Set(ids).size, 30);
  assert.equal(got.filter((x) => x === null).length, 10, 'the rest hear "empty"');
});

test('a write error (read-only file) is reported to the chat, the queue keeps working in memory', (t) => {
  const f = file();
  const q = createQueue(f);
  q.add({ title: 'a' });
  fs.chmodSync(f, 0o444);
  t.after(() => fs.chmodSync(f, 0o666));
  const r = queueTool(q, 'queue_add', { title: 'b' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /^Queue: /);
});

test('B2-21: a broken queue.json is kept as queue.json.broken-<time>; one that cannot be read is never overwritten; odd items dropped', () => {
  const f = file('{"items": [ {"id": "a1", "title": "цел' );
  const q = createQueue(f);
  assert.ok(fs.readdirSync(path.dirname(f)).some((x) => x.startsWith('queue.json.broken-')), 'the broken text is kept');
  q.add({ title: 'новое' });
  const g = file(JSON.stringify({ items: [{ id: 'x1', title: 'ok', status: 'todo', order: 1 }, { id: 5, title: 'bad id', status: 'todo' }, { id: 'x2', title: 'bad status', status: '??' }, null] }));
  assert.deepEqual(createQueue(g).list().map((x) => x.id), ['x1']);
  // A folder where the file should be: reading fails (EISDIR) → the queue refuses to save, nothing replaced.
  const h = path.join(dir, `q${++n}`, 'queue.json'); fs.mkdirSync(h, { recursive: true });
  const r = queueTool(createQueue(h), 'queue_add', { title: 'x' });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /could not be read/);
  assert.ok(fs.statSync(h).isDirectory());
});

test('B2-20: a refused change leaves the item exactly as it was (validation and save errors)', () => {
  const f = file();
  const q = createQueue(f);
  const it = q.add({ title: 'задача' });
  const before = JSON.stringify(q.list());
  assert.equal(queueTool(q, 'queue_update', { id: it.id, status: 'done', note: 'я'.repeat(5000) }).isError, true);
  assert.equal(queueTool(q, 'queue_edit', { id: it.id, title: 'новое', resultPath: 'relative.txt' }).isError, true);
  assert.equal(queueTool(q, 'queue_next', { worker: 'w'.repeat(200) }).isError, true);
  assert.equal(JSON.stringify(q.list()), before, 'nothing changed in memory');
  assert.equal(queueTool(q, 'queue_add', { items: [{ title: 'one' }, { title: '' }] }).isError, true);
  assert.equal(q.list().length, 1, 'all or nothing');
  // A save that fails (the folder is gone and a file blocks it): memory stays as on disk.
  fs.rmSync(path.dirname(f), { recursive: true, force: true }); fs.writeFileSync(path.dirname(f), 'blocker');
  assert.equal(queueTool(q, 'queue_update', { id: it.id, status: 'done' }).isError, true);
  assert.equal(q.list()[0].status, 'todo');
  fs.rmSync(path.dirname(f), { force: true });
});

test('X1-12 / X1-16: a bulk add saves once (a failure half-way leaves queue.json as it was); a wrong-shape file is kept before it is replaced', (t) => {
  const f = file();
  const q = createQueue(f);
  q.add({ title: 'первая' });
  const disk = fs.readFileSync(f, 'utf8');
  fs.chmodSync(f, 0o444);
  t.after(() => fs.chmodSync(f, 0o666));
  assert.equal(queueTool(q, 'queue_add', { items: [{ title: 'a' }, { title: 'b' }] }).isError, true);
  assert.equal(fs.readFileSync(f, 'utf8'), disk, 'nothing half-written');
  assert.equal(q.list().length, 1);
  const g = file(JSON.stringify({ tasks: [{ id: 'a', title: 'старый формат' }] }));
  createQueue(g).add({ title: 'x' });
  const kept = fs.readdirSync(path.dirname(g)).find((x) => x.startsWith('queue.json.broken-'));
  assert.ok(kept, 'the odd file is kept'); assert.match(fs.readFileSync(path.join(path.dirname(g), kept), 'utf8'), /старый формат/);
});

test('YB-11: the broken file is copied once per distinct content, not at every start', () => {
  const g = file(JSON.stringify({ items: [{ id: 'x1', title: 'ok', status: 'todo', order: 1 }, { id: 5, title: 'dropped' }] }));
  const copies = () => fs.readdirSync(path.dirname(g)).filter((x) => x.startsWith('queue.json.broken-'));
  for (let i = 0; i < 3; i++) assert.deepEqual(createQueue(g).list().map((x) => x.id), ['x1']);
  assert.equal(copies().length, 1, 'three starts, one copy');
  fs.writeFileSync(g, '{"items": [ broken');
  createQueue(g);
  assert.equal(copies().length, 2, 'new broken content: one more copy');
  createQueue(g).add({ title: 'x' });
  assert.equal(copies().length, 2);
});
