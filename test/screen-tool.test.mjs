// screen tool (src/screen-tool.mjs + src/screen.ps1). PowerShell is mocked for everything that would
// touch the real screen: tests run on real PCs and never capture the owner's screen or windows.
// Real PowerShell only: the script parses, its C# compiles (C# 5) and packs a picture drawn here,
// and OCR of an image file drawn here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as screen from '../src/screen-tool.mjs';
import { createExtra } from '../src/extra-tools.mjs';
import { noticeText, toastXml } from '../src/notice.mjs';
import { createPolicy } from '../src/policy.mjs';
import { IS_WIN, NOT_WIN, psAst, runPs as realPs } from './helpers/ps.mjs';

const FIX = fileURLToPath(new URL('./fixtures/screen/', import.meta.url));
const fixture = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const WINDOWS = fixture('windows.ru-RU.json');
const PS_FILE = fileURLToPath(new URL('../src/screen.ps1', import.meta.url));
const TINY = Buffer.from('fake-jpeg-bytes-for-the-test').toString('base64');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'снимки экрана '));
/** ctx with a fake PowerShell: answer(env) → stdout object; records calls and notices. */
function makeCtx({ answer, cfg = {} } = {}) {
  const calls = [], notices = [];
  const ctx = {
    cfg,
    policy: createPolicy({ protectSensitive: false }),
    log: () => {},
    notice: (n) => notices.push(n),
    runPs: async (opts) => {
      calls.push(opts);
      const out = answer(opts.env || {});
      return { code: 0, stdout: `noise line\r\n${typeof out === 'string' ? out.trim() : JSON.stringify(out)}\r\n`, stderr: '' };
    },
  };
  return { ctx, calls, notices };
}
const capture = (extra = {}) => ({ ok: true, kind: 'screen', width: 3840, height: 1080, minimized: false, mime: 'image/jpeg', data: TINY, outWidth: 1600, outHeight: 450, bytes: 20, ...extra });
const answerAll = (env) => (env.BRX_ACTION === 'windows' ? WINDOWS : env.BRX_ACTION === 'ocr' ? fixture('ocr.ru-RU.json') : capture(env.BRX_HWND ? { kind: 'window', width: 1600, height: 900 } : {}));
const textOf = (r) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

test('the tool is registered once, read-only, with an action and two settings that default to on', () => {
  const x = createExtra([screen]);
  assert.deepEqual(x.defs.map((d) => d.name), ['screen']);
  const d = x.defs[0];
  assert.deepEqual(d.inputSchema.properties.action.enum, ['windows', 'capture', 'ocr']);
  assert.deepEqual(d.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  assert.deepEqual(x.defaults(), { screen: { enabled: true, notify: true } });
  // Turning screenshots on widens access; turning the notice off lowers protection: both need the PC's OK.
  assert.equal(x.widens({ screen: { enabled: false } }, { key: 'screen.enabled', value: true }), true);
  assert.equal(x.widens({}, { key: 'screen.notify', value: false }), true);
  assert.equal(x.widens({}, { key: 'screen.enabled', value: false }), false);
  assert.ok(!/IMPORTANT|MUST|ALWAYS/.test(d.description), 'short, non-imperative description');
});

test('capture of the whole screen returns a JPEG image and shows the notice once', async () => {
  const { ctx, calls, notices } = makeCtx({ answer: answerAll });
  const r = await screen.handle('screen', { action: 'capture' }, ctx);
  assert.equal(r.isError, undefined);
  const img = r.content.find((c) => c.type === 'image');
  assert.deepEqual(img, { type: 'image', data: TINY, mimeType: 'image/jpeg' });
  assert.match(textOf(r), /whole screen: 3840×1080, sent as 1600×450 JPEG/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.BRX_ACTION, 'capture');
  assert.equal(calls[0].env.BRX_IMAGE, '1');
  assert.equal(calls[0].env.BRX_MAXSIDE, String(screen.MAX_SIDE));
  assert.equal(calls[0].env.BRX_MAXBYTES, String(screen.MAX_BYTES));
  assert.deepEqual(calls[0].files, [PS_FILE]);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'screenshot');
  assert.equal(notices[0].what, 'screen');
});

