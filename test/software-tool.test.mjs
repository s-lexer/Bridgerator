// software (winget): tables read by column position in any language, exit codes → plain words,
// install / upgrade only with explicit flags, the "install" confirmation and the terminal-off preset.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handle, parseTable, cleanLines, runWinget, aliasExists } from '../src/software-tool.mjs';
import { WINGET } from '../src/win.mjs';
import { findMatch } from '../src/confirm.mjs';

const fx = (n) => fs.readFileSync(new URL(`./fixtures/winget/${n}`, import.meta.url), 'utf8');
const ctxWith = (answers, extra = {}) => {
  const calls = [];
  return {
    calls,
    ctx: { cfg: {}, gate: { gate: async () => null }, runWinget: async (argv, opts) => { calls.push({ argv, opts }); const a = answers.shift(); if (a instanceof Error) throw a; return a; }, ...extra },
  };
};
const body = (r) => JSON.parse(r.content[0].text);

test('a ru-RU search table is read by column position: name, id, version, match, source', async () => {
  const { ctx, calls } = ctxWith([{ code: 0, out: fx('search-ru.txt') }]);
  const r = body(await handle('software', { action: 'search', query: '7zip' }, ctx));
  assert.equal(r.found, 3);
  assert.deepEqual(r.programs[0], { name: '7-Zip', id: '7zip.7zip', version: '26.04', match: 'Moniker: 7zip', source: 'winget' });
  assert.equal(r.programs[2].name, 'Архиватор «Пример» Про…');
  assert.equal(r.programs[2].id, 'Primer.Arhivator');
  assert.deepEqual(calls[0].argv, ['search', '--query', '7zip', '--count', '50', '--disable-interactivity'], 'no agreement is accepted unless asked');
});

test('installed list: the "available" column and programs without a source', async () => {
  const { ctx } = ctxWith([{ code: 0, out: fx('list-ru.txt') }]);
  const r = body(await handle('software', { action: 'list' }, ctx));
  assert.equal(r.found, 3);
  assert.equal(r.programs[0].available, '130.0.6723.59');
  assert.equal(r.programs[1].name, 'Microsoft Visual C++ 2015-2022 Redistributable (x64)');
  assert.equal(r.programs[1].available, undefined);
  assert.equal(r.programs[2].id, 'ARP\\Machine\\X64\\{1234}');
  assert.equal(r.programs[2].source, undefined);
});

test('updates: the footer line ("Доступно обновлений: 2.") is not a program', async () => {
  const { ctx, calls } = ctxWith([{ code: 0, out: fx('upgrade-ru.txt') }]);
  const r = body(await handle('software', { action: 'updates' }, ctx));
  assert.deepEqual(r.programs.map((p) => p.id), ['Google.Chrome', 'Notepad++.Notepad++']);
  assert.equal(r.programs[1].available, '8.7');
  assert.equal(calls[0].argv[0], 'upgrade');
  assert.ok(!calls[0].argv.includes('--all'), 'listing updates never updates anything');
});

test('progress spinners and download bars are dropped from the output', () => {
  assert.deepEqual(cleanLines('   - \r   \\ \rName\r\n  ████▒▒  1 MB / 2 MB\r\nDone\r\n'), ['Name', '    1 MB / 2 MB', 'Done']);
  assert.deepEqual(parseTable('no table here\r\n'), { cols: 0, rows: [] });
});

test('"no packages found" is an empty answer, not an error', async () => {
  const { ctx } = ctxWith([{ code: 0x8A150014, out: 'Не найдено ни одного пакета, соответствующего входным условиям.\r\n' }]);
  assert.deepEqual(body(await handle('software', { action: 'search', query: 'нет такой программы' }, ctx)), { action: 'search', found: 0, programs: [] });
});

test('unaccepted source terms → a plain error that says to ask the person and use accept_agreements', async () => {
  const { ctx } = ctxWith([{ code: 0x8A150046, out: '' }]);
  await assert.rejects(handle('software', { action: 'search', query: 'chrome' }, ctx), (e) => e.code === 'WINGET_0x8A150046' && /accept_agreements: true/.test(e.hint));
});

