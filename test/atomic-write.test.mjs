// Atomic writes (temp file + rename) of queue.json, config.json and confirm.ini on Windows: another
// program (antivirus, indexer, backup, an editor) may hold the target file for a moment; rename then
// fails with EPERM / EBUSY / EACCES. Seen in the full test run under load (queue.test: "317 !== 500",
// "EPERM: operation not permitted, rename …queue.json.<pid>.tmp -> …queue.json"). The write must wait
// for the file instead of failing the chat's call halfway (a bulk queue_add, Apply of settings).
// LOGIC: see critical-logic/bridge.md §2a (atomic writes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { POWERSHELL, psArgs } from '../src/win.mjs';
import { writeAtomic, setIni, ensureIni, readSettings } from '../src/confirm.mjs';
import { createQueue } from '../src/queue.mjs';

const NOT_WIN = process.platform === 'win32' ? false : 'Windows sharing modes only (NOT CHECKED here)';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-atomic-'));

/** Another program holds `file` open (read sharing only, no delete sharing) for `ms`. → resolves once it holds it. */
function holdFile(file, ms) {
  const script = `$f = [IO.File]::Open($env:PST_FILE, 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep -Milliseconds ${ms}; $f.Dispose(); 'released'`;
  const p = spawn(POWERSHELL, psArgs(script), { windowsHide: true, env: { ...process.env, PST_FILE: file } });
  const done = new Promise((r) => p.on('exit', r));
  return new Promise((resolve, reject) => {
    p.stdout.on('data', (b) => { if (/held/.test(String(b))) resolve({ done }); });
    p.on('error', reject);
  });
}

test('queue.json held by another program for a moment: adding a task waits for it instead of failing', { skip: NOT_WIN }, async () => {
  const file = path.join(dir, 'queue.json');
  const q = createQueue(file);
  q.add({ title: 'первая задача' });
  const h = await holdFile(file, 400);
  const t = Date.now();
  q.add({ title: 'вторая задача, пока файл занят' });
  assert.ok(Date.now() - t >= 100, 'it really had to wait');
  await h.done;
  assert.deepEqual(createQueue(file).list().map((x) => x.title), ['первая задача', 'вторая задача, пока файл занят']);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no temp file left');
});

test('config.json / confirm.ini held for a moment: writeAtomic and setIni wait; a file that stays locked is reported, no temp left', { skip: NOT_WIN }, async () => {
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, '{}');
  let h = await holdFile(cfg, 300);
  writeAtomic(cfg, JSON.stringify({ theme: 'dark' }));
  await h.done;
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { theme: 'dark' });
  const ini = path.join(dir, 'confirm.ini');
  ensureIni(ini);
  h = await holdFile(ini, 300);
  setIni(ini, 'confirm', 'enabled', 'true');
  await h.done;
  assert.equal(readSettings(ini).enabled, true);
  h = await holdFile(cfg, 5000);           // held far longer than any retry
  assert.throws(() => writeAtomic(cfg, '{"x":1}'), /EPERM|EBUSY|EACCES/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'the temp file is removed after a failed write');
  await h.done;
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, 'utf8')), { theme: 'dark' }, 'the old file is intact');
});
