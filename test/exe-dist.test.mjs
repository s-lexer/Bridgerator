// The BUILT Windows app in dist/ (node scripts/build-exe.mjs [--sign]): bridgerator.exe starts, answers
// --version and doctor --json (no relay: a throw-away home without settings), runs the real engine
// (rg.exe, PowerShell terminal, sharp), refuses scripts from outside its folder; SHA256SUMS, zip and
// manifest agree; the installer's own download checks pass on the real zip (throw-away profile,
// Restricted policy, nothing installed or started on this PC). Without a build: skipped with the
// reason (NOT CHECKED). LOGIC: critical-logic/install-release.md ("Windows app without Node").
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NOT_WIN, runPs } from './helpers/ps.mjs';
import { NODE_VERSION, stageName, zipName, sha256, walk, authenticode } from '../scripts/build-exe.mjs';
import { OUR_SIGNER } from '../scripts/sign.mjs';
import { runFilesPs } from '../src/ask.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, stageName(VERSION, 'x64'));
const EXE = path.join(STAGE, 'bridgerator.exe');
const MANIFEST = path.join(DIST, 'bridgerator-win.json');
const SKIP = NOT_WIN || (process.arch !== 'x64' ? 'the x64 build runs on x64 only (NOT CHECKED here)' : !fs.existsSync(EXE) || !fs.existsSync(MANIFEST) ? `no build of ${VERSION} in dist/ — run node scripts/build-exe.mjs (NOT CHECKED)` : false);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-dist-'));
const cyr = path.join(tmp, 'Пользователь Тест');
fs.mkdirSync(cyr, { recursive: true });
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }));

// Only our own variables reach the exe (no BR_* / BRIDGERATOR_* from the test runner).
const env = () => { const e = { ...process.env }; for (const k of Object.keys(e)) if (/^(BR_|BRIDGERATOR_|NODE_TEST)/i.test(k)) delete e[k]; return e; };
const run = (args, opts = {}) => new Promise((resolve) => {
  execFile(EXE, args, { env: env(), windowsHide: true, timeout: 120000, encoding: 'utf8', ...opts }, (e, out, err) => resolve({ code: e ? (e.code ?? 1) : 0, out, err }));
});

test('dist: bridgerator.exe --version answers the package version (Node is inside, none installed needed)', { skip: SKIP }, async () => {
  const r = await run(['--version']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), VERSION);
});

test('dist: doctor --json works from the exe (embedded Node 24, no settings → "not set up", no relay contacted)', { skip: SKIP }, async () => {
  const home = path.join(cyr, 'home');
  fs.mkdirSync(home);
  const r = await run(['doctor', '--json', '--home', home]);
  assert.equal(r.code, 1, 'exit 1: a check failed (not set up)');
  const j = JSON.parse(r.out);
  assert.deepEqual(j.results.find((x) => x.id === 'node'), { id: 'node', status: 'ok', title: `Node.js ${NODE_VERSION.slice(1)}` });
  assert.equal(j.results.find((x) => x.id === 'config').status, 'fail');
  assert.ok(!j.results.some((x) => ['relay', 'websocket', 'key'].includes(x.id)), 'no relay check without settings');
});

test('dist: the exe refuses to run a script from outside its folder', { skip: SKIP }, async () => {
  const f = path.join(cyr, 'чужой.mjs');
  fs.writeFileSync(f, 'console.log("RAN")');
  const r = await run([f]);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.out, /RAN/);
  assert.match(r.err, /outside the Bridgerator folder/);
  const r2 = await run(['--import', 'file:///C:/Windows/x.mjs', path.join(STAGE, 'src', 'cli.mjs'), '--version']);
  assert.equal(r2.code, 2);
});

test('dist: the real engine runs as a child of the exe — Cyrillic file round trip, ripgrep search, PowerShell terminal, sharp', { skip: SKIP }, async () => {
  const smoke = path.join(STAGE, `exe-smoke-${process.pid}.mjs`);
  fs.copyFileSync(path.join(ROOT, 'test', 'fixtures', 'exe-smoke.mjs'), smoke);
  const cfg = path.join(cyr, 'cfg'), work = path.join(cyr, 'work');
  fs.mkdirSync(work, { recursive: true });
  let r;
  try { r = await run([smoke, cfg, work]); } finally { fs.rmSync(smoke, { force: true }); }
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out.trim().split(/\r?\n/).at(-1));
  assert.equal(j.error, undefined, j.error);
  assert.equal(j.execPath.toLowerCase(), EXE.toLowerCase());
  assert.ok(j.tools >= 30, `${j.tools} tools`);
  assert.match(j.write, /Successfully wrote/);
  assert.match(j.read, /привет needle/);
  assert.match(j.search, /заметка needle\.txt/);
  assert.match(j.shell, /ok-42/);
  assert.equal(j.dcConfig, true, 'the engine config went to our folder (module hooks work in the exe)');
  assert.equal(j.sharpPng, 'PNG');
  assert.equal(j.pcHealth.isError, false, j.pcHealth.text);
});

