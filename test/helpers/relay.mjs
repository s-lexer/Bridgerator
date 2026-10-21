// Test helper: the REAL relay (sibling repo bridgerator-relay) started in this process over https/wss
// with a throwaway certificate and a temporary store — hub (/link), MCP (/mcp), OAuth and the cabinet
// pairing pages. Plus a minimal "ChatGPT" MCP client. No network beyond 127.0.0.1.
// When the relay repo is not next to this one, relayMissing() says why and the callers skip loudly
// (engineering-process §2.2: a missing relay is NOT CHECKED, never a pass).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RELAY_DIR = path.resolve(process.env.BRIDGERATOR_RELAY_DIR || fileURLToPath(new URL('../../../bridgerator-relay/', import.meta.url)));

/** → null when the relay can be started here, otherwise the reason (for a loud skip). */
export function relayMissing() {
  for (const f of ['src/hub.js', 'src/store.js', 'src/mcp.js', 'src/oauth.js', 'src/cabinet.js', 'node_modules/express', 'node_modules/ws']) {
    if (!fs.existsSync(path.join(RELAY_DIR, f))) return `NOT CHECKED: relay repo not found or not installed (${path.join(RELAY_DIR, f)} missing) — put bridgerator-relay next to this repo and run npm install there`;
  }
  return null;
}

const imp = (rel) => import(pathToFileURL(path.join(RELAY_DIR, rel)).href);
const b64url = (b) => Buffer.from(b).toString('base64url');
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';

/**
 * Starts the relay. tls = { key, cert }. → { base, wsUrl, store, hub, srv, sockets(), close(), token(user, pw),
 * mcp(token, method, params), callTool(token, name, args), confirmPair(email, pw, code) }
 */
export async function startRelay({ tls, callTimeoutMs } = {}) {
  const [{ openStore }, { createHub }, { handleMcp }, { createOauthRouter, bearerUser }, { createCabinet }, { createBilling }] = await Promise.all(
    ['src/store.js', 'src/hub.js', 'src/mcp.js', 'src/oauth.js', 'src/cabinet.js', 'src/billing.js'].map(imp));
  const express = createRequire(path.join(RELAY_DIR, 'package.json'))('express');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-relay-'));
  const store = openStore(path.join(dir, 'store.json'));
  const hub = createHub(store, callTimeoutMs ? { callTimeoutMs } : {});
  const srv = https.createServer({ key: tls.key, cert: tls.cert });
  const open = new Set();
  const links = new Set(); // the PCs' WebSocket connections (upgraded), not the MCP / page requests
  srv.on('secureConnection', (s) => { open.add(s); s.on('close', () => open.delete(s)); });
  srv.on('upgrade', (_req, s) => { links.add(s); s.on('close', () => links.delete(s)); });
  hub.attach(srv, '/link');
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `https://localhost:${srv.address().port}`;
  const env = { ISSUER: base, SITE_URL: base, OAUTH_SECRET: `test-${crypto.randomBytes(16).toString('hex')}` };
  const app = express();
  app.set('trust proxy', 1);
  app.use('/', createCabinet(store, hub, createBilling(store, {}, { fetch: async () => { throw new Error('no network in tests'); } }), env));
  app.use('/', createOauthRouter(store, env, () => {}));
  app.all('/mcp', express.json({ limit: '4mb' }), (req, res) => {
    const c = bearerUser(store, env, req);
    if (!c) return res.status(401).json({ error: 'invalid_token' });
    handleMcp(hub, c.sub, req, res).catch(() => { if (!res.headersSent) res.status(500).end(); });
  });
  srv.on('request', app);

  const form = (o) => new URLSearchParams(o).toString();
  async function token(user, pw) {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const p = { response_type: 'code', client_id: 'wc-test', redirect_uri: REDIRECT, state: 's', code_challenge: challenge, code_challenge_method: 'S256', resource: `${base}/mcp` };
    const a = await fetch(`${base}/authorize`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ ...p, username: user, password: pw }) });
    if (a.status !== 302) throw new Error(`authorize: HTTP ${a.status}`);
    const code = new URL(a.headers.get('location')).searchParams.get('code');
    const t = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: 'wc-test', code_verifier: verifier }) });
    return (await t.json()).access_token;
  }
  let rid = 0;
  async function mcp(tok, method, params = {}) {
    const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }) });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`mcp ${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse((text.split('\n').find((l) => l.startsWith('data: ')) || `data: ${text}`).slice(6));
  }
  const callTool = async (tok, name, args = {}) => (await mcp(tok, 'tools/call', { name, arguments: args })).result;
  // The account owner confirms a pairing code in the browser: signs in, then POSTs /pair (same Origin).
  async function confirmPair(email, pw, code) {
    if (!store.getUser(email)) await store.createUser(email, pw);
    const li = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base }, body: form({ email, password: pw }) });
    const cookie = (li.headers.get('set-cookie') || '').split(';')[0];
    if (!cookie) throw new Error(`login: HTTP ${li.status}`);
    const r = await fetch(`${base}/pair`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, cookie }, body: form({ code }) });
    if (r.status !== 200) throw new Error(`pair confirm: HTTP ${r.status}`);
  }
  return {
    base, wsUrl: `wss://localhost:${srv.address().port}/link`, store, hub, srv, dir, token, mcp, callTool, confirmPair,
    /** Drops every PC link at once (network gone / relay restart); MCP requests and the server stay. */
    dropAll: () => { for (const s of links) s.destroy(); },
    close: async () => {
      for (const s of open) s.destroy();
      await new Promise((r) => srv.close(r));
      store.close?.(); // SQLite store keeps the db file open (EPERM on Windows)
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Text of an MCP tool result. */
export const textOf = (r) => (r?.content || []).map((c) => c.text).join('\n');
