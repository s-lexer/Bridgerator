// Ways around the folder checks: variables, quoting, slashes, case, 8.3 names, links, device paths,
// relative paths, the word "bridgerator". LOGIC: critical-logic/bridge.md §2 / §2a.
// The terminal is not a boundary (policy.mjs header, bridge.md: the command checks are a courtesy /
// safety net): what is documented as not caught is pinned as "known limit".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-bypass-'));
// %TEMP% is inside AppData (always excluded): the built-in list points at a fake Cyrillic profile.
const fakeHome = path.join(root, 'Иван Петров');
const APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
Object.assign(process.env, { USERPROFILE: fakeHome, APPDATA, LOCALAPPDATA: path.join(fakeHome, 'AppData', 'Local') });
const { createPolicy, expandVars } = await import('../src/policy.mjs');
const secret = path.join(root, 'Секретное');
const work = path.join(root, 'Работа');
for (const d of [path.join(secret, 'deep'), work, path.join(fakeHome, '.ssh')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(secret, 'deep', 'пароль.txt'), 'x');
// cwd = the engine's working directory (bridge: engineDir, the first allowed folder).
const p = createPolicy({ deniedDirectories: [secret], cwd: work });
const denied = (r) => assert.match(String(r), /excluded|network and device|Bridgerator itself|not allowed/);
const cmd = (c) => p.check('start_process', { command: c });

test('excluded folder in paths: trailing \\ or \\., .. through it, case, mixed slashes, Cyrillic', () => {
  for (const x of [secret + '\\', secret + '\\.', `${secret}\\..\\Секретное\\deep`, secret.toUpperCase(), secret.toLowerCase(), path.join(work, '..', 'Секретное', 'deep', 'пароль.txt'),
    secret.replace(/\\/g, '/'), secret.replace(/\\/g, '\\\\'), `${secret}/deep\\пароль.txt`]) denied(p.check('read_file', { path: x }));
  denied(p.check('get_file_info', { path: path.join(fakeHome, '.ssh', 'id_rsa') }));
  assert.equal(p.check('read_file', { path: path.join(work, 'a.txt') }), null);
  assert.equal(p.check('read_file', { path: path.join(root, 'Секретное-2', 'a') }), null, 'a sibling with a common prefix');
});

test('relative paths and ~ are resolved before the check', () => {
  const back = path.relative(work, path.join(secret, 'deep'));
  denied(p.check('read_file', { path: back }));
  for (const x of ['~\\.ssh\\id_rsa', '~/.ssh/id_rsa', '~/.SSH', '~\\AppData\\Roaming\\Bridgerator\\confirm.ini']) denied(p.check('read_file', { path: x }));
});

test('device / network paths in every spelling are refused', () => {
  for (const x of ['\\\\?\\' + secret, '\\\\?\\C:\\x', '\\\\.\\C:\\x', '\\\\.\\PhysicalDrive0', '//?/C:/x', '//server/share', '\\/server/share', ' \\\\server\\share', '\\\\127.0.0.1\\c$', '\\\\?\\UNC\\srv\\s'])
    assert.match(p.check('read_file', { path: x }), /network and device/, x);
});

test('commands: %VAR% (any case), $env:, ${env:}, ~ are expanded before the check', () => {
  for (const c of ['type %userprofile%\\.ssh\\id_rsa', 'type %UserProfile%\\.ssh\\id_rsa', 'type "%USERPROFILE%\\.ssh\\id_rsa"', 'gc $ENV:UserProfile/.ssh/id_rsa', 'gc ${Env:USERPROFILE}\\.ssh\\id_rsa',
    'gc ~\\.ssh\\id_rsa', 'gc "~/.ssh/id_rsa"', 'notepad %appdata%\\Bridgerator\\confirm.ini', `gc '${secret.replace(/\\/g, '/')}/deep/пароль.txt'`, `gc ${JSON.stringify(secret).slice(1, -1)}\\\\deep`,
    `dir ${secret.toUpperCase()}`, `cmd /c "type ${secret}\\deep\\пароль.txt"`]) denied(cmd(c));
  assert.equal(expandVars('%NOPE%\\x', {}), '%NOPE%\\x', 'unknown variable stays as written');
  assert.equal(cmd('Get-ChildItem %NOPE%\\x'), null);
  denied(p.check('interact_with_process', { pid: 1, input: 'type %APPDATA%\\Bridgerator\\confirm.ini' }));
});

test('commands about Bridgerator itself, in any case, are for the person at the PC', () => {
  for (const c of ['echo BridgeRator', 'Get-Process *BRIDGERATOR*', 'schtasks /Run /TN Bridgerator-S-1-5-21', 'npm.cmd rm -g bridgerator', 'Remove-Item "$env:LOCALAPPDATA\\Bridgerator\\node" -Recurse'])
    assert.match(cmd(c), /person at this PC|excluded/, c);
  assert.equal(cmd('Get-ChildItem C:\\bridgeratorX'), null, 'a different word is not refused');
});

test('8.3 short names: a path through the short name of an excluded folder is refused', (t) => {
  const long = path.join(root, 'Secret Long Folder Name');
  fs.mkdirSync(long);
  const short = execFileSync(process.env.ComSpec, ['/d', '/s', '/c', `"for %I in ("${long}") do @echo %~sI"`], { windowsVerbatimArguments: true }).toString().trim();
  if (!/~\d/.test(short)) return t.skip(`8.3 names are off on this volume (${short}) — NOT CHECKED`);
  const q = createPolicy({ deniedDirectories: [long] });
  denied(q.check('read_file', { path: path.join(short, 'a.txt') }));
  denied(createPolicy({ deniedDirectories: [short] }).check('read_file', { path: path.join(long, 'a.txt') }), 'deny entry given as a short name');
  // A command naming the 8.3 alias is matched too (short names of existing folders are expanded).
  denied(q.check('start_process', { command: `type ${short}\\a.txt` }));
  denied(q.check('start_process', { command: `Get-Content "${short}\\a.txt"` }));
  denied(q.check('start_process', { command: `dir ${short}` }));
});

test('junctions and symlinks into the excluded folder, and into AppData, are refused', () => {
  const j = path.join(work, 'ярлык');
  fs.symlinkSync(secret, j, 'junction');
  denied(p.check('read_file', { path: path.join(j, 'deep', 'пароль.txt') }));
  denied(p.check('write_file', { path: path.join(j, 'new.txt') }), 'not existing yet: resolved via the parent');
  fs.mkdirSync(path.join(APPDATA, 'Bridgerator'), { recursive: true });
  const j2 = path.join(work, 'cfg');
  fs.symlinkSync(path.join(APPDATA, 'Bridgerator'), j2, 'junction');
  denied(createPolicy({}).check('edit_block', { file_path: path.join(j2, 'confirm.ini') }));
});

test('path arguments at any depth and under any path-like key; too deep / too large refused', () => {
  for (const a of [{ options: { outputPath: secret } }, { list: [[{ dest: secret }]] }, { files: ['a', secret] }, { Folder: secret }, { DIRECTORY: secret }])
    denied(p.check('some_tool', a));
  let deep = { path: work }; for (let i = 0; i < 9; i++) deep = { a: deep };
  assert.match(p.check('some_tool', deep), /too deeply nested/);
  assert.match(p.check('some_tool', { paths: Array.from({ length: 5001 }, () => 'x') }), /too large/);
  assert.equal(p.check('some_tool', { text: secret }), null, 'non-path keys are not paths (the engine never opens them)');
});

test('quotes and escape characters inside a path do not hide an excluded folder (cmd ^, PowerShell `)', () => {
  for (const c of ['type "%USERPROFILE%"\\.ssh\\id_rsa', "type '%USERPROFILE%'\\.ssh\\id_rsa", 'type %USERPROFILE%\\.^s^s^h\\id_rsa', 'Get-Content $env:USERPROFILE\\.`ssh\\id_rsa',
    `type "${secret}"\\deep\\пароль.txt`, `type ${secret.slice(0, 6)}"${secret.slice(6)}"\\deep`, 'echo bridge^rator', 'Get-Process *bridge`rator*']) denied(cmd(c));
  assert.equal(cmd('echo "hello" ^& dir'), null, 'ordinary quoting still runs');
});

test('the command check is a safety net, not a boundary: names built at run time are not matched', () => {
  assert.equal(cmd('$a = "bridge" + "rator"; Get-Process "*$a*"'), null);
  // Look-alike letters are a different folder for Windows too: not the excluded one.
  assert.equal(p.check('read_file', { path: secret.replace('С', 'C') }), null);
});

test('B1-1: relative paths are checked against the ENGINE folder (cwd), where the engine opens them — not the bridge folder', () => {
  const cfgFile = path.join(APPDATA, 'Bridgerator', 'config.json');
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true }); fs.writeFileSync(cfgFile, '{}');
  const rel = path.relative(work, cfgFile);             // ..\\Иван Петров\\AppData\\Roaming\\Bridgerator\\config.json
  assert.match(rel, /^\.\.[\\/]/);
  for (const t of ['read_file', 'write_file', 'edit_block', 'get_file_info']) denied(p.check(t, { path: rel, file_path: rel }));
  denied(p.check('move_file', { source: path.join(work, 'a.txt'), destination: rel }));
  // The same relative text from another folder lands elsewhere: allowed there (proves the base is used).
  const elsewhere = createPolicy({ deniedDirectories: [secret], cwd: path.join(root, 'x', 'y', 'z') });
  assert.equal(elsewhere.check('read_file', { path: rel }), null);
  // In a terminal command too.
  denied(cmd(`type ${rel}`));
  denied(cmd(`Get-Content "${rel}"`));
});

