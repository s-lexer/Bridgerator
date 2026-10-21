// confirm.ini can't lower protection by itself, whatever happens to the file (broken, missing,
// replaced, edited from a script). LOGIC: critical-logic/bridge.md §2a.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGate, readSettings, readSettingsStrict, setIni, ensureIni, restoreIni, writeIniFrom, approvedFile, findMatch, COOLDOWN_MS } from '../src/confirm.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-cini-'));
let n = 0;
const onIni = (extra = []) => { const f = path.join(dir, `c${++n}.ini`); ensureIni(f); setIni(f, 'confirm', 'enabled', 'true'); for (const [s, k, v] of extra) setIni(f, s, k, v); return f; };
const asker = (answers = []) => { const seen = []; return { seen, ask: async (q) => { seen.push(q); return answers.length ? answers.shift() : 'deny'; } }; };
const DEL = ['start_process', { command: 'Remove-Item C:\\Работа\\старое -Recurse' }];

test('a broken confirm.ini never turns protection off: garbage, empty, BOM only, UTF-16, no [confirm], enabled = maybe, a folder', async () => {
  const bad = ['garbage', '', '\ufeff', Buffer.from('\ufeff[confirm]\r\nenabled = false\r\n', 'utf16le'), '[ask]\ndelete = false\n', '[confirm]\nenabled = maybe\n', `[confirm]\n${'x'.repeat(2e6)}\n`];
  for (const content of bad) {
    const f = onIni();
    const { ask, seen } = asker();
    const g = createGate({ ini: f, ask });
    fs.writeFileSync(f, content);
    assert.equal(g.mode(), 'on', JSON.stringify(String(content).slice(0, 30)));
    assert.equal((await g.gate(...DEL)).notConfirmed, true, 'still asks before deleting');
    assert.equal(seen.length, 1, 'only the deletion question, no "file changed" prompt');
  }
  const f = onIni(); const g = createGate({ ini: f, ask: async () => 'deny' });
  fs.rmSync(f); fs.mkdirSync(f);
  assert.equal(g.mode(), 'on', 'confirm.ini replaced by a folder');
});

test('confirm.ini parsing: BOM, CRLF / LF, duplicate keys (last wins), comments, case', () => {
  const f = path.join(dir, 'parse.ini');
  fs.writeFileSync(f, '\ufeff; c\r\n[Confirm]\r\nEnabled = TRUE\r\ntimeout_seconds = 5\r\n[ask]\ndelete = off\ndelete = yes\n# x\nwrite_files=1\n');
  const s = readSettingsStrict(f);
  assert.equal(s.enabled, true);
  assert.equal(s.timeoutSec, 120, 'out-of-range timeout → default');
  assert.equal(s.ask.delete, true); assert.equal(s.ask.write_files, true);
  assert.equal(readSettings(path.join(dir, 'nope.ini')).enabled, false, 'missing = defaults (off) at first start');
});

test('the gate keeps the last applied state when the file is missing or deleted while running', async () => {
  const f = onIni();
  const g = createGate({ ini: f, ask: async () => 'deny' });
  fs.rmSync(f);
  assert.equal(g.mode(), 'on');
  assert.equal((await g.gate(...DEL)).notConfirmed, true);
  const g2 = createGate({ ini: path.join(dir, 'never.ini'), ask: async () => assert.fail('off: no question') });
  assert.equal(await g2.gate(...DEL), null, 'never had a file: default off');
});

