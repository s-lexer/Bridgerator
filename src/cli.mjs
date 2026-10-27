#!/usr/bin/env node
// bridgerator.cmd setup [--token <t> | --pair] [--relay <wss url>] [--allow <dir>]... [--deny <dir>]... [--read-only <dir>]... [--language en|ru] [--no-telemetry]
//   → config + autostart + start (no key yet, or the stored key was rejected: pairs this PC through the
//   browser — the signed-in owner confirms a code)
// bridgerator.cmd run | stop | status | doctor [--json] | confirm on|off [category] | read-only add|remove <dir> | telemetry on|off | uninstall [--all | --keep-config] | --version
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';
import { startEngine, connect, checkRelay } from './bridge.mjs';
import { pair, siteOf, checkKey, machineFp } from './pair.mjs';
import { ACCOUNT_URL } from './notice.mjs';
import { send, VERSION } from './telemetry.mjs';
import { restoreIni, setIni, readSettings, writeAtomic, CATEGORIES } from './confirm.mjs';
import { showNotice } from './notice.mjs';
import { startTray } from './tray.mjs';
import { POWERSHELL, SCHTASKS, CMD, WSCRIPT, WHOAMI, REG, psArgs } from './win.mjs';
import { runDoctor, formatDoctor } from './doctor.mjs';
import { removeTasks } from './automations.mjs';

delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; // never talk to the relay with TLS checks off

const DEFAULT_RELAY = 'wss://mcp.bridgerator.recondeck.com/link';
const OLD_TASK = 'Bridgerator'; // ≤ 1.0.7: one name for every user of the PC
const home = os.homedir();
const APPDATA = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const LOCALAPPDATA = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
// BRIDGERATOR_HOME only for the test runner (node --test) or with an explicit --home on the command line.
const HOME_ARG = (() => { const i = process.argv.indexOf('--home'); return i > 0 ? process.argv[i + 1] : null; })();
const DIR = HOME_ARG || (process.env.NODE_TEST_CONTEXT && process.env.BRIDGERATOR_HOME) || path.join(process.platform === 'win32' ? APPDATA : path.join(home, '.config'), 'Bridgerator');
const CONFIG = path.join(DIR, 'config.json');
const LOG = path.join(DIR, 'bridge.log');
const VBS = path.join(DIR, 'run-hidden.vbs');
const INI = path.join(DIR, 'confirm.ini'); // on-PC confirmation settings (confirm.mjs), read on every call
// File copies for Undo (undo.mjs): %LOCALAPPDATA%\Bridgerator\snapshots (always excluded); next to a moved home in tests.
const SNAP_DIR = DIR === path.join(APPDATA, 'Bridgerator') ? path.join(LOCALAPPDATA, 'Bridgerator', 'snapshots') : path.join(DIR, 'snapshots');
// Automations (scheduled scripts, automations.mjs): inside the always-excluded %LOCALAPPDATA%\Bridgerator.
const SCRIPTS_DIR = DIR === path.join(APPDATA, 'Bridgerator') ? path.join(LOCALAPPDATA, 'Bridgerator', 'scripts') : path.join(DIR, 'scripts');
// The window's WebView2 data: a second bridge (--home) gets its own, or its window stays black (one data folder = one browser process).
const WEBVIEW_DIR = DIR === path.join(APPDATA, 'Bridgerator') ? path.join(LOCALAPPDATA, 'Bridgerator', 'webview') : path.join(DIR, 'webview');
const SELF = fileURLToPath(import.meta.url);
const PKG_DIR = path.dirname(path.dirname(SELF)); // …\node_modules\bridgerator
// Private Node.js the installer puts in when there is none (or < 22) — see install.ps1.
const NODE_DIR = path.join(LOCALAPPDATA, 'Bridgerator', 'node');
// The Windows app without Node (install.ps1 default): bridgerator.exe + the package files in this folder.
// LOGIC: see critical-logic/install-release.md ("Windows app without Node").
/**
 * setup / update: the new config = everything the person set before (theme, language, notifications,
 * tool settings…: owner 21.10 "no setting is ever lost on an update") + setup's own keys on top.
 * confirm / confirmTools = keys of an earlier draft (confirm.ini now).
 */
export function setupConfig(prev, own) {
  const { confirm: _c, confirmTools: _t, ...c } = { ...(prev || {}), ...own };
  return c;
}
export const APP_DIR = path.join(LOCALAPPDATA, 'Bridgerator', 'app');
/**
 * Where the program files are: { exe: false } = npm package (removed with npm); { exe: true, dir, ours }
 * = bridgerator.exe running from `dir` (= the package folder); `ours` only for the installer's folder
 * %LOCALAPPDATA%\Bridgerator\app — a build run from anywhere else is never deleted by uninstall.
 */
export function programFiles({ sea = isSea(), execPath = process.execPath, pkgDir = PKG_DIR, appDir = APP_DIR } = {}) {
  if (!sea) return { exe: false };
  const key = (d) => path.resolve(d).toLowerCase().replace(/[\\/]+$/, '');
  const dir = path.dirname(execPath);
  return { exe: true, dir, ours: key(dir) === key(appDir) && key(pkgDir) === key(appDir) };
}
const CWD = process.cwd(); // relative --allow/--deny are resolved against it (we chdir below)

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { o[k] = true; continue; }
    i++;
    if (k === 'allow' || k === 'deny' || k === 'read-only') (o[k] ||= []).push(v); else o[k] = v;
  }
  return o;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; }
}
const writeConfig = (cfg) => { fs.mkdirSync(DIR, { recursive: true }); writeAtomic(CONFIG, JSON.stringify(cfg, null, 2)); };

