// LOGIC: see critical-logic/bridge.md ("Extra tools", apps). `apps`: UI Automation of ordinary Windows programs
// (owner 14.11; written by ChatGPT + Codex from gpt-out/brg_uia/REQUEST.md, reviewed by Claude). uia.ps1 (PowerShell 5.1
// + System.Windows.Automation) runs once per call and is killed on timeout. A snapshot gives eN refs; the bridge keeps each
// ref's locator chain (role + automationId + name + nth of dup siblings) and an action re-finds the element level by level:
// none → STALE_REF, a different count → AMBIGUOUS_TARGET, never "the first similar one". UIA patterns only (no mouse).
// Never: password values, elevated / UAC / sign-in windows, Bridgerator's own windows (its questions included).
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ToolError, psJson } from './tool-lib.mjs';

export { ToolError };
export const settings = [
  { key: 'apps.enabled', default: true, widensWhen: true, label: { en: 'Control of Windows programs (buttons, fields, menus)', ru: 'Управление программами Windows (кнопки, поля, меню)' }, hint: { en: 'The AI can read the windows of ordinary programs and press their buttons, fill fields and choose menu items. Never password fields, Windows security prompts, programs run as administrator or Bridgerator itself.', ru: 'ИИ может читать окна обычных программ, нажимать в них кнопки, заполнять поля и выбирать пункты меню. Никогда — поля паролей, запросы безопасности Windows, программы, запущенные от администратора, и сам Bridgerator.' } },
];
const fail = (code, message = code) => { throw new ToolError(code, message); };
const PS = fileURLToPath(new URL('./uia.ps1', import.meta.url));
export const LIMITS = Object.freeze({ shown: 150, scanned: 2000, depth: 8, walk_ms: 4000, snapshots: 20 });
const ACTIONS = ['windows', 'snapshot', 'act', 'wait'];
const CONSOLES = new Set(['cmd', 'powershell', 'pwsh', 'powershell_ise', 'windowsterminal', 'wt', 'conhost', 'openconsole', 'wsl', 'bash', 'mintty']);
const KINDS = ['invoke', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'focus', 'keys'];
const clean = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, 200);
const messages = {
  OWN_WINDOW: 'Bridgerator cannot control its own windows or Windows notifications.',
  TERMINAL_WINDOW: 'Console windows are not controlled through apps; use the terminal tools (start_process), which follow this PC\'s rules.',
  ELEVATED_TARGET: 'The target requires elevated access or denied UI Automation access.',
  SESSION_LOCKED: 'The session is locked or a Windows security prompt is open.',
  PASSWORD_FIELD: 'Password or unknown-password fields cannot receive text.',
  STALE_REF: 'This reference is no longer valid. Take a fresh snapshot.',
  AMBIGUOUS_TARGET: 'The target is ambiguous. Take a fresh snapshot or use window_id.',
  NO_PATTERN: 'The element does not support this action.',
  TIMEOUT: 'Windows took too long to answer; the worker was stopped.',
};
function check(r) {
  if (!r || r.ok !== true) {
    const e = new ToolError(r?.code || 'PS_FAILED', messages[r?.code] || r?.code || 'PS_FAILED');
    if (r?.acted || r?.partial) e.hint = 'Some input was already sent. Inspect the window before repeating the action.';
    throw e;
  }
  return r;
}
export const defs = [{
  name: 'apps', title: 'Windows applications',
  description: 'UI Automation of ordinary Windows applications. windows lists visible titled windows. '
    + 'snapshot reads one window by title substring or window_id and returns snapshot id plus eN references. '
    + 'act uses target eN and kind; supply snapshot or select the window for its latest snapshot. '
    + 'keys types literal text into the element after verified focus (no Tab / Enter / shortcuts). Every successful act returns a fresh snapshot if the window survives. '
    + 'wait waits for a title, or element {role?,name?}, to appear/disappear (state, timeout_ms <=15000). '
    + 'Password fields, elevated/security windows and Bridgerator itself are protected.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ACTIONS },
    window: { type: 'string', minLength: 1, maxLength: 200 },
    window_id: { type: 'integer', minimum: 1 },
    snapshot: { type: 'string', maxLength: 80 },
    target: { type: 'string', pattern: '^e[1-9][0-9]*$' },
    kind: { type: 'string', enum: KINDS },
    text: { type: 'string', maxLength: 10000 },
    element: { type: 'object', additionalProperties: false, properties: {
      role: { type: 'string', minLength: 1, maxLength: 200 },
      name: { type: 'string', minLength: 1, maxLength: 200 },
    } },
    state: { type: 'string', enum: ['appeared', 'disappeared'] },
    timeout_ms: { type: 'integer', minimum: 0, maximum: 15000 },
  } },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
}];

