// Snapshots and Undo (undo.mjs): copy before a change, put it back, never over a file someone changed
// afterwards; limits (size per file, total, days); groups for "Undo AI changes".
// LOGIC: critical-logic/bridge.md ("Snapshots and Undo").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSnapshots, changedPaths, undoGroups } from '../src/undo.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-undo-'));
const work = path.join(root, 'Мои документы');
fs.mkdirSync(work, { recursive: true });
const P = (...x) => path.join(work, ...x);
const read = (p) => fs.readFileSync(p, 'utf8');
const snapDir = () => fs.mkdtempSync(path.join(root, 'snap-'));
const MB = 1024 * 1024;

// One AI action: capture → change → commit, like the bridge does around the engine call.
async function act(s, tool, list, change, opts) { const a = await s.capture(tool, list, opts); change(); return s.commit(a, true); }

test('which paths a tool call changes', () => {
  assert.deepEqual(changedPaths('write_file', { path: 'C:\\a.txt', content: '' }), [{ path: 'C:\\a.txt' }]);
  assert.deepEqual(changedPaths('edit_block', { file_path: 'C:\\a.txt' }), [{ path: 'C:\\a.txt' }]);
  assert.deepEqual(changedPaths('move_file', { source: 'C:\\a', destination: 'C:\\b' }), [{ path: 'C:\\a', role: 'from' }, { path: 'C:\\b', role: 'to' }]);
  assert.deepEqual(changedPaths('read_file', { path: 'C:\\a.txt' }), []);
  assert.deepEqual(changedPaths('write_file', null), []);
});

test('write / edit / new file / move / delete are undone; the original time comes back', async () => {
  const s = createSnapshots(snapDir());
  fs.writeFileSync(P('план.txt'), 'версия 1');
  const t0 = fs.statSync(P('план.txt')).mtimeMs;
  const w = await act(s, 'write_file', [{ path: P('план.txt') }], () => fs.writeFileSync(P('план.txt'), 'версия 2 от ИИ'));
  const n = await act(s, 'write_file', [{ path: P('новый.txt') }], () => fs.writeFileSync(P('новый.txt'), 'created'));
  fs.writeFileSync(P('из.txt'), 'moved');
  const m = await act(s, 'move_file', [{ path: P('из.txt'), role: 'from' }, { path: P('в.txt'), role: 'to' }], () => fs.renameSync(P('из.txt'), P('в.txt')));
  fs.mkdirSync(P('папка', 'вложенная'), { recursive: true }); fs.writeFileSync(P('папка', 'вложенная', 'x.txt'), 'deep');
  const d = await act(s, 'delete', [{ path: P('папка'), role: 'delete' }], () => fs.rmSync(P('папка'), { recursive: true }));
  assert.equal(s.list().length, 4);
  const r = s.undoMany([w.id, n.id, m.id, d.id]);
  assert.deepEqual(r.flatMap((x) => x.skipped), []);
  assert.equal(read(P('план.txt')), 'версия 1');
  assert.equal(Math.round(fs.statSync(P('план.txt')).mtimeMs), Math.round(t0));
  assert.equal(fs.existsSync(P('новый.txt')), false, 'a file the AI created is removed');
  assert.equal(read(P('из.txt')), 'moved'); assert.equal(fs.existsSync(P('в.txt')), false);
  assert.equal(read(P('папка', 'вложенная', 'x.txt')), 'deep', 'a deleted folder comes back whole');
  assert.ok(s.list().every((a) => a.undone));
  assert.match(s.undo(w.id).skipped[0].why, /already undone/);
});

test('a move over an existing file: both come back', async () => {
  const s = createSnapshots(snapDir());
  fs.writeFileSync(P('src.txt'), 'new'); fs.writeFileSync(P('dst.txt'), 'old one');
  const m = await act(s, 'move_file', [{ path: P('src.txt'), role: 'from' }, { path: P('dst.txt'), role: 'to' }], () => fs.renameSync(P('src.txt'), P('dst.txt')));
  s.undo(m.id);
  assert.equal(read(P('src.txt')), 'new'); assert.equal(read(P('dst.txt')), 'old one');
});

