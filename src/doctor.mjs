// LOGIC: see critical-logic/bridge.md ("Doctor"). `bridgerator doctor` (CLI) and the bridgerator_doctor
// tool: checks what the link to ChatGPT needs, each with a plain-words result and what to do.
// Every check has three outcomes plus a warning: ok / warn / fail / not_checked ("could not check" is
// never a silent ok). Windows facts come from one PowerShell run, read by registry values and enum
// numbers (any locale). Nothing here changes the PC; the WebSocket probe sends no key (a second link
// with this PC's key would take over the running one).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { checkKey, siteOf } from './pair.mjs';
import { psJson, json } from './tool-lib.mjs';

const MB = 1024 * 1024;
// Scheduled task state numbers (Microsoft.Management.Infrastructure CimInstance StateEnum).
const TASK_STATE = { 0: 'unknown', 1: 'disabled', 2: 'queued', 3: 'ready', 4: 'running' };

export const WIN_PS = String.raw`
$o = [ordered]@{}
$o.psVersion = $PSVersionTable.PSVersion.ToString()
$o.languageMode = [string]$ExecutionContext.SessionState.LanguageMode
$o.policies = @{}
foreach ($p in (Get-ExecutionPolicy -List)) { $o.policies[[string]$p.Scope] = [string]$p.ExecutionPolicy }
$o.webview2 = $null
foreach ($k in 'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}') {
  try { $pv = (Get-ItemProperty $k -ErrorAction Stop).pv; if ($pv -and $pv -ne '0.0.0.0') { $o.webview2 = [string]$pv; break } } catch {}
}
$task = $env:BRX_TASK
if (-not $task) { $task = 'Bridgerator-' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
try { $t = Get-ScheduledTask -TaskName $task -ErrorAction Stop; $o.task = @{ state = [int]$t.State } } catch {
  # Up to 1.0.7 one task name for every user of the PC.
  try { $t = Get-ScheduledTask -TaskName 'Bridgerator' -ErrorAction Stop; $o.task = @{ state = [int]$t.State; old = $true } } catch { $o.task = @{ missing = $true } }
}
$o.proxy = @{}
try {
  $i = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
  $o.proxy = @{ enabled = ([int]$i.ProxyEnable -eq 1); server = [string]$i.ProxyServer; pac = [string]$i.AutoConfigURL }
} catch {}
$o | ConvertTo-Json -Compress -Depth 4
`;

const R = (id, status, title, detail = '', fix = '') => ({ id, status, title, ...(detail ? { detail } : {}), ...(fix ? { fix } : {}) });

/** Network error → plain words + what to do (the cause, not the stack). */
export function netWhy(e) {
  const code = e?.cause?.code || e?.code || '';
  const name = e?.name || '';
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return ['no answer in time', 'Check the internet connection; a firewall or VPN may block the connection.'];
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return ['the server name could not be found (DNS)', 'Check the internet connection or DNS settings.'];
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return ['the connection was refused or cut', 'A firewall, antivirus or proxy may block it; try another network.'];
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)) return ['the secure connection was replaced by someone in between (certificate not trusted)', 'An antivirus "HTTPS scanning" or a company proxy inspects traffic: add bridgerator.recondeck.com to its exclusions.'];
  return [String(code || e?.message || e).slice(0, 120), 'Check the internet connection and try again.'];
}

const wsProbe = (url, timeout = 10000) => new Promise((resolve) => {
  let done = false;
  const ws = new WebSocket(url, { handshakeTimeout: timeout });
  const end = (r) => { if (done) return; done = true; try { ws.terminate(); } catch { /* closed */ } resolve(r); };
  ws.on('open', () => end({ ok: true }));
  ws.on('unexpected-response', (_q, res) => end({ ok: false, status: res.statusCode }));
  ws.on('error', (e) => end({ ok: false, error: e }));
  setTimeout(() => end({ ok: false, error: Object.assign(new Error('timeout'), { name: 'TimeoutError' }) }), timeout + 1000).unref?.();
});

const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };

