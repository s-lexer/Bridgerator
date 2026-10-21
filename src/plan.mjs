// The plan as the relay reports it ({type:'plan', plan, until?, calls, limit, month, renewUrl}) →
// what the Bridgerator window, the tray and our notifications show. Paying is offered only here on
// the PC (never inside ChatGPT). Links: only our own site.
export const ACCOUNT_URL = 'https://bridgerator.recondeck.com/app';
const DAY = 86400000;
// Our site = the one this PC is linked to (derived from the relay address: staging stays on staging).
const PROD = 'https://bridgerator.recondeck.com';
let site = PROD;
/** Sets the site (https origin only; anything else keeps the previous one). */
export function setSite(s) {
  try { const x = new URL(String(s)); if (x.protocol === 'https:' && !x.username && !x.password) site = x.origin; } catch { /* keep */ }
}
export const siteUrl = () => site;
export const accountUrl = () => `${site}/app`;

/** Only https://<our site>/… — anything else falls back to the account page. */
export function safeUrl(u) {
  try { const x = new URL(String(u)); if (x.protocol === 'https:' && (x.origin === site || x.origin === PROD) && !x.username && !x.password) return x.href; } catch { /* bad */ }
  return accountUrl();
}

const int = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);

/** Cleans the relay message → { plan:'free'|'pro', until?, calls?, limit?, month?, renewUrl }. */
export function readPlan(m = {}) {
  const until = typeof m.until === 'string' && !Number.isNaN(Date.parse(m.until)) ? new Date(m.until).toISOString() : undefined;
  return {
    plan: m.plan === 'pro' ? 'pro' : 'free',
    ...(until ? { until } : {}),
    ...(int(m.calls) !== null ? { calls: m.calls } : {}),
    ...(int(m.limit) ? { limit: m.limit } : {}),
    ...(typeof m.month === 'string' && /^\d{4}-\d{2}$/.test(m.month) ? { month: m.month } : {}),
    renewUrl: safeUrl(m.renewUrl),
  };
}

/** First day of the month after `month` (YYYY-MM) or after `now`, as YYYY-MM-DD. */
export function resetDay(month, now = Date.now()) {
  const [y, mo] = month ? month.split('-').map(Number) : [new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1];
  return new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 10);
}

/**
 * → { kind, tone, dismissible, days?, calls?, limit?, reset?, action:'renew'|'upgrade', url } or
 * { kind:'none' }. Kinds: pro_ending (≤3 days left), pro_ended (ended within 30 days), limit (Free
 * limit reached), free_high (Free ≥ 80 %).
 */
export function planBanner(p, now = Date.now()) {
  if (!p) return { kind: 'none' };
  const url = p.renewUrl || accountUrl();
  const left = p.until ? Date.parse(p.until) - now : null;
  if (p.plan === 'pro' && left !== null) {
    if (left <= 0) return { kind: 'pro_ended', tone: 'red', dismissible: true, action: 'renew', url };
    const days = Math.ceil(left / DAY);
    if (days <= 3) return { kind: 'pro_ending', tone: 'yellow', dismissible: true, days, action: 'renew', url };
    return { kind: 'none' };
  }
  if (p.plan === 'free' && left !== null && left <= 0 && -left < 30 * DAY) return { kind: 'pro_ended', tone: 'red', dismissible: true, action: 'renew', url };
  if (p.plan === 'free' && p.limit && p.calls !== undefined) {
    if (p.calls >= p.limit) return { kind: 'limit', tone: 'red', dismissible: false, calls: p.calls, limit: p.limit, reset: resetDay(p.month, now), action: 'upgrade', url };
    if (p.calls >= 0.8 * p.limit) return { kind: 'free_high', tone: 'yellow', dismissible: true, calls: p.calls, limit: p.limit, action: 'upgrade', url };
  }
  return { kind: 'none' };
}

/**
 * Usage this month and a simple forecast for the Status page (never shown in ChatGPT): the average
 * pace of the days gone this month (at least one day) × the days of the month. → null (no numbers) or
 * { calls, limit?, state: 'unlimited' | 'enough' | 'runs_out' | 'out', projected?, date? (YYYY-MM-DD) }.
 */
export function forecast(p, now = Date.now()) {
  if (!p || p.calls === undefined) return null;
  if (p.plan === 'pro' || !p.limit) return { calls: p.calls, state: 'unlimited' };
  if (p.calls >= p.limit) return { calls: p.calls, limit: p.limit, state: 'out' };
  const [y, mo] = p.month ? p.month.split('-').map(Number) : [new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1];
  const start = Date.UTC(y, mo - 1, 1), end = Date.UTC(y, mo, 1), days = (end - start) / DAY;
  const gone = Math.max(1, (Math.min(Math.max(now, start), end) - start) / DAY);
  const perDay = p.calls / gone, projected = Math.round(perDay * days);
  if (projected <= p.limit) return { calls: p.calls, limit: p.limit, state: 'enough', projected };
  const date = new Date(Math.min(end - DAY, start + (p.limit / perDay) * DAY)).toISOString().slice(0, 10);
  return { calls: p.calls, limit: p.limit, state: 'runs_out', projected, date };
}

/** A dismissed banner stays hidden 24 h (same kind only); the limit banner can't be dismissed. */
export function bannerVisible(b, dismissed, now = Date.now()) {
  if (b.kind === 'none') return false;
  if (!b.dismissible) return true;
  return !(dismissed && dismissed.kind === b.kind && now < dismissed.until);
}
export const dismissFor = (b, now = Date.now()) => ({ kind: b.kind, until: now + DAY });
