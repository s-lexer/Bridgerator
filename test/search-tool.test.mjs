// fast_search (src/search-tool.mjs + src/search.ps1): query building and escaping, the source chain
// Everything → Windows Search index → plain scan (first error kept), folder rules on every hit.
// PowerShell is mocked (ctx.runPs); the Windows-only checks run search.ps1 itself with a stand-in es.exe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, defs, indexSql, likePattern, esArgs, extOf, parseBasic, urlToPath, coverSql } from '../src/search-tool.mjs';
import { createPolicy } from '../src/policy.mjs';
import { runPs as realPs } from '../src/tool-lib.mjs';
import { IS_WIN, NOT_WIN } from './helpers/ps.mjs';

const FIX = fileURLToPath(new URL('./fixtures/search/', import.meta.url));
const USER = 'C:\\Users\\Алексей';
const fromB64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const out = (o) => ({ code: 0, stdout: `${JSON.stringify(o)}\n`, stderr: '' });
const parse = (r) => JSON.parse(r.content[0].text);

/** ctx with a mocked PowerShell: answers[mode] = object | (env) => object; every call recorded. */
function mkCtx({ answers = {}, cfg = {}, engine, policy } = {}) {
  const calls = [];
  const runPs = async (opts) => {
    calls.push(opts);
    const a = answers[opts.env.BRX_MODE];
    if (a instanceof Error) throw a;
    return out(typeof a === 'function' ? a(opts.env) : a ?? { error: 'NO_MOCK' });
  };
  return { calls, ctx: { cfg: { allowedDirectories: [], ...cfg }, policy: policy || createPolicy({ protectSensitive: false, deniedDirectories: [`${USER}\\Документы\\Секретное`] }), runPs, engine, log: () => {} } };
}
const READY = { everything: { path: 'C:\\Program Files\\Everything\\es.exe', running: true }, index: { service: 'Running', covered: true } };
const ES_ITEMS = { items: [
  { path: `${USER}\\Документы\\Отчёт за июль.docx`, size: 18432, modified: '2026-07-31T09:15:00Z' },
  { path: `${USER}\\Документы\\Секретное\\пароли.txt`, size: 120 },
  { path: 'D:\\Чужое\\отчёт.docx', size: 10 },
] };

test('the tool has one name, the actions and honest read-only hints', () => {
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'fast_search');
  assert.deepEqual(defs[0].inputSchema.properties.action.enum, ['files', 'text', 'status']);
  assert.deepEqual(defs[0].annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  assert.doesNotMatch(defs[0].description, /desktop ?commander|IMPORTANT|MUST|ALWAYS/i);
});

test('a quote in the query or the folder cannot end the SQL string of the index query', () => {
  const sql = indexSql({ action: 'files', query: "o'brien' OR 1=1 --", folders: ["C:\\Users\\Алексей\\Д'Артаньян"], ext: 'docx', limit: 10 });
  assert.match(sql, /System\.FileName LIKE '%o''brien'' OR 1=1 --%'/);
  assert.match(sql, /SCOPE='file:C:\/Users\/Алексей\/Д''Артаньян'/);
  // Outside the string literals there is only our own SQL.
  const outside = sql.replace(/'(?:[^']|'')*'/g, "''");
  assert.doesNotMatch(outside, /OR 1=1|brien/);
  const t = indexSql({ action: 'text', query: "смета'); DELETE", folders: [], limit: 5 });
  assert.match(t, /FREETEXT\('смета''\); DELETE'\)/);
  assert.doesNotMatch(t.replace(/'(?:[^']|'')*'/g, "''"), /DELETE/);
  assert.match(coverSql("C:\\a'b"), /SCOPE='file:C:\/a''b'/);
});

test('LIKE specials are literal and * ? are the wildcards', () => {
  assert.equal(likePattern('отчёт'), '%отчёт%');
  assert.equal(likePattern('*.pdf'), '%.pdf');
  assert.equal(likePattern('IMG_00?.jpg'), 'IMG[_]00_.jpg');
  assert.equal(likePattern('100%'), '%100[%]%');
  assert.equal(likePattern('[x]'), '%[[]x]%');
});

test('nothing that looks like an Everything option reaches es.exe (no -export-… from the query)', () => {
  const a = esArgs({ query: '-export-csv C:\\Windows\\x.csv /a-d --help отчёт', folder: `${USER}\\Документы`, ext: 'pdf', limit: 50 });
  assert.deepEqual(a.slice(0, 6), ['-n', '50', '-path', `${USER}\\Документы`, 'ext:pdf', 'export-csv']);
  assert.ok(a.slice(5).every((w) => !/^[-/]/.test(w)), a.join(' '));
  assert.ok(a.includes('отчёт'));
});

