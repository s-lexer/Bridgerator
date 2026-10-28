// LOGIC: see critical-logic/bridge.md ("AI ↔ AI delegation"). bridgerator_delegate: one AI hands a task
// to another agent CLI installed on this PC — Codex (`codex exec`), Claude Code (`claude -p`), Gemini CLI
// (`gemini -p`) — run headless with the person's own sign-in, in ONE folder, and gets its answer back.
//   - folder rules: a full local path inside the allowed list, not excluded, not holding an excluded /
//     Bridgerator folder; a read-only folder (or one holding a read-only folder) → the agent runs in "read";
//   - limits (window "Agents" / bridgerator_settings `delegate.*`): per-agent allow (on once found), mode
//     read / edit / full (default full = the agent's own permissions widest inside the folder), at most
//     `parallel` runs, `timeoutMin`, `maxOutputKb` of answer;
//   - Undo: the folder is copied into the snapshots before the run (≤ undoMb, ≤ 5000 files; .git,
//     node_modules, .venv skipped), after it only the changed files are kept → ONE undo action per run;
//   - the child gets no Bridgerator variables / tokens, no MCP servers (no way back into Bridgerator:
//     a delegated agent can not delegate again), deny rules for Bridgerator's folders where the CLI has them;
//   - the task text is checked like a terminal command (excluded folders, Bridgerator itself) and must not
//     carry this PC's key; the answer has the key masked;
//   - finished background runs → relay event `delegate_done` {ok: 0|1} (events.mjs).
// Detection reads only the FACT that a CLI's sign-in file exists (never its content) and runs `--version`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { isSea } from 'node:sea';
import { stripOurs } from './ask.mjs';
import { writeAtomic } from './confirm.mjs';
import { norm, realish, ownDenied, sensitiveDenied } from './policy.mjs';
import { fail, json, needAction, str, int, guard } from './tool-lib.mjs';
import { TASKKILL } from './win.mjs';

export const AGENTS = {
  codex: { name: 'Codex', bin: 'codex' },
  claude: { name: 'Claude Code', bin: 'claude' },
  gemini: { name: 'Gemini CLI', bin: 'gemini' },
};
export const AGENT_IDS = Object.keys(AGENTS);
export const MODES = ['read', 'edit', 'full'];                 // narrow → wide
export const NO_MCP = 'bridgerator-none';                       // Gemini: allow only this (non-existent) MCP server
const MB = 1024 * 1024;
const MAX_TASK = 16000, MAX_RUNS = 50, MAX_FILES_LISTED = 200, SCAN_FILES = 20000, SNAP_FILES = 5000;
const STDOUT_CAP = 4 * MB, STDERR_CAP = 16 * 1024, VERSION_MS = 15000, DETECT_TTL_MS = 10 * 60000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__']);
const STATES = ['running', 'done', 'failed', 'timeout', 'cancelled', 'interrupted'];

// ---- settings (extra-tools registry: window page "Agents", bridgerator_settings `delegate`) ----------
const lab = (en, ru) => ({ en, ru });
export const settings = [
  ...AGENT_IDS.map((id) => ({ key: `delegate.${id}`, default: true, widensWhen: true, page: 'agents', label: lab(`Allow delegation to ${AGENTS[id].name}`, `Разрешить поручать задачи ${AGENTS[id].name}`), hint: lab('Used only when it is installed on this PC', 'Работает, только если он установлен на этом ПК') })),
  { key: 'delegate.mode', type: 'enum', values: MODES, default: 'full', widensWhen: 'up', page: 'agents', label: lab('What a delegated agent may do (read / edit / full)', 'Что может делать агент (read / edit / full)'), hint: lab('full = its own widest permissions inside the chosen folder', 'full = самые широкие права самого агента внутри выбранной папки') },
  { key: 'delegate.parallel', type: 'int', min: 1, max: 4, default: 2, widensWhen: 'up', page: 'agents', label: lab('Delegated tasks at once', 'Поручений одновременно') },
  { key: 'delegate.timeoutMin', type: 'int', min: 1, max: 240, default: 30, widensWhen: 'up', page: 'agents', label: lab('Time limit per task (minutes)', 'Лимит времени на задачу (минуты)') },
  { key: 'delegate.maxOutputKb', type: 'int', min: 4, max: 256, default: 32, widensWhen: null, page: 'agents', label: lab('Longest answer passed back (KB)', 'Самый длинный ответ (КБ)') },
  // Owner 21.10: the window's "Agent tasks" page keeps finished tasks (newest first, with Undo); off = finished ones disappear.
  { key: 'delegate.keepFinished', default: true, widensWhen: false, label: lab('Keep finished agent tasks in the list', 'Хранить завершённые задачи агентов'), hint: lab('On the Agent tasks page, newest first, each with Undo. Off: a task leaves the list when it ends.', 'На странице «Задачи агентов», новые сверху, у каждой есть отмена. Выключено: задача пропадает из списка, когда закончится.') },
  { key: 'delegate.undoMb', type: 'int', min: 0, max: 2000, default: 200, widensWhen: 'down', page: 'agents', label: lab('Copy the folder for Undo up to (MB, 0 = no copy)', 'Копия папки для отмены до (МБ, 0 = без копии)') },
];
const SPEC = new Map(settings.map((s) => [s.key.split('.')[1], s]));
const okVal = (s, v) => (s.type === 'int' ? Number.isInteger(v) && v >= s.min && v <= s.max : s.type === 'enum' ? s.values.includes(v) : typeof v === 'boolean');
/** Current delegate.* values of a config (bad / missing → the default). */
export function limitsOf(cfg) {
  const o = {};
  for (const [k, s] of SPEC) { const v = cfg?.delegate?.[k]; o[k] = okVal(s, v) ? v : s.default; }
  return o;
}

