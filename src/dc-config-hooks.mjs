// Module-loader hooks (loaded into the bundled engine child via `node --import ./dc-isolate.mjs`).
// The engine is pinned (package.json); each patch replaces one exact snippet and FAILS CLOSED —
// if the snippet is missing (engine changed), the child refuses to start instead of silently
// sharing the user's own config, opening a browser or downloading a browser.
//   config.js         — config folder → BRIDGERATOR_DC_CONFIG_DIR (an engine the user runs for other
//                       apps keeps its limits; home-folder expansion and the shell env stay real).
//   toolHistory.js    — the local tool-call history (every call with its arguments and output) stays in
//                       memory only: never written to disk (queue push removed; folder = ours).
//   fuzzySearchLogger — the edit tool's fuzzy-match log (holds snippets of edited text) goes to the same
//                       folder, not ~\.claude-server-commander-logs.
//   trackTools.js     — no local log of every tool call with its arguments (commands, paths, text).
//   open-browser.js   — no-ops: the bridge runs hidden and never opens a browser (the engine opens
//                       its vendor's welcome page on first run).
//   index.js          — no Chrome pre-download at start (~400 MB); PDF export still fetches it on demand.
//   terminal-manager  — PowerShell (the default shell) writes UTF-8: the engine decodes output as UTF-8,
//                       so on Russian & co. Windows (console code page 866/1251) text came out as garbage.
const DIR_EXPR = "(globalThis.__BRG_DC_DIR || path.join(USER_HOME, '.claude-server-commander'))";
const PATCHES = [
  { file: /[\\/]dist[\\/]config\.js$/, from: "const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');", to: `const CONFIG_DIR = ${DIR_EXPR};` },
  { file: /[\\/]dist[\\/]utils[\\/]toolHistory\.js$/, from: "const historyDir = path.join(os.homedir(), '.claude-server-commander');", to: "const historyDir = globalThis.__BRG_DC_DIR || path.join(os.homedir(), '.claude-server-commander');" },
  { file: /[\\/]dist[\\/]utils[\\/]toolHistory\.js$/, from: '        // Queue for async write\n        this.writeQueue.push(record);\n', to: '        // bridgerator: no disk writes of tool calls\n' },
  { file: /[\\/]dist[\\/]utils[\\/]fuzzySearchLogger\.js$/, from: "const logDir = path.join(os.homedir(), '.claude-server-commander-logs');", to: "const logDir = globalThis.__BRG_DC_DIR || path.join(os.homedir(), '.claude-server-commander-logs');" },
  { file: /[\\/]dist[\\/]utils[\\/]trackTools\.js$/, from: 'export async function trackToolCall(toolName, args) {\n', to: 'export async function trackToolCall(toolName, args) {\n    return; // bridgerator: no local log of tool arguments\n' },
  { file: /[\\/]dist[\\/]utils[\\/]open-browser\.js$/, from: 'export async function openWelcomePage', replaceAll: 'export async function openBrowser() {}\nexport async function openWelcomePage() {}\n' },
  { file: /[\\/]dist[\\/]terminal-manager\.js$/, from: "args: ['-Command', command],", to: "args: ['-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + command]," },
  { file: /[\\/]dist[\\/]index\.js$/, from: '            ensureChromeAvailable();\n', to: '            // bridgerator: no Chrome pre-download\n' },
];
const ENGINE = /[\\/]bridgerator-engine[\\/]dist[\\/]/; // the bundled engine, installed under our own name (owner 26.10)

export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  const p = url.startsWith('file:') ? decodeURIComponent(new URL(url).pathname) : '';
  if (!ENGINE.test(p)) return r;
  const patches = PATCHES.filter((x) => x.file.test(p));
  if (!patches.length) return r;
  let src = String(r.source).replace(/\r\n/g, '\n');
  for (const patch of patches) {
    if (!src.includes(patch.from)) throw new Error(`bridgerator: unexpected engine file ${p.split(/[\\/]/).slice(-2).join('/')} — refusing to start`);
    src = patch.replaceAll ?? src.replace(patch.from, patch.to);
  }
  return { ...r, source: src };
}