test('B1-12: a folder that CONTAINS an excluded / read-only folder can not be moved or removed', () => {
  const ro = path.join(work, 'Архив');
  fs.mkdirSync(ro, { recursive: true });
  const q = createPolicy({ deniedDirectories: [secret], readOnlyDirectories: [ro], cwd: work });
  assert.match(q.writable(root), /contains an excluded folder/);
  assert.match(q.writable(work), /contains a read-only folder/);
  assert.match(q.check('move_file', { source: root, destination: path.join(os.tmpdir(), 'elsewhere') }), /contains an excluded folder/);
  assert.equal(q.writable(path.join(work, 'a.txt')), null);
  assert.equal(q.check('read_file', { path: root }), null, 'reading / listing the parent stays allowed');
});

test('VM11-4: a terminal command through a junction / link into an excluded folder is refused (paths resolved like the file tools)', (t) => {
  const link = path.join(work, 'link-to-secret');
  try { fs.symlinkSync(secret, link, 'junction'); } catch (e) { return t.skip(`no junction (${e.code}) — NOT CHECKED`); }
  denied(cmd(`type "${link}\\deep\\пароль.txt"`));
  denied(cmd(`Get-Content ${link}\\deep\\пароль.txt`));
  denied(cmd('type link-to-secret\\deep\\пароль.txt'), 'relative, from the terminal folder');
  denied(cmd(`gc -Path=${link}\\deep\\пароль.txt`));
  assert.equal(cmd(`type "${path.join(work, 'a.txt')}"`), null);
  assert.equal(cmd('echo hello & dir /b'), null);
});