// ---- finding the CLIs --------------------------------------------------------------------------------
const envGet = (env, n) => { const k = Object.keys(env || {}).find((x) => x.toLowerCase() === n.toLowerCase()); return k ? env[k] : undefined; };
const homeOf = (env, home) => home || envGet(env, 'USERPROFILE') || os.homedir();
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** Folders searched for an agent, known install places first, then PATH (absolute, not the current / home folder). */
export function searchDirs(id, { env = process.env, home, cwd = process.cwd() } = {}) {
  const h = homeOf(env, home);
  const appData = envGet(env, 'APPDATA') || path.join(h, 'AppData', 'Roaming');
  const local = envGet(env, 'LOCALAPPDATA') || path.join(h, 'AppData', 'Local');
  const bin = AGENTS[id].bin;
  const known = [path.join(appData, 'npm'), path.join(h, '.local', 'bin'), path.join(local, 'Microsoft', 'WinGet', 'Links'), path.join(local, 'pnpm'), path.join(local, 'Programs', bin), path.join(local, 'Programs', bin, 'bin')];
  const bad = new Set([norm(cwd), norm(h)]);
  const fromPath = String(envGet(env, 'PATH') || '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter((d) => /^[a-z]:[\\/]/i.test(d) && !bad.has(norm(d)));
  const seen = new Set(), out = [];
  for (const d of [...known, ...fromPath]) { const k = norm(d); if (!seen.has(k)) { seen.add(k); out.push(d); } }
  return out;
}

/**
 * An npm shim (`codex.cmd`) → what it starts: { cmd, pre } for a node script (run with OUR node, never
 * through cmd.exe: a prompt must not pass a shell) or an exe, or null when the shim is not npm's.
 */
export function readShim(file, { sea = isSea(), env = process.env } = {}) {
  let t;
  try { t = fs.readFileSync(file, 'utf8').slice(0, 65536); } catch { return null; }
  const all = [...t.matchAll(/"%~?dp0%\\?([^"%*\r\n]+?\.(?:c?js|mjs|exe))"/gi)].map((m) => m[1]).filter((r) => !/^node\.exe$/i.test(r));
  if (!all.length) return null;
  const dir = path.dirname(file), target = path.resolve(dir, all[all.length - 1]);
  if (!target.startsWith(dir + path.sep) || !isFile(target)) return null;
  if (/\.exe$/i.test(target)) return { cmd: target, pre: [] };
  // The Windows app (SEA): process.execPath is bridgerator.exe, which runs only its own app's scripts →
  // the person's own Node (the one npm installed the agent with), by absolute path; none → not startable.
  const node = sea ? nodeExe(dir, env) : process.execPath;
  return node ? { cmd: node, pre: [target] } : null;
}
/** node.exe for an npm shim in `dir`: next to it, Program Files\nodejs, then absolute PATH folders. */
export function nodeExe(dir, env = process.env) {
  const pathVar = env.Path ?? env.PATH ?? '';
  const dirs = [dir, ...[env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean).map((d) => path.join(d, 'nodejs')), ...pathVar.split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter((d) => /^[a-z]:\\/i.test(d))];
  for (const d of dirs) { const f = path.join(d, 'node.exe'); if (isFile(f)) return f; }
  return null;
}

/** → { path, cmd, pre } (cmd null + problem when found but not startable safely) or null. */
export function findAgent(id, opts = {}) {
  const bin = AGENTS[id].bin;
  let odd = null;
  for (const d of searchDirs(id, opts)) {
    const exe = path.join(d, `${bin}.exe`);
    if (isFile(exe)) return { path: exe, cmd: exe, pre: [] };
    const shim = path.join(d, `${bin}.cmd`);
    if (isFile(shim)) {
      const r = readShim(shim);
      if (r) return { path: shim, ...r };
      odd ||= { path: shim, cmd: null, pre: [], problem: 'SHIM' };
    }
  }
  return odd;
}

/** Signed in? 'yes' | 'no' | 'unknown' — only whether the CLI's sign-in file / key variable exists. */
export function signedIn(id, { env = process.env, home } = {}) {
  const h = homeOf(env, home);
  const set = (...n) => n.some((x) => !!envGet(env, x));
  if (id === 'codex') {
    const d = envGet(env, 'CODEX_HOME') || path.join(h, '.codex');
    if (isFile(path.join(d, 'auth.json')) || set('CODEX_API_KEY', 'OPENAI_API_KEY')) return 'yes';
    let t = '';
    try { t = fs.readFileSync(path.join(d, 'config.toml'), 'utf8'); } catch { /* no config */ }
    return /^\s*cli_auth_credentials_store\s*=\s*"(keyring|auto)"/m.test(t) ? 'unknown' : 'no';   // kept in the Windows keyring
  }
  if (id === 'claude') {
    const d = envGet(env, 'CLAUDE_CONFIG_DIR') || path.join(h, '.claude');
    return isFile(path.join(d, '.credentials.json')) || set('ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX') ? 'yes' : 'no';
  }
  return isFile(path.join(h, '.gemini', 'oauth_creds.json')) || set('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS') ? 'yes' : 'no';
}

/** Codex MCP servers of the person's config.toml (names only) → switched off for a delegated run. */
export function codexMcpNames({ env = process.env, home } = {}) {
  const d = envGet(env, 'CODEX_HOME') || path.join(homeOf(env, home), '.codex');
  let t = '';
  try { t = fs.readFileSync(path.join(d, 'config.toml'), 'utf8'); } catch { return []; }
  const names = [...t.matchAll(/^\s*\[mcp_servers\.(?:"([^"\]]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)].map((m) => m[1] || m[2]).filter((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n));
  return [...new Set(names)];
}

/** The environment of a delegated run: the person's, without Bridgerator's variables / key. */
export function childEnv(env = process.env, token = '') {
  const e = stripOurs(env);
  for (const k of Object.keys(e)) {
    if (/^(NODE_TLS_REJECT_UNAUTHORIZED|DC_.*|DESKTOP_COMMANDER_.*)$/i.test(k)) delete e[k];
    else if (/^NODE_OPTIONS$/i.test(k) && /bridgerator/i.test(e[k])) delete e[k];
    else if (token && token.length >= 8 && String(e[k]).includes(token)) delete e[k];
  }
  return e;
}

// ---- the command line of each agent --------------------------------------------------------------------
/** C:\Users\A\x → //c/Users/A/x (Claude Code permission rules match POSIX-style absolute paths on Windows). */
export const claudePath = (p) => { const m = /^([a-z]):[\\/]?(.*)$/i.exec(p); return m ? `//${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/').replace(/\/+$/, '')}` : p.replace(/\\/g, '/'); };

export function promptFor({ task, folder, from }) {
  return [
    `A task handed to you by ${from} (another AI assistant this person uses) through a local bridge on this PC.`,
    `Work only inside this folder: ${folder}`,
    'Do not hand the task to another AI agent and do not change any AI assistant settings.',
    'When you finish, answer with a short summary of what you did and the files you created, changed or deleted.',
    '',
    'Task:',
    task,
  ].join('\n');
}

/** argv for the agent CLI (headless, JSON output, permissions by mode, no MCP servers). */
export function buildArgs(id, { prompt, folder, mode, denyDirs = [], mcpNames = [] }) {
  if (!MODES.includes(mode)) throw new Error(`bad mode ${mode}`);
  if (id === 'codex') {
    // workspace-write: writes only inside --cd (and temp); full = also network for its commands.
    const a = ['exec', '--json', '--skip-git-repo-check', '--cd', folder, '--sandbox', mode === 'read' ? 'read-only' : 'workspace-write'];
    if (mode === 'full') a.push('-c', 'sandbox_workspace_write.network_access=true');
    for (const n of mcpNames) a.push('-c', `mcp_servers.${n}.enabled=false`);
    return [...a, '--', prompt];
  }
  if (id === 'claude') {
    const pm = { read: 'dontAsk', edit: 'acceptEdits', full: 'bypassPermissions' }[mode];
    // Deny rules hold in every mode, bypassPermissions too; "mcp__*" removes every MCP tool (no way back to Bridgerator).
    const rules = ['mcp__*'];
    for (const d of denyDirs) { const p = claudePath(d); rules.push(...(isDir(d) ? [`Read(${p}/**)`, `Edit(${p}/**)`] : [`Read(${p})`, `Edit(${p})`])); }
    return ['-p', '--output-format', 'json', '--permission-mode', pm, '--disallowedTools', ...rules, '--', prompt];
  }
  if (id === 'gemini') {
    return ['--output-format', 'json', ...(mode === 'read' ? [] : ['--approval-mode', mode === 'full' ? 'yolo' : 'auto_edit']), '--allowed-mcp-server-names', NO_MCP, `--prompt=${prompt}`];
  }
  throw new Error(`unknown agent ${id}`);
}

const tail = (s, n = 4000) => { const t = String(s || '').trim(); return t.length > n ? `…${t.slice(-n)}` : t; };
function lastJson(s) {
  const t = String(s || '').trim();
  try { return JSON.parse(t); } catch { /* not one object */ }
  const lines = t.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) { const l = lines[i].trim(); if (l.startsWith('{')) { try { return JSON.parse(l); } catch { /* next */ } } }
  const i = t.indexOf('{');
  if (i > 0) { try { return JSON.parse(t.slice(i)); } catch { /* none */ } }
  return null;
}
/** stdout of the agent → { text, error } (error = the agent's own failure message, else null). */
export function parseOutput(id, out) {
  const s = String(out || '');
  if (id === 'codex') {
    let text = '', error = null;
    for (const line of s.split(/\r?\n/)) {
      if (!line.startsWith('{')) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') text = e.item.text;
      else if (e.type === 'turn.failed') error = String(e.error?.message || 'the turn failed');
      else if (e.type === 'error' && e.message) error = String(e.message);
    }
    return { text: text || (error ? '' : tail(s)), error };
  }
  const j = lastJson(s);
  if (!j || typeof j !== 'object') return { text: tail(s), error: null };
  if (id === 'claude') {
    const bad = j.is_error === true || (typeof j.subtype === 'string' && j.subtype !== 'success');
    const text = typeof j.result === 'string' ? j.result : '';
    return { text, error: bad ? (text.slice(0, 300) || String(j.subtype || 'error')) : null };
  }
  return { text: typeof j.response === 'string' ? j.response : '', error: j.error ? String(j.error.message || j.error.type || 'error') : null };
}

