// Tests run on real PCs: no notification, question window or tray icon may appear. Every PowerShell
// started through child_process.execFile (notices, on-PC questions) is caught here instead and
// recorded in `shown`; the question "answer" is `answer(entry)` (default: Deny, like no answer).
// The engine is started with spawn and is not affected.
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const realExecFile = cp.execFile;
export const shown = [];
export const popups = { answer: () => 'deny' };
cp.execFile = function execFile(file, args, opts, cb) {
  if (typeof args === 'function') { cb = args; args = []; opts = {}; }
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  if (/powershell(\.exe)?$/i.test(String(file))) {
    const env = opts?.env || {};
    const entry = { file, args, env, toast: env.BR_TOAST || '', head: env.BR_HEAD || '', detail: env.BR_DETAIL || '' };
    shown.push(entry);
    setImmediate(() => cb?.(null, entry.toast ? '' : popups.answer(entry), ''));
    return { on() {}, kill() {}, pid: 0 };
  }
  return realExecFile.call(this, file, args, opts, cb);
};
syncBuiltinESMExports();