test('install: exact id, silent, agreements only with accept_agreements: true; the output tail is returned', async () => {
  const { ctx, calls } = ctxWith([{ code: 0, out: fx('install-ru.txt') }, { code: 0, out: 'ok' }]);
  const r = body(await handle('software', { action: 'install', id: '7zip.7zip' }, ctx));
  assert.equal(r.done, true);
  assert.ok(r.output.includes('Успешно установлено'));
  assert.ok(r.output.every((l) => !/█/.test(l)));
  assert.deepEqual(calls[0].argv, ['install', '--id', '7zip.7zip', '--exact', '--silent', '--disable-interactivity']);
  await handle('software', { action: 'install', id: 'Mozilla.Firefox', scope: 'user', accept_agreements: true }, ctx);
  assert.deepEqual(calls[1].argv, ['install', '--id', 'Mozilla.Firefox', '--exact', '--scope', 'user', '--silent', '--disable-interactivity', '--accept-source-agreements', '--accept-package-agreements']);
  assert.ok(calls[1].opts.timeout >= 10 * 60000, 'installers get a long timeout');
});

test('upgrade all vs one; an id that is not a winget id is refused before winget runs', async () => {
  const { ctx, calls } = ctxWith([{ code: 0, out: '' }]);
  await handle('software', { action: 'upgrade', all: true }, ctx);
  assert.deepEqual(calls[0].argv.slice(0, 2), ['upgrade', '--all']);
  for (const id of ['7zip.7zip & calc', '"x"', '--force', '']) await assert.rejects(handle('software', { action: 'install', id }, ctx), (e) => e.code === 'BAD_ARGS', id);
  await assert.rejects(handle('software', { action: 'upgrade', id: 'A.B', all: true }, ctx), (e) => e.code === 'BAD_ARGS');
  assert.equal(calls.length, 1);
});

test('known install codes become plain words: already installed, cancelled at the admin prompt, restart needed', async () => {
  const { ctx } = ctxWith([{ code: 0x8A15010D, out: '' }, { code: 0x8A15010C, out: '' }, { code: 0x8A150109, out: 'Перезагрузите ПК' }, { code: 0x8A15FFFF, out: 'что-то\r\nстранное\r\n' }]);
  await assert.rejects(handle('software', { action: 'install', id: 'A.B' }, ctx), (e) => /already installed/.test(e.message));
  await assert.rejects(handle('software', { action: 'install', id: 'A.B' }, ctx), (e) => /administrator prompt/.test(e.message));
  assert.equal(body(await handle('software', { action: 'install', id: 'A.B' }, ctx)).restartNeeded, true);
  await assert.rejects(handle('software', { action: 'install', id: 'A.B' }, ctx), (e) => e.code === 'WINGET_0x8A15FFFF' && /странное/.test(e.message));
});

test('after "No" in the admin prompt (0x8A15010F) the answer says not approved, not "company policy", and points at the taskbar', async () => {
  const { ctx } = ctxWith([{ code: 0x8A15010F, out: '' }]);
  await assert.rejects(handle('software', { action: 'install', id: 'A.B' }, ctx), (e) => /cancelled or not approved/.test(e.message) && !/company policy/i.test(e.message) && /taskbar/.test(e.hint));
});

test('install without the confirmation gate fails closed: winget never runs', async () => {
  const { ctx, calls } = ctxWith([{ code: 0, out: '' }]);
  delete ctx.gate;
  await assert.rejects(handle('software', { action: 'install', id: '7zip.7zip' }, ctx), (e) => e.code === 'NO_GATE');
  await assert.rejects(handle('software', { action: 'upgrade', all: true }, { ...ctx, gate: {} }), (e) => e.code === 'NO_GATE');
  assert.equal(calls.length, 0);
});

