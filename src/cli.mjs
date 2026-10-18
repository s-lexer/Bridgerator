#!/usr/bin/env node
// bridgerator setup --token <t> [--relay <wss url>] [--allow <dir>]... [--deny <dir>]...  → config + autostart + start
// bridgerator run | status | uninstall
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDesktopCommander, connect } from './bridge.mjs';

const DEFAULT_RELAY = 'wss://bridgerator.recondeck.com/link';
const TASK = 'Bridgerator';
const home = os.homedir();
const DIR = process.env.BRIDGERATOR_HOME || path.join(process.env.APPDATA || path.join(home, '.config'), 'Bridgerator');
const CONFIG = path.join(DIR, 'config.json');
const LOG = path.join(DIR, 'bridge.log');
const SELF = fileURLToPath(import.meta.url);

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2), v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { o[k] = true; continue; }
    i++;
    if (k === 'allow' || k === 'deny') (o[k] ||= []).push(v); else o[k] = v;
  }
  return o;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return null; }
}

function log(line) {
  const s = `${new Date().toISOString()} ${line}`;
  console.log(s);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 5e6) fs.renameSync(LOG, `${LOG}.1`);
    fs.appendFileSync(LOG, s + '\n');
  } catch { /* log dir not writable — console only */ }
}

// Hidden autostart at logon of THIS user (not SYSTEM): the assistant gets the user's rights only.
function installAutostart() {
  if (process.platform !== 'win32') return 'autostart: not Windows — start `bridgerator run` yourself';
  const vbs = path.join(DIR, 'run-hidden.vbs');
  const cmd = `"${process.execPath}" "${SELF}" run`;
  fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run "${cmd.replace(/"/g, '""')}", 0, False\r\n`);
  execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/RL', 'LIMITED', '/TN', TASK, '/TR', `wscript.exe "${vbs}"`], { stdio: 'pipe' });
  return vbs;
}

function stopRunning() {
  if (process.platform !== 'win32') return;
  // Only our own bridge processes: node.exe whose command line runs this cli with `run`.
  const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*bridgerator*cli.mjs*run*' -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  try { execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'pipe' }); } catch { /* none running */ }
}

function startHidden() {
  const vbs = path.join(DIR, 'run-hidden.vbs');
  if (process.platform === 'win32' && fs.existsSync(vbs)) spawn('wscript.exe', [vbs], { detached: true, stdio: 'ignore' }).unref();
  else spawn(process.execPath, [SELF, 'run'], { detached: true, stdio: 'ignore' }).unref();
}

async function main() {
  const o = parse(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === 'setup') {
    const prev = readConfig() || {};
    const token = o.token || prev.token;
    if (!token || token === true) throw new Error('setup needs --token <device key from your Bridgerator account>');
    const cfg = {
      relay: o.relay || prev.relay || DEFAULT_RELAY,
      token,
      allowedDirectories: o.allow || prev.allowedDirectories || [home],
      deniedDirectories: o.deny || prev.deniedDirectories || [path.join(home, '.ssh'), path.join(home, 'AppData')],
      blockedCommands: prev.blockedCommands || ['format', 'diskpart', 'bcdedit', 'shutdown', 'reg delete', 'vssadmin delete'],
      disabledTools: prev.disabledTools || [],
    };
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
    // Desktop Commander keeps ONE config per Windows user; ours overwrites its folder limits on start.
    const dcCfg = path.join(home, '.claude-server-commander', 'config.json');
    if (fs.existsSync(dcCfg) && !fs.existsSync(`${dcCfg}.before-bridgerator`)) {
      fs.copyFileSync(dcCfg, `${dcCfg}.before-bridgerator`);
      console.log(`backup of your existing Desktop Commander config: ${dcCfg}.before-bridgerator`);
    }
    console.log(`config: ${CONFIG}`);
    console.log(`allowed:  ${cfg.allowedDirectories.join(', ')}`);
    console.log(`excluded: ${cfg.deniedDirectories.join(', ') || '-'}`);
    console.log(installAutostart() ? `autostart: scheduled task "${TASK}" (at logon, hidden)` : '');
    stopRunning();
    startHidden();
    console.log(`started in background — log: ${LOG}`);
    console.log('Next: in ChatGPT add the connector https://bridgerator.recondeck.com/mcp and sign in.');
    return;
  }
  if (cmd === 'run') {
    const cfg = readConfig();
    if (!cfg) throw new Error(`no config at ${CONFIG} — run: bridgerator setup --token <device key>`);
    const dc = await startDesktopCommander(cfg, log);
    connect(cfg, dc, log);
    return;
  }
  if (cmd === 'status') {
    const cfg = readConfig();
    if (!cfg) { console.log(`not configured (${CONFIG})`); return; }
    console.log(JSON.stringify({ ...cfg, token: `${String(cfg.token).slice(0, 4)}…` }, null, 2));
    try { console.log('--- log tail ---\n' + fs.readFileSync(LOG, 'utf8').split('\n').slice(-8).join('\n')); } catch { console.log('no log yet'); }
    return;
  }
  if (cmd === 'uninstall') {
    stopRunning();
    try { execFileSync('schtasks', ['/Delete', '/F', '/TN', TASK], { stdio: 'pipe' }); } catch { /* not installed */ }
    console.log(`stopped and autostart removed. Config kept at ${CONFIG}. Remove the package: npm rm -g bridgerator`);
    return;
  }
  console.log('usage: bridgerator setup --token <key> [--allow <dir>]... [--deny <dir>]... | run | status | uninstall');
}

main().catch((e) => { console.error(`[bridgerator] ${e?.message || e}`); process.exit(1); });
