// Key-less setup: ask the relay for a pairing code, open the confirmation page in the browser, wait
// until the signed-in owner confirms this computer there, and get this PC's device key back.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { CMD } from './win.mjs';

// wss://mcp.bridgerator.recondeck.com/link → https://bridgerator.recondeck.com (the site host, where the account pages live).
export const siteOf = (relay) => { const u = new URL(relay); return `${u.protocol === 'ws:' ? 'http' : 'https'}://${u.host.replace(/^mcp\./, '')}`; };

// Opens the URL in the default browser. Only a URL we checked ourselves reaches cmd's `start`.
export function openBrowser(url) {
  if (!/^https:\/\/[A-Za-z0-9.:-]+\/pair\?code=[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(url)) return;
  try {
    const p = process.platform === 'win32'
      ? spawn(CMD, ['/d', '/c', `start "" "${url}"`], { windowsHide: true, windowsVerbatimArguments: true, stdio: 'ignore', detached: true })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* no browser: the URL is printed */ }
}

/** → { token, name, email? } once the owner confirmed; throws when the code expires. */
/**
 * This PC + this Windows user, as a one-way fingerprint: sha256 hex of MachineGuid + user SID. Lets
 * the relay replace an offline PC of the same name only when it is really the same machine/user.
 * The raw values never leave the PC. → '' when either is unknown.
 */
export function machineFp(machineGuid, sid) {
  const g = String(machineGuid || '').trim().toLowerCase(), u = String(sid || '').trim().toUpperCase();
  if (!/^[0-9a-f-]{32,36}$/.test(g) || !/^S-1-[\d-]+$/.test(u)) return '';
  return crypto.createHash('sha256').update(`${g}|${u}`).digest('hex');
}

// The key travels over these requests: https only (the same "wss only" rule as the link itself);
// plain http only to this PC itself (loopback: local tests, a relay on the same machine).
const needHttps = (site) => {
  const s = String(site || '');
  if (/^https:\/\/[^\s/]+/i.test(s) || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(s)) return;
  throw new Error(`the server address must be https://, got "${site}"`);
};

export async function pair(site, name, { fp = '', fetch: f = globalThis.fetch, open = openBrowser, log = console.log, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), everyMs = 3000 } = {}) {
  needHttps(site);
  const post = (path, body) => f(`${site}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const r = await post('/pair/start', { name, ...(fp ? { fp } : {}) });
  if (!r.ok) throw new Error(`could not start pairing (HTTP ${r.status}) — try again in a minute`);
  const s = await r.json();
  const url = `${site}/pair?code=${s.code}`;
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(String(s.code)) || typeof s.poll !== 'string') throw new Error('unexpected answer from the relay');
  log('');
  log(`  Confirm this computer in your browser:  ${url}`);
  log(`  Code: ${s.code}   (check that the page shows the same code)`);
  log('');
  open(url);
  log('Waiting for the confirmation (up to 15 minutes)...');
  const until = Date.now() + (Number(s.expiresIn) || 900) * 1000;
  while (Date.now() < until) {
    await sleep(everyMs);
    let p;
    try { p = await post('/pair/poll', { poll: s.poll }); } catch { continue; } // network blip: try again
    if (p.status === 200) { const j = await p.json(); if (j.token) return { token: j.token, name: j.name || name, ...(typeof j.email === 'string' ? { email: j.email } : {}) }; }
    if (p.status === 410) break;
    if (p.status === 404) throw new Error('this pairing code is no longer valid — run the install command again');
    if (p.status === 429) throw new Error('too many attempts — wait a few minutes, then run the install command again');
  }
  throw new Error('the code expired before it was confirmed — run the command again');
}

/** Is the stored device key still accepted? → 'ok' | 'rejected' (computer removed in the account) | 'unknown' (network). */
export async function checkKey(site, token, { fetch: f = globalThis.fetch } = {}) {
  try {
    needHttps(site);
    const r = await f(`${site}/pair/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), signal: AbortSignal.timeout(15000) });
    if (r.status === 401) return 'rejected';
    if (r.status === 200 && (await r.json().catch(() => ({}))).ok === true) return 'ok';
  } catch { /* offline: keep the key */ }
  return 'unknown';
}