function log(line) {
  const s = `${new Date().toISOString()} ${line}`;
  console.log(s);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5e6) fs.renameSync(LOG, `${LOG}.1`);
    fs.appendFileSync(LOG, s + '\n');
  } catch { /* log dir not writable — console only */ }
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ps = (script) => execFileSync(POWERSHELL, psArgs(script), { stdio: 'pipe' }).toString();

// One scheduled task per Windows user: Bridgerator-<SID>.
// Parsers of Windows tool output (any locale: by structure, never by label text).
/** `whoami /user /fo csv /nh` ("domain\name","S-1-…") → the user SID: the last field, never the name. */
export const sidFrom = (out) => (String(out).match(/"(S-1-[\d-]+)"\s*$/m) || [])[1];
/** `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` → the GUID. */
export const machineGuidFrom = (out) => (String(out).match(/MachineGuid\s+REG_SZ\s+(\S+)/) || [])[1];
let sidCache;
function taskName() {
  sidCache ||= sidFrom(execFileSync(WHOAMI, ['/user', '/fo', 'csv', '/nh']).toString());
  if (!sidCache) throw new Error('could not read this Windows user id (whoami /user)');
  return `Bridgerator-${sidCache}`;
}
// Fingerprint for pairing (pair.machineFp): MachineGuid from the registry + this user's SID, hashed.
export function thisPcFp() {
  if (process.platform !== 'win32') return '';
  try {
    const out = execFileSync(REG, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { stdio: 'pipe' }).toString();
    return machineFp(machineGuidFrom(out), taskName().replace(/^Bridgerator-/, ''));
  } catch { return ''; }
}

// The old shared task is removed only when it runs OUR script (another user's task stays).
const dropOldTaskPs = () => `$o = Get-ScheduledTask -TaskName ${q(OLD_TASK)} -ErrorAction SilentlyContinue; if ($o -and ((($o.Actions | ForEach-Object { $_.Arguments }) -join ' ').ToLower().Contains(${q(VBS.toLowerCase())}))) { Unregister-ScheduledTask -TaskName ${q(OLD_TASK)} -Confirm:$false }`;

// Hidden autostart at logon of THIS user (not SYSTEM): the assistant gets the user's rights only.
function installAutostart() {
  if (process.platform !== 'win32') return 'autostart: not Windows — start `bridgerator run` yourself';
  fs.writeFileSync(VBS, '\ufeff' + hiddenVbs(process.execPath, SELF), 'utf16le');
  // Registered through PowerShell's ScheduledTasks module: `schtasks /Create … wscript.exe …` spawned
  // from node is refused (EPERM) on clean Windows 11. No 72 h execution limit (the task default
  // would silently stop the bridge after three days); normal priority (the task default is below normal).
  ps([
    `$a = New-ScheduledTaskAction -Execute ${q(WSCRIPT)} -Argument ${q(`//B //NoLogo "${VBS}"`)}`,
    '$t = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\\$env:USERNAME"',
    '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -Priority 4',
    '$p = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\\$env:USERNAME" -LogonType Interactive -RunLevel Limited',
    `Register-ScheduledTask -TaskName ${q(taskName())} -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`,
    dropOldTaskPs(),
  ].join('; '));
  return `autostart: scheduled task "${taskName()}" (at logon, hidden)`;
}

// Hidden; waits for the bridge and restarts it after a crash (exit code ≠ 0) with a growing pause
// (10 s … 30 min, back to 10 s after a run of 10+ min); exit 0 = stopped on purpose (computer
// unlinked). Quits when node.exe or the package is gone (uninstalled). No WSH error boxes.
// Saved as UTF-16 with BOM: WSH reads a BOM-less file as ANSI, so a Cyrillic & co. profile path
// (C:\Users\Иван) would break the autostart.
export function hiddenVbs(node, app) {
  const s = (x) => `"${String(x).replace(/"/g, '""')}"`;
  return [
    'On Error Resume Next',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `node = ${s(node)}`,
    `app = ${s(app)}`,
    'wait = 10',
    'Do',
    '  If Not fso.FileExists(node) Or Not fso.FileExists(app) Then WScript.Quit 3',
    '  t = Now',
    '  Err.Clear',
    '  rc = sh.Run("""" & node & """ """ & app & """ run", 0, True)',
    // Could not start (an antivirus holds the file, …): retried like a crash, with the same growing pause.
    '  If Err.Number <> 0 Then rc = -1',
    '  Err.Clear',
    '  If rc = 0 Then WScript.Quit 0',
    '  If DateDiff("s", t, Now) > 600 Then wait = 10',
    '  WScript.Sleep wait * 1000',
    '  wait = wait * 2',
    '  If wait > 1800 Then wait = 1800',
    'Loop',
    '',
  ].join('\r\n');
}

// THE process matcher (install.ps1 carries the same lines for old versions without `stop`): in this
// Windows session only — the autostart loop (wscript running our run-hidden.vbs; first, or it
// restarts the bridge), and node.exe / bridgerator.exe / rg.exe / powershell.exe whose command line or
// executable is inside the package folder (bridge, engine child, ripgrep, tray helper).
const matchPs = (pkgDir, vbs, selfPid) => `$me = (Get-Process -Id $PID).SessionId; $pkg = ${q(pkgDir.toLowerCase().replace(/[\\/]+$/, '') + '\\')}; $vbs = ${q(vbs.toLowerCase())}
$all = @(Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='node.exe' OR Name='bridgerator.exe' OR Name='rg.exe' OR Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $s = ("$($_.CommandLine) $($_.ExecutablePath)").ToLower().Replace('/', '\\'); $_.SessionId -eq $me -and $_.ProcessId -ne ${Number(selfPid)} -and ($s.Contains($pkg) -or $s.Contains($vbs)) } |
  Sort-Object { $_.Name -ne 'wscript.exe' })`;
