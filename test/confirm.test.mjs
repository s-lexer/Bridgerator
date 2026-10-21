import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGate, categorize, readSettings, setIni, ensureIni, detail, ALLOW_FOR_MS } from '../src/confirm.mjs';
import { noticeText } from '../src/notice.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-confirm-'));
const iniAt = (name, enabled) => { const f = path.join(dir, name); ensureIni(f); if (enabled) setIni(f, 'confirm', 'enabled', 'true'); return f; };
const fakeAsk = (answers) => { const seen = []; return { seen, ask: async (d) => { seen.push(d); return answers.shift() ?? 'deny'; } }; };
const ON = { delete: true, dangerous_commands: true, write_files: false, move: false, any_command: false, install: false, scheduled_scripts: false };
const cmd = (c) => categorize('start_process', { command: c }, ON);

test('matcher: deletions and system commands ask; ordinary commands and file tools do not (defaults)', () => {
  for (const c of ['del C:\\x.txt', 'rd /s /q build', 'Remove-Item -Recurse .\\old', 'rm -rf node_modules', 'npx rimraf dist', 'cmd /c "erase a.txt"', '[IO.File]::Delete("a")']) assert.equal(cmd(c), 'delete', c);
  for (const c of ['format D: /q', 'diskpart', 'bcdedit /set x', 'reg delete HKLM\\Software\\X /f', 'reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run /v x', 'shutdown /r /t 0', 'Stop-Computer', 'cipher /w:C:', 'takeown /f C:\\x', 'icacls C:\\x /grant Everyone:F', 'net user bob /add', 'sc delete svc', 'schtasks /delete /tn x', 'Set-ExecutionPolicy Unrestricted', 'vssadmin delete shadows /all', 'wmic shadowcopy delete', 'taskkill /f /im lsass.exe']) assert.equal(cmd(c), 'dangerous_commands', c);
  for (const c of ['dir', 'Get-ChildItem', 'git status', 'npm test', 'echo delete me', 'Get-Content readme.md', 'python model.py']) assert.equal(cmd(c), null, c);
  assert.equal(categorize('write_file', { path: 'a' }, ON), null);
  assert.equal(categorize('write_file', { path: 'a' }, { ...ON, write_files: true }), 'write_files');
  assert.equal(categorize('move_file', { source: 'a', destination: 'b' }, { ...ON, move: true }), 'move');
  assert.equal(categorize('start_process', { command: 'dir' }, { ...ON, any_command: true }), 'any_command');
  assert.equal(categorize('start_process', { command: 'git push' }, ON, [/\bgit\s+push\b/i]), 'pattern');
  assert.equal(cmd('del x'.padEnd(10)), 'delete');
});

test('confirm.ini: off by default; defaults per category; edits kept with comments', () => {
  const f = iniAt('a.ini');
  const s = readSettings(f);
  assert.equal(s.enabled, false);
  assert.deepEqual(s.ask, ON);
  assert.equal(s.timeoutSec, 120);
  setIni(f, 'confirm', 'enabled', 'true');
  setIni(f, 'ask', 'delete', 'false');
  setIni(f, 'patterns', 'pattern1', '\\bgit\\s+push\\b');
  const t = fs.readFileSync(f, 'utf8');
  assert.match(t, /; deleting files or folders/);
  const s2 = readSettings(f);
  assert.equal(s2.enabled, true);
  assert.equal(s2.ask.delete, false);
  assert.ok(s2.patterns[0].test('git push origin'));
  assert.equal(readSettings(path.join(dir, 'missing.ini')).enabled, false);
});

test('gate: nothing asked while off; Deny / no answer → notConfirmed; 10 minutes; Allow always turns that check off', async () => {
  let t = 0;
  const offIni = iniAt('off.ini');
  const g0 = createGate({ ini: offIni, ask: async () => assert.fail('must not ask while off') });
  assert.equal(await g0.gate('start_process', { command: 'rd /s /q C:\\x' }), null);

  const f = iniAt('on.ini', true);
  const always = [];
  const { ask, seen } = fakeAsk(['deny', 'allow10', 'always']);
  const g = createGate({ ini: f, ask, now: () => t, onAlways: (c) => always.push(c) });
  assert.equal(await g.gate('read_file', { path: 'C:\\a' }), null);
  assert.equal(await g.gate('start_process', { command: 'dir' }), null);
  assert.equal(seen.length, 0, 'ordinary calls never ask');
  const d = await g.gate('start_process', { command: 'Remove-Item C:\\old -Recurse' });
  assert.equal(d.notConfirmed, true);
  assert.equal(seen[0].head, 'ChatGPT wants to delete files');
  assert.deepEqual(seen[0].buttons.map((b) => b[1]), ['Allow', 'Allow 10 min', 'Allow always', 'Deny']);
  assert.equal(await g.gate('start_process', { command: 'del a' }), null); // allow10 (deletions only)
  assert.equal(await g.gate('start_process', { command: 'rd /s /q x' }), null);
  assert.equal(seen.length, 2, 'no window for deletions within 10 minutes');
  t += ALLOW_FOR_MS + 1;
  assert.equal(await g.gate('start_process', { command: 'del a' }), null); // always
  assert.deepEqual(always, ['delete']);
  assert.equal(readSettings(f).ask.delete, false, 'Allow always wrote delete = false');
  assert.equal(await g.gate('start_process', { command: 'del b' }), null);
  assert.equal(seen.length, 3, 'deletions no longer ask');
  assert.equal((await g.gate('start_process', { command: 'diskpart' })).notConfirmed, true, 'system commands still ask (no answer = deny)');
  assert.equal(seen.length, 4, '"Allow 10 min" for deletions did not cover system commands');
  assert.match(noticeText({ kind: 'confirm_off', category: 'delete' }).body, /confirm on delete/);
  assert.equal(noticeText({ kind: 'confirm_off', category: '$(calc)' }), undefined);
});

