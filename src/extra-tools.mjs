// LOGIC: see critical-logic/bridge.md ("Extra tools"). The ONE list of the bridge's own extra tools.
// bridge.mjs only asks this registry: defs (hello), has(name), call(name, args, ctx), settings.
//
// A module is { defs, handle, settings? }:
//   defs:     MCP tool definitions [{ name, title?, description, inputSchema, annotations }]
//             (few tools with an `action` parameter; short, non-imperative descriptions; honest hints).
//   handle:   async (name, args, ctx) → MCP result { content: [...], isError? }.
//             Throw a ToolError (tool-lib.mjs) for a plain-words refusal; any other throw becomes a
//             short message without a stack (registry `call`).
//   settings: optional [{ key: 'group.name', default: boolean, widensWhen: true|false, label: { en, ru }, hint?: { en, ru }, page? }]
//             — stored in config.json as { group: { name: value } }; shown in the window and readable /
//             settable through bridgerator_settings (`widensWhen` = the value that lowers protection or
//             widens access → the person's OK on the PC). Booleans by default; also
//             { type: 'int', min, max } and { type: 'enum', values: [narrow … wide] } with
//             widensWhen 'up' | 'down' | null (a bigger / smaller value widens; null = never asks).
//             page: the window page that shows it (then not in Settings → Tools).
//
// ctx (built by bridge.mjs per call): { cfg, policy, gate, log, popup, engine(name, args), rpc(method, p), version }
//   ctx.policy is the CURRENT policy (folders can change at runtime); path checks: tool-lib.mjs guard().
// Format is fixed: other modules are added by appending to EXTRA_MODULES, nothing else changes.
import { errorText } from './tool-lib.mjs';
import { addRuLabels } from './pc-text.mjs';
import * as doctor from './doctor.mjs';
import * as docs from './docs-tool.mjs';
import * as search from './search-tool.mjs';
import * as photos from './photos-tool.mjs';
import * as software from './software-tool.mjs';
import * as pcinfo from './pc-check.mjs';
import * as screen from './screen-tool.mjs';
import * as automations from './automations.mjs';
import * as plans from './batch.mjs';
import * as delegate from './delegate.mjs';

export const EXTRA_MODULES = [doctor, docs, search, photos, software, pcinfo, screen, automations, plans, delegate];

/** The registry of EXTRA_MODULES (settings-tool.mjs reads the settings part of it). */
export const extraRegistry = () => (shared ||= createExtra());
let shared = null;

// Typed settings (int / enum) next to the booleans: validation, order for the widen check, schema.
const kind = (s) => s.type || 'boolean';
const valid = (s, v) => (kind(s) === 'int' ? Number.isInteger(v) && v >= s.min && v <= s.max : kind(s) === 'enum' ? s.values.includes(v) : typeof v === 'boolean');
const need = (s) => (kind(s) === 'int' ? `a whole number from ${s.min} to ${s.max}` : kind(s) === 'enum' ? `one of ${s.values.join(', ')}` : 'true or false');
const rank = (s, v) => (kind(s) === 'enum' ? s.values.indexOf(v) : Number(v));

export function createExtra(mods = EXTRA_MODULES) {
  const owner = new Map();
  for (const m of mods) for (const d of m.defs || []) { if (owner.has(d.name)) throw new Error(`extra tool ${d.name} registered twice`); owner.set(d.name, m); }
  const settings = mods.flatMap((m) => m.settings || []);
  const byKey = new Map(settings.map((s) => [s.key, s]));
  addRuLabels(Object.fromEntries(settings.filter((s) => s.label?.en && s.label?.ru).map((s) => [s.label.en, s.label.ru])));
  const get = (cfg, key) => { const [g, k] = key.split('.'); const v = cfg?.[g]?.[k]; return valid(byKey.get(key), v) ? v : byKey.get(key).default; };
  return {
    defs: mods.flatMap((m) => m.defs || []),
    has: (name) => owner.has(name),
    async call(name, args, ctx) {
      // A tool the person turned off (config disabledTools) is refused like the engine's own.
      if (ctx?.policy && !ctx.policy.visible({ name })) return { content: [{ type: 'text', text: `Tool "${name}" is disabled on this computer.` }], isError: true, refused: true };
      try {
        return await owner.get(name).handle(name, args && typeof args === 'object' && !Array.isArray(args) ? args : {}, ctx);
      } catch (e) {
        ctx?.log?.(`[bridgerator] ${name} failed: ${e?.code || ''} ${e?.message || e}`);
        return { content: [{ type: 'text', text: errorText(e) }], isError: true };
      }
    },
    settings,
    /** Current values: { group: { name: bool } }. */
    values(cfg) {
      const o = {};
      for (const s of settings) { const [g, k] = s.key.split('.'); (o[g] ||= {})[k] = get(cfg, s.key); }
      return o;
    },
    defaults() {
      const o = {};
      for (const s of settings) { const [g, k] = s.key.split('.'); (o[g] ||= {})[k] = s.default; }
      return o;
    },
    value: (cfg, key) => get(cfg, key),
    /** → [{key, value}] from { group: { name: bool } } input, or { error }. Unknown groups → null (not ours). */
    parse(input) {
      const changes = [];
      for (const [g, obj] of Object.entries(input || {})) {
        if (!settings.some((s) => s.key.startsWith(`${g}.`))) continue;
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: `${g} must be an object` };
        for (const [k, v] of Object.entries(obj)) {
          const s = byKey.get(`${g}.${k}`);
          if (!s || !valid(s, v)) return { error: `${g}.${k}: unknown or not ${s ? need(s) : 'true/false'}` };
          changes.push({ key: `${g}.${k}`, value: v });
        }
      }
      return { changes };
    },
    groups: () => [...new Set(settings.map((s) => s.key.split('.')[0]))],
    /** JSON schema for the bridgerator_settings `settings` properties. */
    schema() {
      const o = {};
      for (const s of settings) {
        const [g, k] = s.key.split('.');
        const p = kind(s) === 'int' ? { type: 'integer', minimum: s.min, maximum: s.max, description: `${s.label.en} (default ${s.default})` }
          : kind(s) === 'enum' ? { type: 'string', enum: s.values, description: `${s.label.en} (default ${s.default})` }
          : { type: 'boolean', description: `${s.label.en} (default ${s.default ? 'on' : 'off'})` };
        (o[g] ||= { type: 'object', additionalProperties: false, properties: {} }).properties[k] = p;
      }
      return o;
    },
    owns: (key) => byKey.has(key),
    widens(cfg, { key, value }) {
      const s = byKey.get(key);
      if (!s) return false;
      if (kind(s) === 'boolean') return value === s.widensWhen && get(cfg, key) !== value;
      if (!valid(s, value)) return false;
      return s.widensWhen === 'up' ? rank(s, value) > rank(s, get(cfg, key)) : s.widensWhen === 'down' ? rank(s, value) < rank(s, get(cfg, key)) : false;
    },
    describe: ({ key, value }) => `${byKey.get(key)?.label.en || key}: ${typeof value === 'boolean' ? (value ? 'on' : 'off') : value}`,
    /** Window / AI change → config.json (patch = bridge's patchConfig). true when the key is ours. */
    set(cfg, key, value, patch) {
      if (!byKey.has(key)) return false;
      if (!valid(byKey.get(key), value)) throw new Error(`${key} must be ${need(byKey.get(key))}`);
      const [g, k] = key.split('.');
      patch({ [g]: { ...(cfg[g] || {}), [k]: value } });
      return true;
    },
  };
}
