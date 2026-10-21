// Recycle Bin instead of a permanent delete: which terminal commands Bridgerator can do itself
// (parseDelete) and which run as written. LOGIC: critical-logic/bridge.md ("Recycle Bin").
// The real Recycle Bin (recycle.ps1) is touched only by one temp file it recycles and removes again (X1-3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDelete } from '../src/recycle.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-recycle-'));
const work = path.join(root, 'Рабочий стол');
const sub = path.join(work, 'Старые фото');
fs.mkdirSync(sub, { recursive: true });
fs.mkdirSync(path.join(work, 'Пустая'));
for (const f of ['отчёт 2025.docx', 'a.tmp', 'b.tmp', 'readme.txt', '@list.txt', 'x;y.txt']) fs.writeFileSync(path.join(work, f), 'x');
fs.writeFileSync(path.join(sub, '1.jpg'), 'x');
const P = (...x) => path.join(work, ...x);

test('one plain delete statement → Bridgerator moves exactly those items (quotes, spaces, Cyrillic, lists)', () => {
  const cases = [
    [`Remove-Item "${P('отчёт 2025.docx')}"`, [P('отчёт 2025.docx')]],
    [`Remove-Item -LiteralPath '${P('отчёт 2025.docx')}' -Force`, [P('отчёт 2025.docx')]],
    [`Remove-Item -Path "${P('a.tmp')}", "${P('b.tmp')}" -Force -Confirm:$false`, [P('a.tmp'), P('b.tmp')]],
    [`del /q "${P('readme.txt')}"`, [P('readme.txt')]],
    [`cmd /c del /f /q "${P('readme.txt')}"`, [P('readme.txt')]],
    [`rd /s /q "${sub}"`, [sub]],
    [`rmdir "${P('Пустая')}"`, [P('Пустая')]],
    [`rm -rf "${sub}"`, [sub]],
    [`Remove-Item -Recurse -Force "${sub}" -ErrorAction SilentlyContinue`, [sub]],
    ['Remove-Item a.tmp', [P('a.tmp')]],                                   // relative: the terminal's folder
  ];
  for (const [cmd, want] of cases) assert.deepEqual(parseDelete(cmd, work)?.targets, want, cmd);
});

test('a wildcard in the last part is expanded the way the command would; del skips folders', () => {
  assert.deepEqual(parseDelete(`del "${P('*.tmp')}"`, work).targets.sort(), [P('a.tmp'), P('b.tmp')]);
  assert.deepEqual(parseDelete('Remove-Item *.tmp', work).targets.sort(), [P('a.tmp'), P('b.tmp')]);
  assert.equal(parseDelete('Remove-Item *', work), null, 'a non-empty folder matched without -Recurse: run as written');
  assert.equal(parseDelete(`del "${P('*.nothing')}"`, work), null, 'nothing matches: the command reports it itself');
});

test('anything Bridgerator cannot read for sure runs as written (null)', () => {
  for (const cmd of [
    `Remove-Item "${P('a.tmp')}"; Remove-Item "${P('b.tmp')}"`,       // two statements
    `Get-ChildItem *.tmp | Remove-Item`,                                // pipeline
    `Remove-Item $env:TEMP\\x`, `del %TEMP%\\x`, 'Remove-Item $f',     // variables
    `Remove-Item "${P('a.tmp')}" && echo ok`,
    `Remove-Item -Include *.tmp "${work}"`,                             // a flag we don't know
    `del /s *.tmp`,                                                     // every subfolder
    `Remove-Item "${sub}"`,                                             // folder without -Recurse
    `del "${sub}"`,                                                     // del of a folder deletes the files inside
    `rd "${P('a.tmp')}"`,                                               // rd of a file fails anyway
    `Remove-Item "${P('missing.txt')}"`,                                // missing: let it fail as usual
    `Remove-Item \\\\server\\share\\x`, 'Remove-Item "photo [1].jpg"', 'Copy-Item a b', 'python -c "import os; os.remove(1)"',
    `Remove-Item "${P('a.tmp')}`,                                       // unbalanced quote
    'Remove-Item @list.txt', 'del x;y.txt',                             // splatting / a second statement, even if such files exist
    '', 'x'.repeat(5000),
  ]) assert.equal(parseDelete(cmd, work), null, cmd);
});

