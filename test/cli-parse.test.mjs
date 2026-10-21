// The CLI on any Windows: ru-RU output of the Windows tools it parses (OEM code page 866), Cyrillic
// profile paths in the autostart script, and which settings folder it uses. All values in the
// fixtures are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-clip-'));
process.env.BRIDGERATOR_HOME = path.join(tmp, 'home');
const cwd = process.cwd();
const { sidFrom, machineGuidFrom, hiddenVbs, setupConfig, excludedLine, osLanguage, accountUrlOf, offlineWatch, removeOurFiles, revokeKey } = await import('../src/cli.mjs'); // no command: prints usage only
process.chdir(cwd);
const { machineFp } = await import('../src/pair.mjs');

const FIX = fileURLToPath(new URL('./fixtures/ru-RU/', import.meta.url));
const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
// What execFileSync(...).toString() gives the CLI: the OEM bytes decoded as UTF-8.
const out = (f) => fs.readFileSync(path.join(FIX, f)).toString();

test('whoami on ru-RU Windows (code page 866, Cyrillic user name with a space, domain): the SID is read by structure', () => {
  const s = out('whoami-user-csv.cp866.txt');
  assert.ok(s.includes('\ufffd'), 'fixture really is OEM bytes, garbled as UTF-8 — like the real output');
  assert.equal(sidFrom(s), 'S-1-5-21-1111111111-2222222222-3333333333-1001');
  assert.equal(sidFrom(out('whoami-user-csv-domain.cp866.txt')), 'S-1-5-21-4444444444-5555555555-6666666666-1105');
  assert.equal(sidFrom(''), undefined);
});

test('whoami: a user NAME that looks like a SID ("S-1-23") is never taken for the SID', () => {
  assert.equal(sidFrom(out('whoami-user-csv-sid-like-name.txt')), 'S-1-5-21-7777777777-8888888888-9999999999-1002');
});

test('reg query MachineGuid (labels are not localized): GUID read; the ru-RU error text gives nothing', () => {
  const g = machineGuidFrom(out('reg-query-machineguid.txt'));
  assert.equal(g, '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0');
  assert.equal(machineGuidFrom(out('reg-query-missing.cp866.txt')), undefined);
  assert.match(machineFp(g, sidFrom(out('whoami-user-csv.cp866.txt'))), /^[0-9a-f]{64}$/);
  assert.equal(machineFp(undefined, 'S-1-5-21-1'), '', 'unknown GUID → no fingerprint');
});

// Regression 1.0.8 "Cyrillic profile autostart fix": WSH reads a BOM-less .vbs as ANSI, so
// C:\Users\Иван Петров broke the autostart. The CLI writes '\ufeff' + script as UTF-16LE.
test('autostart script for a Cyrillic profile path: UTF-16LE with BOM (FF FE), reads back intact', () => {
  const node = 'C:\\Users\\Иван Петров\\AppData\\Local\\Bridgerator\\node\\node.exe';
  const app = 'C:\\Users\\Иван Петров\\AppData\\Roaming\\npm\\node_modules\\bridgerator\\src\\cli.mjs';
  const f = path.join(tmp, 'run-hidden.vbs');
  fs.writeFileSync(f, '\ufeff' + hiddenVbs(node, app), 'utf16le'); // as installAutostart() does
  const b = fs.readFileSync(f);
  assert.deepEqual([b[0], b[1]], [0xff, 0xfe]);
  const back = b.subarray(2).toString('utf16le');
  assert.ok(back.includes(`node = "${node}"`) && back.includes(`app = "${app}"`));
  assert.ok(fs.readFileSync(CLI, 'utf8').includes("fs.writeFileSync(VBS, '\\ufeff' + hiddenVbs(process.execPath, SELF), 'utf16le')"), 'the CLI still writes it this way');
  assert.match(hiddenVbs('C:\\a"b\\node.exe', 'x'), /node = "C:\\a""b\\node\.exe"/, 'quotes doubled for VBScript');
  // A failed start (or an older suppressed error) is retried with the backoff, never a silent quit for good.
  const v = hiddenVbs('n', 'a').split('\r\n');
  const runAt = v.findIndex((l) => l.includes('sh.Run('));
  assert.equal(v[runAt - 1].trim(), 'Err.Clear'); assert.equal(v[runAt + 1].trim(), 'If Err.Number <> 0 Then rc = -1'); assert.equal(v[runAt + 2].trim(), 'Err.Clear');
  assert.ok(!v.some((l) => /Quit 4/.test(l)));
});

