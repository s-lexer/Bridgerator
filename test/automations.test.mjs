// Automations (src/automations.mjs): schedules, the Task Scheduler scripts, the runner and the
// bridgerator_automation tool. LOGIC: critical-logic/bridge.md ("Automations and recipes").
// No real task is created here: Task Scheduler calls go to a fake (or to PowerShell with
// Register-ScheduledTask replaced by a stub); the runner and the scripts run for real, hidden.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPs, NOT_WIN } from './helpers/ps.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-auto-'));
const home = path.join(root, 'Иван Петров');
Object.assign(process.env, { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
const work = path.join(root, 'Работа'), secret = path.join(root, 'Секрет'), ro = path.join(root, 'Архив');
for (const d of [home, work, secret, ro]) fs.mkdirSync(d, { recursive: true });

const A = await import('../src/automations.mjs');
const { createPolicy } = await import('../src/policy.mjs');
const { createGate, ensureIni, setIni } = await import('../src/confirm.mjs');
const { createExtra } = await import('../src/extra-tools.mjs');
const extra = createExtra([A]); // the registry's call(): a refusal becomes the plain-words text, as in the bridge
const { createAutomations, attachAutomations, readSchedule, describeSchedule, nextRun, removeTasks, REGISTER_PS, UNREGISTER_PS, ENABLE_PS, REMOVE_ALL_PS, RUNNER_PS } = A;

const text = (r) => (r.content || []).map((c) => c.text).join('\n');
const body = (r) => JSON.parse(text(r));
/** Fake Task Scheduler: records every script + env, answers like the real scripts. */
function fakeTs({ fail = '' } = {}) {
  const calls = [];
  const ps = async ({ script, env }) => {
    const kind = script === REGISTER_PS ? 'register' : script === UNREGISTER_PS ? 'unregister' : script === ENABLE_PS ? 'enable' : script === REMOVE_ALL_PS ? 'removeAll' : 'other';
    calls.push({ kind, env: { ...env } });
    const out = kind === 'register' ? (fail ? { ok: false, error: fail } : { ok: true, taskPath: env.BRX_TASKPATH, taskName: env.BRX_TASKNAME })
      : kind === 'removeAll' ? { removed: 2, errors: [], folder: 'removed' } : { ok: true };
    return { code: 0, stdout: `${JSON.stringify(out)}\n`, stderr: '' };
  };
  return { ps, calls };
}
let n = 0;
const newDir = () => path.join(root, `scripts-${++n}`, 'Сценарии');

test('a schedule is checked and normalized; a wrong one says how to write it', () => {
  const now = new Date(2026, 9, 20, 12, 0).getTime();
  assert.deepEqual(readSchedule({ type: 'daily', time: '08:00' }, now), { type: 'daily', time: '08:00' });
  assert.deepEqual(readSchedule({ type: 'weekly', days: ['fri', 'mon'], time: '09:30' }, now), { type: 'weekly', days: ['mon', 'fri'], time: '09:30' }, 'days in week order');
  assert.deepEqual(readSchedule({ type: 'hourly', every: 2 }, now), { type: 'hourly', every: 2 });
  assert.deepEqual(readSchedule({ type: 'logon' }, now), { type: 'logon' });
  assert.deepEqual(readSchedule({ type: 'once', at: '2026-10-21T07:15' }, now), { type: 'once', at: '2026-10-21T07:15' });
  assert.equal(readSchedule(null, now), null);
  for (const bad of [{ type: 'daily', time: '8:00' }, { type: 'daily', time: '24:00' }, { type: 'weekly', days: [], time: '08:00' }, { type: 'weekly', days: ['mon', 'mon'], time: '08:00' }, { type: 'weekly', days: ['пн'], time: '08:00' },
    { type: 'hourly', every: 0 }, { type: 'hourly', every: 13 }, { type: 'once', at: '2026-10-19T08:00' }, { type: 'once', at: '2028-10-19T08:00' }, { type: 'cron', expr: '* * *' }, { type: 'daily', time: '08:00', extra: 1 }, [], 'daily']) {
    assert.throws(() => readSchedule(bad, now), (e) => e.code === 'BAD_SCHEDULE' && /Examples/.test(e.hint), JSON.stringify(bad));
  }
  assert.equal(describeSchedule({ type: 'weekly', days: ['mon', 'fri'], time: '09:30' }), 'Mon, Fri at 09:30');
  assert.equal(describeSchedule({ type: 'hourly', every: 1 }), 'every hour');
  assert.equal(describeSchedule(null), 'not scheduled (run on request)');
});

test('next start: daily, weekly, every N hours from midnight, once; at sign-in has none', () => {
  const at = (d, h, m) => new Date(2026, 9, d, h, m).getTime();
  const now = at(20, 12, 0); // Tuesday 20.10.2026 12:00
  assert.equal(nextRun({ type: 'daily', time: '13:00' }, now), at(20, 13, 0));
  assert.equal(nextRun({ type: 'daily', time: '08:00' }, now), at(21, 8, 0));
  assert.equal(nextRun({ type: 'weekly', days: ['mon'], time: '08:00' }, now), at(26, 8, 0));
  assert.equal(nextRun({ type: 'weekly', days: ['tue'], time: '11:00' }, now), at(27, 11, 0), 'today\'s time is past → next week');
  assert.equal(nextRun({ type: 'hourly', every: 5 }, now), at(20, 15, 0));
  assert.equal(nextRun({ type: 'hourly', every: 5 }, at(20, 21, 0)), at(21, 0, 0), 'the last repetition of the day → midnight');
  assert.equal(nextRun({ type: 'once', at: '2026-10-25T10:00' }, now), at(25, 10, 0));
  assert.equal(nextRun({ type: 'once', at: '2026-10-19T10:00' }, now), null);
  assert.equal(nextRun({ type: 'logon' }, now), null);
});

test('the Task Scheduler, runner and uninstall scripts are valid Windows PowerShell 5.1', { skip: NOT_WIN }, async () => {
  const scripts = { REGISTER_PS, UNREGISTER_PS, ENABLE_PS, REMOVE_ALL_PS, RUNNER_PS };
  const r = await runPs(`$out = @{}
foreach ($k in $env:PST_KEYS.Split(',')) {
  $e = $null; $t = $null
  [void][Management.Automation.Language.Parser]::ParseInput([Environment]::GetEnvironmentVariable('PST_' + $k), [ref]$t, [ref]$e)
  $out[$k] = @($e | ForEach-Object { $_.Message })
}
ConvertTo-Json -Compress -Depth 3 $out`, { env: { PST_KEYS: Object.keys(scripts).join(','), ...Object.fromEntries(Object.entries(scripts).map(([k, v]) => [`PST_${k}`, v])) } });
  for (const k of Object.keys(scripts)) assert.deepEqual(r[k], [], `${k} parses`);
  assert.match(RUNNER_PS, /^[\x00-\x7f]*$/, 'runner.ps1 is ASCII (no BOM / code page surprises)');
});

test('registering: the task folder and the id reach Register-ScheduledTask with a real trigger; a refused folder falls back to the root; the first error is reported', { skip: NOT_WIN }, async () => {
  // Register-ScheduledTask replaced by a function: nothing reaches Task Scheduler. The module is loaded
  // FIRST (loading it later would put the real command back), and the script stops if the stub is not the one called.
  const stub = `Import-Module ScheduledTasks
$global:calls = New-Object System.Collections.ArrayList
function Register-ScheduledTask { param($TaskPath, $TaskName, $Description, $Action, $Trigger, $Settings, $Principal)
  [void]$global:calls.Add(@{ path = $TaskPath; name = $TaskName; desc = $Description; exe = $Action.Execute; arg = $Action.Arguments; days = $Trigger.DaysOfWeek; start = $Trigger.StartBoundary; rep = $Trigger.Repetition.Interval; dur = $Trigger.Repetition.Duration; enabled = $Settings.Enabled; limit = $Settings.ExecutionTimeLimit; level = [string]$Principal.RunLevel; logon = [string]$Principal.LogonType })
  if ($env:PST_DENY -and $TaskPath -ne '\\') { throw 'Access is denied. (folder)' }
  if ($env:PST_DENY_ALL) { throw 'second error' }
}
if ((Get-Command Register-ScheduledTask).ModuleName) { throw 'STUB NOT ACTIVE' }
$res = & { ${REGISTER_PS} }
if ((Get-Command Register-ScheduledTask).ModuleName) { throw 'STUB NOT ACTIVE' }
ConvertTo-Json -Compress -Depth 4 @{ res = ($res | ConvertFrom-Json); calls = @($global:calls) }`;
  const env = (o) => ({ BRX_TASKPATH: '\\Bridgerator-test\\', BRX_TASKNAME: 'a1b2c3d4', BRX_ID: 'a1b2c3d4', BRX_FALLBACK: '1', BRX_ENABLED: '1', BRX_WSCRIPT: 'C:\\Windows\\System32\\wscript.exe', BRX_VBS: 'C:\\Users\\Иван\\AppData\\Local\\Bridgerator\\scripts\\run-hidden.vbs', BRX_DESC: 'Bridgerator automation "Бэкап"', ...o });
  const weekly = await runPs(stub, { env: env({ BRX_SCHED: JSON.stringify({ type: 'weekly', days: ['Monday', 'Friday'], time: '09:30' }) }) });
  assert.deepEqual(weekly.res, { ok: true, taskPath: '\\Bridgerator-test\\', taskName: 'a1b2c3d4' });
  const c = weekly.calls[0];
  assert.equal(weekly.calls.length, 1);
  assert.equal(c.exe, 'C:\\Windows\\System32\\wscript.exe');
  assert.equal(c.arg, '//B //NoLogo "C:\\Users\\Иван\\AppData\\Local\\Bridgerator\\scripts\\run-hidden.vbs" a1b2c3d4');
  assert.equal(c.days, 2 + 32, 'Monday + Friday');
  assert.match(c.start, /^\d{4}-\d{2}-\d{2}T09:30:00$/, 'local time, no zone (stays 09:30 across daylight saving changes)');
  assert.equal(c.desc, 'Bridgerator automation "Бэкап"');
  assert.equal(c.enabled, true);
  assert.equal(c.limit, 'PT2H');
  assert.equal(c.level, 'Limited', 'no elevation');
  assert.equal(c.logon, 'Interactive', 'this user, only while signed in (no stored password)');
  const hourly = await runPs(stub, { env: env({ BRX_ENABLED: '', BRX_SCHED: JSON.stringify({ type: 'hourly', every: 3 }) }) });
  assert.equal(hourly.calls[0].rep, 'PT3H'); assert.equal(hourly.calls[0].dur, 'P1D'); assert.equal(hourly.calls[0].enabled, false);
  const denied = await runPs(stub, { env: env({ PST_DENY: '1', BRX_SCHED: JSON.stringify({ type: 'daily', time: '08:00' }) }) });
  assert.deepEqual(denied.calls.map((x) => [x.path, x.name]), [['\\Bridgerator-test\\', 'a1b2c3d4'], ['\\', 'Bridgerator-auto-a1b2c3d4']]);
  assert.deepEqual(denied.res, { ok: true, taskPath: '\\', taskName: 'Bridgerator-auto-a1b2c3d4' });
  const both = await runPs(stub, { env: env({ PST_DENY: '1', PST_DENY_ALL: '1', BRX_SCHED: JSON.stringify({ type: 'logon' }) }) });
  assert.equal(both.res.ok, false); assert.match(both.res.error, /folder/, 'the first error, not the fallback\'s');
  const known = await runPs(stub, { env: env({ BRX_FALLBACK: '', PST_DENY: '1', BRX_SCHED: JSON.stringify({ type: 'once', at: '2027-01-02T03:04' }) }) });
  assert.equal(known.calls.length, 1, 'an existing task is replaced in place, no second location');
  assert.equal(known.calls[0].start, '2027-01-02T03:04:00');
  assert.match(hourly.calls[0].start, /T00:00:00$/);
});

// Safety net: if a stub ever failed, the test names must not stay in Task Scheduler (and the run is red).
after(async () => {
  if (process.platform !== 'win32') return;
  const r = await runPs(`$hit = @()
foreach ($w in @(@('\\Bridgerator-test\\', 'a1b2c3d4'), @('\\', 'Bridgerator-auto-a1b2c3d4'))) {
  if (Get-ScheduledTask -TaskPath $w[0] -TaskName $w[1] -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskPath $w[0] -TaskName $w[1] -Confirm:$false; $hit += ($w[0] + $w[1]) }
}
ConvertTo-Json -Compress @{ hit = @($hit) }`);
  assert.deepEqual(r.hit, [], 'no real task was created by the tests');
});

test('store: save, schedule (days in English for Windows), disable, rename keeps the task, delete removes it, Undo puts it back', async () => {
  const ts = fakeTs(), dir = newDir();
  const changes = [];
  const a = createAutomations({ dir, ps: ts.ps, onChange: () => changes.push(1) });
  assert.equal(fs.existsSync(dir), false, 'nothing is created before the first save');
  const r = await a.save({ name: 'Бэкап «Документы»', script: "Write-Output 'копия'", schedule: { type: 'weekly', days: ['mon', 'fri'], time: '21:00' } });
  assert.ok(!r.scheduleError);
  assert.match(r.item.id, /^[0-9a-f]{8}$/);
  assert.equal(r.item.scheduled, true);
  const reg = ts.calls.find((c) => c.kind === 'register');
  assert.deepEqual(JSON.parse(reg.env.BRX_SCHED), { type: 'weekly', days: ['Monday', 'Friday'], time: '21:00' });
  assert.equal(reg.env.BRX_TASKPATH, '\\Bridgerator\\'); assert.equal(reg.env.BRX_TASKNAME, r.item.id); assert.equal(reg.env.BRX_FALLBACK, '1');
  assert.equal(reg.env.BRX_VBS, path.join(dir, 'run-hidden.vbs'));
  // Files: the script with a BOM (PowerShell 5.1 + Cyrillic), the runner, the hidden launcher (UTF-16 + BOM).
  const raw = fs.readFileSync(path.join(dir, `${r.item.id}.ps1`));
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(raw.toString('utf8'), /копия/);
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'run-hidden.vbs')).subarray(0, 2)], [0xff, 0xfe]);
  assert.match(fs.readFileSync(path.join(dir, 'runner.ps1'), 'utf8'), /runs\b/);
  assert.equal(a.list().length, 1);
  assert.equal((await a.setEnabled(r.item.id, false)).enabled, false);
  assert.deepEqual(ts.calls.at(-1), { kind: 'enable', env: { BRX_TASKPATH: '\\Bridgerator\\', BRX_TASKNAME: r.item.id, BRX_ON: '' } });
  ts.calls.length = 0;
  await a.save({ id: r.item.id, name: 'Бэкап 2' });
  assert.deepEqual(ts.calls, [], 'a new name alone does not touch the task');
  await a.save({ id: r.item.id, script: "Write-Output 'v2'" });
  assert.equal(ts.calls[0].kind, 'register'); assert.equal(ts.calls[0].env.BRX_FALLBACK, '', 'same task, replaced in place');
  const removed = await a.remove(r.item.id);
  assert.equal(ts.calls.at(-1).kind, 'unregister');
  assert.equal(a.list().length, 0); assert.equal(fs.existsSync(path.join(dir, `${r.item.id}.ps1`)), false);
  const back = await a.restore(JSON.parse(JSON.stringify(removed)));
  assert.equal(back.id, r.item.id); assert.equal(back.scheduled, true); assert.equal(a.script(r.item.id), "Write-Output 'v2'");
  await assert.rejects(a.restore(removed), /Nothing to restore/, 'twice = refused');
  assert.ok(changes.length >= 5, 'the window / relay hear about changes');
  // Schedule off: task removed, the script stays.
  const s = await a.setSchedule(r.item.id, null);
  assert.equal(s.scheduled, false); assert.equal(s.schedule, null); assert.equal(ts.calls.at(-1).kind, 'unregister');
});