test('a double quote never lets a word become an es.exe switch', () => {
  assert.deepEqual(esArgs({ query: '"-export-txt" C:\\x.txt', limit: 5 }), ['-n', '5', 'export-txt', 'C:\\x.txt']);
  assert.deepEqual(esArgs({ query: 'a"b "/a-d" \u201c-help\u201d', limit: 5 }), ['-n', '5', 'ab', 'a-d', 'help']);
});

test('every Everything hit hidden by the folder rules → the index is asked (not an empty answer)', async () => {
  const hidden = { items: [{ path: `${USER}\\Документы\\Секретное\\пароли.txt` }, { path: 'D:\\Чужое\\отчёт.docx' }] };
  const { ctx } = mkCtx({ answers: { status: READY, everything: hidden, index: { items: [{ url: `file:${USER.replace(/\\/g, '/')}/Документы/Отчёт за июль.docx` }] } }, cfg: { allowedDirectories: [USER, 'E:\\Общее'] } });
  const r = parse(await handle('fast_search', { action: 'files', query: 'отчёт' }, ctx));
  assert.equal(r.source, 'windows_index');
  assert.deepEqual(r.results.map((x) => x.path), [`${USER}\\Документы\\Отчёт за июль.docx`]);
  assert.match(r.skipped_sources[0], /^everything: 2 result/);
});

test('a poll of the plain scan that throws still stops the engine search', async () => {
  const names = [];
  const engine = async (name) => {
    names.push(name);
    if (name === 'start_search') return { content: [{ type: 'text', text: 'Started file search session: s9\nStatus: RUNNING\n' }] };
    if (name === 'get_more_search_results') throw Object.assign(new Error('timed out'), { code: -32001 });
    return { content: [] };
  };
  const { ctx } = mkCtx({ engine, answers: { status: { everything: { path: null, running: false }, index: { service: 'Stopped' } } } });
  await assert.rejects(handle('fast_search', { action: 'files', query: 'x', folder: USER }, ctx), { code: 'SEARCH_FAILED' });
  assert.deepEqual(names, ['start_search', 'get_more_search_results', 'stop_search']);
});

test('kind accepts an extension only', () => {
  assert.equal(extOf('.PDF'), 'pdf');
  assert.equal(extOf('*.docx'), 'docx');
  assert.equal(extOf('доки'), 'доки');
  assert.throws(() => extOf("pdf' OR 1=1"), { code: 'BAD_ARGS' });
  assert.throws(() => extOf('a b'), { code: 'BAD_ARGS' });
});

test('Everything hits in excluded folders or outside the allowed folders are dropped', async () => {
  const { ctx, calls } = mkCtx({ answers: { status: READY, everything: ES_ITEMS }, cfg: { allowedDirectories: [USER] } });
  const r = parse(await handle('fast_search', { action: 'files', query: 'отчёт', limit: 10 }, ctx));
  assert.equal(r.source, 'everything');
  assert.deepEqual(r.results.map((x) => x.path), [`${USER}\\Документы\\Отчёт за июль.docx`]);
  assert.match(r.hidden, /^2 result/);
  const args = JSON.parse(fromB64(calls.find((c) => c.env.BRX_MODE === 'everything').env.BRX_ARGS));
  assert.deepEqual(args, ['-n', '20', '-path', USER, 'отчёт'], 'scoped to the one allowed folder');
  assert.ok(!JSON.stringify(r).includes('пароли'));
});

test('a folder inside an excluded folder is refused before any search runs', async () => {
  const { ctx, calls } = mkCtx({ answers: { status: READY } });
  await assert.rejects(handle('fast_search', { action: 'files', query: 'x', folder: `${USER}\\Документы\\Секретное` }, ctx), { code: 'ACCESS_DENIED' });
  await assert.rejects(handle('fast_search', { action: 'files', query: 'x', folder: '\\\\server\\share' }, ctx), { code: 'BAD_PATH' });
  assert.equal(calls.length, 0);
});