test('a second table ("require explicit targeting") does not leak its header or rows into the first', () => {
  const out = 'Name      Id            Version Available Source\r\n------------------------------------------------\r\nChrome    Google.Chrome 129.0   130.0     winget\r\n1 upgrades available.\r\n\r\nThe following packages have an upgrade available, but require explicit targeting for upgrade:\r\nName      Id            Version Available Source\r\n------------------------------------------------\r\nTeams     Microsoft.Teams 1.0   2.0       winget\r\n';
  const t = parseTable(out);
  assert.equal(t.rows.length, 2, JSON.stringify(t.rows));
  assert.equal(t.rows[0][1], 'Google.Chrome');
  assert.ok(!t.rows.some((row) => row.join(' ').includes('Teams') || row[0] === 'Name'));
});

test('install is refused while the terminal is off (access preset Read only / Files); search still works', async () => {
  const { ctx, calls } = ctxWith([{ code: 0, out: fx('search-ru.txt') }], { cfg: { disabledTools: ['start_process', 'interact_with_process', 'kill_process'] } });
  await assert.rejects(handle('software', { action: 'install', id: '7zip.7zip' }, ctx), (e) => e.code === 'TERMINAL_OFF');
  await handle('software', { action: 'search', query: '7zip' }, ctx);
  assert.equal(calls.length, 1);
});

test('install goes through the confirmation gate; a "no" on the PC stops it before winget runs', async () => {
  const seen = [];
  const { ctx, calls } = ctxWith([], { gate: { gate: async (name, args) => { seen.push([name, args.action, args.id]); return { content: [{ type: 'text', text: 'not allowed' }], isError: true, notConfirmed: true }; } } });
  const r = await handle('software', { action: 'install', id: '7zip.7zip' }, ctx);
  assert.equal(r.notConfirmed, true);
  assert.deepEqual(seen, [['software', 'install', '7zip.7zip']]);
  assert.equal(calls.length, 0);
});

test('confirmation category "install": the software tool and winget / msiexec in the terminal; off → no question', () => {
  const ask = { delete: true, dangerous_commands: true, write_files: false, move: false, any_command: false, install: true };
  assert.equal(findMatch('software', { action: 'install', id: 'A.B' }, ask).cat, 'install');
  assert.equal(findMatch('software', { action: 'upgrade', all: true }, ask).cat, 'install');
  assert.equal(findMatch('software', { action: 'search', query: 'x' }, ask).cat, null);
  for (const c of ['winget install --id 7zip.7zip', 'msiexec /i "C:\\Загрузки\\setup.msi" /qn', 'choco install git -y', 'Install-Module PSReadLine']) assert.equal(findMatch('start_process', { command: c }, ask).cat, 'install', c);
  assert.equal(findMatch('start_process', { command: 'winget search chrome' }, ask).cat, null);
  assert.equal(findMatch('software', { action: 'install', id: 'A.B' }, { ...ask, install: false }).cat, null);
});

test('winget is started only from its fixed per-user place, never from the PATH; missing → plain NO_WINGET', { skip: process.platform === 'win32' ? false : 'Windows only (NOT CHECKED here)' }, async () => {
  assert.equal(WINGET.toLowerCase(), path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe').toLowerCase());
  await assert.rejects(runWinget(['--version'], { exists: () => false }), (e) => e.code === 'NO_WINGET' && /App Installer/.test(e.hint));
});

test('winget found through its App Execution Alias (stat fails there, lstat works) — the real winget of this PC runs', { skip: process.platform !== 'win32' }, async () => {
  if (!fs.existsSync(path.dirname(WINGET)) || !fs.readdirSync(path.dirname(WINGET)).includes('winget.exe')) return; // no App Installer here
  assert.equal(aliasExists(WINGET), true, 'the alias is listed in WindowsApps, so it must count as present');
  const r = await runWinget(['--version'], { timeout: 30000 });
  assert.equal(r.code, 0);
  assert.match(r.out, /v\d+\.\d+/);
});