test('a file someone changed after the AI is left as it is and reported', async () => {
  const s = createSnapshots(snapDir());
  fs.writeFileSync(P('общий.txt'), 'исходный');
  const a = await act(s, 'edit_block', [{ path: P('общий.txt') }], () => fs.writeFileSync(P('общий.txt'), 'правка ИИ'));
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(P('общий.txt'), 'правка человека, длиннее');
  const r = s.undo(a.id);
  assert.deepEqual(r.restored, []);
  assert.match(r.skipped[0].why, /changed after/);
  assert.equal(read(P('общий.txt')), 'правка человека, длиннее');
  // Inversion: the check is what keeps the person's text — without the later change, Undo works.
  const b = await act(s, 'edit_block', [{ path: P('общий.txt') }], () => fs.writeFileSync(P('общий.txt'), 'ещё правка ИИ'));
  assert.deepEqual(s.undo(b.id).restored, [P('общий.txt')]);
});

test('folder checks of the AI\'s Undo are honoured (read-only / excluded → nothing restored)', async () => {
  const s = createSnapshots(snapDir());
  fs.writeFileSync(P('ro.txt'), '1');
  const a = await act(s, 'write_file', [{ path: P('ro.txt') }], () => fs.writeFileSync(P('ro.txt'), '22'));
  const r = s.undo(a.id, { check: () => 'read-only folder' });
  assert.equal(r.restored.length, 0); assert.equal(read(P('ro.txt')), '22');
});

test('limits: a file over the size limit gets no copy ("no undo"); total MB and days prune the oldest', async () => {
  let lim = { enabled: true, days: 7, maxMb: 500, maxFileMb: 1 };
  let now = Date.now();
  const dir = snapDir();
  const s = createSnapshots(dir, { limits: () => lim, now: () => now });
  fs.writeFileSync(P('big.bin'), Buffer.alloc(2 * MB));
  const big = await act(s, 'write_file', [{ path: P('big.bin') }], () => fs.appendFileSync(P('big.bin'), 'x'));
  assert.equal(big.entries[0].noCopy, 'big');
  assert.equal(s.list()[0].noUndo, true);
  assert.match(s.undo(big.id).skipped[0].why, /no copy \(bigger than 1 MB\)/);
  // Total: two 0.6 MB copies with a 1 MB cap → the older one goes.
  lim = { ...lim, maxMb: 1 };
  fs.writeFileSync(P('m1.bin'), Buffer.alloc(0.6 * MB)); fs.writeFileSync(P('m2.bin'), Buffer.alloc(0.6 * MB));
  const a1 = await act(s, 'write_file', [{ path: P('m1.bin') }], () => fs.writeFileSync(P('m1.bin'), 'a'));
  now += 1000;
  const a2 = await act(s, 'write_file', [{ path: P('m2.bin') }], () => fs.writeFileSync(P('m2.bin'), 'b'));
  assert.equal(s.find(a1.id), null); assert.ok(s.find(a2.id));
  assert.equal(fs.existsSync(path.join(dir, a1.id)), false, 'its folder is gone too');
  // Days: older than the limit → removed at the next prune; a new instance reads what is left.
  now += 8 * 86400000;
  s.prune();
  assert.equal(s.count, 0);
  assert.equal(createSnapshots(dir, { limits: () => lim }).count, 0);
});

test('snapshots off → nothing is copied; a failed call leaves nothing behind', async () => {
  const dir = snapDir();
  const off = createSnapshots(dir, { limits: () => ({ enabled: false }) });
  assert.equal(await off.capture('write_file', [{ path: P('x.txt') }]), null);
  const s = createSnapshots(dir);
  fs.writeFileSync(P('y.txt'), 'y');
  const a = await s.capture('write_file', [{ path: P('y.txt') }]);
  assert.equal(s.commit(a, false), null);
  assert.deepEqual(fs.readdirSync(dir), []);
  // Nothing changed on disk (the engine refused): nothing to undo.
  const b = await s.capture('write_file', [{ path: P('y.txt') }]);
  assert.equal(s.commit(b, true), null);
});

