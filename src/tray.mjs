// The tray helper (tray.ps1, one hidden PowerShell per bridge) and the JSON-lines link to it:
// icon + menu (Pause / Resume / Quit), the questions on the PC (toast / fallback window, already
// loaded → instant) and the requests of its window (rpc → handled in the bridge, rpc.mjs).
import os from 'node:os';
import readline from 'node:readline';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POWERSHELL } from './win.mjs';
import { runFilesPs, askOnPc, stripOurs } from './ask.mjs';
import { localizeAsk, attrLine } from './pc-text.mjs';

const LIB = fileURLToPath(new URL('./ask-lib.ps1', import.meta.url));
const TRAY = fileURLToPath(new URL('./tray.ps1', import.meta.url));
export const PKG_DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');

/**
 * The protocol, without the process: `write(line)` sends to the helper; feed helper lines to
 * `onLine`. onMenu(action), onRpc(method, params, paths) → Promise<result>.
 */
export function createLink(write, { onMenu = () => {}, onRpc = async () => null, onLog = () => {}, onPower = () => {}, now = Date.now, setTimer = setTimeout } = {}) {
  let ready = false, seq = 0;
  const waiting = new Map(); // id → { resolve, keys, timer }
  const send = (o) => write(`${JSON.stringify(o)}\n`);
  const finish = (id, key) => { const w = waiting.get(id); if (!w) return; waiting.delete(id); clearTimeout(w.timer); w.resolve(w.keys.includes(key) ? key : 'deny'); };
  return {
    get ready() { return ready; },
    onLine(line) {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.t === 'ready') ready = true;
      else if (m.t === 'log' && typeof m.msg === 'string') onLog(m.msg.slice(0, 2000));
      // Keep-awake as the helper applied it: on = holding the PC awake, ac = on mains power.
      else if (m.t === 'power') onPower({ on: m.on === true, ac: m.ac !== false });
      else if (m.t === 'answer' && typeof m.id === 'string') finish(m.id, String(m.key));
      else if (m.t === 'menu' && ['pause', 'resume', 'quit', 'confirm'].includes(m.action)) onMenu(m.action, { minutes: Number.isInteger(m.minutes) ? m.minutes : undefined, on: m.on === true });
      else if (m.t === 'rpc' && typeof m.id === 'string' && typeof m.method === 'string') {
        Promise.resolve().then(() => onRpc(m.method, m.params ?? {}, Array.isArray(m.paths) ? m.paths.filter((p) => typeof p === 'string') : []))
          .then((result) => send({ t: 'rpc-result', id: m.id, result: result ?? null }), (e) => send({ t: 'rpc-result', id: m.id, error: String(e?.message || e) }));
      }
    },
    state: (o) => send({ t: 'state', ...o }),
    open: (page) => send({ t: 'open', page }),
    /** Same contract as askOnPc → the chosen key, 'deny' on timeout / no helper. */
    ask(q0) {
      // The PC's language (V-3): fixed texts, buttons and the "auto-deny in 2 min" line.
      const { head, text, buttons, secs = 120, host = os.hostname(), auto = 'auto-deny', theme = 'system', silent = false, style = 'toast', lang = 'en' } = localizeAsk({ ...q0, auto: q0.auto || 'auto-deny' }, q0.lang);
      const id = `a${++seq}-${now().toString(36)}`;
      const attr = attrLine(host, auto, secs, lang);
      return new Promise((resolve) => {
        const timer = setTimer(() => finish(id, 'deny'), (secs + 15) * 1000);
        waiting.set(id, { resolve, keys: buttons.map((b) => b[0]), timer });
        send({ t: 'ask', id, head, detail: text, attr, host, auto, secs, theme, silent, style, buttons, lang: lang === 'ru' ? 'ru' : 'en' });
      });
    },
    lost() { ready = false; for (const id of [...waiting.keys()]) finish(id, 'deny'); },
  };
}

/** Starts the helper (Windows only) and keeps it running while the bridge runs. → link-like object. */
export function startTray({ log = console.log, onMenu, onRpc, onPower, spawn = nodeSpawn, stderr = 'ignore', testEnv = {}, account = '', webview = '' } = {}) {
  if (process.platform !== 'win32') return null;
  let child = null, link = null, closing = false, restartTimer = null;
  // Our own variables only: BR_* / BRIDGERATOR_* from the environment are ignored (a test harness
  // passes its hooks explicitly as testEnv).
  // BR_ACCOUNT: the account page of the site this PC is linked to (a staging install opens staging; V-5).
  const env = { ...stripOurs(process.env), ...testEnv, BR_PARENT: String(process.pid), BR_PKG: PKG_DIR, ...(webview ? { BR_WEBVIEW: webview } : {}), ...(/^https:\/\/[a-z0-9.-]+(:\d+)?\/app$/i.test(account) ? { BR_ACCOUNT: account } : {}) };
  const start = () => {
    // Plain -Command (not encoded): its command line names the package folder, so the one process
    // matcher (stop / update / uninstall) finds the helper too.
    child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', runFilesPs(LIB, TRAY)], { env, stdio: ['pipe', 'pipe', stderr], windowsHide: true });
    const c = child;
    // An EPIPE after the helper died is an 'error' event on the stream: without a listener it would crash the bridge.
    c.stdin?.on('error', () => {});
    link = createLink((l) => { try { c.stdin.write(l); } catch { /* gone */ } }, { onMenu, onRpc, onPower, onLog: (msg) => log(`[bridgerator] ${msg}`) });
    readline.createInterface({ input: child.stdout }).on('line', (l) => link.onLine(l));
    child.on('error', (e) => log(`[bridgerator] tray: ${e.message}`));
    child.on('exit', (code) => {
      link.lost();
      if (!closing) { log(`[bridgerator] tray helper stopped (${code}); restarting in 30 s`); restartTimer = setTimeout(() => { restartTimer = null; if (!closing) start(); }, 30000); restartTimer.unref(); }
    });
  };
  start();
  // Questions go through the helper when it is up, otherwise one PowerShell per question.
  return {
    get ready() { return !!link?.ready; },
    get pid() { return child?.pid; },
    ask: (q) => (link?.ready ? link.ask(q) : askOnPc(q)),
    state: (o) => link?.state(o),
    open: (page) => link?.open(page),
    // 'exit' + closing stdin let the helper hide + dispose its tray icon itself (a kill leaves a ghost icon); the kill is the fallback.
    close: () => {
      closing = true; clearTimeout(restartTimer);
      try { child?.stdin?.write('{"t":"exit"}\n'); } catch { /* gone */ }
      try { child?.stdin?.end(); } catch { /* gone */ }
      const c = child; const t = setTimeout(() => { try { c?.kill(); } catch { /* gone */ } }, 2000); t.unref();
    },
  };
}
