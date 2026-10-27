// Regression tests for bugs fixed earlier (git log 1.0.1–1.0.8, critical-logic/bridge.md §2a,
// install-release.md) that had no test yet, plus Cyrillic (ru-RU) data through the small helpers.
// No windows: PowerShell (notifications / questions) and the browser start are intercepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const shown = [], spawned = [];
let psAnswer = 'deny';
const realExecFile = cp.execFile, realSpawn = cp.spawn;
cp.execFile = (file, args, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (/powershell\.exe$/i.test(String(file))) { shown.push({ env: opts?.env || {}, args }); setImmediate(() => cb?.(null, psAnswer, '')); return { on() {}, kill() {} }; }
  return realExecFile(file, args, opts, cb);
};
cp.spawn = (file, args, opts) => {
  if (/cmd\.exe$|^(open|xdg-open)$/i.test(String(file))) { spawned.push({ file, args }); return { on() {}, unref() {} }; }
  return realSpawn(file, args, opts);
};
syncBuiltinESMExports();

const { showNotice, noticeText } = await import('../src/notice.mjs');
const { askOnPc } = await import('../src/ask.mjs');
const { pair, openBrowser } = await import('../src/pair.mjs');
const { engineEnv, engineCwd } = await import('../src/bridge.mjs');
const { detail, clip } = await import('../src/confirm.mjs');
const { target, createRecent, outcomeOf } = await import('../src/recent.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-regr-'));

// bridge.md §2: notification texts reach PowerShell only as environment variables, never in the script.
test('notification text travels only in BR_TOAST (escaped); the script is the same for any text', async () => {
  const before = shown.length;
  await new Promise((r) => showNotice({ kind: 'queue_done', title: 'Отчёт "Q3" <готов> & $(calc)' }, () => {}, r));
  await new Promise((r) => showNotice({ kind: 'queue_done', title: 'другой' }, () => {}, r));
  const [a, b] = shown.slice(before);
  assert.deepEqual(a.args, b.args, 'same script for both texts');
  assert.ok(a.env.BR_TOAST.includes('Отчёт &quot;Q3&quot; &lt;готов&gt; &amp; $(calc)'));
  assert.doesNotMatch(Buffer.from(a.args.at(-1), 'base64').toString('utf16le'), /Отчёт|calc/);
});

test('notices accept only our own wording: relay junk in protection_off / confirm_off / queue_done gives no notice', () => {
  assert.equal(noticeText({ kind: 'protection_off', what: ['$(calc)', 'confirmations for <x>'] }), undefined);
  assert.match(noticeText({ kind: 'protection_off', what: ['confirmations for deletions', 'evil'] }).body, /^confirmations for deletions —/);
  assert.equal(noticeText({ kind: 'confirm_off', category: '__proto__' }), undefined);
  assert.equal(noticeText({ kind: 'queue_done', title: '   ' }), undefined);
  assert.equal(noticeText({ kind: 'queue_done', title: 'я'.repeat(500) }).body.length, 120);
});

// Security review 20.10: test hooks are never taken from the environment (stripOurs).
test('the question on the PC: BR_* hooks from the environment are dropped; only an offered button counts', async () => {
  process.env.BR_FORCE_FALLBACK = '1'; process.env.BR_SHOT = 'C:\\x.png'; process.env.BRIDGERATOR_HOME = 'C:\\h';
  try {
    psAnswer = 'allow';
    const b = [['allow', 'Allow', ''], ['deny', 'Deny', 'deny']];
    assert.equal(await askOnPc({ head: 'ChatGPT wants to delete files', text: 'Remove-Item "C:\\Работа"', buttons: b, secs: 120, host: 'ПК-ИВАНА' }), 'allow');
    const env = shown.at(-1).env;
    assert.equal(env.BR_FORCE_FALLBACK, undefined); assert.equal(env.BR_SHOT, undefined); assert.equal(env.BRIDGERATOR_HOME, undefined);
    assert.equal(env.BR_DETAIL, 'Remove-Item "C:\\Работа"');
    assert.equal(env.BR_ATTR, 'ПК-ИВАНА · auto-deny in 2 min');
    psAnswer = 'always';
    assert.equal(await askOnPc({ head: 'h', text: 't', buttons: b }), 'deny', 'a key that was not offered = deny');
    psAnswer = '';
    assert.equal(await askOnPc({ head: 'h', text: 't', buttons: b }), 'deny');
  } finally { delete process.env.BR_FORCE_FALLBACK; delete process.env.BR_SHOT; delete process.env.BRIDGERATOR_HOME; psAnswer = 'deny'; }
});

