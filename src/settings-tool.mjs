// bridgerator_settings: ChatGPT can read every setting of the Bridgerator window and change them.
// Changes apply at once (owner 21.10). With "Ask before AI changes settings" (askSettings, off by default)
// anything that lowers protection or widens access needs Apply on the PC.
// LOGIC: see critical-logic/bridge.md ("Settings", "Access presets").
import { CATEGORIES, LABEL, readSettings } from './confirm.mjs';
import { validateSetup } from './setup-tool.mjs';
import { SNAP_DEFAULTS } from './undo.mjs';
import { FUSE_DEFAULTS } from './guard.mjs';
import { extraRegistry } from './extra-tools.mjs';

// Settings of the extra tools (screen capture…): declared by their modules (extra-tools.mjs).
const EXTRA = extraRegistry();

const BOOL = { type: 'boolean' };
const b = (description) => ({ type: 'boolean', description });
const int = (minimum, maximum, description) => ({ type: 'integer', minimum, maximum, description });
export const PRESETS = ['read_only', 'files', 'full'];
export const TIMEOUTS = [60, 120, 300];
/** What a fresh install has (owner 21.10: nothing restricted, like the engine on its own). */
export const DEFAULTS = {
  preset: 'full', terminal: true, allowedDirectories: [], readOnlyDirectories: [], protectSensitive: false,
  confirm: { enabled: false, ...readSettings('').ask, timeoutSeconds: 120 },   // no confirm.ini = the defaults per category
  recycleBin: true, snapshots: { ...SNAP_DEFAULTS }, fuse: { ...FUSE_DEFAULTS }, keepAwake: true, askSettings: false,
  theme: 'system', language: 'en', popupStyle: 'toast', notify: { sound: true, offline: true, queueDone: true, limit: true },
  deviceName: '', autostart: true, localHistory: false, telemetryEnabled: true,
  ...EXTRA.defaults(),
};
const NOTIFY = ['sound', 'offline', 'queueDone', 'limit'];
const dirs = { type: 'array', maxItems: 20, items: { type: 'string' } };
export const SETTINGS_TOOL_DEF = {
  name: 'bridgerator_settings',
  description: 'Reads ("get": current values and defaults) or changes ("set") every Bridgerator setting of this PC, the same as its window. Changes apply at once (the PC asks first only if the person turned on askSettings). Bridgerator\'s own folders and blocked commands are not settings.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['get', 'set'] },
      settings: {
        type: 'object', additionalProperties: false,
        properties: {
          preset: { type: 'string', enum: PRESETS, description: 'Access level: read_only = terminal off and every folder read-only; files = terminal off; full = files and terminal (default).' },
          terminal: b('Running commands and programs (start_process, interact_with_process, kill_process).'),
          allowedDirectories: { ...dirs, description: 'Folders ChatGPT may use; empty = all folders (default).' },
          readOnlyDirectories: { ...dirs, description: 'Folders that can be read but not changed by the file tools. Terminal commands are only checked as a courtesy (a script can still write there): for a hard limit turn the terminal off.' },
          protectSensitive: b('Block startup programs, PowerShell profiles, .ssh/.aws/cloud logins and AppData (default off).'),
          confirm: { type: 'object', additionalProperties: false, description: 'Ask the person on this PC before risky actions (default off).', properties: { ...Object.fromEntries(['enabled', ...CATEGORIES].map((k) => [k, BOOL])), timeoutSeconds: { type: 'integer', enum: TIMEOUTS, description: 'No answer in this time = Deny.' } } },
          recycleBin: b('Simple delete commands move files to the Recycle Bin instead of deleting them (default on).'),
          snapshots: { type: 'object', additionalProperties: false, description: 'Copies of files before ChatGPT changes them, for bridgerator_undo (default on, 7 days, 500 MB, files up to 50 MB).', properties: { enabled: BOOL, days: int(1, 30), maxMb: int(50, 5000), maxFileMb: int(1, 500) } },
          fuse: { type: 'object', additionalProperties: false, description: 'Pause Bridgerator and ask the person when more than limit files are deleted or moved within a minute (default off, 20).', properties: { enabled: BOOL, limit: int(3, 1000) } },
          keepAwake: b('Keep the PC from sleeping while ChatGPT works or the queue has tasks, on AC power only (default on).'),
          askSettings: b('Ask the person on the PC before an AI change to these settings that lowers protection (default off: every change applies at once).'),
          theme: { type: 'string', enum: ['system', 'light', 'dark'] }, language: { type: 'string', enum: ['en', 'ru'] },
          popupStyle: { type: 'string', enum: ['toast', 'popup'] },
          notify: { type: 'object', additionalProperties: false, properties: Object.fromEntries(NOTIFY.map((k) => [k, BOOL])) },
          deviceName: { type: 'string', maxLength: 40 }, autostart: BOOL, localHistory: b('Keep the Recent list on disk for 7 days.'), telemetryEnabled: b('Anonymous usage counts.'),
          ...EXTRA.schema(),
        },
      },
    },
  },
};