// The tray helper (powershell.exe) removes its icon itself once the bridge is gone (a kill leaves a
// ghost icon): it gets 2 s after the rest is stopped, then the kill. Then the window's WebView2
// processes left behind (msedgewebview2.exe with OUR user data folder, this session only; V-8).
export const webviewStopPs = (dataDir) => `$wvd = ${q(`--user-data-dir=${dataDir}`.toLowerCase())}; $me = (Get-Process -Id $PID).SessionId
$wv = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $me }); $ids = @($wv | Where-Object { "$($_.CommandLine)".ToLower().Replace('"', '').Contains($wvd) } | ForEach-Object { $_.ProcessId })
$wv | Where-Object { $ids -contains $_.ProcessId -or $ids -contains $_.ParentProcessId } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
export function stopPs(pkgDir, vbs, selfPid, webviewDir = path.join(LOCALAPPDATA, 'Bridgerator', 'webview')) {
  return `${matchPs(pkgDir, vbs, selfPid)}
$all | Where-Object { $_.Name -ne 'powershell.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$tray = @($all | Where-Object { $_.Name -eq 'powershell.exe' }); $end = (Get-Date).AddSeconds(2)
while ($tray.Count -and (Get-Date) -lt $end -and @($tray | Where-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }).Count) { Start-Sleep -Milliseconds 200 }
$tray | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
${webviewStopPs(webviewDir)}`;
}

// Is the bridge process running (same matcher as stop, nothing is stopped)?
function isRunning() {
  if (process.platform !== 'win32') return false;
  try { return ps(`${matchPs(PKG_DIR, VBS, process.pid)}\n@($all | Where-Object { $_.Name -eq "node.exe" -or $_.Name -eq "bridgerator.exe" }).Count`).trim() !== '0'; } catch { return false; }
}

/**
 * One "offline" notice per outage, a minute after it began (if `notify()` shows it → true): the timer is
 * armed once per outage — reconnect attempts that fail again do not restart it. → (linkState) => void
 */
export function offlineWatch(notify, ms = 60000) {
  let timer = null, told = false;
  return (state) => {
    if (state === 'online') { clearTimeout(timer); timer = null; told = false; }
    else if (state === 'offline' && !told && !timer) timer = setTimeout(() => { timer = null; told = notify() === true; }, ms);
  };
}

/** The first line of `status`, in plain words, from "is it running" + the end of bridge.log. */
export function statusLine(running, logLines) {
  let state = null;
  for (let i = logLines.length - 1; i >= 0 && !state; i--) {
    const l = logLines[i];
    if (/no longer linked|rejected the device token/.test(l)) state = { rejected: true };
    else { const m = l.match(/registered as "([^"]+)"/); if (m) state = { online: m[1] }; else if (/disconnected \(/.test(l)) state = { offline: true }; }
  }
  if (state?.rejected) return 'Bridgerator: key rejected — run the install command again';
  if (!running) return 'Bridgerator is not running (it starts at the next sign-in; or run the install command again)';
  if (state?.online) return `Bridgerator is running — online as ${state.online}`;
  return 'Bridgerator is running — not connected yet (reconnecting)';
}

function stopRunning() {
  if (process.platform !== 'win32') return;
  try { ps(stopPs(PKG_DIR, VBS, process.pid)); } catch { /* none running */ }
}

// Start through the scheduled task itself — same as at logon, and not a child of this console
// (closing the installer window or a job object around it must not kill the bridge).
function startHidden() {
  if (process.platform === 'win32') execFileSync(SCHTASKS, ['/Run', '/TN', taskName()], { stdio: 'pipe' });
  else spawn(process.execPath, [SELF, 'run'], { detached: true, stdio: 'ignore' }).unref();
}

// Removes `dir` from the user PATH, keeping its registry type (REG_EXPAND_SZ stays expandable).
const removeFromUserPathPs = (dir) => `$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); if ($k -and $null -ne $k.GetValue('Path')) { $kind = $k.GetValueKind('Path'); $old = $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); $new = ($old -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ne ${q(dir)} }) -join ';'; if ($new -ne $old) { $k.SetValue('Path', $new, $kind) } }`;

// wss://mcp.host/link → https://mcp.host/device/revoke
export const revokeUrl = (relay) => { const u = new URL(relay); return `https://${u.host}/device/revoke`; };
// A key the server no longer knows (401: the computer was already removed in the account) is fine.
// 404 is NOT: the relay answers an unknown key with 401 only, so 404 = wrong address / old server.
export async function revokeKey(cfg, { fetchFn = fetch } = {}) {
  const r = await fetchFn(revokeUrl(cfg.relay), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: cfg.token }), signal: AbortSignal.timeout(5000) });
  if (!r.ok && r.status !== 401) throw new Error(`HTTP ${r.status}`);
}
// The account page of the site this config talks to (a staging install points to staging).
/**
 * The tray's confirmations on/off: confirm.ini written, then the gate told. Only a failed write is
 * "not written" + the confirm_locked notice (V-9); an error of the gate is logged as what it is (VR-5).
 */