test('Everything down and the index failing → the plain scan answers, skipped sources are listed', async () => {
  const engineCalls = [];
  const engine = async (name, a) => {
    engineCalls.push([name, a]);
    if (name === 'start_search') return { content: [{ type: 'text', text: `Started file search session: s1\nPattern: "${a.pattern}"\nPath: ${a.path}\nStatus: RUNNING\n` }] };
    if (name === 'get_more_search_results') return { content: [{ type: 'text', text: `Search session: s1\nStatus: COMPLETED\nResults:\n📁 ${USER}\\Документы\\Отчёт за июль.docx\n📁 ${USER}\\Документы\\Секретное\\пароли.txt\n` }] };
    return { content: [] };
  };
  const { ctx } = mkCtx({ engine, answers: { status: READY, everything: { error: 'ES_EXIT_8' }, index: { error: 'INDEX_UNAVAILABLE', hresult: '0x80040E14' } } });
  const r = parse(await handle('fast_search', { action: 'files', query: '*.docx', folder: `${USER}\\Документы` }, ctx));
  assert.equal(r.source, 'basic');
  assert.deepEqual(r.skipped_sources, ['everything: ES_EXIT_8', 'windows_index: INDEX_UNAVAILABLE']);
  assert.deepEqual(r.results.map((x) => x.path), [`${USER}\\Документы\\Отчёт за июль.docx`]);
  assert.deepEqual(engineCalls[0], ['start_search', { path: `${USER}\\Документы`, pattern: '*.docx', searchType: 'files', maxResults: 200, literalSearch: true }]);
});

test('when every source fails the answer names the FIRST failure, without a stack', async () => {
  const engine = async () => ({ content: [{ type: 'text', text: 'Error starting search session: boom' }], isError: true });
  const { ctx } = mkCtx({ engine, answers: { status: READY, everything: { error: 'ES_EXIT_8' }, index: { error: 'INDEX_UNAVAILABLE' } } });
  const e = await handle('fast_search', { action: 'files', query: 'x', folder: USER }, ctx).catch((x) => x);
  assert.equal(e.code, 'SEARCH_FAILED');
  assert.match(e.message, /Everything did not answer/);
  assert.doesNotMatch(e.message, /\n\s+at /);
});

test('text search skips Everything and asks the index inside the folder', async () => {
  const items = JSON.parse(fs.readFileSync(path.join(FIX, 'index-items.json'), 'utf8'));
  const { ctx, calls } = mkCtx({ answers: { status: READY, index: items } });
  const r = parse(await handle('fast_search', { action: 'text', query: 'смета ремонта', folder: USER, kind: 'xlsx' }, ctx));
  assert.equal(r.source, 'windows_index');
  assert.ok(!calls.some((c) => c.env.BRX_MODE === 'everything'));
  const sql = fromB64(calls.find((c) => c.env.BRX_MODE === 'index').env.BRX_SQL);
  assert.match(sql, /SCOPE='file:C:\/Users\/Алексей'/);
  assert.match(sql, /FREETEXT\('смета ремонта'\)/);
  assert.match(sql, /System\.FileExtension = '\.xlsx'/);
  assert.deepEqual(r.results.map((x) => x.path), [`${USER}\\Документы\\Отчёт за июль.docx`, `${USER}\\Рабочий стол\\Смета ремонта.xlsx`]);
  assert.equal(r.results[0].size, 18432);
});

test('a folder the index does not cover: the plain scan is used and the answer says why', async () => {
  const engine = async (name) => (name === 'start_search'
    ? { content: [{ type: 'text', text: `Started content search session: s2\nStatus: COMPLETED\nInitial results:\n📄 ${USER}\\Проекты\\план.txt:12 - смета ремонта кухни\n` }] }
    : { content: [{ type: 'text', text: `Search session: s2\nStatus: COMPLETED\nResults:\n📄 ${USER}\\Проекты\\план.txt:12 - смета ремонта кухни\n📄 ${USER}\\Проекты\\план.txt:40 - ещё\n` }] });
  const { ctx } = mkCtx({ engine, answers: { status: { ...READY, index: { service: 'Running', covered: false } }, index: { items: [] } } });
  const r = parse(await handle('fast_search', { action: 'text', query: 'смета', folder: `${USER}\\Проекты` }, ctx));
  assert.equal(r.source, 'basic');
  assert.match(r.note, /not in the windows search index/i);
  assert.deepEqual(r.results, [{ path: `${USER}\\Проекты\\план.txt` }]);
});

