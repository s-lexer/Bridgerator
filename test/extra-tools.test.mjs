// The registry of the bridge's own extra tools and their shared helpers: tool definitions stay short
// and honest, names never clash, errors reach the AI in plain words without a stack, the folder rules
// are the same as for the engine's file tools, and the tools' settings work through bridgerator_settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtra, EXTRA_MODULES } from '../src/extra-tools.mjs';
import { ToolError, errorText, guard, excludedInside, freeName, fromClixml, engineErrorText, psJson, runPs } from '../src/tool-lib.mjs';
import { createPolicy } from '../src/policy.mjs';
import { CONFIRM_TOOL_DEFS } from '../src/confirm.mjs';
import { SETUP_TOOL_DEF } from '../src/setup-tool.mjs';
import { SETTINGS_TOOL_DEF, validateSettings, widens, describe, DEFAULTS } from '../src/settings-tool.mjs';
import { QUEUE_TOOL_DEFS } from '../src/queue.mjs';

const extra = createExtra();
const RELAY_CATALOG = new URL('../../bridgerator-relay/src/catalog.json', import.meta.url);

test('every extra tool: action enum, honest annotations, short plain description without the engine name', () => {
  assert.ok(extra.defs.length >= 7);
  for (const d of extra.defs) {
    assert.match(d.name, /^[a-z][a-z0-9_]{2,40}$/, d.name);
    assert.equal(d.inputSchema.type, 'object', d.name);
    assert.equal(d.inputSchema.additionalProperties, false, d.name);
    assert.ok(d.inputSchema.required?.includes('action'), `${d.name}: action is required`);
    assert.ok(Array.isArray(d.inputSchema.properties.action.enum) && d.inputSchema.properties.action.enum.length >= 1, d.name);
    for (const h of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) assert.equal(typeof d.annotations?.[h], 'boolean', `${d.name}.${h}`);
    assert.ok(!(d.annotations.readOnlyHint && d.annotations.destructiveHint), `${d.name}: read-only and destructive at once`);
    assert.ok(d.description.length <= 700, `${d.name}: description too long (${d.description.length})`);
    assert.ok(!/desktop ?commander|wonderwhy/i.test(JSON.stringify(d)), `${d.name} names the engine`);
    assert.ok(!/\b(IMPORTANT|MUST|ALWAYS|NEVER|CRITICAL)\b/.test(d.description), `${d.name}: imperative capitals`);
  }
});

test('extra tool names are unique and do not clash with the bridge\'s other tools or the engine catalog', { skip: fs.existsSync(RELAY_CATALOG) ? false : 'relay repo not next to the bridge (NOT CHECKED)' }, () => {
  const own = [...CONFIRM_TOOL_DEFS, SETUP_TOOL_DEF, SETTINGS_TOOL_DEF, ...QUEUE_TOOL_DEFS].map((t) => t.name);
  const engine = JSON.parse(fs.readFileSync(RELAY_CATALOG, 'utf8')).map((t) => t.name);
  const names = extra.defs.map((d) => d.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.ok(!own.includes(n) && !engine.includes(n), n);
  assert.throws(() => createExtra([{ defs: [{ name: 'x' }] }, { defs: [{ name: 'x' }] }]), /registered twice/);
});

test('a module that throws: plain text with a code, no stack trace, logged with context; unknown errors → INTERNAL', async () => {
  const logs = [];
  const r = createExtra([{ defs: [{ name: 'boom' }], handle: async () => { throw new ToolError('NO_WAY', 'Это не получилось.', 'Сделайте иначе.'); } }, { defs: [{ name: 'crash' }], handle: async () => { const e = new Error('kaput'); e.stack = 'Error: kaput\n    at secret (C:\\Users\\Алексей\\x.mjs:1:1)'; throw e; } }]);
  const a = await r.call('boom', {}, { log: (l) => logs.push(l) });
  assert.equal(a.isError, true);
  assert.equal(a.content[0].text, 'Это не получилось. What to do: Сделайте иначе. (code NO_WAY)');
  const b = await r.call('crash', {}, { log: (l) => logs.push(l) });
  assert.equal(b.content[0].text, 'kaput (code INTERNAL)');
  assert.ok(!/at secret/.test(b.content[0].text));
  assert.equal(logs.length, 2);
});

test('arguments that are not an object reach the module as {}; a tool the person disabled is refused', async () => {
  let got;
  const r = createExtra([{ defs: [{ name: 'echo' }], handle: async (n, a) => { got = a; return { content: [] }; } }]);
  await r.call('echo', ['x'], {});
  assert.deepEqual(got, {});
  const policy = createPolicy({ disabledTools: ['echo'] });
  const res = await r.call('echo', {}, { policy });
  assert.equal(res.refused, true);
});

test('Node error codes become plain words with what to do', () => {
  assert.match(errorText(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })), /^File or folder not found\. What to do: .* \(code ENOENT\)$/);
  assert.match(errorText(Object.assign(new Error('x'), { code: 'EBUSY' })), /open in another program/);
  assert.equal(errorText('просто строка'), 'просто строка (code INTERNAL)');
});

