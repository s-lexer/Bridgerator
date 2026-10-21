// Task queue (checklist) on this PC: the person adds steps in the Bridgerator window, ChatGPT works
// through them with the queue_* tools. Stored only here (%APPDATA%\Bridgerator\queue.json, inside
// the always-excluded folder); never sent to the server. Tools read/write only this list.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { writeAtomic } from './confirm.mjs';

export const STATUSES = ['todo', 'doing', 'done', 'failed', 'skipped'];
const MAX_ITEMS = 500, MAX_TITLE = 200, MAX_DETAILS = 4000, MAX_NOTE = 1000, MAX_PATHS = 20;
const RULE = 'The usual loop: queue_next, do the task, queue_update with done / failed / skipped and a short note, then the next one until the queue is empty or the person stops. resultPath set: write the result to that file. from set: another AI added it and reads queue_list.';
const MAX_FROM = 80, MAX_RESULT_PATH = 1000;
export const STALE_MS = 30 * 60 * 1000;   // "doing" with no update for this long: another chat gave up
const ID = { type: 'string', description: 'item id' };
const STR = (n) => ({ type: 'string', maxLength: n });
const PATHS = { type: 'array', maxItems: MAX_PATHS, items: STR(1000) };
// AI ↔ AI hand-off (another AI adds tasks for ChatGPT): who added it, and the file for the result. Optional; old items have neither.
const HANDOFF = { from: { type: 'string', maxLength: MAX_FROM, description: 'Who adds the task when another AI hands work over, e.g. "Claude Code".' }, resultPath: { type: 'string', maxLength: MAX_RESULT_PATH, description: 'Full path of the file where the result should be written.' } };

export const QUEUE_TOOL_DEFS = [
  { name: 'queue_list', description: `List the task queue the person keeps on this PC (a checklist of things to do): counts and items (id, title, status, note, worker, updatedAt, from, resultPath), optionally only one status.`, inputSchema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: STATUSES } } } },
  { name: 'queue_next', description: `Take the next item of the task queue: returns the first "todo" item and marks it "doing" (nothing when the queue is empty). An item left "doing" for 30 minutes without an update (another chat stopped) is returned first, with resumed: true. Several chats can work through one queue at once; each call gets a different item. Pass worker = a short name for this chat (e.g. its title) so the person sees who is on it. ${RULE}`, inputSchema: { type: 'object', additionalProperties: false, properties: { worker: STR(80) } } },
  { name: 'queue_update', description: `Set an item's status (doing / done / failed / skipped / todo) with a short result note.`, inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'status'], properties: { id: ID, status: { type: 'string', enum: STATUSES }, note: STR(MAX_NOTE) } } },
  { name: 'queue_add', description: `Add steps to the task queue (e.g. when planning a bigger job with the person): one { title, details?, paths?, from?, resultPath? } or items: [...] (1–100). Another AI handing work to ChatGPT sets from (its name) and resultPath (a file for the result), then reads the outcome with queue_list.`, inputSchema: { type: 'object', additionalProperties: false, properties: { title: STR(MAX_TITLE), details: STR(MAX_DETAILS), paths: PATHS, ...HANDOFF, items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, required: ['title'], properties: { title: STR(MAX_TITLE), details: STR(MAX_DETAILS), paths: PATHS, ...HANDOFF } } } } } },
  { name: 'queue_clear', description: 'Remove finished items from the task queue: status done, failed or skipped. status "all" removes every item and needs the person\'s OK on the PC.', inputSchema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['done', 'failed', 'skipped', 'all'] } } } },
  { name: 'queue_edit', description: 'Change the title, details, paths or result file of a queue item.', inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: ID, title: STR(MAX_TITLE), details: STR(MAX_DETAILS), paths: PATHS, resultPath: HANDOFF.resultPath } } },
  { name: 'queue_reorder', description: 'Put queue items in a new order: ids first, in this order; the rest keep their order after them.', inputSchema: { type: 'object', additionalProperties: false, required: ['ids'], properties: { ids: { type: 'array', maxItems: MAX_ITEMS, items: ID } } } },
];
export const QUEUE_TOOL_NAMES = new Set(QUEUE_TOOL_DEFS.map((t) => t.name));

const str = (v, n, name, required) => {
  if (v === undefined || v === null) { if (required) throw new Error(`${name} is required`); return undefined; }
  if (typeof v !== 'string') throw new Error(`${name} must be text`);
  const t = v.trim();
  if (required && !t) throw new Error(`${name} is required`);
  if (t.length > n) throw new Error(`${name} is longer than ${n} characters`);
  return t;
};
const paths = (v) => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > MAX_PATHS || v.some((p) => typeof p !== 'string' || p.length > 1000)) throw new Error(`paths must be a list of at most ${MAX_PATHS} paths`);
  return v.map((p) => p.trim()).filter(Boolean);
};
const fromOf = (v) => { const t = str(v, MAX_FROM, 'from'); if (t && /[\u0000-\u001f]/.test(t)) throw new Error('from must be a short name on one line'); return t || undefined; };
const resultPathOf = (v) => { const t = str(v, MAX_RESULT_PATH, 'resultPath'); if (t && !/^[a-z]:[\\/]/i.test(t)) throw new Error('resultPath must be a full path like C:\\Users\\Name\\Documents\\result.md'); return t || undefined; };
const handoff = (x) => { const f = fromOf(x?.from), r = resultPathOf(x?.resultPath); return { ...(f ? { from: f } : {}), ...(r ? { resultPath: r } : {}) }; };