test('V-1: a deleted confirm.ini never means "off": recreated with the applied state while running, at a restart and at setup', async () => {
  const f = onIni([['ask', 'write_files', 'true'], ['patterns', 'pattern1', '\\bgit\\s+push\\b']]);
  const g = createGate({ ini: f, ask: async () => 'deny' });
  assert.ok(fs.existsSync(approvedFile(f)), 'the applied state is kept next to the file');
  fs.rmSync(f);
  assert.equal(g.mode(), 'on');
  assert.ok(fs.existsSync(f), 'recreated while running');
  assert.equal(readSettingsStrict(f).enabled, true); assert.equal(readSettingsStrict(f).ask.write_files, true);
  assert.deepEqual(readSettingsStrict(f).patterns.map((r) => r.source), ['\\bgit\\s+push\\b']);
  // Restart (bridge start / reinstall): the file is gone again before the new gate starts.
  fs.rmSync(f);
  const { ask, seen } = asker();
  const g2 = createGate({ ini: f, ask });
  assert.equal(g2.mode(), 'on', 'restart: protection stays on');
  assert.equal((await g2.gate(...DEL)).notConfirmed, true); assert.equal(seen.length, 1);
  assert.equal(readSettingsStrict(f).enabled, true, 'recreated at start with the applied state');
  // Setup / CLI (restoreIni before the bridge starts): from the applied state, not the "off" template.
  fs.rmSync(f);
  assert.equal(restoreIni(f), true);
  assert.equal(readSettingsStrict(f).enabled, true); assert.equal(readSettingsStrict(f).ask.delete, true);
  assert.equal(restoreIni(f), false, 'an existing file is left as it is');
  // Never applied (fresh install): the product defaults (confirmations off), file created.
  const fresh = path.join(dir, 'fresh.ini');
  assert.equal(createGate({ ini: fresh, ask: async () => 'deny' }).mode(), 'off');
  assert.equal(readSettingsStrict(fresh).enabled, false);
  // Turned off by the person → the copy follows: a later deletion recreates "off".
  const g3 = createGate({ ini: fresh, ask: async () => 'deny' });
  g3.accept({ enabled: true }); fs.rmSync(fresh);
  assert.equal(createGate({ ini: fresh, ask: async () => 'deny' }).mode(), 'on');
});

test('removing your own pattern asks; Keep writes it back, so the question is not repeated on every call', async () => {
  const f = onIni([['patterns', 'pattern1', '\\bgit\\s+push\\b']]);
  const { ask, seen } = asker(['deny']);
  const g = createGate({ ini: f, ask });
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^pattern1 = .*$/m, ''));
  g.mode(); await g.idle();
  assert.match(seen[0]?.text || '', /your own patterns/);
  assert.ok(readSettings(f).patterns.some((r) => r.test('git push')), 'Keep restored the pattern in the file');
  g.mode(); await g.idle(); g.mode(); await g.idle();
  assert.equal(seen.length, 1, 'no new "file changed" question after Keep');
  assert.equal((await g.gate('start_process', { command: 'git push origin' })).notConfirmed, true, 'the pattern still asks');
});

test('Allow always on a pattern question does not write the ini; an unknown or timed-out answer = deny', async () => {
  const f = onIni([['patterns', 'pattern1', '\\bgit\\s+push\\b']]);
  const before = fs.readFileSync(f, 'utf8');
  const { ask, seen } = asker(['allow', 'format-c', 'deny']);
  const g = createGate({ ini: f, ask });
  assert.equal(await g.gate('start_process', { command: 'git push' }), null);
  assert.ok(!seen[0].buttons.some((b) => b[0] === 'always'), '"Allow always" is not offered for your own patterns');
  assert.equal(fs.readFileSync(f, 'utf8'), before, 'the ini is untouched');
  assert.equal((await g.gate(...DEL)).notConfirmed, true, 'unknown key from the helper = deny');
  assert.equal(findMatch('start_process', { command: 'git push' }, readSettings(f).ask, readSettings(f).patterns).cat, 'pattern');
});

test('request_confirm_off: cool-down after Deny is 10 minutes, then it may ask again', async () => {
  let t = 0;
  const f = onIni();
  const { ask, seen } = asker(['deny', 'deny']);
  const g = createGate({ ini: f, ask, now: () => t });
  await g.tool('request_confirm_off');
  t += COOLDOWN_MS - 1;
  assert.match((await g.tool('request_confirm_off')).content[0].text, /said no a few minutes ago/);
  t += 2;
  await g.tool('request_confirm_off');
  assert.equal(seen.length, 2);
  assert.equal(readSettings(f).enabled, true);
});