export function validateArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail('BAD_ARGS');
  if (!ACTIONS.includes(args.action)) fail('BAD_ACTION');
  const permitted = {
    windows: ['action'], snapshot: ['action', 'window', 'window_id'],
    act: ['action', 'window', 'window_id', 'snapshot', 'target', 'kind', 'text'],
    wait: ['action', 'window', 'window_id', 'element', 'state', 'timeout_ms'],
  }[args.action];
  if (Object.keys(args).some((k) => !permitted.includes(k))) fail('BAD_ARGS');
  for (const k of ['window', 'snapshot', 'target', 'kind', 'text']) {
    if (args[k] !== undefined && (typeof args[k] !== 'string' || args[k].length > (k === 'text' ? 10000 : k === 'snapshot' ? 80 : 200))) fail('BAD_ARGS');
    if (k !== 'text' && args[k] !== undefined && !args[k].trim()) fail('BAD_ARGS');
  }
  if (args.window_id !== undefined && (!Number.isSafeInteger(args.window_id) || args.window_id < 1)) fail('BAD_ARGS');
  if (args.window !== undefined && args.window_id !== undefined) fail('BAD_ARGS', 'Use window or window_id.');
  if (args.action !== 'windows' && !args.window && !args.window_id && !(args.action === 'act' && args.snapshot)) fail('BAD_ARGS', 'Select one window.');
  // A ref belongs to the snapshot the model read (another chat's or a later one numbers differently, review 14.11).
  if (args.action === 'act' && !args.snapshot) fail('BAD_ARGS', 'act needs snapshot (the id from apps snapshot) with its target eN.');
  if (args.action === 'act') {
    if (!/^e[1-9][0-9]{0,8}$/.test(args.target || '') || !KINDS.includes(args.kind)) fail('BAD_ARGS');
    if (['keys', 'set_value'].includes(args.kind)) {
      if (typeof args.text !== 'string' || (args.kind === 'keys' && !args.text)) fail('BAD_ARGS');
      if (args.kind === 'keys' && /[\u0000-\u001f\u007f]/.test(args.text)) fail('BAD_ARGS', 'keys types literal text only (no Tab, Enter or other control keys).');
    } else if (args.text !== undefined) fail('BAD_ARGS');
  }
  if (args.action === 'wait') {
    if (args.state !== undefined && !['appeared', 'disappeared'].includes(args.state)) fail('BAD_ARGS');
    if (args.timeout_ms !== undefined && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 0 || args.timeout_ms > 15000)) fail('BAD_ARGS');
    if (args.element !== undefined) {
      const e = args.element;
      if (!e || typeof e !== 'object' || Array.isArray(e) || !Object.keys(e).length || Object.keys(e).some(k => !['role', 'name'].includes(k))) fail('BAD_ARGS');
      for (const v of Object.values(e)) if (typeof v !== 'string' || !v.trim() || v.length > 200) fail('BAD_ARGS');
    }
  }
  return args;
}

