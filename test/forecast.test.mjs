// Usage this month + forecast for the Status page (src/plan.mjs forecast): the average pace of the
// days gone this month. Shown only in the Bridgerator window, never in ChatGPT. LOGIC: critical-logic/bridge.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forecast, readPlan } from '../src/plan.mjs';

const at = (d, h = 0) => Date.UTC(2026, 9, d, h); // October 2026: 31 days

test('enough: the pace of the days gone fits the limit until the end of the month', () => {
  assert.deepEqual(forecast(readPlan({ plan: 'free', calls: 2000, limit: 10000, month: '2026-10' }), at(11)), { calls: 2000, limit: 10000, state: 'enough', projected: 6200 });
});

test('runs out: the date the limit is reached at this pace', () => {
  // 5000 in 10 days = 500 a day → 10000 on day 20 (1.10 + 20 days = 21.10).
  assert.deepEqual(forecast(readPlan({ plan: 'free', calls: 5000, limit: 10000, month: '2026-10' }), at(11)), { calls: 5000, limit: 10000, state: 'runs_out', projected: 15500, date: '2026-10-21' });
});

test('the first hours of a month count as one day (no wild forecast from a few calls)', () => {
  assert.equal(forecast({ plan: 'free', calls: 50, limit: 10000, month: '2026-10' }, at(1, 2)).state, 'enough');
  assert.equal(forecast({ plan: 'free', calls: 400, limit: 10000, month: '2026-10' }, at(1, 2)).date, '2026-10-26');
});

test('limit reached = out; Pro or no limit = unlimited (count only); no numbers = nothing', () => {
  assert.equal(forecast({ plan: 'free', calls: 10000, limit: 10000, month: '2026-10' }, at(20)).state, 'out');
  assert.deepEqual(forecast({ plan: 'pro', calls: 12345, limit: 10000 }, at(20)), { calls: 12345, state: 'unlimited' });
  assert.deepEqual(forecast({ plan: 'free', calls: 7 }, at(20)), { calls: 7, state: 'unlimited' });
  assert.equal(forecast(null), null);
  assert.equal(forecast(readPlan({ plan: 'free' })), null);
});

test('the run-out date never falls after the month; without a month the current UTC month is used', () => {
  assert.deepEqual(forecast({ plan: 'free', calls: 9999, limit: 10000, month: '2026-10' }, at(31, 23)).date, '2026-10-31');
  assert.equal(forecast({ plan: 'free', calls: 1000, limit: 10000, month: '2026-09' }, at(20)).state, 'enough', 'a past month: its own days');
  const f = forecast({ plan: 'free', calls: 9000, limit: 10000 }, at(10));
  assert.equal(f.state, 'runs_out'); assert.equal(f.date, '2026-10-11');
});