test('"bridgerator.cmd confirm off" while the bridge runs is applied only after Apply on the PC', async () => {
  const home = path.join(dir, 'cli-home');
  fs.mkdirSync(home);
  const ini = path.join(home, 'confirm.ini');
  ensureIni(ini); setIni(ini, 'confirm', 'enabled', 'true');
  const { ask, seen } = asker(['deny', 'allow']);
  const off = [];
  const g = createGate({ ini, ask, onTurnedOff: (w) => off.push(...w) });
  const cli = () => spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'confirm', 'off', '--home', home], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const r = cli();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readSettings(ini).enabled, false, 'the command wrote the file');
  assert.equal(g.mode(), 'on', 'not applied yet');
  await g.idle();
  assert.match(seen[0].head, /settings file changed/);
  assert.equal(readSettings(ini).enabled, true, 'Keep wrote the applied state back');
  assert.equal(cli().status, 0);
  g.mode(); await g.idle();
  assert.equal(g.mode(), 'off', 'Apply took it');
  assert.deepEqual(off, ['confirmations']);
});

// VR-1/2/4/8/9/13 + VR-7/11/12: a recreated confirm.ini is ONE atomic write of the full text built in
// memory from the applied / approved state — a failing write leaves the file absent or as it was,
// never the confirmations-OFF template.
const renamesTo = (f, fn) => { const real = fs.renameSync; let n = 0; const m = mock.method(fs, 'renameSync', (a, b) => { if (b === f) n++; return real(a, b); }); try { fn(); } finally { m.mock.restore(); } return n; };
const failRename = (f, code, fn) => { const real = fs.renameSync; let n = 0; const m = mock.method(fs, 'renameSync', (a, b) => { if (b === f) { n++; const e = new Error(code); e.code = code; throw e; } return real(a, b); }); try { fn(); } finally { m.mock.restore(); } return n; };

