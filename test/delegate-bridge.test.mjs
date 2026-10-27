// bridgerator_delegate inside the REAL bridge (bundled engine started): listed in hello, its settings in
// getState / bridgerator_settings (lowering protection waits for the PC; narrowing is direct; a hand
// edit of config.json shows live), a run of a FAKE agent with Undo through bridgerator_undo, the relay
// event of a background run. No windows (the PC question is a fake, notification PowerShell is
// intercepted); no real agent CLI is started. LOGIC: critical-logic/bridge.md ("AI ↔ AI delegation").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fakeAgents } from './helpers/fake-agents.mjs';

const realExecFile = cp.execFile;
cp.execFile = (file, args, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (/powershell\.exe$/i.test(String(file))) { setImmediate(() => cb?.(null, '', '')); return { on() {}, kill() {} }; }
  return realExecFile(file, args, opts, cb);
};
syncBuiltinESMExports();

const win = process.platform === 'win32';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-deleg-b-'));
const fx = fakeAgents(root);
Object.assign(process.env, { USERPROFILE: fx.home, APPDATA: fx.appData, LOCALAPPDATA: fx.local });
const DIR = path.join(fx.appData, 'Bridgerator');
const work = path.join(root, 'Работа', 'Отчёт');
for (const d of [DIR, work]) fs.mkdirSync(d, { recursive: true });

const { startEngine } = await import('../src/bridge.mjs');
const { ensureIni } = await import('../src/confirm.mjs');
const CONFIG = path.join(DIR, 'config.json'), INI = path.join(DIR, 'confirm.ini');
const base = { askSettings: true, relay: 'wss://relay.invalid/link', token: 'brk_test_key_0123456789', allowedDirectories: [], deniedDirectories: [], readOnlyDirectories: [], telemetryEnabled: false, localHistory: false, setupDone: true, protectSensitive: false };
fs.writeFileSync(CONFIG, JSON.stringify(base, null, 2));
ensureIni(INI);

let answer = 'deny';
const asked = [], events = [];
let dc;
const text = (r) => (r.content || []).map((c) => c.text).join('\n');
const body = (r) => JSON.parse(r.content[0].text);
const waitFor = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