test('every screenshot shows its own notice (three captures → three notices)', async () => {
  const { ctx, notices } = makeCtx({ answer: answerAll });
  await screen.handle('screen', { action: 'capture' }, ctx);
  await screen.handle('screen', { action: 'capture', monitor: 2 }, ctx);
  await screen.handle('screen', { action: 'ocr', window: 'word' }, ctx);
  assert.deepEqual(notices.map((n) => n.what), ['screen', 'monitor', 'window']);
  assert.equal(notices[1].monitor, 2);
  assert.equal(notices[2].ocr, true);
  assert.equal(notices[2].title, 'Документ1 — Word');
});

test('no notice when the person turned it off (screen.notify false); read through the registry too', async () => {
  const { ctx, notices } = makeCtx({ answer: answerAll, cfg: { screen: { notify: false } } });
  await screen.handle('screen', { action: 'capture' }, ctx);
  assert.equal(notices.length, 0);
  const x = createExtra([screen]);
  const c2 = makeCtx({ answer: answerAll, cfg: { screen: { notify: false } } });
  c2.ctx.extra = x;
  await screen.handle('screen', { action: 'capture' }, c2.ctx);
  assert.equal(c2.notices.length, 0);
  // Inversion: with the setting on, the same call notifies.
  const c3 = makeCtx({ answer: answerAll, cfg: { screen: { notify: true } } });
  c3.ctx.extra = x;
  await screen.handle('screen', { action: 'capture' }, c3.ctx);
  assert.equal(c3.notices.length, 1);
});

test('screenshots switched off → plain refusal SCREEN_OFF, PowerShell never runs, no notice', async () => {
  const { ctx, calls, notices } = makeCtx({ answer: answerAll, cfg: { screen: { enabled: false } } });
  for (const action of ['capture', 'windows', 'ocr']) {
    const r = await createExtra([screen]).call('screen', { action }, ctx);
    assert.equal(r.isError, true);
    assert.match(textOf(r), /Screenshots are turned off on this PC\..*bridgerator_settings.*\(code SCREEN_OFF\)$/s);
  }
  assert.equal(calls.length, 0);
  assert.equal(notices.length, 0);
});

test('a locked screen gives an honest SCREEN_LOCKED error, no picture and no notice', async () => {
  const { ctx, notices } = makeCtx({ answer: () => fixture('locked.json') });
  const r = await createExtra([screen]).call('screen', { action: 'capture' }, ctx);
  assert.equal(r.isError, true);
  assert.match(textOf(r), /screen is locked.*until the person unlocks the PC.*\(code SCREEN_LOCKED\)/s);
  assert.equal(r.content.some((c) => c.type === 'image'), false);
  assert.equal(notices.length, 0);
  const w = await createExtra([screen]).call('screen', { action: 'capture', window: 'word' }, ctx);
  assert.match(textOf(w), /code SCREEN_LOCKED/);
});

test('a window is picked by part of its title, any case, Cyrillic included', async () => {
  const { ctx, calls } = makeCtx({ answer: answerAll });
  const r = await screen.handle('screen', { action: 'capture', window: 'ЗАГРУЗКИ' }, ctx);
  assert.equal(calls[0].env.BRX_ACTION, 'windows');
  assert.equal(calls[1].env.BRX_HWND, '132456');
  assert.match(textOf(r), /window "Проводник — Загрузки"/);
});

test('several matches: the exact title wins, else the topmost; the others are mentioned', () => {
  const list = JSON.parse(WINDOWS).windows;
  assert.equal(screen.pickWindow(list, 'проводник').win.id, 132456);
  assert.equal(screen.pickWindow(list, 'проводник').others, 1);
  assert.equal(screen.pickWindow(list, 'документы — проводник').win.id, 66322);
  assert.throws(() => screen.pickWindow(list, 'Telegram'), (e) => e.code === 'NO_WINDOW' && /Open windows: "Документ1 — Word"/.test(e.message));
});

