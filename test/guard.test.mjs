// Mass-action fuse and keep-awake decisions (guard.mjs), the helper's power report (tray link).
// LOGIC: critical-logic/bridge.md ("Mass-action fuse", "Keep awake").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFuse, wantAwake, countFiles, AWAKE_AFTER_MS, AWAKE_QUEUE_MS } from '../src/guard.mjs';
import { createLink } from '../src/tray.mjs';

test('fuse: up to the limit per minute passes; one more trips; old hits fall out of the minute', () => {
  let now = 0;
  const f = createFuse({ now: () => now });
  for (let i = 0; i < 20; i++) assert.equal(f.take(1, 20), 0, `#${i + 1}`);
  assert.equal(f.take(1, 20), 21, 'the 21st trips and reports the total');
  assert.equal(f.count(), 20, 'a tripped action is not counted');
  assert.equal(f.take(5, 30), 0);
  assert.equal(f.take(6, 30), 31, 'a batch of deletions counts all its items');
  now += 61000;
  assert.equal(f.count(), 0);
  assert.equal(f.take(20, 20), 0);
  f.reset();
  assert.equal(f.count(), 0);
});

test('keep awake: while a call runs, 2 min after, 10 min while the queue has work; never when off', () => {
  const now = 1e9;
  assert.equal(wantAwake({ inFlight: 1, now }), true);
  assert.equal(wantAwake({ inFlight: 0, lastCall: 0, now }), false, 'nothing ran since start');
  assert.equal(wantAwake({ lastCall: now - AWAKE_AFTER_MS + 1000, now }), true);
  assert.equal(wantAwake({ lastCall: now - AWAKE_AFTER_MS - 1000, now }), false);
  assert.equal(wantAwake({ lastCall: now - AWAKE_AFTER_MS - 1000, queue: { todo: 3 }, now }), true, 'queue work: ChatGPT thinks between calls');
  assert.equal(wantAwake({ lastCall: now - AWAKE_QUEUE_MS - 1000, queue: { todo: 3, doing: 1 }, now }), false, 'a queue nobody works on does not hold the PC up');
  assert.equal(wantAwake({ enabled: false, inFlight: 5, now }), false);
});

test('tray link: the helper\'s power report reaches the bridge; the state carries awake', () => {
  const sent = [], got = [];
  const l = createLink((x) => sent.push(JSON.parse(x)), { onPower: (p) => got.push(p) });
  l.onLine(JSON.stringify({ t: 'power', on: true, ac: true }));
  l.onLine(JSON.stringify({ t: 'power', on: false, ac: false }));
  l.onLine(JSON.stringify({ t: 'power', on: 'yes' }));
  assert.deepEqual(got, [{ on: true, ac: true }, { on: false, ac: false }, { on: false, ac: true }]);
  l.state({ state: 'online', awake: true });
  assert.equal(sent.at(-1).awake, true);
});

test('fuse counts files: a folder = the entries under it, subfolders too (up to the cap), a file = 1, a missing path = 1', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-fuse-'));
  fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
  for (const f of ['1', 'a/2', 'a/b/3', 'a/b/4']) fs.writeFileSync(path.join(d, f), 'x');
  assert.equal(countFiles([d], 100), 6);   // 4 files + 2 folders
  assert.equal(countFiles([d], 3), 3);
  assert.equal(countFiles([path.join(d, '1'), path.join(d, 'gone')], 100), 2);
  assert.equal(countFiles([path.join(d, 'a', 'b')], 100), 2);
  fs.mkdirSync(path.join(d, 'e', 'f', 'g'), { recursive: true }); assert.equal(countFiles([path.join(d, 'e')], 100), 2, 'empty folders count: the walk stays bounded');
  fs.rmSync(d, { recursive: true, force: true });
});
