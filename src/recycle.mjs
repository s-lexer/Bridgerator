// LOGIC: see critical-logic/bridge.md ("Recycle Bin"). A delete command the AI runs in the terminal
// goes to the Recycle Bin instead, when Bridgerator can read it for sure: ONE delete statement
// (Remove-Item / ri / rm / del / erase / rd / rmdir, optionally inside `cmd /c`) with plain paths or a
// wildcard in the last part. Anything else (pipes, ;, &&, variables, loops, scripts, other programs
// that delete) runs as written — a safety net, not a guarantee (said so in the window and on the site).
// The move itself: recycle.ps1 (IFileOperation; an item the shell would delete for good is left alone
// and reported 'nobin' → the bridge asks on the PC before a permanent delete).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POWERSHELL, psArgs } from './win.mjs';
import { runFilesPs, stripOurs } from './ask.mjs';

const VERBS = new Set(['remove-item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir']);
const MAX_TARGETS = 1000;
const RECURSE = new Set(['-recurse', '-r', '-rf', '-fr', '--recursive', '/s']);
const QUIET = new Set(['-force', '-f', '--force', '-v', '-verbose', '/q', '/f', '/a', '-confirm:$false']);

function tokenize(s) {
  const out = [];
  let cur = '', q = null, quoted = false;
  const push = () => { if (cur || quoted) out.push({ v: cur, quoted }); cur = ''; quoted = false; };
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; quoted = true; continue; }
    if (/\s/.test(ch)) { push(); continue; }
    if (ch === ',') { push(); out.push({ v: ',', sep: true }); continue; }
    cur += ch;
  }
  if (q) return null;                       // unbalanced quote
  push();
  return out;
}

const hasWild = (s) => /[*?]/.test(s);
const wildRe = (seg) => new RegExp(`^${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
const kindOf = (p) => { try { const s = fs.lstatSync(p); return s.isDirectory() ? 'dir' : 'file'; } catch { return null; } };
const isEmptyDir = (p) => { try { return fs.readdirSync(p).length === 0; } catch { return false; } };

/**
 * One delete command → { verb, targets: [absolute paths], recurse } when Bridgerator can do exactly
 * what it asks (each target exists, folders only with a recurse flag or empty), else null (the
 * command then runs as written).
 */
export function parseDelete(command, cwd = os.homedir(), home = os.homedir()) {
  let s = String(command ?? '').trim();
  if (!s || s.length > 4000) return null;
  const wrapped = /^cmd(?:\.exe)?\s+\/[ck]\s+(.+)$/i.exec(s);
  if (wrapped) { s = wrapped[1].trim(); if (/^"[^"]*"$/.test(s)) s = s.slice(1, -1); }
  s = s.replace(/\s-Confirm:\$false\b/gi, ' -confirm:$false');
  // Only plain text: no statements, pipes, redirects, variables, sub-expressions, escapes, line breaks.
  if (/[;&|<>`\r\n{}()@%]/.test(s) || /\$(?!false\b)/i.test(s)) return null;
  const tok = tokenize(s);
  if (!tok || !tok.length) return null;
  const verb = tok[0].v.toLowerCase().replace(/\.exe$/, '');
  if (tok[0].quoted || !VERBS.has(verb)) return null;
  const cmdStyle = ['del', 'erase', 'rd', 'rmdir'].includes(verb);
  let recurse = false, literal = false, force = false, allAttrs = false;
  const raw = [];
  for (let i = 1; i < tok.length; i++) {
    const t = tok[i];
    if (t.sep) continue;
    const low = t.v.toLowerCase();
    if (!t.quoted && /^(-|\/[a-z]|\/[a-z]:)/i.test(t.v) && !/^\/[a-z]:?[\\/]/i.test(t.v)) {
      if (RECURSE.has(low)) { recurse = true; continue; }
      if (low === '-force' || low === '/f') force = true;
      if (low === '/a') allAttrs = true;
      if (/^\/a:[a-z-]+$/.test(low)) { allAttrs = 'filter'; continue; }
      if (QUIET.has(low)) continue;
      if (low === '-path') continue;
      if (low === '-literalpath' || low === '-lp') { literal = true; continue; }
      if (low === '-erroraction' || low === '-ea') { i++; continue; }
      return null;                          // a flag we don't know: run as written
    }
    raw.push(t.v);
  }
  if (!raw.length || (cmdStyle && (verb === 'del' || verb === 'erase') && recurse)) return null; // del /s *.tmp: every subfolder
  const targets = [];
  // Wildcard matches the command itself would skip: hidden / system items (del without /a,
  // Remove-Item without -Force) and read-only files (without /f or -Force). Checked by recycle.ps1.
  const skip = cmdStyle ? `${allAttrs === true ? '' : 'hs'}${force ? '' : 'r'}` : force ? '' : 'hsr';
  const wild = [];
  for (let p of raw) {
    if (/^[\\/]{2}/.test(p) || /^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return null;
    if (!literal && /[[\]]/.test(p)) return null;
    if (p === '~' || /^~[\\/]/.test(p)) p = path.join(home, p.slice(1));
    const abs = path.resolve(cwd, p);
    if (!literal && hasWild(abs)) {
      const dir = path.dirname(abs), seg = path.basename(abs);
      // rd / rmdir take no wildcards; /a:<attributes> filters we don't copy: run as written.
      if (hasWild(dir) || verb === 'rd' || verb === 'rmdir' || allAttrs === 'filter') return null;
      let names;
      try { names = fs.readdirSync(dir); } catch { return null; }
      const re = wildRe(seg);
      const hits = names.filter((n) => re.test(n)).map((n) => path.join(dir, n));
      if (!hits.length) return null;
      for (const h of hits) {
        const k = kindOf(h);
        if (k === 'dir') { if (verb === 'del' || verb === 'erase') continue; if (!recurse && !isEmptyDir(h)) return null; }
        targets.push(h);
        wild.push(h);
      }
      continue;
    }
    const k = kindOf(abs);
    if (!k) return null;
    if (k === 'dir' && (verb === 'del' || verb === 'erase')) return null; // del <folder> deletes the files inside
    if (k === 'dir' && !recurse && !isEmptyDir(abs)) return null;
    if (k === 'file' && (verb === 'rd' || verb === 'rmdir')) return null;
    targets.push(abs);
  }
  const uniq = [...new Set(targets)];
  if (!uniq.length || uniq.length > MAX_TARGETS) return null;
  return { verb, targets: uniq, recurse, ...(wild.length && skip ? { skip: Object.fromEntries(wild.map((h) => [h, skip])) } : {}) };
}

