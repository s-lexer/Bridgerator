// LOGIC: see critical-logic/bridge.md ("Automations and recipes").
// "Save as a script and run it every morning": the AI saves a PowerShell script (its own or a recipe
// with parameters) into %LOCALAPPDATA%\Bridgerator\scripts — inside the always-excluded folder, so the
// AI changes it only through this tool — and registers it in Windows Task Scheduler (folder
// \Bridgerator\, this user, no elevation, runs only while the user is signed in). Windows runs it
// without the AI: no chat, no tool calls. Each run is logged locally (time, exit code, end of the
// output) by runner.ps1; the AI reads it with action "runs", the window shows it on Automations.
//   - scheduling / changing a schedule = something that stays on the PC: an info notification after
//     it (on by default, setting automations.notifySchedule) and, when confirmations are on and the
//     "Scheduled scripts" category is on (off by default), a question before it;
//   - a script that names an excluded folder or Bridgerator itself is refused like a terminal command;
//     the terminal being off (presets Read only / Files) turns automations off too;
//   - uninstall removes our tasks (removeTasks) and, unless --keep-config, the scripts folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { POWERSHELL, WSCRIPT } from './win.mjs';
import { stripOurs } from './ask.mjs';
import { writeAtomic, clip } from './confirm.mjs';
import { runPs, psJson, ToolError, fail, json, needAction, str } from './tool-lib.mjs';
import { recipeList, buildRecipe } from './recipes.mjs';

export const TASK_PATH = '\\Bridgerator\\';
export const MAX_AUTOMATIONS = 50, MAX_SCRIPT = 20000, MAX_NAME = 80, TAIL = 4000;
const RUN_WAIT_MS = 50000, ONE_OFF_MS = 90000, STALE_RUN_MS = 3 * 3600000, WATCH_MS = 30000;
export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const PS_DAY = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const JS_DAY = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const ID_RE = /^[0-9a-f]{8}$/;
const CTRL = /[\u0000-\u001f\u007f]/;

export const defaultDir = (env = process.env) => path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Bridgerator', 'scripts');

// ---- schedules --------------------------------------------------------------------------------------
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Schedule from the AI / window → normalized { type, … } or null (no schedule). Throws BAD_SCHEDULE. */
export function readSchedule(s, now = Date.now(), { future = true } = {}) {
  if (s === null || s === undefined) return null;
  const bad = (why) => fail('BAD_SCHEDULE', `Schedule: ${why}.`, 'Examples: {"type":"daily","time":"08:00"}, {"type":"weekly","days":["mon","fri"],"time":"09:30"}, {"type":"hourly","every":2}, {"type":"logon"}, {"type":"once","at":"2026-11-01T08:00"}.');
  if (typeof s !== 'object' || Array.isArray(s)) bad('must be an object');
  const extra = Object.keys(s).filter((k) => !['type', 'time', 'days', 'every', 'at'].includes(k));
  if (extra.length) bad(`unknown field(s) ${extra.join(', ')}`);
  const time = () => { if (!TIME.test(String(s.time))) bad('time must be HH:MM (24 h), e.g. 08:00'); return s.time; };
  switch (s.type) {
    case 'daily': return { type: 'daily', time: time() };
    case 'weekly': {
      if (!Array.isArray(s.days) || !s.days.length || s.days.length > 7 || s.days.some((d) => !DAYS.includes(d)) || new Set(s.days).size !== s.days.length) bad(`days must be a list of ${DAYS.join(', ')}`);
      return { type: 'weekly', days: DAYS.filter((d) => s.days.includes(d)), time: time() };
    }
    case 'hourly': if (!Number.isInteger(s.every) || s.every < 1 || s.every > 12) bad('every must be 1 to 12 (hours)'); return { type: 'hourly', every: s.every };
    case 'logon': return { type: 'logon' };
    case 'once': {
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(s.at));
      if (!m) bad('at must be local date and time YYYY-MM-DDTHH:MM');
      const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
      if (future && (!(t > now + 60000) || t > now + 366 * 86400000)) bad('at must be in the future, within a year');
      return { type: 'once', at: s.at };
    }
    default: bad('type must be daily, weekly, hourly, logon or once');
  }
}
export function describeSchedule(s) {
  if (!s) return 'not scheduled (run on request)';
  if (s.type === 'daily') return `every day at ${s.time}`;
  if (s.type === 'weekly') return `${s.days.map((d) => d[0].toUpperCase() + d.slice(1)).join(', ')} at ${s.time}`;
  if (s.type === 'hourly') return s.every === 1 ? 'every hour' : `every ${s.every} hours`;
  if (s.type === 'logon') return 'at sign-in';
  return `once on ${s.at.replace('T', ' ')}`;
}
/** Next start (ms, local time) or null (sign-in / past). Hourly repeats from 00:00 each day. */
export function nextRun(s, now = Date.now()) {
  if (!s) return null;
  const at = (d, hm) => { const [h, m] = hm.split(':').map(Number); const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };
  if (s.type === 'daily') { const t = at(now, s.time); if (t > now) return t; const d = new Date(now); d.setDate(d.getDate() + 1); return at(d.getTime(), s.time); }
  if (s.type === 'weekly') {
    for (let i = 0; i < 8; i++) {
      const d = new Date(now); d.setDate(d.getDate() + i);
      if (!s.days.some((x) => JS_DAY[x] === d.getDay())) continue;
      const t = at(d.getTime(), s.time);
      if (t > now) return t;
    }
    return null;
  }
  if (s.type === 'hourly') {
    const base = new Date(now); base.setHours(0, 0, 0, 0);
    const step = s.every * 3600000;
    const t = base.getTime() + Math.floor((now - base.getTime()) / step + 1) * step;
    const tomorrow = new Date(base); tomorrow.setDate(tomorrow.getDate() + 1);
    return t < tomorrow.getTime() ? t : tomorrow.getTime();
  }
  if (s.type === 'once') { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s.at); const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime(); return t > now ? t : null; }
  return null;
}

