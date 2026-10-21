// LOGIC: see critical-logic/bridge.md ("Plan card"). Batch approval: when confirmations are on and
// the AI is about to do many similar actions (move 214 files…), it sends the list first
// (bridgerator_plan propose) → ONE card on the PC: Allow all / Review (the window: tick items, Allow
// selected) / Deny. Allowed items then pass the confirmation without their own question — only the
// exact listed tool + paths (or command text), each as many times as listed, for 30 minutes. The
// folder rules (policy.check) and everything else still apply to every call. Approvals live in
// memory only (a restart forgets them). dryRun: the same list is only checked (refused by the folder
// rules / would ask / runs freely, missing sources, existing targets); nothing is asked or run.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { findMatch, detail, clip, LABEL } from './confirm.mjs';
import { norm } from './policy.mjs';
import { fail, json, needAction, str } from './tool-lib.mjs';

export const PLAN_TTL_MS = 30 * 60000, REVIEW_MS = 10 * 60000, MAX_ITEMS = 1000, DENY_COOLDOWN_MS = 10 * 60000;
// The engine tools a confirmation can stop (findMatch): their key arguments identify the item.
const KEY = {
  move_file: (a) => `move|${norm(a.source)}|${norm(a.destination)}`,
  write_file: (a) => `write|${norm(a.path)}`,
  edit_block: (a) => `edit|${norm(a.file_path)}`,
  create_directory: (a) => `mkdir|${norm(a.path)}`,
  start_process: (a) => `cmd|${String(a.command).trim()}`,
};
const NEED = { move_file: ['source', 'destination'], write_file: ['path'], edit_block: ['file_path'], create_directory: ['path'], start_process: ['command'] };
export const PLAN_TOOLS = Object.keys(KEY);
/** → the approval key of a call, or null when such a call can't be part of a plan. */
export function itemKey(tool, args) {
  if (!KEY[tool] || !args || typeof args !== 'object') return null;
  if (NEED[tool].some((k) => typeof args[k] !== 'string' || !args[k].trim())) return null;
  try { return KEY[tool](args); } catch { return null; }
}
// [verb, plural noun of the mixed list, plural object, singular noun of the mixed list]
const VERB = { move_file: ['move', 'moves', 'files', 'move'], write_file: ['write', 'writes', 'files', 'write'], edit_block: ['edit', 'edits', 'files', 'edit'], create_directory: ['create', 'new folders', 'folders', 'new folder'], start_process: ['run', 'commands', 'commands', 'command'] };
/** "ChatGPT wants to move 214 files" / "ChatGPT wants to do 220 actions (214 moves, 6 commands)". */
export function headline(rows) {
  const by = {};
  for (const r of rows) by[r.tool] = (by[r.tool] || 0) + 1;
  const kinds = Object.keys(by);
  if (kinds.length === 1) { const [k] = kinds, n = by[k]; return n === 1 ? `ChatGPT wants to ${VERB[k][0]} 1 ${VERB[k][2].replace(/s$/, '')}` : `ChatGPT wants to ${VERB[k][0]} ${n} ${VERB[k][2]}`; }
  return `ChatGPT wants to do ${rows.length} actions (${kinds.map((k) => `${by[k]} ${VERB[k][by[k] === 1 ? 3 : 1]}`).join(', ')})`;
}
// Dry run notes: what the action would meet on disk (nothing is changed). Only rows the folder rules
// allow, only full paths on the system drive (never a network / device path or another drive letter,
// which may be a mapped network drive: a stat there can hang and hold one of libuv's few threads past
// the time limit), async with a short time limit each, a few at a time. Other paths: no note.
const LOCAL = /^[a-z]:[\\/]/i;
const SYS = String(process.env.SystemDrive || 'C:').slice(0, 2).toLowerCase();
const onSystemDrive = (p) => LOCAL.test(p) && p.slice(0, 2).toLowerCase() === SYS;
const STAT_MS = 2000, STAT_AT_ONCE = 8;
const exists = (p) => (typeof p !== 'string' || !onSystemDrive(p.trim()) ? Promise.resolve(null)
  : Promise.race([fs.promises.stat(p.trim()).then(() => true, () => false), new Promise((r) => { const t = setTimeout(() => r(null), STAT_MS); t.unref?.(); })]));
