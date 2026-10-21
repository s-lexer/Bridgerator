// LOGIC: see critical-logic/bridge.md ("Extra tools"). Shared helpers of the extra tools:
// plain-words errors (stable code + what to do, never a stack), the folder guard (same rules as the
// engine's file tools: allowed list, excluded, read-only, UNC) and the PowerShell runner.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { POWERSHELL, TASKKILL, psArgs } from './win.mjs';
import { runFilesPs, stripOurs } from './ask.mjs';
import { norm, realish } from './policy.mjs';

export class ToolError extends Error {
  /** code: stable UPPER_CASE id; hint: what the person / AI can do about it. */
  constructor(code, message, hint = '') { super(message); this.code = code; this.hint = hint; }
}

// Node / Windows error codes → plain words (the AI shows them to the person).
const NODE_ERRORS = {
  ENOENT: ['File or folder not found.', 'Check the path (list the folder first).'],
  EACCES: ['Windows denied access to this file or folder.', 'The file may belong to another user or need administrator rights.'],
  EPERM: ['Windows did not allow this change.', 'The file may be read-only, open in another program, or protected.'],
  EBUSY: ['The file is open in another program.', 'Close it there and try again.'],
  EEXIST: ['A file with this name already exists.', 'Choose another name or allow overwriting.'],
  ENOSPC: ['The disk is full.', 'Free some space and try again.'],
  EISDIR: ['This is a folder, not a file.', ''],
  ENOTDIR: ['A part of the path is a file, not a folder.', ''],
  ETIMEDOUT: ['The operation took too long and was stopped.', 'Try a smaller task or try again later.'],
};
const clean = (s) => fromClixml(String(s ?? '')).replace(/\r?\n\s+at\s.*$/s, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, 400);