// ---- files the scheduled task runs (written next to the scripts, from the package) -------------------
// runner.ps1 (inputs BRX_RUN_ID / BRX_RUN_TRIGGER / BRX_RUN_DIR in the environment): runs <id>.ps1 in its own PowerShell, appends {t, ms, code, trigger, tail} to runs/<id>.jsonl
// (last 50 kept), marks runs/<id>.running while it works. ASCII only.
export const RUNNER_PS = `# Runs one saved automation and logs the result (time, exit code, end of the output).
$Id = [string]$env:BRX_RUN_ID
$Trigger = [string]$env:BRX_RUN_TRIGGER
$ErrorActionPreference = 'Continue'
if ($Id -notmatch '^[0-9a-f]{8}$') { exit 2 }
if ($Trigger -notmatch '^(schedule|manual|ai)$') { $Trigger = 'schedule' }
$dir = [string]$env:BRX_RUN_DIR
if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { exit 2 }
$file = Join-Path $dir ($Id + '.ps1')
$runs = Join-Path $dir 'runs'
[void][IO.Directory]::CreateDirectory($runs)
$log = Join-Path $runs ($Id + '.jsonl')
$mark = Join-Path $runs ($Id + '.running')
$utf8 = New-Object Text.UTF8Encoding $false
# UTF-8 between this runner and the script's own PowerShell (it inherits the console): the code page
# (437 / 866 / 1251) would garble any other letters in the log.
try { [Console]::OutputEncoding = $utf8 } catch { $null = $_ }
$start = Get-Date
[IO.File]::WriteAllText($mark, [string]$PID, $utf8)
$code = 0
$text = ''
try {
  if (-not (Test-Path -LiteralPath $file)) { throw 'The script file is missing.' }
  $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  # stderr lines come back as error records: keep only their text (not the runner's own position).
  # Loaded as UTF-8 text into a script block (like every PowerShell file of the bridge, never -File): an
  # execution policy set by the administrator for script files does not stop it, the BOM / code page don't matter.
  $env:BRX_SCRIPT = $file
  $text = (& $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command '. ([scriptblock]::Create([IO.File]::ReadAllText($env:BRX_SCRIPT, [Text.Encoding]::UTF8)))' 2>&1 | ForEach-Object { if ($_ -is [Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ } } | Out-String -Width 220)
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 0 }
} catch {
  $text = $text + ($_ | Out-String)
  $code = 1
}
$text = $text.TrimEnd()
if ($text.Length -gt ${TAIL}) { $text = '...' + $text.Substring($text.Length - ${TAIL}) }
$rec = [ordered]@{ t = $start.ToUniversalTime().ToString('o'); ms = [int]((Get-Date) - $start).TotalMilliseconds; code = [int]$code; trigger = $Trigger; tail = $text }
[IO.File]::AppendAllText($log, (ConvertTo-Json -InputObject $rec -Compress) + [char]10, $utf8)
try {
  $lines = [IO.File]::ReadAllLines($log, $utf8)
  if ($lines.Count -gt 60) { [IO.File]::WriteAllLines($log, [string[]]($lines | Select-Object -Last 50), $utf8) }
} catch { Write-Output ('log not trimmed: ' + $_.Exception.Message) }
Remove-Item -LiteralPath $mark -Force -ErrorAction SilentlyContinue
exit $code
`;
// The runner is loaded as UTF-8 text (no -File: see runner.ps1); its path comes in BRX_RUNNER.
export const RUN_CMD = '. ([scriptblock]::Create([IO.File]::ReadAllText($env:BRX_RUNNER, [Text.Encoding]::UTF8)))';
// run-hidden.vbs <id>: the task's action (wscript, window style 0 — no console flash). UTF-16 + BOM.
export const RUN_VBS = [
  "' Runs one saved automation hidden: run-hidden.vbs <id>",
  'On Error Resume Next',
  'If WScript.Arguments.Count < 1 Then WScript.Quit 2',
  'id = WScript.Arguments(0)',
  'Set re = New RegExp',
  're.Pattern = "^[0-9a-f]{8}$"',
  'If Not re.Test(id) Then WScript.Quit 2',
  'Set sh = CreateObject("WScript.Shell")',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  'dir = fso.GetParentFolderName(WScript.ScriptFullName)',
  'ps = sh.ExpandEnvironmentStrings("%SystemRoot%") & "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
  'Set env = sh.Environment("Process")',
  'env("BRX_RUN_ID") = id',
  'env("BRX_RUN_TRIGGER") = "schedule"',
  'env("BRX_RUN_DIR") = dir',
  'env("BRX_RUNNER") = dir & "\\runner.ps1"',
  `rc = sh.Run("""" & ps & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ${JSON.stringify(RUN_CMD).replace(/"/g, '""')}", 0, True)`,
  // PowerShell did not start (On Error Resume Next would hide it): a log line like runner.ps1's, exit 1.
  'If Err.Number <> 0 Then',
  '  Err.Clear',
  '  n = Now',
  '  t = Year(n) & "-" & Right("0" & Month(n), 2) & "-" & Right("0" & Day(n), 2) & "T" & Right("0" & Hour(n), 2) & ":" & Right("0" & Minute(n), 2) & ":" & Right("0" & Second(n), 2)',
  '  Set f = fso.OpenTextFile(dir & "\\runs\\" & id & ".jsonl", 8, True)',
  '  f.WriteLine "{""t"":""" & t & """,""ms"":0,""code"":1,""trigger"":""schedule"",""tail"":""PowerShell did not start (wscript error).""}"',
  '  f.Close',
  '  WScript.Quit 1',
  'End If',
  'WScript.Quit rc',
  '',
].join('\r\n');

