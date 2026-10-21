// bridgerator doctor: every check ends ok / warn / fail / not_checked with a plain "what to do";
// network errors are named by cause; nothing is changed and the WebSocket probe carries no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runDoctor, formatDoctor, netWhy, handle, WIN_PS } from '../src/doctor.mjs';
import { NOT_WIN, psAst } from './helpers/ps.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CFG = { relay: 'wss://mcp.bridgerator.recondeck.com/link', token: 'br_dev_тест' };
const NOW = Date.parse('2026-10-20T12:00:00Z');
const WIN_OK = { psVersion: '5.1.22621.4111', languageMode: 'FullLanguage', policies: { MachinePolicy: 'Undefined', UserPolicy: 'Undefined', Process: 'Bypass', CurrentUser: 'Undefined', LocalMachine: 'Restricted' }, webview2: '130.0.2849.56', task: { state: 3 }, proxy: { enabled: false, server: '', pac: '' } };
const resp = (status, body, date = new Date(NOW).toUTCString()) => ({ ok: status < 400, status, headers: { get: (h) => (h.toLowerCase() === 'date' ? date : null) }, json: async () => body });
function fakeFetch(routes) {
  const seen = [];
  const f = async (url, opts) => {
    seen.push({ url, body: opts?.body });
    for (const [re, r] of routes) if (re.test(url)) { if (r instanceof Error) throw r; return typeof r === 'function' ? r(url, opts) : r; }
    throw new Error(`unexpected ${url}`);
  };
  f.seen = seen;
  return f;
}
const okRoutes = () => [[/registry\.npmjs\.org/, resp(200, { version: '1.0.8' })], [/\/healthz$/, resp(200, { ok: true })], [/\/pair\/check$/, resp(200, { ok: true })]];
const deps = (over = {}) => ({ version: '1.0.8', fetch: fakeFetch(okRoutes()), wsOpen: async () => ({ ok: true }), runPs: async () => ({ code: 0, stdout: JSON.stringify(WIN_OK), stderr: '' }), now: () => NOW, statfs: () => ({ bavail: 50 * 1024 * 1024, bsize: 4096 }), platform: 'win32', nodeVersion: '22.11.0', configDir: 'C:\\Users\\Алексей\\AppData\\Roaming\\Bridgerator', ...over });
const by = (r, id) => r.results.find((x) => x.id === id);

test('a healthy PC: every check ok, the report says so; the key goes only to /pair/check', async () => {
  const d = deps();
  const r = await runDoctor(CFG, d);
  assert.equal(r.ok, true);
  const bad = r.results.filter((x) => x.status !== 'ok');
  assert.deepEqual(bad, []);
  for (const id of ['node', 'version', 'relay', 'clock', 'websocket', 'key', 'powershell', 'policy', 'webview2', 'autostart', 'proxy']) assert.ok(by(r, id), id);
  assert.ok(r.results.some((x) => x.id.startsWith('disk C:')));
  assert.equal(r.results.filter((x) => x.id.startsWith('disk')).length, 1, 'the config folder and the system drive on C: are one check');
  const withKey = d.fetch.seen.filter((s) => String(s.body || '').includes(CFG.token));
  assert.deepEqual(withKey.map((s) => new URL(s.url).pathname), ['/pair/check']);
  assert.match(formatDoctor(r), /All needed checks passed/);
});

test('Restricted script policy is fine (Bridgerator does not need it changed); a GPO policy is a warning', async () => {
  assert.equal(by(await runDoctor(CFG, deps()), 'policy').status, 'ok');
  const r = await runDoctor(CFG, deps({ runPs: async () => ({ code: 0, stdout: JSON.stringify({ ...WIN_OK, policies: { ...WIN_OK.policies, MachinePolicy: 'AllSigned' } }), stderr: '' }) }));
  assert.equal(by(r, 'policy').status, 'warn');
  assert.match(by(r, 'policy').title, /AllSigned/);
});

test('server not reachable: the cause in plain words (DNS / refused / TLS inspection), clock not checked', async () => {
  const cases = [[Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), /DNS/], [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), /refused/], [Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }), /certificate/]];
  for (const [err, re] of cases) {
    const r = await runDoctor(CFG, deps({ fetch: fakeFetch([[/registry/, resp(200, { version: '1.0.8' })], [/healthz/, err], [/pair\/check/, err]]), wsOpen: async () => ({ ok: false, error: err }) }));
    assert.equal(r.ok, false);
    assert.equal(by(r, 'relay').status, 'fail');
    assert.match(by(r, 'relay').detail, re);
    assert.ok(by(r, 'relay').fix);
    assert.equal(by(r, 'clock').status, 'not_checked');
    assert.equal(by(r, 'key').status, 'not_checked', 'an unreachable server is not "key rejected"');
  }
});

