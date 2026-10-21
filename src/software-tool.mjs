// LOGIC: see critical-logic/bridge.md ("Software (winget)"). Programs through the Windows Package
// Manager (winget, part of Windows 10/11 "App Installer"): search, installed list, available updates,
// install, upgrade. winget is started by its absolute path (a planted winget.exe on the PATH never
// runs), never through a shell, with --disable-interactivity; install / upgrade run --silent.
// Agreements are accepted ONLY when the call says accept_agreements: true (the AI asks the person
// first). Install / upgrade = confirmation category "install" (asks only when the person turned
// confirmations on) and are refused while the terminal is off (access presets Read only / Files).
// Tables are read by column positions from the dashes line under the header (any language), the
// result by winget's exit code (HRESULT), never by message text.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { stripOurs } from './ask.mjs';
import { WINGET } from './win.mjs';
import { ToolError, fail, json, needAction, str } from './tool-lib.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/;          // winget ids: Vendor.App, 9NBLGGH4NNS1 (Store)
const SOURCES = ['winget', 'msstore'];
const MAX_ROWS = 200;

// winget runs in the background, so Windows often shows its administrator prompt only as a flashing
// taskbar button (a background program can't bring it to the front): the person must be told to look.
export const UAC_NOTE = 'Windows may show its administrator prompt only as a flashing button in the taskbar — ask the person to click it and choose Yes.';
// HRESULT exit codes (winget returnCodes.md) → plain words + what to do.
const CODES = {
  0x8A150014: ['No program matches.', 'Search with other words (action "search").'],
  0x8A150016: ['Several programs match.', 'Use the exact id from action "search".'],
  0x8A150010: ['No installer of this program fits this PC.', ''],
  0x8A150011: ['The downloaded installer does not match its published checksum, so it was not run.', 'Try again later.'],
  0x8A150008: ['The download failed.', 'Check the internet connection and try again.'],
  0x8A150019: ['This needs administrator rights.', 'Ask the person to run it from an administrator terminal.'],
  0x8A15002B: ['No update is available for it.', ''],
  0x8A15002C: ['Some updates failed.', 'Check the list with action "updates" and update them one by one.'],
  0x8A15003A: ['A company policy blocks winget on this PC.', 'Ask the PC administrator.'],
  0x8A150041: ['The program\'s license terms were not accepted.', 'Ask the person; if they agree, call again with accept_agreements: true.'],
  0x8A150046: ['The program source\'s terms were not accepted yet.', 'Ask the person; if they agree, call again with accept_agreements: true.'],
  0x8A15004F: ['The available version is not newer than the installed one.', ''],
  0x8A150101: ['The program is running.', 'Close it and try again.'],
  0x8A150102: ['Another installation is in progress.', 'Try again in a few minutes.'],
  0x8A150103: ['A file of the program is in use.', 'Close the program and try again.'],
  0x8A150105: ['The disk is full.', 'Free some space and try again.'],
  0x8A150107: ['The installer needs the internet.', 'Check the connection.'],
  0x8A150109: ['Installed — restart the PC to finish.', ''],
  0x8A15010A: ['Installation failed: restart the PC, then try again.', ''],
  0x8A15010B: ['The PC will restart to finish the installation.', ''],
  0x8A15010C: ['The installation was cancelled (for example "No" in the Windows administrator prompt).', `Ask the person to allow it when Windows asks. ${UAC_NOTE}`],
  0x8A15010D: ['It is already installed.', 'Use action "upgrade" to update it.'],
  0x8A15010E: ['A newer version is already installed.', ''],
  // Seen on a lab PC after "No" in the administrator prompt (installer exit 1625): said as not approved.
  0x8A15010F: ['The installation was cancelled or not approved (for example "No" in the Windows administrator prompt, or a policy of this PC).', `Ask the person to try again and allow it when Windows asks. ${UAC_NOTE}`],
  0x8A150113: ['This program does not support this Windows version.', ''],
  0x8A150115: ['The program\'s installer reported an error.', 'Try again, or install it from the vendor\'s site.'],
};
const OK_CODES = new Set([0, 0x8A150109]);

