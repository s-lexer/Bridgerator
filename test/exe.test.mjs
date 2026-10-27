// The Windows app without Node (scripts/build-exe.mjs, scripts/exe-main.cjs, scripts/sign.mjs) and the
// CLI parts for it: the pure logic, with no download, no real signing (sign-api is mocked) and no
// install. The built exe itself: test/exe-dist.test.mjs. LOGIC: critical-logic/install-release.md.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NOT_WIN, runPs } from './helpers/ps.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { plan } = require('../scripts/exe-main.cjs');
const B = await import('../scripts/build-exe.mjs');
const S = await import('../scripts/sign.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-exe-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---- bridgerator.exe entry: what it runs ---------------------------------------------------------
const APP = 'C:\\Users\\Иван Петров\\AppData\\Local\\Bridgerator\\app';
const EXE = `${APP}\\bridgerator.exe`;

test('exe: plain arguments run the bundled CLI with them (bridgerator.exe setup --allow D:\\x.js)', () => {
  assert.deepEqual(plan([EXE, EXE, 'setup', '--allow', 'D:\\x.js'], APP), { imports: [], script: `${APP}\\src\\cli.mjs`, rest: ['setup', '--allow', 'D:\\x.js'] });
  assert.deepEqual(plan([EXE, EXE], APP).rest, []);
  assert.deepEqual(plan([EXE, EXE, '--version'], APP).rest, ['--version'], 'a flag is never taken for a script');
});

test('exe: the autostart line (exe + cli.mjs run) and the engine child (--import dc-isolate + engine entry) run as node would', () => {
  const cli = `${APP}\\src\\cli.mjs`;
  assert.deepEqual(plan([EXE, EXE, cli, 'run'], APP), { imports: [], script: cli, rest: ['run'] });
  const isolate = pathToFileURL(`${APP}\\src\\dc-isolate.mjs`).href;
  const engine = `${APP}\\node_modules\\bridgerator-engine\\dist\\index.js`;
  const p = plan([EXE, EXE, '--import', isolate, engine], APP);
  assert.equal(p.imports[0].toLowerCase(), `${APP}\\src\\dc-isolate.mjs`.toLowerCase(), 'file:// URL with Cyrillic and spaces → the path');
  assert.equal(p.script, engine);
  assert.deepEqual(plan([EXE, EXE, `${APP.toUpperCase()}\\NODE_MODULES\\X\\.mcp-exec-1.mjs`], APP).rest, [], 'case does not matter on Windows');
});

test('exe: a script or --import outside the app folder is refused (the signed exe is no general JS runner)', () => {
  for (const argv of [
    ['C:\\Users\\Иван Петров\\Downloads\\evil.mjs'],
    [`${APP}\\..\\evil.mjs`],
    [`${APP}2\\evil.mjs`],
    ['\\\\server\\share\\x.js'],
    ['--import', 'file:///C:/Temp/hook.mjs', `${APP}\\src\\cli.mjs`],
    ['--import', `${APP}\\src\\dc-isolate.mjs`],
    ['--import'],
  ]) assert.throws(() => plan([EXE, EXE, ...argv], APP), { code: 'BAD_ARGS' }, argv.join(' '));
});

// ---- build: node.exe, the shrinkwrap tree, the fuse ----------------------------------------------
test('build: node.exe hash is taken from the SHASUMS256.txt line of that exact file', () => {
  const text = `${'a'.repeat(64)}  node-v24.22.0-win-x64.zip\n${'b'.repeat(64)}  win-x64/node.exe\n${'c'.repeat(64)}  win-arm64/node.exe\n`;
  assert.equal(B.sumFor(text, 'win-x64/node.exe'), 'b'.repeat(64));
  assert.equal(B.sumFor(text.replace(/\n/g, '\r\n'), 'win-arm64/node.exe'), 'c'.repeat(64));
  assert.throws(() => B.sumFor(text, 'win-x86/node.exe'), /no SHA256/);
  assert.throws(() => B.sumFor('zz  win-x64/node.exe', 'win-x64/node.exe'), /no SHA256/);
});

test('build: the node_modules tree per arch follows npm-shrinkwrap.json (other OS/CPU out, the arch\'s own native packages fetched)', () => {
  const lock = { packages: {
    '': { name: 'bridgerator' },
    'node_modules/ws': { version: '8.20.0' },
    'node_modules/a/node_modules/b': { version: '1.0.0' },
    'node_modules/@img/sharp-win32-x64': { version: '0.34.5', optional: true, os: ['win32'], cpu: ['x64'], resolved: 'https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-0.34.5.tgz', integrity: 'sha512-x' },
    'node_modules/@img/sharp-win32-arm64': { version: '0.34.5', optional: true, os: ['win32'], cpu: ['arm64'], resolved: 'https://registry.npmjs.org/@img/sharp-win32-arm64/-/sharp-win32-arm64-0.34.5.tgz', integrity: 'sha512-y' },
    'node_modules/@img/sharp-linux-x64': { version: '0.34.5', optional: true, os: ['linux'], cpu: ['x64'] },
    'node_modules/@img/sharp-wasm32': { version: '0.34.5', optional: true, cpu: ['wasm32'] },
    'node_modules/@emnapi/runtime': { version: '1.0.0', optional: true },
    'node_modules/devonly': { version: '1.0.0', dev: true },
    'node_modules/linked': { link: true, resolved: 'x' },
  } };
  const installed = new Set(['node_modules/ws', 'node_modules/a/node_modules/b', 'node_modules/@img/sharp-win32-x64']);
  const has = (d) => installed.has(d);
  const x64 = B.modulesFor(lock, 'x64', has);
  assert.deepEqual(x64.map((m) => [m.dir, !!m.fetch]), [['node_modules/@img/sharp-win32-x64', false], ['node_modules/a/node_modules/b', false], ['node_modules/ws', false]]);
  const arm = B.modulesFor(lock, 'arm64', has);
  assert.deepEqual(arm.map((m) => [m.dir, m.fetch?.integrity || null]), [['node_modules/@img/sharp-win32-arm64', 'sha512-y'], ['node_modules/a/node_modules/b', null], ['node_modules/ws', null]]);
  assert.throws(() => B.modulesFor(lock, 'x64', (d) => d !== 'node_modules/ws'), /node_modules\/ws 8\.20\.0 is missing .* npm ci/);
  const bad = { packages: { 'node_modules/@x/win-arm64': { version: '1.0.0', optional: true, os: ['win32'], cpu: ['arm64'], resolved: 'http://evil.example/x.tgz', integrity: 'sha512-z' } } };
  assert.throws(() => B.modulesFor(bad, 'arm64', () => false), /no registry tarball/);
});

test('build: the real npm-shrinkwrap.json gives arm64 its own rg.exe and sharp packages and keeps x64 ones out', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'npm-shrinkwrap.json'), 'utf8'));
  const has = (d) => fs.existsSync(path.join(ROOT, d, 'package.json'));
  const arm = B.modulesFor(lock, 'arm64', has).map((m) => m.dir);
  for (const d of ['node_modules/@vscode/ripgrep-win32-arm64', 'node_modules/@img/sharp-win32-arm64']) assert.ok(arm.includes(d), d);
  for (const d of ['node_modules/@vscode/ripgrep-win32-x64', 'node_modules/@img/sharp-win32-x64', 'node_modules/@img/sharp-wasm32']) assert.ok(!arm.includes(d), d);
  assert.ok(B.modulesFor(lock, 'x64', has).every((m) => !m.fetch || /win32-x64/.test(m.dir)), 'x64 needs nothing from the network except its own natives (none when node_modules is installed on x64)');
});

