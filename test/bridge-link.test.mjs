// The bridge's link loop (src/bridge.mjs connect()) against a hand-played relay over real wss://:
// reconnect and backoff timings, the 75 s silence watchdog, close codes 4003 / 4004, the 4 MB cap and
// broken or old-shape messages. Timers and the clock are mocked (node:test mock.timers), so the waits
// (5 s, 1–30 min, 75 s) are exact and instant; sockets and TLS are real. One bridge loop runs through
// the whole file, like on a PC: each test continues where the previous one left the link.
// LOGIC: see critical-logic/bridge.md (Lifecycle) and architecture.md (WS close codes).
import { shown } from './helpers/no-popups.mjs';
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import tls from 'node:tls';
import { selfSignedCert } from './helpers/tls.mjs';
import { startFakeRelay } from './helpers/fake-relay.mjs';

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));
async function until(pred, what, ms = 8000) {
  const t0 = performance.now();
  while (!pred()) { if (performance.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(3); }
}
const F = JSON.parse(fs.readFileSync(new URL('./fixtures/protocol/messages.json', import.meta.url), 'utf8'));
const pem = selfSignedCert();
const relay = await startFakeRelay(pem);
const { connect, replacedDelay } = await import('../src/bridge.mjs');

mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
const exits = [];
mock.method(process, 'exit', (code) => { exits.push(code); });
after(async () => { mock.timers.reset(); mock.restoreAll(); await relay.close(); });

const logs = [], links = [], plans = [], calls = [];
const log = (l) => logs.push(l);
const logged = (re) => logs.some((l) => re.test(l));
const lastReconnect = () => [...logs].reverse().find((l) => /reconnecting in/.test(l));
const reconnects = () => logs.filter((l) => /reconnecting in/.test(l)).length;
/** Waits for the NEXT scheduled reconnect and checks its log line. */
async function nextReconnect(re, what) { const n = reconnects(); await until(() => reconnects() > n, what); assert.match(lastReconnect(), re); }
let hold = null; // a call that answers only when the test says so
const dc = {
  tools: F.bridgeToRelay.hello.tools,
  resources: F.bridgeToRelay.hello.resources,
  mode: () => ({ confirm: 'off', readOnly: ['D:\\Архив 2025'], setupDone: false, queue: { todo: 2, doing: 1 }, paused: false }),
  async call(name, args) {
    calls.push({ name, args });
    if (name === 'explode') throw new Error('engine call failed');
    if (name === 'hold') return new Promise((r) => { hold = r; });
    if (name === 'slow') await sleep(args.ms);
    return { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }] };
  },
  readResource: async (uri) => (uri === 'ui://desktop-commander/file-preview' ? { result: F.bridgeToRelay.result_resource.result } : { error: 'unknown resource' }),
  onPlanMsg: (m) => plans.push(m),
  onLink: (s, n) => links.push(n === undefined ? s : `${s}:${n}`),
};
const cfg = { relay: relay.url, token: 'device-key-1', notify: {} };
const toasts = () => shown.filter((s) => s.toast);
let c; // the current relay-side connection

test('an untrusted certificate is refused (TLS checks stay on); after a failed connect the bridge retries in 5 s, once', async () => {
  connect(cfg, dc, log);
  await until(() => logged(/disconnected \(connect: .*certificate/i), 'TLS refusal');
  assert.equal(logs.filter((l) => /reconnecting in/.test(l)).length, 1, 'error + close of one attempt schedule ONE retry');
  assert.match(lastReconnect(), /reconnecting in 5s/);
  assert.equal(relay.count, 0, 'no WebSocket was opened over the untrusted certificate');
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), pem.cert]); // now the test relay is trusted
  mock.timers.tick(4999);
  await sleep(30);
  assert.equal(relay.count, 0, 'not before 5 s');
  mock.timers.tick(1);
  c = await relay.next();
});

test('hello: the key, the tools and the PC mode, in the shape of the shared fixture', async () => {
  const hello = await c.next((m) => m.type === 'hello');
  assert.deepEqual(Object.keys(hello).sort(), Object.keys(F.bridgeToRelay.hello).sort());
  assert.equal(hello.token, 'device-key-1');
  assert.deepEqual(hello.tools, dc.tools);
  assert.deepEqual(hello.resources, dc.resources);
  assert.deepEqual({ confirm: hello.confirm, readOnly: hello.readOnly, setupDone: hello.setupDone, queue: hello.queue, paused: hello.paused }, dc.mode());
  assert.ok(!('deviceName' in hello), 'the PC name is not sent (rename stays local, tasks/BRIDGE_CONTRACT)');
});