const TOP = ['theme', 'language', 'popupStyle', 'notify', 'deviceName', 'autostart', 'localHistory', 'telemetryEnabled', 'confirm', 'allowedDirectories', 'readOnlyDirectories',
  'preset', 'terminal', 'protectSensitive', 'recycleBin', 'snapshots', 'fuse', 'keepAwake', 'askSettings', ...EXTRA.groups()];
const RANGES = { 'snapshots.days': [1, 30], 'snapshots.maxMb': [50, 5000], 'snapshots.maxFileMb': [1, 500], 'fuse.limit': [3, 1000] };
const ENUM = { theme: ['system', 'light', 'dark'], language: ['en', 'ru'], popupStyle: ['toast', 'popup'] };

/** → { changes: [{key, value}] } (setSetting keys of the window) or { error }. */
export function validateSettings(input, opts) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'settings must be an object' };
  const bad = Object.keys(input).filter((k) => !TOP.includes(k));
  if (bad.length) return { error: `unknown setting(s): ${bad.join(', ')}` };
  const changes = [];
  for (const k of ['theme', 'language', 'popupStyle']) if (input[k] !== undefined) { if (!ENUM[k].includes(input[k])) return { error: `${k} must be one of ${ENUM[k].join(', ')}` }; changes.push({ key: k, value: input[k] }); }
  if (input.preset !== undefined) { if (!PRESETS.includes(input.preset)) return { error: `preset must be one of ${PRESETS.join(', ')}` }; changes.push({ key: 'preset', value: input.preset }); }
  for (const k of ['autostart', 'localHistory', 'telemetryEnabled', 'terminal', 'protectSensitive', 'recycleBin', 'keepAwake', 'askSettings']) if (input[k] !== undefined) { if (typeof input[k] !== 'boolean') return { error: `${k} must be true or false` }; changes.push({ key: k, value: input[k] }); }
  if (input.deviceName !== undefined) { if (typeof input.deviceName !== 'string' || input.deviceName.trim().length > 40 || /[\u0000-\u001f]/.test(input.deviceName)) return { error: 'deviceName must be text, up to 40 characters' }; changes.push({ key: 'deviceName', value: input.deviceName.trim() }); }
  for (const [group, keys] of [['notify', NOTIFY], ['confirm', ['enabled', ...CATEGORIES, 'timeoutSeconds']], ['snapshots', ['enabled', 'days', 'maxMb', 'maxFileMb']], ['fuse', ['enabled', 'limit']]]) {
    const g = input[group];
    if (g === undefined) continue;
    if (!g || typeof g !== 'object' || Array.isArray(g)) return { error: `${group} must be an object` };
    for (const [k, v] of Object.entries(g)) {
      const key = `${group}.${k}`;
      if (key === 'confirm.timeoutSeconds') { if (!TIMEOUTS.includes(v)) return { error: `confirm.timeoutSeconds must be one of ${TIMEOUTS.join(', ')}` }; changes.push({ key: 'confirm.timeout', value: v }); continue; }
      if (RANGES[key]) { const [lo, hi] = RANGES[key]; if (!Number.isInteger(v) || v < lo || v > hi) return { error: `${key} must be a whole number from ${lo} to ${hi}` }; changes.push({ key, value: v }); continue; }
      if (!keys.includes(k) || typeof v !== 'boolean') return { error: `${key}: unknown or not true/false` };
      changes.push({ key, value: v });
    }
  }
  const ex = EXTRA.parse(input);
  if (ex.error) return { error: ex.error };
  changes.push(...ex.changes);
  for (const k of ['allowedDirectories', 'readOnlyDirectories']) if (input[k] !== undefined) {
    const v = validateSetup({ [k]: input[k] }, opts);
    if (v.error) return { error: v.error };
    changes.push({ key: k, value: v.value[k] });
  }
  if (!changes.length) return { error: 'nothing to change' };
  return { changes };
}

