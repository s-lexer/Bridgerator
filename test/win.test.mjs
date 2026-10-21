import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as win from '../src/win.mjs';

const WIN = process.platform === 'win32';
const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const TOOLS = ['POWERSHELL', 'SCHTASKS', 'CMD', 'WSCRIPT', 'WHOAMI', 'REG', 'TASKKILL'];
const run = (file, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { windowsHide: true, timeout: 60000, encoding: 'buffer', ...opts }, (e, out, err) => (e ? reject(Object.assign(e, { stderr: String(err) })) : resolve(out)));
});
// src/win.mjs loaded fresh with this SystemRoot (child processes always get one from Windows,
// so the "missing" case is checked in this process).
async function winWith(systemRoot) {
  const keys = Object.keys(process.env).filter((k) => k.toLowerCase() === 'systemroot'), saved = keys.map((k) => [k, process.env[k]]);
  for (const k of keys) delete process.env[k];
  if (systemRoot !== undefined) process.env.SystemRoot = systemRoot;
  try { return await import(`../src/win.mjs?root=${encodeURIComponent(String(systemRoot))}`); } finally {
    for (const k of Object.keys(process.env)) if (k.toLowerCase() === 'systemroot') delete process.env[k];
    for (const [k, v] of saved) process.env[k] = v;
  }
}

test('every Windows tool is an absolute path inside System32 of this Windows', () => {
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32').toLowerCase();
  const names = { POWERSHELL: 'powershell.exe', SCHTASKS: 'schtasks.exe', CMD: 'cmd.exe', WSCRIPT: 'wscript.exe', WHOAMI: 'whoami.exe', REG: 'reg.exe', TASKKILL: 'taskkill.exe' };
  for (const k of TOOLS) {
    const p = win[k];
    assert.ok(path.win32.isAbsolute(p), `${k} is absolute: ${p}`);
    assert.ok(p.toLowerCase().startsWith(sys + path.sep), `${k} inside System32: ${p}`);
    assert.equal(path.basename(p).toLowerCase(), names[k]);
  }
  assert.equal(win.POWERSHELL.toLowerCase(), path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase(), 'Windows PowerShell 5.1, not whatever "powershell" is on the PATH');
  if (WIN) for (const k of TOOLS) assert.ok(fs.existsSync(win[k]), `${k} exists on this PC`);
});

test('no SystemRoot in the environment → C:\\Windows; another SystemRoot is followed', async () => {
  const none = await winWith(undefined);
  assert.equal(none.CMD, path.join('C:\\Windows', 'System32', 'cmd.exe'));
  assert.equal(none.POWERSHELL, path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const other = await winWith('D:\\Win dows');
  assert.equal(other.REG, path.join('D:\\Win dows', 'System32', 'reg.exe'));
  assert.ok(process.env.SystemRoot || !WIN, 'environment restored');
});

test('psArgs: no profile, non-interactive, own execution policy, the script as base64 of UTF-16LE', () => {
  const script = "Write-Output 'Привет, \"мир\"' $env:X `n\r\n😀 & | ; ' ''";
  const a = win.psArgs(script);
  assert.deepEqual(a.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
  assert.equal(a.length, 6);
  assert.match(a[5], /^[A-Za-z0-9+/]+={0,2}$/, 'only base64 characters reach the command line');
  assert.equal(Buffer.from(a[5], 'base64').toString('utf16le'), script, 'round-trip keeps Cyrillic, quotes, $, newlines and emoji');
  assert.equal(win.psArgs('').at(-1), '');
});

test('a script run through psArgs prints Cyrillic, quotes, $ and emoji byte for byte (hidden window)', { skip: !WIN && 'Windows PowerShell' }, async () => {
  const text = 'Привет, Иван! "двойные" \'одинарные\' $env:PATH `n & | ; 😀 ✓\nвторая строка C:\\Users\\Иван\\Рабочий стол';
  const script = `[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false\n[Console]::Out.Write('${text.replace(/'/g, "''")}')`;
  const out = await run(win.POWERSHELL, win.psArgs(script));
  assert.deepEqual(out, Buffer.from(text, 'utf8'));
});

test('a powershell / cmd planted in the current folder or first on the PATH never runs instead of the real one', { skip: !WIN && 'Windows' }, async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-win-'));
  try {
    for (const n of ['powershell.bat', 'powershell.cmd', 'cmd.bat', 'whoami.bat', 'reg.bat', 'schtasks.bat']) fs.writeFileSync(path.join(d, n), '@echo PLANTED\r\n');
    const env = { ...process.env, PATH: `${d};${process.env.PATH}` };
    // The plant works for anything that looks a bare name up (cmd searches the current folder first)...
    assert.match(String(await run(win.CMD, ['/d', '/c', 'powershell'], { cwd: d, env })), /PLANTED/, 'the planted file is really found by a bare name');
    // ...but our absolute paths start the real tools.
    assert.equal(String(await run(win.POWERSHELL, win.psArgs("[Console]::Out.Write('REAL')"), { cwd: d, env })), 'REAL');
    assert.equal(String(await run(win.CMD, ['/d', '/c', 'echo REAL'], { cwd: d, env })).trim(), 'REAL');
    assert.match(String(await run(win.WHOAMI, ['/user', '/fo', 'csv', '/nh'], { cwd: d, env })), /S-1-\d/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('src starts Windows tools only through win.mjs (no bare names, no shell exec)', () => {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.mjs') && f !== 'win.mjs');
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(SRC, f), 'utf8');
    // A shell command line (exec / execSync) is never used.
    if (/(^|[^.\w])(exec|execSync)\s*\(/m.test(src)) bad.push(`${f}: exec/execSync`);
    for (const m of src.matchAll(/(?<![.\w])(execFile|execFileSync|spawn|spawnSync)\s*\(\s*([^,]+),/g)) {
      const first = m[2].trim();
      const ok = TOOLS.includes(first) || first === 'process.execPath'
        // the macOS / Linux branch of the browser opener (never on Windows)
        || (f === 'pair.mjs' && first === "process.platform === 'darwin' ? 'open' : 'xdg-open'")
        // winget: App Installer's per-user alias (not in System32), a fixed path from win.mjs
        || (f === 'software-tool.mjs' && first === 'WINGET' && /import \{ WINGET \} from '\.\/win\.mjs'/.test(src))
        // an agent CLI (delegate.mjs): ONE start point, a.cmd = an absolute path found by findAgent (an .exe or our node), no shell
        || (f === 'delegate.mjs' && first === 'a.cmd' && /export const startCli = \(a, args, opts\) => spawn\(a\.cmd,/.test(src));
      if (!ok) bad.push(`${f}: ${m[1]}(${first}, …)`);
    }
    const used = TOOLS.filter((k) => new RegExp(`\\b${k}\\b`).test(src));
    if (used.length) assert.match(src, /from '\.\/win\.mjs'/, `${f} takes ${used.join(', ')} from win.mjs`);
    for (const k of used) assert.doesNotMatch(src, new RegExp(`(const|let|var)\\s+${k}\\s*=`), `${f} does not define its own ${k}`);
  }
  assert.deepEqual(bad, []);
});