test('welcome with e-mail and plan: account e-mail and plan reach the window; the link turns online', async () => {
  c.send(F.relayToBridge.welcome_with_plan);
  await until(() => links.includes('online:Ноутбук Ивана'), 'online');
  assert.equal(dc.email, 'ivan@example.com');
  assert.deepEqual(plans.at(-1), F.relayToBridge.welcome_with_plan.plan);
  assert.ok(logged(/registered as "Ноутбук Ивана"/));
  c.send({ type: 'welcome', device: 'PC', email: 'x'.repeat(300) });
  await until(() => links.includes('online:PC'), 'second welcome');
  assert.equal(dc.email, 'ivan@example.com', 'an absurd e-mail is ignored');
});

test('calls: answered with the same callId; missing args = {}; parallel calls never mix; an engine error becomes an error result', async () => {
  c.send(F.relayToBridge.call);
  const r1 = await c.next((m) => m.type === 'result');
  assert.equal(r1.callId, F.relayToBridge.call.callId);
  assert.deepEqual(calls.at(-1), { name: 'read_file', args: F.relayToBridge.call.args });
  assert.match(r1.result.content[0].text, /заметки\.txt/);
  c.send(F.relayToBridge.call_no_args);
  assert.equal((await c.next((m) => m.callId === F.relayToBridge.call_no_args.callId)).result.content[0].text, 'list_sessions:{}');
  c.send({ type: 'call', callId: 'arr', name: 'read_file', args: ['C:\\x'] });
  await c.next((m) => m.callId === 'arr');
  assert.deepEqual(calls.at(-1).args, {}, 'args that are not an object are replaced by {}');
  // Slow first, fast last: the answers come back in finishing order, each with its own id.
  for (let i = 0; i < 5; i++) c.send({ type: 'call', callId: `p${i}`, name: 'slow', args: { ms: 60 - i * 12, i } });
  const got = [];
  for (let i = 0; i < 5; i++) got.push(await c.next((m) => m.type === 'result' && /^p\d$/.test(m.callId)));
  for (const r of got) assert.equal(JSON.parse(r.result.content[0].text.slice(5)).i, Number(r.callId.slice(1)));
  c.send({ type: 'call', callId: 'boom', name: 'explode', args: {} });
  const e = await c.next((m) => m.callId === 'boom');
  assert.deepEqual(e.result, F.bridgeToRelay.result_bridge_error.result);
});

test('broken or unknown messages from the relay are ignored: no answer, no crash, the link stays up', async () => {
  const before = calls.length;
  for (const bad of F.invalid.toBridge) c.send(bad.raw ?? JSON.parse(JSON.stringify(bad.msg).replace('<300 chars>', 'x'.repeat(300))));
  c.send({ type: 'call', callId: 'after-junk', name: 'read_file', args: { path: 'C:\\a.txt' } });
  const r = await c.next((m) => m.type === 'result');
  assert.equal(r.callId, 'after-junk', 'the first answer after the junk is for the good call');
  assert.equal(calls.length, before + 1, 'none of the junk reached the engine');
  assert.equal(c.ws.readyState, c.ws.OPEN);
  assert.equal(dc.email, 'ivan@example.com');
  assert.equal(toasts().length, 0, 'an unknown notice kind shows nothing');
  assert.deepEqual(plans.at(-1), F.invalid.toBridge.at(-1).msg, 'a plan message is handed on as is (cleaned by plan.readPlan, tested there)');
});

test('widgets: read_resource answered with the same callId; unknown resource → error', async () => {
  c.send(F.relayToBridge.read_resource);
  const r = await c.next((m) => m.callId === F.relayToBridge.read_resource.callId);
  assert.deepEqual(r, { ...F.bridgeToRelay.result_resource, callId: F.relayToBridge.read_resource.callId });
  c.send({ type: 'read_resource', callId: 'rr2', uri: 'file:///C:/Windows/win.ini' });
  assert.deepEqual(await c.next((m) => m.callId === 'rr2'), { ...F.bridgeToRelay.result_resource_error, callId: 'rr2' });
});

