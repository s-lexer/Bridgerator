// Parent side of helpers/bridge-child.mjs: starts a real bridge process for a test PC with its own
// fake profile (USERPROFILE / APPDATA / LOCALAPPDATA in a temp folder, so the always-blocked folders
// and the config never touch the real profile), trusting only the test relay's certificate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHILD = fileURLToPath(new URL('./bridge-child.mjs', import.meta.url));

/**
 * opts: { relay, site?, pair?, name?, token?, allowedDirectories?, deniedDirectories?, readOnlyDirectories? }
 * cert: PEM of the test relay. onAsk(q) → key (or a Promise of it): the person at the PC.
 */
export function startBridgeChild(opts, { cert, root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-pc-')), onAsk = () => 'deny', onOpen } = {}) {
  const home = path.join(root, 'home');
  const env = { ...process.env, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') };
  delete env.NODE_TEST_CONTEXT; // the child is a bridge, not a test file
  for (const k of Object.keys(env)) if (/^(BR_|BRIDGERATOR_)/i.test(k)) delete env[k];
  fs.mkdirSync(env.APPDATA, { recursive: true }); fs.mkdirSync(env.LOCALAPPDATA, { recursive: true });
  const certFile = path.join(root, 'relay-cert.pem');
  fs.writeFileSync(certFile, cert);
  env.NODE_EXTRA_CA_CERTS = certFile;
  const optFile = path.join(root, 'opts.json');
  fs.writeFileSync(optFile, JSON.stringify({ configDir: path.join(env.APPDATA, 'Bridgerator'), ...opts }));
  const child = fork(CHILD, [optFile], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  const p = { child, root, home, env, events: [], logs: [], asks: [], notices: [], stderr: '' };
  const waiters = new Set();
  let rid = 0;
  const pendingRpc = new Map();
  child.stderr.on('data', (b) => { p.stderr += b; });
  child.stdout.on('data', () => {});
  child.on('message', async (m) => {
    p.events.push(m);
    if (m.ev === 'log') p.logs.push(m.line);
    if (m.ev === 'notice') p.notices.push(m);
    if (m.ev === 'open') onOpen?.(m.url);
    if (m.ev === 'ask') { p.asks.push(m.q); const key = await onAsk(m.q); child.send({ cmd: 'answer', id: m.id, key }); }
    if ((m.ev === 'rpc' || m.ev === 'resources') && pendingRpc.has(m.id)) { pendingRpc.get(m.id)(m); pendingRpc.delete(m.id); }
    for (const w of [...waiters]) w();
  });
  p.exited = new Promise((r) => child.on('exit', (code) => { p.exitCode = code; for (const w of [...waiters]) w(); r(code); }));
  /** Resolves when pred() is true (checked on every message), rejects after ms. */
  p.waitFor = (pred, what, ms = 30000) => new Promise((resolve, reject) => {
    const check = () => { try { const v = pred(); if (v) { waiters.delete(check); clearTimeout(t); resolve(v); } } catch (e) { reject(e); } };
    const t = setTimeout(() => { waiters.delete(check); reject(new Error(`bridge child: timed out waiting for ${what}\n${p.logs.slice(-15).join('\n')}\n${p.stderr.slice(-2000)}`)); }, ms);
    waiters.add(check); check();
  });
  p.online = () => p.waitFor(() => p.events.findLast?.((e) => e.ev === 'link')?.state === 'online', 'online');
  p.rpc = (method, params) => new Promise((r) => { const id = ++rid; pendingRpc.set(id, r); child.send({ cmd: 'rpc', id, method, params }); });
  p.resources = () => new Promise((r) => { const id = ++rid; pendingRpc.set(id, (m) => r(m.list)); child.send({ cmd: 'resources', id }); });
  p.stop = async () => {
    if (p.exitCode === undefined) { try { child.send({ cmd: 'exit' }); } catch { /* gone */ } }
    const t = setTimeout(() => child.kill(), 5000);
    await p.exited; clearTimeout(t);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
  return p;
}