test('request_confirm_off needs the person\'s approval; confirm_on does not', async () => {
  const f = iniAt('req.ini', true);
  const changes = [];
  const { ask, seen } = fakeAsk(['deny', 'allow']);
  let t = 0;
  const g = createGate({ ini: f, ask, now: () => t, onChange: (m) => changes.push(m) });
  assert.match((await g.tool('request_confirm_off')).content[0].text, /^declined/);
  assert.equal(g.mode(), 'on');
  assert.match((await g.tool('request_confirm_off')).content[0].text, /said no a few minutes ago/, '10-minute cool-down after a Deny, no new window');
  assert.equal(seen.length, 1);
  t += 11 * 60 * 1000;
  assert.match((await g.tool('request_confirm_off')).content[0].text, /^approved/);
  assert.equal(g.mode(), 'off');
  assert.match(seen[0].head, /stop confirming actions on this PC\. Allow\?/);
  assert.deepEqual(seen[0].buttons.map((b) => b[1]), ['Allow', 'Deny']);
  await g.tool('confirm_on');
  assert.equal(g.mode(), 'on');
  assert.equal(seen.length, 2, 'confirm_on shows no window');
  assert.deepEqual(changes, ['off', 'on']);
});

test('notification text: one line, head … (+N chars) … tail, the matched fragment always shown', () => {
  const long = `echo ${'a'.repeat(300)} & rd /s /q C:\\important & echo ${'b'.repeat(300)}`;
  const d = detail('start_process', { command: long }, 'rd /s /q C:\\important');
  assert.match(d, /^echo a+ … .*rd \/s \/q C:\\important.* … \(\+\d+ chars\) … b+$/);
  assert.ok(d.length < 200);
  assert.equal(detail('start_process', { command: 'Remove-Item\n\n  -Recurse   x' }), 'Remove-Item -Recurse x', 'whitespace collapsed');
  assert.equal(detail("move_file", { source: "a", destination: "b" }), "a → b");
});

test('confirm.ini cannot lower protection by itself: weakening needs Apply on the PC, Keep restores, raising is direct', async () => {
  const { readSettings: rs } = await import('../src/confirm.mjs');
  const f = iniAt('weak.ini', true);
  const off = [];
  const { ask, seen } = fakeAsk(['deny', 'deny', 'allow']);
  const g = createGate({ ini: f, ask, onTurnedOff: (x) => off.push(...x) });
  setIni(f, 'confirm', 'enabled', 'false');              // e.g. edited by a script
  assert.equal(g.mode(), 'on', 'not applied before the person answers');
  await g.idle();
  assert.match(seen[0].head, /settings file changed/); assert.match(seen[0].text, /Turn off confirmations\?/);
  assert.equal(rs(f).enabled, true, 'Keep wrote the applied state back');
  assert.equal((await g.gate('start_process', { command: 'del x' })).notConfirmed, true, 'still asking');
  setIni(f, 'ask', 'delete', 'false');
  g.mode(); await g.idle();
  assert.equal(rs(f).ask.delete, false); assert.equal(g.settings().ask.delete, false, 'Apply took it');
  assert.deepEqual(off, ['confirmations for deletions']);
  fs.writeFileSync(f, 'garbage');
  assert.equal(g.settings().enabled, true, 'broken file = last known state, not the defaults (off)');
  fs.rmSync(f);
  assert.equal(g.settings().enabled, true, 'missing file = last known state');
  const f2 = iniAt('raise.ini');
  const g2 = createGate({ ini: f2, ask: async () => assert.fail('raising must not ask') });
  setIni(f2, 'confirm', 'enabled', 'true');
  assert.equal(g2.mode(), 'on');
});

test('identical questions at the same time share one notification', async () => {
  const f = iniAt('merge.ini', true);
  let n = 0, release;
  const g = createGate({ ini: f, ask: () => { n++; return new Promise((r) => { release = r; }); } });
  const a = g.gate('start_process', { command: 'del x' }), b = g.gate('start_process', { command: 'del x' });
  await new Promise((r) => setImmediate(r));
  release('allow');
  assert.deepEqual(await Promise.all([a, b]), [null, null]);
  assert.equal(n, 1);
});