// ---- Task Scheduler (PowerShell ScheduledTasks module; values only through BRX_* env) ----------------
// Folder \\Bridgerator\\ first; if Windows refuses it (a standard user may not create task folders on
// some PCs) the task goes to the root as Bridgerator-auto-<id>. The first error is the one reported.
export const REGISTER_PS = `$s = $env:BRX_SCHED | ConvertFrom-Json
$me = "$env:USERDOMAIN\\$env:USERNAME"
$inv = [Globalization.CultureInfo]::InvariantCulture
switch ($s.type) {
  'daily'  { $t = New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact($s.time, 'HH:mm', $inv)) }
  'weekly' { $t = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek ([string[]]$s.days) -At ([datetime]::ParseExact($s.time, 'HH:mm', $inv)) }
  'hourly' { $t = New-ScheduledTaskTrigger -Daily -At ([datetime]::Today); $t.Repetition = (New-ScheduledTaskTrigger -Once -At ([datetime]::Today) -RepetitionInterval (New-TimeSpan -Hours ([int]$s.every)) -RepetitionDuration (New-TimeSpan -Hours 24)).Repetition }
  'logon'  { $t = New-ScheduledTaskTrigger -AtLogOn -User $me }
  'once'   { $t = New-ScheduledTaskTrigger -Once -At ([datetime]::ParseExact($s.at, 'yyyy-MM-ddTHH:mm', $inv)) }
  default  { throw 'unknown schedule type' }
}
# Local wall-clock time without a zone: a time with Z / an offset is "synchronized across time zones"
# and would move by an hour when daylight saving time changes.
$day = (Get-Date).ToString('yyyy-MM-dd', $inv)
if ($s.type -eq 'daily' -or $s.type -eq 'weekly') { $t.StartBoundary = $day + 'T' + $s.time + ':00' }
elseif ($s.type -eq 'hourly') { $t.StartBoundary = $day + 'T00:00:00' }
elseif ($s.type -eq 'once') { $t.StartBoundary = $s.at + ':00' }
$a = New-ScheduledTaskAction -Execute $env:BRX_WSCRIPT -Argument ('//B //NoLogo "' + $env:BRX_VBS + '" ' + $env:BRX_ID)
$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$set.Enabled = ($env:BRX_ENABLED -eq '1')
$p = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
if (-not $env:BRX_TASKNAME -or -not $env:BRX_TASKPATH.StartsWith('\\')) { throw 'task location missing' }
# ArrayList: a nested @(@(a, b)) would be flattened and the loop would get single strings.
$where = New-Object System.Collections.ArrayList
[void]$where.Add(@($env:BRX_TASKPATH, $env:BRX_TASKNAME))
if ($env:BRX_FALLBACK -eq '1') { [void]$where.Add(@('\\', ('Bridgerator-auto-' + $env:BRX_ID))) }
$first = $null
foreach ($w in $where) {
  try {
    Register-ScheduledTask -TaskPath $w[0] -TaskName $w[1] -Description $env:BRX_DESC -Action $a -Trigger $t -Settings $set -Principal $p -Force -ErrorAction Stop | Out-Null
    ConvertTo-Json -Compress @{ ok = $true; taskPath = $w[0]; taskName = $w[1] }
    return
  } catch { if (-not $first) { $first = $_.Exception.Message } }
}
ConvertTo-Json -Compress @{ ok = $false; error = [string]$first }`;
export const UNREGISTER_PS = `try {
  Unregister-ScheduledTask -TaskPath $env:BRX_TASKPATH -TaskName $env:BRX_TASKNAME -Confirm:$false -ErrorAction Stop
  ConvertTo-Json -Compress @{ ok = $true }
} catch {
  $e = $_.Exception.Message
  if (Get-ScheduledTask -TaskPath $env:BRX_TASKPATH -TaskName $env:BRX_TASKNAME -ErrorAction SilentlyContinue) { ConvertTo-Json -Compress @{ ok = $false; error = $e } }
  else { ConvertTo-Json -Compress @{ ok = $true; missing = $true } }
}`;
export const ENABLE_PS = `try {
  if ($env:BRX_ON -eq '1') { Enable-ScheduledTask -TaskPath $env:BRX_TASKPATH -TaskName $env:BRX_TASKNAME -ErrorAction Stop | Out-Null }
  else { Disable-ScheduledTask -TaskPath $env:BRX_TASKPATH -TaskName $env:BRX_TASKNAME -ErrorAction Stop | Out-Null }
  ConvertTo-Json -Compress @{ ok = $true }
} catch { ConvertTo-Json -Compress @{ ok = $false; error = $_.Exception.Message } }`;
// Uninstall: every task in \\Bridgerator\\ (and Bridgerator-auto-* in the root) whose action runs a file
// of THIS user's scripts folder; then the folder itself if it is empty (other users' tasks stay).
export const REMOVE_ALL_PS = `$dir = $env:BRX_DIR.ToLower()
$n = 0
$errs = @()
$all = @(Get-ScheduledTask -TaskPath $env:BRX_TASKPATH -ErrorAction SilentlyContinue) + @(Get-ScheduledTask -TaskPath '\\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like 'Bridgerator-auto-*' })
foreach ($t in $all) {
  if (((@($t.Actions) | ForEach-Object { $_.Arguments }) -join ' ').ToLower().Contains($dir)) {
    try { Unregister-ScheduledTask -TaskPath $t.TaskPath -TaskName $t.TaskName -Confirm:$false -ErrorAction Stop; $n++ } catch { $errs += $_.Exception.Message }
  }
}
$folder = 'kept'
try {
  $svc = New-Object -ComObject Schedule.Service
  $svc.Connect()
  $name = $env:BRX_TASKPATH.Trim('\\')
  $f = $svc.GetFolder('\\' + $name)
  if ($f.GetTasks(1).Count -eq 0 -and $f.GetFolders(0).Count -eq 0) { $svc.GetFolder('\\').DeleteFolder($name, 0); $folder = 'removed' }
} catch { $folder = 'kept: ' + $_.Exception.Message }
ConvertTo-Json -Compress @{ removed = $n; errors = @($errs); folder = $folder }`;