// 1.0.6 key-less pairing: the browser opens only a URL the bridge checked itself.
test('pairing: a relay that fails or answers oddly never opens the browser; a crafted URL is never started', async () => {
  const fail = async () => ({ ok: false, status: 503 });
  let opened = 0;
  await assert.rejects(pair('https://bridgerator.recondeck.com', 'ПК', { fetch: fail, open: () => opened++, log: () => {} }), /could not start pairing \(HTTP 503\) — try again in a minute/);
  const odd = async () => ({ ok: true, status: 200, json: async () => ({ code: 'AAAA-AAAA" & calc & "', poll: 'p' }) });
  await assert.rejects(pair('https://bridgerator.recondeck.com', 'ПК', { fetch: odd, open: () => opened++, log: () => {} }), /unexpected answer/);
  assert.equal(opened, 0);
  const n = spawned.length;
  for (const u of ['https://a.b/pair?code=AAAA-AAAA" & calc', 'file:///C:/x', 'https://a.b/pair?code=aaaa-aaaa', 'https://a b/pair?code=AAAA-AAAA']) openBrowser(u);
  assert.equal(spawned.length, n, 'nothing started');
  openBrowser('https://bridgerator.recondeck.com/pair?code=AB12-CD34');
  assert.equal(spawned.length, n + 1);
  assert.match(spawned.at(-1).args.at(-1), /^start "" "https:\/\/bridgerator\.recondeck\.com\/pair\?code=AB12-CD34"$/);
});

// Security review 20.10: the engine child gets no Bridgerator variables and starts in an allowed folder.
test('engine environment and working folder: no BRIDGERATOR_* / BR_* (any case), no TLS switch-off; cwd = first existing allowed folder', () => {
  const e = engineEnv({ PATH: 'p', BRIDGERATOR_HOME: 'h', br_ui_dir: 'x', Bridgerator_Dc_Config_Dir: 'd', NODE_TLS_REJECT_UNAUTHORIZED: '0', BROWSER: 'b' });
  assert.deepEqual(e, { PATH: 'p', BROWSER: 'b', PSExecutionPolicyPreference: 'Bypass' });
  assert.equal(engineEnv({ psexecutionpolicypreference: 'AllSigned' }).PSExecutionPolicyPreference, undefined, 'the person\'s own value stays');
  const a = path.join(tmp, 'Работа');
  fs.mkdirSync(a);
  assert.equal(engineCwd({ allowedDirectories: [path.join(tmp, 'нет'), a] }, 'C:\\H'), a);
  assert.equal(engineCwd({ allowedDirectories: [] }, 'C:\\Users\\Иван'), 'C:\\Users\\Иван', 'no list → home, never the Bridgerator folder');
});

test('Cyrillic in the PC question and the local history: clipped by characters, the matched fragment kept', () => {
  const long = `echo ${'а'.repeat(200)} & Remove-Item "C:\\Users\\Иван Петров\\Документы\\важное" -Recurse & echo ${'б'.repeat(200)}`;
  const d = detail('start_process', { command: long }, 'Remove-Item');
  assert.ok(d.includes('Remove-Item') && d.length < 200, d);
  assert.equal(clip('Привет,\n\n   мир'), 'Привет, мир');
  assert.equal(target({ source: 'C:\\Фото', destination: 'D:\\Архив' }), 'C:\\Фото → D:\\Архив');
  assert.equal(target({ command: 'ё'.repeat(400) }).length, 300);
  const f = path.join(tmp, 'recent.jsonl');
  const r = createRecent(f, { keepFile: true });
  r.record('read_file', { path: 'C:\\Users\\Иван Петров\\заметки.txt' }, outcomeOf({ refused: true, isError: true }));
  assert.deepEqual(createRecent(f, { keepFile: true }).list()[0], { ...r.list()[0] });
  assert.equal(r.list()[0].outcome, 'refused');
  assert.equal(outcomeOf({ paused: true, isError: true }), 'paused');
  assert.equal(outcomeOf({ notConfirmed: true, isError: true }), 'not confirmed');
});

test('uninstall in a Cyrillic profile: only our files and our temp files go; the folder only when empty', async () => {
  process.env.BRIDGERATOR_HOME = path.join(tmp, 'home');
  const cwd = process.cwd();
  const { removeOurFiles, isOurDir } = await import('../src/cli.mjs');
  process.chdir(cwd); delete process.env.BRIDGERATOR_HOME;
  const roots = [path.join(tmp, 'Иван Петров', 'AppData', 'Roaming')];
  const d = path.join(roots[0], 'Bridgerator');
  fs.mkdirSync(path.join(d, 'dc'), { recursive: true });
  for (const f of ['config.json', 'confirm.ini', 'queue.json', 'recent.jsonl', 'usage.json', 'run-hidden.vbs', 'queue.json.1234.tmp', 'confirm.ini.99.tmp']) fs.writeFileSync(path.join(d, f), 'x');
  fs.writeFileSync(path.join(d, 'мои заметки.txt'), 'keep');
  fs.writeFileSync(path.join(d, 'notes.tmp'), 'keep: not our temp name');
  assert.equal(isOurDir(d.toUpperCase(), roots), true, 'case-insensitive');
  removeOurFiles(d);
  assert.deepEqual(fs.readdirSync(d).sort(), ['notes.tmp', 'мои заметки.txt']);
});