test('VR-1: confirm.ini is recreated in one write from the approved state; a failed write never leaves the OFF template', async () => {
  const f = onIni([['ask', 'write_files', 'true'], ['patterns', 'pattern1', '\\bgit\\s+push\\b']]);
  createGate({ ini: f, ask: async () => 'deny' }); // approved = on + write_files + the pattern
  fs.rmSync(f);
  assert.equal(renamesTo(f, () => assert.equal(restoreIni(f), true)), 1, 'restoreIni: one write');
  const s = readSettingsStrict(f);
  assert.equal(s.enabled, true); assert.equal(s.ask.write_files, true); assert.deepEqual(s.patterns.map((r) => r.source), ['\\bgit\\s+push\\b']);
  // writeIniFrom over an existing file: one write too, and a failure keeps the old text.
  const before = fs.readFileSync(f, 'utf8');
  assert.equal(renamesTo(f, () => writeIniFrom(f, { ...s, ask: { ...s.ask, move: true } })), 1, 'writeIniFrom: one write');
  const old = fs.readFileSync(f, 'utf8');
  assert.notEqual(old, before);
  assert.throws(() => failRename(f, 'EIO', () => writeIniFrom(f, { ...s, enabled: false })));
  assert.equal(fs.readFileSync(f, 'utf8'), old, 'failed write: the file as it was');
  // Failing recreation (restoreIni and the running gate): the file stays absent, never "off".
  fs.rmSync(f);
  assert.throws(() => failRename(f, 'EIO', () => restoreIni(f)));
  assert.equal(fs.existsSync(f), false, 'failed restoreIni: absent, not the template');
  const g = createGate({ ini: f, ask: async () => 'deny' });
  fs.rmSync(f);
  failRename(f, 'EIO', () => assert.equal(g.mode(), 'on'));
  assert.equal(fs.existsSync(f), false, 'failed restore while running: absent');
  assert.deepEqual(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')), [], 'no temp file left');
  // Restart: protection from the approved state, file recreated with it.
  const g2 = createGate({ ini: f, ask: async () => 'deny' });
  assert.equal(g2.mode(), 'on');
  assert.equal(readSettingsStrict(f).enabled, true); assert.equal(readSettingsStrict(f).ask.move, false, 'approved state, not a lost write');
});

test('VR-7/11/12: setIni on a missing confirm.ini (window, tray toggle, Allow always) recreates the approved state in the same write', () => {
  const f = onIni([['ask', 'write_files', 'true']]);
  createGate({ ini: f, ask: async () => 'deny' });
  fs.rmSync(f);
  assert.equal(renamesTo(f, () => setIni(f, 'ask', 'move', 'true')), 1, 'one write');
  const s = readSettingsStrict(f);
  assert.equal(s.enabled, true, 'not the OFF template'); assert.equal(s.ask.write_files, true); assert.equal(s.ask.move, true);
  // Nothing approved yet (fresh install): the template, as before.
  const fresh = path.join(dir, 'fresh-set.ini');
  setIni(fresh, 'ask', 'move', 'true');
  assert.equal(readSettingsStrict(fresh).enabled, false); assert.equal(readSettingsStrict(fresh).ask.move, true);
});

test('VR-1: at start a confirm.ini weaker than the approved state asks (Apply / Keep), a stronger one applies at once', async () => {
  const f = onIni();
  createGate({ ini: f, ask: async () => 'deny' }); // approved: on
  setIni(f, 'confirm', 'enabled', 'false');        // edited while the bridge was stopped
  const { ask, seen } = asker(['deny']);
  const g = createGate({ ini: f, ask });
  assert.equal(g.mode(), 'on', 'not taken silently at start');
  await g.idle();
  assert.match(seen[0]?.text || '', /Turn off confirmations/);
  assert.equal(readSettingsStrict(f).enabled, true, 'Keep wrote the applied state back');
  setIni(f, 'confirm', 'enabled', 'false');
  const off = [];
  const g2 = createGate({ ini: f, ask: async () => 'allow', onTurnedOff: (w) => off.push(...w) });
  g2.mode(); await g2.idle();
  assert.equal(g2.mode(), 'off', 'Apply takes it'); assert.deepEqual(off, ['confirmations']);
  setIni(f, 'confirm', 'enabled', 'true'); setIni(f, 'ask', 'move', 'true'); // stronger
  const g3 = createGate({ ini: f, ask: async () => assert.fail('raising needs no question') });
  assert.equal(g3.mode(), 'on'); assert.equal(g3.settings().ask.move, true);
});

test('VR-3: a failing confirm.approved / confirm.ini write is retried at most once a minute and blocks at most once', () => {
  let t = 1e9;
  const f = onIni(), a = approvedFile(f);
  const real = fs.renameSync, hits = { [f]: 0, [a]: 0 };
  const m = mock.method(fs, 'renameSync', (x, y) => { if (y in hits) { hits[y]++; const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return real(x, y); });
  try {
    const g = createGate({ ini: f, now: () => t, ask: async () => 'deny' });
    assert.equal(hits[a], 41, 'first try waits for the lock (~1 s)');
    fs.rmSync(f);
    for (let i = 0; i < 20; i++) g.mode();
    assert.equal(hits[a], 41, 'no retry within the minute');
    assert.equal(hits[f], 41, 'restore: one waiting try, then nothing within the minute');
    t += 61 * 1000;
    for (let i = 0; i < 20; i++) g.mode();
    assert.equal(hits[a], 42, 'after a minute: one try, no wait');
    assert.equal(hits[f], 42);
  } finally { m.mock.restore(); }
  assert.equal(fs.existsSync(f), false);
});

test('confirm.approved held by another program (unreadable, not missing) fails CLOSED: full protection, never "nothing applied"', async () => {
  const { readApproved } = await import('../src/confirm.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-appr-')), ini = path.join(dir, 'confirm.ini');
  assert.equal(readApproved(ini), null, 'missing = nothing applied yet');
  fs.mkdirSync(path.join(dir, 'confirm.approved')); // a read error other than ENOENT (EISDIR)
  const s = readApproved(ini);
  assert.equal(s.enabled, true);
  assert.ok(Object.values(s.ask).every(Boolean));
  fs.rmSync(dir, { recursive: true, force: true });
});