test('build: the SEA fuse is flipped exactly once; a binary without it or with two is refused', () => {
  const f = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
  const b = Buffer.from(`xx${f}:0yy`);
  assert.equal(B.flipFuse(b).toString(), `xx${f}:1yy`);
  assert.throws(() => B.flipFuse(Buffer.from('nothing')), /fuse/);
  assert.throws(() => B.flipFuse(Buffer.from(`${f}:0 ${f}:0`)), /fuse/);
});

test('build: a .ps1 with non-ASCII text gets a UTF-8 BOM (else its signature never verifies); ASCII ones stay byte-for-byte', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const cyr = Buffer.from('# Тест — кнопка\nWrite-Output 1\n');
  assert.ok(B.ps1ForSigning(cyr).equals(Buffer.concat([bom, cyr])));
  assert.ok(B.ps1ForSigning(Buffer.concat([bom, cyr])).equals(Buffer.concat([bom, cyr])), 'no second BOM');
  const ascii = Buffer.from('Write-Output 1\r\n');
  assert.equal(B.ps1ForSigning(ascii), ascii);
});

// A tar entry: 512-byte ustar header + data padded to 512.
const tarEntry = (name, data, type = '0') => {
  const h = Buffer.alloc(512);
  h.write(name, 0, 'utf8'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124); h.write('00000000000\0', 136); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  h.write('        ', 148);
  let sum = 0; for (const x of h) sum += x;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
};