export function trayConfirm(on, { ini, dc, log, notice = showNotice, set = setIni }) {
  try { set(ini, 'confirm', 'enabled', on ? 'true' : 'false'); } catch (e) { log(`[bridgerator] confirm.ini not written (${e.code || e.message}) — setting unchanged`); notice({ kind: 'confirm_locked' }, log); return false; }
  try { dc?.acceptConfirm?.({ enabled: on }); } catch (e) { log(`[bridgerator] tray confirm toggle: ${e?.message || e}`); }
  return true;
}
export const accountUrlOf = (cfg) => { try { return cfg?.relay ? `${siteOf(cfg.relay)}/app` : ACCOUNT_URL; } catch { return ACCOUNT_URL; } };

// npm.cmd by absolute path only: the one next to the node.exe running us (its global folder holds this
// package), else the first on the PATH — never a relative entry, the current or the home folder (a
// planted npm.cmd there must not run). → null when none.
export function findNpm({ execPath = process.execPath, pathEnv = process.env.Path ?? process.env.PATH ?? '', cwd = process.cwd(), home = os.homedir(), exists = fs.existsSync } = {}) {
  const near = path.join(path.dirname(execPath), 'npm.cmd');
  if (exists(near)) return near;
  const key = (d) => path.resolve(d).toLowerCase().replace(/[\\/]+$/, '');
  const bad = new Set([key(cwd), key(home)]);
  for (const raw of String(pathEnv).split(';')) {
    const d = raw.trim().replace(/^"|"$/g, '');
    if (!d || !path.isAbsolute(d) || !/^[a-z]:[\\/]/i.test(d) || bad.has(key(d))) continue;
    const f = path.join(d, 'npm.cmd');
    if (exists(f)) return f;
  }
  return null;
}

/**
 * cmd.exe line for uninstall --all: wait ~3 s (this process exits), delete the folders, then their parent if empty.
 * The paths come in environment variables (removeLaterEnv): cmd expands %VAR% once, so a % in a path
 * (a folder named %NAME%) is never expanded again.
 */
export function removeLaterCmd(dirs) {
  const ping = path.join(path.dirname(CMD), 'PING.EXE');
  return [`"${ping}" -n 4 127.0.0.1 >nul`, ...dirs.map((d, i) => `rmdir /s /q "%BRRM${i}%"`), 'rmdir "%BRRMP%"'].join(' & ');
}
export const removeLaterEnv = (dirs, parent) => ({ ...Object.fromEntries(dirs.map((d, i) => [`BRRM${i}`, d])), BRRMP: parent });
/**
 * cmd.exe arguments that run removeLaterCmd as written (spawned with windowsVerbatimArguments). With more
 * than two quotes cmd /c drops the FIRST and the LAST quote of the line: /s + one outer pair makes that
 * rule take exactly the outer pair.
 */
export const removeLaterArgs = (dirs) => ['/d', '/s', '/c', `"${removeLaterCmd(dirs)}"`];
/**
 * Starts the delayed delete detached. cwd = %SystemRoot%: cmd's working folder inside a folder it deletes
 * (uninstall run from the app folder) would lock it. → Promise<Error | null> (null = cmd.exe started).
 */
export function startRemoveLater(dirs, parent, { spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    try {
      const c = spawnFn(CMD, removeLaterArgs(dirs), { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, cwd: path.dirname(path.dirname(CMD)), env: { ...process.env, ...removeLaterEnv(dirs, parent) } });
      c.once('error', resolve); c.once('spawn', () => resolve(null)); c.unref();
    } catch (e) { resolve(e); }
  });
}

// Uninstall deletes only what Bridgerator itself creates there, then the folder if it is empty.
export const OUR_FILES = ['config.json', 'confirm.ini', 'queue.json', 'recent.jsonl', 'usage.json', 'bridge.log', 'bridge.log.1', 'run-hidden.vbs', 'confirm.approved', 'delegate.json'];
export function removeOurFiles(dir) {
  if (!fs.existsSync(dir)) return; // already gone: nothing to remove
  for (const n of OUR_FILES) fs.rmSync(path.join(dir, n), { force: true, maxRetries: 3 });
  fs.rmSync(path.join(dir, 'dc'), { recursive: true, force: true, maxRetries: 3 });   // the engine's own config folder
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* gone meanwhile */ }
  for (const n of names) if (/\.\d+\.tmp$/.test(n)) fs.rmSync(path.join(dir, n), { force: true });
  try { fs.rmdirSync(dir); } catch { /* something else is in there: left alone */ }
}

// Only a folder that is clearly ours is deleted: …\Bridgerator under APPDATA / LOCALAPPDATA, or one
// holding our config.json (custom BRIDGERATOR_HOME).
export function isOurDir(dir, roots = [APPDATA, LOCALAPPDATA]) {
  const d = path.resolve(dir);
  if (path.basename(d).toLowerCase() === 'bridgerator' && roots.some((r) => path.resolve(r).toLowerCase() === path.dirname(d).toLowerCase())) return true;
  try { const c = JSON.parse(fs.readFileSync(path.join(d, 'config.json'), 'utf8')); return !!(c.relay && c.token); } catch { return false; }
}

