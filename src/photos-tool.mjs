// LOGIC: see critical-logic/bridge.md ("Extra tools" / photos). Photo details (EXIF), smaller / converted
// copies and renaming by the date taken — with the imaging built into Windows (photos.ps1, WIC).
// Never overwrites: a converted photo is always a NEW file; renaming goes through the engine's
// move_file (ctx.engine), so the folder rules, confirmations and snapshots / Undo apply as for any move.
// GPS position is returned only when the call asks for it (gps: true).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { psJson, guard, visiblePath, fail, json, needAction, str, int, freeName } from './tool-lib.mjs';

const PS = fileURLToPath(new URL('./photos.ps1', import.meta.url));
const ACTIONS = ['info', 'convert', 'rename_by_date'];
export const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.jpe', '.png', '.tif', '.tiff', '.heic', '.heif', '.bmp', '.gif', '.webp', '.jxr', '.wdp']);
const MAX_FILES = 500, MAX_DEPTH = 6, MAX_DIRS = 2000;   // folders visited: a huge tree must not freeze the bridge

export const defs = [{
  name: 'photos',
  title: 'Photos',
  description: 'Photos on this PC. action "info": date taken, camera, size, orientation (GPS position only with gps: true); "convert": smaller or converted copies (max_size, quality, format jpg/png) saved as new files, originals untouched; "rename_by_date": names like "2026-07-14 10.22.33.jpg" from the date taken — a preview by default, dry_run: false renames (undoable). path = a photo or a folder.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action', 'path'],
    properties: {
      action: { type: 'string', enum: ACTIONS },
      path: { type: 'string', description: 'A photo or a folder (full path)' },
      recursive: { type: 'boolean', description: 'Include subfolders' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_FILES, description: 'At most this many photos (default 200)' },
      gps: { type: 'boolean', description: 'info: include the GPS position' },
      max_size: { type: 'integer', minimum: 16, maximum: 20000, description: 'convert: longest side in pixels (default 1920)' },
      quality: { type: 'integer', minimum: 1, maximum: 100, description: 'convert: JPEG quality (default 85)' },
      format: { type: 'string', enum: ['jpg', 'png'], description: 'convert: default jpg' },
      output: { type: 'string', description: 'convert: folder (or file for one photo) for the new copies; default: next to each photo as "name (small).jpg"' },
      dry_run: { type: 'boolean', description: 'rename_by_date: true (default) only shows the plan' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}];

const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64');
const isImage = (p) => IMAGE_EXT.has(path.extname(p).toLowerCase());

/** The photos at `p` (a file or a folder), each under the folder rules; → { files, truncated, hidden }. */
export function listPhotos(ctx, p, { recursive = false, limit = 200 } = {}) {
  const root = guard(ctx, p);
  let st;
  try { st = fs.statSync(root); } catch { fail('NOT_FOUND', `"${root}" was not found.`, 'Check the path.'); }
  if (st.isFile()) { if (!isImage(root)) fail('NOT_PHOTO', `"${path.basename(root)}" is not a photo this tool reads (${[...IMAGE_EXT].join(' ')}).`); return { files: [root], truncated: false, hidden: 0 }; }
  const files = [];
  let hidden = 0, truncated = false;
  const stack = [[root, 0]];
  let dirs = 0;
  while (stack.length && !truncated) {
    if (++dirs > MAX_DIRS) { truncated = true; break; }
    const [dir, depth] = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const subdirs = [];
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (recursive && depth < MAX_DEPTH) subdirs.push(full); continue; }
      if (!e.isFile() || !isImage(full)) continue;
      if (!visiblePath(ctx, full)) { hidden++; continue; }
      if (files.length >= limit) { truncated = true; break; }
      files.push(full);
    }
    for (const d of subdirs.reverse()) stack.push([d, depth + 1]);
  }
  return { files, truncated, hidden };
}

const runPs = (ctx, mode, req, n, per) => psJson(ctx, { files: [PS], env: { BRX_MODE: mode }, input: b64(req), timeout: 30000 + n * per });