test('dist: our .ps1 files load the way the bridge reads them (ReadAllText UTF-8 → scriptblock), BOM and signature block included, same code as src/', { skip: SKIP }, async () => {
  const files = walk(STAGE).filter((f) => /^src\/.*\.ps1$/.test(f));
  assert.ok(files.length >= 8);
  const r = await runPs(String.raw`
$out = @()
foreach ($f in ($env:PST_FILES -split '\|')) {
  $t = [IO.File]::ReadAllText($f, [Text.Encoding]::UTF8); $e = $null
  try { [void][scriptblock]::Create($t) } catch { $e = "$_" }
  $out += @{ f = $f; err = $e; bom = ($t.Length -gt 0 -and [int]$t[0] -eq 0xFEFF); text = ($t -split '# SIG # Begin signature block')[0] }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
`, { env: { PST_FILES: files.map((f) => path.join(STAGE, ...f.split('/'))).join('|') } });
  for (const [i, x] of r.entries()) {
    assert.equal(x.err, null, x.f);
    assert.equal(x.bom, false, `${x.f}: ReadAllText drops the BOM`);
    assert.equal(x.text.replace(/\s+$/, ''), fs.readFileSync(path.join(ROOT, ...files[i].split('/')), 'utf8').replace(/\s+$/, ''), files[i]);
  }
});

test('dist: the SIGNED scripts the bridge joins (ask-lib + ask / tray / recycle) build one scriptblock exactly as runFilesPs does', { skip: SKIP }, async () => {
  // Regression 1.1.0: PowerShell refuses code after an Authenticode block → tray, toasts and Recycle Bin all failed.
  const lib = path.join(STAGE, 'src', 'ask-lib.ps1');
  for (const main of ['ask.ps1', 'tray.ps1', 'recycle.ps1']) {
    const r = await runPs(`$e = $null; try { [void]${runFilesPs(lib, path.join(STAGE, 'src', main)).slice(2)} } catch { $e = "$_" }; @{ e = $e } | ConvertTo-Json -Compress`);
    assert.equal(r.e, null, main);
  }
});

test('dist: SHA256SUMS.txt, the zip and the download list agree; dist/install.ps1 pins the list', { skip: SKIP }, async () => {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.equal(m.version, VERSION);
  const zip = path.join(DIST, m.x64.file);
  assert.equal(m.x64.file, zipName(VERSION, 'x64'));
  assert.equal(sha256(fs.readFileSync(zip)), m.x64.sha256);
  assert.equal(fs.statSync(zip).size, m.x64.size);
  const sums = fs.readFileSync(path.join(STAGE, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(sums.map((l) => l.slice(66)), walk(STAGE).filter((f) => f !== 'SHA256SUMS.txt'));
  for (const l of sums.filter((x) => /\.(exe|ps1|mjs)$/.test(x))) assert.equal(sha256(fs.readFileSync(path.join(STAGE, ...l.slice(66).split('/')))), l.slice(0, 64), l.slice(66));
  assert.ok(!sums.some((l) => /\.map$|\.d\.ts$|^install\.ps1$|exe-smoke/.test(l.slice(66))), 'no source maps / declarations / installer / test leftovers');
  assert.match(fs.readFileSync(path.join(DIST, 'install.ps1'), 'utf8'), new RegExp(`^\\$WinManifestSha256 = '${sha256(fs.readFileSync(MANIFEST))}'$`, 'm'));
});

test('dist: the installer\'s download checks pass on the real zip and the new exe answers its version (throw-away profile, Restricted policy)', { skip: SKIP }, async () => {
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const prof = path.join(cyr, 'профиль');
  const r = await runPs(String.raw`
$tok = $null; $err = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput([IO.File]::ReadAllText($env:PST_INSTALL, [Text.Encoding]::UTF8), [ref]$tok, [ref]$err)
foreach ($n in 'Get-Sha256', 'Get-Arch', 'Read-AppManifest', 'Test-App', 'Get-App') { . ([scriptblock]::Create(($ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true) | Select-Object -First 1).Extent.Text)) }
$Work = Join-Path $env:LOCALAPPDATA "Bridgerator\tmp-$([guid]::NewGuid().ToString('N'))"; [void][IO.Directory]::CreateDirectory($Work)
$res = @{}
try {
  $m = Read-AppManifest $env:PST_MF (Get-Arch)
  $AppZip = $env:PST_ZIP; $Sha256 = $m.sha256
  $dir = Get-App
  $res.version = Test-App $dir $m.version
  $res.files = @([IO.File]::ReadAllLines((Join-Path $dir 'SHA256SUMS.txt'))).Count
} catch { $res.err = "$_" }
try { [IO.Directory]::Delete($Work, $true) } catch {}
$res | ConvertTo-Json -Compress
`, { env: { PST_INSTALL: path.join(DIST, 'install.ps1'), PST_MF: MANIFEST, PST_ZIP: path.join(DIST, m.x64.file), APPDATA: path.join(prof, 'Roaming'), LOCALAPPDATA: path.join(prof, 'Local') }, policy: 'Restricted', timeout: 600000 });
  assert.equal(r.err, undefined, r.err);
  assert.equal(r.version, VERSION);
  assert.equal(r.files, m.x64.files - 1, 'every file of the zip but SHA256SUMS.txt itself was checked');
  assert.equal(fs.existsSync(path.join(prof, 'Roaming', 'Bridgerator')), false, 'no settings were created');
});

test('dist: signature state of our files (signed build: our EV certificate + timestamp on every exe and .ps1)', { skip: SKIP }, (t) => {
  const files = [EXE, ...walk(STAGE).filter((f) => /^src\/.*\.ps1$/.test(f)).map((f) => path.join(STAGE, ...f.split('/'))), path.join(DIST, 'install.ps1')];
  const st = authenticode(files);
  if (st.every((s) => s.status === 'NotSigned')) { t.diagnostic('dist is not signed yet (node scripts/sign.mjs) — signature NOT CHECKED'); return; }
  for (const s of st) {
    assert.equal(s.status, 'Valid', `${s.path}: ${s.message}`);
    assert.match(s.signer, OUR_SIGNER, s.path);
    assert.ok(s.timestamper, `${s.path} has a timestamp`);
  }
});
