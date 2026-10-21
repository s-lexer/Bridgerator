// The window's Automations page, the plan card dialog and the usage forecast on Status (ui/app.js),
// in headless Chromium against a fake host (no real window, nothing on the PC).
// LOGIC: critical-logic/bridge.md ("Automations and recipes", "Plan card").
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

// getState of src/bridge.mjs (automations: automations.mjs list(); usage: plan.mjs forecast; pendingBatch: batch.mjs pending()).
function fakeHost(opts) {
  const now = Date.now();
  const h = window.__host = {
    calls: [], listeners: [],
    st: {
      state: 'online', name: 'HOME-PC', version: '1.0.9', paused: false, email: 'ivan@example.com',
      plan: { plan: 'free', calls: 8200, limit: 10000, month: '2026-10' }, banner: { kind: 'none', visible: false }, setupDone: true,
      usage: opts.usage || { calls: 8200, limit: 10000, state: 'runs_out', projected: 12000, date: '2026-10-25' },
      settings: { confirm: { enabled: true, timeoutSec: 120, ask: { delete: true, dangerous_commands: true, scheduled_scripts: false }, patterns: [] }, allowedDirectories: [], readOnlyDirectories: [], theme: 'dark', language: opts.lang || 'en', localHistory: false, telemetry: true, popupStyle: 'toast', notify: { sound: true, offline: true, queueDone: true, limit: true }, autostart: true, deviceName: 'HOME-PC', automations: { notifySchedule: true } },
      queue: { todo: 0, doing: 0, done: 0, failed: 0, skipped: 0 }, pendingSetup: null, pendingBatch: opts.batch || null,
      automations: opts.empty ? [] : [
        { id: 'a1b2c3d4', name: 'Бэкап «Документы»', recipe: 'backup-folder', schedule: { type: 'weekly', days: ['mon', 'fri'], time: '21:00' }, enabled: true, scheduled: true, next: now + 3600000, last: { t: new Date(now - 7200000).toISOString(), code: 0, ms: 4100, trigger: 'schedule' }, running: false },
        { id: 'b2c3d4e5', name: 'Disk report', schedule: { type: 'daily', time: '08:00' }, enabled: false, scheduled: true, next: null, last: { t: new Date(now - 60000).toISOString(), code: 3, ms: 900, trigger: 'manual' }, running: false },
        { id: 'c3d4e5f6', name: 'On request', schedule: null, enabled: true, scheduled: false, next: null, last: null, running: false },
      ],
    },
  };
  const answer = (m) => {
    const p = m.params || {};
    switch (m.method) {
      case 'getState': return JSON.parse(JSON.stringify(h.st));
      case 'queue.list': case 'recent.list': return [];
      case 'undo.list': return { actions: [], groups: [], count: 0, mb: 0 };
      case 'automation.get': return { ...h.st.automations.find((a) => a.id === p.id), script: "Write-Output 'копия'", runs: [{ t: new Date().toISOString(), ms: 4100, code: 0, trigger: 'schedule', tail: 'Backup done (robocopy exit code 1)' }, { t: new Date(Date.now() - 86400000).toISOString(), ms: 900, code: 16, trigger: 'ai', tail: 'ошибка' }] };
      case 'automation.remove': { const i = h.st.automations.findIndex((a) => a.id === p.id); return { item: h.st.automations.splice(i, 1)[0], script: 'x' }; }
      case 'automation.restore': h.st.automations.push(p.removed.item); return p.removed.item;
      case 'batch.decide': h.st.pendingBatch = null; return true;
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
  await page.waitForSelector('#main h1, .overlay .dialog');
  if (opts.lang === 'ru') await page.waitForFunction(() => document.documentElement.lang === 'ru');
  await page.waitForTimeout(100);
  return page;
}
const calls = (page, m) => page.evaluate((x) => window.__host.calls.filter((c) => c.method === x).map((c) => c.params), m);
const rawKey = (s) => /(^|\s)(auto|batch|status|safety|nav)\.[a-zA-Z_]+/.test(s);

test('Automations page: each script with its schedule, next run and last result, in English and Russian', async (t) => {
  for (const lang of ['en', 'ru']) {
    const page = await open(t, 'automations', { lang });
    if (!page) return;
    const L = lang === 'ru' ? RU : EN;
    assert.equal(await page.textContent('#nav [aria-current="page"] .grow'), L.nav.automations);
    const rows = await page.$$eval('.arow', (r) => r.map((x) => x.innerText));
    assert.equal(rows.length, 3);
    assert.match(rows[0], /Бэкап «Документы»/);
    assert.match(rows[0], lang === 'ru' ? /Пн, Пт в 21:00/ : /Mon, Fri at 21:00/);
    assert.match(rows[1], lang === 'ru' ? /выключено.*ошибка \(код 3\)/s : /turned off.*error \(code 3\)/s);
    assert.match(rows[2], lang === 'ru' ? /По запросу.*ещё не запускался/s : /On request.*not run yet/s);
    assert.equal(await page.$$eval('.arow .switch', (s) => s.length), 2, 'no on/off switch for a script without a schedule');
    const all = await page.evaluate(() => document.body.innerText);
    assert.ok(!rawKey(all), `${lang}: no raw string keys`);
    assert.deepEqual(page.errors, []);
    await page.close();
  }
});

test('Automations page: switch, Run now, Delete with Undo, log and script', async (t) => {
  const page = await open(t, 'automations');
  if (!page) return;
  await page.click('[data-auto-toggle="a1b2c3d4"]');
  await page.click('[data-auto-run="c3d4e5f6"]');
  await page.waitForTimeout(100);
  assert.deepEqual(await calls(page, 'automation.enable'), [{ id: 'a1b2c3d4', on: false }]);
  assert.deepEqual(await calls(page, 'automation.run'), [{ id: 'c3d4e5f6' }]);
  await page.click('[data-act="amenu"][data-id="a1b2c3d4"]');
  await page.click('.menu [data-m="log"]');
  await page.waitForSelector('.dialog .runs details');
  const log = await page.textContent('.dialog');
  assert.match(log, /Backup done/); assert.match(log, /Code 16/); assert.match(log, /run by ChatGPT/);
  await page.click('.dialog [data-x]');
  await page.click('[data-act="amenu"][data-id="a1b2c3d4"]');
  await page.click('.menu [data-m="delete"]');
  await page.waitForSelector('.snack button');
  assert.equal(await page.$$eval('.arow', (r) => r.length), 2);
  await page.click('.snack button');
  await page.waitForTimeout(150);
  assert.equal((await calls(page, 'automation.restore'))[0].removed.item.id, 'a1b2c3d4');
  assert.equal(await page.$$eval('.arow', (r) => r.length), 3);
  await page.click('[data-set="automations.notifySchedule"]');
  await page.waitForTimeout(50);
  assert.deepEqual(await calls(page, 'setSetting'), [{ key: 'automations.notifySchedule', value: false }]);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('no automations yet: example phrases to copy', async (t) => {
  const page = await open(t, 'automations', { empty: true, lang: 'ru' });
  if (!page) return;
  const txt = await page.textContent('#main');
  assert.match(txt, /Автоматизаций пока нет/); assert.match(txt, /Каждый вечер копируй/);
  await page.close();
});

test('plan card in the window: untick an item, Allow selected sends only the ticked ones', async (t) => {
  const batch = { id: 'p1', title: 'Разобрать фото', head: 'ChatGPT wants to move 3 files', rows: [0, 1, 2].map((i) => ({ i, text: `D:\\Фото\\IMG_${i}.jpg  →  D:\\Разобрано\\IMG_${i}.jpg`, cat: 'move' })) };
  const page = await open(t, 'home', { batch });
  if (!page) return;
  await page.waitForSelector('.overlay .plist');
  assert.match(await page.textContent('.overlay h2'), /ChatGPT wants to move 3 files/);
  assert.match(await page.textContent('#bd-n'), /3 of 3 selected/);
  await page.uncheck('input[data-i="1"]');
  assert.match(await page.textContent('#bd-n'), /2 of 3 selected/);
  await page.click('.overlay [data-sel]');
  await page.waitForTimeout(50);
  assert.deepEqual(await calls(page, 'batch.decide'), [{ id: 'p1', allow: [0, 2] }]);
  assert.equal(await page.$('.overlay .plist'), null);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('Status: the month forecast — "runs out around …" or the count on Pro; the Safety page has the "Scheduled scripts" question', async (t) => {
  let page = await open(t, 'home');
  if (!page) return;
  assert.match(await page.textContent('.conn'), /8,200 of 10,000 calls this month/);
  assert.match(await page.textContent('.forecast'), /run out around Oct 25/);
  await page.close();
  page = await open(t, 'home', { lang: 'ru', usage: { calls: 1234, state: 'unlimited' } });
  assert.match(await page.textContent('.forecast'), /1\s234 вызовов в этом месяце/);
  await page.close();
  page = await open(t, 'safety');
  assert.match(await page.textContent('#main'), /Scheduled scripts/);
  await page.click('[data-set="confirm.scheduled_scripts"]');
  await page.waitForTimeout(50);
  assert.deepEqual(await calls(page, 'setSetting'), [{ key: 'confirm.scheduled_scripts', value: true }]);
  await page.close();
});
