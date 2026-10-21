// photos (src/photos-tool.mjs + src/photos.ps1): GPS only on request, converted copies never overwrite,
// rename by date is a preview by default and goes through move_file (folder rules, confirm, Undo).
// PowerShell is mocked (ctx.runPs); the Windows-only check makes a real photo with WIC in a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, defs, takenOf, listPhotos } from '../src/photos-tool.mjs';
import { createPolicy } from '../src/policy.mjs';
import { runPs as realPs } from '../src/tool-lib.mjs';
import { NOT_WIN } from './helpers/ps.mjs';

const FIX = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./fixtures/photos/info-items.json', import.meta.url)), 'utf8'));
const parse = (r) => JSON.parse(r.content[0].text);
const out = (o) => ({ code: 0, stdout: `строка без JSON\n${JSON.stringify(o)}\n`, stderr: '' });
const reqOf = (call) => JSON.parse(Buffer.from(call.input, 'base64').toString('utf8'));

/** A temp folder with a Cyrillic name and the given files (name → text). */
function tmp(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brx-фото-'));
  const dir = path.join(root, 'Отпуск 2026');
  fs.mkdirSync(dir);
  for (const [n, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); fs.writeFileSync(path.join(dir, n), t); }
  return { root, dir, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function mkCtx({ info, convert, policy, engine, cfg = {} } = {}) {
  const calls = [];
  const runPs = async (opts) => {
    calls.push(opts);
    const req = reqOf(opts);
    if (opts.env.BRX_MODE === 'info') return out(info ? info(req) : { items: req.files.map((p) => ({ path: p, width: 10, height: 10 })) });
    return out(convert ? convert(req) : { items: req.items.map((x) => ({ ...x, ok: true, width: 5, height: 5, bytes: 100 })) });
  };
  return { calls, ctx: { cfg: { allowedDirectories: [], ...cfg }, policy: policy || createPolicy({ protectSensitive: false }), runPs, engine, log: () => {} } };
}

test('the tool: one name, three actions, not read-only, not destructive', () => {
  assert.equal(defs[0].name, 'photos');
  assert.deepEqual(defs[0].inputSchema.properties.action.enum, ['info', 'convert', 'rename_by_date']);
  assert.deepEqual(defs[0].annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
  assert.doesNotMatch(defs[0].description, /desktop ?commander|IMPORTANT|MUST/i);
});

test('the GPS position is never shown unless the call asks for it', async () => {
  const t = tmp({ 'IMG_0001.JPG': 'x', 'IMG_0002.JPG': 'y' });
  try {
    // The mock returns GPS even when not asked: the bridge drops it anyway.
    const info = (req) => ({ items: req.files.map((p, i) => ({ ...FIX.items[i], path: p })) });
    const { ctx, calls } = mkCtx({ info });
    const r = parse(await handle('photos', { action: 'info', path: t.dir }, ctx));
    assert.equal(reqOf(calls[0]).gps, false);
    assert.ok(!JSON.stringify(r).includes('53.9'));
    assert.match(r.photos[0].location, /not shown/);
    assert.equal(r.photos[0].taken, '2026-07-14 10:22:33');
    assert.equal(r.photos[0].camera, 'Canon EOS R6');
    assert.equal(r.photos[1].camera, 'Apple iPhone 15');
    assert.equal(r.photos[0].orientation, 6);
    assert.equal(r.photos[1].orientation, undefined);
    const g = parse(await handle('photos', { action: 'info', path: t.dir, gps: true }, ctx));
    assert.equal(reqOf(calls[1]).gps, true);
    assert.deepEqual(g.photos[0].gps, { lat: 53.903428, lon: 27.55 });
  } finally { t.done(); }
});

test('a photo Windows cannot decode is reported in plain words (HEIC without the extension)', async () => {
  const t = tmp({ 'IMG_0003.HEIC': 'x', 'скан паспорта.png': 'y' });
  try {
    const { ctx } = mkCtx({ info: (req) => ({ items: req.files.map((p) => (p.endsWith('.HEIC') ? { path: p, error: 'NO_CODEC' } : { path: p, width: 1200, height: 800, format: 'png' })) }) });
    const r = parse(await handle('photos', { action: 'info', path: t.dir }, ctx));
    const heic = r.photos.find((x) => x.path.endsWith('.HEIC'));
    assert.match(heic.problem, /HEIF Image Extensions/);
  } finally { t.done(); }
});

test('convert never overwrites: an existing "(small)" copy gets a new name, the original stays', async () => {
  const t = tmp({ 'IMG_0001.JPG': 'оригинал', 'IMG_0001 (small).jpg': 'старая копия', 'IMG_0002.jpeg': 'два' });
  try {
    const { ctx, calls } = mkCtx();
    const r = parse(await handle('photos', { action: 'convert', path: t.dir }, ctx));
    const req = reqOf(calls[0]);
    assert.deepEqual(req.items.map((x) => path.basename(x.dst)).sort(), ['IMG_0001 (small) (2).jpg', 'IMG_0002 (small).jpg']);
    for (const it of req.items) { assert.notEqual(it.dst.toLowerCase(), it.src.toLowerCase()); assert.equal(fs.existsSync(it.dst), false); }
    assert.equal(req.maxSize, 1920); assert.equal(req.quality, 85); assert.equal(req.format, 'jpg');
    assert.equal(r.converted, 2);
    assert.match(r.note, /Originals were not changed/);
    assert.equal(fs.readFileSync(path.join(t.dir, 'IMG_0001 (small).jpg'), 'utf8'), 'старая копия');
  } finally { t.done(); }
});

test('convert into one output folder: two photos with the same name get different files', async () => {
  const t = tmp({ 'a/IMG_0001.JPG': '1', 'b/IMG_0001.JPG': '2' });
  try {
    const { ctx, calls } = mkCtx();
    const outDir = path.join(t.root, 'Уменьшенные');
    await handle('photos', { action: 'convert', path: t.dir, recursive: true, output: outDir, format: 'png', maxSize: 800 }, ctx);
    const req = reqOf(calls[0]);
    assert.deepEqual(req.items.map((x) => path.basename(x.dst)), ['IMG_0001.png', 'IMG_0001 (2).png']);
    assert.ok(fs.statSync(outDir).isDirectory());
  } finally { t.done(); }
});

test('convert into a read-only folder is refused before anything runs', async () => {
  const t = tmp({ 'IMG_0001.JPG': '1' });
  try {
    const ro = path.join(t.root, 'Архив');
    fs.mkdirSync(ro);
    const { ctx, calls } = mkCtx({ policy: createPolicy({ protectSensitive: false, readOnlyDirectories: [ro] }) });
    await assert.rejects(handle('photos', { action: 'convert', path: t.dir, output: ro }, ctx), { code: 'ACCESS_DENIED' });
    assert.equal(calls.length, 0);
  } finally { t.done(); }
});

test('photos in an excluded subfolder and non-photos are left out; the limit is said', () => {
  const t = tmp({ 'IMG_0001.JPG': '1', 'IMG_0002.JPG': '2', 'IMG_0003.JPG': '3', 'заметки.txt': 't', 'Личное/IMG_9.JPG': 'p' });
  try {
    const ctx = { cfg: { allowedDirectories: [] }, policy: createPolicy({ protectSensitive: false, deniedDirectories: [path.join(t.dir, 'Личное')] }) };
    const all = listPhotos(ctx, t.dir, { recursive: true, limit: 10 });
    assert.equal(all.files.length, 3);
    assert.equal(all.hidden, 1);
    const two = listPhotos(ctx, t.dir, { limit: 2 });
    assert.equal(two.files.length, 2);
    assert.equal(two.truncated, true);
    const outside = { cfg: { allowedDirectories: [path.join(t.root, 'Другая')] }, policy: createPolicy({ protectSensitive: false }) };
    assert.throws(() => listPhotos(outside, t.dir), { code: 'ACCESS_DENIED' });
  } finally { t.done(); }
});

test('rename by date is only a preview by default: nothing is moved', async () => {
  const t = tmp({ 'IMG_0001.JPG': '1', 'IMG_0002.JPG': '2', '2026-07-14 10.22.33.JPG': 'занято', 'scan.png': 's', '2026-05-01 08.00.00.jpg': 'уже' });
  try {
    const dates = { 'IMG_0001.JPG': '2026:07:14 10:22:33', 'IMG_0002.JPG': '2026:07:14 10:22:33', '2026-07-14 10.22.33.JPG': '2026:07:14 10:22:33', '2026-05-01 08.00.00.jpg': '2026:05:01 08:00:00' };
    const engineCalls = [];
    const { ctx } = mkCtx({ engine: async (...a) => { engineCalls.push(a); return { content: [] }; }, info: (req) => ({ items: req.files.map((p) => ({ path: p, width: 1, height: 1, ...(dates[path.basename(p)] ? { taken: dates[path.basename(p)] } : {}) })) }) });
    const r = parse(await handle('photos', { action: 'rename_by_date', path: t.dir }, ctx));
    assert.equal(r.preview, true);
    assert.equal(engineCalls.length, 0);
    assert.deepEqual(r.rename.map((x) => [path.basename(x.from), path.basename(x.to)]), [
      ['IMG_0001.JPG', '2026-07-14 10.22.33 (2).JPG'], ['IMG_0002.JPG', '2026-07-14 10.22.33 (3).JPG'],
    ]);
    const reasons = Object.fromEntries(r.skipped.map((s) => [path.basename(s.path), s.reason]));
    assert.equal(reasons['scan.png'], 'no date taken in the photo');
    assert.equal(reasons['2026-05-01 08.00.00.jpg'], 'already named by date');
    assert.equal(reasons['2026-07-14 10.22.33.JPG'], 'already named by date');
  } finally { t.done(); }
});

test('rename by date with dry_run false goes through move_file and stops when the person declines', async () => {
  const t = tmp({ 'IMG_0001.JPG': '1', 'IMG_0002.JPG': '2', 'IMG_0003.JPG': '3' });
  try {
    const engineCalls = [];
    const engine = async (name, a) => { engineCalls.push([name, a]); return engineCalls.length === 2 ? { content: [{ type: 'text', text: 'The person at this PC did not allow this action.' }], isError: true, notConfirmed: true } : { content: [{ type: 'text', text: 'moved' }] }; };
    const { ctx } = mkCtx({ engine, info: (req) => ({ items: req.files.map((p, i) => ({ path: p, width: 1, height: 1, taken: `2026:07:14 10:22:3${i}` })) }) });
    const r = parse(await handle('photos', { action: 'rename_by_date', path: t.dir, dry_run: false }, ctx));
    assert.equal(engineCalls.length, 2);
    assert.deepEqual(engineCalls[0], ['move_file', { source: path.join(t.dir, 'IMG_0001.JPG'), destination: path.join(t.dir, '2026-07-14 10.22.30.JPG') }]);
    assert.equal(r.renamed, 1);
    assert.match(r.failed[0].problem, /did not allow/);
    assert.match(r.undo, /bridgerator_undo/);
  } finally { t.done(); }
});

test('rename by date: a file that appeared under the planned name meanwhile is not hit (re-checked per move)', async () => {
  const t = tmp({ 'IMG_0001.JPG': '1', 'IMG_0002.JPG': '2' });
  try {
    const moves = [];
    const engine = async (name, a) => {
      moves.push(a);
      // While the first rename runs, another program saves "2026-07-14 10.22.31.JPG" (the 2nd planned name).
      if (moves.length === 1) fs.writeFileSync(path.join(t.dir, '2026-07-14 10.22.31.JPG'), 'чужой');
      return { content: [{ type: 'text', text: 'moved' }] };
    };
    const { ctx } = mkCtx({ engine, info: (req) => ({ items: req.files.map((p, i) => ({ path: p, width: 1, height: 1, taken: `2026:07:14 10:22:3${i}` })) }) });
    const r = parse(await handle('photos', { action: 'rename_by_date', path: t.dir, dry_run: false }, ctx));
    assert.equal(r.renamed, 2);
    assert.equal(path.basename(moves[1].destination), '2026-07-14 10.22.31 (2).JPG');
  } finally { t.done(); }
});

test('convert reads max_size (the VM run sent max_size and got 1920 px); maxSize still works', async () => {
  const t = tmp({ 'IMG_0001.JPG': '1' });
  try {
    const { ctx, calls } = mkCtx();
    await handle('photos', { action: 'convert', path: t.dir, max_size: 800 }, ctx);
    assert.equal(reqOf(calls[0]).maxSize, 800);
    await handle('photos', { action: 'convert', path: t.dir, maxSize: 640 }, ctx);
    assert.equal(reqOf(calls[1]).maxSize, 640);
    assert.ok(defs[0].inputSchema.properties.max_size);
    await assert.rejects(handle('photos', { action: 'convert', path: t.dir, max_size: 5 }, ctx), { code: 'BAD_ARGS' });
  } finally { t.done(); }
});

test('a huge folder tree stops after a fixed number of folders (said as truncated)', () => {
  const t = tmp({});
  try {
    for (let i = 0; i < 2100; i++) fs.mkdirSync(path.join(t.dir, `d${i}`));
    const ctx = { cfg: { allowedDirectories: [] }, policy: createPolicy({ protectSensitive: false }) };
    const r = listPhotos(ctx, t.dir, { recursive: true, limit: 10 });
    assert.equal(r.truncated, true);
    assert.equal(r.files.length, 0);
  } finally { t.done(); }
});

test('only pixel formats that really have alpha (or a palette) are flattened before JPEG', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/photos.ps1', import.meta.url)), 'utf8');
  const m = /\[string\]\$img\.Format -cmatch '([^']+)'/.exec(src);
  assert.ok(m, 'case-sensitive match');
  const re = new RegExp(m[1]);
  for (const f of ['Bgra32', 'Pbgra32', 'Rgba64', 'Prgba64', 'Rgba128Float', 'Indexed8']) assert.ok(re.test(f), f);
  for (const f of ['Bgr24', 'Bgr32', 'Gray8', 'Cmyk32', 'BlackWhite', 'Rgb48']) assert.ok(!re.test(f), f);
});

