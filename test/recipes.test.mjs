// Recipes (recipes/*.json + src/recipes.mjs): parameters, folder rules, PowerShell quoting, and real
// runs of the recipes on throw-away folders (hidden PowerShell; nothing outside the temp folder, no
// Recycle Bin, no Task Scheduler). LOGIC: critical-logic/bridge.md ("Automations and recipes").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPs, NOT_WIN } from './helpers/ps.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-recipes-'));
const home = path.join(root, 'Иван Петров');
Object.assign(process.env, { USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
const dl = path.join(home, 'Downloads'), src = path.join(root, 'Мои документы'), dst = path.join(root, 'Копия'), secret = path.join(root, 'Секрет'), ro = path.join(root, 'Архив');
for (const d of [dl, src, secret, ro]) fs.mkdirSync(d, { recursive: true });

const R = await import('../src/recipes.mjs');
const A = await import('../src/automations.mjs');
const { createPolicy } = await import('../src/policy.mjs');
const { createGate, ensureIni } = await import('../src/confirm.mjs');
const { createExtra } = await import('../src/extra-tools.mjs');

// cwd: the engine's folder (relative paths in commands resolve there; the test process runs inside the package = excluded).
const cfg = { allowedDirectories: [], deniedDirectories: [secret], readOnlyDirectories: [ro], cwd: root };
const ctx = { cfg, policy: createPolicy(cfg), log: () => {}, popup: () => ({}) };
const build = (id, p) => R.buildRecipe(ctx, id, p);
const err = (fn) => { try { fn(); } catch (e) { return `${e.code}: ${e.message}`; } return 'no error'; };

test('five recipes, each with English and Russian title / description, parameters and a suggested schedule', () => {
  const all = R.loadRecipes();
  assert.deepEqual(all.map((r) => r.id), R.RECIPE_IDS);
  for (const r of all) {
    for (const k of ['title', 'description']) { assert.ok(r[k].en && r[k].ru, `${r.id}.${k}`); assert.match(r[k].ru, /[а-яё]/i); }
    assert.ok(Array.isArray(r.params) && r.params.length, r.id);
    for (const p of r.params) { assert.ok(p.description.en && p.description.ru, `${r.id}.${p.name}`); assert.ok(['path', 'int', 'bool', 'enum'].includes(p.type)); }
    assert.doesNotThrow(() => A.readSchedule(r.schedule), r.id);
  }
  const list = R.recipeList('en');
  assert.equal(list.find((r) => r.id === 'clean-downloads').params.find((p) => p.name === 'Days').default, 30);
  assert.match(R.recipeList('ru')[0].title, /Резервная/);
});

test('parameters: required, defaults (%USERPROFILE% expanded), types, unknown ones refused', () => {
  const c = build('clean-downloads', {});
  assert.deepEqual(c.params, { Folder: dl, Days: 30, Subfolders: false, DryRun: false });
  assert.match(c.script, /^ {2}Folder = '.*Иван Петров\\Downloads'$/m);
  assert.match(c.script, /^ {2}Days = 30$/m);
  assert.match(c.script, /^ {2}Subfolders = \$false$/m);
  assert.match(err(() => build('backup-folder', { Source: src })), /BAD_ARGS: Destination is required/);
  assert.match(err(() => build('clean-downloads', { Days: 0 })), /Days: must be a whole number from 1 to 3650/);
  assert.match(err(() => build('clean-downloads', { Days: '30' })), /Days: must be a whole number/);
  assert.match(err(() => build('clean-downloads', { DryRun: 'yes' })), /DryRun: must be true or false/);
  assert.match(err(() => build('sort-folder', { Language: 'de' })), /Language: must be one of en, ru/);
  assert.match(err(() => build('sort-folder', { Folder: src, Recursive: true })), /Unknown parameter\(s\) for sort-folder: Recursive/);
  assert.match(err(() => build('nope', {})), /NO_RECIPE/);
  assert.match(err(() => build('disk-report', { OutFile: path.join(root, 'r.csv') })), /OutFile: must end with \.txt/);
  assert.match(err(() => build('backup-folder', { Source: path.join(root, 'нет такой'), Destination: dst })), /NOT_FOUND/);
});

test('paths follow the folder rules: excluded, outside the list, read-only for writes, network paths refused; the copy may not sit inside the original', () => {
  assert.match(err(() => build('disk-report', { Folder: secret })), /ACCESS_DENIED/);
  assert.match(err(() => build('backup-folder', { Source: ro, Destination: dst })), /no error/, 'reading a read-only folder is fine');
  assert.match(err(() => build('backup-folder', { Source: src, Destination: path.join(ro, 'копия') })), /ACCESS_DENIED.*read-only/);
  assert.match(err(() => build('backup-folder', { Source: src, Destination: '\\\\server\\share' })), /BAD_PATH/);
  assert.match(err(() => build('backup-folder', { Source: src, Destination: 'Копия' })), /not a full path/);
  assert.match(err(() => build('backup-folder', { Source: src, Destination: path.join(src, 'backup') })), /must not be inside Source/);
  const outer = path.join(root, 'Обёртка'), inner = path.join(outer, 'внутри'); fs.mkdirSync(inner, { recursive: true });
  assert.match(err(() => build('backup-folder', { Source: inner, Destination: outer })), /must not be inside Source \(or contain it\)/);
  assert.match(err(() => build('sort-folder', { Folder: `${src}\nRemove-Item C:\\` })), /one line/);
  const only = { ...cfg, allowedDirectories: [src] };
  assert.match(err(() => R.buildRecipe({ cfg: only, policy: createPolicy(only) }, 'disk-report', { Folder: dl })), /outside the folders allowed/);
});

test('values become single-quoted literals: every kind of quote doubled — they reach PowerShell exactly', { skip: NOT_WIN }, async () => {
  assert.equal(R.psQuote("O'Brien ’x‘ ‚y‛"), "'O''Brien ’’x‘‘ ‚‚y‛‛'");
  const weird = path.join(root, "Папка O'Brien ’1‘ $env_USERNAME; $(calc)");
  fs.mkdirSync(weird, { recursive: true });
  const b = build('disk-report', { Folder: weird, Top: 5 });
  const lines = b.script.split('\n'), head = lines.slice(0, lines.indexOf('}') + 1).join('\n');
  const r = await runPs(`${head}\nConvertTo-Json -Compress @{ f = $P.Folder; top = $P.Top; out = $P.OutFile }`);
  assert.deepEqual(r, { f: weird, top: 5, out: null });
});

test('every recipe script is valid Windows PowerShell 5.1 and passes the command rules (never names Bridgerator or an excluded folder)', { skip: NOT_WIN }, async () => {
  const scripts = {
    backup: build('backup-folder', { Source: src, Destination: dst }).script,
    clean: build('clean-downloads', {}).script,
    sort: build('sort-folder', { Folder: src }).script,
    disk: build('disk-report', { Folder: src, OutFile: path.join(root, 'отчёт.txt') }).script,
    update: build('update-apps', {}).script,
  };
  for (const [k, s] of Object.entries(scripts)) { assert.equal(ctx.policy.check('start_process', { command: s }), null, k); assert.doesNotMatch(s, /bridgerator/i, k); }
  const r = await runPs(`$out = @{}
foreach ($k in $env:PST_KEYS.Split(',')) { $e = $null; $t = $null; [void][Management.Automation.Language.Parser]::ParseInput([Environment]::GetEnvironmentVariable('PST_' + $k), [ref]$t, [ref]$e); $out[$k] = @($e | ForEach-Object { $_.Message }) }
ConvertTo-Json -Compress -Depth 3 $out`, { env: { PST_KEYS: Object.keys(scripts).join(','), ...Object.fromEntries(Object.entries(scripts).map(([k, v]) => [`PST_${k}`, v])) } });
  for (const k of Object.keys(scripts)) assert.deepEqual(r[k], [], `${k} parses`);
});

test('clean-downloads carries the bridge\'s own Recycle Bin helper, and it compiles in Windows PowerShell 5.1', { skip: NOT_WIN }, async () => {
  const lib = R.recycleLib();
  assert.match(lib, /^Add-Type -TypeDefinition @'\n[\s\S]*class BrRecycle[\s\S]*\n'@$/);
  assert.match(build('clean-downloads', {}).script, /public static class BrRecycle/);
  const r = await runPs(`${lib}\nConvertTo-Json -Compress @{ missing = [BrRecycle]::One('${path.join(root, 'нет файла.txt').replace(/'/g, "''")}') }`, { env: {} });
  assert.deepEqual(r, { missing: 'missing' });
});

// Real runs through the tool (one-off, piped to PowerShell): only temp folders.
const ini = path.join(root, 'confirm.ini'); ensureIni(ini);
const toolCtx = { ...ctx, gate: createGate({ ini, ask: async () => 'deny' }) };
const extra = createExtra([A]);
const run = async (recipe, params) => { const r = await extra.call('bridgerator_automation', { action: 'run', recipe, params }, toolCtx); assert.ok(!r.isError, JSON.stringify(r)); return JSON.parse(r.content[0].text); };

test('sort-folder: dry run lists, a real run moves files into Russian subfolders, names that exist get " (2)", unfinished downloads stay', { skip: NOT_WIN }, async () => {
  const f = path.join(root, 'Разобрать');
  fs.mkdirSync(path.join(f, 'Изображения'), { recursive: true });
  for (const n of ['фото 1.JPG', 'договор.pdf', 'архив.zip', 'фильм.mp4', 'песня.mp3', 'setup.exe', 'качается.crdownload', 'странное.xyz']) fs.writeFileSync(path.join(f, n), 'x');
  fs.writeFileSync(path.join(f, 'Изображения', 'фото 1.JPG'), 'old');
  const dry = await run('sort-folder', { Folder: f, Language: 'ru', DryRun: true });
  assert.equal(dry.code, 0); assert.match(dry.output, /would move: договор\.pdf -> Документы/); assert.match(dry.output, /Dry run: 6 files/);
  assert.ok(fs.existsSync(path.join(f, 'договор.pdf')), 'dry run moved nothing');
  const real = await run('sort-folder', { Folder: f, Language: 'ru' });
  assert.equal(real.code, 0, real.output); assert.match(real.output, /Sorted: 6 files moved; errors: 0/);
  assert.ok(fs.existsSync(path.join(f, 'Документы', 'договор.pdf')));
  assert.ok(fs.existsSync(path.join(f, 'Изображения', 'фото 1 (2).JPG')), 'no overwrite');
  assert.equal(fs.readFileSync(path.join(f, 'Изображения', 'фото 1.JPG'), 'utf8'), 'old');
  assert.ok(fs.existsSync(path.join(f, 'Установщики', 'setup.exe')));
  assert.ok(fs.existsSync(path.join(f, 'качается.crdownload')), 'unfinished download stays');
  assert.ok(fs.existsSync(path.join(f, 'странное.xyz')), 'unknown type stays unless Other = true');
});

test('clean-downloads dry run: only files older than N days, hidden ones left out; nothing moved', { skip: NOT_WIN }, async () => {
  const f = path.join(root, 'Загрузки');
  fs.mkdirSync(f, { recursive: true });
  const old = new Date(Date.now() - 40 * 86400000);
  for (const n of ['старый.iso', 'новый.pdf', 'скрытый.tmp']) fs.writeFileSync(path.join(f, n), 'x'.repeat(1024));
  fs.utimesSync(path.join(f, 'старый.iso'), old, old); fs.utimesSync(path.join(f, 'скрытый.tmp'), old, old);
  await runPs(`(Get-Item -LiteralPath $env:PST_F).Attributes = 'Hidden'; (Get-Item -LiteralPath $env:PST_F -Force).CreationTime = (Get-Date).AddDays(-40); (Get-Item -LiteralPath $env:PST_O).CreationTime = (Get-Date).AddDays(-40); ConvertTo-Json -Compress @{ ok = 1 }`, { env: { PST_F: path.join(f, 'скрытый.tmp'), PST_O: path.join(f, 'старый.iso') } });
  const r = await run('clean-downloads', { Folder: f, Days: 30, DryRun: true });
  assert.equal(r.code, 0);
  assert.match(r.output, /would go to the Recycle Bin: .*старый\.iso/);
  assert.doesNotMatch(r.output, /новый|скрытый/);
  assert.match(r.output, /Dry run: 1 files/);
  assert.ok(fs.existsSync(path.join(f, 'старый.iso')));
});

test('backup-folder copies new and changed files with robocopy; disk-report lists disks, biggest folders and files and saves the .txt', { skip: NOT_WIN }, async () => {
  fs.mkdirSync(path.join(src, 'Отчёты'), { recursive: true });
  fs.writeFileSync(path.join(src, 'Отчёты', 'квартал.txt'), 'x'.repeat(5000));
  fs.writeFileSync(path.join(src, 'заметка.txt'), 'привет');
  const b = await run('backup-folder', { Source: src, Destination: dst });
  assert.equal(b.code, 0, b.output); assert.match(b.output, /Backup done \(robocopy exit code 1\)/);
  assert.equal(fs.readFileSync(path.join(dst, 'заметка.txt'), 'utf8'), 'привет');
  const again = await run('backup-folder', { Source: src, Destination: dst });
  assert.match(again.output, /exit code 0\)/, 'nothing new = nothing copied');
  const out = path.join(root, 'отчёт.txt');
  const d = await run('disk-report', { Folder: src, Top: 5, OutFile: out });
  assert.equal(d.code, 0, d.output);
  assert.match(d.output, /[A-Z]:\s+[\d.,\s]+ GB free of/);
  assert.match(d.output, /Biggest folders in .*Мои документы:/); assert.match(d.output, /MB {2}Отчёты/); assert.match(d.output, /квартал\.txt/);
  assert.deepEqual([...fs.readFileSync(out).subarray(0, 3)], [0xef, 0xbb, 0xbf]); assert.match(fs.readFileSync(out, 'utf8'), /Отчёты/);
});

// B2-1: a folder used as a whole tree may not CONTAIN an excluded / Bridgerator / (for writes) read-only folder.
test('a folder parameter that contains an excluded, Bridgerator or read-only folder is refused (FOLDER_HAS_EXCLUDED); disk-report skips them by hash', () => {
  assert.match(err(() => build('backup-folder', { Source: root, Destination: dst })), /FOLDER_HAS_EXCLUDED/, 'contains the excluded "Секрет"');
  assert.match(err(() => build('backup-folder', { Source: home, Destination: dst })), /FOLDER_HAS_EXCLUDED/, 'contains %APPDATA%\\Bridgerator');
  assert.match(err(() => build('clean-downloads', { Folder: home })), /FOLDER_HAS_EXCLUDED|contains an excluded folder/);
  const box = path.join(root, 'Коробка'); fs.mkdirSync(box, { recursive: true });
  const c2 = { ...cfg, readOnlyDirectories: [path.join(box, 'архив')] };
  const ctx2 = { cfg: c2, policy: createPolicy(c2) };
  assert.match(err(() => R.buildRecipe(ctx2, 'clean-downloads', { Folder: box })), /FOLDER_HAS_EXCLUDED.*read-only|contains a read-only folder/, 'a write tree may not hold a read-only folder');
  assert.match(err(() => R.buildRecipe(ctx2, 'disk-report', { Folder: box })), /no error/, 'reading over a read-only folder is fine');
  const d = build('disk-report', {});
  assert.equal(d.params.Folder, home);
  const want = ['appdata\\roaming\\bridgerator', 'appdata\\local\\bridgerator'].map(R.skipId);
  for (const w of want) assert.ok(d.script.includes(`'${w}'`), w);
  assert.match(R.skipId('AppData\\Local\\Bridgerator'), /^3:[0-9a-f]{16}$/);
  assert.doesNotMatch(d.script, /bridgerator/i);
  assert.equal(ctx.policy.check('start_process', { command: d.script }), null);
});

test('update-apps: winget from WindowsApps only, license flags only with AcceptAgreements, the install confirmation matches it', async () => {
  const { findMatch } = await import('../src/confirm.mjs');
  const plain = build('update-apps', { Mode: 'all' }).script, yes = build('update-apps', { Mode: 'all', AcceptAgreements: true }).script;
  assert.match(plain, /AcceptAgreements = \$false/); assert.match(yes, /AcceptAgreements = \$true/);
  for (const l of plain.split('\n')) if (/--accept-/.test(l)) assert.match(l, /^if \(\$P\.AcceptAgreements\)/, 'license flags only behind AcceptAgreements');
  assert.match(yes, /--accept-source-agreements/); assert.match(yes, /--accept-package-agreements/);
  assert.doesNotMatch(plain, /Get-Command/); assert.match(plain, /'WindowsApps', 'winget\.exe'/);
  assert.equal(findMatch('start_process', { command: plain }, { install: true }, []).cat, 'install');
});

test('disk-report: a drive root stays a root; excluded folders below are not walked; OutFile never overwrites', { skip: NOT_WIN }, async () => {
  const b = build('disk-report', { Folder: src });
  const lines = b.script.split('\n'), at = lines.findIndex((l) => l.startsWith('$base = '));
  const r = await runPs(`$P = @{ Folder = 'C:\\' }\n${lines.slice(lines.findIndex((l) => l.startsWith('$root = ')), at + 1).join('\n')}\nConvertTo-Json -Compress @{ root = $root; base = $base }`);
  assert.deepEqual(r, { root: 'C:\\', base: 'C:\\' });
  const f = path.join(root, 'Смотреть'), hid = path.join(f, 'Тайное');
  fs.mkdirSync(hid, { recursive: true });
  fs.writeFileSync(path.join(hid, 'тайный-большой.bin'), 'x'.repeat(200000)); fs.writeFileSync(path.join(f, 'обычный.txt'), 'x');
  fs.writeFileSync(path.join(f, 'тайный-ключ.key'), 'x'.repeat(300000));   // X1-17: an excluded FILE is never listed
  const c3 = { ...cfg, deniedDirectories: [secret, hid, path.join(f, 'тайный-ключ.key')] };
  const ctx3 = { ...toolCtx, cfg: c3, policy: createPolicy(c3) };
  const out = path.join(root, 'отчёт-2.txt'); fs.writeFileSync(out, 'старый');
  const x = await extra.call('bridgerator_automation', { action: 'run', recipe: 'disk-report', params: { Folder: f, OutFile: out } }, ctx3);
  assert.ok(!x.isError, JSON.stringify(x));
  const o = JSON.parse(x.content[0].text).output;
  assert.match(o, /обычный\.txt/); assert.doesNotMatch(o, /тайный|Тайное/);
  assert.equal(fs.readFileSync(out, 'utf8'), 'старый', 'existing file kept');
  assert.match(o, /Saved to .*отчёт-2 \(2\)\.txt/); assert.ok(fs.existsSync(path.join(root, 'отчёт-2 (2).txt')));
});

test('backup-folder Mirror: refused into a folder with other files; into a new folder it works and marks it for the next runs', { skip: NOT_WIN }, async () => {
  const s2 = path.join(root, 'Исходник'), busy = path.join(root, 'Занято'), fresh = path.join(root, 'Новая копия');
  fs.mkdirSync(s2, { recursive: true }); fs.mkdirSync(busy, { recursive: true });
  fs.writeFileSync(path.join(s2, 'a.txt'), 'a'); fs.writeFileSync(path.join(busy, 'чужое.txt'), 'не трогать');
  const no = await run('backup-folder', { Source: s2, Destination: busy, Mirror: true });
  assert.equal(no.code, 4); assert.match(no.output, /Mirror refused/); assert.ok(fs.existsSync(path.join(busy, 'чужое.txt')));
  const ok = await run('backup-folder', { Source: s2, Destination: fresh, Mirror: true });
  assert.equal(ok.code, 0, ok.output); assert.ok(fs.existsSync(path.join(fresh, '.mirror-backup')));
  fs.writeFileSync(path.join(fresh, 'лишнее.txt'), 'x');
  const again = await run('backup-folder', { Source: s2, Destination: fresh, Mirror: true });
  assert.equal(again.code, 0, again.output); assert.ok(!fs.existsSync(path.join(fresh, 'лишнее.txt')), 'mirrored'); assert.ok(fs.existsSync(path.join(fresh, '.mirror-backup')), 'mark kept');
  // X1-15: a freshly formatted drive root holds only its system folders: Mirror is allowed there.
  const drive = path.join(root, 'Новый диск'); fs.mkdirSync(path.join(drive, 'System Volume Information'), { recursive: true }); fs.mkdirSync(path.join(drive, '$RECYCLE.BIN'));
  const d = await run('backup-folder', { Source: s2, Destination: drive, Mirror: true });
  assert.equal(d.code, 0, d.output); assert.ok(fs.existsSync(path.join(drive, 'System Volume Information')), 'system folders left alone');
  // X1-7: the mark is written BEFORE robocopy runs (a run that fails half-way still marks the folder).
  const lines = build('backup-folder', { Source: s2, Destination: dst, Mirror: true }).script.split('\n');
  assert.ok(lines.findIndex((l) => /WriteAllText\(\$mark/.test(l)) < lines.findIndex((l) => l.startsWith('& $rc')));
});
