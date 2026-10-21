// Anonymous usage counts to Bridgerator (disclosed on the privacy page; off with
// `bridgerator.cmd telemetry off`, "telemetryEnabled": false in config.json, or install -NoTelemetry).
// Only these fields: random install id, bridge version, Windows version, OS language, Node.js
// version, and in the daily heartbeat per-tool call / error counts. Never paths, file names,
// commands, arguments, outputs, e-mail. HTTPS only; any failure is silent.
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { writeAtomic } from './confirm.mjs';

export const TELEMETRY_URL = 'https://bridgerator.recondeck.com/t';
export const VERSION = createRequire(import.meta.url)('../package.json').version;
const DAY = 24 * 3600 * 1000;
const READ_FAILS_MAX = 3; // hourly ticks

export const enabled = (cfg) => !!cfg?.installId && cfg.telemetryEnabled !== false;

export function payload(cfg, event, extra = {}) {
  let lang = '';
  try { lang = Intl.DateTimeFormat().resolvedOptions().locale; } catch { /* none */ }
  return { event, id: cfg.installId, version: VERSION, os: `${os.platform()} ${os.release()}`, lang, node: process.version, ...extra };
}

export async function send(cfg, event, extra, { fetch: f = globalThis.fetch } = {}) {
  if (!enabled(cfg)) return;
  try {
    await f(TELEMETRY_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload(cfg, event, extra)), signal: AbortSignal.timeout(10000) });
  } catch { /* offline: nothing */ }
}

// Per-tool counters for the heartbeat. `known` = the engine's tool names: a name the relay made up
// is never counted (only our own fixed tool names leave the PC). State survives restarts in `file`.
export function usage(cfg, known, file, { now = Date.now, sendFn = send } = {}) {
  const fresh = () => ({ since: now(), calls: {}, errors: {} });
  // Only a missing file (ENOENT) or an unparsable / wrong-shape one = fresh (rewritten at the next save),
  // so one bad usage.json never stops counting for good. Any other read error (a lock of antivirus /
  // backup, EIO, EMFILE, EISDIR...) throws — the caller keeps its in-memory state and retries next tick;
  // after READ_FAILS_MAX failed ticks in a row it goes on from memory (rewrites the file, the heartbeat
  // goes), so a permanently unreadable file never stops telemetry. Only since / calls / errors are kept;
  // a counter that is not a non-negative safe integer is dropped.
  const load = () => {
    let txt;
    try { txt = fs.readFileSync(file, 'utf8'); } catch (e) { if (e?.code === 'ENOENT') return fresh(); throw e; }
    let j; try { j = JSON.parse(txt); } catch { return fresh(); }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return fresh();
    const obj = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' && !Array.isArray(o) ? o : {}).filter(([, n]) => Number.isSafeInteger(n) && n >= 0));
    return { since: Number.isFinite(j.since) ? j.since : now(), calls: obj(j.calls), errors: obj(j.errors) };
  };
  let st; try { st = load(); } catch { st = fresh(); }
  // Counted since the last save: added to what is in the file then (another bridge process may have
  // saved meanwhile — no last-writer-wins), written atomically (temp + rename).
  let delta = { calls: {}, errors: {} };
  const add = (to, from) => { for (const [k, n] of Object.entries(from)) to[k] = (to[k] || 0) + n; };
  const write = () => { try { writeAtomic(file, JSON.stringify(st)); } catch { /* read-only */ } };
  let fails = 0;
  const save = () => {
    let disk;
    try { disk = load(); fails = 0; } catch { // locked now: keep st + delta, retry next tick
      if (++fails < READ_FAILS_MAX) return false;
      fails = 0; delta = { calls: {}, errors: {} }; write(); return true; // still unreadable: go on from memory
    }

    add(disk.calls, delta.calls); add(disk.errors, delta.errors);
    delta = { calls: {}, errors: {} };
    st = disk;
    write();
    return true;
  };
  return {
    count(name, isError) {
      if (!known.has(name)) return;
      st.calls[name] = (st.calls[name] || 0) + 1;
      delta.calls[name] = (delta.calls[name] || 0) + 1;
      if (isError) { st.errors[name] = (st.errors[name] || 0) + 1; delta.errors[name] = (delta.errors[name] || 0) + 1; }
    },
    async tick() {
      if (!save()) return;
      if (now() - st.since < DAY) return;
      const { calls, errors } = st;
      st = fresh();
      write();
      await sendFn(cfg, 'heartbeat', { calls, errors });
    },
    state: () => st,
  };
}
