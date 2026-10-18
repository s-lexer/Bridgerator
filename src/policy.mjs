// Bridge-side access policy, applied BEFORE a call reaches Desktop Commander and to its results.
// Desktop Commander itself only knows allowedDirectories; it has no "except these folders" rule,
// so deniedDirectories is enforced here: input paths are resolved (symlinks/junctions included)
// and refused when they fall inside a denied folder; result lines that mention a denied path are
// dropped (search hits, recursive listings).
// The terminal is NOT covered by folder rules (a shell can read anything the user can); commands
// that name a denied folder are refused as a courtesy, the real control is disabledTools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tools the model must never get: they would let it rewrite its own limits or leak telemetry.
export const ALWAYS_HIDDEN = ['set_config_value', 'give_feedback_to_desktop_commander', 'get_usage_stats'];
// Argument names that carry filesystem paths in Desktop Commander's tools.
const PATH_KEYS = /^(path|paths|file_path|source|destination|inputPath|outputPath|directory)$/i;

const expandHome = (p) => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p);
export const norm = (p) => path.resolve(expandHome(String(p))).replace(/[\\/]+$/, '').toLowerCase();

// Resolve symlinks/junctions on the deepest existing ancestor, like Desktop Commander does.
export function realish(p) {
  let cur = path.resolve(expandHome(String(p)));
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { /* walk up */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(expandHome(String(p)));
    rest.unshift(path.basename(cur));
    cur = up;
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "c:\secret" mentioned as a path (not as the prefix of "c:\secretive"), any slash style / JSON escaping.
const flat = (s) => String(s).toLowerCase().replace(/[\\/]+/g, '\\');
const mentionRe = (d) => new RegExp(`${esc(d)}(?![a-z0-9_.\\-])`);

export function createPolicy(cfg = {}) {
  const denied = (cfg.deniedDirectories || []).map((d) => norm(realish(d)));
  const res = denied.map(mentionRe);
  const mentionsDenied = (s) => { const f = flat(s); return res.some((r) => r.test(f)); };
  const hidden = new Set([...ALWAYS_HIDDEN, ...(cfg.disabledTools || [])]);
  const inDenied = (p) => {
    const n = norm(p);
    return denied.find((d) => n === d || n.startsWith(d + path.sep)) || null;
  };
  const deniedFor = (p) => inDenied(p) || inDenied(realish(p));

  function pathsIn(args) {
    const out = [];
    for (const [k, v] of Object.entries(args || {})) {
      if (!PATH_KEYS.test(k)) continue;
      for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x) out.push(x);
    }
    return out;
  }

  return {
    denied,
    visible: (tool) => !hidden.has(tool.name),
    // → null when allowed, otherwise the refusal text returned to the model.
    check(name, args) {
      if (hidden.has(name)) return `Tool "${name}" is disabled on this computer.`;
      for (const p of pathsIn(args)) {
        if (deniedFor(p)) return `Access denied by Bridgerator: "${p}" is inside an excluded folder.`;
      }
      for (const k of ['command', 'input']) {
        if (typeof args?.[k] === 'string' && mentionsDenied(args[k])) return `Access denied by Bridgerator: the ${k} refers to an excluded folder.`;
      }
      return null;
    },
    // Drop result lines that reveal anything inside a denied folder. `args` lets a listing of a
    // parent folder hide the excluded child, whose entries are printed relative to that parent.
    filter(result, name, args) {
      if (!denied.length || !result || !Array.isArray(result.content)) return result;
      const rel = [];
      if (name === 'list_directory' && typeof args?.path === 'string') {
        const base = norm(realish(args.path));
        for (const d of denied) if (d.startsWith(base + path.sep)) rel.push(new RegExp(`^${esc(d.slice(base.length + 1))}(?![a-z0-9_.\\-])`));
      }
      const leaks = (line) => mentionsDenied(line) || rel.some((r) => r.test(flat(line).trim().replace(/^\[(dir|file)\]\s*/, '')));
      let dropped = 0;
      const content = result.content.map((c) => {
        if (c?.type !== 'text' || typeof c.text !== 'string') return c;
        const lines = c.text.split(/\r?\n/);
        const kept = lines.filter((ln) => !leaks(ln));
        dropped += lines.length - kept.length;
        return { ...c, text: kept.join('\n') };
      });
      if (dropped) content.push({ type: 'text', text: `[Bridgerator: ${dropped} line(s) hidden — excluded folder]` });
      return { ...result, content };
    },
  };
}

// The bundled engine's own name and links are not shown to the user: tool titles/descriptions and
// widget HTML say Bridgerator. Tool RESULTS are never rewritten (they are the user's own data).
const BRAND = [[/Desktop Commander/g, 'Bridgerator'], [/https?:\/\/(www\.)?desktopcommander\.app[^\s"'\)<]*/g, 'https://bridgerator.recondeck.com']];
export function debrand(v) {
  if (typeof v === 'string') return BRAND.reduce((s, [re, to]) => s.replace(re, to), v);
  if (Array.isArray(v)) return v.map(debrand);
  if (v && typeof v === 'object') {
    const o = {};
    // _meta keys (ui:// template URIs) are identifiers, not user-facing text — keep them as is.
    for (const [k, x] of Object.entries(v)) o[k] = k === '_meta' || k === 'uri' ? x : debrand(x);
    return o;
  }
  return v;
}