// ---- the folder before / after ---------------------------------------------------------------------------
/** → { over, files: Map(path → {size, mtimeMs}) | null, bytes }; null when the folder can't be read. */
export function scanTree(root, { maxFiles = SCAN_FILES } = {}) {
  const files = new Map();
  let bytes = 0;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let list;
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { if (d === root) return null; continue; }
    for (const e of list) {
      if (e.isSymbolicLink()) continue;                         // junctions too: never followed
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name.toLowerCase())) stack.push(p); continue; }
      if (!e.isFile()) continue;
      if (files.size >= maxFiles) return { over: true, files: null, bytes };
      let st; try { st = fs.statSync(p); } catch { continue; }
      files.set(p, { size: st.size, mtimeMs: Math.round(st.mtimeMs) });
      bytes += st.size;
    }
  }
  return { over: false, files, bytes };
}
export function diffTrees(a, b) {
  const modified = [], created = [], deleted = [];
  for (const [p, x] of a) { const y = b.get(p); if (!y) deleted.push(p); else if (y.size !== x.size || y.mtimeMs !== x.mtimeMs) modified.push(p); }
  for (const p of b.keys()) if (!a.has(p)) created.push(p);
  return { modified: modified.sort(), created: created.sort(), deleted: deleted.sort() };
}