test('engine call errors: timeout / restarted engine / bad arguments / other, no "bridge error" internals', () => {
  assert.match(engineErrorText(Object.assign(new Error('MCP error -32001: Request timed out'), { code: -32001 })), /did not finish this in time.*ENGINE_TIMEOUT/);
  assert.match(engineErrorText(Object.assign(new Error('MCP error -32000: Connection closed'), { code: -32000 })), /restarted.*ENGINE_RESTARTED/);
  assert.match(engineErrorText(Object.assign(new Error('MCP error -32602: Invalid arguments for tool read_file'), { code: -32602 })), /^These arguments don't fit the tool: Invalid arguments for tool read_file \(code BAD_ARGS\)$/);
  const t = engineErrorText(new Error('weird\n    at x (y.js:1:1)'));
  assert.match(t, /^The PC could not do this: weird\. .*bridgerator doctor.*ENGINE_ERROR/);
});

test('CLIXML from a non-interactive PowerShell → just the error text (Cyrillic kept)', () => {
  const s = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Get-Item : Не удается найти путь &quot;C:\\Нет&quot;_x000D__x000A_</S><S S="Error">строка:1 знак:1_x000D__x000A_</S></Objs>';
  assert.equal(fromClixml(s), 'Get-Item : Не удается найти путь "C:\\Нет"\nстрока:1 знак:1\n');
  assert.equal(fromClixml('plain'), 'plain');
});

test('psJson takes the last JSON line (after warnings), else a PS_FAILED error', async () => {
  const ctx = (stdout, stderr = '', code = 0) => ({ runPs: async () => ({ code, stdout, stderr }) });
  assert.deepEqual(await psJson(ctx('ПРЕДУПРЕЖДЕНИЕ: что-то\r\n{"a":"б"}\r\n'), {}), { a: 'б' });
  await assert.rejects(psJson(ctx('', 'boom', 1), {}), (e) => e.code === 'PS_FAILED' && /boom/.test(e.message));
});

test('folder guard: full local paths only; excluded, outside the allowed list and read-only (for writes) are refused', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'Отчёты 2026 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'Работа'), ro = path.join(root, 'Архив'), secret = path.join(work, 'Секрет');
  for (const d of [work, ro, secret]) fs.mkdirSync(d, { recursive: true });
  const cfg = { allowedDirectories: [work, ro], readOnlyDirectories: [ro], deniedDirectories: [secret], protectSensitive: false }; // tmp is under AppData
  const ctx = { cfg, policy: createPolicy(cfg) };
  assert.equal(guard(ctx, path.join(work, 'план.docx'), { write: true }), path.join(work, 'план.docx'));
  assert.equal(guard(ctx, path.join(ro, 'старое.xlsx')), path.join(ro, 'старое.xlsx'), 'reading a read-only folder is fine');
  const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code; } };
  assert.equal(code(() => guard(ctx, path.join(ro, 'новое.xlsx'), { write: true })), 'ACCESS_DENIED');
  assert.equal(code(() => guard(ctx, path.join(secret, 'a.txt'))), 'ACCESS_DENIED');
  assert.equal(code(() => guard(ctx, path.join(root, 'вне списка.txt'))), 'ACCESS_DENIED');
  assert.equal(code(() => guard(ctx, '\\\\server\\share\\a.txt')), 'BAD_PATH');
  assert.equal(code(() => guard(ctx, 'relative\\a.txt')), process.platform === 'win32' ? 'BAD_PATH' : 'BAD_PATH');
  assert.equal(code(() => guard(ctx, '')), 'BAD_PATH');
  // Inversion: without the allowed list the same path is fine.
  assert.equal(code(() => guard({ cfg: {}, policy: createPolicy({ protectSensitive: false }) }, path.join(root, 'вне списка.txt'))), 'OK');
});