const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
const baseEnv = (over = {}) => {
  const e = { ...process.env, ...over };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return e;
};

// Test hooks are never taken from the environment (security review 20.10): BRIDGERATOR_HOME only
// under node --test or with an explicit --home.
test('BRIDGERATOR_HOME is ignored outside the test runner; --home is honoured', () => {
  const evil = path.join(tmp, 'evil');
  fs.mkdirSync(evil, { recursive: true });
  fs.writeFileSync(path.join(evil, 'config.json'), JSON.stringify({ relay: 'wss://x.invalid/link', token: 'tok-1234' }));
  const appdata = path.join(tmp, 'Roaming');
  const env = baseEnv({ NODE_TEST_CONTEXT: undefined, BRIDGERATOR_HOME: evil, APPDATA: appdata, LOCALAPPDATA: path.join(tmp, 'Local') });
  const r = run(['status'], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not set up on this PC/, 'the variable alone does not move the settings folder');
  assert.ok(fs.existsSync(path.join(appdata, 'Bridgerator')), 'used the normal folder under APPDATA');
  const h = run(['status', '--json', '--home', evil], env);
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /"token": "tok-…"/, '--home config read, key shown shortened only');
  assert.doesNotMatch(h.stdout, /tok-1234/);
});

// install-release.md: an expired pairing code = a plain message, exit 3 (a clean stop); a network
// failure is no clean stop (review b5): a plain one-line error, exit 1, so the installer rolls back.
test('setup: pairing that cannot reach the site ends with a plain one-line error and exit 1, before anything is changed', () => {
  const home = path.join(tmp, 'pairfail');
  const r = run(['setup', '--home', home, '--relay', 'wss://127.0.0.1:9/link'], baseEnv({ NODE_TEST_CONTEXT: undefined }));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /could not reach https:\/\/127\.0\.0\.1:9 .*check the internet connection/);
  assert.doesNotMatch(r.stdout + r.stderr, /\n\s+at |ERROR/);
  assert.equal(fs.existsSync(path.join(home, 'config.json')), false, 'no config written');
});

test('setup: a value-less --allow / --deny / --read-only stops with a usage line BEFORE pairing (no key is lost)', () => {
  for (const k of ['--allow', '--deny', '--read-only']) {
    const home = path.join(tmp, `bare${k}`);
    const r = run(['setup', '--home', home, '--relay', 'wss://127.0.0.1:9/link', k], baseEnv({ NODE_TEST_CONTEXT: undefined }));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, new RegExp(`${k} needs a value`));
    assert.doesNotMatch(r.stdout + r.stderr, /could not reach|TypeError/, 'stopped before any network call');
  }
});

test('setup: --language other than en / ru stops with a usage line before pairing (X3-13)', () => {
  for (const v of ['fr', 'english']) {
    const home = path.join(tmp, `lang-${v}`);
    const r = run(['setup', '--home', home, '--relay', 'wss://127.0.0.1:9/link', '--language', v], baseEnv({ NODE_TEST_CONTEXT: undefined }));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /--language must be en or ru/);
    assert.doesNotMatch(r.stdout + r.stderr, /could not reach|TypeError/, 'stopped before any network call');
  }
});

test('setup builds the config from the file as it is AFTER the old bridge stopped (a setting it saved meanwhile is kept, X2-17)', () => {
  const src = fs.readFileSync(CLI, 'utf8');
  const stop = src.indexOf('      stopRunning();\n'), reread = src.indexOf('prev = readConfig() || prev; cfg = build();'), write = src.indexOf('writeConfig(setupConfig(prev, cfg));');
  assert.ok(stop > 0 && reread > stop && write > reread, `${stop} < ${reread} < ${write}`);
});

