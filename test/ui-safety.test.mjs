// The window's new safety parts (headless Chromium against a fake host, like ui.test.mjs): Safety tabs
// (Access / Undo & Recycle Bin / Limits), the access preset, Protect sensitive folders, Undo in Recent,
// keep-awake on Status and in Settings — in English and Russian, no raw keys, the right requests.
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
const SECTIONS = Object.keys(EN).filter((k) => EN[k] && typeof EN[k] === 'object');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

async function findPlaywright() {
  for (const name of ['playwright', 'playwright-core']) { try { return await import(name); } catch { /* not here */ } }
  const r0 = process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules');
  for (const base of r0 ? ['playwright', 'playwright-core', path.join('@playwright', 'mcp')] : []) {
    const pkg = path.join(r0, base, 'package.json');
    if (!fs.existsSync(pkg)) continue;
    const req = createRequire(pkg);
    for (const name of ['playwright', 'playwright-core']) { try { return req(name); } catch { /* next */ } }
  }
  return null;
}

let browser = null, server = null, base = '', skipWhy = '';
before(async () => {
  const pw = await findPlaywright();
  if (!pw?.chromium) { skipWhy = 'NOT CHECKED: Playwright is not installed on this PC'; return; }
  const shells = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean)
    .flatMap((d) => { try { return fs.readdirSync(d).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map((n) => path.join(d, n, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); } catch { return []; } })
    .filter((f) => fs.existsSync(f));
  for (const o of [{}, ...shells.map((executablePath) => ({ executablePath })), { channel: 'msedge' }]) { try { browser = await pw.chromium.launch({ headless: true, ...o }); break; } catch { /* next */ } }
  if (!browser) { skipWhy = 'NOT CHECKED: headless Chromium did not start'; return; }
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(UI, rel);
    if (!file.startsWith(UI) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await browser?.close(); await new Promise((r) => (server ? server.close(r) : r())); });

// The host side with the bridge's getState shape (src/bridge.mjs rpc 'getState', 'undo.list').
function fakeHost() {
  const now = Date.now();
  const h = window.__host = {
    calls: [], listeners: [],
    st: {
      state: 'online', name: 'HOME-PC', version: '1.0.9', paused: false, email: '', plan: null, banner: { kind: 'none', visible: false }, setupDone: true,
      settings: {
        confirm: { enabled: false, timeoutSec: 120, ask: { delete: true, dangerous_commands: true, write_files: false, move: false, any_command: false }, patterns: [] },
        allowedDirectories: [], readOnlyDirectories: [], theme: 'dark', language: 'en', localHistory: false, telemetry: true, popupStyle: 'toast',
        notify: { sound: true, offline: true, queueDone: true, limit: true }, autostart: true, deviceName: 'HOME-PC',
        preset: 'full', terminal: true, protectSensitive: false, recycleBin: true, snapshots: { enabled: true, days: 7, maxMb: 500, maxFileMb: 50 }, fuse: { enabled: false, limit: 20 }, keepAwake: true,
      },
      awake: { want: true, on: true, ac: true }, undo: { count: 2, mb: 0.1 }, queue: { todo: 0, doing: 0 }, pendingSetup: null,
    },
    recent: [
      { t: now - 60000, tool: 'write_file', target: 'D:\\Отчёты\\март.txt', outcome: 'ok', undo: 'u1' },
      { t: now, tool: 'start_process', target: 'Remove-Item "D:\\Старое"', outcome: 'ok', undo: 'u2' },
    ],
    undo: {
      actions: [{ id: 'u2', t: now, tool: 'delete', label: 'Remove-Item "D:\\Старое"', paths: ['D:\\Старое'], task: null, undone: false }, { id: 'u1', t: now - 60000, tool: 'write_file', label: 'D:\\Отчёты\\март.txt', paths: ['D:\\Отчёты\\март.txt'], task: { id: 'q1', title: 'Отчёты' }, undone: false }],
      groups: [{ kind: 'batch', key: 'u1', title: '', t0: now - 60000, t1: now, ids: ['u1', 'u2'] }, { kind: 'task', key: 'q1', title: 'Отчёты', t0: now - 60000, t1: now - 60000, ids: ['u1'] }], count: 2, mb: 0.1,
    },
  };
  const answer = (msg) => {
    const p = msg.params || {};
    switch (msg.method) {
      case 'getState': return JSON.parse(JSON.stringify(h.st));
      case 'queue.list': return [];
      case 'recent.list': return JSON.parse(JSON.stringify(h.recent));
      case 'undo.list': return JSON.parse(JSON.stringify(h.undo));
      case 'undo.run': for (const a of h.undo.actions) if (p.ids.includes(a.id)) a.undone = true; return { restored: p.ids.map((x) => `D:\\${x}`), skipped: p.ids.includes('u1') ? [{ path: 'D:\\Отчёты\\март.txt', why: 'changed after ChatGPT\'s action — left as it is' }] : [] };
      case 'setSetting':
        if (p.key === 'preset') h.st.settings.preset = p.value;
        else if (p.key === 'language') h.st.settings.language = p.value;
        return true;
      default: return true;
    }
  };
  const post = (msg) => { h.calls.push(JSON.parse(JSON.stringify(msg))); setTimeout(() => { const r = answer(msg); for (const f of h.listeners) f({ data: { id: msg.id, result: r } }); }, 0); };
  window.chrome = { webview: { postMessage: post, postMessageWithAdditionalObjects: (msg) => post(msg), addEventListener: (type, f) => { if (type === 'message') h.listeners.push(f); } } };
}
async function openPage(t, hash) {
  if (skipWhy) { t.skip(skipWhy); return null; }
  const page = await browser.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push(m.text()); });
  await page.addInitScript(fakeHost);
  await page.goto(`${base}/index.html#${hash}`);
  await page.waitForSelector('#main h1');
  return page;
}
const calls = (page, method) => page.evaluate((m) => window.__host.calls.filter((c) => c.method === m).map((c) => c.params), method);
const settle = (page) => page.waitForTimeout(150);
const RAW_KEY = new RegExp(`(^|[\\s>"'(])(${SECTIONS.join('|')})\\.[a-zA-Z_]+(\\b|$)`);
async function noRawKeys(page, where) {
  const txt = await page.evaluate(() => `${document.body.innerText}\n${[...document.querySelectorAll('[aria-label],[title]')].map((e) => `${e.getAttribute('aria-label') || ''} ${e.getAttribute('title') || ''}`).join('\n')}`);
  assert.equal(txt.split('\n').find((l) => RAW_KEY.test(l)), undefined, `${where}: a string key shown instead of its text`);
}