async function dryNote(tool, a) {
  const e = async (p) => { const x = await exists(p); if (x === null) throw new Error('unknown'); return x; };
  try {
    if (tool === 'move_file') return !(await e(a.source)) ? 'source missing' : (await e(a.destination)) ? 'target exists' : '';
    if (tool === 'write_file') return (await e(a.path)) ? 'overwrites' : 'new file';
    if (tool === 'edit_block') return (await e(a.file_path)) ? '' : 'file missing';
    if (tool === 'create_directory') return (await e(a.path)) ? 'exists' : '';
  } catch { return ''; }
  return '';
}
async function dryNotes(rows) {
  const out = new Map();
  let next = 0;
  const worker = async () => { while (next < rows.length) { const r = rows[next++]; if (!r.refused) out.set(r.i, await dryNote(r.tool, r.args)); } };
  await Promise.all(Array.from({ length: Math.min(STAT_AT_ONCE, rows.length) }, worker));
  return out;
}

// The card's one line: file names first (the full paths are in the window's list).
const base = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
function brief(r) {
  const a = r.args;
  if (r.tool === 'move_file') return `${base(a.source)} → ${a.destination}`;
  if (r.tool === 'start_process') return String(a.command).replace(/\s+/g, ' ').trim();
  return a.path || a.file_path ? `${base(a.path || a.file_path)} (${a.path || a.file_path})` : r.text;
}

