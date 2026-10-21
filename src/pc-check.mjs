// LOGIC: see critical-logic/bridge.md ("PC check"). One-command, read-only PC health: disks (space,
// drive health), event log errors of the last days (grouped), startup programs, devices with driver
// problems, Windows updates, load and memory. Facts come from pc-check.ps1 (CIM classes, Get-WinEvent
// by Level/Id, registry) — numbers and ids, any Windows language; this file turns them into findings.
// A part that could not be read is reported as not checked, never as "fine".
import { fileURLToPath } from 'node:url';
import { psJson, json, needAction, int } from './tool-lib.mjs';

const PS = fileURLToPath(new URL('./pc-check.ps1', import.meta.url));
const ALL = ['disks', 'events', 'startup', 'drivers', 'updates', 'load'];
const GB = 1024 ** 3;
// MSFT_PhysicalDisk numbers.
const HEALTH = { 0: 'healthy', 1: 'warning', 2: 'unhealthy', 5: 'unknown' };
const MEDIA = { 0: 'unspecified', 3: 'HDD', 4: 'SSD', 5: 'SCM' };
// Win32_PnPEntity ConfigManagerErrorCode → plain words.
const DEVICE = {
  1: 'not configured correctly', 3: 'driver may be damaged or memory is low', 10: 'cannot start', 12: 'not enough free resources',
  14: 'needs a restart', 18: 'drivers need reinstalling', 19: 'registry data is damaged', 21: 'being removed', 22: 'disabled', 24: 'not present or not working',
  28: 'no driver installed', 29: 'disabled in firmware', 31: 'not working (driver could not load)', 32: 'driver service disabled', 37: 'driver failed to start',
  39: 'driver missing or damaged', 43: 'stopped and reported a problem (code 43)', 45: 'not connected', 47: 'prepared for safe removal', 48: 'blocked (known problems)', 52: 'driver signature cannot be verified',
};