/** Uninstall: our tasks out of Task Scheduler. → { removed, errors, folder } (never throws). */
export async function removeTasks({ dir = defaultDir(), taskPath = TASK_PATH, ps = runPs } = {}) {
  if (process.platform !== 'win32' && ps === runPs) return { removed: 0, errors: [], folder: 'not Windows' };
  let r;
  try { r = await psJson({ runPs: ps }, { script: REMOVE_ALL_PS, env: { BRX_DIR: dir, BRX_TASKPATH: taskPath }, timeout: 60000 }); } catch (e) { return { removed: 0, errors: [String(e?.message || e)], folder: 'not checked' }; }
  // uninstall --keep-config keeps the scripts: they are no longer scheduled (a schedule can be set again).
  const index = path.join(dir, 'automations.json');
  try {
    const j = JSON.parse(fs.readFileSync(index, 'utf8'));
    if (Array.isArray(j.items)) { for (const x of j.items) { delete x.taskName; delete x.taskPath; } writeAtomic(index, JSON.stringify(j, null, 2)); }
  } catch (e) { if (e.code !== 'ENOENT') r.errors = [...(r.errors || []), `automations.json: ${e.message}`]; }
  return r;
}

/** The runner for "Run now" (window / AI): same runner.ps1 as the schedule, hidden. → exit promise. */
export function startRunner(dir, id, trigger) {
  return new Promise((resolve) => {
    let child;
    const env = { ...stripOurs(process.env), BRX_RUN_ID: id, BRX_RUN_TRIGGER: trigger, BRX_RUN_DIR: dir, BRX_RUNNER: path.join(dir, 'runner.ps1') };
    try { child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', RUN_CMD], { windowsHide: true, stdio: 'ignore', env }); } catch (e) { resolve({ error: e }); return; }
    child.on('error', (e) => resolve({ error: e }));
    child.on('exit', (code) => resolve({ code }));
  });
}

// ---- the store ----------------------------------------------------------------------------------------
/**
 * dir: the scripts folder (created on the first save, never at start). ask: the bridge's question
 * function (info notification), openWindow(page), emit(event) → relay, onChange() → mode / window.
 */
export function createAutomations({ dir = defaultDir(), log = () => {}, ask = null, openWindow = () => {}, emit = () => {}, onChange = () => {}, ps = runPs, runner = startRunner, now = Date.now, taskPath = TASK_PATH, notify = () => true } = {}) {
  const index = path.join(dir, 'automations.json');
  const runsDir = path.join(dir, 'runs');
  let items = [];
  try { const j = JSON.parse(fs.readFileSync(index, 'utf8')); if (Array.isArray(j.items)) items = j.items.filter((x) => x && ID_RE.test(x.id)); } catch (e) { if (e.code !== 'ENOENT') log(`[bridgerator] automations.json unreadable: ${e.message}`); }
  const save = () => { fs.mkdirSync(dir, { recursive: true }); writeAtomic(index, JSON.stringify({ items }, null, 2)); onChange(); };
  const get = (id) => items.find((x) => x.id === id) || fail('NO_AUTOMATION', `There is no automation "${id}" on this PC.`, 'action "list" shows them.');
  const scriptFile = (id) => path.join(dir, `${id}.ps1`);
  const readScript = (id) => { try { return fs.readFileSync(scriptFile(id), 'utf8').replace(/^﻿/, ''); } catch { return ''; } };
  // UTF-8 with BOM (Windows PowerShell 5.1 reads a BOM-less file as ANSI: Cyrillic would break), CRLF.
  const writeScript = (id, text) => { fs.mkdirSync(dir, { recursive: true }); writeAtomic(scriptFile(id), `﻿${text.replace(/\r?\n/g, '\r\n')}`); };
  function ensureRunner() {
    fs.mkdirSync(runsDir, { recursive: true });
    const r = path.join(dir, 'runner.ps1'), v = path.join(dir, 'run-hidden.vbs');
    const want = `﻿${RUNNER_PS.replace(/\r?\n/g, '\r\n')}`;
    try { if (fs.readFileSync(r, 'utf8') === want) { /* current */ } else writeAtomic(r, want); } catch { writeAtomic(r, want); }
    const vb = Buffer.from(`﻿${RUN_VBS}`, 'utf16le');
    let same = false; try { same = fs.readFileSync(v).equals(vb); } catch { /* missing */ }
    if (!same) writeAtomic(v, vb);                 // a task may be starting it right now: temp + rename
  }
  const readRuns = (id) => {
    let t = '';
    try { t = fs.readFileSync(path.join(runsDir, `${id}.jsonl`), 'utf8'); } catch { return []; }
    const out = [];
    for (const l of t.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l.replace(/^﻿/, '')); if (typeof r.t === 'string' && Number.isInteger(r.code)) out.push({ t: r.t, ms: Number(r.ms) || 0, code: r.code, trigger: String(r.trigger || ''), tail: String(r.tail || '') }); } catch { /* a half-written line */ } }
    return out;
  };
  // runs/<id>.running holds the runner's PID: a crash or a reboot leaves the file, but not the process.
  const running = (id) => {
    const mark = path.join(runsDir, `${id}.running`);
    try {
      if (now() - fs.statSync(mark).mtimeMs >= STALE_RUN_MS) return false;
      const pid = Number.parseInt(fs.readFileSync(mark, 'utf8').replace(/^﻿/, ''), 10);
      if (pid > 0) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return false; } }
      return true;
    } catch { return false; }
  };
  // In flight in THIS bridge: a "Run now" whose runner has not written its mark yet; an automation
  // being changed (one change at a time per automation: lock()).
  const starting = new Set(), busy = new Set();
  const summary = (x) => {
    const runs = readRuns(x.id), last = runs[runs.length - 1];
    return {
      id: x.id, name: x.name, ...(x.recipe ? { recipe: x.recipe } : {}), schedule: x.schedule || null, scheduleText: describeSchedule(x.schedule),
      enabled: x.enabled !== false, scheduled: !!(x.schedule && x.taskName), next: x.schedule && x.enabled !== false ? nextRun(x.schedule, now()) : null,
      last: last ? { t: last.t, code: last.code, ms: last.ms, trigger: last.trigger } : null, running: running(x.id), by: x.by || 'ai', updatedAt: x.updatedAt,
      ...(x.taskError ? { taskError: x.taskError } : {}),
    };
  };
  const loc = (x) => ({ BRX_TASKPATH: x.taskPath || taskPath, BRX_TASKNAME: x.taskName || x.id });

  async function register(x) {
    if (!x.schedule) return;
    ensureRunner();
    const sched = x.schedule.type === 'weekly' ? { ...x.schedule, days: x.schedule.days.map((d) => PS_DAY[d]) } : x.schedule;
    const r = await psJson({ runPs: ps }, { script: REGISTER_PS, timeout: 60000, env: {
      ...loc(x), BRX_FALLBACK: x.taskName ? '' : '1', BRX_ID: x.id, BRX_SCHED: JSON.stringify(sched), BRX_ENABLED: x.enabled !== false ? '1' : '',
      BRX_WSCRIPT: WSCRIPT, BRX_VBS: path.join(dir, 'run-hidden.vbs'), BRX_DESC: `Bridgerator automation "${x.name}". Log: ${path.join(runsDir, `${x.id}.jsonl`)}`,
    } });
    if (!r.ok) throw new ToolError('SCHEDULE_FAILED', `Windows Task Scheduler refused the task: ${String(r.error || 'unknown error').slice(0, 300)}`, 'The script is saved; it can still run on request. Try another schedule, or check Task Scheduler on the PC.');
    if (![ '\\', taskPath, x.taskPath].filter(Boolean).includes(r.taskPath) || ![x.id, `Bridgerator-auto-${x.id}`, x.taskName].filter(Boolean).includes(r.taskName)) throw new ToolError('SCHEDULE_FAILED', 'Windows Task Scheduler gave an unexpected task location.', 'Check Task Scheduler → Bridgerator on the PC.');
    Object.assign(x, { taskPath: r.taskPath, taskName: r.taskName });
    delete x.taskError;
  }
  async function unregister(x) {
    if (!x.taskName) return;
    const r = await psJson({ runPs: ps }, { script: UNREGISTER_PS, env: loc(x), timeout: 60000 });
    if (!r.ok) throw new ToolError('UNSCHEDULE_FAILED', `Windows Task Scheduler did not remove the task: ${String(r.error || '').slice(0, 300)}`, 'Remove it in Task Scheduler → Bridgerator on the PC.');
    delete x.taskName; delete x.taskPath;
  }

  const api = {
    dir,
    list: () => items.map(summary),
    get: (id) => { const x = get(id); return { ...summary(x), script: readScript(id) }; },
    script: (id) => readScript(get(id).id),
    runs: (id, n = 10) => readRuns(get(id).id).slice(-Math.max(1, Math.min(50, n))).reverse(),
    counts() { const l = items.map(summary); return { count: l.length, enabled: l.filter((x) => x.scheduled && x.enabled).length, failing: l.filter((x) => x.last && x.last.code !== 0).length }; },
    /** New or changed automation. → { item, scheduleError? } (the script is kept even when Windows refuses the task). */
    async save({ id, name, script, recipe = null, params = null, schedule, by = 'ai' }) {
      const t = new Date(now()).toISOString();
      let x;
      if (id) {
        x = get(id);
        if (name !== undefined) x.name = name;
        if (script !== undefined) { writeScript(x.id, script); x.recipe = recipe || undefined; x.params = params || undefined; }
      } else {
        if (items.length >= MAX_AUTOMATIONS) fail('TOO_MANY', `This PC already has ${MAX_AUTOMATIONS} automations.`, 'Delete one first (action "delete").');
        let nid; do nid = crypto.randomBytes(4).toString('hex'); while (items.some((y) => y.id === nid));
        x = { id: nid, name, ...(recipe ? { recipe } : {}), ...(params ? { params } : {}), schedule: null, enabled: true, by, createdAt: t };
        writeScript(nid, script);
        items.push(x);
        busy.add(nid);                                 // not deletable while its task is being registered
      }
      x.updatedAt = t;
      let scheduleError;
      try {
        if (schedule !== undefined) {
          try { await api.setSchedule0(x, schedule); } catch (e) { scheduleError = e; x.taskError = e.message; }
        } else if (x.taskName && script !== undefined) {
          // The task runs <id>.ps1 itself: a new script text needs no new task, the name may.
          try { await register(x); } catch (e) { scheduleError = e; x.taskError = e.message; }
        }
      } finally { if (!id) busy.delete(x.id); }
      save();
      return { item: summary(x), ...(scheduleError ? { scheduleError } : {}) };
    },
    async setSchedule0(x, schedule) {
      if (!schedule) { await unregister(x); x.schedule = null; return; }
      x.schedule = schedule;
      x.enabled = true;
      await register(x);
    },
    async setSchedule(id, schedule) {
      const x = get(id);
      try { await api.setSchedule0(x, schedule); } catch (e) { x.taskError = e.message; throw e; } finally { x.updatedAt = new Date(now()).toISOString(); save(); }
      return summary(x);
    },
    async setEnabled(id, on) {
      const x = get(id);
      if (x.taskName) {
        const r = await psJson({ runPs: ps }, { script: ENABLE_PS, env: { ...loc(x), BRX_ON: on ? '1' : '' }, timeout: 60000 });
        if (!r.ok) throw new ToolError('SCHEDULE_FAILED', `Windows Task Scheduler did not ${on ? 'enable' : 'disable'} the task: ${String(r.error || '').slice(0, 300)}`, 'Try again, or check Task Scheduler on the PC.');
      }
      x.enabled = !!on; x.updatedAt = new Date(now()).toISOString(); save();
      return summary(x);
    },
    /** → what Undo needs ({ item, script }). The task leaves Task Scheduler first. */
    async remove(id) {
      const x = get(id);
      await unregister(x);
      const removed = { item: { ...x }, script: readScript(id) };
      items = items.filter((y) => y !== x);
      for (const f of [scriptFile(id), path.join(runsDir, `${id}.jsonl`), path.join(runsDir, `${id}.running`)]) fs.rmSync(f, { force: true });
      save();
      return removed;
    },
    /** Undo of a delete in the window (made by the person): same id, script and schedule back. */
    async restore(removed) {
      const it = removed?.item;
      if (!it || !ID_RE.test(it.id) || items.some((y) => y.id === it.id) || typeof removed.script !== 'string' || !removed.script) fail('BAD_ARGS', 'Nothing to restore.');
      if (items.length >= MAX_AUTOMATIONS) fail('TOO_MANY', `This PC already has ${MAX_AUTOMATIONS} automations.`);
      const x = { id: it.id, name: String(it.name || 'Automation').slice(0, MAX_NAME), ...(it.recipe ? { recipe: String(it.recipe) } : {}), ...(it.params && typeof it.params === 'object' ? { params: it.params } : {}), schedule: readSchedule(it.schedule ?? null, now(), { future: false }), enabled: it.enabled !== false, by: it.by === 'person' ? 'person' : 'ai', createdAt: String(it.createdAt || new Date(now()).toISOString()), updatedAt: new Date(now()).toISOString() };
      writeScript(x.id, removed.script.slice(0, MAX_SCRIPT));
      items.push(x);
      try { if (x.schedule && !(x.schedule.type === 'once' && !nextRun(x.schedule, now()))) await register(x); else if (x.schedule?.type === 'once') x.schedule = null; } catch (e) { x.taskError = e.message; }
      save();
      return summary(x);
    },
    /** One change at a time per automation (save under its id, schedule, enable, delete). Throws BUSY. */
    async lock(id, fn) {
      if (busy.has(id)) fail('BUSY', 'This automation is being changed right now (another request is waiting for an answer or for Task Scheduler).', 'Try again in a moment.');
      busy.add(id);
      try { return await fn(); } finally { busy.delete(id); }
    },
    /** Runs a saved automation now (the same runner as the schedule). → { done, run? } — done:false = still running. */
    async run(id, { trigger = 'manual', waitMs = RUN_WAIT_MS } = {}) {
      const x = get(id);
      if (process.platform !== 'win32' && runner === startRunner) fail('NOT_WINDOWS', 'This works only on Windows.');
      if (running(x.id) || starting.has(x.id)) fail('RUNNING', `"${x.name}" is running right now.`, 'Check its log in a moment (action "runs").');
      starting.add(x.id);
      try { ensureRunner(); } catch (e) { starting.delete(x.id); throw e; }
      const t0 = now();
      // A runner that throws at once (not a rejected promise) must not leave the id "starting" for good.
      const p = new Promise((res) => res(runner(dir, x.id, trigger))).finally(() => starting.delete(x.id));
      const r = await Promise.race([p, new Promise((res) => setTimeout(() => res({ waiting: true }), waitMs).unref?.())]);
      if (r?.error) throw new ToolError('PS_START', `PowerShell did not start: ${r.error.code || r.error.message}.`, 'Check that Windows PowerShell is not blocked on this PC.');
      onChange();
      if (r?.waiting) return { done: false };
      const runs = readRuns(x.id);
      const last = runs[runs.length - 1];
      return { done: true, run: last && Date.parse(last.t) >= t0 - 2000 ? last : null, exit: r.code };
    },
    // Scheduled runs that ended with an error → an event for the relay (Telegram etc.: no names, no output).
    seen: new Map(),
    tick() {
      let changed = false;
      for (const x of items) {
        let size = 0;
        try { size = fs.statSync(path.join(runsDir, `${x.id}.jsonl`)).size; } catch { /* no runs yet */ }
        const was = api.seen.get(x.id);
        api.seen.set(x.id, size);
        if (was === undefined || size === was) continue;
        changed = true;
        const runs = readRuns(x.id), last = runs[runs.length - 1];
        if (!last || last.trigger !== 'schedule' || last.code === 0) continue;
        // failing = failed scheduled runs in a row (whole numbers only: the relay gets no name, no output).
        let failing = 0;
        for (let i = runs.length - 1; i >= 0 && runs[i].code !== 0; i--) if (runs[i].trigger === 'schedule') failing++;
        emit({ kind: 'automation_failed', code: last.code, failing });
      }
      if (changed) onChange();
    },
    start() { api.tick(); const t = setInterval(() => { try { api.tick(); } catch (e) { log(`[bridgerator] automations check failed: ${e.message}`); } }, WATCH_MS); t.unref?.(); return () => clearInterval(t); },
    /** Fire-and-forget notice that a script was scheduled (buttons: Show / Turn off). */
    told(x) {
      if (!ask || !notify()) return;
      Promise.resolve(ask({ head: 'ChatGPT scheduled a script on this PC', text: clip(`${x.name} — ${describeSchedule(x.schedule)}`, '', 140), buttons: [['open', 'Show', ''], ['off', 'Turn off', '']], secs: 120, auto: 'closes' }))
        .then((k) => { if (k === 'open') openWindow('automations'); else if (k === 'off') return api.setEnabled(x.id, false); return null; })
        .catch((e) => log(`[bridgerator] automation notice failed: ${e?.message || e}`));
    },
  };
  return api;
}