test('kept across restarts (meta on disk) and broken leftovers are cleaned', async () => {
  const dir = snapDir();
  const s = createSnapshots(dir);
  fs.writeFileSync(P('z.txt'), '1');
  const a = await act(s, 'write_file', [{ path: P('z.txt') }], () => fs.writeFileSync(P('z.txt'), '2'), { task: { id: 'q1', title: 'Задача' }, label: P('z.txt') });
  fs.mkdirSync(path.join(dir, 'junk')); fs.writeFileSync(path.join(dir, 'junk', 'meta.json'), '{broken');
  const s2 = createSnapshots(dir);
  assert.equal(s2.count, 1);
  assert.equal(fs.existsSync(path.join(dir, 'junk')), false);
  assert.deepEqual(s2.list()[0].task, { id: 'q1', title: 'Задача' });
  assert.deepEqual(s2.undo(a.id).restored, [P('z.txt')]);
});

test('groups for "Undo AI changes": per queue task and per batch (gap < 5 min), newest first, undone left out', () => {
  const m = 60000;
  const list = [
    { id: 'a', t: 0, task: { id: 'q1', title: 'Фото' } }, { id: 'b', t: 1 * m, task: { id: 'q1', title: 'Фото' } },
    { id: 'c', t: 2 * m }, { id: 'd', t: 20 * m }, { id: 'e', t: 21 * m, undone: 1 },
  ];
  const g = undoGroups(list);
  assert.deepEqual(g.map((x) => [x.kind, x.ids]), [['batch', ['d']], ['batch', ['a', 'b', 'c']], ['task', ['a', 'b']]]);
});

test('B1-28: a copy taken before a change survives a crash before the commit (kept when the file did change)', () => {
  const dir = snapDir();
  const f = P('crash.txt');
  fs.writeFileSync(f, 'before');
  const s = createSnapshots(dir);
  return s.capture('write_file', [{ path: f }]).then((pend) => {
    fs.writeFileSync(f, 'after, then the bridge died');      // no commit()
    const again = createSnapshots(dir);                         // restart
    assert.equal(again.count, 1, 'kept');
    assert.deepEqual(again.undo(pend.id).restored, [f]);
    assert.equal(read(f), 'before');
    const unchanged = P('same.txt');
    fs.writeFileSync(unchanged, 'x');
    return createSnapshots(dir).capture('write_file', [{ path: unchanged }]).then(() => {
      assert.equal(createSnapshots(dir).list().filter((a) => a.paths.includes(unchanged)).length, 0, 'nothing changed: dropped');
    });
  });
});

test('X1-20 / X1-23: crash recovery never takes a later edit as "what the AI left", and leaves a live process\'s pending action alone', async () => {
  const dir = snapDir();
  const f = P('после-сбоя.txt');
  fs.writeFileSync(f, 'before');
  const pend = await createSnapshots(dir).capture('write_file', [{ path: f }]);
  fs.writeFileSync(f, 'the person edited it while the bridge was down');
  const late = new Date(pend.t + 60 * 60000); fs.utimesSync(f, late, late);
  const again = createSnapshots(dir);
  assert.equal(again.count, 1, 'kept (the file did change)');
  assert.match(again.undo(pend.id).skipped[0].why, /changed after/);
  assert.equal(read(f), 'the person edited it while the bridge was down');
  // Another bridge process (alive) has a pending action: not finished, not removed by this start.
  const meta = path.join(dir, pend.id, 'meta.json');
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  fs.writeFileSync(meta, JSON.stringify({ ...m, pending: true, pid: process.ppid }));
  const third = createSnapshots(dir);
  assert.equal(third.find(pend.id), null, 'not taken over');
  assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).pending, true, 'left as it was');
});