test('uninstall: a key the server no longer knows (401) is not an error; other answers (404 too, YB-5) are (X2-12, X3-14)', async () => {
  const cfg = { relay: 'wss://relay.example/link', token: 'k' };
  const seen = [];
  const answer = (status) => async (url, o) => { seen.push([url, JSON.parse(o.body).token]); return { ok: status < 300, status }; };
  for (const st of [200, 401]) await revokeKey(cfg, { fetchFn: answer(st) });
  await assert.rejects(revokeKey(cfg, { fetchFn: answer(404) }), /HTTP 404/);
  await assert.rejects(revokeKey(cfg, { fetchFn: answer(500) }), /HTTP 500/);
  await assert.rejects(revokeKey(cfg, { fetchFn: answer(429) }), /HTTP 429/);
  assert.deepEqual(seen[0], ['https://relay.example/device/revoke', 'k']);
});

test('setup summary lists only the exclusions that really apply (VM10-4)', () => {
  assert.equal(excludedLine({ deniedDirectories: ['D:\\x'], protectSensitive: false }), "D:\\x, built-in: Bridgerator's own folders");
  assert.match(excludedLine({ deniedDirectories: [], protectSensitive: true }), /^built-in: Bridgerator's own folders, AppData, credentials .*Startup, PowerShell profiles$/);
});

test('first config language from Windows (display language or format); account URL from the config\'s site (VM11-6, VM11-7)', () => {
  assert.equal(osLanguage(['ru-RU']), 'ru'); assert.equal(osLanguage(['en-US', 'ru_RU.UTF-8']), 'ru');
  assert.equal(osLanguage(['en-US', undefined]), 'en'); assert.equal(osLanguage(['rue']), 'en');
  assert.equal(accountUrlOf({ relay: 'wss://mcp.staging.bridgerator.recondeck.com/link' }), 'https://staging.bridgerator.recondeck.com/app');
  assert.equal(accountUrlOf(null), 'https://bridgerator.recondeck.com/app');
  assert.equal(accountUrlOf({ relay: 'not a url' }), 'https://bridgerator.recondeck.com/app');
});

test('offline notice: armed once per outage — repeated failed reconnects do not restart the minute (review b5)', async () => {
  let shown = 0;
  const on = offlineWatch(() => { shown++; return true; }, 60);
  on('offline');
  for (let i = 0; i < 5; i++) { await new Promise((r) => setTimeout(r, 20)); on('offline'); }   // reconnect attempts every 20 ms
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(shown, 1, 'fired within the outage');
  on('offline'); await new Promise((r) => setTimeout(r, 100));
  assert.equal(shown, 1, 'once per outage');
  on('online'); on('offline'); await new Promise((r) => setTimeout(r, 100));
  assert.equal(shown, 2, 'a new outage after being online');
  on('online');
});

test('uninstall: removeOurFiles on a settings folder that is already gone does not throw (review b5)', () => {
  assert.doesNotThrow(() => removeOurFiles(path.join(tmp, 'never-created')));
});

test('confirm off <category> turns off only that category; the window stays on (review b5)', () => {
  const home = path.join(tmp, 'confirm-cat');
  const env = baseEnv({ NODE_TEST_CONTEXT: undefined });
  assert.equal(run(['confirm', 'on', '--home', home], env).status, 0);
  const r = run(['confirm', 'off', 'delete', '--home', home], env);
  assert.equal(r.status, 0, r.stderr);
  const ini = fs.readFileSync(path.join(home, 'confirm.ini'), 'utf8');
  assert.match(ini, /^enabled\s*=\s*true/m, 'the window is still on');
  assert.match(ini, /^delete\s*=\s*false/m);
  assert.match(ini, /^dangerous_commands\s*=\s*true/m, 'other categories untouched');
});

test('setup / update keeps every setting the person made (theme, language, notifications, tool settings); its own keys win', () => {
  const prev = { token: 'old', theme: 'light', language: 'ru', notify: { sound: false }, screen: { enabled: false }, askSettings: true, confirm: { x: 1 }, confirmTools: [] };
  const c = setupConfig(prev, { token: 'new', relay: 'wss://r/link', bridgeVersion: '1.1.0' });
  assert.deepEqual(c, { token: 'new', theme: 'light', language: 'ru', notify: { sound: false }, screen: { enabled: false }, askSettings: true, relay: 'wss://r/link', bridgeVersion: '1.1.0' });
});
