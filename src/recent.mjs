// "Recent on this PC": the last 100 tool calls WITH their command / path, for the person at the PC.
// In memory; with "Keep a local history" on also in %APPDATA%\Bridgerator\recent.jsonl (inside the
// always-excluded folder), entries older than 7 days dropped. Never sent to the server.
import fs from 'node:fs';

export const KEEP = 100;
export const DAYS = 7;
const short = (s, n = 300) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

export function target(a = {}) {
  if (!a || typeof a !== 'object') return '';
  if (a.source && a.destination) return short(`${a.source} → ${a.destination}`);
  const t = a.command ?? a.input ?? a.path ?? a.file_path ?? (Array.isArray(a.paths) ? a.paths.join(', ') : undefined) ?? a.pattern ?? a.title ?? a.id;
  return t === undefined ? '' : short(typeof t === 'string' ? t : JSON.stringify(t));
}

export function createRecent(file, { keepFile = false, now = Date.now } = {}) {
  let list = [], keep = keepFile;
  const fresh = (e) => now() - e.t < DAYS * 86400000;
  const prune = () => {
    if (!keep) return;
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      const ok = lines.filter((l) => { try { return fresh(JSON.parse(l)); } catch { return false; } });
      if (ok.length !== lines.length || ok.length > KEEP * 10) fs.writeFileSync(file, ok.slice(-KEEP * 10).join('\n') + (ok.length ? '\n' : ''));
    } catch { /* no file */ }
  };
  if (keep) { prune(); try { list = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter(fresh).slice(-KEEP); } catch { /* none */ } }
  let lastPrune = now();
  return {
    record(name, args, outcome, extra) {
      const e = { t: now(), tool: String(name), target: target(args), outcome, ...(extra && typeof extra === 'object' ? extra : {}) };
      list.push(e); if (list.length > KEEP) list.shift();
      if (keep) {
        try { fs.appendFileSync(file, JSON.stringify(e) + '\n'); } catch { /* read-only */ }
        if (now() - lastPrune > 86400000) { lastPrune = now(); prune(); }
      }
      return e;
    },
    list: () => [...list].reverse(),
    clear() { list = []; try { fs.rmSync(file, { force: true }); } catch { /* none */ } },
    setKeep(v) { keep = !!v; if (!keep) { try { fs.rmSync(file, { force: true }); } catch { /* none */ } } else for (const e of list) try { fs.appendFileSync(file, JSON.stringify(e) + '\n'); } catch { /* */ } },
    get keep() { return keep; },
  };
}

/** Result of a call → ok | error | refused | not confirmed | paused. */
export const outcomeOf = (r) => (r?.paused ? 'paused' : r?.notConfirmed ? 'not confirmed' : r?.refused ? 'refused' : r?.isError ? 'error' : 'ok');