test('Windows refusing the task keeps the script and says why', async () => {
  const ts = fakeTs({ fail: 'Отказано в доступе' });
  const a = createAutomations({ dir: newDir(), ps: ts.ps });
  const r = await a.save({ name: 'x', script: 'exit 0', schedule: { type: 'daily', time: '08:00' } });
  assert.equal(r.scheduleError.code, 'SCHEDULE_FAILED'); assert.match(r.scheduleError.message, /Отказано в доступе/);
  assert.equal(r.item.scheduled, false); assert.match(r.item.taskError, /Отказано/);
  assert.equal(a.script(r.item.id), 'exit 0');
});

test('runner: runs the saved script hidden, logs time, exit code and the end of its output (Cyrillic kept), keeps the last 50 runs', { skip: NOT_WIN }, async () => {
  const dir = newDir();
  const a = createAutomations({ dir, ps: fakeTs().ps });
  const { item } = await a.save({ name: 'Проверка', script: "Write-Output 'привет, мир ✓'\nWrite-Error 'что-то не так'\n1..3000 | ForEach-Object { 'строка ' + $_ }\nexit 3" });
  fs.mkdirSync(path.join(dir, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runs', `${item.id}.jsonl`), Array.from({ length: 60 }, (_, i) => JSON.stringify({ t: new Date(2026, 0, 1, 0, i).toISOString(), ms: 1, code: 0, trigger: 'schedule', tail: `old ${i}` })).join('\n') + '\n');
  const r = await a.run(item.id, { trigger: 'ai' });
  assert.equal(r.done, true); assert.equal(r.exit, 3);
  assert.equal(r.run.code, 3); assert.equal(r.run.trigger, 'ai');
  assert.match(r.run.tail, /строка 3000$/, 'the END of the output');
  assert.ok(r.run.tail.length <= A.TAIL + 3);
  assert.ok(Date.parse(r.run.t) > Date.now() - 120000);
  const runs = a.runs(item.id, 50);
  assert.equal(runs.length, 50, 'log trimmed to the last 50');
  assert.equal(runs[0].code, 3, 'newest first');
  assert.equal(a.list()[0].last.code, 3); assert.equal(a.list()[0].running, false);
  const { item: b } = await a.save({ name: 'stderr', script: "Write-Output 'ок'\n[Console]::Error.WriteLine('ошибка в stderr')\nexit 0" });
  const r2 = await a.run(b.id);
  assert.equal(r2.run.code, 0); assert.match(r2.run.tail, /ок/); assert.match(r2.run.tail, /ошибка в stderr/);
  assert.doesNotMatch(r2.run.tail, /runner\.ps1/, 'no runner internals in the log');
});

test('a scheduled run that failed becomes an event for the relay (exit code + failures in a row, whole numbers only); manual runs and old runs do not', () => {
  const dir = newDir(), events = [];
  const a = createAutomations({ dir, ps: fakeTs().ps, emit: (e) => events.push(e) });
  return (async () => {
    const { item } = await a.save({ name: 'Секретный бэкап', script: 'exit 1', recipe: 'backup-folder', params: {} });
    const log = path.join(dir, 'runs', `${item.id}.jsonl`);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.writeFileSync(log, `${JSON.stringify({ t: '2026-10-19T08:00:00Z', ms: 5, code: 2, trigger: 'schedule', tail: 'old' })}\n`);
    a.tick();
    assert.deepEqual(events, [], 'runs from before the start are not news');
    fs.appendFileSync(log, `${JSON.stringify({ t: '2026-10-20T08:00:00Z', ms: 5, code: 0, trigger: 'schedule', tail: 'ok' })}\n`); a.tick();
    fs.appendFileSync(log, `${JSON.stringify({ t: '2026-10-20T09:00:00Z', ms: 5, code: 4, trigger: 'manual', tail: 'x' })}\n`); a.tick();
    assert.deepEqual(events, []);
    fs.appendFileSync(log, `${JSON.stringify({ t: '2026-10-20T10:00:00Z', ms: 5, code: 7, trigger: 'schedule', tail: 'Секретный вывод' })}\n`); a.tick();
    assert.deepEqual(events, [{ kind: 'automation_failed', code: 7, failing: 1 }]);
    fs.appendFileSync(log, `${JSON.stringify({ t: '2026-10-21T10:00:00Z', ms: 5, code: 8, trigger: 'schedule', tail: '' })}\n`); a.tick();
    assert.deepEqual(events[1], { kind: 'automation_failed', code: 8, failing: 2 }, 'two scheduled failures in a row (the manual one between does not reset)');
    assert.doesNotMatch(JSON.stringify(events), /Секрет/);
    assert.deepEqual(a.counts(), { count: 1, enabled: 0, failing: 1 });
  })();
});

// ---- the tool --------------------------------------------------------------------------------------------
function toolSetup({ confirm = false, scheduled = false, terminalOff = false } = {}) {
  const ini = path.join(root, `confirm-${++n}.ini`);
  ensureIni(ini);
  if (confirm) setIni(ini, 'confirm', 'enabled', 'true');
  if (scheduled) setIni(ini, 'ask', 'scheduled_scripts', 'true');
  const asked = [], told = [];
  const box = { answer: 'deny', toastAnswer: 'deny' };
  const gate = createGate({ ini, ask: async (q) => { asked.push(q); return box.answer; } });
  const cfg = { allowedDirectories: [], deniedDirectories: [secret], readOnlyDirectories: [ro], ...(terminalOff ? { disabledTools: ['start_process', 'interact_with_process', 'kill_process'] } : {}) };
  const ts = fakeTs();
  const store = attachAutomations(cfg, createAutomations({ dir: newDir(), ps: ts.ps, ask: async (q) => { told.push(q); return box.toastAnswer; }, openWindow: (p) => told.push({ opened: p }), notify: () => cfg.automations?.notifySchedule !== false }));
  const ctx = { cfg, policy: createPolicy(cfg), gate, log: () => {}, popup: () => ({ theme: 'dark' }) };
  const call = (args) => extra.call('bridgerator_automation', args, ctx);
  return { cfg, ctx, call, asked, told, box, ts, store };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('tool: save with a schedule while confirmations are off: no question, a notice that it was scheduled (can be turned off)', async () => {
  const s = toolSetup();
  const r = await s.call({ action: 'save', name: 'Отчёт', script: "Write-Output 'отчёт'", schedule: { type: 'daily', time: '08:00' } });
  assert.ok(!r.isError, text(r));
  const saved = body(r).saved;
  assert.equal(saved.scheduled, true); assert.match(body(r).note, /every day at 08:00/);
  assert.equal(s.asked.length, 0);
  await tick();
  assert.equal(s.told.length, 1);
  assert.equal(s.told[0].head, 'ChatGPT scheduled a script on this PC'); assert.match(s.told[0].text, /Отчёт — every day at 08:00/);
  assert.deepEqual(s.told[0].buttons.map((b) => b[0]), ['open', 'off'], 'Show / Turn off — no Deny meaning "keep"');
  // Turned off in the window / settings: no notice.
  s.cfg.automations = { notifySchedule: false };
  await s.call({ action: 'schedule', id: saved.id, schedule: { type: 'hourly', every: 2 } });
  await tick();
  assert.equal(s.told.length, 1);
  // Saving without a schedule: nothing to tell.
  s.cfg.automations = {};
  await s.call({ action: 'save', name: 'manual', script: 'exit 0' });
  await tick();
  assert.equal(s.told.length, 1);
});

test('tool: the notice buttons — Show opens the Automations page, Turn off disables the task; no answer changes nothing', async () => {
  const s = toolSetup();
  s.box.toastAnswer = 'off';
  const id = body(await s.call({ action: 'save', name: 'a', script: 'exit 0', schedule: { type: 'logon' } })).saved.id;
  await tick(); await tick();
  assert.equal(s.store.list().find((x) => x.id === id).enabled, false);
  assert.equal(s.ts.calls.at(-1).kind, 'enable'); assert.equal(s.ts.calls.at(-1).env.BRX_ON, '');
  s.box.toastAnswer = 'open';
  await s.call({ action: 'save', name: 'b', script: 'exit 0', schedule: { type: 'logon' } });
  await tick();
  assert.deepEqual(s.told.at(-1), { opened: 'automations' });
  s.box.toastAnswer = 'deny';
  const id3 = body(await s.call({ action: 'save', name: 'c', script: 'exit 0', schedule: { type: 'logon' } })).saved.id;
  await tick();
  assert.equal(s.store.list().find((x) => x.id === id3).enabled, true);
});

test('tool: confirmations on + "Scheduled scripts" on: the person is asked first (script head…tail + schedule); Deny = nothing saved or scheduled', async () => {
  const s = toolSetup({ confirm: true, scheduled: true });
  const script = `Write-Output 'начало'\n${'# filler line\n'.repeat(40)}Write-Output 'КОНЕЦ'`;
  const r = await s.call({ action: 'save', name: 'Чистка', script, schedule: { type: 'weekly', days: ['mon'], time: '10:00' } });
  assert.equal(r.isError, true); assert.equal(r.notConfirmed, true); assert.match(text(r), /did not allow/);
  assert.equal(s.asked.length, 1);
  assert.equal(s.asked[0].head, 'ChatGPT wants to schedule a script');
  assert.match(s.asked[0].text, /^Чистка · Mon at 10:00 · Write-Output 'начало'/); assert.match(s.asked[0].text, /КОНЕЦ'$/); assert.match(s.asked[0].text, /\(\+\d+ chars\)/);
  assert.ok(s.asked[0].text.length <= 160);
  assert.equal(s.asked[0].theme, 'dark', 'our pop-up theme');
  assert.equal(s.store.list().length, 0); assert.equal(s.ts.calls.length, 0);
  // A new question within 10 minutes of a Deny is not shown.
  const again = await s.call({ action: 'save', name: 'Чистка', script, schedule: { type: 'daily', time: '10:00' } });
  assert.match(text(again), /declined a schedule a few minutes ago/); assert.equal(s.asked.length, 1);
  // Allowed (fresh gate): saved + scheduled, and no extra notice (the person has just seen it).
  const s2 = toolSetup({ confirm: true, scheduled: true });
  s2.box.answer = 'allow';
  const ok = await s2.call({ action: 'save', name: 'Чистка', script, schedule: { type: 'daily', time: '10:00' } });
  assert.equal(body(ok).saved.scheduled, true);
  await tick();
  assert.equal(s2.told.length, 0);
  // Changing the script under an existing schedule asks too ("change a scheduled script"); the name alone does not.
  const id = body(ok).saved.id;
  await s2.call({ action: 'save', id, script: 'exit 0' });
  assert.equal(s2.asked.at(-1).head, 'ChatGPT wants to change a scheduled script');
  const before = s2.asked.length;
  await s2.call({ action: 'save', id, name: 'Новое имя' });
  assert.equal(s2.asked.length, before);
});

test('tool: confirmations on, "Scheduled scripts" off (the default): no question, only the notice', async () => {
  const s = toolSetup({ confirm: true });
  const r = await s.call({ action: 'save', name: 'x', script: 'exit 0', schedule: { type: 'daily', time: '07:00' } });
  assert.equal(body(r).saved.scheduled, true);
  assert.equal(s.asked.length, 0);
  await tick();
  assert.equal(s.told.length, 1);
});

test('tool: a script that names an excluded folder or Bridgerator itself is refused; the terminal off (Read only / Files) turns automations off', async () => {
  const s = toolSetup();
  for (const script of [`Get-ChildItem '${secret}'`, 'Get-ChildItem $env:LOCALAPPDATA\\Bridgerator', 'Stop-Process -Name bridgerator']) {
    const r = await s.call({ action: 'save', name: 'x', script, schedule: { type: 'daily', time: '07:00' } });
    assert.equal(r.isError, true, script); assert.match(text(r), /ACCESS_DENIED/, script);
  }
  assert.equal(s.store.list().length, 0);
  const off = toolSetup({ terminalOff: true });
  const r = await off.call({ action: 'run', recipe: 'disk-report', params: { Folder: work } });
  assert.match(text(r), /terminal is off/i);
  assert.match(text(await off.call({ action: 'save', name: 'x', script: 'exit 0' })), /terminal is off/i);
});

test('tool: run — a saved script runs now and returns exit code and output; with confirmations on, a deletion inside it asks like a terminal command', { skip: NOT_WIN }, async () => {
  const s = toolSetup();
  const id = body(await s.call({ action: 'save', name: 'echo', script: "Write-Output 'готово'\nexit 2" })).saved.id;
  const r = body(await s.call({ action: 'run', id }));
  assert.equal(r.run.code, 2); assert.match(r.run.tail, /готово/);
  assert.equal(body(await s.call({ action: 'runs', id })).runs[0].trigger, 'ai');
  const c = toolSetup({ confirm: true });
  const did = body(await c.call({ action: 'save', name: 'del', script: `Remove-Item '${path.join(work, 'nothing.txt')}'` })).saved.id;
  const stop = await c.call({ action: 'run', id: did });
  assert.equal(stop.notConfirmed, true);
  assert.equal(c.asked[0].head, 'ChatGPT wants to delete files');
  assert.deepEqual(c.store.runs(did), [], 'not run');
});

test('tool: list / runs / enable / disable / delete; an unknown id says how to find them; recipes listed', async () => {
  const s = toolSetup();
  const id = body(await s.call({ action: 'save', name: 'x', script: 'exit 0', schedule: { type: 'daily', time: '06:00' } })).saved.id;
  assert.equal(body(await s.call({ action: 'list' })).automations[0].id, id);
  assert.equal(body(await s.call({ action: 'disable', id })).automation.enabled, false);
  assert.equal(body(await s.call({ action: 'enable', id })).automation.enabled, true);
  await tick();
  assert.equal(s.told.length, 2, 'scheduling + enabling again were told');
  assert.match(text(await s.call({ action: 'runs', id: 'ffffffff' })), /action "list" shows them.*NO_AUTOMATION/s);
  assert.equal(body(await s.call({ action: 'delete', id })).deleted, id);
  assert.equal(body(await s.call({ action: 'list' })).automations.length, 0);
  const rec = body(await s.call({ action: 'recipes' })).recipes;
  assert.deepEqual(rec.map((x) => x.id), ['backup-folder', 'clean-downloads', 'sort-folder', 'disk-report', 'update-apps']);
  assert.match(text(await s.call({ action: 'nope' })), /BAD_ACTION/);
  assert.match(text(await s.call({ action: 'save', name: 'x', script: 'exit 0', recipe: 'disk-report' })), /either script or recipe/);
});

test('uninstall: our tasks leave Task Scheduler and automations.json no longer claims them', async () => {
  const ts = fakeTs(), dir = newDir();
  const a = createAutomations({ dir, ps: ts.ps });
  await a.save({ name: 'x', script: 'exit 0', schedule: { type: 'daily', time: '08:00' } });
  const r = await removeTasks({ dir, ps: ts.ps });
  assert.deepEqual(r, { removed: 2, errors: [], folder: 'removed' });
  assert.deepEqual(ts.calls.at(-1), { kind: 'removeAll', env: { BRX_DIR: dir, BRX_TASKPATH: '\\Bridgerator\\' } });
  assert.equal(createAutomations({ dir, ps: ts.ps }).list()[0].scheduled, false);
  // A PowerShell that fails: reported, never thrown (uninstall goes on).
  const bad = await removeTasks({ dir, ps: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
  assert.equal(bad.removed, 0); assert.match(bad.errors[0], /boom/);
});

test('the tool definition: few actions, short plain description, honest hints', () => {
  const d = A.AUTOMATION_TOOL;
  assert.equal(d.name, 'bridgerator_automation');
  assert.deepEqual(d.inputSchema.properties.action.enum, ['recipes', 'list', 'save', 'run', 'runs', 'schedule', 'enable', 'disable', 'delete']);
  assert.ok(d.description.length < 700);
  assert.doesNotMatch(d.description, /\b(MUST|ALWAYS|NEVER|IMPORTANT)\b/);
  assert.deepEqual(d.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: true }, 'scripts can change and reach anything the user can');
  assert.deepEqual(A.settings.map((s) => [s.key, s.default, s.widensWhen]), [['automations.notifySchedule', true, false]]);
});


test('B2-6 / B2-34: while the person is asked, the automation can not be changed or deleted; a script swapped on disk is refused (CHANGED)', async () => {
  const s = toolSetup({ confirm: true, scheduled: true });
  const id = body(await s.call({ action: 'save', name: 'Тест', script: 'exit 0' })).saved.id;
  let answer; s.box.answer = new Promise((r) => { answer = r; });
  const pending = s.call({ action: 'schedule', id, schedule: { type: 'daily', time: '09:00' } });
  await tick();
  assert.equal(s.asked.length, 1);
  assert.match(text(await s.call({ action: 'delete', id })), /BUSY/);
  assert.match(text(await s.call({ action: 'save', id, script: 'Remove-Item x' })), /BUSY/);
  await assert.rejects(A.windowRpc(s.store, 'automation.remove', { id }), (e) => e.code === 'BUSY');
  fs.writeFileSync(path.join(s.store.dir, `${id}.ps1`), '\ufeffWrite-Output swapped');   // changed outside the tool
  answer('allow');
  const r = await pending;
  assert.match(text(r), /CHANGED/); assert.equal(s.ts.calls.filter((c) => c.kind === 'register').length, 0, 'nothing scheduled');
  // The lock is released: a delete now works.
  assert.equal(body(await s.call({ action: 'delete', id })).deleted, id);
});

test('B2-35 / B2-42: a second "Run now" while the first is starting is refused; a run mark left by a dead process does not block', async () => {
  const dir = newDir();
  let end; const runner = () => new Promise((r) => { end = r; });
  const a = createAutomations({ dir, ps: fakeTs().ps, runner });
  const { item } = await a.save({ name: 'x', script: 'exit 0' });
  const first = a.run(item.id, { waitMs: 50 });
  await assert.rejects(a.run(item.id, { waitMs: 50 }), (e) => e.code === 'RUNNING');
  assert.equal((await first).done, false);
  end({ code: 0 }); await tick();
  const mark = path.join(dir, 'runs', `${item.id}.running`);
  fs.writeFileSync(mark, String(process.pid));
  assert.equal(a.list()[0].running, true, 'a live runner');
  fs.writeFileSync(mark, '2147483646');
  assert.equal(a.list()[0].running, false, 'its process is gone: not running');
  const again = a.run(item.id, { waitMs: 20 }); end({ code: 0 }); assert.equal((await again).done, true);
});

test('B2-45 / B2-37: run-hidden.vbs reports a PowerShell that did not start (log line + exit 1); it is written through temp + rename', async () => {
  assert.match(A.RUN_VBS, /If Err\.Number <> 0 Then[\s\S]*OpenTextFile\(dir & "\\runs\\" & id & "\.jsonl", 8, True\)[\s\S]*WScript\.Quit 1\r\nEnd If\r\nWScript\.Quit rc/);
  const dir = newDir();
  const a = createAutomations({ dir, ps: fakeTs().ps });
  await a.save({ name: 'x', script: 'exit 0', schedule: { type: 'daily', time: '07:00' } });
  assert.ok(fs.readFileSync(path.join(dir, 'run-hidden.vbs')).equals(Buffer.from(`\ufeff${A.RUN_VBS}`, 'utf16le')));
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('X1-13: a runner that throws at once does not leave the automation "running" for good', async () => {
  const dir = newDir();
  let boom = true;
  const a = createAutomations({ dir, ps: fakeTs().ps, runner: () => { if (boom) throw new Error('spawn failed'); return Promise.resolve({ code: 0 }); } });
  const { item } = await a.save({ name: 'x', script: 'exit 0' });
  await assert.rejects(a.run(item.id, { waitMs: 50 }), /spawn failed/);
  boom = false;
  const r = await a.run(item.id, { waitMs: 50 });
  assert.notEqual(r.done, undefined, 'not refused as RUNNING');
});