const REPLACED = Symbol('replaced');
export function createBatch({ now = Date.now, openWindow = () => {}, log = () => {} } = {}) {
  const plans = new Map();     // id → { id, title, keys: Map(key → uses left), expires, rows }
  let pending = null;          // the card waiting in the window: { id, title, head, rows, resolve }
  let deniedUntil = 0;
  const sweep = () => { for (const [id, p] of plans) if (p.expires <= now()) plans.delete(id); };

  function read(ctx, args) {
    const items = args.items;
    if (!Array.isArray(items) || !items.length || items.length > MAX_ITEMS) fail('BAD_ARGS', `items must be a list of 1–${MAX_ITEMS} actions { tool, args }.`);
    const s = ctx.gate.settings();
    return items.map((it, i) => {
      if (!it || typeof it !== 'object' || Array.isArray(it)) fail('BAD_ARGS', `items[${i}] must be { tool, args }.`);
      const tool = it.tool, a = it.args;
      if (!PLAN_TOOLS.includes(tool)) fail('BAD_ARGS', `items[${i}].tool must be one of ${PLAN_TOOLS.join(', ')}.`);
      if (!a || typeof a !== 'object' || Array.isArray(a)) fail('BAD_ARGS', `items[${i}].args must be the tool's arguments.`);
      const key = itemKey(tool, a);
      if (!key) fail('BAD_ARGS', `items[${i}].args need ${NEED[tool].join(' and ')}.`);
      const refused = ctx.policy.check(tool, a);
      const m = refused ? { cat: null, fragment: '' } : findMatch(tool, a, s.ask, s.patterns);
      return { i, tool, key, args: a, text: detail(tool, a, m.fragment, 160), refused: refused || null, cat: s.enabled ? m.cat : null };
    });
  }

  /** The card: notification first (Allow all / Review / Deny); Review = the window with the list. → indexes allowed. */
  async function card(ctx, id, title, rows) {
    const head = headline(rows);
    const first = brief(rows[0]), last = brief(rows[rows.length - 1]);
    const text = clip(rows.length === 1 ? first : `${title ? `${title}: ` : ''}${first}  …  ${last}`, '', 140);
    const s = ctx.gate.settings();
    const r = await ctx.gate.askPerson(`plan:${id}`, { head, text, buttons: [['allow', 'Allow all', ''], ['review', 'Review…', ''], ['deny', 'Deny', 'deny']], secs: s.timeoutSec, auto: 'auto-deny', ...(ctx.popup?.() || {}) });
    if (r === 'allow') return rows.map((x) => x.i);
    if (r !== 'review') return null;
    openWindow('home');
    return new Promise((resolve) => {
      const timer = setTimeout(() => { if (pending?.id === id) { pending = null; resolve(null); } }, REVIEW_MS);
      timer.unref?.();
      // One card in the window at a time: a newer plan under review replaces an older one, which then
      // ends as "replaced" (its propose call answers; no cool-down for the newer plan).
      if (pending) pending.resolve(REPLACED);
      const me = { id, title, head, rows, resolve: (sel) => { clearTimeout(timer); if (pending === me) pending = null; resolve(sel); } };
      pending = me;
    });
  }

  const api = {
    /** bridge.mjs, before the confirmation: a call listed in an approved plan → true (one use taken). */
    covers(name, args, gate) {
      const key = itemKey(name, args);
      if (!key || !plans.size) return false;
      const s = gate.settings();
      if (!s.enabled || !findMatch(name, args, s.ask, s.patterns).cat) return false;   // would not ask anyway: keep the use
      sweep();
      for (const p of plans.values()) {
        const left = p.keys.get(key);
        if (left > 0) { if (left === 1) p.keys.delete(key); else p.keys.set(key, left - 1); p.used++; return true; }
      }
      return false;
    },
    /** The window's view of the card under review. */
    pending: () => (pending ? { id: pending.id, title: pending.title, head: pending.head, rows: pending.rows.map((r) => ({ i: r.i, text: r.text, cat: r.cat })) } : null),
    /** The person's answer in the window: allow = list of item indexes ([] = deny). */
    decide(id, allow) {
      if (!pending || pending.id !== id) return false;
      const ok = new Set(pending.rows.map((r) => r.i));
      pending.resolve(Array.isArray(allow) ? [...new Set(allow.filter((i) => Number.isInteger(i) && ok.has(i)))] : null);
      return true;
    },
    active() { sweep(); return [...plans.values()].map((p) => ({ planId: p.id, title: p.title, left: [...p.keys.values()].reduce((a, b) => a + b, 0), used: p.used, expiresAt: new Date(p.expires).toISOString() })); },
    async propose(ctx, args) {
      const title = args.title === undefined ? '' : str(args, 'title', { max: 120 }).replace(/\s+/g, ' ').trim();
      const rows = read(ctx, args);
      const s = ctx.gate.settings();
      const refused = rows.filter((r) => r.refused).map((r) => ({ index: r.i, reason: r.refused }));
      const ask = rows.filter((r) => !r.refused && r.cat);
      if (args.dryRun === true) {
        const shown = rows.slice(0, 200), notes = await dryNotes(shown);
        const cats = {};
        for (const r of ask) cats[r.cat] = (cats[r.cat] || 0) + 1;
        return json({
          dryRun: true, total: rows.length, refused, confirmations: s.enabled ? 'on' : 'off',
          wouldAsk: ask.length, ...(ask.length ? { askFor: Object.fromEntries(Object.entries(cats).map(([k, n]) => [LABEL[k] || k, n])) } : {}), runsFreely: rows.length - refused.length - ask.length,
          items: shown.map((r) => ({ index: r.i, action: r.text, ...(r.refused ? { refused: true } : r.cat ? { asks: LABEL[r.cat] || r.cat } : {}), ...(notes.get(r.i) ? { note: notes.get(r.i) } : {}) })),
          ...(rows.length > 200 ? { more: rows.length - 200 } : {}),
          note: 'Nothing was asked or run.',
        });
      }
      if (!s.enabled) return json({ needed: false, refused, note: 'Confirmations are off on this PC: these actions run without questions (the folder rules still apply).' });
      if (!ask.length) return json({ needed: false, refused, note: 'None of these actions asks on this PC; no approval needed.' });
      if (now() < deniedUntil) return { content: [{ type: 'text', text: 'Not approved — the person at the PC declined a plan a few minutes ago. Ask them in the chat first.' }], isError: true, notConfirmed: true };
      const id = crypto.randomBytes(4).toString('hex');
      const sel = await card(ctx, id, title, ask);
      if (sel === REPLACED) return { content: [{ type: 'text', text: JSON.stringify({ planId: id, approved: false, replaced: true, refused, note: 'A newer plan card replaced this one in the Bridgerator window before the person answered. Each action would ask on its own; propose again if needed.' }, null, 2) }], isError: true, notConfirmed: true };
      if (!sel || !sel.length) {
        deniedUntil = now() + DENY_COOLDOWN_MS;
        return { content: [{ type: 'text', text: JSON.stringify({ planId: id, approved: false, refused, note: 'The person at the PC did not allow this plan (denied or no answer). Each action would ask on its own.' }, null, 2) }], isError: true, notConfirmed: true };
      }
      const keys = new Map(), allowed = new Set(sel);
      for (const r of ask) if (allowed.has(r.i)) keys.set(r.key, (keys.get(r.key) || 0) + 1);
      const p = { id, title, keys, used: 0, expires: now() + PLAN_TTL_MS };
      plans.set(id, p);
      log(`[bridgerator] plan ${id} approved on the PC: ${allowed.size} of ${ask.length} actions`);
      return json({ planId: id, approved: true, allowed: allowed.size, notAllowed: ask.length - allowed.size, notAllowedIndexes: ask.filter((r) => !allowed.has(r.i)).map((r) => r.i).slice(0, 200), refused, expiresAt: new Date(p.expires).toISOString(), note: 'Allowed actions run without their own question until expiresAt, each as many times as listed. Actions not allowed still ask.' });
    },
    status(planId) { sweep(); const p = plans.get(planId); return p ? { planId, active: true, left: [...p.keys.values()].reduce((a, b) => a + b, 0), used: p.used, expiresAt: new Date(p.expires).toISOString() } : { planId, active: false }; },
    cancel(planId) { return plans.delete(planId); },
  };
  return api;
}