test('window_id that is gone → NO_WINDOW with a hint to list windows', async () => {
  const { ctx } = makeCtx({ answer: answerAll });
  const r = await createExtra([screen]).call('screen', { action: 'capture', window_id: 999 }, ctx);
  assert.match(textOf(r), /not open any more.*action "windows".*\(code NO_WINDOW\)/s);
});

test('a minimized window is captured with a warning that the picture may be empty', async () => {
  const { ctx } = makeCtx({ answer: (env) => (env.BRX_ACTION === 'windows' ? WINDOWS : capture({ kind: 'window', minimized: true })) });
  const r = await screen.handle('screen', { action: 'capture', window: 'Excel' }, ctx);
  assert.match(textOf(r), /minimized/);
});

test('a picture bigger than the limit is not sent', async () => {
  const big = 'A'.repeat(Math.ceil(screen.MAX_BYTES / 3) * 4 + 1000);
  const { ctx, notices } = makeCtx({ answer: () => capture({ data: big }) });
  const r = await createExtra([screen]).call('screen', { action: 'capture' }, ctx);
  assert.equal(r.isError, true);
  assert.match(textOf(r), /code IMAGE_TOO_LARGE/);
  assert.equal(r.content.some((c) => c.type === 'image'), false);
  assert.equal(notices.length, 1, 'the picture was taken on the PC, so the person is told');
  // Inversion: just under the limit passes.
  const ok = makeCtx({ answer: () => capture({ data: 'A'.repeat(Math.floor(screen.MAX_BYTES / 3) * 4) }) });
  const r2 = await screen.handle('screen', { action: 'capture' }, ok.ctx);
  assert.ok(r2.content.some((c) => c.type === 'image'));
});

test('ocr of a window returns the recognized lines (Cyrillic) and the language', async () => {
  const { ctx, calls } = makeCtx({ answer: answerAll });
  const r = await screen.handle('screen', { action: 'ocr', window: 'word', language: 'ru' }, ctx);
  assert.equal(calls[1].env.BRX_ACTION, 'ocr');
  assert.equal(calls[1].env.BRX_LANG, 'ru');
  assert.equal(calls[1].env.BRX_IMAGE, undefined, 'OCR sends text, not a picture');
  assert.match(textOf(r), /language ru\):\nСчёт № 17 от 20\.10\.2026\nИтого: 1 250,00 руб\./);
  assert.equal(r.content.some((c) => c.type === 'image'), false);
});

test('ocr without any OCR language installed → plain error with what to do', async () => {
  const { ctx } = makeCtx({ answer: (env) => (env.BRX_ACTION === 'ocr' ? fixture('no-lang.json') : capture()) });
  const r = await createExtra([screen]).call('screen', { action: 'ocr' }, ctx);
  assert.equal(r.isError, true);
  assert.match(textOf(r), /No text recognition language is installed.*Time & language.*\(code NO_OCR_LANG\)/s);
});

test('bad language tags are refused before PowerShell runs', async () => {
  const { ctx, calls } = makeCtx({ answer: answerAll });
  const r = await createExtra([screen]).call('screen', { action: 'ocr', language: 'ru; Remove-Item' }, ctx);
  assert.match(textOf(r), /code BAD_ARGS/);
  assert.equal(calls.length, 0);
});