/** "2026:07:14 10:22:33" → { iso: '2026-07-14 10:22:33', name: '2026-07-14 10.22.33' } or null. */
export function takenOf(s) {
  const m = /^(\d{4})[:-](\d{2})[:-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || '').trim());
  if (!m || m[1] === '0000' || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31 || +m[4] > 23 || +m[5] > 59 || +m[6] > 59) return null;
  return { iso: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`, name: `${m[1]}-${m[2]}-${m[3]} ${m[4]}.${m[5]}.${m[6]}` };
}
const ERR = { NO_CODEC: 'Windows has no decoder for this format (for HEIC: install "HEIF Image Extensions" from the Microsoft Store)', DECODE_FAILED: 'not a readable image', NOT_FOUND: 'file not found', NO_ACCESS: 'Windows denied access', IO: 'the file is in use or unreadable', EXISTS: 'a file with the new name already exists' };
const why = (code) => ERR[code] || String(code || 'unknown problem');

async function info(ctx, files, gps) {
  const r = await runPs(ctx, 'info', { files, gps }, files.length, 1000);
  return (r.items || []).map((x) => {
    if (x.error) return { path: x.path, problem: why(x.error) };
    const t = takenOf(x.taken);
    const camera = [x.make, x.model].filter(Boolean).join(' ').replace(/^(\S+) \1 /i, '$1 ');
    return {
      path: x.path, ...(t ? { taken: t.iso } : {}), ...(camera ? { camera } : {}), width: x.width, height: x.height,
      ...(x.orientation && x.orientation !== 1 ? { orientation: x.orientation } : {}), ...(x.format ? { format: x.format } : {}),
      // GPS: only when asked for (also enforced here, whatever the script returned).
      ...(gps && x.gps ? { gps: x.gps } : x.hasGps ? { location: 'stored in the photo (not shown; ask with gps: true)' } : {}),
    };
  });
}

function convertPlan(ctx, files, { output, format }) {
  const ext = format === 'png' ? '.png' : '.jpg';
  let outDir = null, outFile = null;
  if (output !== undefined) {
    const o = guard(ctx, output, { write: true });
    const isDir = (() => { try { return fs.statSync(o).isDirectory(); } catch { return false; } })();
    if (isDir || /[\\/]$/.test(output) || files.length > 1 || !path.extname(o)) outDir = o;
    else outFile = o;
    if (outDir && !fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  }
  const taken = new Set();
  const free = (p) => { let c = freeName(p); const { dir, name, ext: e } = path.parse(p); for (let i = 2; taken.has(c.toLowerCase()); i++) c = freeName(path.join(dir, `${name} (${i})${e}`)); taken.add(c.toLowerCase()); return c; };
  return files.map((src) => {
    const base = path.parse(src).name;
    const dst = outFile ? outFile : outDir ? path.join(outDir, `${base}${ext}`) : path.join(path.dirname(src), `${base} (small)${ext}`);
    return { src, dst: free(guard(ctx, dst, { write: true })) };
  });
}

function renamePlan(ctx, infos) {
  const taken = new Set();
  const plan = [], skipped = [];
  for (const x of infos) {
    if (x.problem) { skipped.push({ path: x.path, reason: x.problem }); continue; }
    const t = takenOf(x.taken ? x.taken.replace(/^(\d{4})-(\d{2})-(\d{2})/, '$1:$2:$3') : '');
    if (!t) { skipped.push({ path: x.path, reason: 'no date taken in the photo' }); continue; }
    const { dir, name, ext } = path.parse(x.path);
    if (name === t.name || new RegExp(`^${t.name.replace(/\./g, '\\.')} \\(\\d+\\)$`).test(name)) { skipped.push({ path: x.path, reason: 'already named by date' }); continue; }
    try { guard(ctx, x.path, { write: true }); } catch (e) { skipped.push({ path: x.path, reason: e.message }); continue; }
    let to = path.join(dir, `${t.name}${ext}`);
    for (let i = 2; fs.existsSync(to) || taken.has(to.toLowerCase()); i++) to = path.join(dir, `${t.name} (${i})${ext}`);
    taken.add(to.toLowerCase());
    plan.push({ from: x.path, to });
  }
  return { plan, skipped };
}

const textOf = (r) => (r?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join(' ').slice(0, 300);

export async function handle(name, args, ctx) {
  const action = needAction(args, ACTIONS);
  const p = str(args, 'path', { required: true, max: 1000 });
  const limit = int(args, 'limit', { min: 1, max: MAX_FILES, def: 200 });
  const { files, truncated, hidden } = listPhotos(ctx, p, { recursive: args.recursive === true, limit });
  const extra = { ...(truncated ? { truncated: `only the first ${limit} photos` } : {}), ...(hidden ? { hidden: `${hidden} photo(s) hidden by this PC's folder rules` } : {}) };
  if (!files.length) return json({ count: 0, note: 'No photos found here.', ...extra });

  if (action === 'info') {
    const items = await info(ctx, files, args.gps === true);
    return json({ count: items.length, photos: items, ...extra });
  }

  if (action === 'convert') {
    const format = args.format === undefined ? 'jpg' : args.format;
    if (!['jpg', 'png'].includes(format)) fail('BAD_ARGS', 'format must be jpg or png.');
    // max_size (snake_case like dry_run); the older spelling maxSize is still read.
    const maxSize = int(args, args.max_size !== undefined ? 'max_size' : 'maxSize', { min: 16, max: 20000, def: 1920 });
    const quality = int(args, 'quality', { min: 1, max: 100, def: 85 });
    const output = str(args, 'output', { max: 1000 });
    // Copies made earlier ("name (small).jpg") are not converted again.
    const fresh = files.length > 1 ? files.filter((f) => !/ \(small\)( \(\d+\))?$/i.test(path.parse(f).name)) : files;
    if (!fresh.length) return json({ converted: 0, note: 'Only copies made earlier ("… (small)") are here.', ...extra });
    const items = convertPlan(ctx, fresh, { output, format });
    const r = await runPs(ctx, 'convert', { items, maxSize, quality, format }, items.length, 3000);
    const done = [], failed = [];
    for (const x of r.items || []) {
      if (x.ok) done.push({ from: x.src, saved: x.dst, width: x.width, height: x.height, bytes: x.bytes });
      else failed.push({ path: x.src, problem: why(x.error) });
    }
    return json({ converted: done.length, files: done, ...(failed.length ? { failed } : {}), note: 'Originals were not changed. The new files carry no metadata (no GPS); photos are turned upright.', ...extra });
  }

  // rename_by_date
  const infos = await info(ctx, files, false);
  const { plan, skipped } = renamePlan(ctx, infos);
  if (args.dry_run !== false) return json({ preview: true, rename: plan, ...(skipped.length ? { skipped } : {}), note: plan.length ? 'Nothing renamed yet. Call again with dry_run: false to rename.' : 'Nothing to rename.', ...extra });
  if (!ctx.engine) fail('NO_ENGINE', 'Renaming is not available here.');
  const renamed = [], failed = [];
  for (const it of plan) {
    // The plan was made before the awaits: a file may have appeared under the chosen name meanwhile.
    if (fs.existsSync(it.to)) {
      const { dir, ext } = path.parse(it.to), stem = path.parse(it.to).name.replace(/ \(\d+\)$/, '');
      let i = 2;
      while (fs.existsSync(path.join(dir, `${stem} (${i})${ext}`)) || plan.some((o) => o !== it && o.to.toLowerCase() === path.join(dir, `${stem} (${i})${ext}`).toLowerCase())) i++;
      it.to = path.join(dir, `${stem} (${i})${ext}`);
    }
    const r = await ctx.engine('move_file', { source: it.from, destination: it.to });
    if (r?.isError) { failed.push({ path: it.from, problem: textOf(r) || 'not renamed' }); if (r.notConfirmed || r.paused) break; } else renamed.push(it);
  }
  return json({ renamed: renamed.length, files: renamed, ...(failed.length ? { failed } : {}), ...(skipped.length ? { skipped } : {}), ...(renamed.length ? { undo: 'Renames can be undone with bridgerator_undo.' } : {}), ...extra });
}
