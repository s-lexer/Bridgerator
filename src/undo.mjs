// LOGIC: see critical-logic/bridge.md ("Snapshots and Undo"). Before the AI writes, edits, moves or
// (through the Recycle Bin path) deletes a file, a copy goes to %LOCALAPPDATA%\Bridgerator\snapshots
// (inside the always-excluded folder, never sent anywhere). "Undo" puts the old state back — but never
// over a file someone changed after the AI's action (size / time differ from what the AI left): that
// file is skipped and reported. Limits: days, total MB, biggest file MB (a bigger file gets no copy:
// the action is marked "no undo").
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { writeAtomic } from './confirm.mjs';
import { POWERSHELL, psArgs } from './win.mjs';

export const SNAP_DEFAULTS = { enabled: true, days: 7, maxMb: 500, maxFileMb: 50 };
const MAX_TREE_FILES = 5000;
const MB = 1024 * 1024;

/**
 * Current state of a path: { kind: 'none' } | { kind: 'file', size, mtimeMs, hash? } | { kind: 'dir' }.
 * Small files also get a content hash: two writes of the same size within one millisecond look alike otherwise.
 */
export function sig(p) {
  try {
    const s = fs.lstatSync(p);
    if (s.isDirectory()) return { kind: 'dir' };
    const out = { kind: 'file', size: s.size, mtimeMs: Math.round(s.mtimeMs) };
    if (s.size <= HASH_MAX) { try { out.hash = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } catch { /* locked: size + time only */ } }
    return out;
  } catch { return { kind: 'none' }; }
}
const HASH_MAX = 1024 * 1024;
// A pending action's own change lands within this time of its capture (one engine call / recycle).
// A delegated agent run passes its own time limit (maxMs); an old meta without it gets the longest one.
const PENDING_MAX_MS = 10 * 60000;
const DELEGATE_MAX_MS = 240 * 60000;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// Windows reuses pids: a pending action of a live pid is taken over only when that process is proven
// NOT the recorded bridge (its start time differs by more than START_SLACK_MS). Start time unknown
// (PowerShell slow / timed out / denied) = maybe still that bridge → left alone this start (data first).
const START_SLACK_MS = 10000;
const SELF_START = Math.round(Date.now() - process.uptime() * 1000);
/** Start time (ms) of a process, or null when it cannot be read. Async (execFile, 5 s limit): never blocks the event loop. */
export function procStart(pid) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    cp.execFile(POWERSHELL, psArgs(`[DateTimeOffset]::new((Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`), { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, out) => {
      const n = err ? NaN : Number(String(out).trim());
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}
const same = (a, b) => a && b && a.kind === b.kind && (a.kind !== 'file' || (a.size === b.size && a.mtimeMs === b.mtimeMs && a.hash === b.hash));
// Own recursive copy: fs.cp / fs.cpSync of Node 24 garble non-ASCII folder names on Windows.
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyTree(a, b); else fs.copyFileSync(a, b);
  }
}

// Size of a folder tree, null when over the caps (then no copy).
function treeSize(dir, capBytes) {
  let bytes = 0, files = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return null; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      if (++files > MAX_TREE_FILES) return null;
      try { bytes += fs.statSync(p).size; } catch { return null; }
      if (bytes > capBytes) return null;
    }
  }
  return bytes;
}

/** The paths a tool call changes: [{ path, role }] (role 'move' = source of a move_file). */
export function changedPaths(name, args = {}) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'write_file' && typeof a.path === 'string') return [{ path: a.path }];
  if (name === 'edit_block' && typeof a.file_path === 'string') return [{ path: a.file_path }];
  if (name === 'move_file' && typeof a.source === 'string' && typeof a.destination === 'string') return [{ path: a.source, role: 'from' }, { path: a.destination, role: 'to' }];
  return [];
}

