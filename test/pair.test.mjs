import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pair, siteOf, checkKey } from '../src/pair.mjs';

const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
const quiet = { log: () => {}, sleep: async () => {} };

test('site host from the relay URL', () => {
  assert.equal(siteOf('wss://mcp.bridgerator.recondeck.com/link'), 'https://bridgerator.recondeck.com');
  assert.equal(siteOf('ws://127.0.0.1:8137/link'), 'http://127.0.0.1:8137');
});

test('pairing: prints/opens the code page, polls until confirmed, returns the device key', async () => {
  const calls = [], opened = [];
  let polls = 0;
  const fetch = async (url, o) => {
    calls.push([url, JSON.parse(o.body)]);
    if (url.endsWith('/pair/start')) return res(200, { code: 'ABCD-EF23', poll: 'p'.repeat(64), url: 'https://evil.example/', expiresIn: 900 });
    return ++polls < 3 ? res(202, { status: 'pending' }) : res(200, { token: 'tok', name: 'HOME-PC-2' });
  };
  const r = await pair('https://bridgerator.recondeck.com', 'HOME-PC', { ...quiet, fetch, open: (u) => opened.push(u) });
  assert.deepEqual(r, { token: 'tok', name: 'HOME-PC-2' });
  assert.deepEqual(calls[0], ['https://bridgerator.recondeck.com/pair/start', { name: 'HOME-PC' }]);
  assert.deepEqual(calls[1], ['https://bridgerator.recondeck.com/pair/poll', { poll: 'p'.repeat(64) }]);
  assert.deepEqual(opened, ['https://bridgerator.recondeck.com/pair?code=ABCD-EF23'], 'opens our own site, not a URL from the answer');
});

test('pairing: an expired code (410) stops with a clear error; network errors are retried', async () => {
  let n = 0;
  const fetch = async (url) => {
    if (url.endsWith('/pair/start')) return res(200, { code: 'ABCD-EF23', poll: 'x', expiresIn: 900 });
    if (++n === 1) throw new Error('ECONNRESET');
    return res(410, { error: 'expired' });
  };
  await assert.rejects(pair('https://s.test', 'pc', { ...quiet, fetch, open: () => {} }), /expired/);
  assert.equal(n, 2);
});


test('pairing: 404 / 429 stop polling with a clear error; the linked account email is passed on', async () => {
  for (const [status, re] of [[404, /no longer valid/], [429, /too many attempts/]]) {
    let n = 0;
    const fetch = async (url) => (url.endsWith('/pair/start') ? res(200, { code: 'ABCD-EF23', poll: 'x', expiresIn: 900 }) : (n++, res(status, {})));
    await assert.rejects(pair('https://s.test', 'pc', { ...quiet, fetch, open: () => {} }), re);
    assert.equal(n, 1);
  }
  const fetch = async (url) => (url.endsWith('/pair/start') ? res(200, { code: 'ABCD-EF23', poll: 'x', expiresIn: 900 }) : res(200, { token: 't', email: 'a@b.c' }));
  assert.deepEqual(await pair('https://s.test', 'pc', { ...quiet, fetch, open: () => {} }), { token: 't', name: 'pc', email: 'a@b.c' });
});

test('stored key check: 401 = rejected, 200 ok = ok, anything else / network = unknown (keep the key)', async () => {
  let sent;
  assert.equal(await checkKey('https://s.test', 'k', { fetch: async (u, o) => { sent = [u, JSON.parse(o.body)]; return res(200, { ok: true }); } }), 'ok');
  assert.deepEqual(sent, ['https://s.test/pair/check', { token: 'k' }]);
  assert.equal(await checkKey('https://s.test', 'k', { fetch: async () => res(401, {}) }), 'rejected');
  assert.equal(await checkKey('https://s.test', 'k', { fetch: async () => res(503, {}) }), 'unknown');
  assert.equal(await checkKey('https://s.test', 'k', { fetch: async () => { throw new Error('ENOTFOUND'); } }), 'unknown');
});

test('pairing sends only a fingerprint of MachineGuid + user SID, never the raw values', async () => {
  const { machineFp } = await import('../src/pair.mjs');
  const guid = '1b2c3d4e-0000-4a5b-9c8d-112233445566', sid = 'S-1-5-21-1111-2222-3333-1001';
  const fp = machineFp(guid, sid);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(machineFp(guid.toUpperCase(), sid.toLowerCase()), fp, 'stable across letter case');
  assert.notEqual(machineFp(guid, 'S-1-5-21-1111-2222-3333-1002'), fp, 'another user = another fingerprint');
  assert.equal(machineFp('', sid), ''); assert.equal(machineFp(guid, 'nobody'), '');
  let body;
  const fetch = async (url, o) => { if (url.endsWith('/pair/start')) { body = o.body; return res(200, { code: 'ABCD-EF23', poll: 'x', expiresIn: 900 }); } return res(200, { token: 't' }); };
  await pair('https://s.test', 'pc', { ...quiet, fetch, open: () => {}, fp });
  assert.deepEqual(JSON.parse(body), { name: 'pc', fp });
  assert.ok(!body.includes(guid) && !body.includes(sid), 'raw values never sent');
});

test('this PC: fingerprint is computed from the real MachineGuid + SID', { skip: process.platform !== 'win32' }, async () => {
  process.env.BRIDGERATOR_HOME ||= fs.mkdtempSync(path.join(os.tmpdir(), 'brg-fp-'));
  const cwd = process.cwd();
  const { thisPcFp } = await import('../src/cli.mjs');
  process.chdir(cwd);
  assert.match(thisPcFp(), /^[0-9a-f]{64}$/);
});

test('B1-32: pairing and the key check never go over plain http (except this PC itself)', async () => {
  let sent = 0;
  const fetch = async () => { sent++; return res(200, {}); };
  await assert.rejects(pair('http://bridgerator.example', 'pc', { ...quiet, fetch, open: () => {} }), /https/);
  assert.equal(await checkKey('http://bridgerator.example', 'k', { fetch }), 'unknown');
  assert.equal(sent, 0, 'the key never left');
  await assert.rejects(pair('http://127.0.0.1:1', 'pc', { ...quiet, fetch: async () => res(503, {}), open: () => {} }), /HTTP 503/, 'loopback allowed');
});