test('build: npm tarballs unpack under the package folder; a path that climbs out is refused', () => {
  const pax = Buffer.from('30 path=package/lib/очень длинное.js\n');
  const tgz = zlib.gzipSync(Buffer.concat([tarEntry('package/package.json', Buffer.from('{"name":"x"}')), tarEntry('package/bin/', Buffer.alloc(0), '5'), tarEntry('PaxHeader', pax, 'x'), tarEntry('package/lib/short.js', Buffer.from('ok')), Buffer.alloc(1024)]));
  const dest = path.join(tmp, 'untar');
  B.untar(tgz, dest);
  assert.deepEqual(B.walk(dest), ['lib/очень длинное.js', 'package.json']);
  assert.equal(fs.readFileSync(path.join(dest, 'lib', 'очень длинное.js'), 'utf8'), 'ok');
  assert.throws(() => B.untar(zlib.gzipSync(Buffer.concat([tarEntry('package/../../evil.js', Buffer.from('x')), Buffer.alloc(1024)])), path.join(tmp, 'untar2')), /bad path/);
});

// ---- pack: SHA256SUMS, deterministic zip, manifest, pinned installer --------------------------------
function fakeApp(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', 'пакет с пробелом'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridgerator.exe'), crypto.randomBytes(5000));
  fs.writeFileSync(path.join(dir, 'src', 'cli.mjs'), 'console.log(1)\n'.repeat(200));
  fs.writeFileSync(path.join(dir, 'node_modules', 'пакет с пробелом', 'index.js'), 'module.exports = "привет"');
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');
}

