// bridgerator_setup: the assistant SUGGESTS folders / read-only folders / confirmation checks after
// a conversation with the person; nothing changes until the person clicks Apply in a window on the
// PC (no answer = Cancel). It can't touch the built-in exclusions, blockedCommands, telemetry or
// anything else.
import fs from 'node:fs';
import path from 'node:path';
import { CATEGORIES, readSettings, setIni, restoreIni, writeAtomic, LABEL } from './confirm.mjs';
import { TERMINAL_TOOLS } from './policy.mjs';

const MAX = 20;
const CONFIRM_KEYS = ['enabled', ...CATEGORIES];
const dirList = { type: 'array', maxItems: MAX, items: { type: 'string' } };
export const SETUP_TOOL_DEF = {
  name: 'bridgerator_setup',
  description: 'Limits access on this PC, and only when the person explicitly asks for limits ("only this folder", "read only", "ask me before deleting"). A folder named for a task is not a request to limit: just work there. "Set up Bridgerator" needs no call: the defaults (every folder, terminal on, no confirmations, deletions to the Recycle Bin, Undo on) are the setup. Fields: preset (read_only | files | full), allowedDirectories (empty = every folder), readOnlyDirectories, confirm. Applied at once (the PC asks first only if the person turned on "Ask before AI changes settings"). Absolute local paths only.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      preset: { type: 'string', enum: ['read_only', 'files', 'full'], description: 'read_only = look only (terminal off, everything read-only); files = files but no terminal; full = files and terminal (default).' },
      allowedDirectories: dirList,
      readOnlyDirectories: dirList,
      confirm: { type: 'object', additionalProperties: false, properties: Object.fromEntries(CONFIRM_KEYS.map((k) => [k, { type: 'boolean' }])) },
    },
  },
};

