// LOGIC: see critical-logic/bridge.md ("Automations and recipes"). Ready-made PowerShell scripts
// (recipes/*.json in the package): the AI runs one with parameters or saves it as an automation.
// A recipe becomes ONE plain script: a `$P = @{…}` block with the checked parameters (single-quoted
// literals, every quote character doubled), then the recipe's own lines. Paths go through the same
// folder rules as the file tools (tool-lib guard); the whole script then through policy.check like a
// terminal command (bridge.mjs / automations.mjs), so an excluded folder can't hide in a parameter.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expandVars, norm } from './policy.mjs';
import { ToolError, fail, guard, excludedInside } from './tool-lib.mjs';

export const RECIPE_IDS = ['backup-folder', 'clean-downloads', 'sort-folder', 'disk-report', 'update-apps'];
const DIR = new URL('../recipes/', import.meta.url);
let cache = null;
export function loadRecipes() {
  cache ||= RECIPE_IDS.map((id) => JSON.parse(fs.readFileSync(new URL(`${id}.json`, DIR), 'utf8')));
  return cache;
}
const byId = (id) => loadRecipes().find((r) => r.id === id) || fail('NO_RECIPE', `There is no recipe "${id}".`, `Use one of: ${RECIPE_IDS.join(', ')} (action "recipes" lists them).`);

/** What the AI gets from action "recipes" (English, parameters with types and defaults). */
export function recipeList(lang = 'en') {
  const l = (o) => (o && (o[lang] || o.en)) || '';
  return loadRecipes().map((r) => ({
    id: r.id, title: l(r.title), description: l(r.description), suggestedSchedule: r.schedule,
    params: r.params.map((p) => ({ name: p.name, type: p.type, ...(p.required ? { required: true } : {}), ...(p.default !== undefined ? { default: p.default } : {}), ...(p.values ? { values: p.values } : {}), ...(p.min !== undefined ? { min: p.min, max: p.max } : {}), description: l(p.description) })),
  }));
}
export const recipeTitle = (id) => { const r = loadRecipes().find((x) => x.id === id); return r ? r.title : null; };

// PowerShell single-quoted literal. PowerShell treats ' ‘ ’ ‚ ‛ all as single quotes; doubling each
// one keeps it literal. Control characters are refused before this (no line breaks in a value).
export const psQuote = (s) => `'${String(s).replace(/['‘’‚‛]/g, (c) => c + c)}'`;
const CTRL = /[\u0000-\u001f\u007f\u2028\u2029]/;

// The Recycle Bin helper of the bridge itself (recycle.ps1, IFileOperation without UI; an item that
// would be deleted for good is left alone). Copied into the script: a scheduled run needs no package.
export function recycleLib() {
  const t = fs.readFileSync(fileURLToPath(new URL('./recycle.ps1', import.meta.url)), 'utf8');
  const m = /Add-CachedType @'\r?\n([\s\S]*?)\r?\n'@/.exec(t);
  if (!m || !/class BrRecycle\b/.test(m[1])) throw new ToolError('INTERNAL', 'The Recycle Bin helper of this Bridgerator version could not be read.', 'Update Bridgerator.');
  // Plain Add-Type (not ask-lib's Add-CachedType): its cache is in Bridgerator's own folder, which a
  // recipe / scheduled script may never name (policy.check refuses such a script).
  return `Add-Type -TypeDefinition @'\n${m[1]}\n'@`;
}

/** Relative folder path → "<depth>:<first 16 hex of SHA-256 of it in lower case>" (the recipe's walk computes the same). */
export const skipId = (rel) => `${rel.split(/[\\/]/).length}:${crypto.createHash('sha256').update(rel.toLowerCase(), 'utf8').digest('hex').slice(0, 16)}`;

function readParam(ctx, spec, v, all, skips = {}) {
  const bad = (why) => fail('BAD_ARGS', `${spec.name}: ${why}.`);
  if (spec.type === 'bool') { if (typeof v !== 'boolean') bad('must be true or false'); return v; }
  if (spec.type === 'int') { if (!Number.isInteger(v) || v < spec.min || v > spec.max) bad(`must be a whole number from ${spec.min} to ${spec.max}`); return v; }
  if (spec.type === 'enum') { if (!spec.values.includes(v)) bad(`must be one of ${spec.values.join(', ')}`); return v; }
  if (spec.type === 'path') {
    if (typeof v !== 'string' || !v.trim() || v.length > 1000 || CTRL.test(v)) bad('must be a full folder or file path on one line');
    // A folder parameter is used as a whole tree (copied, walked, recycled below it): it must not contain an
    // excluded / Bridgerator folder (FOLDER_HAS_EXCLUDED), except tree "skip": the script skips them itself.
    const write = spec.access === 'write', folder = !spec.ext;
    const abs = guard(ctx, expandVars(v.trim()), { write, tree: folder && spec.tree !== 'skip' });
    if (folder && spec.tree === 'skip') skips[spec.name] = excludedInside(ctx, abs, { write }).map(skipId);
    if (spec.mustExist) { let ok = false; try { ok = fs.statSync(abs).isDirectory(); } catch { /* missing */ } if (!ok) fail('NOT_FOUND', `${spec.name}: the folder "${abs}" does not exist.`, 'Check the path (list the folder first).'); }
    if (spec.ext && path.extname(abs).toLowerCase() !== spec.ext) bad(`must end with ${spec.ext}`);
    if (spec.notInside && all[spec.notInside]) {
      const a = norm(abs), b = norm(all[spec.notInside]);
      if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) bad(`must not be inside ${spec.notInside} (or contain it)`);
    }
    return abs;
  }
  bad('unknown type');
}

/**
 * → { recipe: id, params: {checked values}, script }. ctx: { cfg, policy } (folder rules).
 * Throws ToolError on a wrong / missing parameter or a path the folder rules refuse.
 */
export function buildRecipe(ctx, id, input = {}) {
  const r = byId(id);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) fail('BAD_ARGS', 'params must be an object.');
  const unknown = Object.keys(input).filter((k) => !r.params.some((p) => p.name === k));
  if (unknown.length) fail('BAD_ARGS', `Unknown parameter(s) for ${id}: ${unknown.join(', ')}.`, `Parameters: ${r.params.map((p) => p.name).join(', ')}.`);
  const out = {}, skips = {};
  for (const spec of r.params) {
    let v = input[spec.name];
    if (v === undefined || v === null || v === '') {
      if (spec.required) fail('BAD_ARGS', `${spec.name} is required for ${id}.`);
      if (spec.default === undefined) { out[spec.name] = null; continue; }
      v = spec.default;
    }
    out[spec.name] = readParam(ctx, spec, v, out, skips);
  }
  const lit = (v) => (v === null ? '$null' : typeof v === 'boolean' ? (v ? '$true' : '$false') : typeof v === 'number' ? String(v) : psQuote(v));
  const body = r.script.join('\n').replace('#RECYCLE#', () => recycleLib());
  const script = [
    `# Recipe "${r.id}" (${r.title.en}). Parameters:`,
    "$ErrorActionPreference = 'Continue'",
    '$P = @{',
    ...r.params.map((p) => `  ${p.name} = ${lit(out[p.name])}`),
    // Excluded folders below a tree "skip" folder as "<depth>:<hash of the relative path>" (skipId): the
    // script never names them (it may not mention an excluded folder or Bridgerator).
    ...Object.entries(skips).map(([k, l]) => `  ${k}Skip = @(${l.map(psQuote).join(', ')})`),
    '}',
    body,
  ].join('\n');
  return { recipe: r.id, params: out, script };
}