test('YB-7: a pending action is another bridge\'s only when pid AND start time match; a delegated run gets its own time limit', async () => {
  const dir = snapDir();
  const f = P('чужой-pid.txt');
  fs.writeFileSync(f, 'before');
  const pend = await createSnapshots(dir).capture('write_file', [{ path: f }]);
  fs.writeFileSync(f, 'the AI wrote this');
  const meta = path.join(dir, pend.id, 'meta.json');
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  assert.equal(m.pending, true); assert.ok(Number.isFinite(m.started), 'start time recorded');
  const asOther = (o) => fs.writeFileSync(meta, JSON.stringify({ ...m, pid: process.ppid, ...o }));
  // Same pid, same start time: that bridge is still running → left alone.
  asOther({ started: 5000000 });
  const s0 = createSnapshots(dir, { startOf: async () => 5003000 });
  await s0.ready;
  assert.equal(s0.find(pend.id), null, 'live owner: not taken over');
  assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).pending, true);
  // Same pid, other start time (pid reused by an unrelated program) → recovered as a crashed action,
  // after startup (the start time is read asynchronously).
  let release;
  const s1 = createSnapshots(dir, { startOf: () => new Promise((r) => { release = () => r(9000000); }) });
  assert.equal(s1.find(pend.id), null, 'not decided before the start time is known');
  release(); await s1.ready;
  assert.ok(s1.find(pend.id), 'reused pid: recovered');
  assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).pending, undefined);
  // ZB-1: start time cannot be read (slow / timed out / denied) → maybe still that bridge → left alone.
  for (const startOf of [async () => null, async () => { throw new Error('denied'); }]) {
    asOther({ started: 5000000, pending: true });
    const s3 = createSnapshots(dir, { startOf });
    await s3.ready;
    assert.equal(s3.find(pend.id), null, 'unknown start: not taken over');
    assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).pending, true, 'meta left as it was');
  }
  // Delegated run: an agent change 2 h after the start is still "what the AI left" (not the 10-min rule).
  fs.writeFileSync(f, 'the agent wrote this late');
  const late = new Date(m.t + 120 * 60000); fs.utimesSync(f, late, late);
  fs.writeFileSync(meta, JSON.stringify({ ...m, tool: 'delegate', pid: 0, maxMs: 245 * 60000 }));
  const s2 = createSnapshots(dir);
  assert.equal(s2.find(pend.id).entries[0].after.kind, 'file', 'within the run\'s own limit');
  // A plain call: the same late change stays unknown (the person's edit).
  fs.writeFileSync(meta, JSON.stringify({ ...m, pid: 0 }));
  assert.equal(createSnapshots(dir).find(pend.id).entries[0].after.kind, 'unknown');
  // An older delegate meta without maxMs: the longest run (240 min) is assumed.
  fs.writeFileSync(meta, JSON.stringify({ ...m, tool: 'delegate', pid: 0 }));
  assert.equal(createSnapshots(dir).find(pend.id).entries[0].after.kind, 'file');
});

test('YB-7: procStart reads a live process\'s start time (Windows), null for a missing pid', { skip: process.platform !== 'win32' }, async () => {
  const { procStart } = await import('../src/undo.mjs');
  const p = procStart(process.pid);
  assert.ok(p instanceof Promise, 'async: never blocks the event loop');
  const t = await p;
  assert.ok(Math.abs(t - (Date.now() - process.uptime() * 1000)) < 10000, `own start ${t}`);
  assert.equal(await procStart(0x7ffffff0), null);
});