/** The ONE place an agent CLI starts: a.cmd is an absolute path from findAgent (an .exe, or our node for an npm script), never a shell. */
export const startCli = (a, args, opts) => spawn(a.cmd, [...a.pre, ...args], opts);

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    const k = spawn(TASKKILL, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    k.on('error', () => { try { child.kill(); } catch { /* gone */ } });
  } else { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

// ---- runs -----------------------------------------------------------------------------------------------
const cleanName = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) : '');
const cap = (s, n) => (s.length <= n ? s : `${s.slice(0, Math.floor(n / 4))}\n…[${s.length - n} characters left out]…\n${s.slice(-(n - Math.floor(n / 4)))}`);
const mask = (s, token) => (token && token.length >= 8 ? String(s).split(token).join('[hidden]') : String(s));
const capList = (l) => (l.length > MAX_FILES_LISTED ? [...l.slice(0, MAX_FILES_LISTED), `… and ${l.length - MAX_FILES_LISTED} more`] : l);

/**
 * The run store of one bridge. file = the run log (delegate.json in the settings folder, local only).
 * snapshots = undo.mjs store (or null). emit({kind,…}) → relay events. Test seams: env, home, minuteMs, kill.
 */
export function createDelegate({ file = '', snapshots = null, log = () => {}, emit = () => {}, onChange = () => {}, env = process.env, home, now = Date.now, minuteMs = 60000, kill = killTree } = {}) {
  let runs = [];
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(j.runs)) runs = j.runs.filter((r) => r && typeof r.id === 'string' && STATES.includes(r.state)).slice(0, MAX_RUNS);
  } catch { /* no log yet */ }
  // A run that was going when the bridge stopped is not watched any more.
  for (const r of runs) if (r.state === 'running') { r.state = 'interrupted'; r.ok = false; r.endedAt ||= new Date(now()).toISOString(); }
  const live = new Map();        // id → { child, done: Promise, cancel() }
  let detected = null, detecting = null;
  const save = () => { if (!file) return; try { writeAtomic(file, JSON.stringify({ runs })); } catch (e) { log(`[bridgerator] delegate log not saved: ${e.code || e.message}`); } };

  function version(a) {
    return new Promise((resolve) => {
      let out = '', done = false;
      const fin = (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      let c;
      try { c = startCli(a, ['--version'], { windowsHide: true, env: childEnv(env), stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return resolve(null); }
      const t = setTimeout(() => { kill(c); fin(null); }, VERSION_MS);
      c.stdout.on('data', (b) => { if (out.length < 2000) out += b; });
      c.on('error', () => fin(null));
      c.on('close', () => { const m = /\d+\.\d+(?:\.\d+)?[\w.+-]*/.exec(out); fin(m ? m[0].slice(0, 40) : null); });
    });
  }
  async function detect(force = false) {
    if (!force && detected && now() - detected.t < DETECT_TTL_MS) return detected.list;
    if (detecting) return detecting;
    detecting = (async () => {
      const list = [];
      for (const id of AGENT_IDS) {
        const f = findAgent(id, { env, home });
        const e = { id, name: AGENTS[id].name, found: !!f, path: f?.path || null, startable: !!f?.cmd, version: null, signedIn: f ? signedIn(id, { env, home }) : 'no' };
        if (f?.cmd) e.version = await version(f);
        e._run = f?.cmd ? { cmd: f.cmd, pre: f.pre } : null;
        list.push(e);
      }
      detected = { t: now(), list };
      onChange();
      return list;
    })().finally(() => { detecting = null; });
    return detecting;
  }
  const publicAgent = ({ _run, ...a }) => a;

  const slim = (r) => ({
    id: r.id, agent: r.agent, name: AGENTS[r.agent]?.name || r.agent, from: r.from, folder: r.folder, mode: r.mode, task: r.task,
    startedAt: r.startedAt, endedAt: r.endedAt || null, state: r.state, ok: !!r.ok, summary: r.summary || '',
    changed: r.changed ? { modified: r.changed.modified.length, created: r.changed.created.length, deleted: r.changed.deleted.length } : null,
    undoId: r.undoId || null, undone: !!(r.undoId && snapshots?.find(r.undoId)?.undone),
  });
  function resultView(r) {
    const v = { id: r.id, agent: r.agent, state: r.state, ok: !!r.ok, from: r.from, folder: r.folder, mode: r.mode, seconds: r.endedAt ? Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000) : null };
    if (r.state === 'running') return { ...v, note: 'Still running. Ask again with action "status" or "result" (same id) in a minute.' };
    if (r.exitCode !== undefined) v.exitCode = r.exitCode;
    v.answer = r.text || '';
    if (r.error) v.error = r.error;
    v.changedFiles = r.changed ? { modified: capList(r.changed.modified), created: capList(r.changed.created), deleted: capList(r.changed.deleted) } : `not checked (${r.changedWhy || 'unknown'})`;
    v.undo = r.undoId ? (slim(r).undone ? 'already undone' : `bridgerator_undo id ${r.undoId} undoes every file change of this run`) : (r.undoWhy || 'no file changes to undo');
    if (r.notes?.length) v.notes = r.notes;
    return v;
  }
  const find = (id) => { const r = runs.find((x) => x.id === id); if (!r) fail('NO_RUN', `No delegated run ${id} on this PC.`, 'action "status" lists the recent ones.'); return r; };

  async function run(ctx, args) {
    const id = args.agent;
    if (!AGENT_IDS.includes(id)) fail('BAD_ARGS', `agent must be one of: ${AGENT_IDS.join(', ')}.`);
    const A = AGENTS[id];
    const task = str(args, 'task', { required: true, max: MAX_TASK }).trim();
    if (!task || /\u0000/.test(task)) fail('BAD_ARGS', 'task must be text.');
    const from = cleanName(args.from) || 'the AI';
    const waitS = int(args, 'wait_seconds', { min: 0, max: 240, def: 45 });
    if (args.mode !== undefined && !MODES.includes(args.mode)) fail('BAD_ARGS', `mode must be one of: ${MODES.join(', ')}.`);
    const L = limitsOf(ctx.cfg);
    if (!L[id]) fail('AGENT_OFF', `Delegation to ${A.name} is turned off on this PC.`, `Turn it on with bridgerator_settings set {delegate: {${id}: true}} if the person wants it (applies at once).`);
    if (ctx.policy && !ctx.policy.visible({ name: 'start_process' })) fail('TERMINAL_OFF', 'Running programs is off on this PC (access preset Read only or Files), so no agent can be started.', 'The person can switch to Full in Bridgerator → Safety.');
    // The folder: same rules as the file tools; it must not hold anything excluded (the agent works on the whole tree).
    // (guard tree: FOLDER_HAS_EXCLUDED when it contains an excluded / Bridgerator folder)
    const folder = guard(ctx, str(args, 'folder', { required: true, max: 1000 }), { tree: true });
    if (!isDir(folder)) fail('NO_FOLDER', `"${folder}" is not an existing folder.`, 'Give the full path of the folder the agent works in.');
    const nf = norm(realish(folder));
    const notes = [];
    let mode = args.mode || L.mode;
    if (MODES.indexOf(mode) > MODES.indexOf(L.mode)) { notes.push(`mode lowered to "${L.mode}" (the limit set on this PC)`); mode = L.mode; }
    const roInside = (ctx.cfg?.readOnlyDirectories || []).some((d) => norm(realish(d)).startsWith(nf + path.sep));
    if (mode !== 'read' && (ctx.policy?.writable(folder) || roInside)) { notes.push('mode "read": the folder is (or holds) a read-only folder'); mode = 'read'; }
    // Never this PC's key in the task; the text is checked like a terminal command (excluded folders, Bridgerator itself).
    for (const s of [ctx.cfg?.token, ctx.cfg?.installId]) if (typeof s === 'string' && s.length >= 8 && task.includes(s)) fail('SECRET_IN_TASK', 'The task contains this PC\'s Bridgerator key.', 'Leave it out: the agent does not need it.');
    const why = ctx.policy?.check('start_process', { command: task });
    if (why) fail('ACCESS_DENIED', why.replace(/^Access denied by Bridgerator: /, '').replace(/the command/, 'the task'), 'Change the task text.');
    const agent = (await detect()).find((x) => x.id === id);
    if (!agent?.found) fail('NOT_FOUND', `${A.name} is not installed on this PC (or Bridgerator did not find it).`, `Install it and sign in once in a terminal, then try again; action "agents" shows what was found.`);
    if (!agent._run) fail('CANT_START', `${A.name} was found (${agent.path}) but Bridgerator can't start it safely (not a standard npm or .exe install).`, 'Reinstall it with npm or its own installer.');
    if (agent.signedIn === 'no') notes.push(`${A.name} looks signed out on this PC — if it fails, the person signs in once in a terminal ("${A.bin}")`);
    const busy = () => {
      if (live.size >= L.parallel) fail('BUSY', `${live.size} delegated task${live.size === 1 ? ' is' : 's are'} already running (limit ${L.parallel}).`, 'Wait for one to finish (action "status"), cancel one, or ask the person to raise the limit.');
      // Two runs in the same or nested folders would mix their change lists and Undo.
      const near = runs.find((r) => r.state === 'running' && live.has(r.id) && r.folder && (() => { const o = norm(realish(r.folder)); return o === nf || o.startsWith(nf + path.sep) || nf.startsWith(o + path.sep); })());
      if (near) fail('FOLDER_BUSY', `Delegated run ${near.id} is already working in "${near.folder}", the same folder or one inside / around this one.`, 'Wait for it to finish (action "status"), or give this task another folder.');
    };
    busy();
    const stop = await ctx.gate?.gate?.('start_process', { command: `${A.bin} (task from ${from}) in ${folder}` });
    if (stop) return stop;
    busy();                                                            // another run may have started meanwhile
    const rid = `d${now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
    const rec = { id: rid, agent: id, from, folder, mode, task: task.slice(0, 300), startedAt: new Date(now()).toISOString(), state: 'running', ok: false };
    const entry = { child: null, canceled: false, timedOut: false };
    live.set(rid, entry);
    runs.unshift(rec); runs = runs.slice(0, MAX_RUNS); save(); onChange();

    let resolveDone, finished = false;
    entry.done = new Promise((r) => { resolveDone = r; });
    (async () => {
      // Undo: the folder as it is now (only when it fits the limits), later only what the agent changed.
      const before = scanTree(folder);
      let pend = null;
      if (!before) rec.changedWhy = 'the folder could not be read';
      else if (before.over) rec.changedWhy = `more than ${SCAN_FILES} files`;
      if (!snapshots || snapshots.enabled === false) rec.undoWhy = 'Undo is off on this PC (snapshots)';
      else if (L.undoMb === 0) rec.undoWhy = 'no copy for Undo (delegate.undoMb is 0)';
      else if (!before || before.over || before.files.size > SNAP_FILES || before.bytes > L.undoMb * MB) rec.undoWhy = `no copy for Undo: the folder is bigger than ${L.undoMb} MB / ${SNAP_FILES} files`;
      else {
        pend = await snapshots.capture('delegate', [...before.files.keys()].map((p) => ({ path: p })), { label: `${A.name}: ${task.slice(0, 120)}`, keepEmpty: true, maxMs: (L.timeoutMin + 5) * 60000 }).catch((e) => { log(`[bridgerator] delegate snapshot skipped: ${e.code || e.message}`); return null; });
        if (!pend) rec.undoWhy = 'Undo is off on this PC (snapshots)';
      }
      if (entry.canceled) { snapshots?.commit(pend, false); return finish(null, '', ''); }
      const argv = buildArgs(id, { prompt: promptFor({ task, folder, from }), folder, mode, denyDirs: denyDirsOf(ctx.cfg), mcpNames: id === 'codex' ? codexMcpNames({ env, home }) : [] });
      const out = [], err = [];
      let outBytes = 0, errBytes = 0;
      let child;
      try { child = startCli(agent._run, argv, { cwd: folder, env: childEnv(env, ctx.cfg?.token), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return finish(e, '', '', before, pend); }
      entry.child = child;
      const timer = setTimeout(() => { entry.timedOut = true; kill(child); }, L.timeoutMin * minuteMs);
      child.stdout.on('data', (b) => { out.push(b); outBytes += b.length; while (outBytes > STDOUT_CAP && out.length > 1) outBytes -= out.shift().length; });
      child.stderr.on('data', (b) => { err.push(b); errBytes += b.length; while (errBytes > STDERR_CAP && err.length > 1) errBytes -= err.shift().length; });
      let started = true;
      child.on('error', (e) => { started = false; clearTimeout(timer); finish(e, '', '', before, pend); });
      child.on('close', (code) => { clearTimeout(timer); if (started) finish(null, Buffer.concat(out).toString('utf8'), Buffer.concat(err).toString('utf8'), before, pend, code); });
    })().catch((e) => { log(`[bridgerator] delegate run ${rid} failed: ${e.code || e.message}`); finish(e, '', ''); });

    function finish(e, stdout, stderr, before = null, pend = null, code = null) {
      if (finished) return;
      finished = true;
      try {
        const token = ctx.cfg?.token;
        const p = e ? { text: '', error: `could not start: ${e.code || e.message}` } : parseOutput(id, stdout);
        const after = before && !before.over ? scanTree(folder) : null;
        const changes = before?.files && after?.files ? diffTrees(before.files, after.files) : null;
        if (!changes && before && !before.over) rec.changedWhy = 'the folder could not be read after the run';
        let kept = null;
        if (pend) { try { kept = snapshots.commit(pend, true, { changedOnly: true, added: changes ? changes.created : [] }); } catch (x) { log(`[bridgerator] delegate snapshot not kept: ${x.code || x.message}`); } }
        rec.state = entry.canceled ? 'cancelled' : entry.timedOut ? 'timeout' : !e && code === 0 && !p.error ? 'done' : 'failed';
        rec.ok = rec.state === 'done';
        if (code !== null) rec.exitCode = code;
        rec.text = cap(mask(p.text || '', token), limitsOf(ctx.cfg).maxOutputKb * 1024);
        const errText = p.error || (rec.state === 'failed' ? tail(stderr, 600) || `exit code ${code}` : rec.state === 'timeout' ? `stopped after ${L.timeoutMin} min (time limit)` : rec.state === 'cancelled' ? 'cancelled' : '');
        if (errText) rec.error = mask(errText, token).slice(0, 1000);
        rec.summary = (rec.ok ? rec.text : rec.error || rec.text).replace(/\s+/g, ' ').trim().slice(0, 300);
        if (changes) rec.changed = changes;
        if (kept) { rec.undoId = kept.id; delete rec.undoWhy; } else if (pend) rec.undoWhy = 'no file changes to undo';
        if (notes.length) rec.notes = notes;
        rec.endedAt = new Date(now()).toISOString();
      } catch (x) {
        rec.state = 'failed'; rec.ok = false; rec.error = `Bridgerator could not finish the run: ${x.code || x.message}`; rec.endedAt = new Date(now()).toISOString();
      }
      live.delete(rid); save(); onChange();
      if (rec.background) emit({ kind: 'delegate_done', ok: rec.ok ? 1 : 0 });
      resolveDone(rec);
    }
    entry.cancel = () => { entry.canceled = true; if (entry.child) kill(entry.child); };

    let t;
    const r = waitS > 0 ? await Promise.race([entry.done, new Promise((res) => { t = setTimeout(() => res(null), waitS * 1000); t.unref?.(); })]) : null;
    clearTimeout(t);
    if (r) return json(resultView(r));
    rec.background = true; save();
    return json({ id: rid, agent: id, state: 'running', ...(notes.length ? { notes } : {}), note: 'Still running in the background. Check it with action "status" (id) and read the answer with action "result". The person sees it on the Agents page of the Bridgerator window.' });
  }

  return {
    detect,
    agents: async (force) => (await detect(force)).map(publicAgent),
    run,
    get: (id) => find(String(id)),
    result: (id) => resultView(find(String(id))),
    status: (id) => (id ? slim(find(String(id))) : { running: runs.filter((r) => r.state === 'running').map(slim), recent: runs.slice(0, 10).map(slim) }),
    async cancel(id) {
      const r = find(String(id));
      const e = live.get(r.id);
      if (!e) fail('NOT_RUNNING', `Run ${r.id} is not running (${r.state}).`);
      e.cancel();
      await Promise.race([e.done, new Promise((res) => setTimeout(res, 10000).unref?.())]);
      return slim(r);
    },
    /** For the window (no process started here: detection runs in the background once). */
    view(cfg) {
      if (!detected && !detecting) detect().catch((e) => log(`[bridgerator] agent detection failed: ${e.message}`));
      const lim = limitsOf(cfg);
      return { checking: !detected, agents: (detected?.list || []).map((a) => ({ ...publicAgent(a), allowed: lim[a.id] })), limits: lim, running: live.size, runs: runs.map(slim) };
    },
    get running() { return live.size; },
    list: () => runs.map(slim),
    stop() { for (const e of live.values()) e.cancel(); },
  };
}

/** Bridgerator's own folders + the person's excluded ones: deny rules for agents that have them (Claude Code). */
export function denyDirsOf(cfg = {}) {
  return [...new Set([...ownDenied(), ...(cfg.protectSensitive === true ? sensitiveDenied() : []), ...(cfg.deniedDirectories || []), ...(cfg.configDir ? [cfg.configDir] : [])].filter((d) => typeof d === 'string' && /^[a-z]:[\\/]/i.test(d)))];
}

// ---- the tool ------------------------------------------------------------------------------------------------
const ACTIONS = ['agents', 'run', 'status', 'result', 'cancel'];
export const HANDOFF = 'The other way round (another AI hands work to ChatGPT): that AI, connected to Bridgerator, adds tasks with queue_add {title, details, from: "<its name>", resultPath: "<file for the result>"}; the person says "Work through my Bridgerator queue" in ChatGPT; ChatGPT writes each result to resultPath (or the note) and marks the task done; the first AI reads queue_list.';
export const DELEGATE_TOOL = {
  name: 'bridgerator_delegate',
  title: 'Delegate to another AI agent',
  description: 'Hands a task to another AI agent installed on this PC (Codex, Claude Code or Gemini CLI). It works in one folder with the person\'s own subscription and returns its answer and the files it changed. Actions: agents (what is installed and signed in, limits), run (agent, folder, task, from), status, result, cancel (id). Long runs continue in the background: check status, then result. All file changes of a run can be undone with bridgerator_undo. To hand a task to ChatGPT instead, use the task queue (queue_add with from and resultPath).',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ACTIONS },
      agent: { type: 'string', enum: AGENT_IDS },
      task: { type: 'string', maxLength: MAX_TASK, description: 'What the agent should do, in plain words, with everything it needs to know.' },
      folder: { type: 'string', maxLength: 1000, description: 'Full path of the folder it works in.' },
      from: { type: 'string', maxLength: 80, description: 'Who hands the task over, e.g. "ChatGPT" (shown to the person).' },
      mode: { type: 'string', enum: MODES, description: 'read, edit or full (default: the limit set on the PC, full unless changed).' },
      wait_seconds: { type: 'integer', minimum: 0, maximum: 240, description: 'Wait this long for the answer before the run continues in the background (default 45).' },
      id: { type: 'string', maxLength: 40, description: 'Run id (status, result, cancel).' },
      refresh: { type: 'boolean', description: 'agents: look again (after installing or signing in).' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};
export const defs = [DELEGATE_TOOL];

// One store per bridge (bridge.mjs attaches it; ctx.cfg is the same object for the bridge's lifetime).
const stores = new WeakMap();
export const attachDelegate = (cfg, store) => { stores.set(cfg, store); return store; };
export const delegateFor = (cfg) => stores.get(cfg) || null;

export async function handle(name, args, ctx) {
  const d = delegateFor(ctx.cfg);
  const action = needAction(args, ACTIONS);
  if (!d) fail('NOT_AVAILABLE', 'Delegation is not available on this PC.', 'Bridgerator needs to be installed with its settings folder.');
  const L = limitsOf(ctx.cfg);
  switch (action) {
    case 'agents': {
      const list = (await d.agents(args.refresh === true)).map((a) => ({ ...a, allowed: L[a.id], usable: a.found && a.startable && L[a.id] }));
      return json({ agents: list, limits: { mode: L.mode, parallel: L.parallel, timeoutMinutes: L.timeoutMin, maxAnswerKb: L.maxOutputKb, undoCopyMb: L.undoMb }, running: d.running, handoff: HANDOFF });
    }
    case 'run': return d.run(ctx, args);
    case 'status': return json(d.status(args.id === undefined ? undefined : str(args, 'id', { required: true, max: 40 })));
    case 'result': return json(d.result(str(args, 'id', { required: true, max: 40 })));
    case 'cancel': return json({ cancelled: await d.cancel(str(args, 'id', { required: true, max: 40 })) });
    default: return fail('BAD_ACTION', `action must be one of: ${ACTIONS.join(', ')}.`);
  }
}

/** Window requests (the person at the PC). Undo of a run = the window's undo.run with its undoId. */
export async function windowRpc(d, method, p = {}) {
  if (!d) throw new Error('delegation is not available');
  switch (method) {
    case 'delegate.detect': return (await d.agents(true));
    case 'delegate.get': { const r = d.get(String(p.id)); return { ...r, files: r.changed ? { modified: capList(r.changed.modified), created: capList(r.changed.created), deleted: capList(r.changed.deleted) } : null }; }
    case 'delegate.cancel': return d.cancel(String(p.id));
    default: throw new Error(`unknown request ${method}`);
  }
}