/** → { value } (normalized) or { error } (text for the assistant). */
export function validateSetup(input, { isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } } } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'expected an object' };
  const extra = Object.keys(input).filter((k) => !['preset', 'allowedDirectories', 'readOnlyDirectories', 'confirm'].includes(k));
  if (extra.length) return { error: `unknown setting(s): ${extra.join(', ')} — only preset, allowedDirectories, readOnlyDirectories and confirm can be suggested` };
  const value = {};
  if (input.preset !== undefined) {
    if (!['read_only', 'files', 'full'].includes(input.preset)) return { error: 'preset must be read_only, files or full' };
    value.preset = input.preset;
  }
  for (const k of ['allowedDirectories', 'readOnlyDirectories']) {
    if (input[k] === undefined) continue;
    const list = input[k];
    if (!Array.isArray(list) || list.length > MAX) return { error: `${k} must be a list of at most ${MAX} folders` };
    const out = [];
    for (const p of list) {
      if (typeof p !== 'string' || !p.trim()) return { error: `${k}: every entry must be a folder path` };
      const s = p.trim();
      if (/^[\\/]{2}/.test(s) || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return { error: `${k}: "${s}" — network paths and URLs are not allowed` };
      if (!/^[a-z]:[\\/]/i.test(s)) return { error: `${k}: "${s}" is not an absolute local path like C:\\Users\\Name\\Documents` };
      if (!isDir(s)) return { error: `${k}: "${s}" is not an existing folder` };
      const n = path.resolve(s);
      if (!out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
    }
    value[k] = out;
  }
  if (input.confirm !== undefined) {
    const c = input.confirm;
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { error: 'confirm must be an object' };
    const bad = Object.keys(c).filter((k) => !CONFIRM_KEYS.includes(k) || typeof c[k] !== 'boolean');
    if (bad.length) return { error: `confirm: unknown or non-boolean key(s): ${bad.join(', ')} (allowed: ${CONFIRM_KEYS.join(', ')})` };
    value.confirm = { ...c };
  }
  if (!Object.keys(value).length) return { error: 'nothing to change' };
  return { value };
}

/** One line for the notification, e.g. "Folders: D:\\Work, D:\\Photos (read-only) · confirm deletions: on". */
export function summarizeSetup(cfg, ini, v) {
  const parts = [];
  const ro = v.readOnlyDirectories || cfg.readOnlyDirectories || [];
  const folders = [...(v.allowedDirectories || []).map((d) => (ro.some((r) => r.toLowerCase() === d.toLowerCase()) ? `${d} (read-only)` : d)),
    ...(v.readOnlyDirectories || []).filter((r) => !(v.allowedDirectories || []).some((d) => d.toLowerCase() === r.toLowerCase())).map((r) => `${r} (read-only)`)];
  if (folders.length) parts.push(`Folders: ${folders.join(', ')}`);
  else if (v.readOnlyDirectories) parts.push('Read-only folders: none');
  if (v.confirm) {
    const s = readSettings(ini);
    const on = v.confirm.enabled ?? s.enabled;
    if (!on) parts.push('confirmations: off');
    else parts.push(`confirm ${CATEGORIES.filter((k) => (k in v.confirm ? v.confirm[k] : s.ask[k])).map((k) => LABEL[k]).join(', ') || 'nothing'}: on`);
  }
  const line = parts.join(' · ');
  return line.length > 180 ? `${line.slice(0, 179)}…` : line;
}

/** Before → after as a diff: lines for the window, one short line for the notification. */
export function diffSetup(cfg, ini, v) {
  const lines = [], parts = [];
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const d = (label, before, after) => {
    const add = after.filter((x) => !before.some((b) => same(b, x))), rem = before.filter((x) => !after.some((a) => same(a, x)));
    if (!add.length && !rem.length) return;
    lines.push(`${label}: ${before.length} → ${after.length}`, ...add.map((x) => `  + ${x}`), ...rem.map((x) => `  − ${x}`));
    parts.push(`${label}: ${[...add.map((x) => `+${x}`), ...rem.map((x) => `−${x}`)].join(', ')}`);
  };
  if (v.allowedDirectories) {
    const before = cfg.allowedDirectories || [], after = v.allowedDirectories;
    if (!after.length && before.length) { lines.push('Folders: all folders (except always-blocked)'); parts.push('Folders: all (except always-blocked)'); }
    else if (after.length && !before.length) { lines.push(`Folders: only these ${after.length}`, ...after.map((x) => `  + ${x}`)); parts.push(`Folders: only ${after.join(', ')}`); }
    else d('Folders', before, after);
  }
  if (v.readOnlyDirectories) d('Read-only', cfg.readOnlyDirectories || [], v.readOnlyDirectories);
  if (typeof v.terminal === 'boolean' && v.terminal !== !(cfg.disabledTools || []).includes('start_process')) { const t = `Terminal: ${v.terminal ? 'on' : 'off'}`; lines.push(t); parts.push(t); }
  if (v.confirm) {
    const s = readSettings(ini);
    const cur = { enabled: s.enabled, ...s.ask };
    for (const [k, x] of Object.entries(v.confirm)) if (cur[k] !== x) {
      const t = `${k === 'enabled' ? 'Confirmations' : `Confirm ${LABEL[k]}`}: ${x ? 'on' : 'off'}`;
      lines.push(t); parts.push(t);
    }
  }
  return { lines: lines.length ? lines : ['No changes'], short: parts.join(' · ') || 'No changes' };
}

/** Writes the approved settings: config.json (folders, setupDone) and confirm.ini. → the new cfg. */
export function applySetup(configFile, ini, v) {
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const next = { ...cfg, ...(v.allowedDirectories ? { allowedDirectories: v.allowedDirectories } : {}), ...(v.readOnlyDirectories ? { readOnlyDirectories: v.readOnlyDirectories } : {}), setupDone: true };
  if (typeof v.terminal === 'boolean') next.disabledTools = terminalTools(cfg.disabledTools, v.terminal);
  writeAtomic(configFile, JSON.stringify(next, null, 2));
  if (v.confirm) {
    restoreIni(ini);
    for (const [k, x] of Object.entries(v.confirm)) setIni(ini, k === 'enabled' ? 'confirm' : 'ask', k, x ? 'true' : 'false');
  }
  return next;
}

/** disabledTools with the terminal tools switched on (removed) or off (added). */
export function terminalTools(list = [], on) {
  const rest = (list || []).filter((x) => !TERMINAL_TOOLS.includes(x));
  return on ? rest : [...rest, ...TERMINAL_TOOLS];
}
