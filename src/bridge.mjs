// Bridgerator bridge: runs on the user's PC.
//   - starts the bundled MCP engine as a child over stdio;
//   - pushes this PC's limits (allowedDirectories, blockedCommands) into it at startup;
//   - opens ONE outbound WebSocket to the relay (no inbound port is opened on this PC);
//   - forwards each relay `call` through the policy (excluded / read-only folders, disabled tools)
//     and, when turned on, the on-PC confirmation window for risky calls (confirm.mjs) to Desktop
//     Commander and sends the filtered result back.
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPolicy, debrand, debrandResult, ourUi, engineUi, TERMINAL_TOOLS, ALWAYS_HIDDEN } from './policy.mjs';
import { showNotice } from './notice.mjs';
import { usage } from './telemetry.mjs';
import { createGate, askOnPc, CONFIRM_TOOL_DEFS } from './confirm.mjs';
import { SETUP_TOOL_DEF, validateSetup, diffSetup, applySetup, terminalTools } from './setup-tool.mjs';
import { SETTINGS_TOOL_DEF, validateSettings, widens, describe, DEFAULTS, presetOf, presetChanges, expandPresets } from './settings-tool.mjs';
import { shorten } from './tool-text.mjs';
import { parseDelete, recycle as recycleOnPc, purgeFromBin } from './recycle.mjs';
import { createSnapshots, changedPaths, undoGroups, SNAP_DEFAULTS, UNDO_TOOL_DEF } from './undo.mjs';
import { createFuse, wantAwake, FUSE_DEFAULTS } from './guard.mjs';
import { createQueue, queueTool, stalledItems, QUEUE_TOOL_DEFS, QUEUE_TOOL_NAMES } from './queue.mjs';
import { createRecent, outcomeOf } from './recent.mjs';
import { readSettingsStrict, setIni, writeAtomic, CATEGORIES, findMatch, clip } from './confirm.mjs';
import { readPlan, planBanner, bannerVisible, dismissFor, safeUrl, forecast, setSite, accountUrl } from './plan.mjs';
import { createAutomations, attachAutomations, windowRpc as automationRpc } from './automations.mjs';
import { createBatch, attachBatch } from './batch.mjs';
import { createDelegate, attachDelegate, windowRpc as delegateRpc } from './delegate.mjs';
import { eventMessage, createEventLimiter } from './events.mjs';
import { createExtra } from './extra-tools.mjs';
import { engineErrorText } from './tool-lib.mjs';
import { spawn } from 'node:child_process';
import { POWERSHELL, psArgs } from './win.mjs';
import { stripOurs } from './ask.mjs';
import { siteOf } from './pair.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RECONNECT_MS = 5000;
// The relay pings every 30 s: silence for this long means a dead link (sleep/Wi-Fi switch) that
// TCP alone may not notice for hours — drop it and reconnect.
const SILENT_MS = 75000;
const VERSION = createRequire(import.meta.url)('../package.json').version;
const STDERR_LINES = 20;
export const MAX_CALLS = 8;
/** At most `max` at once; others wait up to `waitMs` → slot() resolves true (go) or false (busy). */
export function createLimiter(max, waitMs) {
  let running = 0;
  const waiting = [];
  return {
    slot: () => new Promise((resolve) => {
      if (running < max) { running++; return resolve(true); }
      const w = { resolve, timer: setTimeout(() => { waiting.splice(waiting.indexOf(w), 1); resolve(false); }, waitMs) };
      waiting.push(w);
    }),
    release: () => { const w = waiting.shift(); if (w) { clearTimeout(w.timer); w.resolve(true); } else running--; },
    get running() { return running; },
  };
}
const BUSY_WAIT_MS = 30000;
const DC_ENTRY = createRequire(import.meta.url).resolve('bridgerator-engine/dist/index.js');
const ISOLATE = new URL('./dc-isolate.mjs', import.meta.url).href;

