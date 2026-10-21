// The engine patch table (src/dc-config-hooks.mjs): every patch applies to the pinned engine, several
// patches on one file apply in order, and a missing snippet refuses to start (fails closed).
// Regressions: efc13e0 "hooks are a fail-closed patch table", 1.0.1 UTF-8 terminal output on
// non-English Windows (code page 866/1251), no on-disk tool history, no browser / Chrome download.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { load } from '../src/dc-config-hooks.mjs';

const dist = path.dirname(createRequire(import.meta.url).resolve('@wonderwhy-er/desktop-commander/dist/index.js'));
const fake = (rel) => pathToFileURL(path.join(dist, rel)).href;
const via = (source) => async () => ({ format: 'module', source });

test('every patch applies to the pinned engine files (an engine update that moved a snippet is caught here)', async () => {
  const files = ['config.js', 'utils/toolHistory.js', 'utils/fuzzySearchLogger.js', 'utils/trackTools.js', 'utils/open-browser.js', 'terminal-manager.js', 'index.js'];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(dist, rel), 'utf8');
    const r = await load(fake(rel), {}, via(src));
    assert.notEqual(String(r.source), src.replace(/\r\n/g, '\n'), `${rel} patched`);
  }
  const hist = String((await load(fake('utils/toolHistory.js'), {}, via(fs.readFileSync(path.join(dist, 'utils/toolHistory.js'), 'utf8')))).source);
  assert.ok(hist.includes('globalThis.__BRG_DC_DIR') && hist.includes('no disk writes of tool calls') && !hist.includes('this.writeQueue.push(record)'), 'both toolHistory patches, in order');
  const term = String((await load(fake('terminal-manager.js'), {}, via(fs.readFileSync(path.join(dist, 'terminal-manager.js'), 'utf8')))).source);
  assert.ok(term.includes("'[Console]::OutputEncoding=[Text.Encoding]::UTF8;' + command"), 'PowerShell writes UTF-8 (ru-RU / 866 garbled output)');
  const ob = String((await load(fake('utils/open-browser.js'), {}, via(fs.readFileSync(path.join(dist, 'utils/open-browser.js'), 'utf8')))).source);
  assert.match(ob, /export async function openBrowser\(\) \{\}/); assert.doesNotMatch(ob, /child_process|exec\(/, 'never opens a browser');
});

test('a missing snippet refuses to start; CRLF sources are patched; other files pass untouched', async () => {
  await assert.rejects(load(fake('config.js'), {}, via('const CONFIG_DIR = somewhereElse;')), /unexpected engine file dist\/config\.js — refusing to start/);
  // Second toolHistory patch missing: the first one alone is not enough.
  await assert.rejects(load(fake('utils/toolHistory.js'), {}, via("const historyDir = path.join(os.homedir(), '.claude-server-commander');\n")), /refusing to start/);
  const crlf = "x\r\nconst CONFIG_DIR = path.join(USER_HOME, '.claude-server-commander');\r\n";
  assert.match(String((await load(fake('config.js'), {}, via(crlf))).source), /globalThis\.__BRG_DC_DIR/);
  const other = { format: 'module', source: 'const CONFIG_DIR = 1;' };
  assert.equal(await load(pathToFileURL(path.join(dist, '..', '..', 'other', 'config.js')).href, {}, async () => other), other);
  assert.equal(await load('node:fs', {}, async () => other), other);
  assert.equal(await load(fake('server.js'), {}, async () => other), other, 'engine file without patches');
});

test('the preload refuses to run without its folder and hides the folder from the engine environment', async () => {
  const { spawnSync } = await import('node:child_process');
  const iso = new URL('../src/dc-isolate.mjs', import.meta.url).href;
  const env = { ...process.env }; delete env.BRIDGERATOR_DC_CONFIG_DIR;
  assert.notEqual(spawnSync(process.execPath, ['--import', iso, '-e', '0'], { env, encoding: 'utf8', windowsHide: true }).status, 0);
  const r = spawnSync(process.execPath, ['--import', iso, '-e', 'console.log(JSON.stringify([process.env.BRIDGERATOR_DC_CONFIG_DIR ?? null, globalThis.__BRG_DC_DIR]))'], { env: { ...env, BRIDGERATOR_DC_CONFIG_DIR: 'C:\\Users\\Иван\\dc' }, encoding: 'utf8', windowsHide: true });
  assert.deepEqual(JSON.parse(r.stdout), [null, 'C:\\Users\\Иван\\dc']);
});