test('a removed PC (key rejected), a clock 10 minutes off, an old version, no WebView2, autostart off', async () => {
  const fetch = fakeFetch([[/registry/, resp(200, { version: '1.1.0' })], [/healthz/, resp(200, { ok: true }, new Date(NOW - 10 * 60000).toUTCString())], [/pair\/check/, resp(401, {})]]);
  const runPs = async () => ({ code: 0, stdout: JSON.stringify({ ...WIN_OK, webview2: null, task: { state: 1 } }), stderr: '' });
  const r = await runDoctor(CFG, deps({ fetch, runPs }));
  assert.equal(by(r, 'key').status, 'fail');
  assert.match(by(r, 'key').fix, /install command/);
  assert.equal(by(r, 'clock').status, 'fail');
  assert.match(by(r, 'clock').title, /10 min/);
  assert.equal(by(r, 'version').status, 'warn');
  assert.equal(by(r, 'webview2').status, 'warn');
  assert.equal(by(r, 'autostart').status, 'warn');
  const text = formatDoctor(r);
  assert.match(text, /What to do: /);
  assert.match(text, /2 problems found/);
});

test('autostart: missing task fails; the pre-1.0.8 shared task is a warning to update', async () => {
  const run = (task) => runDoctor(CFG, deps({ runPs: async () => ({ code: 0, stdout: JSON.stringify({ ...WIN_OK, task }), stderr: '' }) }));
  assert.equal(by(await run({ missing: true }), 'autostart').status, 'fail');
  assert.equal(by(await run({ state: 3, old: true }), 'autostart').status, 'warn');
  assert.equal(by(await run({ state: 4 }), 'autostart').status, 'ok');
});

test('a proxy in Windows: warning while the link works, a problem with advice when the server is unreachable', async () => {
  const proxy = { enabled: true, server: 'proxy.firma.local:3128', pac: '' };
  const runPs = async () => ({ code: 0, stdout: JSON.stringify({ ...WIN_OK, proxy }), stderr: '' });
  assert.equal(by(await runDoctor(CFG, deps({ runPs })), 'proxy').status, 'warn');
  const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
  const r = await runDoctor(CFG, deps({ runPs, fetch: fakeFetch([[/registry/, err], [/healthz/, err], [/pair/, err]]), wsOpen: async () => ({ ok: false, error: err }) }));
  assert.equal(by(r, 'proxy').status, 'fail');
  assert.match(by(r, 'proxy').fix, /mcp\.bridgerator\.recondeck\.com/);
  assert.equal(by(r, 'version').status, 'not_checked', 'the update check failing is "not checked", not "latest"');
});

test('WebSockets blocked by a proxy (HTTP 403 from the proxy is fine, other refusals fail); a constrained PowerShell warns', async () => {
  assert.equal(by(await runDoctor(CFG, deps({ wsOpen: async () => ({ ok: false, status: 401 }) })), 'websocket').status, 'ok', 'the relay refusing a key-less probe still proves the path works');
  assert.equal(by(await runDoctor(CFG, deps({ wsOpen: async () => ({ ok: false, status: 502 }) })), 'websocket').status, 'fail');
  const r = await runDoctor(CFG, deps({ runPs: async () => ({ code: 0, stdout: JSON.stringify({ ...WIN_OK, languageMode: 'ConstrainedLanguage' }), stderr: '' }) }));
  assert.equal(by(r, 'powershell').status, 'warn');
});

test('PowerShell that does not run at all is a problem; low disk space warns / fails; old Node fails', async () => {
  const r = await runDoctor(CFG, deps({ runPs: async () => { throw new Error('spawn EPERM'); }, statfs: () => ({ bavail: 100, bsize: 1024 * 1024 }), nodeVersion: '20.11.1' }));
  assert.equal(by(r, 'powershell').status, 'fail');
  assert.equal(r.results.find((x) => x.id.startsWith('disk')).status, 'fail');
  assert.equal(by(r, 'node').status, 'fail');
  const w = await runDoctor(CFG, deps({ statfs: () => ({ bavail: 600, bsize: 1024 * 1024 }) }));
  assert.equal(w.results.find((x) => x.id.startsWith('disk')).status, 'warn');
});

test('not set up / no key: plain advice, no network calls with a key', async () => {
  const r = await runDoctor(null, deps());
  assert.equal(by(r, 'config').status, 'fail');
  const r2 = await runDoctor({ relay: CFG.relay }, deps());
  assert.equal(by(r2, 'key').status, 'fail');
});

test('netWhy names timeouts and unknown errors without a stack', () => {
  assert.match(netWhy(Object.assign(new Error('x'), { name: 'TimeoutError' }))[0], /no answer in time/);
  const [why] = netWhy(new Error('weird\n    at foo (file.js:1:1)'));
  assert.ok(why.length <= 120);
});

test('the tool: one action "check", read-only, uses the bridge link state', async () => {
  const r = await handle('bridgerator_doctor', { action: 'check' }, { cfg: CFG, version: '1.0.8', rpc: async () => ({ state: 'online' }), runPs: deps().runPs, fetch: fakeFetch(okRoutes()), wsOpen: async () => ({ ok: true }) });
  const j = JSON.parse(r.content[0].text);
  assert.equal(j.results.find((x) => x.id === 'link').status, 'ok');
});

test('the doctor PowerShell script parses under Windows PowerShell 5.1', { skip: NOT_WIN }, async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')), 'doctor.ps1');
  fs.writeFileSync(f, WIN_PS);
  const [r] = await psAst([f]);
  assert.deepEqual(r.errors, []);
});