// OneDrive root: online-only placeholders would be downloaded by searches/listings.
// Nothing extra is excluded by default (owner 21.10: OneDrive too). An install from before kept
// exactly [OneDrive] as its default — that entry goes; a list the person changed stays.
const defaultDenied = () => [];
/** The setup summary's "excluded" line: only what really applies (sensitive folders only when that switch is on). */
export const excludedLine = (cfg) => [...(cfg.deniedDirectories || []), `built-in: Bridgerator's own folders${cfg.protectSensitive ? ', AppData, credentials (.ssh, .aws, …), Startup, PowerShell profiles' : ''}`].join(', ');
/** 'ru' when the Windows display language or regional format is Russian, else 'en'. */
// Node's Intl gives only the regional format: the display language comes from Windows, as in install.ps1.
const uiCulture = () => { try { return process.platform === 'win32' ? execFileSync(POWERSHELL, psArgs('[Globalization.CultureInfo]::CurrentUICulture.Name'), { stdio: 'pipe', timeout: 15000 }).toString().trim() : ''; } catch { return ''; } };
export function osLanguage(locales = [Intl.DateTimeFormat().resolvedOptions().locale, process.env.LANG], askWindows = arguments.length === 0) {
  const ru = (l) => /^ru([-_.]|$)/i.test(String(l || ''));
  return locales.some(ru) || (askWindows && ru(uiCulture())) ? 'ru' : 'en';
}
const keptDenied = (list) => (Array.isArray(list) && !(list.length === 1 && process.env.OneDrive && list[0].toLowerCase() === process.env.OneDrive.toLowerCase()) ? list : []);