test('while a question is on the screen, new commands wait for the answer', async () => {
  const f = iniAt('wait.ini', true);
  let release;
  const g = createGate({ ini: f, ask: () => new Promise((r) => { release = r; }) });
  const q = g.gate('start_process', { command: 'del a' });
  await new Promise((r) => setImmediate(r));
  assert.equal(g.pending, 1);
  let idle = false; g.idle().then(() => { idle = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(idle, false, 'still waiting');
  release('deny'); await q; await new Promise((r) => setImmediate(r));
  assert.equal(idle, true); assert.equal(g.pending, 0);
});

test('helpers never take test hooks from the environment', async () => {
  const { stripOurs } = await import('../src/ask.mjs');
  assert.deepEqual(stripOurs({ PATH: 'p', BR_UI_DIR: 'x', br_zoom: '2', BRIDGERATOR_HOME: 'h', BROWSER: 'b' }), { PATH: 'p', BROWSER: 'b' });
});

test('B1-7: "Allow 10 min" for one category does not silence a later category of the same command', async () => {
  const f = iniAt('b17.ini', true);
  let t = 1000;
  const { ask, seen } = fakeAsk(['allow10', 'deny']);
  const g = createGate({ ini: f, ask, now: () => t });
  assert.equal(await g.gate('start_process', { command: 'del C:\\x.txt' }), null);
  const r = await g.gate('start_process', { command: 'del C:\\x.txt & format D: /q' });
  assert.equal(seen.length, 2, 'the system command is asked about');
  assert.match(seen[1].head, /system command/);
  assert.ok(r?.notConfirmed);
});

test('B1-8: accept(changed) takes only what the bridge wrote; a weakening edit by someone else still needs Apply', async () => {
  const f = iniAt('b18.ini', true);
  const { ask, seen } = fakeAsk(['deny']);
  const g = createGate({ ini: f, ask });
  setIni(f, 'ask', 'delete', 'false');          // someone else turns deletions off …
  setIni(f, 'ask', 'move', 'true');             // … while the bridge writes this one
  g.accept({ move: true });
  await g.idle();
  assert.equal(seen.length, 1, 'the other change is asked about');
  assert.equal(readSettings(f).ask.delete, true, 'Keep wrote it back');
  assert.equal(g.settings().ask.move, true);
});

test('B1-9: a Deny given while a question waited in the queue counts (no second question)', async () => {
  const f = iniAt('b19.ini', true);
  let release;
  const first = new Promise((r) => { release = r; });
  const seen = [];
  const g = createGate({ ini: f, ask: async (q) => { seen.push(q); return seen.length === 1 ? first : 'allow'; } });
  const a = g.askPerson('setup', { head: 'one' });
  const b = g.askPerson('setup', { head: 'two' });
  release('deny');
  assert.equal(await a, 'deny');
  assert.equal(await b, 'cooldown');
  assert.equal(seen.length, 1);
});

test('B1-17: a failing question about a changed confirm.ini never becomes an unhandled rejection', async () => {
  const f = iniAt('b117.ini', true);
  const g = createGate({ ini: f, ask: async () => { throw new Error('no PowerShell'); } });
  let unhandled = 0;
  const on = () => { unhandled++; };
  process.on('unhandledRejection', on);
  setIni(f, 'confirm', 'enabled', 'false');
  g.mode(); await g.idle(); await new Promise((r) => setTimeout(r, 20));
  process.off('unhandledRejection', on);
  assert.equal(unhandled, 0);
  assert.equal(g.mode(), 'on', 'the applied state stays');
});

test('B1-13: a path with typographic quotes stays one PowerShell literal (each quote doubled)', async () => {
  const { q, runFilesPs } = await import('../src/ask.mjs');
  assert.equal(q('C:\\it\u2019s\\a\'b'), "'C:\\it\u2019\u2019s\\a''b'");
  for (const ch of ['\u2018', '\u2019', '\u201A', '\u201B']) assert.ok(runFilesPs(`C:\\x${ch}y.ps1`).includes(`x${ch}${ch}y`));
});

test('X1-10: a request_confirm_off that waited in the queue behind a Deny does not move the 10-minute cool-down', async () => {
  const f = iniAt('req2.ini', true);
  let t = 0;
  const { ask, seen } = fakeAsk(['deny', 'allow']);
  const g = createGate({ ini: f, ask: async (q) => { const r = await ask(q); t += 60 * 1000; return r; }, now: () => t });
  const [a, b] = await Promise.all([g.tool('request_confirm_off'), g.tool('request_confirm_off')]);
  assert.match(a.content[0].text, /^declined/); assert.match(b.content[0].text, /said no a few minutes ago/);
  assert.equal(seen.length, 1);
  t = 60 * 1000 + 10 * 60 * 1000 + 1;      // 10 minutes after the Deny (not after the queued call)
  assert.match((await g.tool('request_confirm_off')).content[0].text, /^approved/);
});