test('freeName never returns an existing file: "name (2).ext", "name (3).ext"', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'имя-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const p = path.join(d, 'Отчёт.docx');
  assert.equal(freeName(p), p);
  fs.writeFileSync(p, '');
  assert.equal(freeName(p), path.join(d, 'Отчёт (2).docx'));
  fs.writeFileSync(path.join(d, 'Отчёт (2).docx'), '');
  assert.equal(freeName(p), path.join(d, 'Отчёт (3).docx'));
});

test('tool settings: values / defaults / parse / widens / describe / set', () => {
  const r = createExtra([{ defs: [], settings: [{ key: 'screen.enabled', default: true, widensWhen: true, label: { en: 'Screenshots', ru: 'Снимки' } }, { key: 'screen.notify', default: true, widensWhen: false, label: { en: 'Notify', ru: 'Уведомлять' } }] }]);
  assert.deepEqual(r.values({}), { screen: { enabled: true, notify: true } });
  assert.deepEqual(r.values({ screen: { notify: false, enabled: 'yes' } }), { screen: { enabled: true, notify: false } }, 'a non-boolean in the file = the default');
  assert.deepEqual(r.parse({ screen: { notify: false }, theme: 'dark' }), { changes: [{ key: 'screen.notify', value: false }] });
  assert.ok(r.parse({ screen: { notify: 'no' } }).error);
  assert.ok(r.parse({ screen: { other: true } }).error);
  const cur = { screen: { enabled: false, notify: true } };
  assert.equal(r.widens(cur, { key: 'screen.enabled', value: true }), true, 'turning screenshots on widens access');
  assert.equal(r.widens(cur, { key: 'screen.notify', value: false }), true, 'turning the indicator off lowers protection');
  assert.equal(r.widens(cur, { key: 'screen.notify', value: true }), false);
  assert.equal(r.widens({ screen: { enabled: true } }, { key: 'screen.enabled', value: true }), false, 'no change = no question');
  assert.equal(r.describe({ key: 'screen.notify', value: false }), 'Notify: off');
  const cfg = { screen: { enabled: true } };
  let patched;
  assert.equal(r.set(cfg, 'screen.notify', false, (o) => { patched = o; }), true);
  assert.deepEqual(patched, { screen: { enabled: true, notify: false } });
  assert.equal(r.set(cfg, 'theme', 'dark', () => {}), false);
  assert.throws(() => r.set(cfg, 'screen.notify', 'off', () => {}), /true or false/);
  assert.equal(r.schema().screen.properties.notify.type, 'boolean');
});

