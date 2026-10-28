// On-PC confirmation (OFF by default): when turned on, risky calls — deletions and system-changing
// commands; optionally every file write, move or command — wait for a window on the PC:
// Allow / Allow for 10 minutes / Allow always / Deny (Esc, closing it or no answer = Deny).
// Settings: confirm.ini in the Bridgerator folder (always excluded from the file tools), re-read on
// every call so edits apply at once. Only the person turns it off; the assistant can only ask
// (request_confirm_off → a window on the PC). Turning it back on needs no window.
// ponytail: a regex list per category, not a shell parser — an obfuscated command slips through; the
// window is a safety net (like blockedCommands), not a boundary. Said so on the site.
import fs from 'node:fs';
import os from 'node:os';
import { askOnPc } from './ask.mjs';
import { withDecoded } from './policy.mjs';

export const ALLOW_FOR_MS = 10 * 60 * 1000;
export const CATEGORIES = ['delete', 'dangerous_commands', 'write_files', 'move', 'any_command', 'install', 'scheduled_scripts'];
const DEFAULT_ASK = { delete: true, dangerous_commands: true, write_files: false, move: false, any_command: false, install: false, scheduled_scripts: false };

export const INI_TEMPLATE = `; Bridgerator: confirmation window on this PC before risky actions by ChatGPT.
; Changes apply right away (no restart). The assistant cannot read or edit this file.
; It is a safety net: commands are matched by patterns, a disguised command can slip through.

[confirm]
; true = ask on this PC; false = never ask (default). Also: bridgerator.cmd confirm on|off
enabled = false
; no answer within this time = Deny
timeout_seconds = 120

[ask]
; deleting files or folders (del, rd, Remove-Item, rm, ...)
delete = true
; commands that change the system (format, diskpart, bcdedit, reg add/delete, shutdown, icacls, net user, ...)
dangerous_commands = true
; every file write or edit (write_file, edit_block)
write_files = false
; every move or rename (move_file)
move = false
; every terminal command
any_command = false
; installing or updating programs (software tool, winget / msiexec / choco in the terminal)
install = false
; ChatGPT puts a script on a schedule in Windows Task Scheduler or changes one (automations)
scheduled_scripts = false

[patterns]
; extra regular expressions (case-insensitive) that always ask, matched against commands and paths:
; pattern1 = \\bgit\\s+push\\b
`;