// ---- the tool ---------------------------------------------------------------------------------------
const ACTIONS = ['recipes', 'list', 'save', 'run', 'runs', 'schedule', 'enable', 'disable', 'delete'];
const SCHEDULE = {
  type: ['object', 'null'], additionalProperties: false,
  description: 'daily {time "HH:MM"} · weekly {days ["mon"…"sun"], time} · hourly {every 1–12} · logon · once {at "YYYY-MM-DDTHH:MM" local}; null = no schedule',
  properties: { type: { type: 'string', enum: ['daily', 'weekly', 'hourly', 'logon', 'once'] }, time: { type: 'string' }, days: { type: 'array', items: { type: 'string', enum: DAYS } }, every: { type: 'integer', minimum: 1, maximum: 12 }, at: { type: 'string' } },
};
export const AUTOMATION_TOOL = {
  name: 'bridgerator_automation',
  title: 'Automations (scheduled scripts)',
  description: 'PowerShell scripts saved on this PC that Windows Task Scheduler runs on a schedule — without the chat and without using tool calls. Actions: recipes (ready-made scripts and their parameters), save (script or recipe + params, optional schedule; id = change an existing one), list, run (a saved id now, or a recipe once without saving), runs (last runs: time, exit code, end of the output), schedule (set, change or null), enable, disable, delete. A recipe with DryRun true only shows what it would do.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ACTIONS },
      id: { type: 'string', maxLength: 8 },
      name: { type: 'string', maxLength: MAX_NAME },
      script: { type: 'string', maxLength: MAX_SCRIPT, description: 'Windows PowerShell 5.1 script; exit code ≠ 0 = failed' },
      recipe: { type: 'string', maxLength: 40 },
      params: { type: 'object', description: 'recipe parameters (action "recipes" lists them)' },
      schedule: SCHEDULE,
      limit: { type: 'integer', minimum: 1, maximum: 50 },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};