test('new strings exist in both languages and Russian ones are translated', () => {
  const keys = ['status.awakeOn', 'status.awakeIdle', 'status.awakeBattery', 'status.awakeOff', 'recent.undo', 'recent.undoAll', 'recent.undoTitle', 'safety.tab_access', 'safety.tab_undo', 'safety.tab_limits',
    'safety.read_only', 'safety.files', 'safety.full', 'safety.read_onlyHint', 'safety.filesHint', 'safety.fullHint', 'safety.sensitive', 'safety.recycle', 'safety.snapshots', 'safety.fuse', 'settings.keepAwake'];
  const get = (o, k) => k.split('.').reduce((x, y) => x?.[y], o);
  for (const k of keys) { assert.equal(typeof get(EN, k), 'string', `en ${k}`); assert.match(get(RU, k), /[а-яё]/i, `ru ${k}`); }
  for (const L of [EN, RU]) assert.ok(L.help.topics.undo && L.help.topics.undo.steps.length >= 2);
  assert.doesNotMatch(EN.safety.always, /\.ssh|startup/i, 'the always-blocked note names only Bridgerator itself');
});

test('Safety: tabs, preset, sensitive folders, Recycle Bin, snapshots, fuse — the right requests, EN and RU', async (t) => {
  const page = await openPage(t, 'safety');
  if (!page) return;
  for (const lang of ['en', 'ru']) {
    if (lang === 'ru') { await page.evaluate(() => { window.__host.st.settings.language = 'ru'; location.hash = 'home'; }); await page.waitForFunction(() => document.documentElement.lang === 'ru'); await page.evaluate(() => { location.hash = 'safety'; }); await page.waitForSelector('#main.safety'); }
    await page.click('[data-tab="access"]'); await settle(page);
    await noRawKeys(page, `${lang} access`);
    await page.click('[data-tab="undo"]'); await settle(page);
    await noRawKeys(page, `${lang} undo`);
    await page.click('[data-tab="limits"]'); await settle(page);
    await noRawKeys(page, `${lang} limits`);
  }
  await page.evaluate(() => window.__host.calls.splice(0));
  await page.click('[data-tab="access"]'); await settle(page);
  assert.equal(await page.getAttribute('[data-set="preset"][data-value="full"]', 'aria-checked'), 'true');
  await page.click('[data-set="preset"][data-value="files"]'); await settle(page);
  await page.click('[data-set="protectSensitive"]'); await settle(page);
  await page.click('[data-tab="undo"]'); await settle(page);
  await page.click('[data-set="recycleBin"]'); await settle(page);
  await page.click('[data-set="snapshots.enabled"]'); await settle(page);
  await page.selectOption('[data-num="snapshots.days"]', '14'); await settle(page);
  await page.selectOption('[data-num="snapshots.maxFileMb"]', '100'); await settle(page);
  await page.click('[data-tab="limits"]'); await settle(page);
  await page.click('[data-set="fuse.enabled"]'); await settle(page);
  await page.selectOption('[data-num="fuse.limit"]', '50'); await settle(page);
  await page.click('[data-set="keepAwake"]'); await settle(page);
  assert.deepEqual(await calls(page, 'setSetting'), [
    { key: 'preset', value: 'files' }, { key: 'protectSensitive', value: true }, { key: 'recycleBin', value: false }, { key: 'snapshots.enabled', value: false },
    { key: 'snapshots.days', value: 14 }, { key: 'snapshots.maxFileMb', value: 100 }, { key: 'fuse.enabled', value: true }, { key: 'fuse.limit', value: 50 }, { key: 'keepAwake', value: false },
  ]);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('Recent: Undo per action and "Undo AI changes…" by batch / task; skipped files are listed', async (t) => {
  const page = await openPage(t, 'recent');
  if (!page) return;
  await page.waitForSelector('[data-undo="u2"]');
  await page.click('[data-undo="u2"]'); await settle(page);
  assert.deepEqual(await calls(page, 'undo.run'), [{ ids: ['u2'] }]);
  assert.match(await page.textContent('#layer'), /Files restored: 1/);
  await page.click('[data-act="undoDialog"]'); await settle(page);
  assert.match(await page.textContent('.overlay'), /Task: Отчёты/);
  await page.locator('.overlay [data-ids="u1"]').last().click(); await settle(page);
  assert.deepEqual((await calls(page, 'undo.run')).at(-1), { ids: ['u1'] });
  assert.match(await page.textContent('.overlay'), /changed after ChatGPT/, 'the skipped file and why');
  await page.click('.overlay [data-x]');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('Status shows keep-awake; Settings has its switch', async (t) => {
  const page = await openPage(t, 'home');
  if (!page) return;
  assert.match(await page.textContent('.awake-line'), new RegExp(EN.status.awakeOn));
  await page.evaluate(() => { window.__host.st.awake = { want: true, on: false, ac: false }; });
  await page.waitForFunction((s) => document.querySelector('.awake-line')?.textContent.includes(s), EN.status.awakeBattery);
  await page.evaluate(() => { location.hash = 'settings'; });
  await page.waitForSelector('#main.settings [data-set="keepAwake"]');
  assert.deepEqual(page.errors, []);
  await page.close();
});
