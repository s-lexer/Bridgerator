// Contract bridge ↔ relay over real wss://: the REAL relay hub (sibling repo bridgerator-relay, started
// in this process with a temporary store) and the REAL bridge link (src/bridge.mjs connect()) exchange
// hello / welcome / plan / mode / call / result / read_resource. Old-shape and broken messages are
// replayed from test/fixtures/protocol/messages.json (shared with the relay tests). Timers are mocked
// so the 30 s ping, the 1 s mode merge and the 5 s / 1 min reconnects are exact.
// No relay next to this repo → the relay part is a loud skip (NOT CHECKED), never a pass.
// LOGIC: see critical-logic/architecture.md (protocol), relay.md (hub), bridge.md.
import { shown } from './helpers/no-popups.mjs';
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import tls from 'node:tls';
import WebSocket from 'ws';
import { selfSignedCert } from './helpers/tls.mjs';
import { relayMissing, startRelay } from './helpers/relay.mjs';

const F = JSON.parse(fs.readFileSync(new URL('./fixtures/protocol/messages.json', import.meta.url), 'utf8'));
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));
async function until(pred, what, ms = 8000) {
  const t0 = performance.now();
  while (!(await pred())) { if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(3); }
}

test('the shared fixture has the documented shapes (both repos read it)', () => {
  const b = F.bridgeToRelay, r = F.relayToBridge;
  assert.deepEqual(Object.keys(b.hello).sort(), ['confirm', 'paused', 'queue', 'readOnly', 'resources', 'setupDone', 'token', 'tools', 'type']);
  for (const k of ['busy', 'paused', 'notConfirmed', 'refused']) assert.equal(b[`result_${k}`].result[k], true, k), assert.equal(b[`result_${k}`].result.isError, true);
  assert.ok(b.hello.tools.length >= 2 && b.hello.resources.length >= 2 && b.hello.readOnly.length >= 2, 'lists have at least 2 elements');
  assert.ok(b.hello.readOnly.some((p) => /[а-я]/i.test(p) && / /.test(p)), 'Cyrillic paths with spaces');
  assert.deepEqual(Object.keys(r.plan_free).sort(), ['calls', 'limit', 'month', 'plan', 'renewUrl', 'type']);
  for (const m of [...Object.values(b), ...Object.values(r)]) assert.equal(typeof m.type, 'string');
  assert.ok(Object.keys(F.closeCodes).includes('4003') && Object.keys(F.closeCodes).includes('4004'));
});