/** Runs winget (win.WINGET) → { code (unsigned HRESULT), out }. ctx.runWinget (tests) replaces it. */
// winget.exe in WindowsApps is an App Execution Alias: stat() fails (EACCES) so fs.existsSync says false; lstat sees it.
export const aliasExists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
export function runWinget(args, { timeout = 120000, exists = aliasExists } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new ToolError('NOT_WINDOWS', 'This works only on Windows.'));
  if (!exists(WINGET)) return Promise.reject(new ToolError('NO_WINGET', 'winget (Windows Package Manager) is not available on this PC.', 'It comes with "App Installer" from the Microsoft Store; Windows 10 1809+ and Windows 11 have it after updates.'));
  return new Promise((resolve, reject) => {
    const child = spawn(WINGET, args, { windowsHide: true, env: stripOurs(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(new ToolError('TIMEOUT', 'winget did not finish in time.', `An installer may be waiting for an answer on the PC screen; ask the person to look. ${UAC_NOTE}`)); }, timeout);
    const take = (b) => { size += b.length; if (size < 8 * 1024 * 1024) chunks.push(b); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => { clearTimeout(timer); reject(new ToolError('NO_WINGET', `winget did not start (${e.code || e.message}).`, 'Update "App Installer" from the Microsoft Store.')); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code >>> 0, out: Buffer.concat(chunks).toString('utf8') }); });
  });
}

/** Output lines without progress spinners / bars (text after the last bare \r of a line). */
export function cleanLines(out, { blank = false } = {}) {
  return String(out).replace(/\r\n/g, '\n').split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1).replace(/[▀-▟]+/g, '').replace(/\s+$/, ''))
    .filter((l) => (blank && !l) || (l && !/^\s*[-\\|/]\s*$/.test(l)));
}

/**
 * The first table of winget output → rows of cells. Columns start where the header words start;
 * the dashes line marks the header. Header labels are localized and only give positions.
 * → { cols: number, rows: [[cell…]] }
 */
export function parseTable(out) {
  const lines = cleanLines(out, { blank: true });
  const dash = lines.findIndex((l) => /^-{10,}$/.test(l.trim()));
  if (dash < 1) return { cols: 0, rows: [] };
  const header = lines[dash - 1];
  const starts = [];
  for (const m of header.matchAll(/\S+/g)) starts.push(m.index);
  const rows = [];
  for (let i = dash + 1; i < lines.length && rows.length < MAX_ROWS; i++) {
    const l = lines[i];
    // The table ends at a blank line, a dashes line, or the header of a second table (its dashes follow).
    if (!l.trim() || /^-{10,}$/.test(l.trim()) || /^-{10,}$/.test((lines[i + 1] || '').trim())) break;
    rows.push(starts.map((s, j) => l.slice(s, starts[j + 1] ?? undefined).trim()));
  }
  return { cols: starts.length, rows };
}

// Column order is fixed by winget: search Name Id Version [Match] Source; list Name Id Version
// [Available] Source; upgrade Name Id Version Available Source.
function rowsOf(kind, { cols, rows }) {
  return rows.map((r) => {
    const o = { name: r[0], id: r[1], version: r[2] };
    if (cols >= 5) { if (kind === 'search') { if (r[3]) o.match = r[3]; } else if (r[3]) o.available = r[3]; o.source = r[4] || undefined; }
    else if (cols === 4) { if (kind === 'updates') o.available = r[3]; else o.source = r[3] || undefined; }
    return o;
  }).filter((o) => /^\S+$/.test(o.id || '') && o.version);            // footer lines ("2 upgrades available.") have no id
}

function explain(code, out) {
  if (OK_CODES.has(code)) return null;
  const known = CODES[code];
  const hex = `0x${code.toString(16).toUpperCase()}`;
  const tail = cleanLines(out).filter((l) => !/^-{3,}/.test(l)).slice(-3).join(' | ').slice(0, 300);
  return known ? new ToolError(`WINGET_${hex}`, known[0], known[1]) : new ToolError(`WINGET_${hex}`, `winget stopped with code ${hex}.${tail ? ` Last output: ${tail}` : ''}`, 'Try again; if it repeats, the person can run the same winget command in a terminal to see more.');
}

const base = (args) => ['--disable-interactivity', ...(args.accept_agreements === true ? ['--accept-source-agreements'] : [])];
const sourceArg = (args) => { const s = str(args, 'source', { max: 20 }); if (s && !SOURCES.includes(s)) fail('BAD_ARGS', `source must be ${SOURCES.join(' or ')}.`); return s ? ['--source', s] : []; };
const idArg = (args, required) => {
  const id = str(args, 'id', { required, max: 128 });
  if (id && !ID_RE.test(id)) fail('BAD_ARGS', 'id must be a winget package id like "7zip.7zip" (from action "search").');
  return id;
};