const low = (a) => a.map((x) => x.toLowerCase());
/** Does this change lower protection or widen access (→ the person's OK on the PC)? */
export function widens(cur, { key, value }) {
  if (EXTRA.owns(key)) return EXTRA.widens(cur, { key, value });
  if (key === 'confirm.enabled') return cur.confirm.enabled && !value;
  if (key === 'confirm.timeout') return false;
  if (key.startsWith('confirm.')) return cur.confirm.ask[key.slice(8)] && !value;
  const was = (k, d) => (cur[k] === undefined ? d : cur[k]);
  if (key === 'terminal') return value && !was('terminal', DEFAULTS.terminal);
  if (key === 'protectSensitive' || key === 'recycleBin') return !value && was(key, DEFAULTS[key]);
  const snap = { ...SNAP_DEFAULTS, ...(cur.snapshots || {}) }, fuse = { ...FUSE_DEFAULTS, ...(cur.fuse || {}) };
  if (key === 'snapshots.enabled') return !value && snap.enabled;
  if (key.startsWith('snapshots.')) return value < snap[key.slice(10)];          // less undo history
  if (key === 'fuse.enabled') return !value && fuse.enabled;
  if (key === 'fuse.limit') return fuse.enabled && value > fuse.limit;
  if (key === 'askSettings') return !value && cur.askSettings === true;
  if (key === 'keepAwake' || key === 'preset') return false;                     // preset: judged by its parts (presetChanges)
  if (key === 'autostart') return value !== cur.autostart;
  if (key === 'telemetryEnabled') return value && !cur.telemetry;
  if (key === 'localHistory') return value && !cur.localHistory;
  if (key === 'readOnlyDirectories') { const now = low(value); return low(cur.readOnlyDirectories).some((x) => !now.includes(x)); }
  if (key === 'allowedDirectories') {
    const before = low(cur.allowedDirectories), after = low(value);
    if (!after.length) return before.length > 0;            // a list → all folders
    if (!before.length) return false;                        // all folders → a list: narrower
    return after.some((x) => !before.includes(x));           // a folder added to the list
  }
  return false;                                              // theme, language, notifications, name…
}

