// The whole product against the owner's rules (critical-logic/decisions.md), not one patch.
// Born from the 27.10 audit (bridgerator-relay/tasks/FINDINGS_2026_10_27_PRODUCT_AUDIT.md): three bugs the
// owner found by hand that no diff review could see — an engine setting with no AI path, a widget that calls a
// hidden tool, a status written for an old rule. Each check below fails when a NEW case of that class appears.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FIELD_KEYS } from 'bridgerator-engine/dist/config-field-definitions.js';
import { SETTINGS_TOOL_DEF } from '../src/settings-tool.mjs';
import { SETUP_TOOL_DEF } from '../src/setup-tool.mjs';
import { CONFIRM_TOOL_DEFS } from '../src/confirm.mjs';
import { QUEUE_TOOL_DEFS } from '../src/queue.mjs';
import { UNDO_TOOL_DEF } from '../src/undo.mjs';
import { createExtra } from '../src/extra-tools.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELAY = path.resolve(ROOT, '..', 'bridgerator-relay');
const files = (dir, re) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, String(f))).filter((f) => re.test(f) && fs.statSync(f).isFile()) : []);
const read = (f) => fs.readFileSync(f, 'utf8');

test('owner 21.10/27.10 "the AI configures everything": every engine setting has a bridgerator_settings key, or a decision says why not', () => {
  const ai = Object.keys(SETTINGS_TOOL_DEF.inputSchema.properties.settings.properties);
  // Not AI settings, by decision (quote the row when adding one here).
  const NOT_AI = {
    telemetryEnabled: 'decisions 20.10: the engine\'s own telemetry to its authors stays OFF (Bridgerator\'s own is telemetryEnabled in bridgerator_settings)',
  };
  const missing = CONFIG_FIELD_KEYS.filter((k) => !ai.includes(k) && !NOT_AI[k]);
  assert.deepEqual(missing, [], 'engine setting(s) the AI cannot change — add them to bridgerator_settings or record a decision');
});

test('every bridgerator_* tool named in a hint or text of the bridge exists', () => {
  const names = new Set([SETTINGS_TOOL_DEF, SETUP_TOOL_DEF, UNDO_TOOL_DEF, ...CONFIRM_TOOL_DEFS, ...QUEUE_TOOL_DEFS, ...createExtra().defs].map((t) => t.name));
  const bad = [];
  for (const f of files(path.join(ROOT, 'src'), /\.mjs$/)) {
    for (const m of read(f).matchAll(/\bbridgerator_[a-z_]+\b/g)) if (!names.has(m[0])) bad.push(`${path.basename(f)}: ${m[0]}`);
  }
  assert.deepEqual([...new Set(bad)], []);
});

test('AI-facing hints point to a tool, not to the person at the PC typing a command', () => {
  for (const f of files(path.join(ROOT, 'src'), /\.mjs$/)) {
    assert.doesNotMatch(read(f), /run "bridgerator doctor" on the PC|the person can run 'bridgerator doctor'/, `${path.basename(f)}: the AI has bridgerator_doctor`);
  }
});

// Texts written for a rule that no longer holds. Each pattern names the decision that retired it.
const STALE = [
  [/asks a few questions|задаст пару вопросов|suggests settings; you confirm/, '21.10: no interview, settings apply at once'],
  [/Setup: not done|Настройка: не сделана/, '27.10: the defaults are a finished setup'],
  [/(and say|In ChatGPT, say|скажите):?\s*[«"“]?Set up Bridgerator/i, '21.10/27.10: nothing to set up — "Set up Bridgerator" is not a required step'],
  [/apps menu|меню приложений/, '21.10: ChatGPT Apps are Plugins now'],
  [/ChatGPT suggests Bridgerator settings|ChatGPT предлагает настройки/, '21.10: the AI changes settings, it does not propose them'],
  [/always-blocked credential folders/, '21.10: .ssh/.aws are "Protect sensitive folders", off by default'],
];
test('no user- or AI-visible text contradicts a current decision (stale wording guard)', () => {
  const where = [
    ...files(path.join(ROOT, 'src'), /\.(mjs|ps1)$/), ...files(path.join(ROOT, 'ui'), /\.(js|json|html)$/),
    ...files(path.join(RELAY, 'src'), /\.js$/), ...files(path.join(RELAY, 'site', 'pages'), /\.html$/),
  ];
  assert.ok(where.length > 20, 'scanned the sources');
  const hits = [];
  for (const f of where) { const s = read(f); for (const [re, why] of STALE) if (re.test(s)) hits.push(`${path.relative(path.dirname(ROOT), f)} ~ ${re} (${why})`); }
  assert.deepEqual(hits, []);
});
