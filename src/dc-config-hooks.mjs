// Module-loader hooks (loaded into the Desktop Commander child via `node --import ./dc-isolate.mjs`).
// 1. config.js — Desktop Commander keeps ONE config per Windows user (~/.claude-server-commander).
//    Bridgerator must not change the limits of a Desktop Commander the user already runs for other
//    apps, so the config folder is redirected to BRIDGERATOR_DC_CONFIG_DIR. Only this one line is
//    touched; home-folder expansion and the shell environment stay the user's real ones.
// 2. utils/open-browser.js — replaced by no-ops: the bridge runs hidden and must never open a
//    browser (Desktop Commander opens its own welcome page on first run).
// Fails closed: if an expected line is not found (Desktop Commander changed), the child refuses to start.
const DC = /[\\/]@wonderwhy-er[\\/]desktop-commander[\\/]dist[\\/]/;
const CONFIG_LINE = "const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');";
const NO_BROWSER = 'export async function openBrowser() {}\nexport async function openWelcomePage() {}\n';

export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  const p = url.startsWith('file:') ? decodeURIComponent(new URL(url).pathname) : '';
  if (!DC.test(p)) return r;
  if (/[\\/]dist[\\/]config\.js$/.test(p)) {
    const src = String(r.source);
    if (!src.includes(CONFIG_LINE)) throw new Error('bridgerator: unexpected Desktop Commander config.js — refusing to share its config');
    return { ...r, source: src.replace(CONFIG_LINE, "const CONFIG_DIR = process.env.BRIDGERATOR_DC_CONFIG_DIR || path.join(USER_HOME, '.claude-server-commander');") };
  }
  if (/[\\/]dist[\\/]utils[\\/]open-browser\.js$/.test(p)) {
    const src = String(r.source);
    if (!src.includes('export async function openWelcomePage')) throw new Error('bridgerator: unexpected Desktop Commander open-browser.js');
    return { ...r, source: NO_BROWSER };
  }
  return r;
}
