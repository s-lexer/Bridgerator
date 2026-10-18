// Module-loader hooks (loaded into the bundled engine child via `node --import ./dc-isolate.mjs`).
// The engine is pinned (package.json); each patch replaces one exact snippet and FAILS CLOSED —
// if the snippet is missing (engine changed), the child refuses to start instead of silently
// sharing the user's own config, opening a browser or downloading a browser.
//   config.js         — config folder → BRIDGERATOR_DC_CONFIG_DIR (an engine the user runs for other
//                       apps keeps its limits; home-folder expansion and the shell env stay real).
//   toolHistory.js    — the local tool-call history goes to the same folder, not ~\.claude-server-commander.
//   open-browser.js   — no-ops: the bridge runs hidden and never opens a browser (the engine opens
//                       its vendor's welcome page on first run).
//   index.js          — no Chrome pre-download at start (~400 MB); PDF export still fetches it on demand.
const DIR_EXPR = "(process.env.BRIDGERATOR_DC_CONFIG_DIR || path.join(USER_HOME, '.claude-server-commander'))";
const PATCHES = [
  { file: /[\\/]dist[\\/]config\.js$/, from: "const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');", to: `const CONFIG_DIR = ${DIR_EXPR};` },
  { file: /[\\/]dist[\\/]utils[\\/]toolHistory\.js$/, from: "const historyDir = path.join(os.homedir(), '.claude-server-commander');", to: "const historyDir = process.env.BRIDGERATOR_DC_CONFIG_DIR || path.join(os.homedir(), '.claude-server-commander');" },
  { file: /[\\/]dist[\\/]utils[\\/]open-browser\.js$/, from: 'export async function openWelcomePage', replaceAll: 'export async function openBrowser() {}\nexport async function openWelcomePage() {}\n' },
  { file: /[\\/]dist[\\/]index\.js$/, from: '            ensureChromeAvailable();\n', to: '            // bridgerator: no Chrome pre-download\n' },
];
const ENGINE = /[\\/]@wonderwhy-er[\\/]desktop-commander[\\/]dist[\\/]/;

export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  const p = url.startsWith('file:') ? decodeURIComponent(new URL(url).pathname) : '';
  if (!ENGINE.test(p)) return r;
  const patch = PATCHES.find((x) => x.file.test(p));
  if (!patch) return r;
  const src = String(r.source).replace(/\r\n/g, '\n');
  if (!src.includes(patch.from)) throw new Error(`bridgerator: unexpected engine file ${p.split(/[\\/]/).slice(-2).join('/')} — refusing to start`);
  return { ...r, source: patch.replaceAll ?? src.replace(patch.from, patch.to) };
}