/**
 * → { ok: boolean (no fail), results: [{ id, status, title, detail?, fix? }] }.
 * deps (tests): fetch, wsOpen(url), runPs, now(), statfs(dir), platform, nodeVersion, taskName, running (CLI), linkState (inside the bridge).
 */
export async function runDoctor(cfg, { version, fetch: f = globalThis.fetch, wsOpen = wsProbe, runPs, now = Date.now, statfs = (d) => fs.statfsSync(d), platform = process.platform, nodeVersion = process.versions.node, taskName, running, linkState, configDir } = {}) {
  const out = [];
  const major = Number(String(nodeVersion).split('.')[0]);
  out.push(major >= 22 ? R('node', 'ok', `Node.js ${nodeVersion}`) : R('node', 'fail', `Node.js ${nodeVersion} is too old`, 'Bridgerator needs Node.js 22 or newer.', 'Run the install command from https://bridgerator.recondeck.com/app again: it brings its own Node.js.'));

  // Bridge version vs the newest one on npm.
  try {
    const r = await f('https://registry.npmjs.org/bridgerator/latest', { signal: AbortSignal.timeout(10000) });
    const latest = String((await r.json()).version || '');
    out.push(!latest ? R('version', 'not_checked', `Bridgerator ${version}`, 'the update server gave no version')
      : newer(latest, version) ? R('version', 'warn', `Bridgerator ${version} — ${latest} is available`, '', 'Run the install command again to update (settings are kept).')
        : R('version', 'ok', `Bridgerator ${version} (latest)`));
  } catch (e) { out.push(R('version', 'not_checked', `Bridgerator ${version}`, `update check failed: ${netWhy(e)[0]}`)); }

  if (!cfg) {
    out.push(R('config', 'fail', 'Bridgerator is not set up on this PC', '', 'Run the install command from https://bridgerator.recondeck.com/app.'));
    return finish(out);
  }
  if (!cfg.token) out.push(R('key', 'fail', 'This PC has no Bridgerator key', 'It was unlinked or never paired.', 'Run the install command again and confirm the PC in the browser.'));

  let relay = null, site = null;
  try { relay = new URL(cfg.relay); site = siteOf(cfg.relay); } catch { out.push(R('relay', 'fail', 'The server address in the settings is broken', String(cfg.relay).slice(0, 80), 'Run the install command again.')); }

  if (relay) {
    // Relay reachable over HTTPS + the clock (TLS and sign-in break when the clock is far off).
    const health = `https://${relay.host}/healthz`;
    try {
      const t0 = now();
      const r = await f(health, { signal: AbortSignal.timeout(10000) });
      const ms = now() - t0;
      out.push(r.ok ? R('relay', 'ok', `Server reachable (${ms} ms)`) : R('relay', 'fail', `Server answered HTTP ${r.status}`, '', 'Try again in a few minutes; if it stays, write to support at https://bridgerator.recondeck.com/support.'));
      const date = Date.parse(r.headers?.get?.('date') || '');
      if (Number.isFinite(date)) {
        const skew = Math.round((now() - date) / 1000);
        out.push(Math.abs(skew) > 300 ? R('clock', 'fail', `The PC clock is off by ${Math.round(Math.abs(skew) / 60)} min`, 'Secure connections and sign-in can fail.', 'Windows Settings → Time & language → Date & time → "Set time automatically" → Sync now.')
          : R('clock', 'ok', `Clock in sync (${skew >= 0 ? '+' : ''}${skew} s)`));
      } else out.push(R('clock', 'not_checked', 'Clock', 'the server sent no time'));
    } catch (e) {
      const [why, fix] = netWhy(e);
      out.push(R('relay', 'fail', 'Server not reachable', why, fix));
      out.push(R('clock', 'not_checked', 'Clock', 'server not reachable'));
    }
    // WebSocket upgrade (proxies that pass HTTPS but drop WebSockets), without the key.
    const w = await wsOpen(cfg.relay).catch((e) => ({ ok: false, error: e }));
    if (w.ok || [401, 403, 400].includes(w.status)) out.push(R('websocket', 'ok', 'Live connection (WebSocket) works'));
    else if (w.status) out.push(R('websocket', 'fail', `Live connection refused (HTTP ${w.status})`, 'Something between this PC and the server blocks WebSockets.', 'A company proxy or antivirus web filter may block it: allow mcp.bridgerator.recondeck.com.'));
    else { const [why, fix] = netWhy(w.error); out.push(R('websocket', 'fail', 'Live connection (WebSocket) failed', why, fix)); }
    // Key still accepted?
    if (cfg.token && site) {
      const k = await checkKey(site, cfg.token, { fetch: f });
      out.push(k === 'ok' ? R('key', 'ok', 'This PC\'s key is accepted')
        : k === 'rejected' ? R('key', 'fail', 'This PC was removed from your account', 'The server no longer accepts its key.', 'Run the install command again and confirm the PC in the browser.')
          : R('key', 'not_checked', 'This PC\'s key', 'the server could not be asked'));
    }
  }
  if (linkState) out.push(linkState === 'online' ? R('link', 'ok', 'Connected to the server now') : R('link', 'warn', `Link state: ${linkState}`, '', 'It reconnects by itself; if it stays offline, see the checks above.'));
  if (running !== undefined) out.push(running ? R('running', 'ok', 'Bridgerator is running') : R('running', 'fail', 'Bridgerator is not running', '', 'Sign out and in again, or run the install command again.'));

  // Free disk space where Bridgerator keeps its files and on the system drive.
  const rootOf = (d) => (platform === 'win32' ? path.win32.parse(path.win32.resolve(d)).root.toUpperCase() : d);
  const dirs = [...new Map([configDir, platform === 'win32' ? `${process.env.SystemDrive || 'C:'}\\` : '/'].filter(Boolean).map((d) => [rootOf(d), d])).values()];
  for (const d of dirs) {
    try {
      const s = statfs(d);
      const free = Number(s.bavail) * Number(s.bsize);
      const label = platform === 'win32' ? rootOf(d).replace(/\\$/, '') : d;
      const gb = (free / 1024 / MB).toFixed(1);
      out.push(free < 200 * MB ? R(`disk ${label}`, 'fail', `Disk ${label} only ${Math.round(free / MB)} MB free`, '', 'Free some space (Settings → System → Storage).')
        : free < 1024 * MB ? R(`disk ${label}`, 'warn', `Disk ${label} ${gb} GB free`, 'Snapshots for Undo and updates need space.', 'Free some space soon.')
          : R(`disk ${label}`, 'ok', `Disk ${label} ${gb} GB free`));
    } catch (e) { out.push(R(`disk ${d}`, 'not_checked', `Disk ${d}`, String(e?.code || e?.message || e))); }
  }

  if (platform === 'win32') {
    let w = null;
    try { w = await psJson({ runPs }, { script: WIN_PS, env: { BRX_TASK: taskName || '' }, timeout: 30000 }); } catch (e) { out.push(R('powershell', 'fail', 'Windows PowerShell does not run', String(e?.message || e).slice(0, 160), 'Bridgerator needs Windows PowerShell 5.1 (part of Windows). Ask the PC administrator whether it is blocked.')); }
    if (w) {
      out.push(w.languageMode === 'FullLanguage' ? R('powershell', 'ok', `PowerShell ${w.psVersion}`)
        : R('powershell', 'warn', `PowerShell runs in ${w.languageMode} mode`, 'A company policy (AppLocker / WDAC) limits PowerShell: notifications, the tray window and some tools may not work.', 'Ask the PC administrator to allow Bridgerator.'));
      const gpo = ['MachinePolicy', 'UserPolicy'].map((k) => w.policies?.[k]).find((v) => v && v !== 'Undefined');
      out.push(gpo ? R('policy', 'warn', `Script policy set by the administrator: ${gpo}`, 'Bridgerator runs its scripts in a way this policy allows in most cases.', 'If notifications or the window do not appear, ask the administrator.')
        : R('policy', 'ok', `Script policy: ${w.policies?.CurrentUser && w.policies.CurrentUser !== 'Undefined' ? w.policies.CurrentUser : w.policies?.LocalMachine || 'default'} (fine — Bridgerator does not need it changed)`));
      out.push(w.webview2 ? R('webview2', 'ok', `Window component (WebView2) ${w.webview2}`) : R('webview2', 'warn', 'Window component (Microsoft WebView2) not installed', 'Bridgerator works; its window opens your account page instead.', 'Install "Microsoft Edge WebView2 Runtime" from microsoft.com, or run the install command again.'));
      {
        const st = w.task?.missing ? 'missing' : TASK_STATE[w.task?.state] || 'unknown';
        out.push((st === 'ready' || st === 'running') && w.task?.old ? R('autostart', 'warn', 'Starts with Windows (old-style task)', '', 'Run the install command again to update it.')
          : st === 'ready' || st === 'running' ? R('autostart', 'ok', 'Starts with Windows')
          : st === 'disabled' ? R('autostart', 'warn', 'Start with Windows is off', '', 'Turn it on in the Bridgerator window → Settings, or run the install command again.')
            : st === 'missing' ? R('autostart', 'fail', 'Start with Windows is not set up', '', 'Run the install command again.')
              : R('autostart', 'not_checked', 'Start with Windows', 'task state unknown'));
      }
      const p = w.proxy || {};
      const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
      if (p.enabled || p.pac) {
        const relayFail = out.some((x) => (x.id === 'relay' || x.id === 'websocket') && x.status === 'fail');
        out.push(R('proxy', relayFail ? 'fail' : 'warn', `A proxy is set in Windows${p.server ? ` (${String(p.server).slice(0, 60)})` : p.pac ? ' (automatic script)' : ''}`, 'Bridgerator connects directly, not through the Windows proxy.', relayFail ? 'Allow direct connections to mcp.bridgerator.recondeck.com (port 443) in the firewall / proxy.' : 'Nothing to do while the connection works.'));
      } else out.push(R('proxy', 'ok', envProxy ? 'Proxy from the environment is set (not used by Bridgerator)' : 'No proxy'));
    }
  }
  return finish(out);
}
const finish = (results) => ({ ok: !results.some((r) => r.status === 'fail'), results });