test('plan notices: shown on the PC with our own link only; "limit" can be muted in Notifications', async () => {
  c.send({ ...F.relayToBridge.notice_limit, renewUrl: 'https://evil.example/pay' });
  await until(() => toasts().length === 1, 'limit toast');
  assert.match(toasts()[0].toast, /monthly limit reached/);
  assert.doesNotMatch(toasts()[0].toast, /evil\.example/);
  // Our own link = the site this PC is linked to (derived from the relay address: staging stays on staging).
  assert.ok(toasts()[0].toast.includes(`${new URL(relay.url).origin.replace(/^wss:/, 'https:')}/app`), toasts()[0].toast);
  cfg.notify = { limit: false };
  c.send(F.relayToBridge.notice_limit); c.send(F.relayToBridge.notice_expired);
  c.send({ type: 'call', callId: 'fence', name: 'read_file', args: {} });
  await c.next((m) => m.callId === 'fence');
  await sleep(20);
  assert.equal(toasts().length, 1, 'muted: no limit / expired toast');
  cfg.notify = {};
  c.send(F.relayToBridge.notice_rename_failed);
  c.send({ type: 'call', callId: 'fence2', name: 'read_file', args: {} });
  await c.next((m) => m.callId === 'fence2');
  await sleep(20);
  assert.equal(toasts().length, 1, 'rename_failed has no notification text');
});

test('mode changes go to the relay over the live link', async () => {
  dc.onMode({ confirm: 'on', readOnly: [], setupDone: true, queue: { todo: 0, doing: 0 }, paused: true });
  assert.deepEqual(await c.next((m) => m.type === 'mode'), { type: 'mode', confirm: 'on', readOnly: [], setupDone: true, queue: { todo: 0, doing: 0 }, paused: true });
});

test('the link drops mid-call: the late answer is not sent anywhere; reconnect after exactly 5 s with a fresh hello', async () => {
  c.send({ type: 'call', callId: 'mid', name: 'hold', args: {} });
  await until(() => hold, 'held call');
  const r = nextReconnect(/close 1006\); reconnecting in 5s/, 'reconnect after the drop');
  c.ws.terminate();
  await r;
  assert.equal(links.at(-1), 'offline');
  hold({ content: [{ type: 'text', text: 'too late' }] }); hold = null;
  await sleep(20); // the late answer finds no open socket: nothing thrown
  dc.namePending = 'Ноутбук Ивана';           // X1-8: renamed on this PC while offline → sent once, in the next hello
  mock.timers.tick(4999); await sleep(30);
  const n = relay.count;
  mock.timers.tick(1);
  const c2 = await relay.next();
  assert.equal(relay.count, n + 1);
  const hello = await c2.next((m) => m.type === 'hello');
  assert.equal(hello.token, 'device-key-1');
  assert.equal(hello.deviceName, 'Ноутбук Ивана'); assert.equal(dc.namePending, 'Ноутбук Ивана', 'YB-16: kept until the relay accepts the hello (welcome)');
  assert.ok(!c.msgs.some((m) => m.callId === 'mid'), 'the dead socket got nothing');
  dc.onMode({ paused: false });
  assert.deepEqual(await c2.next((m) => m.type === 'mode'), { type: 'mode', paused: false }, 'mode now goes over the new link');
  c = c2;
  c.send(F.relayToBridge.welcome_old);
  await until(() => links.at(-1) === 'online:HOME-PC', 'online after an old-shape welcome (no e-mail, no plan)');
  assert.equal(dc.namePending, '', 'welcome: not again at the next hello (a rename in the cabinet stays)');
});

test('relay pings keep the link; 75 s of silence (sleep, Wi-Fi switch) drops it and reconnects in 5 s', async () => {
  const silentBefore = logs.filter((l) => /relay silent/.test(l)).length;
  for (let i = 0; i < 12; i++) {             // 3 minutes, a ping every 30 s like the relay
    if (i % 2 === 0) { const pong = new Promise((r) => c.ws.once('pong', r)); c.ws.ping(); await pong; }
    mock.timers.tick(15000);
    await sleep(2);
  }
  assert.equal(logs.filter((l) => /relay silent/.test(l)).length, silentBefore, 'pings keep it alive');
  assert.equal(c.ws.readyState, c.ws.OPEN);
  { const pong = new Promise((r) => c.ws.once('pong', r)); c.ws.ping(); await pong; }   // the last sign of life
  for (let i = 0; i < 5; i++) { mock.timers.tick(15000); await sleep(2); }  // then 75 s of nothing
  assert.equal(c.ws.readyState, c.ws.OPEN, 'not yet at exactly 75 s');
  const n = reconnects();
  mock.timers.tick(15000);
  await until(() => logs.filter((l) => /relay silent for 75s/.test(l)).length === silentBefore + 1, 'watchdog');
  await until(() => reconnects() > n, 'reconnect scheduled');
  assert.match(lastReconnect(), /reconnecting in 5s/);
  mock.timers.tick(5000);
  c = await relay.next();
  await c.next((m) => m.type === 'hello');
});