test('VM10-7: commands that change files are refused in a read-only folder (also through a junction); reading stays allowed', (t) => {
  const ro = path.join(work, 'Только чтение');
  fs.mkdirSync(ro, { recursive: true });
  const q = createPolicy({ readOnlyDirectories: [ro], cwd: work });
  const c = (x) => q.check('start_process', { command: x });
  for (const x of [`echo x > "${ro}\\a.txt"`, `Set-Content -Path "${ro}\\a.txt" -Value 1`, `del "${ro}\\a.txt"`, `copy C:\\x.txt "${ro}\\"`, `Move-Item "${ro}\\a.txt" C:\\x.txt`, 'mkdir "Только чтение\\new"'])
    assert.match(String(c(x)), /read-only/, x);
  for (const x of [`type "${ro}\\a.txt"`, `copy "${ro}\\a.txt" "${path.join(work, 'b.txt')}"`, `Get-ChildItem "${ro}"`]) assert.equal(c(x), null, x);
  const link = path.join(work, 'ro-link');
  try { fs.symlinkSync(ro, link, 'junction'); } catch (e) { return t.skip(`no junction (${e.code}) — NOT CHECKED`); }
  assert.match(String(c(`echo x > "${link}\\a.txt"`)), /read-only/);
});

test('B1-11: the command checks stay linear on a huge command (no regex backtracking)', () => {
  const big = `type C:\\${'a'.repeat(200000)}`;
  const t0 = performance.now();
  for (let i = 0; i < 4; i++) cmd(big);
  assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
});

test('X1-1: only what a command WRITES counts for a read-only folder (2>&1, >nul, read sources, other segments are reads)', () => {
  const ro = path.join(work, 'Архив только чтение');
  fs.mkdirSync(ro, { recursive: true });
  const q = createPolicy({ readOnlyDirectories: [ro], cwd: work });
  const c = (x) => q.check('start_process', { command: x });
  const out = path.join(work, 'итог.txt');
  for (const x of [`type "${ro}\\a.txt" 2>&1`, `dir "${ro}" >nul`, `Get-ChildItem "${ro}" *> $null`, `Get-Content "${ro}\\a.txt" | Out-File "${out}"`,
    `findstr x "${ro}\\a.txt" > "${out}"`, `Copy-Item -Path "${ro}\\a.txt" -Destination "${out}"`, `robocopy "${ro}" "${path.join(work, 'копия')}" /E`, `type "${ro}\\a.txt" & del "${out}"`])
    assert.equal(c(x), null, x);
  for (const x of [`type x 2> "${ro}\\err.txt"`, `Get-Content a | Out-File -FilePath "${ro}\\b.txt"`, `Copy-Item -Destination "${ro}" -Path "${out}"`, `dir & del "${ro}\\a.txt"`, `Rename-Item "${ro}\\a.txt" b.txt`])
    assert.match(String(c(x)), /read-only/, x);
});

test('X1-4: UNC / device paths in a command are refused at once, never looked up', () => {
  const q = createPolicy({ cwd: work });
  const c = (x) => q.check('start_process', { command: x });
  const t0 = performance.now();
  for (const x of ['type \\\\10.255.255.1\\share\\a.txt', 'dir "\\\\nosuchserver-x1\\c$\\Users"', 'copy a.txt \\\\.\\pipe\\x', 'type \\\\?\\UNC\\srv\\sh\\a.txt'])
    assert.match(String(c(x)), /network and device paths/, x);
  assert.ok(performance.now() - t0 < 500, `${Math.round(performance.now() - t0)} ms`);
  assert.equal(c("'a\\\\b' -split '\\\\'"), null, 'a regex with \\\\ is not a network path');
});