/** One human line per change, for the notification / the window. */
export function describe(cur, { key, value }) {
  const onoff = (v) => (v ? 'on' : 'off');
  if (EXTRA.owns(key)) return EXTRA.describe({ key, value });
  if (key === 'confirm.enabled') return `Confirmations: ${onoff(value)}`;
  if (key === 'confirm.timeout') return `No answer = Deny after: ${value} s`;
  if (key.startsWith('confirm.')) return `Confirm ${LABEL[key.slice(8)]}: ${onoff(value)}`;
  if (key === 'allowedDirectories') {
    if (!value.length) return 'Folders: all (except always-blocked)';
    const before = low(cur.allowedDirectories);
    const add = value.filter((x) => !before.includes(x.toLowerCase())), rem = cur.allowedDirectories.filter((x) => !low(value).includes(x.toLowerCase()));
    return `Folders: ${[...add.map((x) => `+${x}`), ...rem.map((x) => `−${x}`)].join(', ') || 'unchanged'}`;
  }
  if (key === 'readOnlyDirectories') {
    const before = low(cur.readOnlyDirectories);
    const add = value.filter((x) => !before.includes(x.toLowerCase())), rem = cur.readOnlyDirectories.filter((x) => !low(value).includes(x.toLowerCase()));
    return `Read-only: ${[...add.map((x) => `+${x}`), ...rem.map((x) => `−${x}`)].join(', ') || 'unchanged'}`;
  }
  const names = { autostart: 'Start with Windows', telemetryEnabled: 'Usage stats', localHistory: 'Local history', theme: 'Theme', language: 'Language', popupStyle: 'Pop-up style', deviceName: 'Computer name',
    terminal: 'Terminal (commands)', protectSensitive: 'Protect sensitive folders', recycleBin: 'Recycle Bin instead of deleting', keepAwake: 'Keep the PC awake while ChatGPT works', askSettings: 'Ask before AI changes settings', preset: 'Access',
    'snapshots.enabled': 'Snapshots and Undo', 'snapshots.days': 'Keep snapshots (days)', 'snapshots.maxMb': 'Snapshots up to (MB)', 'snapshots.maxFileMb': 'Snapshot files up to (MB)',
    'fuse.enabled': 'Pause on mass deletes / moves', 'fuse.limit': 'Mass-action limit per minute' };
  return `${names[key] || key}: ${typeof value === 'boolean' ? onoff(value) : value}`;
}

const covered = (dirs, ro) => { const r = low(ro).map((x) => x.replace(/[\\/]+$/, '')); return dirs.length > 0 && dirs.every((d) => { const n = d.toLowerCase().replace(/[\\/]+$/, ''); return r.some((x) => n === x || n.startsWith(`${x}\\`)); }); };
/** Folders the Read only preset makes read-only: the folder list, or every drive when there is none. */
const presetTargets = (s, drives) => (s.allowedDirectories.length ? s.allowedDirectories : drives);
/** The access preset the settings amount to: full (terminal on), read_only (terminal off, all read-only), files. */
export function presetOf(s, drives = []) {
  if (s.terminal !== false) return 'full';
  return covered(presetTargets(s, drives), s.readOnlyDirectories || []) ? 'read_only' : 'files';
}
/** A preset → the setting changes it stands for (terminal, readOnlyDirectories). */
export function presetChanges(name, s, drives = []) {
  const t = presetTargets(s, drives), ro = s.readOnlyDirectories || [];
  const out = [{ key: 'terminal', value: name === 'full' }];
  if (name === 'read_only') {
    const add = t.filter((d) => !low(ro).includes(d.toLowerCase()));
    if (add.length) out.push({ key: 'readOnlyDirectories', value: [...ro, ...add] });
  } else if (presetOf(s, drives) === 'read_only') {
    // Leaving Read only: the folders it made read-only go back to writable.
    const keep = ro.filter((d) => !low(t).includes(d.toLowerCase()));
    if (keep.length !== ro.length) out.push({ key: 'readOnlyDirectories', value: keep });
  }
  return out;
}
/** Change list with every preset replaced by what it stands for (the widen check looks at the parts). */
// The preset is judged on the folder lists of the SAME request (they are applied first, the preset after).
export function expandPresets(changes, s, drives) {
  const rest = changes.filter((c) => c.key !== 'preset'), presets = changes.filter((c) => c.key === 'preset');
  if (!presets.length) return changes;
  const s2 = { ...s };
  for (const c of rest) if (c.key === 'allowedDirectories' || c.key === 'readOnlyDirectories' || c.key === 'terminal') s2[c.key] = c.value;
  return [...rest, ...presets.flatMap((c) => presetChanges(c.value, s2, drives))];
}