test('index service stopped (ru-RU PC with indexing off) → no index query at all', async () => {
  const engine = async () => ({ content: [{ type: 'text', text: 'Started file search session: s3\nStatus: COMPLETED\n' }] });
  const { ctx, calls } = mkCtx({ engine, answers: { status: { everything: { path: null, running: false }, index: { service: 'Stopped', covered: null } } } });
  const r = parse(await handle('fast_search', { action: 'files', query: 'отчёт', folder: USER }, ctx));
  assert.equal(r.source, 'basic');
  assert.deepEqual(r.skipped_sources, ['everything: not installed', 'windows_index: service Stopped']);
  assert.ok(!calls.some((c) => c.env.BRX_MODE === 'index'));
});

test('status says plainly which sources this PC has', async () => {
  const { ctx, calls } = mkCtx({ answers: { status: { everything: { path: 'C:\\Program Files\\Everything\\es.exe', running: false }, index: { service: 'Running', covered: false } } } });
  const r = parse(await handle('fast_search', { action: 'status', folder: `${USER}\\Фото` }, ctx));
  assert.equal(r.everything, 'installed, not running');
  assert.equal(r.windows_index, 'ready');
  assert.match(r.folder_indexed, /^no/);
  assert.match(fromB64(calls[0].env.BRX_SCOPE_SQL), /SCOPE='file:C:\/Users\/Алексей\/Фото'/);
});

test('bad input is refused in plain words', async () => {
  const { ctx } = mkCtx();
  await assert.rejects(handle('fast_search', { action: 'find' }, ctx), { code: 'BAD_ACTION' });
  await assert.rejects(handle('fast_search', { action: 'files' }, ctx), { code: 'BAD_ARGS' });
  await assert.rejects(handle('fast_search', { action: 'files', query: 'x', limit: 501 }, ctx), { code: 'BAD_ARGS' });
});

test('engine search lines and index URLs become plain paths', () => {
  assert.deepEqual(parseBasic(`Results:\n📁 ${USER}\\a.txt\n📄 ${USER}\\b.txt:3 - строка\n📄 ${USER}\\b.txt:9 - ещё\n✅ Search completed.`), [
    { path: `${USER}\\a.txt` }, { path: `${USER}\\b.txt`, line: 3, match: 'строка' },
  ]);
  assert.equal(urlToPath('file:C:/Users/Алексей/Рабочий стол/x.txt'), `${USER}\\Рабочий стол\\x.txt`);
});