export const defs = [AUTOMATION_TOOL];
export const settings = [
  { key: 'automations.notifySchedule', default: true, widensWhen: false, label: { en: 'Notify when ChatGPT schedules a script', ru: 'Уведомлять, когда ChatGPT ставит сценарий на расписание' }, hint: { en: 'A notification on this PC each time a script is scheduled or its schedule changes', ru: 'Уведомление на этом ПК при каждой постановке сценария на расписание или его изменении' } },
];

// One store per bridge (bridge.mjs attaches it; ctx.cfg is the same object for the bridge's lifetime).
const stores = new WeakMap();
export const attachAutomations = (cfg, store) => { stores.set(cfg, store); return store; };
export const automationsFor = (cfg) => stores.get(cfg) || null;

const notConfirmed = (t) => ({ content: [{ type: 'text', text: t }], isError: true, notConfirmed: true });
/** A script the AI wants on this PC: the same rules as a terminal command (terminal off, excluded folders, Bridgerator itself). */
function checkScript(ctx, script) {
  const refusal = ctx.policy?.check('start_process', { command: script });
  if (refusal) fail('ACCESS_DENIED', refusal.replace(/^Access denied by Bridgerator: /, ''), 'Change the script, or ask the person to change Bridgerator → Safety.');
}
function scriptOf(ctx, args) {
  if (args.recipe !== undefined) {
    if (args.script !== undefined) fail('BAD_ARGS', 'Give either script or recipe, not both.');
    const b = buildRecipe(ctx, str(args, 'recipe', { required: true, max: 40 }), args.params ?? {});
    return { script: b.script, recipe: b.recipe, params: b.params };
  }
  if (args.params !== undefined) fail('BAD_ARGS', 'params belong to a recipe.');
  const s = str(args, 'script', { required: true, max: MAX_SCRIPT });
  if (/\u0000/.test(s)) fail('BAD_ARGS', 'The script contains a NUL character.');
  return { script: s, recipe: null, params: null };
}
const nameOf = (args, fallback) => {
  const n = args.name === undefined ? fallback : str(args, 'name', { required: true, max: MAX_NAME }).trim();
  if (!n || CTRL.test(n)) fail('BAD_ARGS', 'name must be a short title on one line.');
  return n;
};
/** Scheduling = something that stays on the PC: asks first when confirmations + "Scheduled scripts" are on. */
async function approve(ctx, { name, script, schedule, change }) {
  const s = ctx.gate?.settings?.();
  if (!s?.enabled || !s.ask?.scheduled_scripts) return 'free';
  const r = await ctx.gate.askPerson('schedule', {
    head: change ? 'ChatGPT wants to change a scheduled script' : 'ChatGPT wants to schedule a script',
    text: clip(`${name} · ${describeSchedule(schedule)} · ${script}`, '', 140),
    buttons: [['allow', 'Allow', ''], ['deny', 'Deny', 'deny']], secs: s.timeoutSec, auto: 'auto-deny', ...(ctx.popup?.() || {}),
  });
  return r === 'allow' ? 'allowed' : r === 'cooldown' ? 'cooldown' : 'denied';
}
const deniedText = (r) => notConfirmed(r === 'cooldown' ? 'Not scheduled — the person at the PC declined a schedule a few minutes ago. Ask them first.' : 'Not scheduled — the person at the PC did not allow it (denied or no answer).');