export function protectedWindow(w) {
  const p = String(w.program ?? w.process ?? '').replace(/\.exe$/i, '').toLowerCase();
  if (['consent', 'credentialuibroker', 'logonui', 'winlogon'].includes(p)) return 'SESSION_LOCKED';
  // shellexperiencehost = Windows notifications: a Bridgerator question shown as a toast has its Allow button there.
  if (p === 'bridgerator' || p === 'shellexperiencehost' || /^bridgerator/i.test(String(w.title ?? ''))) return 'OWN_WINDOW';
  // Typing into a console would run commands past the terminal's rules (confirmations, blocked commands, Recycle Bin).
  if (CONSOLES.has(p)) return 'TERMINAL_WINDOW';
  return w.blocked || null;
}
export function pickWindow(list, args) {
  const matches = args.window_id ? list.filter(w => w.id === args.window_id)
    : list.filter(w => String(w.title).toLowerCase().includes(args.window.toLowerCase()));
  if (!matches.length) fail('NO_WINDOW');
  // Even an exact title is ambiguous if another window matches the supplied substring.
  if (matches.length !== 1) fail('AMBIGUOUS_TARGET');
  const w = matches[0], code = protectedWindow(w);
  if (code) fail(code, messages[code] || code);
  if (!Number.isSafeInteger(w.id) || !Number.isInteger(w.pid) || w.pid <= 0 || typeof w.started !== 'string' || !w.started) fail('PS_FAILED');
  return { id: w.id, pid: w.pid, started: w.started, title: clean(w.title), program: clean(w.program ?? w.process) };
}