test('bridgerator_settings knows the tools\' settings: schema, defaults, validation, PC confirm for widening', () => {
  const groups = extra.groups();
  assert.ok(groups.includes('screen'));
  assert.ok(SETTINGS_TOOL_DEF.inputSchema.properties.settings.properties.screen);
  assert.deepEqual(DEFAULTS.screen, { enabled: true, notify: true });
  assert.deepEqual(validateSettings({ screen: { notify: false } }).changes, [{ key: 'screen.notify', value: false }]);
  assert.ok(validateSettings({ screen: { notify: 1 } }).error);
  assert.equal(widens({ screen: { enabled: true, notify: true } }, { key: 'screen.notify', value: false }), true);
  assert.equal(widens({ screen: { enabled: true, notify: false } }, { key: 'screen.notify', value: true }), false);
  assert.match(describe({}, { key: 'screen.enabled', value: false }), /: off$/);
});

test('every module is a { defs, handle } module; settings have EN + RU labels', () => {
  for (const m of EXTRA_MODULES) {
    assert.ok(Array.isArray(m.defs));
    if (m.defs.length) assert.equal(typeof m.handle, 'function');
    for (const s of m.settings || []) {
      assert.match(s.key, /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/);
      // Booleans, or typed (delegate.mjs limits): int {min, max} / enum {values}, widensWhen 'up' | 'down' | null.
      if (!s.type) { assert.equal(typeof s.default, 'boolean', s.key); assert.equal(typeof s.widensWhen, 'boolean', s.key); }
      else {
        assert.ok(['int', 'enum'].includes(s.type), s.key);
        assert.ok(s.type === 'int' ? Number.isInteger(s.default) && s.default >= s.min && s.default <= s.max : s.values.includes(s.default), `${s.key}: default inside its range`);
        assert.ok([null, 'up', 'down'].includes(s.widensWhen), s.key);
      }
      assert.ok(s.label?.en && s.label?.ru, s.key);
    }
  }
});

test('B2-1: guard tree — a folder that CONTAINS an excluded / Bridgerator folder (or, for writes, a read-only one) is refused; excludedInside lists them relative', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const box = path.join(root, 'Коробка'), sec = path.join(box, 'Секрет'), ro = path.join(box, 'Архив'), plain = path.join(root, 'Обычная');
  for (const d of [sec, ro, plain]) fs.mkdirSync(d, { recursive: true });
  const cfg = { allowedDirectories: [], deniedDirectories: [sec], readOnlyDirectories: [ro], protectSensitive: false };
  const ctx = { cfg, policy: createPolicy(cfg) };
  const code = (fn) => { try { fn(); return 'OK'; } catch (e) { return e.code; } };
  assert.equal(code(() => guard(ctx, box, { tree: true })), 'FOLDER_HAS_EXCLUDED');
  assert.equal(code(() => guard(ctx, box)), 'OK', 'without tree: the folder itself is allowed');
  assert.equal(code(() => guard(ctx, plain, { tree: true, write: true })), 'OK');
  const c2 = { ...cfg, deniedDirectories: [] }, ctx2 = { cfg: c2, policy: createPolicy(c2) };
  assert.equal(code(() => guard(ctx2, box, { tree: true })), 'OK', 'reading over a read-only folder');
  assert.notEqual(code(() => guard(ctx2, box, { tree: true, write: true })), 'OK', 'writing over a read-only folder');
  assert.deepEqual(excludedInside(ctx, box), ['секрет']);
  assert.deepEqual(excludedInside(ctx, box, { write: true }).sort(), ['архив', 'секрет']);
  assert.deepEqual(excludedInside(ctx, plain), []);
});

test('B2-43: a PowerShell timeout ends the whole process tree (child programs too)', { skip: process.platform !== 'win32' && 'Windows' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brg-kill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pidFile = path.join(root, 'kid.txt');
  const script = `$p = Start-Process -PassThru -WindowStyle Hidden -FilePath (Join-Path $env:SystemRoot 'System32\\\\ping.exe') -ArgumentList '-n','60','127.0.0.1'; [IO.File]::WriteAllText($env:BRX_PID, [string]$p.Id); Start-Sleep -Seconds 60`;
  await assert.rejects(runPs({ script, env: { BRX_PID: pidFile }, timeout: 4000 }), (e) => e.code === 'TIMEOUT');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(), false, 'the grandchild is gone');
});