test('ocr of an image file follows the folder rules and shows no screenshot notice', async () => {
  const dir = tmp();
  const img = path.join(dir, 'скан счёта.png');
  fs.writeFileSync(img, 'x');
  const { ctx, calls, notices } = makeCtx({ answer: () => ({ ok: true, kind: 'file', width: 10, height: 10, language: 'ru', lines: ['Привет'] }) });
  const r = await screen.handle('screen', { action: 'ocr', path: img }, ctx);
  assert.equal(calls[0].env.BRX_FILE, img);
  assert.match(textOf(r), /скан счёта\.png.*\nПривет/s);
  assert.equal(notices.length, 0);
  // Works also when screenshots are off (it is a file, not the screen).
  const off = makeCtx({ answer: () => ({ ok: true, kind: 'file', width: 1, height: 1, language: 'ru', lines: [] }), cfg: { screen: { enabled: false } } });
  assert.match(textOf(await screen.handle('screen', { action: 'ocr', path: img }, off.ctx)), /no text found/);
  // Excluded folder → refused, PowerShell not started.
  const denied = makeCtx({ answer: answerAll });
  denied.ctx.policy = createPolicy({ protectSensitive: false, deniedDirectories: [dir] });
  const d = await createExtra([screen]).call('screen', { action: 'ocr', path: img }, denied.ctx);
  assert.match(textOf(d), /code ACCESS_DENIED/);
  assert.equal(denied.calls.length, 0);
  // Outside the allowed list → refused.
  const narrow = makeCtx({ answer: answerAll, cfg: { allowedDirectories: [path.join(dir, 'другая')] } });
  assert.match(textOf(await createExtra([screen]).call('screen', { action: 'ocr', path: img }, narrow.ctx)), /outside the folders allowed/);
  // Not an image / UNC.
  assert.match(textOf(await createExtra([screen]).call('screen', { action: 'ocr', path: path.join(dir, 'a.txt') }, ctx)), /code BAD_IMAGE/);
  assert.match(textOf(await createExtra([screen]).call('screen', { action: 'ocr', path: '\\\\server\\share\\a.png' }, ctx)), /code BAD_PATH/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('save_to: guarded, never overwrites (name (2).png), read-only folder refused', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'экран.png'), 'old');
  const { ctx, calls } = makeCtx({ answer: (env) => capture({ saved: env.BRX_SAVE }) });
  const r = await screen.handle('screen', { action: 'capture', save_to: path.join(dir, 'экран.png') }, ctx);
  assert.equal(calls[0].env.BRX_SAVE, path.join(dir, 'экран (2).png'));
  assert.match(textOf(r), /Full-size copy saved: .*экран \(2\)\.png/);
  assert.equal(fs.readFileSync(path.join(dir, 'экран.png'), 'utf8'), 'old');
  const ro = makeCtx({ answer: answerAll });
  ro.ctx.policy = createPolicy({ protectSensitive: false, readOnlyDirectories: [dir] });
  const r2 = await createExtra([screen]).call('screen', { action: 'capture', save_to: path.join(dir, 'b.png') }, ro.ctx);
  assert.match(textOf(r2), /read-only folder.*\(code ACCESS_DENIED\)/s);
  assert.equal(ro.calls.length, 0);
  assert.match(textOf(await createExtra([screen]).call('screen', { action: 'capture', save_to: path.join(dir, 'b.gif') }, ctx)), /\.png or \.jpg/);
  assert.match(textOf(await createExtra([screen]).call('screen', { action: 'capture', save_to: path.join(dir, 'нет', 'b.png') }, ctx)), /does not exist/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the window list is slim and titles from the PC are cleaned of control characters', async () => {
  const { ctx } = makeCtx({ answer: () => ({ ok: true, windows: [{ id: 5, title: 'Злой\u0007\nзаголовок', process: 'notepad', minimized: false }, { id: 6, title: 'Свёрнутое', process: 'x', minimized: true }] }) });
  const r = await screen.handle('screen', { action: 'windows' }, ctx);
  const j = JSON.parse(textOf(r));
  assert.deepEqual(j.windows, [{ id: 5, title: 'Злой  заголовок', program: 'notepad' }, { id: 6, title: 'Свёрнутое', program: 'x', minimized: true }]);
});

test('window and monitor together are refused; unknown action is refused', async () => {
  const { ctx } = makeCtx({ answer: answerAll });
  assert.match(textOf(await createExtra([screen]).call('screen', { action: 'capture', window: 'a', monitor: 1 }, ctx)), /either window/);
  assert.match(textOf(await createExtra([screen]).call('screen', { action: 'record' }, ctx)), /code BAD_ACTION/);
});

test('the screenshot notice: fixed title, what was captured, no buttons; bad input shows nothing', () => {
  const t = noticeText({ kind: 'screenshot', what: 'window', title: 'Документ1 — Word' });
  assert.equal(t.title, 'Bridgerator: the AI took a screenshot');
  assert.match(t.body, /^Window "Документ1 — Word"\./);
  assert.match(noticeText({ kind: 'screenshot', what: 'screen' }).body, /^Whole screen\./);
  assert.match(noticeText({ kind: 'screenshot', what: 'monitor', monitor: 2, ocr: true }).body, /^Monitor 2 \(text recognized\)\./);
  const x = toastXml(noticeText({ kind: 'screenshot', what: 'window', title: '<b>&"x"' }));
  assert.ok(!x.includes('<actions>'));
  assert.ok(x.includes('&lt;b&gt;&amp;&quot;x&quot;'));
  assert.equal(noticeText({ kind: 'screenshot', what: 'desktop' }), undefined);
  // Other notices keep their button.
  assert.ok(toastXml(noticeText({ kind: 'offline' })).includes('<actions>'));
});

test('screen.ps1 parses as PowerShell 5.1 and is ASCII-only', { skip: NOT_WIN }, async () => {
  const buf = fs.readFileSync(PS_FILE);
  assert.ok(![...buf].some((b) => b > 0x7f), 'non-ASCII text would need a BOM');
  const [ast] = await psAst([PS_FILE]);
  assert.deepEqual(ast.errors, []);
  assert.equal(ast.csharp.length, 1);
});

test('the C# helper compiles (C# 5) and packs a big picture under the limits; full-size copy saved', { skip: NOT_WIN, timeout: 120000 }, async () => {
  const [ast] = await psAst([PS_FILE]);
  const dir = tmp();
  const r = await realPs(String.raw`
Add-Type -TypeDefinition $env:PST_CODE -ReferencedAssemblies System.Drawing
$b = New-Object Drawing.Bitmap 3000, 2000
$rnd = New-Object Random 7
$g = [Drawing.Graphics]::FromImage($b)
for ($i = 0; $i -lt 3000; $i++) { $g.FillRectangle((New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb($rnd.Next(256), $rnd.Next(256), $rnd.Next(256)))), $rnd.Next(3000), $rnd.Next(2000), 40, 40) }
$g.Dispose()
$p = [BrShot]::Pack($b, 1600, 300000)
$save = Join-Path $env:PST_DIR 'полный.png'
[BrShot]::Save($b, $save)
$len = (Get-Item -LiteralPath $save).Length
$again = $false; try { [BrShot]::Save((New-Object Drawing.Bitmap 10, 10), $save) } catch { $again = $true }
ConvertTo-Json -Compress @{ w = $p.W; h = $p.H; bytes = $p.Data.Length; saved = (Test-Path $save); refused = $again; same = ((Get-Item -LiteralPath $save).Length -eq $len) }`, { env: { PST_CODE: ast.csharp[0].code, PST_DIR: dir } });
  assert.ok(r.w <= 1600 && r.h <= 1600, JSON.stringify(r));
  assert.ok(r.bytes <= 300000);
  assert.equal(r.saved, true);
  assert.equal(r.refused, true, 'an existing file is never overwritten');
  assert.equal(r.same, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('real OCR of an image drawn here (Windows built-in OCR, no screen involved)', { skip: NOT_WIN, timeout: 120000 }, async (t) => {
  const dir = tmp();
  const img = path.join(dir, 'текст.png');
  await realPs(String.raw`Add-Type -AssemblyName System.Drawing; $b = New-Object Drawing.Bitmap 900, 200; $g = [Drawing.Graphics]::FromImage($b); $g.Clear([Drawing.Color]::White)
$g.DrawString('Hello Bridgerator 123', (New-Object Drawing.Font('Arial', 40)), [Drawing.Brushes]::Black, 20, 50); $b.Save($env:PST_OUT); ConvertTo-Json -Compress @{ ok = $true }`, { env: { PST_OUT: img } });
  const ctx = { cfg: {}, policy: createPolicy({ protectSensitive: false }), log: () => {}, notice: () => assert.fail('no notice for a file') };
  const r = await createExtra([screen]).call('screen', { action: 'ocr', path: img }, ctx);
  if (r.isError && /NO_OCR_LANG/.test(textOf(r))) { t.skip('no OCR language installed in this Windows (NOT CHECKED)'); return; }
  assert.equal(r.isError, undefined, textOf(r));
  assert.match(textOf(r), /Hello Bridgerator 123/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('two runs compiling the same helper at once: the loser uses the winner\'s DLL and leaves no file', { skip: NOT_WIN }, async () => {
  const src = fs.readFileSync(PS_FILE, 'utf8');
  const fn = /function Add-CachedType[\s\S]*?\n\}\r?\n/.exec(src)[0];
  const dir = tmp();
  // Add-Type stand-in: compiling writes our temp DLL, and the "other run" finishes the shared one first.
  const r = await realPs(`$script:loaded = @()
function Add-Type { param($TypeDefinition, $ReferencedAssemblies, $OutputAssembly, $OutputType, $Path)
  if ($OutputAssembly) { [IO.File]::WriteAllText($OutputAssembly, 'mine'); [IO.File]::WriteAllText(($OutputAssembly -replace '\\.\\d+\\.dll$', '.dll'), 'winner') }
  if ($Path) { $script:loaded += $Path } }
${fn}
Add-CachedType 'class X {}'
ConvertTo-Json -Compress @{ loaded = @($script:loaded); files = @(Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'Bridgerator\\cache') | ForEach-Object { $_.Name }) }`, { env: { LOCALAPPDATA: dir } });
  assert.equal(r.files.length, 1, JSON.stringify(r));
  assert.match(r.files[0], /^br-[0-9a-f]{24}\.dll$/);
  assert.equal(path.basename(r.loaded[0]), r.files[0]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('one installed OCR language stays a list (not a string whose [0] is a letter)', () => {
  const src = fs.readFileSync(PS_FILE, 'utf8');
  assert.match(src, /\$langs = @\(Get-OcrLanguages\)/);
  assert.doesNotMatch(src, /\$langs = Get-OcrLanguages/);
});

test('a picture taken but not sent (later step failed / no answer) still shows the notice', async () => {
  const a = makeCtx({ answer: () => ({ ok: false, code: 'PS_ERROR', message: 'boom', taken: true }) });
  const r = await createExtra([screen]).call('screen', { action: 'capture' }, a.ctx);
  assert.equal(r.isError, true);
  assert.equal(a.notices.length, 1);
  const b = makeCtx({ answer: () => ({ ok: false, code: 'NO_WINDOW', message: 'gone' }) });
  await createExtra([screen]).call('screen', { action: 'capture' }, b.ctx);
  assert.equal(b.notices.length, 0, 'nothing was taken');
  const c = makeCtx({ answer: answerAll });
  c.ctx.runPs = async () => { throw Object.assign(new Error('Windows took too long to answer.'), { code: 'TIMEOUT' }); };
  await createExtra([screen]).call('screen', { action: 'capture' }, c.ctx);
  assert.equal(c.notices.length, 1, 'no answer: it may have taken one');
});

test('the window id is checked against its program in the capture run (ids are reused)', async () => {
  const list = { ok: true, windows: [{ id: 777, pid: 4242, title: 'Блокнот', process: 'notepad' }] };
  const { ctx, calls } = makeCtx({ answer: (env) => (env.BRX_ACTION === 'windows' ? list : capture({ kind: 'window' })) });
  await screen.handle('screen', { action: 'capture', window: 'блокнот' }, ctx);
  assert.equal(calls[1].env.BRX_HWND, '777');
  assert.equal(calls[1].env.BRX_PID, '4242');
});

if (!IS_WIN) test('PowerShell parts', { skip: NOT_WIN }, () => {});