export class SnapshotStore {
  #items = new Map();
  add(window, raw) {
    if (typeof raw.text !== 'string' || raw.text.length > 100000 || !raw.refs || typeof raw.refs !== 'object' || Array.isArray(raw.refs)) fail('PS_FAILED');
    const refs = Object.create(null);
    const entries = Object.entries(raw.refs);
    if (entries.length > LIMITS.shown) fail('PS_FAILED');
    for (const [key, chain] of entries) {
      if (!/^e[1-9][0-9]*$/.test(key) || !Array.isArray(chain) || chain.length > LIMITS.depth) fail('PS_FAILED');
      refs[key] = chain.map(s => {
        if (!s || typeof s.role !== 'string' || typeof s.aid !== 'string' || typeof s.name !== 'string'
          || s.name.length > 200 || s.aid.length > 200 || s.role.length > 200
          || !Number.isInteger(s.nth) || !Number.isInteger(s.dup) || s.nth < 0 || s.dup < 1 || s.dup > 2000 || s.nth >= s.dup) fail('PS_FAILED');
        return Object.freeze({ role: s.role, aid: s.aid, name: s.name, nth: s.nth, dup: s.dup });
      });
      Object.freeze(refs[key]);
    }
    const id = 's-' + randomUUID();
    const item = Object.freeze({ id, window: Object.freeze({ ...window }), refs: Object.freeze(refs) });
    this.#items.set(id, item);
    while (this.#items.size > LIMITS.snapshots) this.#items.delete(this.#items.keys().next().value);
    return item;
  }
  get(id) { return this.#items.get(id); }
  latest(window) {
    return [...this.#items.values()].reverse().find(s => s.window.id === window.id && s.window.pid === window.pid && s.window.started === window.started);
  }
}

const result = o => ({ content: [{ type: 'text', text: JSON.stringify(o) }] });
export function createApps() {
  const store = new SnapshotStore();
  // Serialize snapshot/act/wait calls: an omitted snapshot always means the latest completed call.
  let tail = Promise.resolve();
  const run = async (ctx, request, timeout = 12000) => check(await psJson(ctx, {
    files: [PS], env: { BRX_UIA: Buffer.from(JSON.stringify(request), 'utf8').toString('base64') }, timeout,
  }));
  const getWindow = async (ctx, args) => {
    const r = await run(ctx, { action: 'windows' });
    if (!Array.isArray(r.windows)) fail('PS_FAILED');
    return pickWindow(r.windows, args);
  };
  const save = (w, r) => {
    const s = store.add(w, r);
    return { snapshot: s.id, text: r.text }; // no locator chains, process identity or values outside text
  };
  async function execute(name, input, ctx = {}) {
    if (name !== 'apps') fail('BAD_TOOL');
    if (ctx.extra?.value && !ctx.extra.value(ctx.cfg, 'apps.enabled')) fail('APPS_OFF', 'Control of Windows programs is turned off on this PC (Bridgerator → Safety). The person can turn it on.');
    const args = validateArgs(input);
    if (args.action === 'windows') {
      const r = await run(ctx, { action: 'windows' });
      if (!Array.isArray(r.windows)) fail('PS_FAILED');
      return result({ windows: r.windows.map(w => ({
        id: w.id, title: clean(w.title), program: clean(w.program ?? w.process), pid: w.pid,
        ...(protectedWindow(w) ? { blocked: protectedWindow(w) } : {}),
      })) });
    }
    if (args.action === 'wait' && !args.element) {
      const r = await run(ctx, { action: 'wait', window: args.window, window_id: args.window_id,
        state: args.state ?? 'appeared', timeout_ms: args.timeout_ms ?? 5000 }, (args.timeout_ms ?? 5000) + 10000);
      return result({ met: r.met, elapsed_ms: r.elapsed_ms });
    }
    let w, s;
    if (args.action === 'act' && args.snapshot) {
      s = store.get(args.snapshot);
      if (!s) fail('STALE_REF');
      w = s.window;
      if (args.window || args.window_id) {
        const selected = await getWindow(ctx, args);
        if (selected.id !== w.id || selected.pid !== w.pid || selected.started !== w.started) fail('STALE_REF');
      }
    } else {
      w = await getWindow(ctx, args);
      if (args.action === 'act') s = store.latest(w);
    }
    if (args.action === 'snapshot') return result(save(w, await run(ctx, { action: 'snapshot', identity: w })));
    if (args.action === 'wait') {
      const r = await run(ctx, { action: 'wait', identity: w, element: args.element,
        state: args.state ?? 'appeared', timeout_ms: args.timeout_ms ?? 5000 }, (args.timeout_ms ?? 5000) + 10000);
      return result({ met: r.met, elapsed_ms: r.elapsed_ms });
    }
    if (!s || !Object.hasOwn(s.refs, args.target)) fail('STALE_REF');
    // Like a terminal command: off with the terminal; asks when confirmations are on. Fails closed without the gate.
    if ((ctx.cfg?.disabledTools || []).includes('start_process')) fail('TERMINAL_OFF', 'Acting in program windows is off on this PC together with the terminal (access preset Read only or Files).');
    if (typeof ctx.gate?.gate !== 'function') fail('NO_GATE', 'Acting in program windows is not available here.');
    const stop = await ctx.gate.gate('apps', { action: 'act', kind: args.kind, target: args.target, ...(args.text !== undefined ? { text: args.text } : {}), window: w.title });
    if (stop) return stop;
    let r;
    try { r = await run(ctx, { action: 'act', identity: w, chain: s.refs[args.target], kind: args.kind, text: args.text }, 16000); }
    catch (e) {
      if (['TIMEOUT', 'PS_FAILED'].includes(e.code)) e.hint = 'The action may already have happened. Inspect the window before repeating it.';
      // Some editors (Windows 11 Notepad) have no writable Value: typing works (lab 14.11).
      if (args.kind === 'set_value' && ['NO_PATTERN', 'READ_ONLY'].includes(e.code)) e.hint = 'This field takes no direct value: use kind "keys" on it to type the text.';
      throw e;
    }
    const response = { acted: true, kind: args.kind, target: args.target };
    if (r.window_closed) response.window_closed = true;
    else if (r.snapshot_error) response.snapshot_error = r.snapshot_error;
    else {
      try { Object.assign(response, save(w, r)); }
      catch (e) { response.snapshot_error = e.code || 'PS_FAILED'; }
    }
    // Partial success must stay explicit: do not suggest retrying an already performed action.
    return result(response);
  }
  return { store, handle(name, args, ctx) {
    const task = tail.then(() => execute(name, args, ctx));
    tail = task.catch(() => {});
    return task;
  } };
}
export const handle = createApps().handle;