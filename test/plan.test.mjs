import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBanner, bannerVisible, dismissFor, readPlan, safeUrl, resetDay } from '../src/plan.mjs';

const now = Date.parse('2026-10-20T12:00:00Z');
const day = 86400000;

test('plan banner states: Pro ending / ended, Free high / limit, none', () => {
  assert.deepEqual(planBanner(readPlan({ plan: 'pro', until: new Date(now + 2 * day).toISOString() }), now).kind, 'pro_ending');
  assert.equal(planBanner(readPlan({ plan: 'pro', until: new Date(now + 2 * day).toISOString() }), now).days, 2);
  assert.equal(planBanner(readPlan({ plan: 'pro', until: new Date(now + 10 * day).toISOString() }), now).kind, 'none');
  assert.equal(planBanner(readPlan({ plan: 'pro', until: new Date(now - day).toISOString() }), now).kind, 'pro_ended');
  assert.equal(planBanner(readPlan({ plan: 'free', until: new Date(now - 5 * day).toISOString(), calls: 10, limit: 10000 }), now).kind, 'pro_ended');
  assert.equal(planBanner(readPlan({ plan: 'free', until: new Date(now - 40 * day).toISOString(), calls: 10, limit: 10000 }), now).kind, 'none');
  const hi = planBanner(readPlan({ plan: 'free', calls: 8000, limit: 10000, month: '2026-10' }), now);
  assert.deepEqual([hi.kind, hi.tone, hi.action], ['free_high', 'yellow', 'upgrade']);
  const lim = planBanner(readPlan({ plan: 'free', calls: 10000, limit: 10000, month: '2026-10' }), now);
  assert.deepEqual([lim.kind, lim.tone, lim.dismissible, lim.reset], ['limit', 'red', false, '2026-11-01']);
  assert.equal(planBanner(readPlan({ plan: 'free', calls: 7999, limit: 10000 }), now).kind, 'none');
  assert.equal(resetDay('2026-12'), '2027-01-01');
});

test('banner dismissal: 24 h, same kind only; the limit banner always shows', () => {
  const b = planBanner(readPlan({ plan: 'free', calls: 9000, limit: 10000 }), now);
  const d = dismissFor(b, now);
  assert.equal(bannerVisible(b, d, now + 1000), false);
  assert.equal(bannerVisible(b, d, now + day + 1), true);
  const lim = planBanner(readPlan({ plan: 'free', calls: 10000, limit: 10000 }), now);
  assert.equal(bannerVisible(lim, { kind: 'limit', until: now + day }, now), true);
  assert.equal(bannerVisible(lim, d, now), true, 'other kind dismissed');
});

test('pay links: only our own site', () => {
  assert.equal(readPlan({ renewUrl: 'https://bridgerator.recondeck.com/app/billing?x=1' }).renewUrl, 'https://bridgerator.recondeck.com/app/billing?x=1');
  for (const u of ['https://evil.example/pay', 'http://bridgerator.recondeck.com/app', 'https://bridgerator.recondeck.com.evil.example/', 'https://user:pw@bridgerator.recondeck.com/', 'javascript:alert(1)', undefined]) assert.equal(safeUrl(u), 'https://bridgerator.recondeck.com/app', String(u));
});