test('4004 (the key is used by another bridge): waits 1 min, then 2 min; told once; a welcome alone does not reset the wait, an hour on the link does', async () => {
  assert.deepEqual([1, 2, 3, 6, 7].map(replacedDelay), [60000, 120000, 240000, 1800000, 1800000]);
  const toastsBefore = toasts().length;
  let r = nextReconnect(/reconnecting in 60s/, '1 min'); c.ws.close(4004, 'replaced'); await r;
  assert.ok(logged(/another Bridgerator with this computer's key took over/));
  mock.timers.tick(59999); await sleep(30);
  const n = relay.count;
  assert.equal(relay.count, n);
  mock.timers.tick(1);
  c = await relay.next(); await c.next((m) => m.type === 'hello');
  r = nextReconnect(/reconnecting in 120s/, '2 min'); c.ws.close(4004, 'replaced'); await r;
  mock.timers.tick(120000);
  c = await relay.next(); await c.next((m) => m.type === 'hello');
  assert.equal(toasts().length, toastsBefore + 1, 'one "key used elsewhere" notification, not one per retry');
  assert.match(toasts().at(-1).toast, /used elsewhere/);
  // Two bridges with one key: each wins the link for a moment (welcome) — the wait keeps growing.
  c.send(F.relayToBridge.welcome);
  await until(() => links.at(-1) === 'online:HOME-PC', 'online');
  r = nextReconnect(/reconnecting in 240s/, '4 min: a welcome alone does not reset'); c.ws.close(4004, 'replaced'); await r;
  mock.timers.tick(240000);
  c = await relay.next(); await c.next((m) => m.type === 'hello');
  // The link then stays ours for over an hour (the relay's pings keep it alive) → back to 1 min.
  const on = links.length;
  c.send(F.relayToBridge.welcome);
  await until(() => links.length > on && links.at(-1) === 'online:HOME-PC', 'online again');
  for (let i = 0; i < 245; i++) { c.ws.ping(); await sleep(4); mock.timers.tick(15000); }
  r = nextReconnect(/reconnecting in 60s/, 'back to 1 min after an hour on the link'); c.ws.close(4004, 'replaced'); await r;
  mock.timers.tick(60000);
  c = await relay.next(); await c.next((m) => m.type === 'hello');
});

test('4005 (removed in the account) is a normal reconnect; a message over 4 MB closes the link (1009) and reconnects', async () => {
  let r = nextReconnect(/close 4005\); reconnecting in 5s/, '4005'); c.ws.close(4005, 'removed'); await r;
  mock.timers.tick(5000);
  c = await relay.next(); await c.next((m) => m.type === 'hello');
  c.send({ type: 'call', callId: 'big', name: 'read_file', args: { path: 'x'.repeat(4 * 1024 * 1024) } });
  r = nextReconnect(/reconnecting in 5s/, 'reconnect');
  assert.equal(await c.closed, 1009, 'the bridge refuses the oversized message');
  await r;
  assert.ok(!calls.some((x) => x.args?.path?.length > 1000), 'the oversized call never reached the engine');
  mock.timers.tick(5000);
  c = await relay.next(); await c.next((m) => m.type === 'hello');
});

test('4003 (key unknown / computer unlinked): the person is told, the bridge exits 0 and never reconnects', async () => {
  const n = relay.count, t = toasts().length;
  c.ws.close(4003, 'bad token');
  await until(() => exits.length === 1, 'exit');
  assert.deepEqual(exits, [0]);
  assert.match(toasts().at(-1).toast, /no longer linked/);
  assert.equal(toasts().length, t + 1);
  assert.ok(logged(/no longer linked to your Bridgerator account/));
  mock.timers.tick(60 * 60000); await sleep(50);
  assert.equal(relay.count, n, 'no reconnect after 4003');
});