/** Drive roots of this PC (C:\\ … Z:\\): what the Read only preset makes read-only when there is no folder list. */
export function localDrives() {
  if (process.platform !== 'win32') return [];
  const out = [];
  for (const c of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const d = `${c}:\\`; try { if (fs.statSync(d).isDirectory()) out.push(d); } catch { /* no such drive */ } }
  return out;
}
/** The same off the event loop (a dead mapped drive can take seconds to answer). */
export async function localDrivesAsync() {
  if (process.platform !== 'win32') return [];
  const all = [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map((c) => `${c}:\\`);
  const ok = await Promise.all(all.map((d) => fs.promises.stat(d).then((s) => s.isDirectory(), () => false)));
  return all.filter((d, i) => ok[i]);
}
const DRIVES_MS = 60000;

export async function startEngine(cfg, log = console.log, { ask: askArg, recycle: recycleArg, drives: drivesArg, delegate: delegateOpts } = {}) {
  const ask0 = askArg || askOnPc;
  const recycle = recycleArg || recycleOnPc;
  // Drive list: refreshed in the background once a minute (new / removed drives are seen); only the
  // very first use before the background check finished looks synchronously.
  let drivesCache = null, drivesAt = 0;
  const refreshDrives = () => {
    drivesAt = Date.now();
    if (drivesArg) { drivesCache = drivesArg(); return; }
    localDrivesAsync().then((d) => { drivesCache = d; }, () => {});
  };
  const drives = () => {
    if (!drivesCache) { drivesCache = (drivesArg || localDrives)(); drivesAt = Date.now(); } else if (Date.now() - drivesAt > DRIVES_MS) refreshDrives();
    return drivesCache;
  };
  if (!drivesArg) refreshDrives();
  // A long settings proposal is reviewed in the Bridgerator window (Apply there); others: notification.
  let pendingSetup = null;
  const ask = (q) => {
    if (!q.review) return ask0(q);
    return new Promise((resolve) => {
      const id = `s${Date.now().toString(36)}`;
      const timer = setTimeout(() => { if (pendingSetup?.id === id) { pendingSetup = null; resolve('deny'); } }, 10 * 60000);
      pendingSetup = { id, lines: q.lines, resolve: (k) => { clearTimeout(timer); pendingSetup = null; resolve(k); } };
      out.openWindow?.('home');
      ask0({ head: 'ChatGPT suggests Bridgerator settings', text: 'Too many changes for a notification — review them in the Bridgerator window.', buttons: [['deny', 'Cancel', 'deny']], secs: 120, auto: 'closes', ...out.popup() })
        .then((k) => { if (k === 'deny' && pendingSetup?.id === id && Date.now() - Number.parseInt(id.slice(1), 36) < 115000) pendingSetup.resolve('deny'); });
    });
  };
  if (!cfg.dcConfigDir) throw new Error('dcConfigDir missing');
  // Links in notices / the plan banner point at the site this PC is linked to (prod or staging).
  try { if (cfg.relay) setSite(siteOf(cfg.relay)); } catch { /* bad relay address: the default site */ }
  // Relative paths in calls resolve where the engine's terminal starts.
  const engineDir = engineCwd(cfg);
  const absPath = (p) => path.resolve(engineDir, String(p).replace(/^~(?=[\\/]|$)/, os.homedir()));
  const transport = new StdioClientTransport({
    command: process.execPath,
    // The engine's own config folder (dc-isolate.mjs): a copy of the engine the user runs elsewhere keeps its limits.
    args: ['--import', ISOLATE, DC_ENTRY],
    // No calls home: telemetry kill-switch, and remote feature flags (onboarding page, promo text
    // injected into tool results, A/B tests) replaced by an empty local set.
    // The engine's terminal starts in the first allowed folder (never in the Bridgerator folder) and
    // its environment carries no Bridgerator variables (the config dir is removed by dc-isolate).
    cwd: engineDir,
    env: { ...engineEnv(), DC_TELEMETRY_ENABLED: 'false', DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', DC_FLAG_URL: 'data:application/json,{"flags":{}}', BRIDGERATOR_DC_CONFIG_DIR: cfg.dcConfigDir },
    stderr: 'pipe', // last lines kept for the log when the engine dies
  });
  const tail = [];
  transport.stderr?.on('data', (b) => { tail.push(...String(b).split(/\r?\n/).filter(Boolean)); tail.splice(0, Math.max(0, tail.length - STDERR_LINES)); });
  const engineErr = () => (tail.length ? `\n  engine stderr (last lines):\n  ${tail.join('\n  ')}` : '');
  const client = new Client({ name: 'bridgerator', version: VERSION }, { capabilities: {} });
  try { await client.connect(transport); } catch (e) { throw new Error(`engine did not start: ${e?.message || e}${engineErr()}`); }
  // Engine gone (crash, killed): nothing works without it — exit, the autostart starts us again.
  let closing = false;
  client.onclose = () => { if (closing) return; log(`[bridgerator] engine stopped — exiting (autostart restarts the bridge)${engineErr()}`); process.exit(1); };
  // The PC owner's limits go into the engine's own config; the model can't change them
  // (set_config_value is never exposed to the relay, see policy.ALWAYS_HIDDEN).
  const set = (key, value) => client.callTool({ name: 'set_config_value', arguments: { key, value } });
  await set('allowedDirectories', cfg.allowedDirectories || []);
  if (Array.isArray(cfg.blockedCommands)) await set('blockedCommands', cfg.blockedCommands);
  await set('telemetryEnabled', false);
  // The Bridgerator folder (key, confirm.ini) is always excluded, also when it was moved (BRIDGERATOR_HOME).
  // Relative paths are checked where the engine opens them: its working directory (engineDir).
  const makePolicy = () => createPolicy({ ...cfg, cwd: engineDir, deniedDirectories: [...(cfg.deniedDirectories || []), ...(cfg.configDir ? [cfg.configDir] : [])] });
  let policy = makePolicy();
  const { tools } = await client.listTools();
  // The bridge's own extra tools (doctor, documents, search, photos, software, PC check, screen): extra-tools.mjs.
  const extra = createExtra();
  // Short plain descriptions (tool-text.mjs). The terminal tools are always listed: the access preset
  // turns them off by refusing calls, so switching back needs no restart.
  const listed = (t) => policy.visible(t) || (TERMINAL_TOOLS.includes(t.name) && !ALWAYS_HIDDEN.includes(t.name));
  // Snapshots + Undo (on by default) in %LOCALAPPDATA%\Bridgerator\snapshots (given by the CLI).
  const snapCfg = () => ({ ...SNAP_DEFAULTS, ...(cfg.snapshots || {}) });
  const snapshots = cfg.snapshotsDir ? createSnapshots(cfg.snapshotsDir, { limits: snapCfg, log }) : null;
  const visible = [...tools.filter(listed).map(debrand), ...CONFIRM_TOOL_DEFS, SETUP_TOOL_DEF, ...(cfg.configFile ? [SETTINGS_TOOL_DEF] : []), ...(cfg.configDir ? QUEUE_TOOL_DEFS : []), ...(snapshots ? [UNDO_TOOL_DEF] : []), ...extra.defs.filter(policy.visible)].map(shorten).map(ourUi);
  const virtual = new Set(CONFIRM_TOOL_DEFS.map((t) => t.name));
  // namePending: a computer name given on this PC not yet accepted by the relay — kept in config.json too,
  // so a restart before the next link does not lose it; cleared by nameSent() (welcome / live mode message).
  const out = { onMode: () => {}, paused: false, linkState: 'offline', linkName: '', nameGen: 0, namePending: typeof cfg.namePending === 'string' ? cfg.namePending : '' };
  // Local only (never sent): the person's task queue and the recent calls with their targets.
  // "Queue finished" (todo + doing went to 0 with work done) → an event for the relay's notifications.
  // A task marked failed → "task_failed" (counts only, events.mjs).
  let queueBusy = 0, queueFailed = 0;
  const queueChanged = () => {
    out.onMode(mode());
    const c = queueCounts(), busy = c.todo + c.doing;
    if (c.failed > queueFailed) out.onEvent?.({ kind: 'task_failed', n: c.failed - queueFailed, failed: c.failed });
    if (queueBusy && !busy && c.done + c.failed) out.onEvent?.({ kind: 'queue_done', done: c.done, failed: c.failed });
    queueBusy = busy; queueFailed = c.failed;
  };
  const queue = cfg.configDir ? createQueue(path.join(cfg.configDir, 'queue.json'), { onChange: () => queueChanged() }) : null;
  const recent = createRecent(cfg.configDir ? path.join(cfg.configDir, 'recent.jsonl') : '', { keepFile: !!cfg.configDir && cfg.localHistory === true });
  const queueCounts = () => { const c = queue ? queue.counts() : {}; return { todo: c.todo || 0, doing: c.doing || 0, done: c.done || 0, failed: c.failed || 0 }; };
  queueBusy = queueCounts().todo + queueCounts().doing; queueFailed = queueCounts().failed;
  // Automations (scheduled scripts + recipes) and plan cards; their tools are in extra-tools.mjs.
  // LOGIC: critical-logic/bridge.md ("Automations and recipes", "Plan card").
  const autos = cfg.scriptsDir ? attachAutomations(cfg, createAutomations({ dir: cfg.scriptsDir, log, ask: (q) => ask({ ...q, ...out.popup() }), openWindow: (p) => out.openWindow?.(p), emit: (e) => out.onEvent?.(e), onChange: () => out.onMode(mode()), notify: () => cfg.automations?.notifySchedule !== false })) : null;
  const stopAutos = autos ? autos.start() : null;
  const batch = attachBatch(cfg, createBatch({ openWindow: (p) => out.openWindow?.(p), log }));
  // AI ↔ AI delegation (bridgerator_delegate, window page Agents). LOGIC: critical-logic/bridge.md ("AI ↔ AI delegation").
  const delegate = attachDelegate(cfg, createDelegate({ file: cfg.configDir ? path.join(cfg.configDir, 'delegate.json') : '', snapshots, log, emit: (e) => out.onEvent?.(e), ...(delegateOpts || {}) }));
  const mode = () => ({ confirm: gate.mode(), readOnly: cfg.readOnlyDirectories || [], setupDone: cfg.setupDone === true, queue: queueCounts(), paused: out.paused, ...(autos ? { automations: autos.counts() } : {}) });
  // confirm.ini is re-read on every call; a change of on/off is reported to the relay.
  const gate = createGate({
    ini: cfg.confirmIni,
    ask: (q) => ask({ ...q, ...out.popup() }),
    onChange: (m) => { log(`[bridgerator] confirmations ${m}`); out.onMode(mode()); },
    onAlways: (cat) => showNotice({ kind: 'confirm_off', category: cat }, log),
    onTurnedOff: (what) => { log(`[bridgerator] protection turned off: ${what.join(', ')}`); showNotice({ kind: 'protection_off', what }, log); },
  });
  // The bridge's own writes pass what they changed (the tray's on/off toggle passes the value it wrote).
  // Without it only [confirm] enabled is taken, read strictly: a missing / unreadable / broken file keeps
  // the applied state (never "off" from a lenient default) — never other edits sitting in confirm.ini.
  out.acceptConfirm = (changed) => {
    if (changed && typeof changed === 'object') return gate.accept(changed);
    const s = cfg.confirmIni ? readSettingsStrict(cfg.confirmIni) : null;
    return gate.accept(s ? { enabled: s.enabled } : {});
  };
  // MCP Apps widgets (file preview, config view) — served to ChatGPT through the relay as-is.
  const resources = ourUi(((await client.listResources().catch(() => ({ resources: [] }))).resources || []).map(debrand));
  const resourceUris = new Set(resources.map((r) => r.uri));
  log(`[bridgerator] engine up: ${visible.length} tools; allowed=${JSON.stringify(cfg.allowedDirectories || [])} excluded=${JSON.stringify(cfg.deniedDirectories || [])} read-only=${JSON.stringify(cfg.readOnlyDirectories || [])} confirm=${gate.mode()}`);
  if (!(cfg.allowedDirectories || []).length) log('[bridgerator] folders: all (no list), except the always-blocked ones');

  // Folders / read-only folders / confirm checks: written, then live in the engine and the policy.
  async function applyValues(v, why) {
    out.checkConfig?.(); // an outside edit not seen yet is reconciled, not swallowed by this write
    const next = applySetup(cfg.configFile, cfg.confirmIni, v);
    const foldersChanged = JSON.stringify(next.allowedDirectories) !== JSON.stringify(cfg.allowedDirectories);
    // Only what was approved: the file may hold other changes still waiting for Apply (reconcile).
    Object.assign(cfg, { ...(v.allowedDirectories ? { allowedDirectories: next.allowedDirectories } : {}), ...(v.readOnlyDirectories ? { readOnlyDirectories: next.readOnlyDirectories } : {}), ...(typeof v.terminal === 'boolean' ? { disabledTools: next.disabledTools } : {}), setupDone: true });
    ownText = JSON.stringify(next, null, 2); // exactly what applySetup wrote (a later hand edit stays visible)
    if (foldersChanged) await set('allowedDirectories', cfg.allowedDirectories || []);
    policy = makePolicy();
    log(`[bridgerator] settings applied (${why}): allowed=${JSON.stringify(cfg.allowedDirectories)} read-only=${JSON.stringify(cfg.readOnlyDirectories || [])}`);
    gate.accept(v.confirm || {});
    out.onMode(mode());
  }
  let ownText = null;                // config.json as the bridge itself last wrote / read it
  const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const patchConfig = (o) => {
    out.checkConfig?.(); // an outside edit not seen yet is reconciled, not swallowed by this write
    const c = JSON.parse(fs.readFileSync(cfg.configFile, 'utf8'));
    ownText = JSON.stringify({ ...c, ...o }, null, 2);
    writeAtomic(cfg.configFile, ownText);
    Object.assign(cfg, o);
  };
  // The relay took the name (welcome after a hello that carried it, or a live mode message): not sent again.
  out.nameSent = (name) => {
    if (out.namePending !== name) return; // renamed again meanwhile: the newer name still waits
    out.namePending = '';
    if (cfg.namePending !== undefined && cfg.configFile) { try { patchConfig({ namePending: undefined }); } catch { /* read-only: sent once more */ } }
  };
  // V-10: the relay's name for this computer (welcome) is the name, unless a name given on this PC still
  // waits to be sent: after a re-pair the window shows what the account shows, not the old local name.
  // gen = nameGen when the hello was sent: a name changed on this PC after it (already sent in a live mode
  // message, so no longer pending) is newer than this welcome's name and stays (VR-10).
  out.relayName = (name, gen) => {
    if ((gen !== undefined && gen !== out.nameGen) || out.namePending || typeof name !== 'string' || !name.trim() || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) return;
    if (cfg.deviceName === undefined || cfg.deviceName === name || !cfg.configFile) return;
    try { patchConfig({ deviceName: name }); log(`[bridgerator] computer name from the account: "${name}"`); } catch { /* read-only: shown from the link */ }
  };
  // Started after an update from the window: say so once (the marker survives setup, cli.setupConfig).
  if (cfg.updatingFrom && cfg.configFile) {
    if (cfg.updatingFrom !== VERSION) showNotice({ kind: 'updated', version: VERSION }, log);
    try { patchConfig({ updatingFrom: null }); } catch { /* read-only settings: shown again next start */ }
  }
  // State the presets / settings tool work on (same shape as getState().settings).
  const terminalOn = () => !(cfg.disabledTools || []).includes('start_process');
  const accessState = (o = {}) => ({ terminal: terminalOn(), allowedDirectories: cfg.allowedDirectories || [], readOnlyDirectories: cfg.readOnlyDirectories || [], ...o });

  // bridgerator_setup: applied at once; after Apply on the PC only with askSettings on (setup-tool.mjs).
  const say = (t, isError) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  // The person sees every settings change not made in the window (notify.settingsChanged, on by default; owner 26.10).
  // `on` is read before the change: the call that turns this notice off is still announced (review 26.10).
  const toldSettings = (by, lines, on = cfg.notify?.settingsChanged !== false) => { const what = lines.filter((l) => l && l !== 'No changes' && !/: unchanged$/.test(l)).sort((a, b) => /settingsChanged/.test(b) - /settingsChanged/.test(a)); if (what.length && on) showNotice({ kind: 'settings_changed', by, what }, log); };
  async function setup(args) {
    const v = validateSetup(args);
    if (v.error) return say(`Not applied: ${v.error}`, true);
    if (!cfg.configFile) return say('Not applied: settings can only be changed on a configured PC.', true);
    if (v.value.preset) {
      const st = accessState({ ...(v.value.allowedDirectories ? { allowedDirectories: v.value.allowedDirectories } : {}), ...(v.value.readOnlyDirectories ? { readOnlyDirectories: v.value.readOnlyDirectories } : {}) });
      for (const c of presetChanges(v.value.preset, st, drives())) v.value[c.key] = c.value;
      delete v.value.preset;
    }
    // Owner 21.10: applied at once; Apply on the PC only when the person turned on "Ask before AI changes settings".
    if (cfg.askSettings !== true) { const d = diffSetup(cfg, cfg.confirmIni, v.value).short, on = cfg.notify?.settingsChanged !== false; try { await applyValues(v.value, 'bridgerator_setup'); } finally { toldSettings('ai', [d], on); } return say('Applied on the PC.'); }
    // A diff that fits the notification gets Apply there; a longer one is reviewed in the window.
    const diff = diffSetup(cfg, cfg.confirmIni, v.value);
    let r;
    if (diff.short.length <= 180) {
      r = await gate.askPerson('setup', { head: 'ChatGPT suggests Bridgerator settings', text: diff.short, buttons: [['allow', 'Apply', ''], ['deny', 'Cancel', 'deny']], secs: 120, auto: 'auto-cancel', ...popup() });
    } else {
      r = await gate.askPerson('setup', { review: true, lines: diff.lines });
    }
    if (r === 'cooldown') return { ...say('Not applied — the person at the PC declined settings a few minutes ago. Ask them before suggesting again.'), notConfirmed: true };
    if (r !== 'allow') return { ...say('Not applied — the person at the PC cancelled or didn\'t answer.'), notConfirmed: true };
    await applyValues(v.value, 'bridgerator_setup, approved on the PC');
    return say('Applied on the PC.');
  }

  // At most MAX_CALLS calls run at once (several chats on one PC); the rest wait up to 30 s, then get
  // a "busy" answer (flag busy: the relay doesn't count it).
  const { slot, release } = createLimiter(MAX_CALLS, BUSY_WAIT_MS);
  // bridgerator_settings: get everything; set → applied at once (askSettings on: lowering protection after Apply on the PC).
  async function settingsTool(args = {}) {
    const snap = async () => (await rpc('getState')).settings;
    if (args.action === 'get') return say(JSON.stringify({ current: toolView(await snap()), defaults: DEFAULTS, alwaysBlocked: 'Bridgerator\'s own settings and program folders (not a setting)' }, null, 2));
    if (args.action !== 'set') return say('action must be "get" or "set"', true);
    const v = validateSettings(args.settings);
    if (v.error) return say(`Not changed: ${v.error}`, true);
    const cur = await snap();
    v.changes = expandPresets(v.changes, cur, drives());
    // Owner 21.10: everything applies at once unless "Ask before AI changes settings" is on (then only lowering protection asks).
    const ask1 = (c) => cfg.askSettings === true && widens(cur, c);
    const risky = v.changes.filter(ask1), safe = v.changes.filter((c) => !ask1(c));
    const on = cfg.notify?.settingsChanged !== false;
    // Announced: what really changed (not a value sent again), also when a later change fails.
    const real = (c) => JSON.stringify(c.key.split('.').reduce((o, k) => o?.[k], cur)) !== JSON.stringify(c.value);
    const apply = async (list) => { const ok = []; try { for (const c of list) { await rpc('setSetting', { ...c, via: 'bridgerator_settings' }); if (real(c)) ok.push(describe(cur, c)); } } finally { toldSettings('ai', ok, on); } };
    await apply(safe);
    const done = safe.map((c) => describe(cur, c));
    if (!risky.length) return say(`Applied: ${done.join('; ')}`);
    const lines = risky.map((c) => describe(cur, c)), short = lines.join(' · ');
    const r = short.length <= 180
      ? await gate.askPerson('settings', { head: 'ChatGPT wants to change Bridgerator settings', text: short, buttons: [['allow', 'Apply', ''], ['deny', 'Cancel', 'deny']], secs: 120, auto: 'auto-cancel', ...popup() })
      : await gate.askPerson('settings', { review: true, lines });
    if (r === 'allow') { await apply(risky); return say(`Applied${done.length ? `: ${done.join('; ')};` : ':'} after the person's OK: ${lines.join('; ')}`); }
    return { ...say(`${done.length ? `Applied: ${done.join('; ')}. ` : ''}Not applied (the person at the PC ${r === 'cooldown' ? 'declined a few minutes ago' : 'cancelled or didn\'t answer'}): ${lines.join('; ')}`), notConfirmed: true };
  }

  async function call(name, args) {
    if (!(await slot())) return { content: [{ type: 'text', text: 'This PC is busy with other chats — try again in a moment.' }], isError: true, busy: true };
    inFlight++;
    try {
      const r = await call0(name, args);
      const undo = r?.undoId;
      if (undo) delete r.undoId;
      recent.record(name, args, outcomeOf(r), undo ? { undo } : undefined);
      if (name === 'queue_update' && args?.status === 'done' && !r.isError && cfg.notify?.queueDone === true) {
        try { showNotice({ kind: 'queue_done', title: JSON.parse(r.content[0].text).item.title }, log); } catch { /* no title */ }
      }
      return r;
    } finally { inFlight--; lastCall = Date.now(); release(); }
  }
  async function call0(name, args) {
    if (out.paused) { wasPaused = true; return { content: [{ type: 'text', text: 'Bridgerator is paused on this PC. Ask the person to resume it (tray icon → Resume).' }], isError: true, paused: true }; }
    if (wasPaused) { wasPaused = false; fuse.reset(); }
    if (name === SETUP_TOOL_DEF.name) return setup(args);
    if (extra.has(name)) return extra.call(name, args, { cfg, policy, gate, log, popup, engine: call0, rpc, extra, version: VERSION });
    if (name === SETTINGS_TOOL_DEF.name && cfg.configFile) return settingsTool(args);
    if (snapshots && name === UNDO_TOOL_DEF.name) return undoTool(args);
    if (virtual.has(name)) return gate.tool(name);
    if (queue && name === 'queue_clear' && args?.status === 'all') {
      const n = queue.list().length;
      if (!n) return say('The queue is already empty.');
      const r = await gate.askPerson('clear', { head: `ChatGPT wants to clear ${n} task${n === 1 ? '' : 's'}`, text: 'Every task in the Bridgerator queue will be removed.', buttons: [['allow', 'Clear', ''], ['deny', 'Keep', 'deny']], secs: 120, auto: 'auto-keep', ...popup() });
      if (r !== 'allow') return { ...say(r === 'cooldown' ? 'Not cleared — the person said no a few minutes ago.' : 'Not cleared — the person at the PC kept the queue.'), notConfirmed: true };
      const gone = queue.clear({ status: 'all' });
      return say(JSON.stringify({ removed: gone.length, counts: queue.counts() }));
    }
    if (queue && QUEUE_TOOL_NAMES.has(name)) return queueTool(queue, name, args);
    const refusal = policy.check(name, args);
    if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true, refused: true };
    // While a question is on the screen, new commands wait for the person's answer.
    if ((name === 'start_process' || name === 'interact_with_process') && gate.pending) await gate.idle();
    // Listed in a plan the person approved on the PC (bridgerator_plan): no question of its own, not counted by the fuse.
    const planned = batch.covers(name, args, gate);
    const stop = planned ? null : await gate.gate(name, args);
    if (stop) return stop;
    // A plain delete command → the Recycle Bin instead (recycle.mjs); other delete commands only count.
    // A command on the PC's blockedCommands list is left to the engine, which refuses it.
    const del = name === 'start_process' && cfg.recycleBin !== false && typeof args?.command === 'string' && !namesBlocked(args.command) ? parseDelete(args.command, engineDir) : null;
    // Under the per-path lock too: snapshot → recycle → commit can't interleave with a call on the same path.
    if (del) return locked(del.targets.map((p) => p.toLowerCase()), () => deleteToBin(del, args, planned));
    const mass = name === 'move_file' ? 1 : (name === 'start_process' || name === 'interact_with_process') && findMatch(name, args, { delete: true }).cat === 'delete' ? 1 : 0;
    if (mass && !planned) { const f = fuseCheck(mass); if (f) return f; }
    // Snapshot → engine call → commit as one step per path: a parallel call on the same file waits,
    // so neither records the other's result as its own "after".
    const changed = snapshots ? changedPaths(name, args).map((x) => ({ ...x, path: absPath(x.path) })) : [];
    return changed.length ? locked(changed.map((x) => x.path.toLowerCase()), () => engineCall(name, args, changed)) : engineCall(name, args, changed);
  }
  async function engineCall(name, args, changed) {
    const pend = changed.length ? await snapshots.capture(name, changed, { task: currentTask(), label: recentTarget(args) }).catch((e) => { log(`[bridgerator] snapshot skipped: ${e.message}`); return null; }) : null;
    let res;
    try {
      // Results are NOT debranded (the user's own file contents), except the engine's own
      // get_prompts / get_config texts (debrandResult).
      res = policy.filter(debrandResult(name, await client.callTool({ name, arguments: args || {} }), VERSION), name, args);
    } catch (e) {
      res = { content: [{ type: 'text', text: engineErrorText(e) }], isError: true };
    }
    const kept = snapshots ? snapshots.commit(pend, !res.isError) : null;
    if (kept) {
      const big = kept.entries.some((e) => e.noCopy === 'big' && e.before.kind === 'file');
      res = { ...res, undoId: kept.id, content: [...(res.content || []), { type: 'text', text: big ? `[Bridgerator: no undo copy — the file is bigger than ${snapCfg().maxFileMb} MB]` : `[Bridgerator: can be undone — bridgerator_undo id ${kept.id}]` }] };
    }
    return res;
  }

  // --- Recycle Bin, mass-action fuse, Undo (LOGIC: critical-logic/bridge.md) ---------------------
  const fuse = createFuse();
  let fuseAsking = false, inFlight = 0, lastCall = 0, wasPaused = false;
  // One notice per stalled "doing" item (id + updatedAt), on unless the person turned it off.
  const stalledWarned = new Set(), started = Date.now();
  if (queue) setInterval(() => {
    if (cfg.notify?.queueStalled === false || inFlight) return;
    const fresh = stalledItems(queue.list('doing'), { now: Date.now(), idleSince: Math.max(lastCall, started) }).filter((it) => !stalledWarned.has(`${it.id}@${it.updatedAt}`));
    for (const it of fresh) stalledWarned.add(`${it.id}@${it.updatedAt}`);
    if (fresh.length) showNotice({ kind: 'queue_stalled', title: fresh[0].title, more: fresh.length - 1 }, log); // one notice per check, not a burst
  }, 60000).unref();
  const fuseCfg = () => ({ ...FUSE_DEFAULTS, ...(cfg.fuse || {}) });
  const setPaused = (v) => { if (out.setPaused) out.setPaused(v); else { out.paused = v; out.onMode(mode()); } };
  const currentTask = () => { const d = queue ? queue.list('doing') : []; return d.length === 1 ? { id: d[0].id, title: d[0].title } : undefined; };
  const recentTarget = (a = {}) => String(a.path ?? a.file_path ?? (a.source ? `${a.source} → ${a.destination}` : a.command ?? '')).slice(0, 300);
  /** n more deletions / moves: over the limit → pause + question on the PC; → the result to return, or null. */
  function fuseCheck(n) {
    const f = fuseCfg();
    if (!f.enabled) return null;
    const total = fuse.take(n, f.limit);
    if (!total) return null;
    log(`[bridgerator] mass-action fuse: ${total} deletions / moves within a minute (limit ${f.limit}) — paused`);
    setPaused(true);
    if (!fuseAsking) {
      fuseAsking = true;
      Promise.resolve(ask({ head: `ChatGPT deleted or moved ${total} files in a minute`, text: 'Bridgerator paused itself. Continue? No answer = it stays paused.', buttons: [['allow', 'Continue', ''], ['deny', 'Keep paused', 'deny']], secs: 300, auto: 'closes', ...popup() }))
        .then((k) => { if (k === 'allow') { fuse.reset(); setPaused(false); } }, (e) => log(`[bridgerator] fuse question failed: ${e?.message || e}`))
        .finally(() => { fuseAsking = false; });
    }
    return { content: [{ type: 'text', text: `Paused: more than ${f.limit} files were deleted or moved within a minute. Bridgerator asked the person on the PC whether to continue; wait for them.` }], isError: true, paused: true };
  }
  // Per-path lock (keys taken all at once, so two calls can never wait on each other in a circle).
  const locks = new Map();
  async function locked(keys, fn) {
    const ks = [...new Set(keys)];
    const before = ks.map((k) => locks.get(k)).filter(Boolean);
    let done;
    const mine = new Promise((r) => { done = r; });
    for (const k of ks) locks.set(k, mine);
    await Promise.all(before);
    try { return await fn(); } finally { done(); for (const k of ks) if (locks.get(k) === mine) locks.delete(k); }
  }
  // The command WORD (first word, and the one after cmd /c), not a path segment or an argument:
  // parseDelete takes one statement only, so these are the only words the engine checks against the list.
  const commandWords = (c) => {
    const out = [];
    let rest = String(c).trim();
    for (let k = 0; k < 2; k++) {
      const m = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s*([\s\S]*)$/.exec(rest);
      if (!m) break;
      out.push(path.win32.basename(m[1] ?? m[2] ?? m[3]).toLowerCase().replace(/\.(exe|com)$/, ''));
      if (out.at(-1) !== 'cmd') break;
      rest = m[4].replace(/^\/[ck]\s+/i, '').replace(/^"/, '');
    }
    return out;
  };
  const namesBlocked = (command) => { const w = commandWords(command); return (cfg.blockedCommands || []).some((b) => typeof b === 'string' && w.includes(b.trim().toLowerCase().replace(/\.(exe|com)$/, ''))); };
  async function deleteToBin(del, args, planned = false) {
    for (const p of del.targets) { const why = policy.writable(p); if (why) return { content: [{ type: 'text', text: why }], isError: true, refused: true }; }
    // Listed in a plan the person approved: not counted by the fuse (like the engine path).
    const f = planned ? null : fuseCheck(del.targets.length);
    if (f) return f;
    const pend = snapshots ? await snapshots.capture('delete', del.targets.map((p) => ({ path: p, role: 'delete' })), { task: currentTask(), label: String(args.command).slice(0, 300) }).catch((e) => { log(`[bridgerator] snapshot skipped: ${e.message}`); return null; }) : null;
    const res = await recycle(del.targets, del.skip ? { skip: del.skip } : undefined);
    const binned = res.filter((x) => x.r === 'recycled').map((x) => x.p);
    const nobin = res.filter((x) => x.r === 'nobin').map((x) => x.p);
    const skipped = res.filter((x) => x.r === 'skipped').map((x) => x.p);
    const failed = res.filter((x) => x.r.startsWith('error')).map((x) => `${x.p} (${x.r.slice(6) || 'error'})`);
    const gone = [], kept = [];
    if (nobin.length) {
      const r = await gate.askPerson('permdelete', { head: `ChatGPT wants to delete ${nobin.length} item${nobin.length === 1 ? '' : 's'} for good`, text: clip(`No Recycle Bin on that drive: ${nobin.join(', ')}`, '', 140), buttons: [['allow', 'Delete', ''], ['deny', 'Keep', 'deny']], secs: 120, auto: 'auto-keep', ...popup() });
      for (const p of nobin) {
        if (r !== 'allow') { kept.push(p); continue; }
        try { fs.rmSync(p, { recursive: true, force: true }); gone.push(p); } catch (e) { failed.push(`${p} (${e.code || e.message})`); }
      }
    }
    const removed = [...binned, ...gone];
    if (pend) {
      pend.entries = pend.entries.filter((e) => removed.includes(e.path));
      // The exact Recycle Bin copy of each item (recycle.ps1): Undo removes that one, never another.
      for (const e of pend.entries) { const bin = res.find((x) => x.p === e.path)?.bin; if (typeof bin === 'string') e.bin = bin; }
    }
    const done = snapshots ? snapshots.commit(pend, removed.length > 0) : null;
    const lines = [];
    if (binned.length) lines.push(`Bridgerator moved ${binned.length} item${binned.length === 1 ? '' : 's'} to the Recycle Bin instead of deleting (the command itself was not run):`, ...binned.map((p) => `  ${p}`));
    if (gone.length) lines.push('Deleted for good after the person\'s OK (no Recycle Bin on that drive):', ...gone.map((p) => `  ${p}`));
    if (kept.length) lines.push('Not deleted: the person at the PC kept them (no Recycle Bin on that drive):', ...kept.map((p) => `  ${p}`));
    if (failed.length) lines.push('Could not delete:', ...failed.map((p) => `  ${p}`));
    if (skipped.length) lines.push('Left alone (hidden, system or read-only — the command itself would skip them without -Force or /a /f):', ...skipped.map((p) => `  ${p}`));
    if (done) lines.push(`Undo: bridgerator_undo id ${done.id} (or restore from the Recycle Bin).`);
    return { content: [{ type: 'text', text: lines.join('\n') }], ...(removed.length ? {} : { isError: true }), ...(kept.length && !removed.length ? { notConfirmed: true } : {}), ...(done ? { undoId: done.id } : {}) };
  }
  // Undo of a Recycle Bin delete restores from the snapshot: the same item then leaves the bin (no duplicate).
  function binCleanup(results) {
    for (const r of results) {
      const a = snapshots.find(r.id);
      if (a?.tool === 'delete' && r.restored.length) { try { purgeFromBin(a.entries.filter((e) => e.bin && r.restored.includes(e.path)).map((e) => ({ path: e.path, bin: e.bin }))); } catch (e) { log(`[bridgerator] Recycle Bin cleanup: ${e.message}`); } }
    }
    return results;
  }
  // bridgerator_undo. The window's Undo (rpc undo.run) skips the folder checks: the person's own choice.
  async function undoTool(args = {}) {
    const live = snapshots.list().filter((a) => !a.undone);
    if (args.action === 'list') return say(JSON.stringify({ changes: live.slice(0, 30).map((a) => ({ id: a.id, time: new Date(a.t).toISOString(), tool: a.tool, what: a.label, ...(a.task ? { task: a.task } : {}), ...(a.noUndo ? { noUndo: true } : {}) })) }, null, 2));
    if (args.action !== undefined && args.action !== 'undo') return say('action must be "undo" or "list"', true);
    const ids = args.id ? [String(args.id)] : args.task ? live.filter((a) => a.task?.id === String(args.task)).map((a) => a.id) : live.slice(0, Number.isInteger(args.count) && args.count > 0 ? Math.min(args.count, 50) : 1).map((a) => a.id);
    if (!ids.length) return say('Nothing to undo: no recorded changes by ChatGPT on this PC.');
    const first = snapshots.find(ids[0])?.entries[0]?.path;
    const stop = first ? await gate.gate('write_file', { path: first }) : null;
    if (stop) return stop;
    const results = binCleanup(snapshots.undoMany(ids, { check: (p) => policy.writable(p) }));
    const restored = results.flatMap((r) => r.restored), skipped = results.flatMap((r) => r.skipped.map((s) => ({ id: r.id, ...s })));
    return say(JSON.stringify({ undone: results.filter((r) => r.restored.length).map((r) => r.id), restored, skipped }, null, 2), !restored.length);
  }
  out.wantAwake = () => wantAwake({ enabled: cfg.keepAwake !== false, inFlight: inFlight + delegate.running, lastCall, queue: queueCounts() });
  // What bridgerator_settings get shows: the names "set" takes.
  const toolView = (s) => {
    const { confirm, telemetry, ...rest } = s;
    return { ...rest, confirm: { enabled: confirm.enabled, ...confirm.ask, timeoutSeconds: confirm.timeoutSec }, telemetryEnabled: telemetry };
  };
  async function readResource(uri) {
    // The old widget URI still works: ChatGPT and the relay's offline list may have cached it.
    if (!resourceUris.has(ourUi(String(uri)))) return { error: 'unknown resource' };
    try { return { result: ourUi(debrand(await client.readResource({ uri: engineUi(uri) }))) }; } catch (e) { return { error: String(e?.message || e) }; }
  }
  // Requests of the Bridgerator window (tray helper). Made by the person at the PC: no extra prompt.
  // Theme for our pop-ups = the window's theme (Settings → Appearance); sound / style from Notifications.
  // lang: the questions on the PC follow the window language (pc-text.mjs, V-3).
  const popup = () => ({ theme: cfg.theme || cfg.popupTheme || 'system', silent: cfg.notify?.sound === false, style: cfg.popupStyle === 'popup' ? 'popup' : 'toast', lang: cfg.language === 'ru' ? 'ru' : 'en' });
  out.popup = popup;
  const bannerNow = () => { const b = planBanner(out.plan); return { ...b, visible: bannerVisible(b, cfg.planBannerDismissed) }; };
  out.banner = bannerNow;
  out.onPlanMsg = (m) => { out.plan = readPlan(m); out.onPlan?.(); };
  const BOOL_NOTIFY = ['sound', 'offline', 'queueDone', 'queueStalled', 'settingsChanged', 'limit'];

  // Requests of the Bridgerator window (tray helper). Made by the person at the PC: no extra prompt.
  async function rpc(method, p = {}, paths = []) {
    switch (method) {
      case 'getState': {
        const conf = gate.settings();
        return {
          state: out.paused ? 'paused' : out.linkState, name: cfg.deviceName || out.linkName, version: VERSION, paused: out.paused,
          email: out.email || '', plan: out.plan || null, banner: bannerNow(), setupDone: cfg.setupDone === true, allowOpened: cfg.chatgptAllowOpened === true,
          settings: {
            confirm: conf, allowedDirectories: cfg.allowedDirectories || [], readOnlyDirectories: cfg.readOnlyDirectories || [],
            theme: popup().theme, language: cfg.language || 'en', localHistory: cfg.localHistory === true, telemetry: cfg.telemetryEnabled !== false,
            popupStyle: popup().style, notify: Object.fromEntries(BOOL_NOTIFY.map((k) => [k, cfg.notify?.[k] !== false])),
            autostart: cfg.autostart !== false, deviceName: cfg.deviceName || out.linkName || '',
            preset: presetOf(accessState(), drives()), terminal: terminalOn(), protectSensitive: cfg.protectSensitive !== false,
            recycleBin: cfg.recycleBin !== false, snapshots: snapCfg(), fuse: fuseCfg(), keepAwake: cfg.keepAwake !== false, askSettings: cfg.askSettings === true,
            ...extra.values(cfg),
          },
          // Labels of the extra tools' settings for the window (Settings → Tools): extra-tools.mjs.
          extraSettings: extra.settings.map((s) => ({ key: s.key, label: s.label, hint: s.hint, default: s.default, value: extra.value(cfg, s.key), ...(s.page ? { page: s.page } : {}) })),
          awake: { want: out.wantAwake(), on: !!out.power?.on, ac: out.power ? out.power.ac !== false : true },
          undo: snapshots ? { count: snapshots.count, mb: Math.round((snapshots.bytes / 1048576) * 10) / 10 } : null,
          queue: queue ? queue.counts() : {},
          pendingSetup: pendingSetup ? { id: pendingSetup.id, lines: pendingSetup.lines } : null,
          automations: autos ? autos.list() : null, pendingBatch: batch.pending(), usage: forecast(out.plan), agents: delegate.view(cfg),
        };
      }
      case 'batch.decide': return batch.decide(String(p.id), p.allow);
      case 'delegate.detect': case 'delegate.get': case 'delegate.cancel': return delegateRpc(delegate, method, p);
      case 'automation.list': case 'automation.get': case 'automation.run': case 'automation.enable': case 'automation.remove': case 'automation.restore': return automationRpc(autos, method, p);
      case 'setup.decide': if (pendingSetup && p.id === pendingSetup.id) pendingSetup.resolve(p.apply === true ? 'allow' : 'deny'); return true;
      case 'setSetting': {
        const { key, value } = p;
        // Who changed it, for the log: the AI (bridgerator_settings), the settings file, or the window.
        const via = ['bridgerator_settings', 'settings file'].includes(p.via) ? p.via : 'Bridgerator window';
        const m = /^confirm\.(enabled|[a-z_]+)$/.exec(String(key));
        // confirm.ini held by another program (V-9): nothing changes, the person is told (notice + the window's message).
        const iniWrite = (sec, k, v) => { try { setIni(cfg.confirmIni, sec, k, v); } catch (e) { log(`[bridgerator] confirm.ini not written (${e.code || e.message}) — setting unchanged`); showNotice({ kind: 'confirm_locked' }, log); throw new Error('CONFIRM_LOCKED'); } };
        if (m && (m[1] === 'enabled' || CATEGORIES.includes(m[1])) && typeof value === 'boolean') { iniWrite(m[1] === 'enabled' ? 'confirm' : 'ask', m[1], String(value)); gate.accept({ [m[1]]: value }); return true; }
        if (key === 'confirm.timeout' && [60, 120, 300].includes(value)) { iniWrite('confirm', 'timeout_seconds', String(value)); return true; }
        if (key === 'allowedDirectories' || key === 'readOnlyDirectories') {
          const v = validateSetup({ [key]: value });
          if (v.error && !(key === 'readOnlyDirectories' && Array.isArray(value) && !value.length)) throw new Error(v.error);
          await applyValues(v.value || { readOnlyDirectories: [] }, via); return true;
        }
        if (key === 'theme' && ['light', 'dark', 'system'].includes(value)) { patchConfig({ theme: value }); return true; }
        if (key === 'language' && ['en', 'ru'].includes(value)) { patchConfig({ language: value }); return true; }
        if (key === 'localHistory' && typeof value === 'boolean') { patchConfig({ localHistory: value }); recent.setKeep(value); return true; }
        if (key === 'telemetryEnabled' && typeof value === 'boolean') { patchConfig({ telemetryEnabled: value }); return true; }
        if (key === 'popupStyle' && ['toast', 'popup'].includes(value)) { patchConfig({ popupStyle: value }); return true; }
        const n = /^notify\.(\w+)$/.exec(String(key));
        if (n && BOOL_NOTIFY.includes(n[1]) && typeof value === 'boolean') { patchConfig({ notify: { ...(cfg.notify || {}), [n[1]]: value } }); return true; }
        // The new name goes to the relay too (mode message; the relay renames the computer in the account).
        if (key === 'deviceName' && typeof value === 'string' && value.trim().length <= 40) { patchConfig({ deviceName: value.trim() || undefined, namePending: value.trim() || undefined }); out.namePending = value.trim(); out.nameGen++; out.onMode({ ...mode(), ...(value.trim() ? { deviceName: value.trim() } : {}) }); return true; }
        if (key === 'autostart' && typeof value === 'boolean' && out.hooks?.autostart) { await out.hooks.autostart(value); patchConfig({ autostart: value }); return true; }
        if (key === 'preset' && ['read_only', 'files', 'full'].includes(value)) { for (const c of presetChanges(value, accessState(), drives())) await rpc('setSetting', { ...c, via }); return true; }
        if (key === 'terminal' && typeof value === 'boolean') { patchConfig({ disabledTools: terminalTools(cfg.disabledTools, value) }); policy = makePolicy(); out.onMode(mode()); return true; }
        if (key === 'protectSensitive' && typeof value === 'boolean') { patchConfig({ protectSensitive: value }); policy = makePolicy(); return true; }
        if ((key === 'recycleBin' || key === 'keepAwake' || key === 'askSettings') && typeof value === 'boolean') { patchConfig({ [key]: value }); return true; }
        const g = /^(snapshots|fuse)\.(\w+)$/.exec(String(key));
        if (g) {
          const v = validateSettings({ [g[1]]: { [g[2]]: value } });
          if (v.error) throw new Error(v.error);
          patchConfig({ [g[1]]: { ...(g[1] === 'fuse' ? fuseCfg() : snapCfg()), [g[2]]: value } });
          if (g[1] === 'snapshots') snapshots?.prune(); else fuse.reset();
          return true;
        }
        if (extra.set(cfg, key, value, patchConfig)) return true;
        throw new Error(`unknown setting ${key}`);
      }
      case 'queue.list': return queue.list(p.status);
      case 'queue.add': return queue.add({ ...p, ...(paths.length ? { paths: [...(p.paths || []), ...paths] } : {}) });
      case 'queue.edit': return queue.edit(p);
      case 'queue.update': return queue.update(p);
      case 'queue.reorder': return queue.reorder(p);
      case 'queue.remove': return queue.remove(p);
      case 'queue.restore': return queue.restore(p);
      case 'queue.clearFinished': return queue.clearFinished();
      case 'queue.clear': return queue.clear({ status: p.status });
      case 'queue.restoreMany': return queue.restoreMany(p);
      case 'recent.list': return recent.list();
      case 'recent.clear': recent.clear(); return true;
      case 'undo.list': { const list = snapshots ? snapshots.list() : []; return { actions: list.slice(0, 300), groups: undoGroups(list).slice(0, 30), count: list.length, mb: snapshots ? Math.round((snapshots.bytes / 1048576) * 10) / 10 : 0 }; }
      case 'undo.run': {
        if (!snapshots) throw new Error('Undo is off');
        const ids = (Array.isArray(p.ids) ? p.ids : []).filter((x) => typeof x === 'string').slice(0, 500);
        const r = binCleanup(snapshots.undoMany(ids));
        return { restored: r.flatMap((x) => x.restored), skipped: r.flatMap((x) => x.skipped) };
      }
      case 'undo.clear': snapshots?.clear(); return true;
      case 'chatgptAllowOpened': patchConfig({ chatgptAllowOpened: true }); return true;
      case 'dismissBanner': { const b = planBanner(out.plan); if (b.dismissible) patchConfig({ planBannerDismissed: dismissFor(b) }); out.onPlan?.(); return true; }
      case 'testNotification': return ask({ head: 'Test notification', text: 'This is how Bridgerator asks before risky actions. Nothing will run.', buttons: [['allow', 'Allow', ''], ['allow10', 'Allow 10 min', ''], ['always', 'Allow always', ''], ['deny', 'Deny', 'deny']], secs: 60, auto: 'closes', ...popup() });
      case 'checkUpdate': {
        // The download list on our own site (what the installer would install), not npm.
        const r = await fetch(`${siteOf(cfg.relay)}/bridgerator-win.json`, { signal: AbortSignal.timeout(10000) });
        const latest = String((await r.json()).version || '');
        const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
        return { latest, current: VERSION, upToDate: !newer(latest, VERSION) };
      }
      case 'update': {
        // Owner 21.10: no console for the person. Our own signed installer from our own site, hidden; it stops
        // this bridge and starts the new one. The new version says "updated" (updatingFrom, kept by setup).
        const site = siteOf(cfg.relay);
        if (!/^https:\/\//.test(site)) throw new Error('no https site to update from');
        patchConfig({ updatingFrom: VERSION });
        showNotice({ kind: 'updating', version: String(p.version || '') }, log);
        const ps = spawn(POWERSHELL, psArgs(`& ([scriptblock]::Create((Invoke-RestMethod '${site.replace(/'/g, "''")}/install.ps1')))`), { windowsHide: true, stdio: 'ignore', env: stripOurs(process.env) });
        ps.on('error', (e) => log(`[bridgerator] update did not start: ${e.message}`));
        ps.unref();
        return true;
      }
      case 'pause': out.setPaused?.(true); return true;
      case 'resume': out.setPaused?.(false); return true;
      case 'unlink': if (!out.hooks?.unlink) throw new Error('not available'); setTimeout(() => out.hooks.unlink(), 300); return true;
      case 'uninstall': if (!out.hooks?.uninstall) throw new Error('not available'); setTimeout(() => out.hooks.uninstall(), 300); return true;
      default: throw new Error(`unknown request ${method}`);
    }
  }
  // --- config.json changed outside the bridge (hand edit, CLI, a script) ------------------------------
  // LOGIC: critical-logic/bridge.md ("Settings file"). Shown in the window within a second or two;
  // lowering protection / widening access applies only after Apply on the PC ("Keep" writes the
  // applied values back) — the same rule as confirm.ini (confirm.mjs createGate).
  let reconciling = Promise.resolve();
  async function reconcile(j) {
    const cur = (await rpc('getState')).settings;
    const changes = [];
    const want = (key, v, now) => { if (JSON.stringify(v) !== JSON.stringify(now)) changes.push({ key, value: v }); };
    const list = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string') : []);
    want('allowedDirectories', list(j.allowedDirectories), cur.allowedDirectories);
    want('readOnlyDirectories', list(j.readOnlyDirectories), cur.readOnlyDirectories);
    want('terminal', !list(j.disabledTools).includes('start_process'), cur.terminal);
    for (const k of ['protectSensitive', 'recycleBin', 'keepAwake']) want(k, j[k] !== false, cur[k]);
    want('askSettings', j.askSettings === true, cur.askSettings === true);
    want('localHistory', j.localHistory === true, cur.localHistory);
    want('telemetryEnabled', j.telemetryEnabled !== false, cur.telemetry);
    want('theme', j.theme || j.popupTheme || 'system', cur.theme);
    want('language', j.language || 'en', cur.language);
    want('popupStyle', j.popupStyle === 'popup' ? 'popup' : 'toast', cur.popupStyle);
    for (const k of BOOL_NOTIFY) want(`notify.${k}`, j.notify?.[k] !== false, cur.notify[k]);
    want('deviceName', String(j.deviceName || ''), String(cfg.deviceName || ''));
    for (const s of extra.settings) want(s.key, extra.value(j, s.key), extra.value(cfg, s.key));
    for (const [g, d, now] of [['snapshots', SNAP_DEFAULTS, snapCfg()], ['fuse', FUSE_DEFAULTS, fuseCfg()]]) {
      const f = { ...d, ...(j[g] && typeof j[g] === 'object' ? j[g] : {}) };
      for (const k of Object.keys(d)) want(`${g}.${k}`, f[k], now[k]);
    }
    const den = list(j.deniedDirectories), denNow = cfg.deniedDirectories || [];
    const denRemoved = denNow.filter((x) => !den.some((y) => y.toLowerCase() === x.toLowerCase()));
    if (!changes.length && JSON.stringify(den) === JSON.stringify(denNow)) return;
    // Owner 26.10: a file edit applies at once like an AI change; Apply on the PC only with askSettings on.
    const ask1 = (c) => cfg.askSettings === true && widens(cur, c);
    const risky = changes.filter(ask1), safe = changes.filter((c) => !ask1(c));
    // Excluded folders are never AI-editable (bridgerator_settings / setup can't touch them): removing one from the file always asks.
    const denAsk = denRemoved.length > 0;
    const on = cfg.notify?.settingsChanged !== false;
    const back = {};
    const top = (key) => (key === 'terminal' ? 'disabledTools' : key.split('.')[0]);
    for (const c of safe) { try { await rpc('setSetting', { ...c, via: 'settings file' }); } catch (e) { log(`[bridgerator] settings file: ${c.key} not applied (${e.message})`); back[top(c.key)] = cfg[top(c.key)]; } }
    if (!denAsk) { cfg.deniedDirectories = den; policy = makePolicy(); }
    const denLine = denRemoved.length ? [`Excluded folders: ${denRemoved.map((x) => `−${x}`).join(', ')}`] : [];
    toldSettings('file', safe.filter((c) => !(top(c.key) in back)).map((c) => describe(cur, c)), on);
    const lines = [...risky.map((c) => describe(cur, c)), ...(denAsk ? denLine : [])];
    if (lines.length) {
      const r = await gate.askPerson('file', { head: 'Bridgerator settings file changed', text: clip(`Apply: ${lines.join(' · ')}?`, '', 180), buttons: [['allow', 'Apply', ''], ['deny', 'Keep', 'deny']], secs: 120, auto: 'auto-keep', ...popup() });
      if (r === 'allow') {
        for (const c of risky) { try { await rpc('setSetting', { ...c, via: 'settings file' }); } catch (e) { log(`[bridgerator] settings file: ${c.key} not applied (${e.message})`); back[top(c.key)] = cfg[top(c.key)]; } }
        if (denAsk) { cfg.deniedDirectories = den; policy = makePolicy(); }
        toldSettings('file', [...risky.filter((c) => !(top(c.key) in back)).map((c) => describe(cur, c)), ...(denRemoved.length ? denLine : [])], on);
        log(`[bridgerator] settings file change applied on the PC: ${lines.join('; ')}`);
      } else {
        for (const c of risky) back[top(c.key)] = cfg[top(c.key)];
        if (denAsk) back.deniedDirectories = denNow;
        log(`[bridgerator] settings file change kept out (${r}): ${lines.join('; ')}`);
      }
    }
    if (Object.keys(back).length) patchConfig(back);
    out.onMode(mode());
  }
  const onConfigFile = () => {
    const text = readText(cfg.configFile);
    if (text === null || text === ownText) return;
    let j;
    try { j = JSON.parse(text); } catch { log('[bridgerator] config.json is not valid JSON — keeping the applied settings'); return; }
    ownText = text;
    reconciling = reconciling.then(() => reconcile(j)).catch((e) => log(`[bridgerator] settings file change not applied: ${e?.message || e}`));
  };
  if (cfg.configFile) { ownText = readText(cfg.configFile); fs.watchFile(cfg.configFile, { interval: 1000, persistent: false }, onConfigFile); out.checkConfig = onConfigFile; }
  out.settled = () => reconciling;

  return Object.assign(out, { client, tools: visible, resources, call, rpc, readResource, engineErr, mode, queue, recent, snapshots, close: () => { closing = true; stopAutos?.(); delegate.stop(); if (cfg.configFile) fs.unwatchFile(cfg.configFile, onConfigFile); return client.close(); } });
}

// The bridge never runs with TLS checks turned off, and neither does its engine child.
export function cleanEnv(env = process.env) {
  const e = { ...env };
  // Windows variable names are case-insensitive: node_tls_reject_unauthorized works there too.
  for (const k of Object.keys(e)) if (k.toUpperCase() === 'NODE_TLS_REJECT_UNAUTHORIZED') delete e[k];
  return e;
}
/** cleanEnv without any BRIDGERATOR_* / BR_* variables (test hooks, our paths). */
export function engineEnv(env = process.env) {
  const e = cleanEnv(env);
  for (const k of Object.keys(e)) if (/^(BRIDGERATOR_|BR_)/i.test(k)) delete e[k];
  // The terminal's PowerShell may run .ps1 (npm.ps1, npx.ps1…): Windows' default "Restricted" blocks them (26.10, a user's
  // PC). Process scope only — the PC's own policy is never changed, a Group Policy still wins, a value the person set stays.
  if (!Object.keys(e).some((k) => k.toLowerCase() === 'psexecutionpolicypreference')) e.PSExecutionPolicyPreference = 'Bypass';
  return e;
}
export function engineCwd(cfg, home = os.homedir()) {
  for (const d of cfg.allowedDirectories || []) { try { if (fs.statSync(d).isDirectory()) return d; } catch { /* missing */ } }
  return home;
}

export const checkRelay = (url) => {
  if (!/^wss:\/\/[^\s/]+/i.test(String(url || ''))) throw new Error(`relay must be a wss:// address, got "${url}"`);
  return url;
};

// 4004 = another bridge with this key took the link: wait longer each time (1 min … 30 min).
let replaced = 0, toldReplaced = false, stats = null, linkedAt = 0;
const REPLACED_RESET_MS = 60 * 60000;
const events = createEventLimiter(); // one per bridge process, across reconnects
export const replacedDelay = (n) => Math.min(60000 * 2 ** Math.max(0, n - 1), 30 * 60000);

export function connect(cfg, dc, log = console.log) {
  checkRelay(cfg.relay);
  try { setSite(siteOf(cfg.relay)); } catch { /* checked above */ }
  // Heartbeat counters (telemetry.mjs) — only when telemetry is on.
  if (!stats && cfg.usageFile && cfg.installId && cfg.telemetryEnabled !== false) {
    stats = usage(cfg, new Set(dc.tools.map((t) => t.name)), cfg.usageFile);
    setInterval(() => stats.tick(), 3600 * 1000).unref();
    const inner = dc.call;
    dc.call = async (name, args) => { const r = await inner(name, args); stats.count(name, !!r?.isError); return r; };
  }
  const ws = new WebSocket(cfg.relay, { handshakeTimeout: 15000, maxPayload: 4 * 1024 * 1024 });
  let helloName = '', helloGen = 0;
  const nameSent = (n) => { if (dc.nameSent) dc.nameSent(n); else if (dc.namePending === n) dc.namePending = ''; };
  // Live mode updates ({confirm, readOnly}) go over the current link.
  // A name given on this PC reaches the relay in this mode message; offline it waits for the next hello.
  dc.onMode = (m) => { if (ws.readyState === ws.OPEN) { ws.send(JSON.stringify({ type: 'mode', ...m })); if (typeof m.deviceName === 'string') nameSent(m.deviceName); } };
  // Events for the relay's notifications (Telegram…): counts / status only, never names or contents.
  dc.onEvent = (e) => {
    const m = eventMessage(e);
    if (!m || ws.readyState !== ws.OPEN) return;
    if (!events.take()) { if (!dc.eventsDropped) log('[bridgerator] more than 30 notifications a minute for the relay — the rest are dropped'); dc.eventsDropped = true; return; }
    dc.eventsDropped = false;
    ws.send(JSON.stringify(m));
  };
  let alive = false, seen = Date.now();
  const touch = () => { seen = Date.now(); };
  const watch = setInterval(() => { dc.mode?.(); if (Date.now() - seen > SILENT_MS) { log('[bridgerator] relay silent for 75s'); ws.terminate(); } }, 15000);
  ws.on('ping', touch);
  ws.on('pong', touch);
  ws.on('open', () => {
    alive = true;
    touch();
    // deviceName: only a name given on this PC while it was offline (not yet sent) — the relay renames the
    // computer. Never on every hello: that would undo a rename made in the cabinet at each reconnect.
    // Cleared only when the relay accepts this hello (welcome): a dropped / refused link sends it again.
    helloName = dc.namePending ? String(dc.namePending) : '';
    helloGen = dc.nameGen;
    ws.send(JSON.stringify({ type: 'hello', token: cfg.token, tools: dc.tools, resources: dc.resources, ...(dc.mode ? dc.mode() : {}), ...(helloName ? { deviceName: helloName } : {}) }));
    log('[bridgerator] linked to relay, waiting for calls');
  });
  ws.on('message', (raw) => { onMessage(raw).catch((e) => log(`[bridgerator] message failed: ${e?.message || e}`)); });
  async function onMessage(raw) {
    touch();
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'welcome') {
      if (helloName) { nameSent(helloName); helloName = ''; }
      dc.relayName?.(String(msg.device ?? ''), helloGen);
      // The 4004 back-off is NOT reset here: two bridges with one key would otherwise swap the link
      // every minute forever. It resets only after the link stayed ours for REPLACED_RESET_MS.
      linkedAt = Date.now(); log(`[bridgerator] registered as "${msg.device}"`);
      if (typeof msg.email === 'string' && msg.email.length < 200) dc.email = msg.email;
      if (msg.plan && typeof msg.plan === 'object') dc.onPlanMsg?.(msg.plan);
      dc.onLink?.('online', String(msg.device || ''));
      return;
    }
    if (msg.type === 'notice') {
      if (msg.kind === 'settings_changed') return; // the bridge's own notice, never from the relay
      if (['limit', 'expiring', 'expired'].includes(msg.kind) && cfg.notify?.limit === false) return;
      showNotice({ ...msg, renewUrl: msg.renewUrl ?? dc.plan?.renewUrl }, log);
      return;
    }
    if (msg.type === 'plan') { dc.onPlanMsg?.(msg); return; }
    if (msg.type === 'read_resource' && msg.callId) {
      const r = await dc.readResource(msg.uri);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'result', callId: msg.callId, ...r }));
      return;
    }
    if (msg.type !== 'call' || !msg.callId || typeof msg.name !== 'string') return;
    let result;
    try { result = await dc.call(msg.name, msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args) ? msg.args : {}); } catch (e) { result = { content: [{ type: 'text', text: `bridge error: ${e?.message || e}` }], isError: true }; }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'result', callId: msg.callId, result }));
  }
  const die = (why, ms = RECONNECT_MS) => {
    if (ws._down) return;
    ws._down = true;
    clearInterval(watch);
    log(`[bridgerator] disconnected (${why}); reconnecting in ${Math.round(ms / 1000)}s`);
    setTimeout(() => connect(cfg, dc, log), ms);
  };
  ws.on('close', (code) => {
    clearInterval(watch);
    dc.onLink?.('offline');
    // Exit 0 = done on purpose: the autostart loop (run-hidden.vbs) does not restart it.
    if (code === 4003) {
      log(`[bridgerator] This computer is no longer linked to your Bridgerator account. Run the install command from ${accountUrl()} again.`);
      ws._down = true;
      showNotice({ kind: 'unlinked' }, log, () => process.exit(0));
      return;
    }
    if (code === 4004) {
      if (!toldReplaced) { toldReplaced = true; showNotice({ kind: 'replaced' }, log); }
      if (linkedAt && Date.now() - linkedAt > REPLACED_RESET_MS) replaced = 0;
      linkedAt = 0;
      die('another Bridgerator with this computer\'s key took over the link', replacedDelay(++replaced));
      return;
    }
    die(`close ${code}`);
  });
  ws.on('error', (e) => { if (!alive) die(`connect: ${e.message}`); });
  return ws;
}
