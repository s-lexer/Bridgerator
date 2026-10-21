// bridgerator_delegate (src/delegate.mjs): finding the agent CLIs, their headless command lines, the
// answer formats, and real runs of FAKE agents (test/fixtures/delegate/fake-agent.cjs behind npm-style
// shims) in a Cyrillic folder: changed files, Undo of the whole run, time limit (the process tree is
// killed), parallel limit, folder rules, no way back into Bridgerator, a clean environment.
// No real Codex / Claude / Gemini is ever started. LOGIC: critical-logic/bridge.md ("AI ↔ AI delegation").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDelegate, attachDelegate, handle, findAgent, signedIn, searchDirs, readShim, buildArgs, parseOutput, promptFor, claudePath, codexMcpNames, childEnv, limitsOf, scanTree, diffTrees, NO_MCP } from '../src/delegate.mjs';
import { createSnapshots } from '../src/undo.mjs';
import { createPolicy } from '../src/policy.mjs';
import { eventMessage } from '../src/events.mjs';
import { fakeAgents, npmShim } from './helpers/fake-agents.mjs';

const win = process.platform === 'win32';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-deleg-'));
const fx = fakeAgents(root);
const work = path.join(root, 'Проекты', 'Сайт «Ромашка»');
const ro = path.join(root, 'Архив'), secret = path.join(root, 'Проекты', 'Секрет'), parent = path.join(root, 'Проекты');
const cfgDir = path.join(root, 'cfg');
for (const d of [work, ro, secret, cfgDir]) fs.mkdirSync(d, { recursive: true });
const TOKEN = 'brk_live_0123456789abcdef';
const body = (r) => JSON.parse(r.content[0].text);
const textOf = (r) => (r.content || []).map((c) => c.text).join('\n');
const code = async (p) => { try { const r = await p; return r?.isError ? `isError:${textOf(r)}` : 'OK'; } catch (e) { return e.code; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitFor = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

let snapshots, events, store, cfg, ctx;
function makeCtx(over = {}) {
  const c = { token: TOKEN, allowedDirectories: [], deniedDirectories: [secret, cfgDir], readOnlyDirectories: [ro], protectSensitive: false, configDir: cfgDir, cwd: root, ...over };
  return { cfg: c, policy: createPolicy(c), gate: { gate: async () => null }, log: () => {} };
}
before(() => {
  snapshots = createSnapshots(path.join(root, 'snaps'));
  events = [];
  ctx = makeCtx();
  cfg = ctx.cfg;
  store = attachDelegate(cfg, createDelegate({ file: path.join(cfgDir, 'delegate.json'), snapshots, env: fx.env, home: fx.home, emit: (e) => events.push(e), minuteMs: 300 }));
});
after(() => { store?.stop(); fs.rmSync(root, { recursive: true, force: true }); });
const call = (args, c = ctx) => handle('bridgerator_delegate', args, c);
const task = (o) => JSON.stringify(o);

test('found where they are installed: npm shims in %APPDATA%\\npm, a folder on the PATH; relative PATH entries and the current folder are ignored', { skip: !win && 'Windows paths' }, () => {
  const dirs = searchDirs('codex', { env: fx.env, home: fx.home, cwd: process.cwd() });
  assert.equal(dirs[0], fx.npmDir, 'known install place first');
  assert.ok(dirs.includes(fx.geminiDir));
  assert.ok(!dirs.some((d) => d === 'relative\\bin' || d === '.'), 'relative PATH entries are never searched');
  const c = findAgent('codex', { env: fx.env, home: fx.home });
  assert.equal(c.path, path.join(fx.npmDir, 'codex.cmd'));
  assert.equal(c.cmd, process.execPath, 'a node script runs with our node, never through cmd.exe');
  assert.match(c.pre[0], /@openai\\codex\\bin\\codex\.js$/);
  assert.equal(findAgent('gemini', { env: fx.env, home: fx.home }).path, path.join(fx.geminiDir, 'gemini.cmd'));
  // A .cmd that is not an npm shim: found, but not startable (no shell).
  const odd = path.join(root, 'odd'); fs.mkdirSync(odd, { recursive: true }); fs.writeFileSync(path.join(odd, 'claude.cmd'), '@echo hello %*');
  const f = findAgent('claude', { env: { ...fx.env, APPDATA: path.join(root, 'none'), PATH: odd }, home: path.join(root, 'nohome') });
  assert.equal(f.cmd, null); assert.equal(f.problem, 'SHIM');
  // A shim that points outside its folder is refused.
  fs.writeFileSync(path.join(odd, 'x.cmd'), npmShim('..\\Проекты\\evil.js')); fs.writeFileSync(path.join(root, 'Проекты', 'evil.js'), '');
  assert.equal(readShim(path.join(odd, 'x.cmd')), null);
  // The Windows app (SEA, B2-22): never bridgerator.exe for a .js shim — the person's node.exe by absolute path, none → not startable.
  const shim = path.join(fx.npmDir, 'codex.cmd');
  assert.equal(readShim(shim, { sea: true, env: { PATH: '' } }), null);
  const nodeDir = path.join(root, 'nodejs-x'); fs.mkdirSync(nodeDir, { recursive: true }); fs.writeFileSync(path.join(nodeDir, 'node.exe'), '');
  const viaPath = readShim(shim, { sea: true, env: { PATH: `relative\\bin;${nodeDir}` } });
  assert.equal(viaPath.cmd, path.join(nodeDir, 'node.exe')); assert.match(viaPath.pre[0], /codex\.js$/);
  assert.equal(readShim(shim, { sea: true, env: { PATH: 'relative\\nodejs-x' } }), null, 'relative PATH entries are ignored');
  assert.equal(readShim(shim, { sea: false }).cmd, process.execPath);
});

test('sign-in = only whether the CLI\'s sign-in file / key exists; versions come from --version', async () => {
  assert.equal(signedIn('codex', { env: fx.env, home: fx.home }), 'yes');
  assert.equal(signedIn('claude', { env: fx.env, home: fx.home }), 'no');
  assert.equal(signedIn('claude', { env: { ...fx.env, ANTHROPIC_API_KEY: 'x' }, home: fx.home }), 'yes');
  assert.equal(signedIn('gemini', { env: fx.env, home: fx.home }), 'yes');
  const h2 = path.join(root, 'keyring'); fs.mkdirSync(path.join(h2, '.codex'), { recursive: true }); fs.writeFileSync(path.join(h2, '.codex', 'config.toml'), 'cli_auth_credentials_store = "keyring"\n');
  assert.equal(signedIn('codex', { env: {}, home: h2 }), 'unknown', 'kept in the Windows keyring: not checked, never "no"');
  if (!win) return;
  const list = body(await call({ action: 'agents' })).agents;
  assert.deepEqual(list.map((a) => [a.id, a.found, a.signedIn, a.version, a.allowed, a.usable]), [['codex', true, 'yes', '1.2.3', true, true], ['claude', true, 'no', '1.2.3', true, true], ['gemini', true, 'yes', '1.2.3', true, true]]);
});

test('command lines: headless JSON output, permissions by mode, no MCP servers (no way back into Bridgerator), prompt after --', () => {
  const p = promptFor({ task: 'Проверь сайт', folder: work, from: 'ChatGPT' });
  assert.match(p, /handed to you by ChatGPT/); assert.match(p, /Do not hand the task to another AI agent/); assert.match(p, /\nTask:\nПроверь сайт$/);
  assert.doesNotMatch(p, /desktop ?commander/i);
  const cx = buildArgs('codex', { prompt: p, folder: work, mode: 'full', mcpNames: codexMcpNames({ env: fx.env, home: fx.home }) });
  assert.deepEqual(cx.slice(0, 8), ['exec', '--json', '--skip-git-repo-check', '--cd', work, '--sandbox', 'workspace-write', '-c']);
  assert.ok(cx.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(cx.includes('mcp_servers.bridgerator.enabled=false') && cx.includes('mcp_servers.files-2.enabled=false'));
  assert.ok(!cx.some((a) => /two words|bridgerator\.env/.test(a)), 'odd names / sub-tables are not turned into keys');
  assert.deepEqual(cx.slice(-2), ['--', p]);
  assert.ok(buildArgs('codex', { prompt: p, folder: work, mode: 'read' }).includes('read-only'));
  assert.ok(!buildArgs('codex', { prompt: p, folder: work, mode: 'edit' }).includes('sandbox_workspace_write.network_access=true'), 'network only in full');
  const deny = [cfgDir, path.join(root, 'nofile.txt')];
  const cl = buildArgs('claude', { prompt: p, folder: work, mode: 'full', denyDirs: deny });
  assert.deepEqual(cl.slice(0, 7), ['-p', '--output-format', 'json', '--permission-mode', 'bypassPermissions', '--disallowedTools', 'mcp__*']);
  assert.ok(cl.includes(`Edit(${claudePath(cfgDir)}/**)`) && cl.includes(`Read(${claudePath(cfgDir)}/**)`));
  assert.deepEqual(cl.slice(-2), ['--', p], '-- ends the variadic --disallowedTools');
  assert.equal(buildArgs('claude', { prompt: p, folder: work, mode: 'read' })[4], 'dontAsk');
  assert.equal(buildArgs('claude', { prompt: p, folder: work, mode: 'edit' })[4], 'acceptEdits');
  const gm = buildArgs('gemini', { prompt: p, folder: work, mode: 'full' });
  assert.deepEqual(gm, ['--output-format', 'json', '--approval-mode', 'yolo', '--allowed-mcp-server-names', NO_MCP, `--prompt=${p}`]);
  assert.ok(!buildArgs('gemini', { prompt: p, folder: work, mode: 'read' }).includes('--approval-mode'));
  assert.equal(claudePath('C:\\Users\\Мария\\AppData\\Roaming\\Bridgerator'), '//c/Users/Мария/AppData/Roaming/Bridgerator');
});

test('answers of each CLI: final message, the CLI\'s own error, raw text when it is not JSON', () => {
  const codex = ['{"type":"thread.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"первый"}}', 'not json', '{"type":"item.completed","item":{"type":"agent_message","text":"Готово: 2 файла"}}', '{"type":"turn.completed"}'].join('\n');
  assert.deepEqual(parseOutput('codex', codex), { text: 'Готово: 2 файла', error: null });
  assert.equal(parseOutput('codex', '{"type":"turn.failed","error":{"message":"usage limit"}}').error, 'usage limit');
  assert.deepEqual(parseOutput('claude', 'warning\n{"type":"result","subtype":"success","is_error":false,"result":"Сделано"}'), { text: 'Сделано', error: null });
  assert.ok(parseOutput('claude', '{"type":"result","subtype":"error_max_turns","is_error":true}').error);
  assert.deepEqual(parseOutput('gemini', '{"response":"Ответ","stats":{}}'), { text: 'Ответ', error: null });
  assert.equal(parseOutput('gemini', '{"response":"","error":{"message":"quota"}}').error, 'quota');
  assert.deepEqual(parseOutput('gemini', 'plain words'), { text: 'plain words', error: null });
});

test('the folder before / after: modified, created, deleted; .git and node_modules are not walked; junction-safe', () => {
  const d = path.join(root, 'scan'); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); fs.mkdirSync(path.join(d, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(d, 'a.txt'), '1'); fs.writeFileSync(path.join(d, 'b.txt'), '2'); fs.writeFileSync(path.join(d, '.git', 'HEAD'), 'x'); fs.writeFileSync(path.join(d, 'node_modules', 'x', 'i.js'), 'x');
  const a = scanTree(d);
  assert.deepEqual([...a.files.keys()].map((p) => path.basename(p)).sort(), ['a.txt', 'b.txt']);
  fs.writeFileSync(path.join(d, 'a.txt'), '111'); fs.rmSync(path.join(d, 'b.txt')); fs.writeFileSync(path.join(d, 'new.txt'), 'n');
  const ch = diffTrees(a.files, scanTree(d).files);
  assert.deepEqual([ch.modified, ch.created, ch.deleted].map((l) => l.map((p) => path.basename(p))), [['a.txt'], ['new.txt'], ['b.txt']]);
  assert.equal(scanTree(d, { maxFiles: 1 }).over, true);
  assert.equal(scanTree(path.join(root, 'nope')), null);
});

test('a run in a Cyrillic folder: the answer, the changed files, and ONE Undo for the whole run', { skip: !win && 'Windows' }, async () => {
  fs.writeFileSync(path.join(work, 'index.html'), '<h1>Старый</h1>');
  fs.writeFileSync(path.join(work, 'удалить.txt'), 'лишнее');
  fs.mkdirSync(path.join(work, 'css'), { recursive: true });
  const r = await call({ action: 'run', agent: 'codex', folder: work, from: 'ChatGPT', task: task({ answer: 'Обновил заголовок, добавил стиль, убрал лишнее.', write: { 'index.html': '<h1>Новый</h1>', 'css\\стиль.css': 'h1{}' }, delete: ['удалить.txt'] }) });
  const v = body(r);
  assert.equal(v.state, 'done', JSON.stringify(v));
  assert.equal(v.answer, 'Обновил заголовок, добавил стиль, убрал лишнее.');
  assert.deepEqual(v.changedFiles, { modified: [path.join(work, 'index.html')], created: [path.join(work, 'css', 'стиль.css')], deleted: [path.join(work, 'удалить.txt')] });
  assert.match(v.undo, /^bridgerator_undo id \w+ undoes every file change of this run$/);
  const id = /id (\w+)/.exec(v.undo)[1];
  // Only the changed files are kept in the snapshot (the rest of the folder copy is dropped).
  assert.equal(snapshots.find(id).entries.length, 3);
  const u = snapshots.undo(id);
  assert.equal(u.skipped.length, 0, JSON.stringify(u.skipped));
  assert.equal(fs.readFileSync(path.join(work, 'index.html'), 'utf8'), '<h1>Старый</h1>');
  assert.equal(fs.readFileSync(path.join(work, 'удалить.txt'), 'utf8'), 'лишнее');
  assert.ok(!fs.existsSync(path.join(work, 'css', 'стиль.css')));
  // The run log knows it was undone.
  assert.equal(store.list()[0].undone, true);
  // Nothing changed → no undo action at all.
  const r2 = body(await call({ action: 'run', agent: 'gemini', folder: work, task: task({ answer: 'Только посмотрел' }) }));
  assert.equal(r2.state, 'done'); assert.equal(r2.undo, 'no file changes to undo');
  assert.deepEqual(r2.changedFiles, { modified: [], created: [], deleted: [] });
});

test('the agent\'s environment has no Bridgerator variables or key; its cwd is the folder; MCP is off', { skip: !win && 'Windows' }, async () => {
  const dump = path.join(root, 'dump-env.json');
  const env0 = { ...fx.env, BR_TEST_HOOK: '1', BRIDGERATOR_HOME: 'C:\\x', NODE_TLS_REJECT_UNAUTHORIZED: '0', DC_TELEMETRY_ENABLED: 'false', MY_SETTING: `key=${TOKEN}`, KEEP_ME: 'да' };
  const s2 = attachDelegate(ctx.cfg, createDelegate({ snapshots: null, env: env0, home: fx.home }));
  try {
    const v = body(await call({ action: 'run', agent: 'claude', folder: work, task: task({ dump }) }));
    assert.equal(v.state, 'done', JSON.stringify(v));
    assert.match(v.undo, /Undo is off/);
    const d = JSON.parse(fs.readFileSync(dump, 'utf8'));
    for (const k of ['BR_TEST_HOOK', 'BRIDGERATOR_HOME', 'NODE_TLS_REJECT_UNAUTHORIZED', 'DC_TELEMETRY_ENABLED', 'MY_SETTING']) assert.equal(d.env[k], undefined, k);
    assert.equal(d.env.KEEP_ME, 'да');
    assert.equal(path.resolve(d.cwd).toLowerCase(), work.toLowerCase());
    assert.ok(d.argv.includes('mcp__*'));
    assert.ok(!JSON.stringify(d.argv).includes(TOKEN), 'the key never reaches the command line');
    // Inversion: the same variable without our key is passed through.
    assert.equal(childEnv({ MY_SETTING: 'plain' }, TOKEN).MY_SETTING, 'plain');
  } finally { attachDelegate(ctx.cfg, store); }
});

test('time limit: the agent and its child processes are stopped; the run is "timeout"', { skip: !win && 'Windows' }, async () => {
  const kid = path.join(root, 'kid.pid');
  const t0 = Date.now();
  // timeoutMin 1 × minuteMs 300 ms in this test store.
  const c = makeCtx({ delegate: { timeoutMin: 1 } }); attachDelegate(c.cfg, store);
  const v = body(await call({ action: 'run', agent: 'codex', folder: work, task: task({ sleep: 60000, child: kid }) }, c));
  assert.equal(v.state, 'timeout');
  assert.match(v.error, /time limit/);
  assert.ok(Date.now() - t0 < 5000, `stopped after ${Date.now() - t0} ms`);
  const pid = Number(fs.readFileSync(kid, 'utf8'));
  assert.ok(await waitFor(() => !alive(pid), 10000), 'the grandchild is gone too (taskkill /T)');
}, { timeout: 30000 });

test('parallel limit (2 by default): a third run is refused while two run; cancel stops one; background end → event delegate_done', { skip: !win && 'Windows' }, async () => {
  const c = makeCtx({ delegate: { timeoutMin: 240 } });
  const s = attachDelegate(c.cfg, createDelegate({ snapshots: null, env: fx.env, home: fx.home, emit: (e) => events.push(e) }));
  events.length = 0;
  const pa = path.join(root, 'пар-a'), pb = path.join(root, 'пар-b'), pbIn = path.join(pb, 'внутри');
  fs.mkdirSync(pa, { recursive: true }); fs.mkdirSync(pbIn, { recursive: true });
  try {
    const a = body(await call({ action: 'run', agent: 'gemini', folder: pa, wait_seconds: 0, task: task({ sleep: 60000 }) }, c));
    const b = body(await call({ action: 'run', agent: 'claude', folder: pb, wait_seconds: 0, task: task({ sleep: 60000 }) }, c));
    assert.equal(a.state, 'running'); assert.equal(b.state, 'running');
    assert.equal(await code(call({ action: 'run', agent: 'codex', folder: work, task: task({}) }, c)), 'BUSY');
    assert.equal(body(await call({ action: 'status' }, c)).running.length, 2);
    const x = body(await call({ action: 'cancel', id: a.id }, c)).cancelled;
    assert.equal(x.state, 'cancelled');
    // A slot is free again — but not in the folder of a running one (same, inside or around it: B2-17).
    assert.equal(await code(call({ action: 'run', agent: 'codex', folder: pbIn, task: task({}) }, c)), 'FOLDER_BUSY');
    assert.equal(await code(call({ action: 'run', agent: 'codex', folder: root, task: task({}) }, c)), 'FOLDER_HAS_EXCLUDED', 'root holds Bridgerator folders');
    const d = body(await call({ action: 'run', agent: 'codex', folder: pa, wait_seconds: 0, task: task({ answer: 'фон' }) }, c));
    assert.ok(await waitFor(() => s.status(d.id).state === 'done'));
    assert.equal(body(await call({ action: 'result', id: d.id }, c)).answer, 'фон');
    await call({ action: 'cancel', id: b.id }, c);
    assert.deepEqual(events.map((e) => [e.kind, e.ok]), [['delegate_done', 0], ['delegate_done', 1], ['delegate_done', 0]]);
    assert.deepEqual(eventMessage(events[1]), { type: 'event', kind: 'delegate_done', ok: 1 }, 'numbers only to the relay');
    // Inversion: parallel 3 → the third run would start.
    assert.equal(limitsOf({ delegate: { parallel: 3 } }).parallel, 3);
  } finally { s.stop(); attachDelegate(c.cfg, store); }
}, { timeout: 60000 });

test('folder rules: excluded, holding an excluded / Bridgerator folder, outside the list → refused; read-only → mode read', { skip: !win && 'Windows' }, async () => {
  const run = (folder, c = ctx, extra = {}) => code(call({ action: 'run', agent: 'codex', folder, task: task({}), ...extra }, c));
  assert.equal(await run(secret), 'ACCESS_DENIED');
  assert.equal(await run(parent), 'FOLDER_HAS_EXCLUDED', 'the parent of an excluded folder');
  assert.equal(await run(root), 'FOLDER_HAS_EXCLUDED', 'the parent of the Bridgerator settings folder');
  assert.equal(await run('relative\\folder'), 'BAD_PATH');
  assert.equal(await run(path.join(root, 'нет такой')), 'NO_FOLDER');
  const listed = makeCtx({ allowedDirectories: [ro] }); attachDelegate(listed.cfg, store);
  assert.equal(await run(work, listed), 'ACCESS_DENIED', 'outside the allowed list');
  // Inversion: without the excluded child the parent is fine.
  const open = makeCtx({ deniedDirectories: [cfgDir] }); attachDelegate(open.cfg, store);
  assert.equal(await run(parent, open), 'OK');
  // Read-only folder: runs, but read-only.
  const dump = path.join(root, 'dump-ro.json');
  const v = body(await call({ action: 'run', agent: 'codex', folder: ro, task: task({ dump }) }));
  assert.equal(v.mode, 'read'); assert.ok(v.notes.some((n) => /read-only/.test(n)));
  assert.ok(JSON.parse(fs.readFileSync(dump, 'utf8')).argv.includes('read-only'));
  // A wider mode than the PC's limit is lowered.
  const lim = makeCtx({ delegate: { mode: 'edit' } }); attachDelegate(lim.cfg, store);
  const w = body(await call({ action: 'run', agent: 'claude', folder: work, mode: 'full', task: task({ dump }) }, lim));
  assert.equal(w.mode, 'edit');
  assert.equal(JSON.parse(fs.readFileSync(dump, 'utf8')).argv[4], 'acceptEdits');
});

test('refusals: agent turned off, terminal off, the PC key or an excluded folder in the task, unknown agent, not installed', { skip: !win && 'Windows' }, async () => {
  const off = makeCtx({ delegate: { codex: false } }); attachDelegate(off.cfg, store);
  assert.equal(await code(call({ action: 'run', agent: 'codex', folder: work, task: 'x' }, off)), 'AGENT_OFF');
  assert.equal(await code(call({ action: 'run', agent: 'claude', folder: work, task: task({}) }, off)), 'OK', 'inversion: another agent still runs');
  const term = makeCtx({ disabledTools: ['start_process', 'interact_with_process', 'kill_process'] }); attachDelegate(term.cfg, store);
  assert.equal(await code(call({ action: 'run', agent: 'codex', folder: work, task: 'x' }, term)), 'TERMINAL_OFF');
  assert.equal(await code(call({ action: 'run', agent: 'codex', folder: work, task: `use key ${TOKEN}` })), 'SECRET_IN_TASK');
  assert.equal(await code(call({ action: 'run', agent: 'codex', folder: work, task: `read ${secret}\\пароли.txt` })), 'ACCESS_DENIED');
  assert.equal(await code(call({ action: 'run', agent: 'cursor', folder: work, task: 'x' })), 'BAD_ARGS');
  const none = makeCtx(); attachDelegate(none.cfg, createDelegate({ env: { PATH: '' }, home: path.join(root, 'empty') }));
  assert.equal(await code(call({ action: 'run', agent: 'codex', folder: work, task: 'x' }, none)), 'NOT_FOUND');
  // The person's OK on the PC (confirm category any_command / patterns) stops it before anything runs.
  const asked = makeCtx(); asked.gate = { gate: async () => ({ content: [{ type: 'text', text: 'Not run — denied' }], isError: true, notConfirmed: true }) }; attachDelegate(asked.cfg, store);
  const r = await call({ action: 'run', agent: 'codex', folder: work, task: 'x' }, asked);
  assert.equal(r.notConfirmed, true);
});

test('a failed agent: its own error, exit code; long answers are cut; the PC key is masked in the answer', { skip: !win && 'Windows' }, async () => {
  const f = body(await call({ action: 'run', agent: 'codex', folder: work, task: task({ fail: true, exit: 1 }) }));
  assert.equal(f.state, 'failed'); assert.equal(f.error, 'usage limit reached'); assert.equal(f.exitCode, 1);
  const g = body(await call({ action: 'run', agent: 'gemini', folder: work, task: task({ exit: 3, stderr: 'Ошибка входа' }) }));
  assert.equal(g.state, 'failed'); assert.match(g.error, /Ошибка входа/);
  const small = makeCtx({ delegate: { maxOutputKb: 4 } }); attachDelegate(small.cfg, store);
  const big = path.join(root, 'long-answer.txt'); fs.writeFileSync(big, `начало ${'я'.repeat(20000)} ${TOKEN} конец`);
  const long = body(await call({ action: 'run', agent: 'claude', folder: work, task: task({ answerFrom: big }) }, small));
  assert.ok(long.answer.length < 4300, String(long.answer.length));
  assert.match(long.answer, /characters left out/); assert.match(long.answer, /конец$/);
  assert.ok(!long.answer.includes(TOKEN)); assert.match(long.answer, /\[hidden\] конец$/);
});

test('the run log survives a restart; a run that was going is "interrupted"', () => {
  const file = path.join(root, 'log.json');
  fs.writeFileSync(file, JSON.stringify({ runs: [{ id: 'd1', agent: 'codex', from: 'ChatGPT', folder: work, mode: 'full', task: 't', startedAt: new Date().toISOString(), state: 'running' }, { id: 'd0', agent: 'claude', state: 'done', ok: true, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }, { id: 'bad' }] }));
  const s = createDelegate({ file, env: { PATH: '' }, home: root });
  assert.deepEqual(s.list().map((r) => [r.id, r.state]), [['d1', 'interrupted'], ['d0', 'done']]);
  assert.equal(s.status('d1').ok, false);
  assert.throws(() => s.result('zzz'), (e) => e.code === 'NO_RUN');
});
