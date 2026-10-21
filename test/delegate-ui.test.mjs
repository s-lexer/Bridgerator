// The window's Agents page (ui/app.js P.agents): detected agent CLIs with sign-in state and per-agent
// switches, limits, the delegated-run log with Stop / Undo / Details — in headless Chromium against a
// fake host (no real window, nothing on the PC). LOGIC: critical-logic/bridge.md ("AI ↔ AI delegation").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const UI = fileURLToPath(new URL('../ui/', import.meta.url));
const EN = JSON.parse(fs.readFileSync(path.join(UI, 'i18n', 'en.json'), 'utf8'));
const RU = JSON.parse(fs.readFileSync(path.join(UI, 'i18n', 'ru.json'), 'utf8'));

async function findPlaywright() {
  for (const name of ['playwright', 'playwright-core']) { try { return await import(name); } catch { /* not here */ } }
  const r = process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules');
  for (const b of r ? ['playwright', 'playwright-core', path.join('@playwright', 'mcp')] : []) {
    const pkg = path.join(r, b, 'package.json');
    if (!fs.existsSync(pkg)) continue;
    for (const name of ['playwright', 'playwright-core']) { try { return createRequire(pkg)(name); } catch { /* next */ } }
  }
  return null;
}
let browser = null, server = null, base = '', skipWhy = '';
before(async () => {
  const pw = await findPlaywright();
  if (!pw?.chromium) { skipWhy = 'NOT CHECKED: Playwright is not installed on this PC'; return; }
  const shells = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean)
    .flatMap((d) => { try { return fs.readdirSync(d).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map((n) => path.join(d, n, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); } catch { return []; } }).filter((f) => fs.existsSync(f));
  for (const o of [{}, ...shells.map((executablePath) => ({ executablePath })), { channel: 'msedge' }]) { try { browser = await pw.chromium.launch({ headless: true, ...o }); break; } catch { /* next */ } }
  if (!browser) { skipWhy = 'NOT CHECKED: headless Chromium did not start'; return; }
  server = http.createServer((req, res) => {
    const file = path.resolve(UI, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html');
    if (!file.startsWith(UI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json; charset=utf-8' }[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); await new Promise((r) => (server ? server.close(r) : r())); });

// getState.agents of src/bridge.mjs = delegate.mjs view(cfg); extraSettings carry page 'agents'.
function fakeHost(opts) {
  const now = Date.now();
  const iso = (ms) => new Date(now - ms).toISOString();
  const h = window.__host = {
    calls: [], listeners: [], csp: [],
    st: {
      state: 'online', name: 'HOME-PC', version: '1.0.9', paused: false, email: 'ivan@example.com',
      plan: { plan: 'free', calls: 100, limit: 10000, month: '2026-10' }, banner: { kind: 'none', visible: false }, setupDone: true,
      settings: { confirm: { enabled: false, timeoutSec: 120, ask: {}, patterns: [] }, allowedDirectories: [], readOnlyDirectories: [], theme: 'dark', language: opts.lang || 'en', localHistory: false, telemetry: true, popupStyle: 'toast', notify: { sound: true, offline: true, queueDone: true, limit: true }, autostart: true, deviceName: 'HOME-PC', screen: { enabled: true, notify: true }, delegate: { codex: true, claude: false, gemini: true, mode: 'full', parallel: 2, timeoutMin: 30, maxOutputKb: 32, undoMb: 200 } },
      extraSettings: [
        { key: 'screen.notify', label: { en: 'Notify on screenshots', ru: 'Уведомлять о снимках' }, default: true, value: true },
        { key: 'delegate.codex', label: { en: 'Allow delegation to Codex', ru: 'Разрешить поручать задачи Codex' }, default: true, value: true, page: 'agents' },
        { key: 'delegate.parallel', label: { en: 'Delegated tasks at once', ru: 'Поручений одновременно' }, default: 2, value: 2, page: 'agents' },
      ],
      queue: { todo: 0, doing: 0, done: 0, failed: 0, skipped: 0 }, pendingSetup: null, pendingBatch: null,
      agents: opts.checking ? { checking: true, agents: [], limits: {}, runs: [], running: 0 } : {
        checking: false, running: 1,
        limits: { codex: true, claude: false, gemini: true, mode: 'full', parallel: 2, timeoutMin: 30, maxOutputKb: 32, undoMb: 200 },
        agents: [
          { id: 'codex', name: 'Codex', found: true, path: 'C:\\Users\\Мария\\AppData\\Roaming\\npm\\codex.cmd', startable: true, version: '0.155.1', signedIn: 'yes', allowed: true },
          { id: 'claude', name: 'Claude Code', found: true, path: 'C:\\Users\\Мария\\.local\\bin\\claude.exe', startable: true, version: '2.1.290', signedIn: 'no', allowed: false },
          { id: 'gemini', name: 'Gemini CLI', found: false, path: null, startable: false, version: null, signedIn: 'no', allowed: true },
        ],
        runs: [
          { id: 'd1', agent: 'codex', name: 'Codex', from: 'ChatGPT', folder: 'D:\\Проекты\\Сайт', mode: 'full', task: 'Почини тесты', startedAt: iso(30000), endedAt: null, state: 'running', ok: false, summary: '', changed: null, undoId: null, undone: false },
          { id: 'd2', agent: 'claude', name: 'Claude Code', from: 'ChatGPT (чат 2)', folder: 'D:\\Проекты\\Отчёт', mode: 'edit', task: 'Сделай обзор', startedAt: iso(3600000), endedAt: iso(3500000), state: 'done', ok: true, summary: 'Обновил README и добавил отчёт', changed: { modified: 1, created: 1, deleted: 0 }, undoId: 'snap1', undone: false },
          { id: 'd3', agent: 'codex', name: 'Codex', from: 'Claude Code', folder: 'D:\\Проекты\\Старое', mode: 'read', task: 'x', startedAt: iso(7200000), endedAt: iso(7100000), state: 'timeout', ok: false, summary: 'stopped after 30 min (time limit)', changed: { modified: 2, created: 0, deleted: 0 }, undoId: 'snap0', undone: true },
        ],
      },
    },
  };
  document.addEventListener('securitypolicyviolation', (e) => h.csp.push(e.violatedDirective));
  const set = (o, k, v) => { const p = k.split('.'); let x = o; while (p.length > 1) x = x[p.shift()] ||= {}; x[p[0]] = v; };
  const answer = (m) => {
    const p = m.params || {};
    switch (m.method) {
      case 'getState': return JSON.parse(JSON.stringify(h.st));
      case 'queue.list': case 'recent.list': return [];
      case 'undo.list': return { actions: [], groups: [], count: 0, mb: 0 };
      case 'undo.run': { const r = h.st.agents.runs.find((x) => p.ids.includes(x.undoId)); if (r) r.undone = true; return { restored: ['D:\\Проекты\\Отчёт\\README.md'], skipped: [] }; }
      case 'delegate.cancel': { const r = h.st.agents.runs.find((x) => x.id === p.id); r.state = 'cancelled'; return r; }
      case 'delegate.detect': return h.st.agents.agents;
      case 'delegate.get': return { ...h.st.agents.runs.find((x) => x.id === p.id), text: 'Готово: обновил README.md, добавил отчёт.md', files: { modified: ['D:\\Проекты\\Отчёт\\README.md'], created: ['D:\\Проекты\\Отчёт\\отчёт.md'], deleted: [] } };
      case 'setSetting': set(h.st.settings, p.key, p.value); if (p.key.startsWith('delegate.')) h.st.agents.limits[p.key.slice(9)] = p.value; return true;
      default: return true;
    }
  };
  const post = (msg) => { h.calls.push(JSON.parse(JSON.stringify(msg))); setTimeout(() => { const r = answer(msg); for (const f of h.listeners) f({ data: { id: msg.id, result: r } }); }, 0); };
  window.chrome = { webview: { postMessage: post, postMessageWithAdditionalObjects: post, addEventListener: (t, f) => { if (t === 'message') h.listeners.push(f); } } };
}
async function open(t, hash, opts = {}) {
  if (skipWhy) { t.skip(skipWhy); return null; }
  const page = await browser.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.addInitScript(fakeHost, opts);
  await page.goto(`${base}/index.html#${hash}`);
  await page.waitForSelector('#main h1');
  if (opts.lang === 'ru') await page.waitForFunction(() => document.documentElement.lang === 'ru');
  await page.waitForTimeout(100);
  return page;
}
const calls = (page, m) => page.evaluate((x) => window.__host.calls.filter((c) => c.method === x).map((c) => c.params), m);
const rawKey = (s) => /(^|\s)(agents|nav|queue)\.[a-zA-Z_]+/.test(s);

test('Agents page: found agents with version and sign-in, allow switches (off and disabled when not installed), run log — EN and RU', async (t) => {
  for (const lang of ['en', 'ru']) {
    const page = await open(t, 'agents', { lang });
    if (!page) return;
    const L = lang === 'ru' ? RU : EN;
    assert.equal(await page.textContent('#nav [aria-current="page"] .grow'), L.nav.agents);
    assert.equal(await page.textContent('#main h1'), L.agents.title);
    const rows = await page.$$eval('#aglist .agrow', (r) => r.map((x) => x.innerText));
    assert.equal(rows.length, 3);
    assert.match(rows[0], new RegExp(`Codex[\\s\\S]*v0\\.155\\.1 · ${L.agents.signed_yes}`));
    assert.match(rows[1], new RegExp(L.agents.signed_no));
    assert.match(rows[2], new RegExp(L.agents.notFound));
    assert.deepEqual(await page.$$eval('#aglist .switch', (s) => s.map((x) => [x.getAttribute('aria-checked'), x.disabled])), [['true', false], ['false', false], ['false', true]]);
    assert.equal(await page.$eval('.seg [data-value="full"]', (b) => b.getAttribute('aria-checked')), 'true');
    if (lang === 'ru') assert.doesNotMatch(await page.textContent('.agents .two'), /Tasks at once|Time limit/, 'limits are in Russian');
    assert.equal(await page.$('#drlist'), null, 'the task log has its own page (owner 21.10)');
    await page.evaluate(() => { location.hash = 'delegated'; });
    await page.waitForSelector('#drlist');
    assert.equal(await page.textContent('#nav [aria-current="page"] .grow'), L.nav.delegated);
    const log = await page.$$eval('#drlist .qrow', (r) => r.map((x) => x.innerText));
    assert.equal(log.length, 3);
    assert.match(log[0], new RegExp(L.agents.st_running)); assert.match(log[0], new RegExp(L.agents.stop));
    assert.match(log[1], /Обновил README и добавил отчёт/); assert.match(log[1], new RegExp(L.agents.undo));
    assert.match(log[1], new RegExp(L.agents.from.replace('{from}', 'ChatGPT \\(чат 2\\)')));
    assert.match(log[2], new RegExp(L.agents.undone)); assert.match(log[2], new RegExp(L.agents.st_timeout));
    const all = await page.evaluate(() => document.body.innerText);
    assert.ok(!rawKey(all), `${lang}: no raw string keys`);
    assert.deepEqual(page.errors, []);
    assert.deepEqual(await page.evaluate(() => window.__host.csp), []);
    await page.close();
  }
});

test('Agents page: switches and limits go to setSetting (the same keys as bridgerator_settings); Stop, Undo, Details, Check again', async (t) => {
  const page = await open(t, 'agents');
  if (!page) return;
  await page.click('#aglist [data-set="delegate.codex"]');
  await page.waitForTimeout(80);
  await page.click('.seg [data-set="delegate.mode"][data-value="read"]');
  await page.waitForTimeout(80);
  await page.selectOption('select[data-num="delegate.parallel"]', '3');
  await page.selectOption('select[data-num="delegate.timeoutMin"]', '60');
  await page.selectOption('select[data-num="delegate.undoMb"]', '0');
  await page.waitForTimeout(120);
  assert.deepEqual(await calls(page, 'setSetting'), [{ key: 'delegate.codex', value: false }, { key: 'delegate.mode', value: 'read' }, { key: 'delegate.parallel', value: 3 }, { key: 'delegate.timeoutMin', value: 60 }, { key: 'delegate.undoMb', value: 0 }]);
  assert.equal(await page.$eval('.seg [data-value="read"]', (b) => b.getAttribute('aria-checked')), 'true', 'shown after the refresh');
  await page.evaluate(() => { location.hash = 'delegated'; });
  await page.waitForSelector('#drlist');
  await page.click('[data-dcancel="d1"]');
  await page.waitForTimeout(100);
  assert.deepEqual(await calls(page, 'delegate.cancel'), [{ id: 'd1' }]);
  await page.click('[data-undo="snap1"]');
  await page.waitForTimeout(150);
  assert.deepEqual(await calls(page, 'undo.run'), [{ ids: ['snap1'] }]);
  assert.match(await page.textContent('#drlist'), new RegExp(EN.agents.st_cancelled));
  await page.click('[data-drun="d2"]');
  await page.waitForSelector('.overlay .dialog');
  const dlg = await page.textContent('.overlay .dialog');
  assert.match(dlg, /Готово: обновил README\.md/); assert.match(dlg, /отчёт\.md/); assert.match(dlg, new RegExp(EN.agents.dlg_created));
  await page.click('.overlay [data-x]');
  await page.evaluate(() => { location.hash = 'agents'; });
  await page.waitForSelector('#aglist');
  await page.click('[data-act="detectAgents"]');
  await page.waitForTimeout(100);
  assert.equal((await calls(page, 'delegate.detect')).length, 1);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('while looking for agents the page says so; the Tools card in Settings does not repeat the Agents settings', async (t) => {
  const page = await open(t, 'agents', { checking: true });
  if (!page) return;
  assert.match(await page.textContent('#aglist'), new RegExp(EN.agents.checking.replace('…', '')));
  await page.evaluate(() => { location.hash = 'settings'; });
  await page.waitForSelector('#main.settings');
  const tools = await page.textContent('#tl-h + *').catch(() => '');
  const card = await page.evaluate(() => document.querySelector('#tl-h')?.closest('section')?.innerText || '');
  assert.match(card, /Notify on screenshots/);
  assert.doesNotMatch(card + tools, /delegation|at once/i);
  await page.evaluate(() => { location.hash = 'help'; });
  await page.waitForSelector('#main.helpp');
  await page.click('[data-topic="agents"]');
  await page.waitForTimeout(50);
  assert.match(await page.textContent('.article'), new RegExp(EN.help.topics.agents.title));
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('Agent tasks page: "Keep finished agent tasks" off → only running tasks are listed', async (t) => {
  const page = await open(t, 'delegated');
  if (!page) return;
  assert.equal((await page.$$('#drlist .qrow')).length, 3);
  await page.evaluate(() => { window.__host.st.extraSettings.push({ key: 'delegate.keepFinished', default: true, value: false }); location.hash = 'agents'; location.hash = 'delegated'; });
  await page.waitForTimeout(300);
  const log = await page.$$eval('#drlist .qrow', (r) => r.map((x) => x.innerText));
  assert.equal(log.length, 1);
  assert.match(log[0], new RegExp(EN.agents.st_running));
  assert.deepEqual(page.errors, []);
  await page.close();
});
