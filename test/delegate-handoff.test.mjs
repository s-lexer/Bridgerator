// AI → ChatGPT hand-off through the task queue (src/queue.mjs): another AI adds tasks with `from` and
// `resultPath`, ChatGPT works through them, the first AI reads the outcome with queue_list. Old queue
// files without these fields keep working. LOGIC: critical-logic/bridge.md ("AI ↔ AI delegation").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue, queueTool, QUEUE_TOOL_DEFS } from '../src/queue.mjs';
import { DELEGATE_TOOL, HANDOFF } from '../src/delegate.mjs';

const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'очередь-')); return { d, file: path.join(d, 'queue.json') }; };
const body = (r) => JSON.parse(r.content[0].text);

test('queue_add takes from + resultPath (single and items), queue_list returns them, queue_next hands them to ChatGPT', (t) => {
  const { d, file } = tmp(); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const q = createQueue(file);
  const res = 'D:\\Проекты\\Отчёт по сайту.md';
  const one = body(queueTool(q, 'queue_add', { title: 'Проверь ссылки на сайте', details: 'Все страницы в D:\\Проекты\\site', from: 'Claude Code', resultPath: res }));
  assert.equal(one.item.from, 'Claude Code'); assert.equal(one.item.resultPath, res);
  const many = body(queueTool(q, 'queue_add', { items: [{ title: 'Сводка', from: 'Codex' }, { title: 'Без пометки' }] }));
  assert.equal(many.items[0].from, 'Codex'); assert.equal(many.items[1].from, undefined);
  const next = body(queueTool(q, 'queue_next', { worker: 'ChatGPT' })).item;
  assert.equal(next.resultPath, res);
  queueTool(q, 'queue_update', { id: next.id, status: 'done', note: `Готово, результат в ${res}` });
  const list = body(queueTool(q, 'queue_list', {}));
  const back = list.items.find((x) => x.id === next.id);
  assert.deepEqual([back.status, back.from, back.resultPath], ['done', 'Claude Code', res]);
  // Kept across a restart.
  assert.equal(createQueue(file).list().find((x) => x.id === next.id).from, 'Claude Code');
});

test('bad hand-off fields are refused; items: one bad item adds none', (t) => {
  const { d, file } = tmp(); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const q = createQueue(file);
  assert.equal(queueTool(q, 'queue_add', { title: 'x', resultPath: 'отчёт.md' }).isError, true, 'not a full path');
  assert.equal(queueTool(q, 'queue_add', { title: 'x', from: 'a\nb' }).isError, true, 'one line only');
  assert.equal(queueTool(q, 'queue_add', { title: 'x', from: 'x'.repeat(81) }).isError, true);
  const r = queueTool(q, 'queue_add', { items: [{ title: 'ok', from: 'Claude Code' }, { title: 'bad', resultPath: 'relative\\x.md' }] });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /items\[1\]/);
  assert.equal(q.list().length, 0);
  // queue_edit changes / removes the result file.
  const it = q.add({ title: 'a', resultPath: 'C:\\r.md' });
  assert.equal(q.edit({ id: it.id, resultPath: 'C:\\Новый.md' }).resultPath, 'C:\\Новый.md');
  assert.equal(q.edit({ id: it.id, resultPath: '' }).resultPath, undefined);
});

test('an old queue.json (no from / resultPath) loads and lists as before', (t) => {
  const { d, file } = tmp(); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify({ items: [{ id: 'a1', title: 'Старая задача', status: 'todo', order: 1, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }] }));
  const l = body(queueTool(createQueue(file), 'queue_list', {}));
  assert.deepEqual(Object.keys(l.items[0]).sort(), ['id', 'status', 'title', 'updatedAt']);
});

test('the schemas and texts say how the hand-off works (both directions)', () => {
  const add = QUEUE_TOOL_DEFS.find((x) => x.name === 'queue_add');
  assert.ok(add.inputSchema.properties.from && add.inputSchema.properties.resultPath);
  assert.ok(add.inputSchema.properties.items.items.properties.resultPath);
  assert.match(add.description, /from .*resultPath/);
  assert.match(QUEUE_TOOL_DEFS.find((x) => x.name === 'queue_next').description, /resultPath set: write the result to that file/);
  assert.match(HANDOFF, /Work through my Bridgerator queue/);
  assert.match(DELEGATE_TOOL.description, /queue_add with from and resultPath/);
});
