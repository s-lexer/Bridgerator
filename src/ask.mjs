// The question on the PC: a native Windows notification in the bottom-right (our own app id
// "Bridgerator" under HKCU, scenario "reminder" = stays until answered) with buttons. A helper
// PowerShell waits for the click (ToastNotification.Activated) or the timeout (then the toast is
// removed and the answer is Deny). If our notifications are turned off or the toast fails: a small
// borderless window in the bottom-right above the taskbar, same buttons, never steals focus.
// No protocol handler is registered: a click on a stale toast in the Action Center does nothing.
// Texts reach PowerShell only as environment variables (XML-escaped there), never in the script.
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { POWERSHELL, psArgs } from './win.mjs';
import { localizeAsk, attrLine } from './pc-text.mjs';

const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
export const ASK_LIB = read('./ask-lib.ps1');
export const ASK_PS = ASK_LIB + '\n' + read('./ask.ps1');
const LIB_FILE = fileURLToPath(new URL('./ask-lib.ps1', import.meta.url));
const MAIN_FILE = fileURLToPath(new URL('./ask.ps1', import.meta.url));
// PowerShell also ends a single-quoted string at the typographic quotes U+2018/2019/201A/201B: each is doubled too.
export const q = (x) => `'${String(x).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`;
// The scripts are too long for -EncodedCommand: read from the package and run as one scriptblock
// (no double quotes, so it also passes as a plain -Command argument).
// The release build signs every .ps1 (Authenticode block at the end); PowerShell refuses code after a
// signature block, so each file's block is cut before joining (the joined text is never verified anyway).
export const runFilesPs = (...files) => `. ([scriptblock]::Create((${files.map((f) => `([IO.File]::ReadAllText(${q(f)}, [Text.Encoding]::UTF8) -replace '(?s)# SIG # Begin signature block.*$', '')`).join(' + [Environment]::NewLine + ')})))`;

/** process.env without BR_* / BRIDGERATOR_* (test hooks are never taken from the environment). */
export const stripOurs = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !/^(BR_|BRIDGERATOR_)/i.test(k)));

let seq = 0;
/**
 * Asks the person at the PC → the key of the button they chose; Deny ('deny') when they close it,
 * don't answer within `secs`, or anything fails. buttons: [key, label, kind ('deny' = red)].
 */
export const ICON = fileURLToPath(new URL('../assets/icon-64.png', import.meta.url));
export function askOnPc(q0) {
  if (process.platform !== 'win32') return Promise.resolve('deny');
  const { head, text, buttons, secs = 120, host = os.hostname(), auto = 'auto-deny', theme = 'system', silent = false, style = 'toast', lang = 'en' } = localizeAsk({ ...q0, auto: q0.auto || 'auto-deny' }, q0.lang);
  const attr = attrLine(host, auto, secs, lang);
  const env = {
    ...stripOurs(process.env), BR_HEAD: head, BR_DETAIL: text, BR_ATTR: attr, BR_HOSTNAME: host, BR_AUTOWORD: auto, BR_SECS: String(secs),
    BR_BUTTONS: buttons.map((b) => b.join('=')).join('|'), BR_TAG: `ask${process.pid}-${++seq}`, BR_THEME: theme, BR_ICON: ICON, BR_SILENT: silent ? '1' : '', BR_STYLE: style, BR_LANG: lang === 'ru' ? 'ru' : 'en',
  };
  return new Promise((resolve) => {
    execFile(POWERSHELL, psArgs(runFilesPs(LIB_FILE, MAIN_FILE)), { windowsHide: true, timeout: (secs + 30) * 1000, env }, (e, out) => {
      const r = String(out || '').trim();
      resolve(!e && buttons.some((b) => b[0] === r) ? r : 'deny');
    });
  });
}