export function createQueue(file, { now = () => new Date().toISOString(), onChange = () => {} } = {}) {
  let items = [], unreadable = null;
  // Missing file = empty queue. A file that can't be READ (locked, no access) is never overwritten: saves
  // fail until a restart reads it. A file that can't be PARSED — or has the wrong shape, or items that
  // are dropped (no id / title, unknown status) — is kept as queue.json.broken-<content hash> before any
  // save: once per distinct broken content (the same file at every start is not copied again).
  let raw = null;
  const keepCopy = () => {
    const copy = `${file}.broken-${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16)}`;
    try { fs.copyFileSync(file, copy, fs.constants.COPYFILE_EXCL); } catch (e) { if (e.code !== 'EEXIST') unreadable = 'BROKEN'; }
  };
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') unreadable = e.code || e.message; }
  if (raw !== null) {
    try {
      const j = JSON.parse(raw.replace(/^﻿/, ''));
      if (Array.isArray(j?.items)) {
        items = j.items.filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id && typeof x.title === 'string' && STATUSES.includes(x.status))
          .map((x, i) => ({ ...x, order: Number.isFinite(x.order) ? x.order : i + 1 }));
        if (items.length !== j.items.length) keepCopy();
      } else keepCopy();
    } catch { keepCopy(); }
  }
  // Atomic: write a temp file, then rename over queue.json — a crash or a parallel write never leaves
  // half a file. (Calls run in one process, so the read-modify-write steps never interleave.)
  const save = () => {
    if (unreadable) throw new Error(`queue.json could not be read (${unreadable}); restart Bridgerator to load it — nothing was changed`);
    if (deferSave) return;
    writeAtomic(file, JSON.stringify({ items }, null, 2)); onChange();
  };
  // Every change is all or nothing: a validation or save error leaves the queue as it was.
  const commit = (fn) => {
    const before = structuredClone(items);
    try { return fn(); } catch (e) { items = before; throw e; }
  };
  // Several items in one change: ONE save at the end (a failure half-way leaves queue.json as it was).
  let deferSave = false;
  const many = (fn) => commit(() => { deferSave = true; let r; try { r = fn(); } finally { deferSave = false; } save(); return r; });
  const sorted = () => [...items].sort((a, b) => a.order - b.order);
  const get = (id) => { const it = items.find((x) => x.id === id); if (!it) throw new Error(`no queue item ${id}`); return it; };
  const renumber = (list) => list.forEach((x, i) => { x.order = i + 1; });

  return {
    list: (status) => {
      if (status !== undefined && !STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
      return sorted().filter((x) => !status || x.status === status);
    },
    counts: () => Object.fromEntries(STATUSES.map((s) => [s, items.filter((x) => x.status === s).length])),
    add(x = {}) { return commit(() => this.add0(x)); },
    add0({ title, details, paths: p, from, resultPath } = {}) {
      if (items.length >= MAX_ITEMS) throw new Error(`the queue is full (${MAX_ITEMS} items)`);
      const t = now();
      const it = { id: crypto.randomUUID().slice(0, 8), title: str(title, MAX_TITLE, 'title', true), ...(details !== undefined ? { details: str(details, MAX_DETAILS, 'details') } : {}), ...(p !== undefined ? { paths: paths(p) } : {}), ...handoff({ from, resultPath }), status: 'todo', order: (Math.max(0, ...items.map((x) => x.order)) + 1), createdAt: t, updatedAt: t };
      items.push(it); save(); return it;
    },
    // Synchronous take: parallel chats calling queue_next never get the same item.
    next({ worker } = {}) { return commit(() => {
      const w = str(worker, 80, 'worker');
      const t = Date.parse(now());
      const stale = sorted().find((x) => x.status === 'doing' && t - Date.parse(x.updatedAt) >= STALE_MS);
      const it = stale || sorted().find((x) => x.status === 'todo');
      if (!it) return null;
      if (stale) it.resumedFrom = it.worker || 'another chat';
      it.status = 'doing'; it.updatedAt = now();
      if (w) it.worker = w; else delete it.worker;
      save(); return stale ? { ...it, resumed: true } : it;
    }); },
    update({ id, status, note } = {}) { return commit(() => {
      const it = get(str(id, 40, 'id', true));
      if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
      const n = note !== undefined ? str(note, MAX_NOTE, 'note') : undefined;
      it.status = status; it.updatedAt = now();
      if (note !== undefined) it.note = n;
      if (['done', 'failed', 'skipped'].includes(status)) it.doneAt = it.updatedAt; else delete it.doneAt;
      if (status !== 'doing') delete it.worker;
      save(); return it;
    }); },
    edit({ id, title, details, paths: p, resultPath } = {}) { return commit(() => {
      const it = get(str(id, 40, 'id', true));
      // Everything is checked first, then changed.
      const t = title !== undefined ? str(title, MAX_TITLE, 'title', true) : undefined;
      const d = details !== undefined ? str(details, MAX_DETAILS, 'details') : undefined;
      const ps = p !== undefined ? paths(p) : undefined;
      const r = resultPath !== undefined ? resultPathOf(resultPath) : undefined;
      if (title !== undefined) it.title = t;
      if (details !== undefined) it.details = d;
      if (p !== undefined) it.paths = ps;
      if (resultPath !== undefined) { if (r) it.resultPath = r; else delete it.resultPath; }
      it.updatedAt = now(); save(); return it;
    }); },
    reorder({ ids } = {}) { return commit(() => {
      if (!Array.isArray(ids)) throw new Error('ids must be a list');
      const first = ids.map((id) => get(String(id)));
      renumber([...new Set(first), ...sorted().filter((x) => !first.includes(x))]);
      save(); return sorted();
    }); },
    remove({ id } = {}) { return commit(() => { const it = get(String(id)); items = items.filter((x) => x !== it); renumber(sorted()); save(); return it; }); },
    // Undo of a delete in the window: the item goes back at its old place.
    restore(x = {}) { return commit(() => this.restore0(x)); },
    restore0({ item } = {}) {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || items.some((x) => x.id === item.id)) throw new Error('nothing to restore');
      if (!STATUSES.includes(item.status)) throw new Error('bad item');
      const it = { ...item, title: str(item.title, MAX_TITLE, 'title', true) };
      const list = sorted(); list.splice(Math.max(0, Math.min(list.length, (Number(item.order) || 1) - 1)), 0, it);
      items = list; renumber(items); save(); return it;
    },
    clearFinished() { return commit(() => { items = items.filter((x) => !['done', 'failed', 'skipped'].includes(x.status)); renumber(sorted()); save(); return true; }); },
    // status: done | failed | skipped | finished (all three) | all → the removed items (for Undo).
    clear({ status = 'finished' } = {}) {
      const pick = { done: ['done'], failed: ['failed'], skipped: ['skipped'], finished: ['done', 'failed', 'skipped'], 'failed+skipped': ['failed', 'skipped'], all: STATUSES }[status];
      if (!pick) throw new Error('status must be done, failed, skipped or all');
      return commit(() => {
        const gone = sorted().filter((x) => pick.includes(x.status));
        items = items.filter((x) => !gone.includes(x)); renumber(sorted()); save();
        return gone;
      });
    },
    restoreMany({ items: list } = {}) {
      if (!Array.isArray(list)) throw new Error('nothing to restore');
      return many(() => { for (const it of [...list].sort((a, b) => a.order - b.order)) this.restore0({ item: it }); return sorted(); });
    },
    addMany(list) {
      if (!Array.isArray(list) || !list.length || list.length > 100) throw new Error('items must be a list of 1–100 tasks');
      if (items.length + list.length > MAX_ITEMS) throw new Error(`the queue would be over ${MAX_ITEMS} items`);
      // All or nothing: a half-added list would be added twice when the chat retries.
      list.forEach((x, i) => { str(x?.title, MAX_TITLE, `items[${i}].title`, true); str(x?.details, MAX_DETAILS, `items[${i}].details`); paths(x?.paths); try { handoff(x); } catch (e) { throw new Error(`items[${i}]: ${e.message}`); } });
      return many(() => list.map((x) => this.add0(x)));
    },
  };
}

