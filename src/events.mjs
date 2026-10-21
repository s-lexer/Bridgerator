// LOGIC: see critical-logic/bridge.md ("Relay notifications"). Events the bridge tells the relay so it
// can notify the person outside the chat (Telegram…): {type:'event', kind, …} with whole numbers only —
// never titles, names, paths, commands or output. At most 30 a minute (the rest are dropped, logged once).
// delegate_done {ok: 0|1}: a delegated agent run (delegate.mjs) that went on in the background has ended.
export const EVENT_KINDS = ['queue_done', 'task_failed', 'automation_failed', 'delegate_done'];
const FIELDS = ['n', 'code', 'failing', 'done', 'failed', 'ok'];
export const EVENTS_PER_MIN = 30;

/** → the message to send, or null (unknown kind). Non-integer fields are dropped. */
export function eventMessage(e) {
  if (!e || !EVENT_KINDS.includes(e.kind)) return null;
  const m = { type: 'event', kind: e.kind };
  for (const k of FIELDS) if (Number.isSafeInteger(e[k])) m[k] = e[k];
  return m;
}

/** take() → true while under `max` events in the last `windowMs`. */
export function createEventLimiter(max = EVENTS_PER_MIN, windowMs = 60000, now = Date.now) {
  let times = [];
  return { take() { const t = now(); times = times.filter((x) => t - x < windowMs); if (times.length >= max) return false; times.push(t); return true; } };
}