const missing = relayMissing();
if (missing) {
  test('bridge ↔ relay contract (real relay)', { skip: missing }, () => {});
} else {
  const pem = selfSignedCert();
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem.cert]);
  const relay = await startRelay({ tls: pem });
  const { connect } = await import('../src/bridge.mjs');
  const USER = 'ann@example.com';
  await relay.store.createUser(USER, 'ann-password-123');
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const exits = [];
  mock.method(process, 'exit', (code) => { exits.push(code); });
  after(async () => { mock.timers.reset(); mock.restoreAll(); await relay.close(); });
  const { hub, store } = relay;
  const online = () => hub.devicesForUser(USER);
  const fill = (m, tok) => JSON.parse(JSON.stringify(m).replace('"<token>"', JSON.stringify(tok)));

  // A raw client replaying fixture messages (old bridges in the field).
  function raw() {
    const ws = new WebSocket(relay.wsUrl);
    const got = [];
    const closed = new Promise((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (m) => got.push(JSON.parse(m)));
    return { ws, got, closed, opened: new Promise((r, j) => { ws.on('open', r); ws.on('error', j); }) };
  }

  test('every hello shape in the field is accepted (1.0.0, 1.0.2, current): welcome with the name and e-mail, then the plan', async () => {
    for (const [i, key] of ['hello_1_0_0', 'hello_1_0_2', 'hello'].entries()) {
      const d = store.addDevice(USER, `pc-${i}`);
      const c = raw(); await c.opened;
      c.ws.send(JSON.stringify(fill(F.bridgeToRelay[key], d.token)));
      await until(() => c.got.length >= 2, `${key} answered`);
      assert.deepEqual(Object.keys(c.got[0]).sort(), Object.keys(F.relayToBridge.welcome).sort(), 'welcome has the fixture shape');
      assert.deepEqual(c.got[0], { type: 'welcome', device: `pc-${i}`, email: USER });
      assert.deepEqual(Object.keys(c.got[1]).sort(), Object.keys(F.relayToBridge.plan_free).sort(), 'plan has the fixture shape');
      assert.equal(c.got[1].plan, 'free'); assert.equal(c.got[1].renewUrl.startsWith('https://bridgerator.recondeck.com/'), true);
      const dev = online().find((x) => x.name === `pc-${i}`);
      assert.deepEqual(dev.tools.map((t) => t.name), F.bridgeToRelay[key].tools.map((t) => t.name));
      if (key === 'hello') {
        assert.deepEqual(dev.mode, { confirm: 'off', readOnly: F.bridgeToRelay.hello.readOnly, setupDone: false, queue: { todo: 2, doing: 1 }, paused: false });
        assert.deepEqual(store.devicesOf(USER).find((x) => x.id === d.id).mode, { confirm: 'off', readOnly: 2, setupDone: false, queue: { todo: 2, doing: 1 }, paused: false }, 'the store keeps counts, never the read-only paths');
      } else {
        assert.deepEqual(dev.mode, { confirm: null, readOnly: [], setupDone: null, queue: null, paused: false }, 'an old bridge says nothing about its mode');
        assert.deepEqual(dev.resources.length, key === 'hello_1_0_2' ? 2 : 0);
      }
      c.ws.close(); await c.closed;
      store.deleteDevice(d.id);
    }
  });

  test('broken messages to the relay: closed with the documented code; junk after hello changes nothing; the relay keeps serving', async () => {
    for (const bad of F.invalid.toRelay) {
      const c = raw(); await c.opened;
      c.ws.send(bad.raw ?? JSON.stringify(bad.msg));
      if (bad.close) assert.equal(await c.closed, bad.close, bad.why);
      else { c.ws.send(JSON.stringify({ type: 'result', callId: 'x' })); assert.equal(await c.closed, 4002, `${bad.why}: ignored, then hello-first`); }
    }
    const d = store.addDevice(USER, 'junk-pc');
    const c = raw(); await c.opened;
    c.ws.send(JSON.stringify(fill(F.bridgeToRelay.hello, d.token)));
    await until(() => c.got.length >= 2, 'hello');
    const before = structuredClone(online().find((x) => x.name === 'junk-pc').mode);
    for (const bad of F.invalid.toRelayAfterHello) c.ws.send(bad.raw ?? JSON.stringify(bad.msg));
    mock.timers.tick(1000); await sleep(30);
    assert.equal(c.ws.readyState, c.ws.OPEN, 'still linked');
    assert.deepEqual(online().find((x) => x.name === 'junk-pc').mode, before, 'junk mode values are ignored');
    c.ws.close(); await c.closed; store.deleteDevice(d.id);
  });

  // The real bridge link with a scripted engine: results in the fixture shapes.
  const dev = store.addDevice(USER, 'Ноутбук Ивана');
  const logs = [], links = [], plans = [], calls = [];
  const log = (l) => logs.push(l);
  const reconnects = () => logs.filter((l) => /reconnecting in/.test(l)).length;
  let hold = null;
  const results = { busy: 'result_busy', pause: 'result_paused', nope: 'result_notConfirmed', denied: 'result_refused' };
  const dc = {
    tools: F.bridgeToRelay.hello.tools, resources: F.bridgeToRelay.hello.resources,
    mode: () => ({ confirm: 'off', readOnly: [], setupDone: true, queue: { todo: 0, doing: 0 }, paused: false }),
    async call(name, args) {
      calls.push(name);
      if (results[name]) return F.bridgeToRelay[results[name]].result;
      if (name === 'hold') return new Promise((r) => { hold = r; });
      if (name === 'echo') { await sleep(args.ms || 0); return { content: [{ type: 'text', text: JSON.stringify(args) }] }; }
      return F.bridgeToRelay.result_ok.result;
    },
    readResource: async (uri) => (uri === F.bridgeToRelay.result_resource.result.contents[0].uri ? { result: F.bridgeToRelay.result_resource.result } : { error: 'unknown resource' }),
    onPlanMsg: (m) => plans.push(m), onLink: (s, n) => links.push(n ? `${s}:${n}` : s),
  };
  const cfg = { relay: relay.wsUrl, token: dev.token, notify: {} };
  const logs2 = []; // the second bridge with the same key

  test('real bridge ↔ real relay: hello → welcome (name, e-mail) → plan; the PC shows up online with its tools', async () => {
    connect(cfg, dc, log);
    await until(() => links.includes('online:Ноутбук Ивана'), 'online');
    assert.equal(dc.email, USER);
    await until(() => plans.length, 'plan');
    assert.equal(plans[0].type, 'plan'); assert.equal(plans[0].limit, 10000);
    assert.deepEqual(online().map((x) => x.name), ['Ноутбук Ивана']);
    assert.deepEqual(online()[0].tools.map((t) => t.name), dc.tools.map((t) => t.name));
  });

  test('mode updates from the bridge are merged on the relay (at most once a second)', async () => {
    dc.onMode({ ...dc.mode(), confirm: 'on', readOnly: ['D:\\Архив 2025'] });
    await until(() => online()[0].mode.confirm === 'on', 'first mode applied at once');
    dc.onMode({ paused: true }); dc.onMode({ queue: { todo: 3, doing: 0 } });
    await sleep(30);
    assert.equal(online()[0].mode.paused, false, 'the next ones wait for the 1 s window');
    mock.timers.tick(1000);
    await until(() => online()[0].mode.paused === true, 'merged after 1 s');
    assert.deepEqual(online()[0].mode, { confirm: 'on', readOnly: ['D:\\Архив 2025'], setupDone: true, queue: { todo: 3, doing: 0 }, paused: true });
  });

  test('calls are routed by callId: 20 parallel calls each get their own answer; flags (busy/paused/notConfirmed/refused) pass through', async () => {
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => hub.callOnUserDevice(USER, 'echo', { i, ms: (20 - i) * 2, nonce: `n${i}-Привет` })));
    rs.forEach((r, i) => { assert.equal(r.type, 'result'); assert.deepEqual(JSON.parse(r.result.content[0].text), { i, ms: (20 - i) * 2, nonce: `n${i}-Привет` }); });
    assert.equal(new Set(rs.map((r) => r.callId)).size, 20);
    for (const [tool, fx] of Object.entries(results)) assert.deepEqual((await hub.callOnUserDevice(USER, tool, {})).result, F.bridgeToRelay[fx].result, tool);
    assert.deepEqual((await hub.callOnUserDevice(USER, 'read_file', { path: 'C:\\Users\\Иван Петров\\заметки.txt' })).result, F.bridgeToRelay.result_ok.result);
    const w = await hub.readResourceForUser(USER, 'ui://desktop-commander/file-preview');
    assert.deepEqual(w.result, F.bridgeToRelay.result_resource.result);
    assert.deepEqual((await hub.readResourceForUser(USER, 'ui://nope')), { error: 'resource not available' });
  });

  test('relay pings every 30 s, the bridge answers; a healthy link survives 3 minutes on both sides', async () => {
    const before = reconnects();
    for (let i = 0; i < 12; i++) { mock.timers.tick(15000); await sleep(15); }
    assert.equal(reconnects(), before, 'no drop');
    assert.equal(online().length, 1);
    assert.equal((await hub.callOnUserDevice(USER, 'read_file', {})).type, 'result');
  });

  test('the link drops mid-call: the waiting call gets "PC disconnected" at once; the bridge is back after 5 s', async () => {
    const pending = hub.callOnUserDevice(USER, 'hold', {});
    await until(() => hold, 'call reached the PC');
    const n = reconnects();
    relay.dropAll();
    assert.deepEqual(await pending, { error: 'PC disconnected — try again.', undelivered: true }); // undelivered: refunded (relay billing.md)
    await until(() => reconnects() > n, 'reconnect scheduled');
    assert.match(logs.filter((l) => /reconnecting in/.test(l)).at(-1), /reconnecting in 5s/);
    hold(F.bridgeToRelay.result_ok.result); hold = null;
    assert.equal(online().length, 0, 'offline while waiting');
    assert.match((await hub.callOnUserDevice(USER, 'read_file', {})).error, /offline/);
    mock.timers.tick(5000);
    await until(() => online().length === 1, 'back online');
    assert.equal((await hub.callOnUserDevice(USER, 'echo', { back: 1 })).result.content[0].text, '{"back":1}');
  });

  test('a second bridge with the same key takes the link: the first gets 4004 and waits 1 min', async () => {
    const links2 = [];
    const n = reconnects();
    connect({ ...cfg }, { ...dc, onLink: (s, nm) => links2.push(nm ? `${s}:${nm}` : s) }, (l) => logs2.push(l));
    await until(() => links2.includes('online:Ноутбук Ивана'), 'second online');
    await until(() => reconnects() > n, 'first one dropped');
    assert.match(logs.filter((l) => /reconnecting in/.test(l)).at(-1), /took over the link\); reconnecting in 60s/);
    assert.equal(online().length, 1);
    assert.ok(shown.some((s) => /used elsewhere/.test(s.toast)), 'the person at the first PC is told');
  });

  test('a removed computer: the relay kicks it (4005), refuses the key (4003), the bridge exits 0 and stays off', async () => {
    store.deleteDevice(dev.id);
    hub.kick(dev.id);
    await until(() => [...logs, ...logs2].some((l) => /close 4005/.test(l)), 'kicked');   // whichever loop held the link
    mock.timers.tick(60000);                                                // both loops retry with the dead key
    await until(() => exits.length >= 1, 'exit');
    assert.ok(exits.every((c) => c === 0));
    assert.ok(shown.some((s) => /no longer linked/.test(s.toast)));
    assert.equal(online().length, 0);
  });
}