// One recipe / script run without saving: piped to PowerShell's stdin (no file, no length limit of a command line).
const ONE_OFF_PS = "$ErrorActionPreference = 'Continue'\n[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)\n$__s = [Console]::In.ReadToEnd()\n& ([scriptblock]::Create($__s)) 2>&1 | ForEach-Object { if ($_ -is [Management.Automation.ErrorRecord]) { 'ERROR: ' + $_.Exception.Message } else { $_ } } | Out-String -Stream -Width 220\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }";
const tailOf = (s) => { const t = String(s || '').replace(/\s+$/, ''); return t.length > TAIL ? `...${t.slice(-TAIL)}` : t; };

/** The script on disk is still the one the person was asked about (another change can't slip in). */
function sameScript(a, id, script) {
  if (id && script !== null && a.script(id) !== script) fail('CHANGED', 'The script was changed while the person was being asked; nothing was done.', 'Ask again.');
}
/** action "save" (inside the automation's lock when it has an id). */
async function saveAction(a, ctx, args, src, cur) {
  const script = src ? src.script : a.script(cur.id);
  checkScript(ctx, script);
  const schedule = args.schedule === undefined ? undefined : readSchedule(args.schedule, Date.now());
  const nm = nameOf(args, cur ? cur.name : src.recipe ? src.recipe : '');
  // What runs on a schedule changes (new schedule, or a new script under an existing one) → approval.
  const willRun = schedule !== undefined ? schedule : cur?.scheduled ? cur.schedule : null;
  const changed = !!willRun && (schedule !== undefined || !!src);
  let ok = 'free';
  if (changed) { ok = await approve(ctx, { name: nm, script, schedule: willRun, change: !!cur?.scheduled }); if (ok === 'denied' || ok === 'cooldown') return deniedText(ok); }
  if (changed) sameScript(a, cur?.id, cur ? (src ? null : script) : null);
  const r = await a.save({ id: cur?.id, name: nm, ...(src ? { script: src.script, recipe: src.recipe, params: src.params } : {}), ...(schedule !== undefined ? { schedule } : {}) });
  if (r.scheduleError) return { content: [{ type: 'text', text: `Saved as ${r.item.id}, but not scheduled. ${r.scheduleError.message}${r.scheduleError.hint ? ` ${r.scheduleError.hint}` : ''}` }], isError: true };
  if (changed && r.item.scheduled && ok === 'free') a.told(r.item);
  return json({ saved: r.item, note: r.item.scheduled ? `Windows runs it ${r.item.scheduleText}, also when no chat is open. Results: action "runs".` : 'Saved; not scheduled. Run it with action "run" or give it a schedule.' });
}

