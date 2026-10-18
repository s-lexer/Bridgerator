// Module-loader hook (loaded into the Desktop Commander child via `node --import ./dc-isolate.mjs`).
// Desktop Commander keeps ONE config per Windows user (~/.claude-server-commander). Bridgerator
// must not change the limits of a Desktop Commander the user already runs for other apps, so the
// config folder is redirected to BRIDGERATOR_DC_CONFIG_DIR. Only config.js is touched, only this
// one line; home-folder expansion and the shell environment stay the user's real ones.
// Fails closed: if the line is not found (Desktop Commander changed), the child refuses to start.
const TARGET = /[\\/]@wonderwhy-er[\\/]desktop-commander[\\/]dist[\\/]config\.js$/;
const LINE = "const CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');";

export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  if (!TARGET.test(decodeURIComponent(new URL(url).pathname))) return r;
  const src = String(r.source);
  if (!src.includes(LINE)) throw new Error('bridgerator: unexpected Desktop Commander config.js — refusing to share its config');
  return { ...r, source: src.replace(LINE, 'const CONFIG_DIR = process.env.BRIDGERATOR_DC_CONFIG_DIR || path.join(USER_HOME, \'.claude-server-commander\');') };
}