// PowerShell writes errors of a non-interactive run as CLIXML: keep only the error text.
export function fromClixml(s) {
  if (!s.startsWith('#< CLIXML')) return s;
  const parts = [...s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => m[1]);
  return parts.join('').replace(/_x000D__x000A_/g, '\n').replace(/_x([0-9A-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
/** Any error → one short paragraph for the AI: what happened, what to do, (code). No stack, no internals. */
export function errorText(e) {
  if (e instanceof ToolError) return `${e.message}${e.hint ? ` What to do: ${e.hint}` : ''} (code ${e.code})`;
  const m = NODE_ERRORS[e?.code];
  if (m) return `${m[0]}${m[1] ? ` What to do: ${m[1]}` : ''} (code ${e.code})`;
  const msg = clean(e?.message || e) || 'Something went wrong.';
  return `${msg} (code INTERNAL)`;
}

/** An engine call that threw (not a tool error result) → plain words; MCP error codes, no stack. */
export function engineErrorText(e) {
  const code = e?.code, msg = clean(e?.message || e).split('\n')[0].replace(/^MCP error -?\d+:\s*/, '');
  if (code === -32001 || /timed? ?out/i.test(msg)) return 'The PC did not finish this in time — it may still be running. Check the result, or do it in smaller steps. (code ENGINE_TIMEOUT)';
  if (code === -32000 || /connection closed/i.test(msg)) return 'Bridgerator\'s file and terminal service on the PC restarted. Try again in a few seconds. (code ENGINE_RESTARTED)';
  if (code === -32602) return `These arguments don't fit the tool: ${msg.slice(0, 200)} (code BAD_ARGS)`;
  return `The PC could not do this: ${msg.slice(0, 300) || 'unknown error'}. If it repeats, the person can run "bridgerator doctor" on the PC. (code ENGINE_ERROR)`;
}
export const text = (t) => ({ content: [{ type: 'text', text: t }] });
export const json = (o) => ({ content: [{ type: 'text', text: JSON.stringify(o, null, 2) }] });
export const fail = (code, message, hint) => { throw new ToolError(code, message, hint); };

export function needAction(args, actions) {
  if (!actions.includes(args.action)) fail('BAD_ACTION', `action must be one of: ${actions.join(', ')}.`);
  return args.action;
}
export function str(args, key, { required = false, max = 2000 } = {}) {
  const v = args[key];
  if (v === undefined || v === null || v === '') { if (required) fail('BAD_ARGS', `${key} is required.`); return undefined; }
  if (typeof v !== 'string') fail('BAD_ARGS', `${key} must be text.`);
  if (v.length > max) fail('BAD_ARGS', `${key} is longer than ${max} characters.`);
  return v;
}
export function int(args, key, { min, max, def }) {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (!Number.isInteger(v) || v < min || v > max) fail('BAD_ARGS', `${key} must be a whole number from ${min} to ${max}.`);
  return v;
}

const inside = (p, d) => p === d || p.startsWith(d + path.sep);
/**
 * The folder rules for a path an extra tool reads (write=false) or writes (write=true) — the same the
 * engine's file tools get: absolute local path only, inside the allowed list (when there is one),
 * not in an excluded folder, not in a read-only folder for writes. → the absolute path, or throws.
 */
export function guard(ctx, p, { write = false, tree = false } = {}) {
  if (typeof p !== 'string' || !p.trim()) fail('BAD_PATH', 'A file or folder path is required.');
  const s = p.trim();
  if (/^[\\/]{2}/.test(s)) fail('BAD_PATH', `Network and device paths ("${s}") are not allowed.`);
  if (!/^[a-z]:[\\/]/i.test(s) && !(process.platform !== 'win32' && s.startsWith('/'))) fail('BAD_PATH', `"${s}" is not a full path.`, 'Use a full path like C:\\Users\\Name\\Documents\\file.docx.');
  const abs = path.resolve(s);
  const refusal = ctx.policy?.check(write ? 'write_file' : 'read_file', { path: abs });
  if (refusal) fail('ACCESS_DENIED', refusal.replace(/^Access denied by Bridgerator: /, ''), 'Choose another folder, or ask the person to change Bridgerator → Safety.');
  const allowed = ctx.cfg?.allowedDirectories || [];
  if (allowed.length) {
    const n = norm(realish(abs));
    if (!allowed.some((d) => inside(n, norm(realish(d))))) fail('ACCESS_DENIED', `"${s}" is outside the folders allowed on this PC.`, 'Use a path inside an allowed folder (bridgerator_settings get shows them).');
  }
  // tree: the tool works on the whole folder (copies, walks, recycles below it) → it must not CONTAIN an
  // excluded folder (Bridgerator's own ones included), nor a read-only one for writes.
  if (tree && excludedInside(ctx, abs, { write }).length) fail('FOLDER_HAS_EXCLUDED', `"${s}" contains a folder that is excluded on this PC${write ? ' or read-only' : ''} (or belongs to Bridgerator), so it can't be used as a whole.`, 'Choose a subfolder that holds only the files of this task.');
  return abs;
}
/**
 * Excluded (and, for writes, read-only) folders strictly INSIDE folder `abs` → their paths relative to
 * it (lower case, "\"-joined on Windows), [] when none. Same normalisation as policy (realish + norm).
 */
export function excludedInside(ctx, abs, { write = false } = {}) {
  const nf = norm(realish(abs)), pre = nf.endsWith(path.sep) ? nf : nf + path.sep;
  const list = [...(ctx.policy?.denied || []), ...(write ? (ctx.cfg?.readOnlyDirectories || []).map((d) => norm(realish(d))) : [])];
  return [...new Set(list.filter((d) => d.startsWith(pre)).map((d) => d.slice(pre.length)))];
}
/** Paths of search results / listings that the person excluded → dropped (same as policy.filter). */
export function visiblePath(ctx, p) {
  try { guard(ctx, p); return true; } catch { return false; }
}

/** A new file never overwrites: "name.ext" → "name (2).ext" … when it exists. */
export function freeName(p) {
  if (!fs.existsSync(p)) return p;
  const { dir, name, ext } = path.parse(p);
  for (let i = 2; i < 1000; i++) { const c = path.join(dir, `${name} (${i})${ext}`); if (!fs.existsSync(c)) return c; }
  fail('EXISTS', `Too many files named like "${name}${ext}".`);
}

// PowerShell: UTF-8 out, errors as text, no profile. Script text inline (-EncodedCommand, small
// scripts) or read from package files (long scripts). Input data only through env (BRX_*) / stdin,
// never interpolated into the script.
const PRELUDE = "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$OutputEncoding=[Text.Encoding]::UTF8\n";
// A script may start programs of its own: a timeout or the bridge exiting ends the whole process tree
// (taskkill /T), not only powershell.exe.
const live = new Set();
export function killTree(child, { sync = false } = {}) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const a = ['/PID', String(child.pid), '/T', '/F'];
    try {
      if (sync) spawnSync(TASKKILL, a, { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      else { const k = spawn(TASKKILL, a, { windowsHide: true, stdio: 'ignore' }); k.on('error', () => { try { child.kill(); } catch { /* gone */ } }); return; }
    } catch { /* fall back to kill */ }
  }
  try { child.kill(); } catch { /* gone */ }
}
process.once('exit', () => { for (const c of live) killTree(c, { sync: true }); });
/**
 * → { code, stdout, stderr }. opts: { files: [abs .ps1 paths] } or { script }, env: {}, timeout ms, input.
 * Not Windows → ToolError NOT_WINDOWS.
 */
export function runPs({ script, files, env = {}, timeout = 60000, input } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new ToolError('NOT_WINDOWS', 'This works only on Windows.'));
  const cmd = files ? PRELUDE + runFilesPs(...files) : PRELUDE + script;
  return new Promise((resolve, reject) => {
    // PSModulePath of a PowerShell 7 parent would make 5.1 load the wrong modules: let 5.1 use its own.
    const base = stripOurs(process.env);
    for (const k of Object.keys(base)) if (k.toLowerCase() === 'psmodulepath') delete base[k];
    const child = spawn(POWERSHELL, psArgs(cmd), { windowsHide: true, env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let size = 0, done = false;
    live.add(child);
    const timer = setTimeout(() => { if (!done) { killTree(child); finish(new ToolError('TIMEOUT', 'Windows took too long to answer.', 'Try again, or ask for less at once.')); } }, timeout);
    const finish = (e, r) => { if (done) return; done = true; clearTimeout(timer); live.delete(child); e ? reject(e) : resolve(r); };
    child.stdout.on('data', (b) => { size += b.length; if (size < 64 * 1024 * 1024) out.push(b); });
    child.stderr.on('data', (b) => { if (err.length < 200) err.push(b); });
    child.on('error', (e) => finish(new ToolError('PS_START', `PowerShell did not start: ${e.code || e.message}.`, 'Check that Windows PowerShell is not blocked on this PC.')));
    child.on('close', (code) => finish(null, { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.on('error', () => { /* child exited early: close reports it */ });
    child.stdin.end(input ?? '');
  });
}
/** Runs a script that prints ONE JSON object as its last line → that object. ps = ctx.runPs (tests) or runPs. */
export async function psJson(ctx, opts) {
  const r = await (ctx?.runPs || runPs)(opts);
  const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (l.startsWith('{') || l.startsWith('[')) { try { return JSON.parse(l); } catch { /* not this line */ } }
  }
  const why = clean(r.stderr).split(/\r?\n/)[0] || `exit code ${r.code}`;
  throw new ToolError('PS_FAILED', `Windows could not do it: ${why}`, 'Try again; if it repeats, run "bridgerator doctor" on the PC.');
}
export const pkgFile = (rel) => new URL(rel, import.meta.url);