// Case-insensitive patterns per category, matched against the command text.
const RX = {
  delete: [
    /(^|[\s;&|('"`])(del|erase|rd|rmdir|ri|rm|rimraf|shred)(\.exe)?\s/i,
    /\bRemove-Item\b/i, /\bClear-RecycleBin\b/i, /\bClear-Content\b/i,
    /\[(System\.)?IO\.(File|Directory)\]::Delete/i, /\.Delete\(\s*\)/i, /\bunlink(Sync)?\s*\(/i, /\brmSync\s*\(/i,
    /\bMove-Item\b.*\$null/i, /\bmove\b.*\bnul\b/i,
  ],
  dangerous_commands: [
    /\bformat(\.com)?\s+[a-z]:/i, /\bdiskpart\b/i, /\bbcdedit\b/i, /\bbcdboot\b/i, /\bmanage-bde\b/i,
    /\breg(\.exe)?\s+(add|delete|import|restore|load|unload|copy)\b/i,
    /\b(Set|New|Remove)-ItemProperty\b.*\bHK(LM|CR|U)\b/i, /\bHKLM:/i,
    /\bshutdown(\.exe)?\b/i, /\b(Stop|Restart)-Computer\b/i, /\blogoff\b/i,
    /\bcipher(\.exe)?\s+\/w/i, /\btakeown\b/i, /\bicacls\b/i, /\bSet-Acl\b/i,
    /\bnet(\.exe)?\s+(user|localgroup|share|stop)\b/i, /\b(New|Remove|Set)-Local(User|Group)/i,
    /\bsc(\.exe)?\s+(delete|config|stop|create)\b/i, /\b(Stop|Set|Remove|New)-Service\b/i,
    /\bschtasks(\.exe)?\s+\/(delete|create|change)\b/i, /\b(Unregister|Register|Disable)-ScheduledTask\b/i,
    /\bSet-ExecutionPolicy\b/i, /\bvssadmin\b.*\b(delete|resize)\b/i, /\bwmic\b.*\bshadowcopy\b/i, /\bwbadmin\b.*\bdelete\b/i,
    /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition|Set-Partition|Resize-Partition)\b/i,
    /\bwevtutil(\.exe)?\s+cl\b/i, /\bClear-EventLog\b/i, /\bDisable-ComputerRestore\b/i,
    /\bnetsh\b.*\b(firewall|advfirewall)\b.*\b(set|add|delete)\b/i, /\bSet-MpPreference\b/i, /\bAdd-MpPreference\b/i,
    /\b(taskkill|Stop-Process|kill)\b.*\b(lsass|csrss|winlogon|wininit|services|smss|svchost|explorer|dwm)\b/i,
  ],
  install: [
    /\bwinget(\.exe)?\s+(install|upgrade|update|uninstall|remove|import)\b/i, /\bmsiexec(\.exe)?\b/i,
    /\b(choco|scoop)(\.exe)?\s+(install|upgrade|update|uninstall)\b/i, /\b(Install|Update|Uninstall)-(Package|Module|Script|WinGetPackage)\b/i, /\bAdd-AppxPackage\b/i,
  ],
};
const commandOf = (name, args) => (name === 'start_process' ? args?.command : name === 'interact_with_process' ? args?.input : null);

/** → { cat, fragment } — the category that makes this call ask (or cat null) and the matched text. */
export function findMatch(name, args = {}, ask = DEFAULT_ASK, patterns = []) {
  const cmd = commandOf(name, args);
  const text = typeof cmd === 'string' ? withDecoded(cmd) : null;
  const hay = [text, args?.path, args?.file_path, args?.source, args?.destination].filter((x) => typeof x === 'string');
  const hit = (list, strs) => { for (const re of list) for (const h of strs) { const m = re.exec(h); if (m) return m[0].trim() || h; } return null; };
  let f;
  if ((f = hit(patterns, hay))) return { cat: 'pattern', fragment: f };
  if (text && ask.delete && (f = hit(RX.delete, [text]))) return { cat: 'delete', fragment: f };
  if (text && ask.dangerous_commands && (f = hit(RX.dangerous_commands, [text]))) return { cat: 'dangerous_commands', fragment: f };
  if (ask.write_files && (name === 'write_file' || name === 'edit_block')) return { cat: 'write_files', fragment: '' };
  if (ask.move && name === 'move_file') return { cat: 'move', fragment: '' };
  if (ask.install && name === 'software' && ['install', 'upgrade'].includes(args?.action)) return { cat: 'install', fragment: '' };
  if (text && ask.install && (f = hit(RX.install, [text]))) return { cat: 'install', fragment: f };
  if (ask.any_command && text !== null) return { cat: 'any_command', fragment: '' };
  return { cat: null, fragment: '' };
}
export const categorize = (...a) => findMatch(...a).cat;

// --- confirm.ini ---------------------------------------------------------------------------
export function parseIni(text) {
  const out = {};
  let sec = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { sec = m[1].trim().toLowerCase(); out[sec] ||= {}; continue; }
    const i = line.indexOf('=');
    if (i > 0) (out[sec] ||= {})[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

export function readSettings(file) {
  let ini = {};
  try { ini = parseIni(fs.readFileSync(file, 'utf8')); } catch { /* missing = defaults */ }
  const c = ini.confirm || {}, a = ini.ask || {};
  const patterns = [];
  for (const v of Object.values(ini.patterns || {})) { try { patterns.push(new RegExp(v, 'i')); } catch { /* bad regex: ignored */ } }
  const secs = Number.parseInt(c.timeout_seconds, 10);
  return {
    enabled: bool(c.enabled, false),
    timeoutSec: Number.isFinite(secs) && secs >= 10 && secs <= 3600 ? secs : 120,
    ask: Object.fromEntries(CATEGORIES.map((k) => [k, bool(a[k], DEFAULT_ASK[k])])),
    patterns,
  };
}

/** Like readSettings, but null when the file is missing, unreadable or has no valid [confirm] enabled. */
export function readSettingsStrict(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const ini = parseIni(text);
  if (!ini.confirm || !/^(1|0|true|false|yes|no|on|off)$/i.test(ini.confirm.enabled || '')) return null;
  return readSettings(file);
}
// Atomic: temp file + rename (a crash or a parallel reader never sees half a file).
// Windows: an antivirus / indexer / backup tool may hold the target for a moment → rename fails with
// EPERM / EBUSY / EACCES. Retried for up to ~1 s (like graceful-fs); still locked → the error, temp removed.
// wait: false → one try, no blocking wait (a background retry after an earlier failure).
export function writeAtomic(file, text, { wait = true } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= (wait ? 40 : 0) || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
const TEMPLATE_CRLF = INI_TEMPLATE.replace(/\n/g, '\r\n');
/** confirm.ini missing → created (from the last applied state when there is one, never "off" over it). */
export function ensureIni(file) { restoreIni(file); }

// The last applied state, kept next to confirm.ini (confirm.ini → confirm.approved, JSON): a deleted
// confirm.ini is recreated from it (at start, at setup and while running), so deleting the file never
// turns confirmations off. No copy yet (never applied) → the product defaults (confirmations off).
export const approvedFile = (ini) => (ini ? `${ini.replace(/\.ini$/i, '')}.approved` : '');
const approvedJson = (s) => JSON.stringify({ enabled: s.enabled, timeoutSec: s.timeoutSec, ask: s.ask, patterns: s.patterns.map((r) => r.source) });
export function readApproved(ini) {
  let j;
  for (let i = 0; ; i++) {
    try { j = JSON.parse(fs.readFileSync(approvedFile(ini), 'utf8')); break; } catch (e) {
      if (e?.code === 'ENOENT' || e instanceof SyntaxError) return null; // nothing applied yet / broken: not trusted
      // Held by another program (antivirus): retry briefly, then fail CLOSED - a locked file never lowers protection.
      if (i >= 3) return { enabled: true, timeoutSec: 120, ask: Object.fromEntries(CATEGORIES.map((k) => [k, true])) };
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  if (!j || typeof j.enabled !== 'boolean') return null;
  const t = j.timeoutSec;
  return {
    enabled: j.enabled,
    timeoutSec: Number.isInteger(t) && t >= 10 && t <= 3600 ? t : 120,
    ask: Object.fromEntries(CATEGORIES.map((k) => [k, typeof j.ask?.[k] === 'boolean' ? j.ask[k] : DEFAULT_ASK[k]])),
    patterns: (Array.isArray(j.patterns) ? j.patterns : []).flatMap((p) => { try { return [new RegExp(String(p), 'i')]; } catch { return []; } }),
  };
}
/** The full confirm.ini text for settings `s`, built on `base` (the template by default; other lines kept). */
export function iniTextFrom(s, base = TEMPLATE_CRLF) {
  let t = setIniText(base, 'confirm', 'enabled', String(s.enabled));
  t = setIniText(t, 'confirm', 'timeout_seconds', String(s.timeoutSec));
  for (const k of CATEGORIES) t = setIniText(t, 'ask', k, String(s.ask[k]));
  const have = parseIni(t).patterns || {};
  const kept = Object.values(have).map((v) => { try { return new RegExp(v, 'i').source; } catch { return null; } });
  let i = 1;
  for (const r of s.patterns) if (!kept.includes(r.source)) { while (`pattern${i}` in have) i++; t = setIniText(t, 'patterns', `pattern${i++}`, r.source); }
  return t;
}
// The current text, or (missing) what a recreated file holds: the last applied state, else the template.
const textOrRecreated = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const s = readApproved(file);
  return s ? iniTextFrom(s) : TEMPLATE_CRLF;
};
/**
 * Writes settings `s` into confirm.ini in ONE atomic write (built in memory on the current text, or on
 * the template when missing; other lines kept) — a failure leaves the file as it was (or absent).
 */
export function writeIniFrom(file, s, opts) {
  let base;
  try { base = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; base = TEMPLATE_CRLF; }
  writeAtomic(file, iniTextFrom(s, base), opts);
}
/** confirm.ini missing → recreated in one write: from the last applied state when there is one, else the template. */
export function restoreIni(file) {
  if (fs.existsSync(file)) return false;
  writeAtomic(file, textOrRecreated(file));
  return true;
}

/** Sets section.key = value in place (comments and other lines kept); adds the key if missing. A missing
 * file is recreated from the last applied state (never the "off" template over it), in the same write. */
export function setIni(file, section, key, value) {
  writeAtomic(file, setIniText(textOrRecreated(file), section, key, value));
}
/** [patterns] replaced by `list` (pattern1…N); the rest of the file kept. Owner 27.10: the AI sets them too. */
export function setIniPatterns(file, list) {
  const lines = textOrRecreated(file).split(/\r?\n/);
  let sec = '';
  const kept = lines.filter((l) => { const t = l.trim(), m = t.match(/^\[(.+)\]$/); if (m) { sec = m[1].trim().toLowerCase(); return true; } return !(sec === 'patterns' && t && !t.startsWith(';') && t.includes('=')); });
  let t = kept.join('\r\n');
  list.forEach((p, i) => { t = setIniText(t, 'patterns', `pattern${i + 1}`, p); });
  writeAtomic(file, t);
}
/** setIni on a text: → the new text. */
export function setIniText(text, section, key, value) {
  const lines = String(text).split(/\r?\n/);
  let sec = '', at = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim(), m = t.match(/^\[(.+)\]$/);
    if (m) { if (sec === section && end < 0) end = i; sec = m[1].trim().toLowerCase(); continue; }
    if (sec === section && !t.startsWith(';') && t.split('=')[0].trim().toLowerCase() === key) { at = i; break; }
  }
  if (at >= 0) lines[at] = `${key} = ${value}`;
  else if (lines.some((l) => l.trim().toLowerCase() === `[${section}]`)) lines.splice(end >= 0 ? end : lines.length, 0, `${key} = ${value}`);
  else lines.push('', `[${section}]`, `${key} = ${value}`);
  return lines.join('\r\n');
}

// --- the window --------------------------------------------------------------------------------
const HEAD = {
  delete: 'ChatGPT wants to delete files', dangerous_commands: 'ChatGPT wants to run a system command',
  write_files: 'ChatGPT wants to change a file', move: 'ChatGPT wants to move or rename', any_command: 'ChatGPT wants to run a command',
  install: 'ChatGPT wants to install or update a program', scheduled_scripts: 'ChatGPT wants to schedule a script',
  pattern: 'ChatGPT wants to do something your rules ask about',
};
export const LABEL = { delete: 'deletions', dangerous_commands: 'system commands', write_files: 'file changes', move: 'moves and renames', any_command: 'commands', install: 'installing programs', scheduled_scripts: 'scheduled scripts' };
const short = (s, n = 180) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/** What the window shows under the header: the command or path(s), ≤ 300 chars. */
/**
 * What the notification shows: the command or path(s) on one line (whitespace collapsed). Too long →
 * head … (+N chars) … tail, and the fragment that triggered the question is always kept.
 */
export function detail(name, args = {}, fragment = '', max = 140) {
  const a = args || {};
  const t = name === 'software' ? `${a.action === 'upgrade' ? 'Update' : 'Install'}: ${a.id || 'all programs'}`
    : a.source && a.destination ? `${a.source}  →  ${a.destination}`
    : commandOf(name, a) ?? a.path ?? a.file_path ?? JSON.stringify(a);
  return clip(String(t ?? ''), fragment, max);
}
export function clip(t, fragment = '', max = 140) {
  const flat = t.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const H = 60, T = 40;
  const head = flat.slice(0, H), tail = flat.slice(-T);
  let mid = '';
  const frag = String(fragment || '').replace(/\s+/g, ' ').trim();
  const i = frag ? flat.toLowerCase().indexOf(frag.toLowerCase()) : -1;
  if (i >= 0 && !(i + frag.length <= H) && !(i >= flat.length - T)) mid = flat.slice(Math.max(H, i - 10), Math.min(flat.length - T, i + frag.length + 10));
  const hidden = flat.length - head.length - tail.length - mid.length;
  return mid ? `${head} … ${mid} … (+${hidden} chars) … ${tail}` : `${head} … (+${hidden} chars) … ${tail}`;
}

export { askOnPc } from './ask.mjs';

// Tools the bridge adds itself (not the engine's).
const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };
export const CONFIRM_TOOL_DEFS = [
  { name: 'request_confirm_off', description: 'Ask the person at this PC to turn off the confirmation window for risky actions. Only the person can approve it, in a window on the PC; returns approved or declined.', inputSchema: NO_ARGS },
  { name: 'confirm_on', description: 'Turn the confirmation window for risky actions on this PC back on. No approval needed.', inputSchema: NO_ARGS },
];

const notConfirmed = (text) => ({ content: [{ type: 'text', text }], isError: true, notConfirmed: true });
export const COOLDOWN_MS = 10 * 60 * 1000;

/** What `next` turns off compared with `cur` (protection lowered): list of human labels. */
export function weakerBy(cur, next) {
  const off = [];
  if (cur.enabled && !next.enabled) off.push('confirmations');
  if (next.enabled || cur.enabled) for (const k of CATEGORIES) if (cur.ask[k] && !next.ask[k]) off.push(`confirmations for ${LABEL[k]}`);
  const src = (l) => l.map((r) => r.source);
  if (src(cur.patterns).some((p) => !src(next.patterns).includes(p))) off.push('your own patterns');
  return off;
}

/**
 * ini: path of confirm.ini. The file can't lower protection by itself: the last applied settings are
 * kept in memory; a change that turns something off (or a missing / broken file) is applied only
 * after Apply on the PC ("Keep" writes the applied state back); raising protection applies at once.
 * accept() = the bridge itself changed the file for the person (Bridgerator window, Allow always…).
 * gate(name, args) → null (go ahead) or the result to return instead. Only the questions are
 * serialized (one at a time); identical pending questions share one answer.
 */
export function createGate({ ini, ask = askOnPc, now = Date.now, onChange = () => {}, onAlways = () => {}, onTurnedOff = () => {}, host = os.hostname() } = {}) {
  // At start: the last applied state (confirm.approved) when there is one, else the file, else the defaults.
  // The file is then checked like any edit (first sync): stronger → applied at once, weaker → Apply / Keep
  // on the PC (an edit made while the bridge was stopped too); missing / broken → nothing changes.
  let applied = (ini && (readApproved(ini) || readSettingsStrict(ini))) || readSettings(ini);
  const approved = approvedFile(ini);
  // A failed write is retried at most once a minute (or when there is something new to write), and
  // only the first try may wait for a lock (writeAtomic's ~1 s) — never a blocking retry on every call.
  const RETRY_MS = 60 * 1000;
  let saved = '', keepFail = null, keepFailText = '', restoreFail = null;
  const keep = () => {
    if (!approved) return;
    const t = approvedJson(applied);
    if (t === saved || (keepFail !== null && t === keepFailText && now() - keepFail < RETRY_MS)) return;
    try { writeAtomic(approved, t, { wait: keepFail === null }); saved = t; keepFail = null; } catch { keepFail = now(); keepFailText = t; /* read-only: kept in memory */ }
  };
  // A deleted confirm.ini comes back with the applied state, in one write (never the "off" template).
  const restore = () => {
    if (restoreFail !== null && now() - restoreFail < RETRY_MS) return;
    try { if (!fs.existsSync(ini)) writeIniFrom(ini, applied, { wait: restoreFail === null }); restoreFail = null; } catch { restoreFail = now(); /* read-only */ }
  };
  let chain = Promise.resolve(), pending = 0, last = applied.enabled ? 'on' : 'off', reviewing = null;
  const allowUntil = {};            // category → time ("Allow 10 min" is per category)
  const cooldown = {};              // 'off' / 'setup' → no new question until this time after a Deny
  const merged = new Map();         // identical question → its promise
  const serial = (fn) => { pending++; const p = chain.then(fn).finally(() => { pending--; }); chain = p.catch(() => {}); return p; };
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  const report = () => { keep(); const m = applied.enabled ? 'on' : 'off'; if (m !== last) { last = m; onChange(m); } return m; };
  // Removed own patterns go back too (else the same question comes on every call).
  const writeApplied = () => { try { writeIniFrom(ini, applied); } catch { /* read-only */ } };
  // Re-read the file; lower protection only through the person.
  const sync = () => {
    if (!ini) return applied;
    const next = readSettingsStrict(ini);
    if (!next) { if (!reviewing) restore(); return applied; } // missing: recreated; broken: kept as is
    const off = weakerBy(applied, next);
    if (!off.length) { applied = next; report(); return applied; }
    if (!reviewing) {
      reviewing = serial(async () => {
        // A failed question counts as Keep (never an unhandled rejection).
        const r = await Promise.resolve().then(() => ask({ head: 'Bridgerator settings file changed', text: `Turn off ${off.join(', ')}?`, buttons: [['allow', 'Apply', ''], ['deny', 'Keep', 'deny']], secs: applied.timeoutSec, host, auto: 'auto-keep' })).catch(() => 'deny');
        if (r === 'allow') { applied = readSettingsStrict(ini) || next; onTurnedOff(off); } else writeApplied();
        report();
      }).finally(() => { reviewing = null; });
    }
    return applied;
  };
  // skip() → an answer without asking (checked when the question's turn comes), or null.
  const askOnce = (key, q, skip = () => null) => {
    if (merged.has(key)) return merged.get(key);
    const p = serial(() => skip() ?? ask(q)).finally(() => merged.delete(key));
    merged.set(key, p);
    return p;
  };

  if (ini) { restore(); keep(); }

  return {
    mode: () => { sync(); return report(); },
    settings: () => sync(),
    /**
     * The bridge itself wrote the file for the person. changed = only what it wrote ({ enabled?, <category>? }):
     * that is taken as applied, anything else in the file goes through the usual check (sync).
     * No argument (the person's own CLI command): the whole file is taken.
     */
    accept(changed) {
      const before = applied;
      if (changed && typeof changed === 'object') {
        const ask = { ...applied.ask };
        for (const k of CATEGORIES) if (typeof changed[k] === 'boolean') ask[k] = changed[k];
        applied = { ...applied, ask, ...(typeof changed.enabled === 'boolean' ? { enabled: changed.enabled } : {}), ...(Array.isArray(changed.patterns) ? { patterns: changed.patterns.map((p) => new RegExp(p, 'i')) } : {}) };
      } else applied = (ini && readSettingsStrict(ini)) || applied;
      const off = weakerBy(before, applied);
      if (off.length) onTurnedOff(off);
      sync();
      report();
    },
    /** Resolves when no question is on the screen (new commands wait for the person's answer). */
    idle: () => chain,
    get pending() { return pending; },
    gate: async (name, args) => {
      const s = sync();
      if (!s.enabled) return null;
      // A category with an open "Allow 10 min" window is skipped, so a later category of the same
      // call (a delete that is also a system command) is still asked about.
      const open = (c) => now() < (allowUntil[c] || 0);
      const ask1 = Object.fromEntries(Object.entries(s.ask).map(([k, v]) => [k, v && !open(k)]));
      const { cat, fragment } = findMatch(name, args, ask1, open('pattern') ? [] : s.patterns);
      if (!cat) return null;
      const buttons = [['allow', 'Allow', ''], ['allow10', 'Allow 10 min', ''], ...(cat !== 'pattern' ? [['always', 'Allow always', '']] : []), ['deny', 'Deny', 'deny']];
      const text0 = detail(name, args, fragment);
      // Re-checked when the question's turn comes: "Allow 10 min" given meanwhile covers it.
      const r = await askOnce(`${cat}|${name}|${text0}`, { head: HEAD[cat], text: text0, buttons, secs: s.timeoutSec, tool: name, host }, () => (open(cat) ? 'allow' : null));
      if (r === 'allow10') allowUntil[cat] = now() + ALLOW_FOR_MS;
      if (r === 'always' && cat !== 'pattern') { try { setIni(ini, 'ask', cat, 'false'); } catch { /* read-only */ } applied = { ...applied, ask: { ...applied.ask, [cat]: false } }; keep(); onAlways(cat); }
      return ['allow', 'allow10', 'always'].includes(r) ? null : notConfirmed(`The person at this PC did not allow this action (denied or no answer in ${s.timeoutSec} s). Ask them, or try something else.`);
    },
    /** A question of the bridge's own (bridgerator_setup): same queue, cool-down after a Deny. */
    askPerson: async (kind, q) => {
      if (now() < (cooldown[kind] || 0)) return 'cooldown';
      // Checked again when the question's turn comes: a Deny given while it waited counts.
      const r = await serial(() => (now() < (cooldown[kind] || 0) ? 'cooldown' : ask(q)));
      if (r !== 'allow' && r !== 'cooldown') cooldown[kind] = now() + COOLDOWN_MS;
      return r;
    },
    // The virtual tools (CONFIRM_TOOL_DEFS).
    tool: async (name) => {
      if (!ini) return text('Confirmations are not available on this PC.');
      if (name === 'confirm_on') { setIni(ini, 'confirm', 'enabled', 'true'); applied = { ...applied, enabled: true }; sync(); report(); return text('Confirmations are on for this PC (deletions and system commands, as set in confirm.ini).'); }
      if (!sync().enabled) return text('Confirmations are already off on this PC.');
      if (now() < (cooldown.off || 0)) return { ...text('declined: the person at this PC said no a few minutes ago — ask them directly.'), notConfirmed: true };
      // A call that waited in the queue and finds the cool-down already running gets 'cooldown' (the window is not moved).
      const r = await serial(() => (now() < (cooldown.off || 0) ? 'cooldown' : ask({ head: 'ChatGPT asks to stop confirming actions on this PC. Allow?', text: 'After that, deletions and system commands run without asking you. Turn it back on any time: bridgerator.cmd confirm on', buttons: [['allow', 'Allow', ''], ['deny', 'Deny', 'deny']], secs: applied.timeoutSec, host })));
      if (r === 'cooldown') return { ...text('declined: the person at this PC said no a few minutes ago — ask them directly.'), notConfirmed: true };
      if (r !== 'allow') { cooldown.off = now() + COOLDOWN_MS; return { ...text('declined: the person at this PC kept confirmations on.'), notConfirmed: true }; }
      setIni(ini, 'confirm', 'enabled', 'false');
      applied = { ...applied, enabled: false };
      onTurnedOff(['confirmations']);
      report();
      return text('approved: confirmations are off on this PC.');
    },
  };
}