export async function handle(name, args, ctx) {
  const a = automationsFor(ctx.cfg);
  const action = needAction(args, ACTIONS);
  if (action === 'recipes') return json({ recipes: recipeList('en'), note: 'Run one with action "run" (recipe + params) or keep it with action "save" (+ schedule). DryRun true only shows what would happen.' });
  if (!a && !(action === 'run' && args.id === undefined)) fail('NOT_AVAILABLE', 'Automations are not available on this PC.', 'Bridgerator needs to be installed with its settings folder.');
  const id = () => str(args, 'id', { required: true, max: 8 });
  switch (action) {
    case 'list': return json({ automations: a.list(), where: 'Windows Task Scheduler → Bridgerator; scripts and logs stay on this PC' });
    case 'runs': { const x = a.get(id()); return json({ id: x.id, name: x.name, runs: a.runs(x.id, Number.isInteger(args.limit) ? args.limit : 5) }); }
    case 'save': {
      const src = args.script === undefined && args.recipe === undefined && args.id ? null : scriptOf(ctx, args);
      const cur = args.id ? a.get(id()) : null;
      // One change at a time per automation: nothing can swap its script or delete it while the person is asked.
      return cur ? a.lock(cur.id, () => saveAction(a, ctx, args, src, a.get(cur.id))) : saveAction(a, ctx, args, src, null);
    }
    case 'schedule': {
      const x = a.get(id());
      if (args.schedule === undefined) fail('BAD_ARGS', 'schedule is required (null removes it).');
      const schedule = readSchedule(args.schedule, Date.now());
      return a.lock(x.id, async () => {
        if (schedule) {
          const script = a.script(x.id);
          checkScript(ctx, script);
          const ok = await approve(ctx, { name: x.name, script, schedule, change: x.scheduled });
          if (ok === 'denied' || ok === 'cooldown') return deniedText(ok);
          sameScript(a, x.id, script);
          const s = await a.setSchedule(x.id, schedule);
          if (ok === 'free') a.told({ ...s, schedule });
          return json({ automation: s });
        }
        return json({ automation: await a.setSchedule(x.id, null), note: 'No schedule any more; the script is kept.' });
      });
    }
    case 'enable': case 'disable': {
      const x = a.get(id());
      return a.lock(x.id, async () => {
        if (action === 'enable' && x.scheduled && !x.enabled) {
          const script = a.script(x.id);
          checkScript(ctx, script);
          const ok = await approve(ctx, { name: x.name, script, schedule: x.schedule, change: true });
          if (ok === 'denied' || ok === 'cooldown') return deniedText(ok);
          sameScript(a, x.id, script);
          const s = await a.setEnabled(x.id, true);
          if (ok === 'free') a.told(s);
          return json({ automation: s });
        }
        return json({ automation: await a.setEnabled(x.id, action === 'enable') });
      });
    }
    case 'delete': { const x = a.get(id()); await a.lock(x.id, () => a.remove(x.id)); return json({ deleted: x.id, note: 'Removed from Task Scheduler with its script and log.' }); }
    case 'run': {
      if (args.id === undefined) {
        // A recipe (or a script) once, without saving it.
        const src = scriptOf(ctx, args);
        checkScript(ctx, src.script);
        const stop = await ctx.gate?.gate?.('start_process', { command: src.script });
        if (stop) return stop;
        const r = await (ctx.runPs || runPs)({ script: ONE_OFF_PS, input: src.script, timeout: ONE_OFF_MS });
        return json({ ...(src.recipe ? { recipe: src.recipe } : {}), code: r.code, output: tailOf(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`) });
      }
      const x = a.get(id());
      return a.lock(x.id, async () => {
        const script = a.script(x.id);
        checkScript(ctx, script);
        const stop = await ctx.gate?.gate?.('start_process', { command: script });
        if (stop) return stop;
        sameScript(a, x.id, script);
        const r = await a.run(x.id, { trigger: 'ai' });
        if (!r.done) return json({ id: x.id, running: true, note: 'Still running in the background; action "runs" shows the result when it ends.' });
        return json({ id: x.id, run: r.run || { code: r.exit, tail: '' } });
      });
    }
    default: return fail('BAD_ACTION', `action must be one of: ${ACTIONS.join(', ')}.`);
  }
}

/** Window requests (the person at the PC: no questions). */
export async function windowRpc(a, method, p = {}) {
  if (!a) throw new Error('automations are not available');
  switch (method) {
    case 'automation.list': return a.list();
    case 'automation.get': return { ...a.get(String(p.id)), runs: a.runs(String(p.id), 20) };
    case 'automation.run': { const r = a.run(String(p.id), { trigger: 'manual', waitMs: 300 }); await r; return true; }
    case 'automation.enable': return a.lock(String(p.id), () => a.setEnabled(String(p.id), p.on === true));
    case 'automation.remove': return a.lock(String(p.id), () => a.remove(String(p.id)));
    case 'automation.restore': return a.restore(p.removed);
    default: throw new Error(`unknown request ${method}`);
  }
}