/** queue_* tool call → MCP result. */
export function queueTool(q, name, args = {}) {
  const ok = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
  try {
    switch (name) {
      case 'queue_list': return ok({ counts: q.counts(), items: q.list(args.status).map(({ id, title, status, note, worker, updatedAt, details, paths, from, resultPath }) => ({ id, title, status, ...(note ? { note } : {}), ...(worker ? { worker } : {}), updatedAt, ...(details ? { details } : {}), ...(paths ? { paths } : {}), ...(from ? { from } : {}), ...(resultPath ? { resultPath } : {}) })) });
      case 'queue_next': { const it = q.next(args); return ok(it ? { item: it } : { item: null, message: 'The queue is empty — tell the person and stop.' }); }
      case 'queue_update': return ok({ item: q.update(args) });
      case 'queue_add': return args.items ? ok({ items: q.addMany(args.items) }) : ok({ item: q.add(args) });
      case 'queue_clear': { if (args.status === 'all') throw new Error('clearing every item needs the person\'s OK'); const gone = q.clear({ status: args.status || 'finished' }); return ok({ removed: gone.length, counts: q.counts() }); }
      case 'queue_edit': return ok({ item: q.edit(args) });
      case 'queue_reorder': return ok({ items: q.reorder(args) });
      default: return { content: [{ type: 'text', text: `unknown queue tool ${name}` }], isError: true };
    }
  } catch (e) {
    return { content: [{ type: 'text', text: `Queue: ${e.message}` }], isError: true };
  }
}
