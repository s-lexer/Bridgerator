// Stress, parallel chats (engineering-process §2.2 item 6; mandatory before a release that touches the
// hub, the bridge call path, the queue or confirm): the REAL relay in this process and TWO real bridge
// processes (two PCs of one account) with the bundled engine; many "ChatGPT chats" call at once over
// MCP. Checks: every answer reaches its own call, routing by device name, the shared queue is never
// double-taken, the limit of 8 calls in flight per PC (the 9th waits for a free slot, then "busy",
// not counted), the link dropping with many calls in flight, and no leaked pending calls / timers.
// Run: npm run test:stress (about a minute; the busy check waits the real 30 s).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { selfSignedCert } from '../helpers/tls.mjs';
import { relayMissing, startRelay, textOf } from '../helpers/relay.mjs';
import { startBridgeChild } from '../helpers/bridge-proc.mjs';

const missing = relayMissing() || false;
const EMAIL = 'team@example.com', PW = 'team-password-2026';
const CHATS = 6, CALLS = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let relay, tok, root;
const pcs = {};               // name → { proc, work }
const held = [];              // questions on PC "A" waiting for the test to answer
const timers = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
const call = (name, args, device) => relay.callTool(tok, name, device ? { ...args, device } : args);

before(async () => {
  if (missing) return;
  const pem = selfSignedCert();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem.cert]);
  relay = await startRelay({ tls: pem });
  await relay.store.createUser(EMAIL, PW);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-stress-'));
  for (const name of ['Офис A', 'Дом B']) {
    const { token } = relay.store.addDevice(EMAIL, name);
    const work = path.join(root, `work ${name}`);
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(path.join(work, 'whoami.txt'), `this is ${name}\n`);
    for (let i = 0; i < CHATS * CALLS; i++) fs.writeFileSync(path.join(work, `файл-${i}.txt`), `nonce ${name} ${i}\n`);
    const proc = startBridgeChild({ token, relay: relay.wsUrl, allowedDirectories: [work] }, {
      cert: pem.cert, root: path.join(root, `pc-${name}`),
      onAsk: (q) => (name === 'Офис A' ? new Promise((resolve) => held.push({ q, resolve })) : 'deny'),
    });
    pcs[name] = { proc, work };
  }
  await Promise.all(Object.values(pcs).map((p) => p.proc.online()));
  tok = await relay.token(EMAIL, PW);
});
after(async () => { await Promise.all(Object.values(pcs).map((p) => p.proc.stop())); await relay?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

test('two PCs online: a call must name the device; each answer comes from the PC that was named', { skip: missing }, async () => {
  assert.match(textOf(await call('read_file', { path: 'x' })), /Specify "device"/);
  for (const name of Object.keys(pcs)) assert.match(textOf(await call('read_file', { path: path.join(pcs[name].work, 'whoami.txt') }, name)), new RegExp(`this is ${name}`));
  assert.match(textOf(await call('read_file', { path: 'x' }, 'Нет такого')), /Specify "device"|not online/);
});

test(`${CHATS} chats × ${CALLS} calls on both PCs at once: every answer is the right one; no pending calls or timers left`, { skip: missing }, async () => {
  await sleep(300);
  const t0 = timers(), c0 = { A: (await pcs['Офис A'].proc.resources()).filter((x) => x === 'Timeout').length };
  const before = relay.store.usage(EMAIL).calls;
  const jobs = [];
  for (let chat = 0; chat < CHATS; chat++) {
    jobs.push((async () => {
      for (let k = 0; k < CALLS; k++) {
        const i = chat * CALLS + k, name = i % 2 ? 'Дом B' : 'Офис A';
        const r = await call('read_file', { path: path.join(pcs[name].work, `файл-${i}.txt`) }, name);
        assert.match(textOf(r), new RegExp(`nonce ${name} ${i}\\b`), `chat ${chat} call ${k}`);
      }
    })());
  }
  // and a burst of 40 at the same instant on top
  const burst = Array.from({ length: 40 }, (_, i) => call('read_file', { path: path.join(pcs['Дом B'].work, `файл-${i}.txt`) }, 'Дом B')
    .then((r) => assert.match(textOf(r), new RegExp(`nonce Дом B ${i}\\b`))));
  await Promise.all([...jobs, ...burst]);
  assert.equal(relay.store.usage(EMAIL).calls - before, CHATS * CALLS + 40, 'every call counted once');
  await sleep(500);
  assert.ok(timers() <= t0 + 3, `relay timers back to the baseline (${t0} → ${timers()}): no pending calls left`);
  const cA = (await pcs['Офис A'].proc.resources()).filter((x) => x === 'Timeout').length;
  assert.ok(cA <= c0.A + 3, `bridge timers back to the baseline (${c0.A} → ${cA})`);
});

test('the shared task queue: 6 chats work through 30 tasks at once, each task taken exactly once', { skip: missing }, async () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ title: `Задача ${i + 1}: переименовать «счёт-${i}.pdf»` }));
  assert.equal(JSON.parse(textOf(await call('queue_add', { items }, 'Офис A'))).items.length, 30);
  const taken = [];
  await Promise.all(Array.from({ length: CHATS }, async (_, c) => {
    for (;;) {
      const it = JSON.parse(textOf(await call('queue_next', { worker: `chat ${c}` }, 'Офис A'))).item;
      if (!it) return;
      taken.push(it.id);
      await call('queue_update', { id: it.id, status: 'done', note: `done by chat ${c}` }, 'Офис A');
    }
  }));
  assert.equal(taken.length, 30); assert.equal(new Set(taken).size, 30, 'no task taken twice');
  assert.deepEqual(JSON.parse(textOf(await call('queue_list', {}, 'Офис A'))).counts, { todo: 0, doing: 0, done: 30, failed: 0, skipped: 0 });
  const file = JSON.parse(fs.readFileSync(path.join(pcs['Офис A'].proc.home, 'AppData', 'Roaming', 'Bridgerator', 'queue.json'), 'utf8'));
  assert.equal(file.items.length, 30, 'queue.json whole');
});

