import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { payload, send, usage, TELEMETRY_URL } from '../src/telemetry.mjs';

const cfg = { installId: 'id-1', token: 'SECRET', allowedDirectories: ['C:\\Users\\x'], relay: 'wss://r' };

test('telemetry payload: only the disclosed fields, HTTPS, opt-out respected, failures silent', async () => {
  assert.deepEqual(Object.keys(payload(cfg, 'install')).sort(), ['event', 'id', 'lang', 'node', 'os', 'version']);
  assert.match(TELEMETRY_URL, /^https:\/\//);
  const sent = [];
  const f = async (u, o) => { sent.push([u, JSON.parse(o.body)]); };
  await send(cfg, 'install', undefined, { fetch: f });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(JSON.stringify(sent), /SECRET|Users|wss/);
  await send({ ...cfg, telemetryEnabled: false }, 'install', undefined, { fetch: f });
  assert.equal(sent.length, 1, 'off = nothing sent');
  await send(cfg, 'install', undefined, { fetch: async () => { throw new Error('offline'); } }); // no throw
});

test('heartbeat: counts only known tool names, sends once a day, then resets', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brg-t-')), 'usage.json');
  let t = 1000;
  const out = [];
  const u = usage(cfg, new Set(['read_file']), file, { now: () => t, sendFn: async (c, ev, x) => out.push([ev, x]) });
  u.count('read_file', false); u.count('read_file', true); u.count('C:\\secret\\made-up', false);
  await u.tick();
  assert.equal(out.length, 0);
  t += 24 * 3600 * 1000;
  await u.tick();
  assert.deepEqual(out, [['heartbeat', { calls: { read_file: 2 }, errors: { read_file: 1 } }]]);
  assert.deepEqual(u.state().calls, {});
});

test('B1-24: two bridge processes on one counters file add up (no last-writer-wins)', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brg-t2-')), 'usage.json');
  const a = usage(cfg, new Set(['read_file']), file, { now: () => 1000 });
  const b = usage(cfg, new Set(['read_file']), file, { now: () => 1000 });
  a.count('read_file'); a.count('read_file'); b.count('read_file', true);
  await a.tick(); await b.tick();
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([j.calls.read_file, j.errors.read_file], [3, 1]);
});

test('X1-9 / YB-3: a locked usage file (EBUSY/EPERM/EACCES) keeps in-memory counters and since; retried next tick', async (t0) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-t3-'));
  const file = path.join(dir, 'usage.json');
  fs.writeFileSync(file, JSON.stringify({ since: 1000, calls: {}, errors: {} }));
  const real = fs.readFileSync;
  let locked = true;
  t0.mock.method(fs, 'readFileSync', (f, ...a) => { if (locked && f === file) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real(f, ...a); });
  let t = 1000;
  const out = [];
  const u = usage(cfg, new Set(['read_file']), file, { now: () => t, sendFn: async (c, ev, x) => out.push([ev, x]) });
  u.count('read_file', true);
  t += 25 * 3600 * 1000;
  await u.tick();
  assert.equal(out.length, 0, 'no heartbeat / reset while the file is locked');
  assert.deepEqual([u.state().since, u.state().calls.read_file, u.state().errors.read_file], [1000, 1, 1]);
  locked = false; // unlocked: the counted calls are added to the file and the day's heartbeat goes
  await u.tick();
  assert.deepEqual(out, [['heartbeat', { calls: { read_file: 1 }, errors: { read_file: 1 } }]]);
});

test('YB-3: a corrupt / empty / wrong-shape usage.json is rewritten fresh — counting and the daily send never stop', async () => {
  for (const bad of ['{not json', '', 'null', '[1,2]']) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brg-t4-')), 'usage.json');
    fs.writeFileSync(file, bad);
    let t = 1000;
    const out = [];
    const u = usage(cfg, new Set(['read_file']), file, { now: () => t, sendFn: async (c, ev, x) => out.push([ev, x]) });
    u.count('read_file', false);
    await u.tick();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).calls.read_file, 1, `file repaired (${JSON.stringify(bad)})`);
    t += 24 * 3600 * 1000;
    u.count('read_file', false);
    await u.tick();
    assert.deepEqual(out, [['heartbeat', { calls: { read_file: 2 }, errors: {} }]], 'heartbeat still sent');
  }
});

test('ZB-2/4: any read error but ENOENT (EIO, EISDIR...) keeps the file and the in-memory counters; retried next tick', async (t0) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brg-t5-')), 'usage.json');
  fs.writeFileSync(file, JSON.stringify({ since: 1000, calls: { read_file: 7 }, errors: {} }));
  const real = fs.readFileSync;
  let bad = true;
  t0.mock.method(fs, 'readFileSync', (f, ...a) => { if (bad && f === file) throw Object.assign(new Error('io'), { code: 'EIO' }); return real(f, ...a); });
  let t = 2000;
  const u = usage(cfg, new Set(['read_file']), file, { now: () => t, sendFn: async () => {} });
  u.count('read_file', false);
  await u.tick();
  assert.equal(JSON.parse(real(file, 'utf8')).calls.read_file, 7, 'file not overwritten by the delta');
  bad = false;
  await u.tick();
  assert.equal(JSON.parse(real(file, 'utf8')).calls.read_file, 8, 'delta added once the read works');
});

test('ZB-2: counters on disk that are not finite non-negative numbers are dropped on load', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brg-t6-')), 'usage.json');
  fs.writeFileSync(file, JSON.stringify({ since: 1000, calls: { read_file: 'x', a: -1, b: null, c: 3, d: 1e400, e: 1.5, f: 2 ** 60 }, errors: { read_file: {} }, junk: 'C:\\secret' }));
  const u = usage(cfg, new Set(['read_file']), file, { now: () => 2000, sendFn: async () => {} });
  u.count('read_file', true);
  await u.tick();
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([j.calls, j.errors], [{ c: 3, read_file: 1 }, { read_file: 1 }]);
  assert.deepEqual(Object.keys(j).sort(), ['calls', 'errors', 'since'], 'W-6: unknown top-level keys dropped');
});

test('W-5: a permanently unreadable usage file (a folder: EISDIR) stops telemetry only for a few ticks', async () => {
  const file = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-t7-')); // usage.json is a directory
  let t = 1000;
  const out = [];
  const u = usage(cfg, new Set(['read_file']), file, { now: () => t, sendFn: async (c, ev, x) => out.push([ev, x]) });
  u.count('read_file', false);
  t += 25 * 3600 * 1000;
  await u.tick(); await u.tick();
  assert.equal(out.length, 0, 'retried first');
  await u.tick();
  assert.deepEqual(out, [['heartbeat', { calls: { read_file: 1 }, errors: {} }]], 'then goes on from memory');
  u.count('read_file', false);
  assert.equal(u.state().calls.read_file, 1, 'counting goes on after the reset');
});