test('rename by date in a read-only folder: each photo is skipped with the reason', async () => {
  const t = tmp({ 'IMG_0001.JPG': '1' });
  try {
    const { ctx } = mkCtx({ policy: createPolicy({ protectSensitive: false, readOnlyDirectories: [t.dir] }), engine: async () => assert.fail('no move'), info: (req) => ({ items: req.files.map((p) => ({ path: p, taken: '2026:07:14 10:22:33' })) }) });
    const r = parse(await handle('photos', { action: 'rename_by_date', path: t.dir, dry_run: false }, ctx));
    assert.equal(r.renamed, 0);
    assert.match(r.skipped[0].reason, /read-only/);
  } finally { t.done(); }
});

test('dates: only real EXIF dates count', () => {
  assert.deepEqual(takenOf('2026:07:14 10:22:33'), { iso: '2026-07-14 10:22:33', name: '2026-07-14 10.22.33' });
  assert.equal(takenOf('0000:00:00 00:00:00'), null);
  assert.equal(takenOf('2026:13:01 10:00:00'), null);
  assert.equal(takenOf(''), null);
  assert.equal(takenOf('14.07.2026 10:22'), null);
});

// --- photos.ps1 itself: a real JPEG made with WIC (EXIF date, camera, orientation 6, GPS) -------------
const GEN = String.raw`
Add-Type -AssemblyName PresentationCore,WindowsBase
$px = New-Object byte[] (64*32*4)
$bmp = [Windows.Media.Imaging.BitmapSource]::Create(64,32,96,96,[Windows.Media.PixelFormats]::Bgra32,$null,$px,64*4)
$md = New-Object Windows.Media.Imaging.BitmapMetadata 'jpg'
$md.SetQuery('/app1/ifd/{ushort=271}','Canon'); $md.SetQuery('/app1/ifd/{ushort=272}','Canon EOS R6')
$md.SetQuery('/app1/ifd/{ushort=274}',[uint16]6); $md.SetQuery('/app1/ifd/exif/{ushort=36867}','2026:07:14 10:22:33')
$one = [uint64]4294967296
$md.SetQuery('/app1/ifd/gps/{ushort=1}','N'); $md.SetQuery('/app1/ifd/gps/{ushort=2}',[uint64[]]@(($one + 53), ($one + 54), ($one*100 + 1234)))
$md.SetQuery('/app1/ifd/gps/{ushort=3}','E'); $md.SetQuery('/app1/ifd/gps/{ushort=4}',[uint64[]]@(($one + 27), ($one + 33), $one))
$enc = New-Object Windows.Media.Imaging.JpegBitmapEncoder
$enc.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bmp,$null,$md,$null))
$fs = [IO.File]::Create($env:BRX_OUT); $enc.Save($fs); $fs.Close()
'{"ok":true}'`;
test('photos.ps1 reads EXIF by tag id and makes an upright smaller copy (real WIC, Cyrillic path)', { skip: NOT_WIN }, async () => {
  const t = tmp({});
  try {
    const img = path.join(t.dir, 'IMG_0001.JPG');
    await realPs({ script: GEN, env: { BRX_OUT: img } });
    const before = fs.readFileSync(img);
    const ctx = { cfg: { allowedDirectories: [] }, policy: createPolicy({ protectSensitive: false }) };
    const r = parse(await handle('photos', { action: 'info', path: img }, ctx));
    assert.equal(r.photos[0].taken, '2026-07-14 10:22:33');
    assert.equal(r.photos[0].camera, 'Canon EOS R6');
    assert.equal(r.photos[0].orientation, 6);
    assert.equal(r.photos[0].gps, undefined);
    const g = parse(await handle('photos', { action: 'info', path: img, gps: true }, ctx));
    assert.deepEqual(g.photos[0].gps, { lat: 53.903428, lon: 27.55 });
    const c = parse(await handle('photos', { action: 'convert', path: img, max_size: 32 }, ctx));
    assert.equal(c.converted, 1);
    assert.equal(path.basename(c.files[0].saved), 'IMG_0001 (small).jpg');
    assert.deepEqual([c.files[0].width, c.files[0].height], [16, 32]);   // 64×32 → 32×16, turned upright
    assert.deepEqual(fs.readFileSync(img), before);
    const again = parse(await handle('photos', { action: 'convert', path: img, maxSize: 32 }, ctx));
    assert.equal(path.basename(again.files[0].saved), 'IMG_0001 (small) (2).jpg');
  } finally { t.done(); }
});