const LIB = fileURLToPath(new URL('./ask-lib.ps1', import.meta.url));
const PS = fileURLToPath(new URL('./recycle.ps1', import.meta.url));

/**
 * Moves the paths to the Recycle Bin → [{ p, r: 'recycled' | 'nobin' | 'missing' | 'skipped' | 'error:…' }].
 * skip: { path: 'hsr' } — leave that item alone ('skipped') when it is hidden (h) / system (s) / read-only (r).
 */
export function recycle(paths, { timeoutMs = 120000, skip = {} } = {}) {
  if (process.platform !== 'win32') return Promise.resolve(paths.map((p) => ({ p, r: 'nobin' })));
  return new Promise((resolve) => {
    const fail = (why) => resolve(paths.map((p) => ({ p, r: `error:${why}` })));
    const chunks = [];
    let done = false;
    const child = spawn(POWERSHELL, psArgs(runFilesPs(LIB, PS)), { windowsHide: true, env: stripOurs(process.env), stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } if (!done) { done = true; fail('timeout'); } }, timeoutMs);
    child.stdout.on('data', (b) => { chunks.push(b); }); // decoded once at the end: a UTF-8 character may span chunks
    child.stderr.on('data', () => {});
    child.on('error', (e) => { clearTimeout(timer); if (!done) { done = true; fail(e.code || 'spawn'); } });
    child.on('close', () => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      try {
        const r = JSON.parse(Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).pop());
        const list = Array.isArray(r) ? r : [r];
        resolve(paths.map((p) => list.find((x) => x && x.p === p) || { p, r: 'error:no-answer' }));
      } catch { fail('bad-answer'); }
    });
    // PowerShell gone early (EPIPE): the error is reported through 'close' / the timeout, never thrown.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(paths.map((p) => ({ p, skip: typeof skip[p] === 'string' ? skip[p] : '' }))));
  });
}

// --- Undo of a delete: the restored item's copy leaves the Recycle Bin too ----------------------
// Each recycled item is a pair in <drive>\$Recycle.Bin\<SID>\: $I<id> (original path + deletion time)
// and $R<id> (the item itself). Only this user's folder is readable, so only their items match.
const FILETIME_EPOCH_MS = 11644473600000;
/** $I file → { path, t } (format 1: Vista–8, 2: Windows 10+), or null. */
export function readBinInfo(buf) {
  try {
    const v = Number(buf.readBigInt64LE(0));
    const t = Number(buf.readBigInt64LE(16) / 10000n) - FILETIME_EPOCH_MS;
    const p = v === 2 ? buf.toString('utf16le', 28, 28 + (buf.readUInt32LE(24) - 1) * 2) : v === 1 ? buf.toString('utf16le', 24, 24 + 520) : null;
    return p ? { path: p.replace(/\0.*$/s, ''), t } : null;
  } catch { return null; }
}
/**
 * Removes from the Recycle Bin exactly the copies this bridge made: items = [{ path, bin }], bin = the
 * $R path recycle.ps1 reported when it recycled `path`. Removed only when that pair is still there and
 * its $I names that same original path; an item without a recorded copy is left alone (never another
 * bin entry — it may be the person's own later deletion). → the paths whose bin copy was removed. Never throws.
 */
export function purgeFromBin(items) {
  const gone = [];
  for (const it of Array.isArray(items) ? items : []) {
    try {
      const r = typeof it?.bin === 'string' ? path.resolve(it.bin) : '', n = path.basename(r);
      if (!/^\$R/i.test(n) || path.basename(path.dirname(path.dirname(r))).toLowerCase() !== '$recycle.bin') continue;
      const i = path.join(path.dirname(r), `$I${n.slice(2)}`);
      const info = readBinInfo(fs.readFileSync(i));
      if (!info || path.resolve(info.path).toLowerCase() !== path.resolve(String(it.path)).toLowerCase()) continue;
      fs.rmSync(r, { recursive: true, force: true }); fs.rmSync(i, { force: true }); gone.push(it.path);
    } catch { /* gone already / in use: stays in the bin */ }
  }
  return gone;
}