async function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  // Before anything is created: the installer runs a fresh bridgerator.exe --version as its start check.
  if (cmd === 'version' || (!cmd && o.version === true)) { console.log(VERSION); return; }
  // Own folder as the working directory: no DLL / module lookups from wherever we were started.
  if (cmd !== 'uninstall') { fs.mkdirSync(DIR, { recursive: true }); process.chdir(DIR); } else process.chdir(home);

  if (cmd === 'setup' && o._[1] === 'done') {
    // The person skips the guided setup in ChatGPT (bridgerator_setup).
    const cfg = readConfig();
    if (!cfg) throw new Error(`not configured (${CONFIG})`);
    writeConfig({ ...cfg, setupDone: true });
    console.log('Guided setup marked as done.');
    return;
  }
  if (cmd === 'setup') {
    if (o.token === true) throw new Error('--token needs the device key from your Bridgerator account');
    // Checked before pairing: a typo must not cost a freshly confirmed key.
    for (const k of ['allow', 'deny', 'read-only', 'relay', 'language']) if (o[k] === true) throw new Error(`--${k} needs a value`);
    const language = o.language === undefined ? undefined : String(o.language).toLowerCase();
    if (language !== undefined && !['en', 'ru'].includes(language)) throw new Error('--language must be en or ru');
    let prev = readConfig() || {};
    const relay = checkRelay(o.relay || prev.relay || DEFAULT_RELAY);
    // --pair: get a new key through the browser even if one is configured. Without it, a stored key
    // the relay rejects (computer removed in the account) is replaced the same way; offline = keep it.
    // The running bridge keeps working until the new key is in hand.
    let paired = !o.token && (o.pair || !prev.token);
    if (!o.token && !paired && (await checkKey(siteOf(relay), prev.token)) === 'rejected') {
      console.log("This computer was removed from your account — let's connect it again.");
      paired = true;
    }
    // Pairing errors are plain messages for the person (code expired, too many attempts): exit 3, no stack.
    // A network / TLS failure is no clean stop: a plain error (exit 1), so the installer rolls back.
    const linked = paired ? await pair(siteOf(relay), os.hostname(), { fp: thisPcFp() }).catch((e) => {
      if (e instanceof TypeError || e?.name === 'AbortError' || e?.name === 'TimeoutError') throw new Error(`could not reach ${siteOf(relay)} (${e.cause?.code || e.message}) — check the internet connection and run the install command again`);
      e.friendly = true; throw e;
    }) : null;
    const token = o.token || (linked ? linked.token : prev.token);
    if (linked) console.log(`Confirmed — this computer is linked to ${linked.email ? `the account ${linked.email}` : 'your account'}.`);
    const abs = (list) => list.map((d) => path.resolve(CWD, d));
    const build = () => ({
      relay,
      token,
      // Empty = all folders (the always-blocked list still applies); a list = only those folders.
      allowedDirectories: o.allow ? abs(o.allow) : prev.allowedDirectories || [],
      // Added to the built-in exclusions (policy.builtinDenied), which can't be removed.
      deniedDirectories: o.deny ? abs(o.deny) : prev.deniedDirectories ? keptDenied(prev.deniedDirectories) : defaultDenied(),
      // "Protect sensitive folders" (policy.sensitiveDenied): off unless the person turned it on. Written
      // explicitly: the bridge and its settings-file watcher read a missing key as on.
      protectSensitive: prev.protectSensitive === true,
      // Readable, never changed by the file tools (the terminal is not bound by folders).
      readOnlyDirectories: o['read-only'] ? abs(o['read-only']) : prev.readOnlyDirectories || [],
      // blockedCommands: absent = the engine's own default list (format, diskpart, reg, net, sc, runas, …).
      ...(prev.blockedCommands ? { blockedCommands: prev.blockedCommands } : {}),
      disabledTools: prev.disabledTools || [],
      installId: prev.installId || crypto.randomUUID(),
      telemetryEnabled: o['no-telemetry'] ? false : prev.telemetryEnabled !== false,
      bridgeVersion: VERSION,
      setupDone: prev.setupDone === true, // set by bridgerator_setup (Apply on the PC) or `setup done`
      // Window language: the person's choice stays; a first config takes the installer's (Windows) language.
      language: prev.language || language || osLanguage(),
    });
    let cfg = build();
    try {
      stopRunning();
      // Pairing can take minutes while the old bridge runs, and it may save a setting while it stops:
      // built again from the file as it is now, so nothing the person changed meanwhile is lost.
      prev = readConfig() || prev; cfg = build();
      writeConfig(setupConfig(prev, cfg));
      restoreIni(INI);
      console.log(`config: ${CONFIG}`);
      console.log(`allowed:  ${cfg.allowedDirectories.length ? cfg.allowedDirectories.join(', ') : 'all folders (except the always-blocked ones)'}`);
      console.log(`excluded: ${excludedLine(cfg)}`);
      if (cfg.readOnlyDirectories.length) console.log(`read-only: ${cfg.readOnlyDirectories.join(', ')}`);
      console.log(`confirm:  ${readSettings(INI).enabled ? 'on' : 'off'} (a window on this PC before deletions / system commands; settings: ${INI}; bridgerator.cmd confirm on|off)`);
      if (!cfg.protectSensitive) console.log('protect sensitive folders: off (startup programs, PowerShell profiles, .ssh, cloud logins, AppData) — turn on in the Bridgerator window → Safety');
      console.log(installAutostart());
      startHidden();
    } catch (e) {
      try { startHidden(); } catch { /* no task yet */ } // the bridge that ran before keeps running
      throw e;
    }
    console.log(`started in background — log: ${LOG}`);
    console.log(`usage statistics: ${cfg.telemetryEnabled ? 'on (anonymous counts only; turn off: bridgerator.cmd telemetry off)' : 'off'}`);
    console.log('Next: in ChatGPT add the Bridgerator app and sign in with the same account.');
    if (!cfg.setupDone) console.log('Then open ChatGPT and say: Set up Bridgerator');
    const event = !prev.token ? 'install' : prev.bridgeVersion !== VERSION ? 'update' : null;
    if (event) await send(cfg, event);
    return;
  }
  if (cmd === 'run') {
    let cfg = readConfig();
    if (!cfg) throw new Error(`no config at ${CONFIG} — run the install command from ${ACCOUNT_URL}`);
    checkRelay(cfg.relay);
    // A config from before 21.10 has no protectSensitive: written as off (the new default), explicitly.
    if (typeof cfg.protectSensitive !== 'boolean') { cfg = { ...cfg, protectSensitive: false }; writeConfig(cfg); }
    restoreIni(INI);
    // The engine's on-disk call logs (arguments + output) are patched off; old ones are removed.
    for (const f of ['tool-history.jsonl', 'claude_tool_call.log']) fs.rmSync(path.join(DIR, 'dc', f), { force: true });
    // Tray helper first (its questions are instant); its menu / window requests go to the bridge.
    let dc = null, pauseTimer = null;
    const offlineLink = offlineWatch(() => {
      if (dc.linkState === 'online' || readConfig()?.notify?.offline === false) return false;
      showNotice({ kind: 'offline' }, log); return true;
    });
    const tray = startTray({
      log, account: accountUrlOf(cfg), webview: WEBVIEW_DIR,
      onMenu: (a, m) => {
        if (a === 'quit') { log('[bridgerator] quit from the tray (starts again at the next sign-in)'); tray?.close(); process.exit(0); }
        if (a === 'pause') dc?.setPaused(true, m.minutes);
        if (a === 'resume') dc?.setPaused(false);
        // confirm.ini held by another program (V-9): the state stays, the person is told.
        if (a === 'confirm') {
          trayConfirm(!!m.on, { ini: INI, dc, log });
          pushTray();
        }
      },
      onRpc: (m, p, paths) => { if (!dc) throw new Error('starting'); return dc.rpc(m, p, paths); },
      onPower: (pw) => { if (dc) dc.power = pw; },
    });
    // The tray mirrors the bridge: state dot, PC name, queue count, confirm, and the pay item / badge.
    const pushTray = () => {
      if (!tray || !dc) return;
      const b = dc.banner();
      tray.state({
        state: dc.paused ? 'paused' : dc.linkState, name: dc.cfgName?.() || dc.linkName, todo: dc.queue ? dc.queue.counts().todo : 0,
        confirm: dc.mode ? dc.mode().confirm : readSettings(INI).enabled ? 'on' : 'off', theme: dc.popup().theme, lang: dc.popup().lang, awake: dc.wantAwake(),
        plan: b.kind === 'none' ? null : { label: b.action === 'renew' ? 'Renew Pro…' : 'Upgrade to Pro…', url: b.url, badge: b.tone },
      });
    };
    dc = await startEngine({ ...cfg, dcConfigDir: path.join(DIR, 'dc'), configDir: DIR, confirmIni: INI, configFile: CONFIG, snapshotsDir: SNAP_DIR, scriptsDir: SCRIPTS_DIR }, log, { ask: tray ? (q) => tray.ask(q) : undefined });
    dc.cfgName = () => readConfig()?.deviceName;
    dc.openWindow = (page) => tray?.open(page);
    dc.onPlan = pushTray;
    dc.onLink = (state, name) => {
      dc.linkState = state; if (name) dc.linkName = name;
      offlineLink(state);
      pushTray();
    };
    dc.setPaused = (v, minutes) => {
      clearTimeout(pauseTimer);
      dc.paused = v; log(`[bridgerator] ${v ? `paused${minutes ? ` for ${minutes} min` : ''}` : 'resumed'}`);
      if (v && Number.isInteger(minutes) && minutes > 0 && minutes <= 24 * 60) pauseTimer = setTimeout(() => dc.setPaused(false), minutes * 60000);
      pushTray(); dc.onMode(dc.mode());
    };
    setInterval(pushTray, 5000).unref();
    // Window actions that need the CLI: autostart on/off, unlink, uninstall.
    dc.hooks = {
      autostart: (on) => execFileSync(SCHTASKS, ['/Change', '/TN', taskName(), on ? '/ENABLE' : '/DISABLE'], { stdio: 'pipe' }),
      unlink: async () => {
        const c = readConfig();
        if (c?.token) await revokeKey(c).catch((e) => log(`[bridgerator] could not remove this computer's key on the server (${e.message}) — remove the computer in your account`));
        const now = readConfig(); // read again after the network call: a change made meanwhile is kept
        if (now) writeConfig({ ...now, token: undefined });
        log('[bridgerator] unlinked from the Bridgerator window — run the install command to connect again');
        tray?.close(); process.exit(0);
      },
      uninstall: () => {
        spawn(process.execPath, [SELF, 'uninstall', '--all'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      },
    };
    connect({ ...cfg, usageFile: path.join(DIR, 'usage.json') }, dc, log);
    return;
  }
  if (cmd === 'doctor') {
    // What the link needs, in plain words with what to do (doctor.mjs). Exit 1 when something fails.
    let tn; try { tn = process.platform === 'win32' ? taskName() : undefined; } catch { /* doctor finds the task itself */ }
    const r = await runDoctor(readConfig(), { version: VERSION, running: process.platform === 'win32' ? isRunning() : undefined, taskName: tn, configDir: DIR });
    console.log(o.json ? JSON.stringify(r, null, 2) : formatDoctor(r));
    if (!r.ok) process.exitCode = 1;
    return;
  }
  if (cmd === 'stop') { stopRunning(); console.log('Bridgerator stopped (it starts again at the next logon).'); return; }
  if (cmd === 'status') {
    const cfg = readConfig();
    if (!cfg) { console.log(`Bridgerator is not set up on this PC — run the install command from ${ACCOUNT_URL}`); return; }
    let tail = [];
    try { tail = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean); } catch { /* no log yet */ }
    console.log(statusLine(isRunning(), tail));
    if (o.json) console.log(JSON.stringify({ ...cfg, token: `${String(cfg.token).slice(0, 4)}…` }, null, 2));
    else console.log(`settings: ${CONFIG}\nlog:      ${LOG}\n(details: bridgerator.cmd status --json)`);
    return;
  }
  if (cmd === 'confirm') {
    // confirm.ini is read on every call: no restart. `confirm on <category>` turns one check back on;
    // plain `confirm on` also brings back the default checks (deletions, system commands).
    const [, v, cat] = o._;
    if (!['on', 'off'].includes(v) || (cat && !CATEGORIES.includes(cat))) throw new Error(`usage: bridgerator.cmd confirm on|off [${CATEGORIES.join('|')}]`);
    restoreIni(INI);
    // `confirm off <category>`: only that check goes off, the window stays as it is.
    if (v === 'on' || !cat) setIni(INI, 'confirm', 'enabled', v === 'on' ? 'true' : 'false');
    if (v === 'on') for (const c of cat ? [cat] : ['delete', 'dangerous_commands']) setIni(INI, 'ask', c, 'true');
    else if (cat) setIni(INI, 'ask', cat, 'false');
    // Turning protection off from a script (not a console the person types in): the running bridge
    // applies it only after Apply in a notification on this PC.
    if (v === 'off' && !process.stdin.isTTY) console.log('Bridgerator asks on this PC before turning protection off — click Apply in the notification.');
    if (v === 'off' && cat) { console.log(`confirmations for ${cat} off (the window stays ${readSettings(INI).enabled ? 'on' : 'off'}) — settings: ${INI}`); return; }
    console.log(`confirmation window ${v}${v === 'on' ? ` (asks for: ${Object.entries(readSettings(INI).ask).filter(([, x]) => x).map(([k]) => k).join(', ') || 'nothing'})` : ''} — settings: ${INI}`);
    return;
  }
  if (cmd === 'telemetry' || cmd === 'read-only') {
    const cfg = readConfig();
    if (!cfg) throw new Error(`not configured (${CONFIG})`);
    const [, v, dir] = o._;
    let next;
    if (cmd === 'read-only') {
      if (!['add', 'remove'].includes(v) || !dir) throw new Error('usage: bridgerator.cmd read-only add|remove <folder>');
      const d = path.resolve(CWD, dir), list = (cfg.readOnlyDirectories || []).filter((x) => x.toLowerCase() !== d.toLowerCase());
      next = { ...cfg, readOnlyDirectories: v === 'add' ? [...list, d] : list };
      console.log(`read-only folders: ${next.readOnlyDirectories.join(', ') || '-'}`);
    } else {
      if (!['on', 'off'].includes(v)) throw new Error('usage: bridgerator.cmd telemetry on|off');
      next = { ...cfg, telemetryEnabled: v === 'on' };
      console.log(`usage statistics ${v}`);
    }
    writeConfig(next);
    // A running bridge picks the change up within seconds (its settings-file watcher); lowering
    // protection waits for Apply in a notification on this PC.
    if (isRunning()) console.log('The running Bridgerator applies this in a few seconds (turning protection off: click Apply in the notification on this PC).');
    return;
  }
  if (cmd === 'uninstall') {
    // uninstall --all: everything (THE uninstall for customers); --keep-config: keep key + folder settings.
    const cfg = readConfig();
    if (cfg) await send(cfg, 'uninstall');
    // Best effort: the relay forgets this device key, so a reinstall doesn't become "<name>-2".
    if (cfg?.token && !o['keep-config']) await revokeKey(cfg).catch((e) => console.log(`Could not remove this computer's key on the server (${e.message}) — remove the computer in your account (below).`));
    if (process.platform === 'win32') {
      try {
        ps([
          `Unregister-ScheduledTask -TaskName ${q(taskName())} -Confirm:$false -ErrorAction SilentlyContinue`,
          dropOldTaskPs(),
          "Remove-Item 'HKCU:\\Software\\Classes\\AppUserModelId\\Bridgerator' -Recurse -Force -ErrorAction SilentlyContinue",
        ].join('; '));
      } catch { /* not installed */ }
      // Scheduled automations (Task Scheduler \Bridgerator\) must not run after an uninstall, --keep-config too.
      const t = await removeTasks({ dir: SCRIPTS_DIR });
      if (t.removed || t.errors.length) console.log(`Scheduled automations removed: ${t.removed}${t.errors.length ? ` (not removed: ${t.errors.join('; ')})` : ''}`);
    }
    stopRunning();
    console.log('Bridgerator stopped, autostart removed.');
    if (!o['keep-config']) {
      if (isOurDir(DIR)) { removeOurFiles(DIR); console.log(`Removed Bridgerator's files from ${DIR} (device key, settings, task queue, engine data and history).`); }
      else console.log(`Not deleting ${DIR}: it doesn't look like a Bridgerator folder — remove it yourself if it is.`);
      // The automations' scripts and run logs (only a folder that is clearly ours: it has our runner / index).
      if (['automations.json', 'runner.ps1'].some((n) => fs.existsSync(path.join(SCRIPTS_DIR, n)))) fs.rmSync(SCRIPTS_DIR, { recursive: true, force: true, maxRetries: 3 });
      // The tray window's browser data and installer leftovers under %LOCALAPPDATA%\Bridgerator.
      // (+ the compiled helpers cache and a previous app folder an interrupted update left behind)
      try { for (const n of fs.readdirSync(path.join(LOCALAPPDATA, 'Bridgerator'))) if (n === 'webview' || n === 'snapshots' || n === 'cache' || /^tmp-[0-9a-f]{32}$/.test(n) || /^app\.old-[0-9a-f]{32}$/.test(n)) fs.rmSync(path.join(LOCALAPPDATA, 'Bridgerator', n), { recursive: true, force: true, maxRetries: 3 }); } catch { /* none */ }
    }
    const ownNode = fs.existsSync(path.join(NODE_DIR, 'node.exe'));
    const prog = programFiles();
    if (o.all) {
      console.log('Removing the program files...');
      // Folders this very process may run from (bridgerator.exe, node.exe): deleted a few seconds after we exit.
      const later = [];
      if (prog.exe) {
        try { ps(removeFromUserPathPs(prog.dir)); } catch { /* PATH left as is */ }
        if (prog.ours) later.push(prog.dir);
        else console.log(`This Bridgerator runs from ${prog.dir} — delete that folder yourself.`);
      } else {
        // The npm next to the node.exe running us is the one whose global folder holds this package.
        const npm = findNpm();
        if (!npm) console.log('Could not find npm.cmd next to node.exe or on the PATH — remove the package yourself: npm.cmd rm -g bridgerator');
        else try { execFileSync(CMD, ['/d', '/c', npm, 'rm', '-g', 'bridgerator', '--loglevel=error'], { stdio: 'inherit' }); } catch { console.log('Could not remove the npm package — run: npm.cmd rm -g bridgerator'); }
      }
      if (ownNode) {
        try { ps(removeFromUserPathPs(NODE_DIR)); } catch { /* PATH left as is */ }
        later.push(NODE_DIR);
        // npm's cache, only when the installer created it for that private Node.js (marker file).
        try {
          const cache = fs.readFileSync(path.join(LOCALAPPDATA, 'Bridgerator', 'created-npm-cache'), 'utf8').trim();
          if (cache && path.resolve(cache).toLowerCase() === path.join(LOCALAPPDATA, 'npm-cache').toLowerCase()) fs.rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
          fs.rmSync(path.join(LOCALAPPDATA, 'Bridgerator', 'created-npm-cache'), { force: true });
        } catch { /* not ours */ }
      }
      if (later.length) {
        // Reported only once cmd.exe has really started (a failed start says so).
        const e = await startRemoveLater(later, path.join(LOCALAPPDATA, 'Bridgerator'));
        if (e) console.log(`Could not remove ${later.join(', ')} (${e.message}) — delete ${later.length > 1 ? 'these folders' : 'this folder'} yourself.`);
        else for (const d of later) console.log(`${d === NODE_DIR ? 'The Node.js that Bridgerator installed' : 'The Bridgerator program folder'} (${d}) is removed in a few seconds.`);
      }
    } else if (prog.exe) {
      console.log('To remove the program files: bridgerator.cmd uninstall --all');
    } else {
      console.log('To remove the program files: npm.cmd rm -g bridgerator');
      if (ownNode) console.log(`and the Node.js that Bridgerator installed: Remove-Item -Recurse -Force '${NODE_DIR}'`);
      console.log('(or remove everything at once: bridgerator.cmd uninstall --all)');
    }
    console.log(`Also remove this computer in your account: ${accountUrlOf(cfg)}`);
    return;
  }
  console.log('usage: bridgerator.cmd setup [--token <key> | --pair] [--allow <dir>]... [--deny <dir>]... [--read-only <dir>]... [--language en|ru] [--no-telemetry] | run | stop | status | doctor [--json] | confirm on|off [category] | read-only add|remove <dir> | telemetry on|off | uninstall [--all | --keep-config] | --version');
}

// The hidden bridge has no console: its startup errors go to bridge.log too.
main().catch((e) => {
  if (e?.friendly) { console.log(`\n${e.message}`); process.exit(3); }
  const msg = `[bridgerator] ${e?.message || e}`;
  if (process.argv[2] === 'run') log(msg); else console.error(msg);
  process.exit(1);
});