// ---- the tool -------------------------------------------------------------------------------------------
const ACTIONS = ['propose', 'status', 'cancel'];
export const PLAN_TOOL = {
  name: 'bridgerator_plan',
  title: 'Plan card (one approval for many actions)',
  description: 'One approval on the PC for a list of similar actions (e.g. moving 200 files) while confirmations are on, instead of a question per action. propose: items [{ tool, args }] with the exact arguments planned; the person allows all, some or none, and allowed items then run without their own question for 30 minutes. dryRun true only checks the list (refused by folder rules, would ask, missing files) — nothing is asked or run. status / cancel by planId.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ACTIONS },
      title: { type: 'string', maxLength: 120 },
      items: { type: 'array', minItems: 1, maxItems: MAX_ITEMS, items: { type: 'object', additionalProperties: false, required: ['tool', 'args'], properties: { tool: { type: 'string', enum: PLAN_TOOLS }, args: { type: 'object' } } } },
      dryRun: { type: 'boolean' },
      planId: { type: 'string', maxLength: 8 },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};
export const defs = [PLAN_TOOL];

const batches = new WeakMap();
export const attachBatch = (cfg, b) => { batches.set(cfg, b); return b; };
export const batchFor = (cfg) => batches.get(cfg) || null;

export async function handle(name, args, ctx) {
  const b = batchFor(ctx.cfg);
  if (!b) fail('NOT_AVAILABLE', 'Plan cards are not available on this PC.');
  const action = needAction(args, ACTIONS);
  if (action === 'propose') return b.propose(ctx, args);
  const id = str(args, 'planId', { required: true, max: 8 });
  if (action === 'status') return json(b.status(id));
  return json({ planId: id, cancelled: b.cancel(id) });
}