export function createSnapshots(dir, { limits = () => SNAP_DEFAULTS, now = Date.now, log = () => {}, startOf = procStart, selfStart = SELF_START } = {}) {
  let actions = [];
  const touched = new Set(); // paths this process captured (deferred recovery must not take their state)
  const lim = () => ({ ...SNAP_DEFAULTS, ...(limits() || {}) });
  const metaFile = (id) => path.join(dir, id, 'meta.json');
  const save = (a) => { try { writeAtomic(metaFile(a.id), JSON.stringify(a)); } catch (e) { log(`[bridgerator] snapshot ${a.id}: ${e.message}`); } };
  const drop = (a) => { try { fs.rmSync(path.join(dir, a.id), { recursive: true, force: true }); } catch (e) { log(`[bridgerator] snapshot cleanup ${a.id}: ${e.message}`); } };
  const readMeta = (id) => {
    const a = JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
    if (!a || a.id !== id || !Array.isArray(a.entries)) throw new Error('bad meta');
    return a;
  };
  const rmId = (id) => { try { fs.rmSync(path.join(dir, id), { recursive: true, force: true }); } catch { /* busy */ } };
  // Captured, but the bridge stopped before the commit (crash, power): kept when the files did change.
  // late: recovered after startup (deferred check) — a path this bridge has captured since, or a file
  // changed after this bridge started, may hold a NEWER action's result: its after-state stays unknown.
  const recover = (a, late = false) => {
    if (a.pending) {
      const maxMs = Number.isFinite(a.maxMs) && a.maxMs > 0 ? a.maxMs : a.tool === 'delegate' ? DELEGATE_MAX_MS : PENDING_MAX_MS;
      delete a.pending; delete a.pid; delete a.started; delete a.maxMs;
      // A file changed long after the action (the person, while the bridge was down) is not "what the AI
      // left": its after-state stays unknown, so Undo never puts the old copy over it.
      for (const e of a.entries) {
        const now1 = sig(e.path);
        const newer = late && (touched.has(e.path) || (now1.kind === 'file' && now1.mtimeMs > selfStart));
        e.after = newer || (now1.kind === 'file' && now1.mtimeMs > a.t + maxMs) ? { kind: 'unknown' } : now1;
      }
      if (a.entries.every((e) => same(e.before, e.after))) throw new Error('nothing changed');
      save(a);
    }
    return a;
  };
  // A left-alone pending meta older than the days limit is long over (an action lasts maxMs at most):
  // removed like prune() would, so a pid reused by a long-lived program never leaks its copies.
  const expired = (a) => !(a.t >= now() - lim().days * 86400000);
  const check = []; // pending metas of a live pid with a start time: checked after startup (async)
  try {
    for (const id of fs.readdirSync(dir)) {
      try {
        const a = readMeta(id);
        // Another bridge process still running owns its pending action: left alone (not read, not removed).
        if (a.pending && a.pid && a.pid !== process.pid && alive(a.pid)) {
          if (Number.isFinite(a.started)) check.push(a); // meta of an older bridge (pid only): left alone
          else if (expired(a)) rmId(id);
          continue;
        }
        actions.push(recover(a));
      } catch { rmId(id); }
    }
  } catch { /* no folder yet */ }
  actions.sort((x, y) => x.t - y.t);
  // Live pid: taken over only when its start time is known AND differs (the pid now belongs to another
  // program). Same start time or unknown = that bridge may still be running → left alone this start.
  const ready = Promise.all(check.map(async (a0) => {
    let st = null;
    try { st = await startOf(a0.pid); } catch { /* unknown */ }
    if (st === null || !Number.isFinite(st) || Math.abs(st - a0.started) <= START_SLACK_MS) { if (expired(a0)) rmId(a0.id); return; }
    try {
      const a = readMeta(a0.id); // re-read: its owner may have committed meanwhile
      if (!a.pending || a.pid !== a0.pid || a.started !== a0.started) return; // changed since: not ours to take
      actions.push(recover(a, true));
      actions.sort((x, y) => x.t - y.t);
    } catch { rmId(a0.id); }
  })).then(() => { if (check.length) prune(); });

  function prune() {
    const l = lim();
    const old = now() - l.days * 86400000;
    let total = actions.reduce((n, a) => n + (a.bytes || 0), 0);
    const keep = [];
    for (const a of actions) {
      if (a.t < old) { drop(a); total -= a.bytes || 0; continue; }
      keep.push(a);
    }
    while (keep.length && total > l.maxMb * MB) { const a = keep.shift(); drop(a); total -= a.bytes || 0; }
    actions = keep;
  }
  prune();

  return {
    /**
     * Copies the current state of the paths before the action. → a pending action (commit after the
     * call), or null when snapshots are off / nothing to copy. kind 'delete' = paths about to be removed.
     */
    async capture(tool, list, { task, label, keepEmpty = false, maxMs } = {}) {
      const l = lim();
      // keepEmpty: a delegated agent run in an empty folder still needs an action (its new files are added at commit).
      if (!l.enabled || (!list.length && !keepEmpty)) return null;
      const id = `${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      const base = path.join(dir, id);
      fs.mkdirSync(base, { recursive: true });
      const entries = [];
      let bytes = 0;
      for (const [i, it] of list.entries()) {
        const p = path.resolve(it.path);
        touched.add(p);
        const before = sig(p);
        const e = { path: p, role: it.role, before };
        if (it.role === 'from') { entries.push(e); continue; }       // a move is undone by moving back
        if (before.kind === 'file') {
          if (before.size > l.maxFileMb * MB) e.noCopy = 'big';
          else { try { await fs.promises.copyFile(p, path.join(base, String(i))); e.blob = String(i); bytes += before.size; } catch (err) { e.noCopy = 'error'; log(`[bridgerator] snapshot copy failed: ${err.code || err.message}`); } }
        } else if (before.kind === 'dir' && it.role === 'delete') {
          const n = treeSize(p, l.maxFileMb * MB);
          if (n === null) e.noCopy = 'big';
          else { try { copyTree(p, path.join(base, String(i))); e.blob = String(i); bytes += n; } catch (err) { e.noCopy = 'error'; log(`[bridgerator] snapshot copy failed: ${err.code || err.message}`); } }
        }
        entries.push(e);
      }
      const a = { id, t: now(), tool, label: label || '', ...(task ? { task } : {}), entries, bytes };
      // Written now (marked pending), so a crash before commit() does not lose the copy.
      // maxMs: how long the action itself may keep changing files (a delegated run: its time limit).
      save({ ...a, pending: true, pid: process.pid, started: SELF_START, ...(Number.isFinite(maxMs) && maxMs > 0 ? { maxMs } : {}) });
      return a;
    },
    /**
     * After the call: ok → kept with the state the AI left; failed → thrown away.
     * added: paths created during the action (undo removes them); changedOnly: entries the action did
     * not change are dropped with their copies (a whole folder captured before a delegated agent run).
     */
    commit(a, ok, { added = [], changedOnly = false } = {}) {
      if (!a) return null;
      if (!ok) { drop(a); return null; }
      for (const p of added) { const r = path.resolve(p); if (!a.entries.some((e) => e.path === r)) a.entries.push({ path: r, before: { kind: 'none' } }); }
      for (const e of a.entries) e.after = sig(e.path);
      if (changedOnly) {
        for (const e of a.entries) {
          if (!same(e.before, e.after) || !e.blob) continue;
          try { fs.rmSync(path.join(dir, a.id, e.blob), { force: true }); a.bytes -= e.before.size || 0; } catch (err) { log(`[bridgerator] snapshot trim: ${err.code || err.message}`); }
        }
        a.entries = a.entries.filter((e) => !same(e.before, e.after));
      }
      // Nothing changed on disk (e.g. the engine refused) → nothing to undo.
      if (a.entries.every((e) => same(e.before, e.after))) { drop(a); return null; }
      actions.push(a); save(a); prune();
      return a;
    },
    list() {
      return [...actions].reverse().map((a) => ({
        id: a.id, t: a.t, tool: a.tool, label: a.label, task: a.task || null, undone: !!a.undone,
        paths: a.entries.map((e) => e.path),
        noUndo: a.entries.some((e) => e.noCopy && e.before.kind !== 'none'),
      }));
    },
    get bytes() { return actions.reduce((n, a) => n + (a.bytes || 0), 0); },
    get count() { return actions.length; },
    find: (id) => actions.find((a) => a.id === id) || null,
    /** Undo one action → { id, restored: [path], skipped: [{ path, why }] }. check(path) → refusal text or null. */
    undo(id, { check = () => null } = {}) {
      const a = actions.find((x) => x.id === id);
      if (!a) return { id, restored: [], skipped: [{ path: '', why: 'no such change (too old, or snapshots were cleared)' }] };
      if (a.undone) return { id, restored: [], skipped: [{ path: '', why: 'already undone' }] };
      const restored = [], skipped = [];
      const base = path.join(dir, a.id);
      const from = a.entries.find((e) => e.role === 'from'), to = a.entries.find((e) => e.role === 'to');
      for (const e of a.entries) { const why = check(e.path); if (why) { skipped.push({ path: e.path, why }); } }
      if (skipped.length) return { id, restored, skipped };
      // Someone (the person, another chat) changed it after the AI → leave it, say so.
      for (const e of a.entries) if (!same(sig(e.path), e.after)) skipped.push({ path: e.path, why: 'changed after ChatGPT\'s action — left as it is' });
      if (skipped.length) return { id, restored, skipped };
      try {
        if (from && to) {
          fs.mkdirSync(path.dirname(from.path), { recursive: true });
          fs.renameSync(to.path, from.path); restored.push(from.path);
          if (to.blob) { fs.copyFileSync(path.join(base, to.blob), to.path); restored.push(to.path); }
          else if (to.noCopy && to.before.kind === 'file') skipped.push({ path: to.path, why: 'the file it replaced was too big to keep a copy' });
        } else {
          for (const e of a.entries) {
            if (e.before.kind === 'none') { if (sig(e.path).kind === 'file') { fs.rmSync(e.path, { force: true }); restored.push(e.path); } continue; }
            if (!e.blob) { skipped.push({ path: e.path, why: e.noCopy === 'big' ? `no copy (bigger than ${lim().maxFileMb} MB)${a.tool === 'delete' ? ' — it is in the Recycle Bin' : ''}` : 'no copy was kept' }); continue; }
            fs.mkdirSync(path.dirname(e.path), { recursive: true });
            if (e.before.kind === 'dir') copyTree(path.join(base, e.blob), e.path);
            else { fs.copyFileSync(path.join(base, e.blob), e.path); try { const t = new Date(e.before.mtimeMs); fs.utimesSync(e.path, t, t); } catch { /* time only */ } }
            restored.push(e.path);
          }
        }
      } catch (err) {
        skipped.push({ path: '', why: `could not restore: ${err.code || err.message}` });
      }
      if (restored.length) { a.undone = now(); save(a); }
      return { id, restored, skipped };
    },
    /** Several actions, newest first (later changes are undone before earlier ones). */
    undoMany(ids, opts) {
      const order = actions.filter((a) => ids.includes(a.id)).sort((x, y) => y.t - x.t).map((a) => a.id);
      return order.map((id) => this.undo(id, opts));
    },
    clear() { for (const a of actions) drop(a); actions = []; },
    prune,
    /** Resolves when the pending metas of live pids have been checked (tests; startup never waits). */
    ready,
  };
}

/**
 * Groups for "Undo AI changes": per queue task, and per batch (actions less than `gapMs` apart).
 * → [{ kind: 'task'|'batch', key, title, t0, t1, ids }] newest first, only not-yet-undone actions.
 */
export function undoGroups(list, gapMs = 5 * 60000) {
  const live = list.filter((a) => !a.undone).sort((x, y) => x.t - y.t);
  const tasks = new Map(), batches = [];
  for (const a of live) {
    if (a.task) { const g = tasks.get(a.task.id) || { kind: 'task', key: a.task.id, title: a.task.title || a.task.id, t0: a.t, t1: a.t, ids: [] }; g.t1 = a.t; g.ids.push(a.id); tasks.set(a.task.id, g); }
    const b = batches[batches.length - 1];
    if (b && a.t - b.t1 < gapMs) { b.t1 = a.t; b.ids.push(a.id); } else batches.push({ kind: 'batch', key: a.id, title: '', t0: a.t, t1: a.t, ids: [a.id] });
  }
  return [...tasks.values(), ...batches].sort((x, y) => y.t1 - x.t1);
}

export const UNDO_TOOL_DEF = {
  name: 'bridgerator_undo',
  description: 'Undoes ChatGPT\'s file changes on this PC (writes, edits, moves, deletions through the Recycle Bin) from Bridgerator\'s snapshots: the last change by default, a number of recent ones, one by id, or all changes made for a queue task. A file someone changed afterwards is left as it is and reported. action "list" shows recent changes that can be undone.',
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['undo', 'list'] },
      id: { type: 'string', maxLength: 40, description: 'Change id (from a result or the list).' },
      task: { type: 'string', maxLength: 40, description: 'Queue item id: undo every change made while it was in progress.' },
      count: { type: 'integer', minimum: 1, maximum: 50, description: 'Undo this many of the most recent changes (default 1).' },
    },
  },
};
