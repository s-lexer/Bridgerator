import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noticeText, toastXml, ACCOUNT_URL } from '../src/notice.mjs';

test('plan notices: pay button with our own link only, XML-escaped, unknown kind ignored', () => {
  assert.match(noticeText({ kind: 'limit', calls: 10000, limit: 10000 }).body, /10000 of 10000/);
  assert.match(noticeText({ kind: 'expiring', until: '2026-11-01T00:00:00Z' }).title, /2026-11-01/);
  assert.equal(noticeText({ kind: 'expired' }).button, 'Renew Pro');
  assert.equal(noticeText({ kind: 'expired', renewUrl: 'https://evil.example/' }).url, ACCOUNT_URL);
  assert.equal(noticeText({ kind: 'limit', calls: 1, limit: 1, renewUrl: 'https://bridgerator.recondeck.com/app/pay' }).url, 'https://bridgerator.recondeck.com/app/pay');
  assert.equal(noticeText({ kind: 'unlinked' }).button, 'Open account');
  assert.equal(noticeText({ kind: 'whatever' }), undefined);
  assert.match(noticeText({ kind: 'unlinked' }).body, /install command/);
  const x = toastXml({ title: 'a<b>&"\'', body: 'b', button: 'c' });
  assert.ok(x.includes('a&lt;b&gt;&amp;&quot;&apos;') && x.includes(`arguments="${ACCOUNT_URL}"`));
});

test('notices: relay values validated strictly — junk numbers / dates / kinds give no notice', () => {
  assert.equal(noticeText({ kind: 'limit', calls: '1; calc', limit: 10 }), undefined);
  assert.equal(noticeText({ kind: 'limit', calls: 1.5, limit: 10 }), undefined);
  assert.equal(noticeText({ kind: 'expiring', until: "2026-11-01'; calc" }), undefined);
  assert.equal(noticeText({ kind: 'expiring', until: '2026-11-01T00:00:00Z' }).title, 'Bridgerator Pro ends on 2026-11-01');
  assert.equal(noticeText({ kind: 'expiring', until: 'tomorrow' }), undefined);
  assert.equal(noticeText({ kind: 'constructor' }), undefined);
  assert.match(noticeText({ kind: 'replaced' }).body, /took over/);
});

test('update from the window: "updating" before the hidden installer, "updated" from the new version; only a plain x.y.z version', () => {
  assert.equal(noticeText({ kind: 'updating', version: '1.2.0' }).title, 'Bridgerator is updating to 1.2.0');
  assert.equal(noticeText({ kind: 'updated', version: '1.2.0' }).title, 'Bridgerator updated to 1.2.0');
  assert.equal(noticeText({ kind: 'updated', version: '1.2.0' }).button, null);
  assert.match(noticeText({ kind: 'update_available', version: '1.2.0' }).title, /1\.2\.0 is available/);
  assert.equal(noticeText({ kind: 'update_available', version: 'x' }), undefined);
  for (const v of ['', '1.2', '1.2.0<x>', null]) assert.equal(noticeText({ kind: 'updating', version: v }), undefined, String(v));
});

test('queue_done title: control chars are stripped (a raw one makes the toast XML invalid)', () => {
  const n = noticeText({ kind: 'queue_done', title: 'a\u0000b\u001fc' });
  assert.doesNotMatch(n.body, /[\u0000-\u001f]/);
});

test('X1-14/X1-30: links follow the linked site; prod renewUrl stays allowed, other origins never', async () => {
  const { setSite } = await import('../src/plan.mjs');
  setSite('https://staging.example.test');
  assert.equal(noticeText({ kind: 'unlinked' }).url, 'https://staging.example.test/app');
  assert.match(toastXml({ title: 't', body: 'b', button: 'c' }), /arguments="https:\/\/staging\.example\.test\/app"/);
  assert.equal(noticeText({ kind: 'expired', renewUrl: 'https://bridgerator.recondeck.com/app/pay' }).url, 'https://bridgerator.recondeck.com/app/pay');
  assert.equal(noticeText({ kind: 'expired', renewUrl: 'https://staging.example.test/app/pay' }).url, 'https://staging.example.test/app/pay');
  assert.equal(noticeText({ kind: 'expired', renewUrl: 'https://evil.example/' }).url, 'https://staging.example.test/app');
});

test('V-9: confirm.ini held by another program — a plain notice, no button, nothing about the relay', () => {
  const n = noticeText({ kind: 'confirm_locked' });
  assert.equal(n.title, 'Bridgerator: the setting was not changed');
  assert.match(n.body, /Another program is using confirm\.ini/);
  assert.equal(n.button, null);
  assert.doesNotMatch(toastXml(n), /<actions>/);
});