before(async () => {
  dc = await startEngine({ ...base, dcConfigDir: path.join(DIR, 'dc'), configDir: DIR, confirmIni: INI, configFile: CONFIG, snapshotsDir: path.join(fx.local, 'Bridgerator', 'snapshots') }, () => {},
    { ask: async (q) => { asked.push(q); return answer; }, delegate: { env: fx.env, home: fx.home } });
  dc.onEvent = (e) => events.push(e);
});
after(async () => { await dc?.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('listed in hello; getState carries the agents and their settings (page Agents, not the Tools card)', async () => {
  assert.ok(dc.tools.some((t) => t.name === 'bridgerator_delegate'));
  const d = dc.tools.find((t) => t.name === 'bridgerator_delegate');
  assert.deepEqual(d.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  const st = await dc.rpc('getState');
  assert.deepEqual(st.settings.delegate, { codex: true, claude: true, gemini: true, mode: 'full', parallel: 2, timeoutMin: 30, maxOutputKb: 32, keepFinished: true, undoMb: 200 });
  assert.ok(st.extraSettings.filter((s) => s.key.startsWith('delegate.') && s.key !== 'delegate.keepFinished').every((s) => s.page === 'agents'));
  assert.equal(st.extraSettings.find((s) => s.key === 'delegate.keepFinished').page, undefined, 'Keep finished agent tasks is in Settings → Tools (owner 21.10)');
  assert.ok(st.agents && Array.isArray(st.agents.runs));
  if (win) {
    assert.ok(await waitFor(async () => (await dc.rpc('getState')).agents.agents.length === 3), 'detected in the background for the window');
    const a = (await dc.rpc('getState')).agents.agents;
    assert.deepEqual(a.map((x) => [x.id, x.found, x.allowed]), [['codex', true, true], ['claude', true, true], ['gemini', true, true]]);
  }
});

test('bridgerator_settings: get shows delegate values + defaults; narrowing is direct, widening waits for the PC', async () => {
  const g = JSON.parse(text(await dc.call('bridgerator_settings', { action: 'get' })));
  assert.equal(g.current.delegate.parallel, 2); assert.equal(g.defaults.delegate.mode, 'full');
  asked.length = 0;
  let r = await dc.call('bridgerator_settings', { action: 'set', settings: { delegate: { parallel: 1, mode: 'edit', codex: false } } });
  assert.ok(!r.isError, text(r)); assert.equal(asked.length, 0, 'narrowing: no question');
  assert.deepEqual(JSON.parse(fs.readFileSync(CONFIG, 'utf8')).delegate, { parallel: 1, mode: 'edit', codex: false });
  answer = 'deny';
  r = await dc.call('bridgerator_settings', { action: 'set', settings: { delegate: { parallel: 4, mode: 'full', codex: true } } });
  assert.equal(r.notConfirmed, true); assert.equal(asked.length, 1);
  assert.match(asked[0].text, /Delegated tasks at once: 4/); assert.match(asked[0].text, /Allow delegation to Codex: on/);
  assert.equal((await dc.rpc('getState')).settings.delegate.parallel, 1, 'kept after Deny');
  assert.ok(validationError(await dc.call('bridgerator_settings', { action: 'set', settings: { delegate: { parallel: 9 } } })));
  // A Deny holds for 10 minutes: asking again right away gets no new question.
  r = await dc.call('bridgerator_settings', { action: 'set', settings: { delegate: { parallel: 4 } } });
  assert.equal(r.notConfirmed, true); assert.match(text(r), /declined a few minutes ago/); assert.equal(asked.length, 1);
  // The person in the window: direct.
  for (const [key, value] of [['delegate.parallel', 2], ['delegate.mode', 'full'], ['delegate.codex', true]]) await dc.rpc('setSetting', { key, value });
  assert.deepEqual((await dc.rpc('getState')).settings.delegate, { codex: true, claude: true, gemini: true, mode: 'full', parallel: 2, timeoutMin: 30, maxOutputKb: 32, keepFinished: true, undoMb: 200 });
});
const validationError = (r) => r.isError && /delegate\.parallel/.test(text(r));

test('a hand edit of config.json shows in the window live (narrowing applies, widening waits)', async () => {
  const j = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  fs.writeFileSync(CONFIG, JSON.stringify({ ...j, delegate: { ...j.delegate, mode: 'read' } }, null, 2));
  assert.ok(await waitFor(async () => (await dc.rpc('getState')).settings.delegate.mode === 'read'));
  asked.length = 0;
  fs.writeFileSync(CONFIG, JSON.stringify({ ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')), delegate: { ...j.delegate, mode: 'full' } }, null, 2));
  assert.ok(await waitFor(() => asked.length === 1));
  await dc.settled();
  assert.equal((await dc.rpc('getState')).settings.delegate.mode, 'read', 'Keep → stays read');
  await dc.rpc('setSetting', { key: 'delegate.mode', value: 'full' });   // the person in the window: direct
  assert.equal((await dc.rpc('getState')).settings.delegate.mode, 'full');
});

test('a run through the bridge: answer + changed files; bridgerator_undo undoes the whole run; Recent shows it', { skip: !win && 'Windows' }, async () => {
  fs.writeFileSync(path.join(work, 'отчёт.md'), 'старый');
  const r = await dc.call('bridgerator_delegate', { action: 'run', agent: 'claude', folder: work, from: 'ChatGPT', task: JSON.stringify({ answer: 'Переписал отчёт', write: { 'отчёт.md': 'новый', 'итоги.md': 'итог' } }) });
  const v = body(r);
  assert.equal(v.state, 'done', text(r));
  assert.equal(v.changedFiles.modified.length, 1); assert.equal(v.changedFiles.created.length, 1);
  const id = /id (\w+)/.exec(v.undo)[1];
  const u = await dc.call('bridgerator_undo', { id });
  assert.ok(!u.isError, text(u));
  assert.equal(fs.readFileSync(path.join(work, 'отчёт.md'), 'utf8'), 'старый');
  assert.ok(!fs.existsSync(path.join(work, 'итоги.md')));
  assert.ok((await dc.rpc('recent.list')).some((x) => x.tool === 'bridgerator_delegate'));
  const run = (await dc.rpc('getState')).agents.runs[0];
  assert.deepEqual([run.state, run.from, run.undone], ['done', 'ChatGPT', true]);
  const g = await dc.rpc('delegate.get', { id: run.id });
  assert.equal(g.text, 'Переписал отчёт');
});

test('the Bridgerator folder and its parents are refused; a background run ends with the relay event delegate_done', { skip: !win && 'Windows' }, async () => {
  for (const folder of [DIR, fx.appData, fx.home]) {
    const r = await dc.call('bridgerator_delegate', { action: 'run', agent: 'codex', folder, task: '{}' });
    assert.equal(r.isError, true, folder); assert.match(text(r), /ACCESS_DENIED|FOLDER_HAS_EXCLUDED/);
  }
  events.length = 0;
  const v = body(await dc.call('bridgerator_delegate', { action: 'run', agent: 'gemini', folder: work, wait_seconds: 0, task: JSON.stringify({ sleep: 300 }) }));
  assert.equal(v.state, 'running');
  assert.ok((await dc.rpc('getState')).awake.want, 'keeps the PC awake while it runs');
  assert.ok(await waitFor(() => events.some((e) => e.kind === 'delegate_done')));
  assert.deepEqual(events.filter((e) => e.kind === 'delegate_done'), [{ kind: 'delegate_done', ok: 1 }]);
});
