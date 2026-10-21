// The relay notification events (src/events.mjs): shape the relay accepts — known kinds, whole
// numbers only, ≤ 30 a minute. LOGIC: critical-logic/bridge.md ("Relay notifications").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventMessage, createEventLimiter, EVENT_KINDS } from '../src/events.mjs';

test('only the known kinds, only whole-number fields (names, paths, text never leave the PC)', () => {
  assert.deepEqual(EVENT_KINDS, ['queue_done', 'task_failed', 'automation_failed', 'delegate_done']);
  assert.deepEqual(eventMessage({ kind: 'queue_done', done: 3, failed: 1 }), { type: 'event', kind: 'queue_done', done: 3, failed: 1 });
  assert.deepEqual(eventMessage({ kind: 'task_failed', n: 1, failed: 2, title: 'Секрет' }), { type: 'event', kind: 'task_failed', n: 1, failed: 2 });
  assert.deepEqual(eventMessage({ kind: 'automation_failed', code: -1073741510, failing: 2, recipe: 'backup-folder', at: '2026-10-21T08:00:00Z', tail: 'C:\\Users\\Иван' }), { type: 'event', kind: 'automation_failed', code: -1073741510, failing: 2 });
  assert.deepEqual(eventMessage({ kind: 'queue_done', done: 1.5, failed: '2', n: NaN }), { type: 'event', kind: 'queue_done' });
  assert.equal(eventMessage({ kind: 'queue_finished' }), null);
  assert.equal(eventMessage(null), null);
});

test('at most 30 a minute; the window slides', () => {
  let t = 0;
  const l = createEventLimiter(30, 60000, () => t);
  for (let i = 0; i < 30; i++) assert.equal(l.take(), true);
  assert.equal(l.take(), false);
  t = 59999; assert.equal(l.take(), false);
  t = 60000; assert.equal(l.take(), true);
});