/** Facts → { findings: [{ level: problem|warning|info|not_checked, area, text }], ...facts trimmed }. */
export function analyze(f, now = Date.now()) {
  // PowerShell unrolls a list returned from a scriptblock: none → {} and one → the item itself. Normalize both (pc-check.ps1 also returns ,@()).
  for (const k of ['startup', 'drivers']) { const v = f[k]; if (k in f && !Array.isArray(v) && !v?.error) f = { ...f, [k]: v && Object.keys(v).length ? [v] : [] }; }
  const out = [];
  const add = (level, area, text) => out.push({ level, area, text });
  const nc = (area, v) => { if (v && !Array.isArray(v) && v.error) { add('not_checked', area, `Could not read: ${v.error}`); return true; } return false; };
  if (f.disks && !nc('disks', f.disks)) {
    for (const v of f.disks.volumes || []) {
      if (!v.size) continue;
      const pct = (v.free / v.size) * 100;
      const txt = `${v.drive} ${(v.free / GB).toFixed(1)} GB free of ${(v.size / GB).toFixed(0)} GB (${pct.toFixed(0)} %)`;
      if (v.free < 2 * GB || pct < 5) add('problem', 'disks', `${txt} — almost full`);
      else if (v.free < 10 * GB || pct < 10) add('warning', 'disks', `${txt} — getting full`);
      else add('info', 'disks', txt);
    }
    if (nc('disks', f.disks.physical)) { /* reported */ } else for (const p of f.disks.physical || []) {
      const h = HEALTH[p.health] || 'unknown';
      add(h === 'healthy' ? 'info' : h === 'unknown' ? 'not_checked' : 'problem', 'disks', `Drive "${p.name}" (${MEDIA[p.media] || 'disk'}): health ${h}${h === 'unhealthy' || h === 'warning' ? ' — back up important files and plan a replacement' : ''}`);
    }
  }
  if (f.events && !nc('events', f.events)) {
    const e = f.events;
    if (!e.total) add('info', 'events', `No errors in the System and Application logs in the last ${e.days} days`);
    else {
      add(e.critical ? 'warning' : 'info', 'events', `${e.total} errors${e.critical ? `, ${e.critical} critical` : ''} in the last ${e.days} days (the most frequent are listed in "events")`);
      // Event 41 Kernel-Power = the PC was not shut down cleanly (power loss, freeze, forced off).
      // Counted by pc-check.ps1 over all events (kernelPower); older facts: only the listed groups.
      const kp = Number.isInteger(e.kernelPower) ? e.kernelPower : (e.groups || []).find((g) => g.id === 41 && /Kernel-Power/i.test(g.source))?.count || 0;
      if (kp) add('warning', 'events', `The PC turned off unexpectedly ${kp} time(s) (power loss, freeze or holding the power button)`);
    }
  }
  if (f.startup && !nc('startup', f.startup)) {
    const on = f.startup.filter((s) => s.enabled !== false);
    add(on.length > 15 ? 'warning' : 'info', 'startup', `${on.length} programs start with Windows${f.startup.length > on.length ? ` (${f.startup.length - on.length} more turned off)` : ''}${on.length > 15 ? ' — many; turning some off speeds up the start' : ''}`);
  }
  if (f.drivers && !nc('drivers', f.drivers)) {
    const off = f.drivers.filter((d) => d.code === 22), bad = f.drivers.filter((d) => d.code !== 22);
    if (!bad.length) add('info', 'drivers', 'All devices work');
    for (const d of bad) add('problem', 'drivers', `${d.name || d.id}: ${DEVICE[d.code] || `problem code ${d.code}`}`);
    // Code 22 = turned off on purpose (Device Manager → Disable): not a problem.
    if (off.length) add('info', 'drivers', `${off.length} device(s) turned off in Device Manager: ${[...new Set(off.map((d) => d.name || d.id))].slice(0, 5).join(', ')}`);
  }
  if (f.updates && !nc('updates', f.updates)) {
    const u = f.updates;
    const last = (u.recent || [])[0];
    if (last) {
      const age = Math.round((now - Date.parse(last.installed)) / 86400000);
      add(age > 60 ? 'warning' : 'info', 'updates', `Last update installed ${last.installed} (${last.id})${age > 60 ? ` — ${age} days ago, check Windows Update` : ''}`);
    } else add('not_checked', 'updates', 'No installed updates listed');
    if (u.rebootPending) add('warning', 'updates', 'A restart is needed to finish updates');
    if (Array.isArray(u.pending)) add(u.pending.length ? 'warning' : 'info', 'updates', u.pending.length ? `${u.pending.length} updates waiting to be installed` : 'No updates waiting');
    else nc('updates', u.pending);
  }
  if (f.load && !nc('load', f.load)) {
    const l = f.load;
    const used = l.memTotalMb ? Math.round(((l.memTotalMb - l.memFreeMb) / l.memTotalMb) * 100) : null;
    if (used !== null) add(used > 90 ? 'warning' : 'info', 'load', `Memory ${used} % used (${Math.round(l.memFreeMb / 1024 * 10) / 10} GB free of ${Math.round(l.memTotalMb / 1024)} GB)`);
    if (Number.isFinite(l.cpuLoad)) add(l.cpuLoad > 85 ? 'warning' : 'info', 'load', `Processor load ${Math.round(l.cpuLoad)} %`);
    const up = Date.parse(l.bootedAt);
    if (Number.isFinite(up)) { const d = Math.floor((now - up) / 86400000); add(d > 14 ? 'warning' : 'info', 'load', `Running ${d} day(s) since the last restart${d > 14 ? ' — a restart often helps' : ''}`); }
  }
  const order = { problem: 0, warning: 1, not_checked: 2, info: 3 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  return out;
}

export const defs = [{
  name: 'pc_health',
  title: 'PC health check',
  description: 'Read-only health check of this PC. summary: everything at once (disks, event log errors, startup programs, devices with driver problems, Windows updates, memory and load); or one part: disks, events (errors of the last `days`), startup, drivers, updates (pending: true also asks Windows Update for waiting updates — slow), load. Returns findings in plain words plus the details. Changes nothing.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['summary', ...ALL] },
      days: { type: 'integer', minimum: 1, maximum: 30, description: 'events: how many days back (default 3)' },
      pending: { type: 'boolean', description: 'updates: also list updates waiting to be installed (takes up to a few minutes)' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}];

export async function handle(name, args, ctx) {
  const action = needAction(args, defs[0].inputSchema.properties.action.enum);
  const days = int(args, 'days', { min: 1, max: 30, def: 3 });
  const parts = action === 'summary' ? ALL : [action];
  const pending = args.pending === true && parts.includes('updates');
  const facts = await psJson(ctx, { files: [PS], env: { BRX_PARTS: parts.join(','), BRX_DAYS: String(days), BRX_PENDING: pending ? '1' : '' }, timeout: pending ? 300000 : 90000 });
  return json({ action, findings: analyze(facts), details: facts });
}