test('pack: SHA256SUMS.txt lists every file once (not itself), "/" separated, sorted', () => {
  const d = path.join(tmp, 'sums'); fakeApp(d);
  assert.equal(B.writeSums(d), 4);
  const lines = fs.readFileSync(path.join(d, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((l) => l.slice(66)), ['bridgerator.exe', 'empty.txt', 'node_modules/пакет с пробелом/index.js', 'src/cli.mjs']);
  for (const l of lines) assert.match(l, /^[0-9a-f]{64} \*/);
  assert.equal(lines[1].slice(0, 64), crypto.createHash('sha256').update('').digest('hex'));
  B.writeSums(d);
  assert.equal(fs.readFileSync(path.join(d, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').length, 4, 'running again does not list SHA256SUMS.txt');
});

test('pack: the zip is byte-for-byte the same for the same files, and Windows (.NET ZipFile, as the installer) unpacks it exactly', { skip: NOT_WIN }, async () => {
  const d = path.join(tmp, 'zipsrc'); fakeApp(d); B.writeSums(d);
  const z1 = path.join(tmp, 'a.zip'), z2 = path.join(tmp, 'b.zip');
  B.zipDir(d, z1);
  fs.utimesSync(path.join(d, 'src', 'cli.mjs'), new Date(2001, 1, 1), new Date(2001, 1, 1));
  B.zipDir(d, z2);
  assert.equal(B.sha256(fs.readFileSync(z1)), B.sha256(fs.readFileSync(z2)), 'file times do not change the zip');
  const out = path.join(tmp, 'unz', 'Пользователь');
  const r = await runPs(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:PST_ZIP, $env:PST_OUT); @{ ok = $true } | ConvertTo-Json -Compress`, { env: { PST_ZIP: z1, PST_OUT: out } });
  assert.equal(r.ok, true);
  assert.deepEqual(B.walk(out), B.walk(d));
  for (const f of B.walk(d)) assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(d, f))), f);
});

test('pack: manifest names zip + SHA256 + size per arch; dist/install.ps1 carries the manifest SHA256', () => {
  const out = path.join(tmp, 'dist');
  fakeApp(path.join(out, B.stageName('9.9.9', 'x64')));
  fakeApp(path.join(out, B.stageName('9.9.9', 'arm64')));
  const m = B.pack(out, { version: '9.9.9', node: 'v24.22.0', arches: ['x64', 'arm64'] });
  assert.equal(m.version, '9.9.9');
  for (const a of ['x64', 'arm64']) {
    assert.equal(m[a].file, `bridgerator-9.9.9-win-${a}.zip`);
    assert.match(m[a].file, new RegExp(`^bridgerator-[0-9]+\\.[0-9]+\\.[0-9]+-win-${a}\\.zip$`), 'what install.ps1 Read-AppManifest accepts');
    assert.equal(m[a].sha256, B.sha256(fs.readFileSync(path.join(out, m[a].file))));
    assert.equal(m[a].size, fs.statSync(path.join(out, m[a].file)).size);
  }
  const text = fs.readFileSync(path.join(out, 'bridgerator-win.json'));
  const inst = fs.readFileSync(path.join(out, 'install.ps1'), 'utf8');
  assert.match(inst, new RegExp(`^\\$WinManifestSha256 = '${B.sha256(text)}'$`, 'm'));
  assert.throws(() => B.pinInstaller('no line here', 'a'.repeat(64)), /WinManifestSha256/);
  assert.throws(() => B.pinInstaller("$WinManifestSha256 = ''", 'nothex'), /hash/);
  assert.throws(() => B.pack(path.join(tmp, 'nothing'), { version: '9.9.9', arches: ['x64'] }), /no bridgerator\.exe/);
});

// ---- signing (sign-api mocked; the real run is scripts/sign.mjs on dist) -----------------------------
test('sign: SIGN_API / SIGN_TOKEN from the environment first, else from the K-AutoAdmin env file', () => {
  assert.deepEqual(S.signConfig({ env: { SIGN_API: 'http://10.0.0.1:7771/', SIGN_TOKEN: 't1' }, read: () => { throw new Error('not read'); } }), { api: 'http://10.0.0.1:7771', token: 't1' });
  const file = 'SSH_HOST=x\nSIGN_API=http://10.0.0.2:7771\r\nSIGN_TOKEN="abc def"\n';
  assert.deepEqual(S.signConfig({ env: {}, read: () => file }), { api: 'http://10.0.0.2:7771', token: 'abc def' });
  assert.throws(() => S.signConfig({ env: {}, read: () => 'SIGN_API=http://x' }), /missing/);
  assert.throws(() => S.signConfig({ env: {}, read: () => { throw Object.assign(new Error('no'), { code: 'ENOENT' }); } }), /not readable \(ENOENT\)/);
  assert.throws(() => S.signConfig({ env: { SIGN_API: 'http://x/sign?a', SIGN_TOKEN: 't' } }), /plain/);
  // The EV signing token never goes over plain http to a public address (review b5).
  assert.throws(() => S.signConfig({ env: { SIGN_API: 'http://sign.example.com', SIGN_TOKEN: 't' } }), /private network/);
  assert.throws(() => S.signConfig({ env: { SIGN_API: 'http://8.8.8.8:7771', SIGN_TOKEN: 't' } }), /private network/);
  assert.deepEqual(S.signConfig({ env: { SIGN_API: 'https://sign.example.com', SIGN_TOKEN: 't' } }), { api: 'https://sign.example.com', token: 't' });
  assert.equal(S.signConfig({ env: { SIGN_API: 'http://192.168.1.5:7771', SIGN_TOKEN: 't' } }).api, 'http://192.168.1.5:7771');
});

test('build: every downloaded node.exe must be in the signature answer and signed by OpenJS (review b5)', () => {
  const ok = { path: 'C:\\c\\a.exe', status: 'Valid', signer: 'CN=OpenJS Foundation, O=OpenJS Foundation' };
  assert.doesNotThrow(() => B.checkOpenJs(['C:\\c\\a.exe'], [ok]));
  assert.throws(() => B.checkOpenJs(['C:\\c\\a.exe', 'C:\\c\\b.exe'], [ok]), /b\.exe: no signature state/);
  assert.throws(() => B.checkOpenJs(['C:\\c\\a.exe'], [{ ...ok, status: 'HashMismatch' }]), /not a valid OpenJS/);
  assert.throws(() => B.checkOpenJs(['C:\\c\\a.exe'], []), /no signature state/);
});

test('build: a truncated cached SHASUMS256.txt is downloaded again (written atomically) (review b5)', async () => {
  const cache = path.join(tmp, 'sums-cache');
  fs.mkdirSync(cache, { recursive: true });
  const exe = Buffer.from('fake node');
  const sum = crypto.createHash('sha256').update(exe).digest('hex');
  fs.writeFileSync(path.join(cache, 'SHASUMS256-v24.0.0.txt'), `${'0'.repeat(64)}  win-arm64/no`);   // cut off mid-file
  const seen = [];
  const fetch = async (u) => { seen.push(u); const b = u.endsWith('SHASUMS256.txt') ? Buffer.from(`${sum}  win-x64/node.exe\n`) : exe; return { ok: true, status: 200, arrayBuffer: async () => b }; };
  const f = await B.nodeExe('v24.0.0', 'x64', cache, { fetch });
  assert.deepEqual(fs.readFileSync(f), exe);
  assert.ok(seen.some((u) => u.endsWith('SHASUMS256.txt')), 'fetched again');
  assert.match(fs.readFileSync(path.join(cache, 'SHASUMS256-v24.0.0.txt'), 'utf8'), /win-x64\/node\.exe/);
  assert.equal(fs.existsSync(path.join(cache, 'SHASUMS256-v24.0.0.txt.part')), false);
});

test('sign: our exe and our .ps1 files are signed; Microsoft WebView2 DLLs and third-party node_modules are not', () => {
  const d = path.join(tmp, 'tosign');
  for (const f of ['bridgerator.exe', 'src/tray.ps1', 'src/ask-lib.ps1', 'recipes/x.ps1', 'vendor/webview2/Microsoft.Web.WebView2.Core.dll', 'vendor/webview2/x64/WebView2Loader.dll', 'node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe', 'node_modules/a/s.ps1', 'src/cli.mjs', 'bridgerator.cmd']) {
    fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), 'x');
  }
  assert.deepEqual(S.filesToSign(d).map((f) => path.relative(d, f).split(path.sep).join('/')), ['bridgerator.exe', 'recipes/x.ps1', 'src/ask-lib.ps1', 'src/tray.ps1']);
});

const TOKEN = 'sekret-token-123';
const okVerify = async () => ({ ok: true, signer: 'CN=X, SERIALNUMBER=193808466', timestamp: 'Tue Oct 21 12:00:00 2026', timestamper: 'CN=GlobalSign TSA', notAfter: '2026-11-13T00:00:00Z' });
const answer = (status, body) => ({ ok: status === 200, status, arrayBuffer: async () => Buffer.from(body), json: async () => JSON.parse(body) });

test('sign: a reset upload is retried; the signed answer replaces the file only after it verifies', async () => {
  const f = path.join(tmp, 'tray.ps1'); fs.writeFileSync(f, 'Write-Output 1\r\n');
  let n = 0; const seen = [];
  const fetch = async (url, o) => { n++; seen.push({ url, auth: o.headers.authorization, name: o.body.get('file').name, redirect: o.redirect }); if (n < 3) throw new Error('socket hang up'); return answer(200, 'Write-Output 1\r\n# SIG # Begin signature block\r\n'); };
  const v = await S.signFile(f, { api: 'http://sign:7771', token: TOKEN, fetch, verify: okVerify, pause: 1 });
  assert.equal(n, 3);
  assert.deepEqual(seen[0], { url: 'http://sign:7771/sign', auth: `Bearer ${TOKEN}`, name: 'tray.ps1', redirect: 'error' }, 'the token never follows a redirect (X3-7)');
  assert.match(fs.readFileSync(f, 'utf8'), /SIG # Begin signature block/);
  assert.equal(v.timestamp, 'Tue Oct 21 12:00:00 2026');
  assert.deepEqual(fs.readdirSync(tmp).filter((x) => /signing/.test(x)), [], 'no temp file left');
});

test('sign: an answer that fails the check (no timestamp, foreign cert, invalid) never replaces the original', async () => {
  const f = path.join(tmp, 'bridgerator.exe'); fs.writeFileSync(f, 'ORIGINAL');
  const fetch = async () => answer(200, 'SIGNED-BUT-BAD');
  let checked = '';
  const verify = async (p) => { checked = p; return { ok: false, why: 'no timestamp (the signature would die with the certificate on 2026-11-13)' }; };
  await assert.rejects(S.signFile(f, { api: 'http://sign', token: TOKEN, fetch, verify, pause: 1 }), /no timestamp.*left as it was/);
  assert.equal(fs.readFileSync(f, 'utf8'), 'ORIGINAL');
  assert.match(path.basename(checked), /^bridgerator\.signing\.exe$/, 'checked under the same extension (signtool picks the format by it)');
  assert.equal(fs.existsSync(checked), false);
});

test('sign: sign-api errors are reported without the token; after 5 failures the file is untouched', async () => {
  const f = path.join(tmp, 'x.ps1'); fs.writeFileSync(f, 'ORIGINAL');
  let n = 0;
  const fetch = async () => { n++; if (n === 1) throw new Error(`connect failed for Bearer ${TOKEN}`); return answer(500, JSON.stringify({ error: 'jsign failed (rc=1): jsign: Unsupported file\njava.lang...' })); };
  const e = await S.signFile(f, { api: 'http://sign', token: TOKEN, fetch, verify: okVerify, pause: 1 }).catch((x) => x);
  assert.equal(n, 5);
  assert.match(e.message, /after 5 attempts \(sign-api HTTP 500: jsign failed \(rc=1\): jsign: Unsupported file\)/);
  assert.doesNotMatch(e.message, new RegExp(TOKEN));
  assert.equal(fs.readFileSync(f, 'utf8'), 'ORIGINAL');
});

test('sign: files already validly signed by us are not sent again (re-running sign.mjs is safe)', async () => {
  const a = path.join(tmp, 'a.ps1'), b = path.join(tmp, 'b.ps1');
  fs.writeFileSync(a, 'signed'); fs.writeFileSync(b, 'plain');
  const sent = [];
  const verify = async (p) => (fs.readFileSync(p, 'utf8').startsWith('signed') ? okVerify() : { ok: false, why: 'NotSigned' });
  const r = await S.signAll([a, b], { api: 'http://sign', token: TOKEN, verify, pause: 1, fetch: async (_u, o) => { sent.push(o.body.get('file').name); return answer(200, 'signed now'); } });
  assert.deepEqual(sent, ['b.ps1']);
  assert.deepEqual(r.map((x) => x.signed), [false, true]);
});

test('sign: the check itself — signtool failure, status not Valid, another signer, a missing timestamp all fail', async () => {
  const st = (code, ts = true) => async () => ({ code, out: ts ? 'Successfully verified\nThe signature is timestamped: Tue Oct 21 12:00:00 2026\n' : 'Successfully verified\n' });
  const ps = (o) => () => [{ status: 'Valid', signer: 'CN="ООО СофтИнноватиксПлюс", SERIALNUMBER=193808466, O=ООО СофтИнноватиксПлюс', timestamper: 'CN=Globalsign TSA for Advanced - G4', notAfter: '2026-11-13T07:00:00.0000000Z', ...o }];
  assert.equal((await S.verifySigned('f', { signtool: st(0), ps: ps({}) })).ok, true);
  assert.match((await S.verifySigned('f', { signtool: st(1), ps: ps({}) })).why, /signtool verify failed/);
  assert.match((await S.verifySigned('f', { signtool: st(0), ps: ps({ status: 'HashMismatch' }) })).why, /HashMismatch/);
  assert.match((await S.verifySigned('f', { signtool: st(0), ps: ps({ signer: 'CN=Someone Else, SERIALNUMBER=1938084660' }) })).why, /not with our certificate/);
  assert.match((await S.verifySigned('f', { signtool: st(0, false), ps: ps({}) })).why, /no timestamp/);
  assert.match((await S.verifySigned('f', { signtool: st(0), ps: ps({ timestamper: '' }) })).why, /no timestamp/);
});

// ---- the CLI in the app ------------------------------------------------------------------------------
test('cli: --version prints the version and creates nothing (the installer start check)', () => {
  const appData = path.join(tmp, 'Roaming v'), local = path.join(tmp, 'Local v');
  const out = execFileSync(process.execPath, [path.join(ROOT, 'src', 'cli.mjs'), '--version'], { env: { ...process.env, APPDATA: appData, LOCALAPPDATA: local, NODE_TEST_CONTEXT: '' }, encoding: 'utf8' }).trim();
  assert.equal(out, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(fs.existsSync(appData), false, 'no settings folder created');
});

test('cli: uninstall --all deletes the app folder only when it is the installer\'s own %LOCALAPPDATA%\\Bridgerator\\app', async () => {
  process.env.BRIDGERATOR_HOME = path.join(tmp, 'home');
  const cwd = process.cwd();
  const { programFiles, removeLaterCmd, removeLaterArgs, removeLaterEnv, APP_DIR } = await import('../src/cli.mjs');
  process.chdir(cwd);
  const app = 'C:\\Users\\Иван\\AppData\\Local\\Bridgerator\\app';
  assert.deepEqual(programFiles({ sea: false }), { exe: false });
  assert.deepEqual(programFiles({ sea: true, execPath: `${app}\\bridgerator.exe`, pkgDir: app, appDir: `${app.toUpperCase()}\\` }), { exe: true, dir: app, ours: true });
  assert.equal(programFiles({ sea: true, execPath: 'D:\\ARM\\bridgerator\\dist\\b\\bridgerator.exe', pkgDir: 'D:\\ARM\\bridgerator\\dist\\b', appDir: app }).ours, false, 'a build run from dist/ is never deleted');
  assert.equal(programFiles({ sea: true, execPath: `${app}\\bridgerator.exe`, pkgDir: 'D:\\elsewhere', appDir: app }).ours, false);
  assert.match(APP_DIR, /[\\/]Bridgerator[\\/]app$/);
  const cmd = removeLaterCmd([app, 'C:\\L\\Bridgerator\\node']);
  // The paths themselves go in environment variables (expanded once: a % in a path stays as it is).
  assert.match(cmd, /^"[^"]+PING\.EXE" -n 4 127\.0\.0\.1 >nul & rmdir \/s \/q "%BRRM0%" & rmdir \/s \/q "%BRRM1%" & rmdir "%BRRMP%"$/);
  assert.deepEqual(removeLaterEnv([app, 'C:\\L\\Bridgerator\\node'], 'C:\\L\\Bridgerator'), { BRRM0: app, BRRM1: 'C:\\L\\Bridgerator\\node', BRRMP: 'C:\\L\\Bridgerator' });
  assert.deepEqual(removeLaterArgs([app]).slice(0, 3), ['/d', '/s', '/c'], 'one outer pair of quotes for cmd /s /c to strip');
});

// VM11-3 / VM10-1: cmd /c dropped the first and the last quote of the line, so nothing was deleted.
// Runs the REAL line the way uninstall --all spawns it, on throw-away folders (spaces, Cyrillic, brackets).
test('cli: the delayed delete of uninstall --all really removes the folders and then the empty parent', { skip: NOT_WIN }, async () => {
  process.env.BRIDGERATOR_HOME = path.join(tmp, 'home');
  const cwd = process.cwd();
  const { startRemoveLater } = await import('../src/cli.mjs');
  process.chdir(cwd);
  const { spawn } = await import('node:child_process');
  // %USERNAME% in a folder name: cmd would expand it if the path were in the command line (X3-22).
  const parent = path.join(tmp, 'Local Иван (x) %USERNAME% & co', 'Bridgerator');
  const app = path.join(parent, 'app'), node = path.join(parent, 'node');
  for (const d of [app, node]) { fs.mkdirSync(path.join(d, 'src deep'), { recursive: true }); fs.writeFileSync(path.join(d, 'src deep', 'файл.txt'), 'x'); }
  // The real start (detached, as uninstall --all runs it): cmd.exe's own folder is %SystemRoot%, never one it deletes (X3-10).
  let opts, child;
  const spawnFn = (cmd, args, o) => { opts = o; child = spawn(cmd, args, { ...o, detached: false }); return child; };
  assert.equal(await startRemoveLater([app, node], parent, { spawnFn }), null, 'started');
  assert.equal(opts.cwd.toLowerCase(), (process.env.SystemRoot || 'C:\\Windows').toLowerCase());
  const code = child.exitCode ?? await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.equal(fs.existsSync(app), false, 'app folder removed');
  assert.equal(fs.existsSync(node), false, 'node folder removed');
  assert.equal(fs.existsSync(parent), false, 'empty parent removed');
  // A cmd.exe that cannot start is reported, not "removed in a few seconds" (X2-23).
  const bad = await startRemoveLater([app], parent, { spawnFn: (cmd, args, o) => spawn(path.join(tmp, 'нет.exe'), args, o) });
  assert.match(String(bad?.code || bad?.message), /ENOENT/);
});

test('cli: the process matcher also stops bridgerator.exe (bridge, engine child) and counts it as running', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'cli.mjs'), 'utf8');
  assert.match(src, /Name='wscript\.exe' OR Name='node\.exe' OR Name='bridgerator\.exe' OR Name='rg\.exe' OR Name='powershell\.exe'/);
  assert.match(src, /\$_\.Name -eq "node\.exe" -or \$_\.Name -eq "bridgerator\.exe"/);
});

test('build output stays out of git and npm: dist/ is ignored, package files whitelist has no dist or scripts', () => {
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^dist\/$/m);
  const files = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
  assert.ok(!files.some((f) => /^(dist|scripts)\b/.test(f)), files.join(','));
});
