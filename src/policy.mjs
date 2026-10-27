// Bridge-side access policy, applied BEFORE a call reaches the engine and to its results.
// The engine itself only knows allowedDirectories; it has no "except these folders" rule,
// so deniedDirectories is enforced here: input paths are resolved (symlinks/junctions included)
// and refused when they fall inside a denied folder; result lines that mention a denied path are
// dropped (search hits, recursive listings).
// The terminal is NOT covered by folder rules (a shell can read anything the user can); commands
// that name a denied folder are refused as a courtesy, the real control is disabledTools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tools the model must never get: they would let it rewrite its own limits, leak telemetry, read the
// local log of earlier calls, or fetch from the network (PDF export loads remote content).
export const ALWAYS_HIDDEN = ['set_config_value', 'give_feedback_to_desktop_commander', 'get_usage_stats', 'write_pdf', 'get_recent_tool_calls'];
// Tools that change files; refused inside readOnlyDirectories (move_file: on either side).
export const WRITE_TOOLS = ['write_file', 'edit_block', 'move_file', 'create_directory'];
// Argument names that carry filesystem paths (at any depth): path, paths, file_path, outputPath, directory, source, destination…
const MAX_DEPTH = 8, MAX_NODES = 5000;
const PATH_KEYS = /(path|paths|file|files|dir|directory|folder|source|dest|destination)$/i;

// The terminal: off in the access presets Read only / Files (config disabledTools). The bridge always
// lists these, refused while off, so turning the terminal on needs no restart.
export const TERMINAL_TOOLS = ['start_process', 'interact_with_process', 'kill_process'];
const PKG = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');

// LOGIC: see critical-logic/bridge.md. Always excluded, whatever the config says: Bridgerator's own
// settings, key, snapshots and program files — without this the AI could switch any protection off.
export function ownDenied(env = process.env, home = os.homedir()) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const npm = path.join(appData, 'npm');
  return [path.join(appData, 'Bridgerator'), path.join(local, 'Bridgerator'), path.join(npm, 'node_modules', 'bridgerator'),
    ...['bridgerator', 'bridgerator.cmd', 'bridgerator.ps1'].map((x) => path.join(npm, x)), PKG];
}
// "Protect sensitive folders" (config protectSensitive, off by default since 21.10): autostart folder,
// shell profiles that run code at start, credentials, the whole AppData.
export function sensitiveDenied(env = process.env, home = os.homedir()) {
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const docs = [path.join(home, 'Documents'), ...(env.OneDrive ? [path.join(env.OneDrive, 'Documents')] : [])];
  return [
    path.join(appData, 'npm'), path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'),
    ...docs.flatMap((d) => [path.join(d, 'WindowsPowerShell'), path.join(d, 'PowerShell')]),
    ...['.ssh', '.aws', '.azure', '.kube', '.docker', '.gnupg', '.config', '.npmrc', '.git-credentials', '.gitconfig', '.claude', 'AppData'].map((x) => path.join(home, x)),
  ];
}
/** Built-in exclusions: own folders always; sensitive ones unless protectSensitive is false. */
export function builtinDenied(env = process.env, home = os.homedir(), { protectSensitive = true } = {}) {
  return [...ownDenied(env, home), ...(protectSensitive ? sensitiveDenied(env, home) : [])];
}

const expandHome = (p) => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p);
// base: the folder a relative path is resolved against (default: this process's cwd).
export const norm = (p, base) => path.resolve(base || '.', expandHome(String(p))).replace(/[\\/]+$/, '').toLowerCase();