export const defs = [{
  name: 'software',
  title: 'Programs (winget)',
  description: 'Programs on this PC through the Windows Package Manager (winget). search: find programs by name; list: installed programs; updates: programs with a newer version; install / upgrade: install or update one program by its id (silent; upgrade with all: true updates everything). Windows may still show its administrator prompt on the PC for some installers (often only as a flashing taskbar button). Program and source license terms are accepted only with accept_agreements: true, after the person agreed.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['search', 'list', 'updates', 'install', 'upgrade'] },
      query: { type: 'string', maxLength: 100, description: 'search / list: words to look for' },
      id: { type: 'string', maxLength: 128, description: 'install / upgrade: exact package id, e.g. "7zip.7zip"' },
      all: { type: 'boolean', description: 'upgrade: update every program that has an update' },
      version: { type: 'string', maxLength: 40, description: 'install: a specific version' },
      scope: { type: 'string', enum: ['user', 'machine'], description: 'install: for this user only, or for all users (needs administrator rights)' },
      source: { type: 'string', enum: SOURCES },
      accept_agreements: { type: 'boolean', description: 'Accept the program\'s and the source\'s license terms (only after the person agreed). Default false.' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
}];

export async function handle(name, args, ctx) {
  const action = needAction(args, defs[0].inputSchema.properties.action.enum);
  const run = ctx.runWinget || runWinget;
  if (action === 'search' || action === 'list' || action === 'updates') {
    const q = str(args, 'query', { required: action === 'search', max: 100 });
    if (q && /[\u0000-\u001f"]/.test(q)) fail('BAD_ARGS', 'query must be plain text.');
    const argv = action === 'search' ? ['search', '--query', q, '--count', '50']
      : action === 'list' ? ['list', ...(q ? ['--query', q] : [])]
        : ['upgrade'];
    const r = await run([...argv, ...sourceArg(args), ...base(args)], { timeout: 120000 });
    if (r.code === 0x8A150014) return json({ action, found: 0, programs: [] });
    const err = explain(r.code, r.out);
    if (err) throw err;
    const programs = rowsOf(action, parseTable(r.out));
    return json({ action, found: programs.length, programs, ...(programs.length >= MAX_ROWS ? { note: `first ${MAX_ROWS} shown` } : {}) });
  }
  // install / upgrade: like a terminal command — off with the terminal; asks when confirmations are on.
  if ((ctx.cfg?.disabledTools || []).includes('start_process')) fail('TERMINAL_OFF', 'Installing programs is off on this PC (access preset Read only or Files).', 'The person can switch to Full in Bridgerator → Safety, or you can ask with bridgerator_settings.');
  const id = idArg(args, !(action === 'upgrade' && args.all === true));
  if (action === 'upgrade' && args.all === true && id) fail('BAD_ARGS', 'Give either id or all: true, not both.');
  const version = str(args, 'version', { max: 40 });
  if (version && !/^[A-Za-z0-9.+_-]+$/.test(version)) fail('BAD_ARGS', 'version must look like 1.2.3.');
  // Fails closed: without the confirmation gate nothing is installed.
  if (typeof ctx.gate?.gate !== 'function') fail('NO_GATE', 'Installing programs is not available here.');
  const stop = await ctx.gate.gate('software', { ...args, action });
  if (stop) return stop;
  const argv = [action, ...(id ? ['--id', id, '--exact'] : ['--all']),
    ...(version && action === 'install' ? ['--version', version] : []),
    ...(args.scope && action === 'install' ? ['--scope', args.scope === 'machine' ? 'machine' : 'user'] : []),
    '--silent', ...sourceArg(args), ...base(args), ...(args.accept_agreements === true ? ['--accept-package-agreements'] : [])];
  ctx.log?.(`[bridgerator] software ${action} ${id || '--all'}`);
  const r = await run(argv, { timeout: 30 * 60000 });
  const err = explain(r.code, r.out);
  if (err) throw err;
  return json({ action, id: id || 'all', done: true, ...(r.code === 0x8A150109 ? { restartNeeded: true } : {}), output: cleanLines(r.out).filter((l) => !/^-{3,}/.test(l)).slice(-6) });
}
