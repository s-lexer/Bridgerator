// Absolute paths to the Windows tools we start: a planted powershell.exe / cmd.exe in the current
// folder or early on the PATH must never run instead.
import path from 'node:path';
import os from 'node:os';

const SYS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
export const POWERSHELL = path.join(SYS, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const SCHTASKS = path.join(SYS, 'schtasks.exe');
export const CMD = path.join(SYS, 'cmd.exe');
// winget = App Installer's alias for this user (never looked up on the PATH).
export const WINGET = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WindowsApps', 'winget.exe');
export const WSCRIPT = path.join(SYS, 'wscript.exe');
export const WHOAMI = path.join(SYS, 'whoami.exe');
export const REG = path.join(SYS, 'reg.exe');
export const TASKKILL = path.join(SYS, 'taskkill.exe');
// -EncodedCommand: the script text never goes through command-line quoting.
export const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
