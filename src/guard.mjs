// LOGIC: see critical-logic/bridge.md ("Mass-action fuse", "Keep awake").
// Mass-action fuse (off by default): more than `limit` deletions / moves within a minute → the bridge
// pauses itself and asks on the PC whether to continue (no answer = stays paused).
export const FUSE_DEFAULTS = { enabled: false, limit: 20 };
export const FUSE_WINDOW_MS = 60000;

export function createFuse({ now = Date.now, windowMs = FUSE_WINDOW_MS } = {}) {
  let hits = [];                 // [{ t, n }]
  const count = () => { const from = now() - windowMs; hits = hits.filter((h) => h.t > from); return hits.reduce((s, h) => s + h.n, 0); };
  return {
    /** Would n more actions go over the limit? → the total (with them) or 0 when they fit. Counted only if they fit. */
    take(n, limit) {
      const total = count() + n;
      if (total > limit) return total;
      hits.push({ t: now(), n });
      return 0;
    },
    count,
    reset() { hits = []; },
  };
}

// Keep the PC awake (on by default, AC power only — the tray helper checks the power line): while a
// call runs, for 2 minutes after the last one, and for 10 minutes after it while the task queue has
// work (ChatGPT thinks between calls). A queue nobody works on does not keep the PC up for ever.
export const AWAKE_AFTER_MS = 2 * 60000, AWAKE_QUEUE_MS = 10 * 60000;
export function wantAwake({ enabled = true, inFlight = 0, lastCall = 0, queue = {}, now = Date.now() } = {}) {
  if (!enabled) return false;
  if (inFlight > 0) return true;
  if (!lastCall) return false;
  const idle = now - lastCall;
  if (idle < AWAKE_AFTER_MS) return true;
  return ((queue.todo || 0) + (queue.doing || 0)) > 0 && idle < AWAKE_QUEUE_MS;
}