test('B1-20: wildcard matches carry what the command itself would skip (hidden / system / read-only); rd takes no wildcard', () => {
  assert.deepEqual(Object.values(parseDelete(`del "${P('*.tmp')}"`, work).skip), ['hsr', 'hsr']);
  assert.equal(parseDelete(`del /f /a "${P('*.tmp')}"`, work).skip, undefined, '/f /a: everything, like the command');
  assert.deepEqual(Object.values(parseDelete(`del /f "${P('*.tmp')}"`, work).skip), ['hs', 'hs']);
  assert.deepEqual(Object.values(parseDelete('Remove-Item *.tmp', work).skip), ['hsr', 'hsr']);
  assert.equal(parseDelete('Remove-Item *.tmp -Force', work).skip, undefined);
  assert.equal(parseDelete(`Remove-Item "${P('a.tmp')}"`, work).skip, undefined, 'a named item is not skipped');
  assert.equal(parseDelete('rd /s /q Ста*', work), null);
  assert.equal(parseDelete('del /a:h *.tmp', work), null, 'attribute filters run as written');
});

test('VM11-11: Undo of a delete takes the item out of the Recycle Bin (this user\'s $I/$R pair)', async () => {
  const { purgeFromBin, readBinInfo } = await import('../src/recycle.mjs');
  const bin = path.join(root, '$Recycle.Bin'), sid = path.join(bin, 'S-1-5-21-1');
  fs.mkdirSync(sid, { recursive: true });
  const info = (p, ms) => {
    const name = Buffer.from(`${p}\0`, 'utf16le');
    const b = Buffer.alloc(28 + name.length);
    b.writeBigInt64LE(2n, 0); b.writeBigInt64LE(1n, 8); b.writeBigInt64LE(BigInt(ms + 11644473600000) * 10000n, 16); b.writeUInt32LE(p.length + 1, 24); name.copy(b, 28);
    return b;
  };
  const target = P('отчёт 2025.docx'), t = Date.now();
  fs.writeFileSync(path.join(sid, '$IABC123.docx'), info(target, t + 10)); fs.writeFileSync(path.join(sid, '$RABC123.docx'), 'x');
  fs.writeFileSync(path.join(sid, '$IOLD000.docx'), info(target, t - 3600000)); fs.writeFileSync(path.join(sid, '$ROLD000.docx'), 'old');
  assert.equal(readBinInfo(fs.readFileSync(path.join(sid, '$IABC123.docx'))).path, target);
  // X1-3: the person deleted the same path again later (a newer bin entry): only the recorded copy goes.
  fs.writeFileSync(path.join(sid, '$INEW999.docx'), info(target, t + 5000)); fs.writeFileSync(path.join(sid, '$RNEW999.docx'), 'person');
  assert.deepEqual(purgeFromBin([{ path: target, bin: path.join(sid, '$RABC123.docx') }]), [target]);
  assert.deepEqual(fs.readdirSync(sid).sort(), ['$INEW999.docx', '$IOLD000.docx', '$RNEW999.docx', '$ROLD000.docx'], 'only the item of this delete');
  assert.deepEqual(purgeFromBin([{ path: P('nothing.txt'), bin: path.join(sid, '$RNEW999.docx') }]), [], 'its $I names another path');
  assert.deepEqual(purgeFromBin([{ path: target }, { path: target, bin: path.join(root, '$RNEW999.docx') }]), [], 'no recorded copy / not in a bin folder');
  assert.equal(fs.readdirSync(sid).length, 4);
});

test('B1-4/B1-34: recycle() survives PowerShell closing its input early (no uncaught EPIPE)', { skip: process.platform !== 'win32' }, async () => {
  const { recycle } = await import('../src/recycle.mjs');
  const many = Array.from({ length: 3000 }, (_, i) => P(`нет-такого-${i}.txt`));
  const r = await recycle(many, { timeoutMs: 60000 });
  assert.equal(r.length, many.length);
  assert.ok(r.every((x) => x.r === 'missing'), 'a long Cyrillic answer split across chunks still decodes');
});

test('X1-3: recycle.ps1 reports the exact Recycle Bin copy; purgeFromBin removes that one', { skip: process.platform !== 'win32' }, async () => {
  const { recycle, purgeFromBin } = await import('../src/recycle.mjs');
  const f = P(`корзина-${process.pid}.txt`);
  fs.writeFileSync(f, 'x');
  const [r] = await recycle([f], { timeoutMs: 60000 });
  if (r.r !== 'recycled') return; // a temp folder without a Recycle Bin (some CI disks): nothing to check
  assert.match(r.bin, /\\\$R[^\\]+$/i);
  assert.ok(fs.existsSync(r.bin));
  assert.deepEqual(purgeFromBin([{ path: f, bin: r.bin }]), [f]);
  assert.equal(fs.existsSync(r.bin), false);
});