test('8 calls in flight per PC: the 9th waits for a free slot; when all 8 stay busy for 30 s it gets "busy" (not counted)', { skip: missing }, async () => {
  assert.match(textOf(await call('confirm_on', {}, 'Офис A')), /on/);
  const hold = (i) => call('start_process', { command: `Remove-Item -LiteralPath "${path.join(pcs['Офис A'].work, `нет-${i}.txt`)}"`, timeout_ms: 5000 }, 'Офис A');
  const holders = Array.from({ length: 8 }, (_, i) => hold(i));
  await sleep(1500);                                   // 8 slots taken (one question shown, 7 queued behind it)
  const ninth = call('read_file', { path: path.join(pcs['Офис A'].work, 'whoami.txt') }, 'Офис A');
  await sleep(1000);
  held.shift().resolve('deny');                        // one holder ends → its slot goes to the 9th
  assert.match(textOf(await ninth), /this is Офис A/, 'the 9th ran as soon as a slot was free');
  const holders2 = [...holders.slice(1), hold(8)];     // 8 in flight again
  await sleep(1500);
  const before = relay.store.usage(EMAIL).calls;
  const t = Date.now();
  const busy = await call('read_file', { path: path.join(pcs['Офис A'].work, 'whoami.txt') }, 'Офис A');
  const waited = Date.now() - t;
  assert.equal(busy.isError, true); assert.match(textOf(busy), /busy with other chats/);
  assert.ok(waited >= 29000 && waited < 40000, `busy after the 30 s wait (${waited} ms)`);
  assert.equal(relay.store.usage(EMAIL).calls, before, 'busy is not counted');
  assert.match(textOf(await call('read_file', { path: path.join(pcs['Дом B'].work, 'whoami.txt') }, 'Дом B')), /Дом B/, 'the other PC was never blocked');
  // the person denies everything that was waiting
  const deny = setInterval(() => { while (held.length) held.shift().resolve('deny'); }, 50);
  const res = await Promise.all([holders[0], ...holders2]);
  clearInterval(deny);
  for (const r of res) assert.match(textOf(r), /did not allow/);
  assert.match(textOf(await call('read_file', { path: path.join(pcs['Офис A'].work, 'whoami.txt') }, 'Офис A')), /Офис A/, 'all slots free again');
});

test('the link drops with 10 calls in flight: all answered "PC disconnected" at once; the PC is back and nothing leaks', { skip: missing }, async () => {
  const t0 = timers();
  const inflight = Array.from({ length: 10 }, (_, i) => call('start_process', { command: `Start-Sleep -Seconds 15; "late ${i}"`, timeout_ms: 30000 }, 'Дом B'));
  await sleep(1500);
  const t = Date.now();
  relay.dropAll();
  const rs = await Promise.all(inflight);
  for (const r of rs) assert.match(textOf(r), /PC disconnected|Specify "device"|offline/);
  assert.ok(Date.now() - t < 3000, 'answered at once');
  await Promise.all(Object.values(pcs).map((p) => p.proc.waitFor(() => p.proc.events.filter((e) => e.ev === 'link' && e.state === 'online').length >= 2, 'back online', 20000)));
  for (const name of Object.keys(pcs)) assert.match(textOf(await call('read_file', { path: path.join(pcs[name].work, 'whoami.txt') }, name)), new RegExp(name));
  await sleep(500);
  assert.ok(timers() <= t0 + 3, `relay timers back to the baseline (${t0} → ${timers()})`);
});