test('W-1: deferred recovery never takes a newer action\'s result as the older action\'s after-state', async () => {
  const dir = snapDir();
  const f = P('w1.txt'), g = P('w1-old.txt');
  fs.writeFileSync(f, 'before'); fs.writeFileSync(g, 'before');
  const pend = await createSnapshots(dir).capture('write_file', [{ path: f }, { path: g }]);
  fs.writeFileSync(f, 'old bridge wrote'); fs.writeFileSync(g, 'old bridge wrote');
  const old = new Date(Date.now() - 60000); fs.utimesSync(g, old, old); // before this bridge started
  const meta = path.join(dir, pend.id, 'meta.json');
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  fs.writeFileSync(meta, JSON.stringify({ ...m, pid: process.ppid, started: 5000000 }));
  let release;
  // selfStart in the future: only the "captured since" rule can make f unknown here.
  const s = createSnapshots(dir, { selfStart: Date.now() + 3600000, startOf: () => new Promise((r) => { release = () => r(9000000); }) });
  // This bridge acts on f before the deferred check ends.
  const newer = await act(s, 'write_file', [{ path: f }], () => fs.writeFileSync(f, 'new action'));
  release(); await s.ready;
  const r = s.find(pend.id);
  assert.equal(r.entries[0].after.kind, 'unknown', 'path captured by this bridge since');
  assert.equal(r.entries[1].after.kind, 'file', 'untouched old change: still undoable');
  assert.equal(s.undo(pend.id).skipped.length > 0, true, 'older undo never puts the old copy over the newer result');
  assert.equal(read(f), 'new action');
  assert.ok(s.find(newer.id));
  // A file changed after this bridge started (not through a capture) is unknown too.
  fs.writeFileSync(meta, JSON.stringify({ ...m, pid: process.ppid, started: 5000000 }));
  const s2 = createSnapshots(dir, { selfStart: Date.now() - 30000, startOf: async () => 9000000 });
  await s2.ready;
  assert.equal(s2.find(pend.id).entries[0].after.kind, 'unknown');
});

test('W-2/W-3/W-4: deferred pushes are pruned; a left-alone meta older than the days limit is removed; a changed meta is not taken', async () => {
  const dir = snapDir();
  const f = P('w2.txt');
  fs.writeFileSync(f, 'before');
  const pend = await createSnapshots(dir).capture('write_file', [{ path: f }]);
  fs.writeFileSync(f, 'x');
  const meta = path.join(dir, pend.id, 'meta.json');
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  const oldT = Date.now() - 30 * 86400000;
  // W-2: recovered after startup but older than the days limit → pruned.
  fs.writeFileSync(meta, JSON.stringify({ ...m, t: oldT, pid: process.ppid, started: 5000000 }));
  const s = createSnapshots(dir, { startOf: async () => 9000000 });
  await s.ready;
  assert.equal(s.find(pend.id), null, 'pruned');
  assert.equal(fs.existsSync(path.join(dir, pend.id)), false);
  // W-3: unknown start time / no start time recorded, older than days → removed, not kept forever.
  for (const o of [{ started: 5000000 }, { started: undefined }]) {
    fs.mkdirSync(path.join(dir, pend.id), { recursive: true });
    fs.writeFileSync(meta, JSON.stringify({ ...m, t: oldT, pid: process.ppid, ...o }));
    const s3 = createSnapshots(dir, { startOf: async () => null });
    await s3.ready;
    assert.equal(fs.existsSync(path.join(dir, pend.id)), false, `expired left-alone meta removed (${JSON.stringify(o)})`);
  }
  // Recent and unknown: still left alone.
  fs.mkdirSync(path.join(dir, pend.id), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ ...m, pid: process.ppid, started: 5000000 }));
  await createSnapshots(dir, { startOf: async () => null }).ready;
  assert.equal(JSON.parse(fs.readFileSync(meta, 'utf8')).pending, true);
  // W-4: the owner committed (or the meta changed) while the start time was read → not taken over.
  let release;
  const s4 = createSnapshots(dir, { startOf: () => new Promise((r) => { release = () => r(9000000); }) });
  const { pending, pid, started, ...committed } = { ...m, pid: process.ppid, started: 5000000 };
  fs.writeFileSync(meta, JSON.stringify({ ...committed, entries: m.entries.map((e) => ({ ...e, after: { kind: 'none' } })) }));
  release(); await s4.ready;
  assert.equal(s4.find(pend.id), null, 'committed by its owner: not in this bridge\'s list');
});