// --- search.ps1 itself (Windows PowerShell 5.1) ---------------------------------------------
const PS = fileURLToPath(new URL('../src/search.ps1', import.meta.url));
const envKey = (k) => Object.keys(process.env).find((x) => x.toLowerCase() === k.toLowerCase()) || k;
// Windows sets ProgramFiles for every new process itself, so a stand-in can't live in "Program Files":
// this copy of search.ps1 trusts any es.exe (the real check is tested with the real file below).
const trustAll = () => fs.readFileSync(PS, 'utf8').replace(/^\uFEFF/, '').replace('function Test-TrustedEs(', 'function Test-TrustedEs { $true }\nfunction Test-TrustedEs-Real(');
test('search.ps1 reads an Everything export with Cyrillic names (stand-in es.exe)', { skip: NOT_WIN }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brx-es-'));
  try {
    const pf = path.join(dir, 'pf'), local = path.join(dir, 'local');
    fs.mkdirSync(pf);
    const fake = path.join(pf, 'es.cmd');
    // The stand-in copies the fixture where -export-efu points (5th argument here), like es.exe does.
    fs.writeFileSync(fake, '@copy /y "%PST_EFU%" %5 >nul\r\n@exit /b 0\r\n');
    const env = { BRX_MODE: 'everything', BRX_ES: fake, BRX_ARGS: Buffer.from(JSON.stringify(['-n', '10', 'отчёт'])).toString('base64'), PST_EFU: path.join(FIX, 'everything.efu'), [envKey('LOCALAPPDATA')]: local };
    const r = await realPs({ script: trustAll(), env });
    const j = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(j.items.length, 3);
    assert.deepEqual(j.items[0], { path: `${USER}\\Документы\\Отчёт за июль.docx`, size: 18432, modified: '2026-09-02T10:15:00Z', dir: false });
    assert.equal(j.items[1].dir, true);
    // The export file was in our cache folder (not TEMP) and is gone.
    assert.deepEqual(fs.readdirSync(path.join(local, 'Bridgerator', 'cache')), []);
    const missing = await realPs({ script: trustAll(), env: { ...env, BRX_ES: path.join(dir, 'нет.exe') } });
    assert.deepEqual(JSON.parse(missing.stdout.trim()), { error: 'ES_MISSING' });
    // Outside Program Files and not signed by voidtools: never started.
    const planted = path.join(dir, 'es.cmd');
    fs.copyFileSync(fake, planted);
    const untrusted = await realPs({ files: [PS], env: { ...env, BRX_ES: planted } });
    assert.deepEqual(JSON.parse(untrusted.stdout.trim().split(/\r?\n/).at(-1)), { error: 'ES_UNTRUSTED' });
    // A hanging es.exe is stopped; nothing is left behind.
    const slow = path.join(pf, 'slow.cmd');
    fs.writeFileSync(slow, '@echo off\r\n:again\r\ngoto again\r\n');         // hangs without a child process
    const t0 = Date.now();
    const hung = await realPs({ script: trustAll(), env: { ...env, BRX_ES: slow, BRX_ES_WAIT: '800' } });
    assert.deepEqual(JSON.parse(hung.stdout.trim().split(/\r?\n/).at(-1)), { error: 'ES_TIMEOUT' });
    assert.ok(Date.now() - t0 < 5000, 'stopped early');
    assert.deepEqual(fs.readdirSync(path.join(local, 'Bridgerator', 'cache')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// X3-3/X3-11/X3-17: a quoted argument ending in \ keeps the next arguments; X3-4/X3-18: es.exe output never
// blocks it; X3-19: es.exe that cannot start = one clear code.
test('search.ps1: trailing \\ in a quoted folder, a chatty es.exe, an es.exe that cannot start', { skip: NOT_WIN }, async () => {
  const q = await realPs({ script: String.raw`
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($env:PST_PS, [Text.Encoding]::UTF8), [ref]$t, [ref]$e)
. ([scriptblock]::Create(($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Quote-Arg' }, $true) | Select-Object -First 1).Extent.Text))
$psi = New-Object Diagnostics.ProcessStartInfo $env:PST_NODE
$psi.Arguments = (@('-p', 'JSON.stringify(process.argv.slice(1))', '--', '-path', 'C:\My Files\', '\\srv\my share\', 'a\\b', '-n', '5') | ForEach-Object { Quote-Arg $_ }) -join ' '
$psi.UseShellExecute = $false; $psi.RedirectStandardOutput = $true
$p = [Diagnostics.Process]::Start($psi); $o = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
[Console]::Out.WriteLine($o.Trim())
`, env: { PST_PS: PS, PST_NODE: process.execPath } });
  assert.ok(q.stdout.trim(), q.stderr);
  assert.deepEqual(JSON.parse(q.stdout.trim().split(/\r?\n/).at(-1)), ['-path', 'C:\\My Files\\', '\\\\srv\\my share\\', 'a\\\\b', '-n', '5']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brx-es2-'));
  try {
    const local = path.join(dir, 'local');
    const chatty = path.join(dir, 'chatty.cmd');
    // ~200 KB on stdout and stderr each (far over a pipe buffer), then the export.
    fs.writeFileSync(chatty, '@echo off\r\nfor /l %%i in (1,1,3000) do (echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx& echo yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy 1>&2)\r\ncopy /y "%PST_EFU%" %5 >nul\r\nexit /b 0\r\n');
    const env = { BRX_MODE: 'everything', BRX_ES: chatty, BRX_ES_WAIT: '30000', BRX_ARGS: Buffer.from(JSON.stringify(['-n', '10', 'x'])).toString('base64'), PST_EFU: path.join(FIX, 'everything.efu'), [envKey('LOCALAPPDATA')]: local };
    const r = await realPs({ script: trustAll(), env, timeout: 60000 });
    assert.equal(JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)).items?.length, 3, r.stdout.slice(-300));
    const notExe = path.join(dir, 'es.exe');
    fs.writeFileSync(notExe, 'not a program');
    const bad = await realPs({ script: trustAll(), env: { ...env, BRX_ES: notExe } });
    assert.deepEqual(JSON.parse(bad.stdout.trim().split(/\r?\n/).at(-1)), { error: 'ES_START_FAILED' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('search.ps1 status answers with service state by name, not by localized text', { skip: NOT_WIN }, async () => {
  const r = await realPs({ files: [PS], env: { BRX_MODE: 'status' } });
  const j = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
  assert.ok(['Running', 'Stopped', 'Missing', 'StartPending', 'StopPending', 'Paused'].includes(j.index.service), j.index.service);
  assert.equal(typeof j.everything.running, 'boolean');
  assert.equal(IS_WIN, true);
});
