// LOGIC: see critical-logic/bridge.md ("Extra tools" / fast_search). Instant search: Everything (if
// installed and running) → the Windows Search index (SystemIndex over OLE DB) → the engine's own
// search (start_search, already under the policy). Every hit goes through the same folder rules as the
// file tools (visiblePath): excluded folders and folders outside the allowed list never show up.
// Queries are built here (escaped); search.ps1 only runs them.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { psJson, guard, visiblePath, fail, json, needAction, str, int, ToolError, errorText } from './tool-lib.mjs';

const PS = fileURLToPath(new URL('./search.ps1', import.meta.url));
const ACTIONS = ['files', 'text', 'status'];
const MAX = 500;
const POLL_MS = 400, BASIC_WAIT_MS = 20000;

export const defs = [{
  name: 'fast_search',
  title: 'Fast search',
  description: 'Fast file search on this PC. action "files": names or masks like *.pdf; "text": words inside documents (Windows Search index); "status": which search sources this PC has. Uses Everything when it is installed, then the Windows Search index, then a plain folder scan. Results follow the folder rules of this PC.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ACTIONS },
      query: { type: 'string', maxLength: 300, description: 'Name, mask (* ?) or words' },
      folder: { type: 'string', description: 'Search only inside this folder (full path)' },
      kind: { type: 'string', maxLength: 12, description: 'File extension, e.g. pdf or .docx' },
      limit: { type: 'integer', minimum: 1, maximum: MAX, description: 'Default 100' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}];

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const sq = (s) => String(s).replace(/'/g, "''");                         // SQL string literal
const ctl = (s) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
export function extOf(kind) {
  if (kind === undefined) return undefined;
  const k = String(kind).trim().replace(/^\*?\./, '');
  if (!/^[\p{L}\p{N}_-]{1,10}$/u.test(k)) fail('BAD_ARGS', 'kind must be a file extension like pdf or .docx.');
  return k.toLowerCase();
}
/** Name / mask → LIKE pattern: LIKE's own specials are literal, * ? are the wildcards. */
export function likePattern(q) {
  const lit = ctl(q).replace(/[[%_]/g, (c) => `[${c}]`);
  const w = lit.replace(/\*/g, '%').replace(/\?/g, '_');
  return /[*?]/.test(q) ? w : `%${w}%`;
}
const scopeUrl = (d) => `file:${d.replace(/\\/g, '/')}`;
/** The SystemIndex query for files / text, scoped to folders (none = whole index). */
export function indexSql({ action, query, folders = [], ext, limit }) {
  const where = [];
  if (folders.length) where.push(`(${folders.map((d) => `SCOPE='${sq(scopeUrl(d))}'`).join(' OR ')})`);
  if (action === 'text') { where.push(`FREETEXT('${sq(ctl(query))}')`); where.push("System.ItemType <> 'Directory'"); }
  else if (query) where.push(`System.FileName LIKE '${sq(likePattern(query))}'`);
  if (ext) where.push(`System.FileExtension = '.${sq(ext)}'`);
  return `SELECT TOP ${limit} System.ItemUrl, System.Size, System.DateModified FROM SystemIndex${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY System.DateModified DESC`;
}
export const coverSql = (folder) => `SELECT TOP 1 System.ItemUrl FROM SystemIndex WHERE SCOPE='${sq(scopeUrl(folder))}'`;
/** es.exe arguments: words only — nothing that starts like an option (-export-…, /a) reaches it. Every
 * double quote goes first (a quoted "-export-txt" or a"b must never turn into a switch), then a leading - or /. */
export function esArgs({ query, folder, ext, limit }) {
  const words = ctl(query || '').replace(/["\u201c\u201d]/g, '').split(/\s+/).map((w) => w.replace(/^[-/]+/, '')).filter(Boolean);
  return ['-n', String(limit), ...(folder ? ['-path', folder] : []), ...(ext ? [`ext:${ext}`] : []), ...words];
}
export const urlToPath = (u) => String(u).replace(/^file:/i, '').replace(/\//g, '\\');

const run = (ctx, env, timeout = 30000) => psJson(ctx, { files: [PS], env, timeout });
async function status(ctx, folder) {
  return run(ctx, { BRX_MODE: 'status', ...(folder ? { BRX_SCOPE_SQL: b64(coverSql(folder)) } : {}) }, 20000);
}

function keep(ctx, items, limit) {
  const out = [];
  let hidden = 0;
  for (const it of items) {
    if (!it?.path || typeof it.path !== 'string') continue;
    if (!visiblePath(ctx, it.path)) { hidden++; continue; }
    out.push({ path: it.path, ...(Number.isFinite(it.size) ? { size: it.size } : {}), ...(it.modified ? { modified: it.modified } : {}), ...(it.dir ? { folder: true } : {}) });
    if (out.length >= limit) break;
  }
  return { items: out, hidden };
}

// The engine's own search: "📁 path" (files) / "📄 path:line - text" (content) lines.
export function parseBasic(text) {
  const items = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    let m = /^📁 (.+)$/u.exec(line);
    if (m) { items.push({ path: m[1].trim() }); continue; }
    m = /^📄 (.+?):(\d+) - (.*)$/u.exec(line);
    if (m && !items.some((x) => x.path === m[1])) items.push({ path: m[1], line: Number(m[2]), match: m[3].slice(0, 200) });
  }
  return items;
}
const textOf = (r) => (r?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n');
async function basic(ctx, { action, query, folder, ext, limit }, wait = BASIC_WAIT_MS) {
  if (!ctx.engine) throw new ToolError('NO_BASIC', 'The plain folder search is not available here.');
  const root = folder || ctx.cfg?.allowedDirectories?.[0] || process.env.USERPROFILE;
  if (!root) throw new ToolError('NO_FOLDER', 'Say which folder to search.', 'Pass folder.');
  // Names: the engine takes masks (* ?) as globs and plain text as "contains"; content: literal text.
  const started = await ctx.engine('start_search', { path: root, pattern: query, searchType: action === 'text' ? 'content' : 'files', ...(ext ? { filePattern: `*.${ext}` } : {}), maxResults: limit, literalSearch: true });
  const t0 = textOf(started);
  if (started?.isError) throw new ToolError('BASIC_FAILED', t0.slice(0, 300) || 'The folder search did not start.');
  const id = /session:\s*(\S+)/i.exec(t0)?.[1];
  if (!id) return parseBasic(t0);
  let all = [], done = /COMPLETED/.test(t0);
  const until = Date.now() + wait;
  try {
    for (;;) {
      const r = await ctx.engine('get_more_search_results', { sessionId: id, offset: 0, length: limit });
      const t = textOf(r);
      all = parseBasic(t);
      done = /Status:\s*COMPLETED/i.test(t);
      if (done || r?.isError || Date.now() > until) break;
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
  } finally {
    // Also when a poll throws (engine timeout / restart): the search must not keep running.
    if (!done) await Promise.resolve().then(() => ctx.engine('stop_search', { sessionId: id })).catch(() => null);
  }
  return all;
}

export async function handle(name, args, ctx) {
  const action = needAction(args, ACTIONS);
  const folder = args.folder !== undefined ? guard(ctx, str(args, 'folder', { max: 1000 })) : undefined;
  if (action === 'status') {
    const s = await status(ctx, folder);
    return json({
      everything: s.everything?.path ? (s.everything.running ? 'ready' : 'installed, not running') : s.everything?.untrusted ? 'not used (es.exe is outside Program Files and not signed by voidtools)' : 'not installed',
      windows_index: s.index?.service === 'Running' ? 'ready' : `not available (service ${String(s.index?.service || 'unknown')})`,
      ...(folder ? { folder, folder_indexed: s.index?.covered === true ? 'yes' : s.index?.covered === false ? 'no (not in the index — the plain scan is used)' : 'unknown' } : {}),
      plain_scan: 'always available',
    });
  }
  const query = str(args, 'query', { required: true, max: 300 });
  const limit = int(args, 'limit', { min: 1, max: MAX, def: 100 });
  const ext = extOf(args.kind);
  const allowed = ctx.cfg?.allowedDirectories || [];
  const folders = folder ? [folder] : allowed.map((d) => path.resolve(d));
  const want = Math.min(MAX, limit * 2);       // room for hits the folder rules hide
  const tried = [];
  let firstError = null;
  const note = (src, e) => { tried.push(`${src}: ${e instanceof ToolError ? e.code : e?.code || 'error'}`); firstError ||= e; };
  // null = every hit was hidden by the folder rules → the next source is tried.
  const answer = (source, items, extra = {}) => {
    const k = keep(ctx, items, limit);
    if (!k.items.length && k.hidden) { tried.push(`${source}: ${k.hidden} result(s) hidden by this PC's folder rules`); return null; }
    return json({ source, count: k.items.length, results: k.items, ...(k.hidden ? { hidden: `${k.hidden} result(s) hidden by this PC's folder rules` } : {}), ...(tried.length ? { skipped_sources: tried } : {}), ...extra });
  };

  let st = null;
  try { st = await status(ctx, folder); } catch (e) { note('status', e); }

  if (action === 'files' && st?.everything?.path && st.everything.running) {
    try {
      // Scoped like the index: the folder, or the one allowed folder (several: hits are filtered below).
      const esFolder = folder || (folders.length === 1 ? folders[0] : undefined);
      const r = await run(ctx, { BRX_MODE: 'everything', BRX_ES: st.everything.path, BRX_ARGS: b64(JSON.stringify(esArgs({ query, folder: esFolder, ext, limit: want }))) });
      if (r.error) throw new ToolError(r.error, r.error === 'ES_START_FAILED' ? 'Everything\'s es.exe could not start (an antivirus may block it).' : 'Everything did not answer.');
      const a = r.items?.length ? answer('everything', r.items) : null;
      if (a) return a;
      if (!r.items?.length) tried.push('everything: nothing found');
    } catch (e) { note('everything', e); }
  } else if (action === 'files') tried.push(`everything: ${st?.everything?.path ? 'not running' : 'not installed'}`);

  let indexNote;
  if (st?.index?.service === 'Running') {
    try {
      const r = await run(ctx, { BRX_MODE: 'index', BRX_SQL: b64(indexSql({ action, query, folders, ext, limit: want })) });
      if (r.error) throw new ToolError(r.error, 'The Windows Search index did not answer.');
      const items = (r.items || []).map((x) => ({ ...x, path: urlToPath(x.url) }));
      const a = items.length ? answer('windows_index', items, folder && st.index.covered === false ? { note: 'This folder is not in the Windows Search index; results may be incomplete.' } : {}) : null;
      if (a) return a;
      if (!items.length) {
        indexNote = folder && st.index.covered === false ? 'This folder is not in the Windows Search index' : 'Nothing found in the Windows Search index';
        tried.push(`windows_index: ${indexNote.toLowerCase()}`);
      }
    } catch (e) { note('windows_index', e); }
  } else tried.push(`windows_index: service ${String(st?.index?.service || 'unknown')}`);

  try {
    const items = await basic(ctx, { action, query, folder, ext, limit: want });
    return answer('basic', items, { note: `Plain folder scan${indexNote ? ` (${indexNote.toLowerCase()})` : ''}.` })
      || json({ source: 'basic', count: 0, results: [], skipped_sources: tried });
  } catch (e) {
    note('basic', e);
    throw new ToolError('SEARCH_FAILED', `Search did not work: ${errorText(firstError).replace(/\s*\(code [A-Z_0-9]+\)$/, '')}`, 'Pass a folder, or check the PC with bridgerator_doctor.');
  }
}