// Resolve symlinks/junctions on the deepest existing ancestor, like the engine does.
export function realish(p, base) {
  const start = path.resolve(base || '.', expandHome(String(p)));
  let cur = start;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch { /* walk up */ }
    const up = path.dirname(cur);
    if (up === cur) return start;
    rest.unshift(path.basename(cur));
    cur = up;
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "c:\secret" mentioned as a path (not as the prefix of "c:\secretive"), any slash style / JSON escaping.
const flat = (s) => String(s).toLowerCase().replace(/[\\/]+/g, '\\');
const mentionRe = (d) => new RegExp(`${esc(d)}(?![a-z0-9_.\\-])`);

// Quotes and the escape characters of cmd (^) and PowerShell (`) can split a path in a command.
export const unquote = (s) => String(s).replace(/["'^`]/g, '');
// 8.3 short names (C:\Users\3C8A~1\…): the deepest existing part is resolved to its long name.
// Linear: tokens first (one regex over the whole command backtracks quadratically), at most 50 lookups.
export const longNames = (s) => {
  let n = 0;
  return String(s).replace(/[^\s"'|&;<>]+/g, (tok) => (n < 50 && /~\d/.test(tok) ? tok.replace(/[a-z]:[\\/].*$/i, (m) => (/~\d/.test(m) && ++n <= 50 ? realish(m) : m)) : tok));
};

// Path-like parts of a command: absolute (C:\…, also after = or >) and relative with a backslash
// (sub\x, .\x, ..\x), quoted or not. Capped (count and length): this runs on every command.
const MAX_CMD_PATHS = 64;
export function commandPaths(s) {
  const out = [];
  for (const m of String(s).slice(0, 20000).matchAll(/"([^"]{1,1000})"|'([^']{1,1000})'|([^\s"'|&;<>(),]{1,1000})/g)) {
    let t = (m[1] ?? m[2] ?? m[3]).trim();
    const d = /[a-z]:[\\/]/i.exec(t);
    if (d) t = t.slice(d.index);
    else if (/^[-/]/.test(t) || !t.includes('\\') || t.includes(':')) continue; // a flag, a switch, no folder part, a URL
    out.push(t);
    if (out.length >= MAX_CMD_PATHS) break;
  }
  return out;
}
// What a command WRITES (a heuristic like the other command checks — the terminal is not a boundary):
// redirect targets (> / >> / 2> file; not 2>&1, >nul, >$null), the destination of a copy (-Destination
// or the last path), every path after a move / delete / write verb of its own segment (a move empties
// its source too). Read sources and paths of other segments (a | b ; c && d) are not targets.
const COPY_VERB = /^(copy|xcopy|robocopy|cp|cpi|copy-item)$/i;
const WRITE_VERB = /^(set-content|add-content|out-file|new-item|ni|remove-item|ri|rm|del|erase|rd|rmdir|mkdir|md|move|mv|mi|move-item|copy|xcopy|robocopy|cp|cpi|copy-item|ren|rename|rename-item|rni|clear-content|tee-object|tee|expand-archive|compress-archive|icacls|attrib|takeown)(\.exe)?$/i;
const NUL_TARGET = /^(\$?null|nul|con)$/i;
const segments = (s) => {
  const out = [];
  let cur = '', q = '';
  for (const ch of String(s).slice(0, 20000)) {
    if (q) { if (ch === q) q = ''; cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\n' || ch === '\r') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
};
export function writeTargets(s) {
  const out = [];
  const text = String(s).slice(0, 20000);
  for (const m of text.matchAll(/[*\d]?>>?(?!&)\s*("([^"]{1,1000})"|'([^']{1,1000})'|([^\s"'|&;<>()]{1,1000}))/g)) {
    const t = (m[2] ?? m[3] ?? m[4]).trim();
    if (t && !NUL_TARGET.test(t)) out.push(t);
  }
  for (const seg of segments(text)) {
    const words = [...seg.matchAll(/[^\s"'(){}=]+/g)];
    const v = words.find((w) => WRITE_VERB.test(w[0].replace(/^[.&@]+/, '')));
    if (!v) continue;
    const rest = seg.slice(v.index + v[0].length).replace(/[*\d]?>>?(?!&)\s*("[^"]*"|'[^']*'|[^\s"'|&;<>()]+)/g, ' ');
    const named = commandPaths(rest);
    if (COPY_VERB.test(v[0].replace(/^[.&@]+|\.exe$/gi, ''))) {
      const d = /(^|\s)-destination\s+("[^"]{1,1000}"|'[^']{1,1000}'|[^\s"']{1,1000})/i.exec(rest);
      const dest = d ? commandPaths(d[2])[0] : named.at(-1);
      if (dest) out.push(dest);
    } else out.push(...named);
    if (out.length >= MAX_CMD_PATHS) break;
  }
  return out.slice(0, MAX_CMD_PATHS);
}
/** %VAR%, $env:VAR, ${env:VAR} and a leading ~ expanded with the real environment (case-insensitive names). */
export function expandVars(s, env = process.env, home = os.homedir()) {
  const get = (n) => { const k = Object.keys(env).find((x) => x.toLowerCase() === String(n).toLowerCase()); return k ? env[k] : undefined; };
  return String(s)
    .replace(/%([A-Za-z_][\w()]*)%/g, (m, n) => get(n) ?? m)
    .replace(/\$\{env:([^}]+)\}/gi, (m, n) => get(n) ?? m)
    .replace(/\$env:([A-Za-z_]\w*)/gi, (m, n) => get(n) ?? m)
    .replace(/(^|[\s"'(=;,])~(?=[\\/]|$|[\s"'])/g, (m, pre) => pre + home);
}

// cfg.cwd: the folder the ENGINE resolves relative paths against (its working directory): relative
// arguments are checked where the engine will open them, never against the bridge's own folder.
// Terminal commands that change or stop Bridgerator itself (its CLI's setting/lifecycle commands, removing the
// package, ending its processes or autostart task). Read-only uses (doctor, status, --version, a folder name) pass.
const SELF_CHANGE = [
  /\bbridgerator(?:\.cmd|\.ps1|\.exe)?["']?\s+(?:confirm|read-only|telemetry|setup|uninstall|stop|run|unlink)\b/i,
  /\b(?:npm|pnpm|yarn)(?:\.cmd)?\s[^|;&\n]*\b(?:rm|remove|uninstall|un|r|unlink)\s[^|;&\n]*\bbridgerator\b/i,
  /\b(?:taskkill|tskill|pskill|kill|stop-process|wmic|schtasks|(?:start|stop|disable|enable|unregister|set)-scheduledtask)\b[^|;&\n]*\bbridgerator/i,
  /\bbridgerator[^;&\n]*\|\s*(?:stop-process|kill|(?:stop|disable|unregister|set)-scheduledtask)\b/i,
];
// Tools whose result is the text of files that passed the folder check (shown whole, never filtered).
const FILE_TEXT = new Set(['read_file', 'read_multiple_files']);
export function createPolicy(cfg = {}) {
  const base = cfg.cwd || process.cwd();
  // protectSensitive absent = on (callers that don't say); the bridge passes the person's setting.
  const denied = [...new Set([...builtinDenied(process.env, os.homedir(), { protectSensitive: cfg.protectSensitive !== false }), ...(cfg.deniedDirectories || [])].map((d) => norm(realish(d))))];
  const res = denied.map(mentionRe);
  const mentionsDenied = (s) => { const f = flat(s); return res.some((r) => r.test(f)); };
  const hidden = new Set([...ALWAYS_HIDDEN, ...(cfg.disabledTools || [])]);
  const inDenied = (p) => {
    const n = norm(p, base);
    return denied.find((d) => n === d || n.startsWith(d + path.sep)) || null;
  };
  const deniedFor = (p) => inDenied(p) || inDenied(realish(p, base));
  const readOnly = (cfg.readOnlyDirectories || []).map((d) => norm(realish(d)));
  const inRo = (n) => readOnly.some((d) => n === d || n.startsWith(d + path.sep));
  const readOnlyFor = (p) => inRo(norm(p, base)) || inRo(norm(realish(p, base)));
  // A folder that CONTAINS an excluded / read-only folder (moving or deleting it takes that folder along).
  const holds = (list, p) => { const a = norm(p, base), b = norm(realish(p, base)); return list.some((d) => d.startsWith(a + path.sep) || d.startsWith(b + path.sep)); };

  // Every path-like string at any depth — iterative, with caps (deep / huge arguments are refused).
  function pathsIn(args) {
    const out = [], stack = [[args, '', 0]];
    let seen = 0;
    while (stack.length) {
      const [v, key, depth] = stack.pop();
      if (++seen > MAX_NODES || depth > MAX_DEPTH) throw new Error('arguments too deeply nested or too large');
      if (typeof v === 'string') { if (v && PATH_KEYS.test(key)) out.push(v); }
      else if (Array.isArray(v)) for (const x of v) stack.push([x, key, depth + 1]);
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) stack.push([x, k, depth + 1]);
    }
    return out;
  }

  return {
    denied,
    visible: (tool) => !hidden.has(tool.name),
    // → null when allowed, otherwise the refusal text returned to the model.
    check(name, args) {
      if (hidden.has(name)) return TERMINAL_TOOLS.includes(name) ? 'The terminal is off on this PC (access preset Read only or Files). The person can switch to Full in Bridgerator → Safety, or you can ask with bridgerator_settings.' : `Tool "${name}" is disabled on this computer.`;
      if (name === 'read_file' && args?.isUrl) return 'Reading URLs is disabled on this computer.';
      let paths;
      try { paths = pathsIn(args); } catch (e) { return `Refused by Bridgerator: ${e.message}.`; }
      for (const p of paths) {
        // UNC / device paths (\\server\share, \\?\, \\.\): network shares and raw devices are out of scope.
        if (/^[\\/]{2}/.test(p.trim())) return `Access denied by Bridgerator: network and device paths ("${p}") are not allowed.`;
        if (deniedFor(p)) return `Access denied by Bridgerator: "${p}" is inside an excluded folder.`;
        if (WRITE_TOOLS.includes(name) && readOnlyFor(p)) return `Access denied by Bridgerator: "${p}" is in a read-only folder — files there can be read, not changed.`;
        if (WRITE_TOOLS.includes(name) && holds(denied, p)) return `Access denied by Bridgerator: "${p}" contains an excluded folder.`;
        if (WRITE_TOOLS.includes(name) && holds(readOnly, p)) return `Access denied by Bridgerator: "${p}" contains a read-only folder.`;
        // A hard link is the same file under another name (maybe inside an excluded folder): no writes.
        if (WRITE_TOOLS.includes(name)) { try { if (fs.lstatSync(path.resolve(base, expandHome(p))).nlink > 1) return `Access denied by Bridgerator: "${p}" is a hard-linked file — it can't be changed through Bridgerator.`; } catch { /* doesn't exist yet */ } }
      }
      for (const k of ['command', 'input']) {
        if (typeof args?.[k] !== 'string') continue;
        // Checked as written AND with variables expanded (%APPDATA%, $env:APPDATA, ${env:APPDATA}, ~),
        // with quotes / escape characters removed ("%USERPROFILE%"\.ssh, .s^sh, .`ssh) and 8.3 short
        // names of existing folders made long (C:\PROGRA~1).
        const u = unquote(args[k]);
        const texts = [args[k], expandVars(args[k]), u, expandVars(u)];
        texts.push(...texts.map(longNames));
        if (texts.some(mentionsDenied)) return `Access denied by Bridgerator: the ${k} refers to an excluded folder.`;
        // Paths in the command resolved like the file tools do (relative → the terminal's folder,
        // junctions / symbolic links → their target): a link to an excluded folder is refused too.
        const named = [...new Set([...commandPaths(texts[1]), ...commandPaths(texts[3])])].slice(0, MAX_CMD_PATHS);
        // UNC / device paths are refused like path arguments — never resolved here (a lookup on a
        // network path blocks the bridge's main thread).
        const unc = named.find((p) => /^[\\/]{2}[^\\/]+[\\/]/.test(p));
        if (unc) return `Access denied by Bridgerator: network and device paths ("${unc}") are not allowed.`;
        if (named.some((p) => deniedFor(p))) return `Access denied by Bridgerator: the ${k} refers to an excluded folder.`;
        // Read-only folders, for commands that change files (a courtesy: a script can still write there).
        // Only what the command writes counts (as written with its quotes and as unquoted).
        if (readOnly.length) {
          const targets = [...new Set([...writeTargets(texts[1]), ...writeTargets(texts[3])])].filter((p) => !/^[\\/]{2}/.test(p));
          if (targets.some((p) => readOnlyFor(p))) return `Access denied by Bridgerator: the ${k} would change a read-only folder — files there can be read, not changed.`;
        }
        // Courtesy, like the folder check (the terminal itself is not a boundary): commands that change or stop
        // Bridgerator itself are for the person; its files are covered by the folder rule above. Owner 26.10: the AI
        // sets up everything else — the word alone (a project folder, npm i -g bridgerator, doctor) is fine.
        if (texts.some((x) => SELF_CHANGE.some((re) => re.test(x)))) return 'This command would change or stop Bridgerator itself. Change its settings with bridgerator_settings (they apply at once); to turn confirmations off use request_confirm_off. Stopping, re-linking or removing Bridgerator is for the person at this PC.';
      }
      return null;
    },
    /** Refusal text when Bridgerator itself may not remove / restore this path (excluded, read-only, network), else null. */
    writable(p) {
      if (/^[\\/]{2}/.test(String(p).trim())) return `Access denied by Bridgerator: network and device paths ("${p}") are not allowed.`;
      if (deniedFor(p)) return `Access denied by Bridgerator: "${p}" is inside an excluded folder.`;
      if (readOnlyFor(p)) return `Access denied by Bridgerator: "${p}" is in a read-only folder.`;
      if (holds(denied, p)) return `Access denied by Bridgerator: "${p}" contains an excluded folder.`;
      if (holds(readOnly, p)) return `Access denied by Bridgerator: "${p}" contains a read-only folder.`;
      return null;
    },
    // Drop result lines that reveal anything inside a denied folder. `args` lets a listing of a
    // parent folder hide the excluded child, whose entries are printed relative to that parent.
    // Not for the text of a file that was allowed to be read: a line that merely NAMES an excluded folder is the
    // person's own content (E2E 26.10: .md notes lost lines, a later full rewrite would delete them from disk).
    filter(result, name, args) {
      if (!denied.length || !result || !Array.isArray(result.content) || FILE_TEXT.has(name)) return result;
      const rel = [];
      if (name === 'list_directory' && typeof args?.path === 'string') {
        const at = norm(realish(args.path, base));
        for (const d of denied) if (d.startsWith(at + path.sep)) rel.push(new RegExp(`^${esc(d.slice(at.length + 1))}(?![a-z0-9_.\\-])`));
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
      if (dropped) content.push({ type: 'text', text: `[Bridgerator: ${dropped} line(s) naming an excluded folder were left out; everything else above is complete — not an error]` }); // E2E 26.10: "hidden" read as a refusal
      return { ...result, content };
    },
  };
}

// The bundled engine's own name and links are not shown to the user: tool titles/descriptions and
// widget HTML say Bridgerator. Tool RESULTS are never rewritten (they are the user's own data).
const BRAND = [[/"DC: \.\.\." or /g, ''], [/Desktop ?Commander/g, 'Bridgerator'], [/https?:\/\/(www\.)?desktopcommander\.app[^\s"'\)<]*/g, 'https://bridgerator.recondeck.com']];
// The engine's widget URIs and their in-page state key carry its name: ChatGPT sees them in tool _meta and resources.
// Shown as ui://bridgerator/…, mapped back when a resource is read (owner 26.10: "как будто наш код").
const UI_ENGINE = 'ui://desktop-commander/', UI_OURS = 'ui://bridgerator/';
export const ourUi = (v) => JSON.parse(JSON.stringify(v).replaceAll(UI_ENGINE, UI_OURS).replaceAll('desktop-commander:widget-state', 'bridgerator:widget-state'));
export const engineUi = (uri) => String(uri).replace(UI_OURS, UI_ENGINE);
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

// Two results are the engine's own text, not user data: the prompt catalog (get_prompts says
// its own brand in the heading) and get_config, whose `version` is the engine's and is
// shown as "Bridgerator version" — replaced by the bridge's own version.
export function debrandResult(name, result, version) {
  if (!result || typeof result !== 'object') return result;
  if (name === 'get_prompts') return debrand(result);
  const sc = result.structuredContent, engine = sc?.config?.version;
  if (name !== 'get_config' || typeof engine !== 'string') return result;
  const label = `"version": ${JSON.stringify(engine)}`;
  const content = Array.isArray(result.content)
    ? result.content.map((c) => (c?.type === 'text' && typeof c.text === 'string' ? { ...c, text: c.text.replace(label, `"version": ${JSON.stringify(version)}`) } : c))
    : result.content;
  return { ...result, content, structuredContent: { ...sc, config: { ...sc.config, version } } };
}