const MARK = { ok: '[ok]  ', warn: '[!]   ', fail: '[x]   ', not_checked: '[?]   ' };
/** Report for the console. */
export function formatDoctor({ ok, results }) {
  const lines = ['Bridgerator doctor', ''];
  for (const r of results) {
    lines.push(`${MARK[r.status]}${r.title}${r.detail ? ` — ${r.detail}` : ''}`);
    if (r.fix && r.status !== 'ok') lines.push(`      What to do: ${r.fix}`);
  }
  const bad = results.filter((r) => r.status === 'fail').length, warn = results.filter((r) => r.status === 'warn').length, nc = results.filter((r) => r.status === 'not_checked').length;
  lines.push('', ok ? `All needed checks passed${warn ? ` (${warn} warning${warn > 1 ? 's' : ''})` : ''}${nc ? `, ${nc} not checked` : ''}.` : `${bad} problem${bad > 1 ? 's' : ''} found — see "What to do" above.`);
  return lines.join(os.EOL);
}

// --- the tool --------------------------------------------------------------------------------
export const defs = [{
  name: 'bridgerator_doctor',
  title: 'Check the Bridgerator connection',
  description: 'Checks what the link between ChatGPT and this PC needs: Node.js, Bridgerator version, this PC\'s key, server and live connection, clock, proxy, PowerShell, the window component, start with Windows, free disk space. Each result has a plain explanation and what to do. Changes nothing.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: { action: { type: 'string', enum: ['check'], description: '"check" runs all checks' } } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}];

export async function handle(name, args, ctx) {
  const st = await ctx.rpc?.('getState').catch(() => null);
  const r = await runDoctor(ctx.cfg, { version: ctx.version, runPs: ctx.runPs, linkState: st?.state, configDir: ctx.cfg?.configDir, fetch: ctx.fetch, wsOpen: ctx.wsOpen });
  return json(r);
}
