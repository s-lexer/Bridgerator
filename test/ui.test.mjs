// The Bridgerator window (ui/): strings in both languages, the page's CSP rules, and — when
// Playwright with its headless Chromium is on this PC — the real page against a fake host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const UI = fileURLToPath(new URL('../ui/', import.meta.url));
const APP = fs.readFileSync(path.join(UI, 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
const EN = JSON.parse(fs.readFileSync(path.join(UI, 'i18n', 'en.json'), 'utf8'));
const RU = JSON.parse(fs.readFileSync(path.join(UI, 'i18n', 'ru.json'), 'utf8'));

const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
const EN_F = new Map(flat(EN)), RU_F = new Map(flat(RU));
const SECTIONS = Object.keys(EN).filter((k) => EN[k] && typeof EN[k] === 'object');
const holes = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
// A JS array of plain strings declared in app.js: `const NAME = ['a', 'b'];`
const arrayIn = (name) => {
  const m = new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(APP);
  assert.ok(m, `app.js declares ${name}`);
  return JSON.parse(m[1].replace(/'/g, '"'));
};
const callsOf = (fn) => [...APP.matchAll(new RegExp(`\\b${fn}\\('(\\w+)'`, 'g'))].map((m) => m[1]);
const has = (k) => EN_F.has(k) && RU_F.has(k);

test('English and Russian strings: same keys, same {placeholders}, nothing empty', () => {
  assert.deepEqual([...RU_F.keys()].sort(), [...EN_F.keys()].sort());
  for (const [k, en] of EN_F) {
    const ru = RU_F.get(k);
    assert.equal(typeof ru, typeof en, `${k}: same type`);
    if (Array.isArray(en)) {
      assert.equal(ru.length, en.length, `${k}: same number of steps`);
      en.forEach((x, i) => assert.deepEqual(holes(ru[i]), holes(x), `${k}[${i}] placeholders`));
      for (const x of [...en, ...ru]) assert.ok(String(x).trim(), `${k}: no empty step`);
    } else {
      assert.deepEqual(holes(ru), holes(en), `${k}: placeholders`);
      assert.ok(String(en).trim() && String(ru).trim(), `${k}: not empty`);
    }
  }
});

test('Russian strings are translated (only brand, plan name, commands and phrases for ChatGPT stay English)', () => {
  // Phrases the person says to ChatGPT and commands to type stay as they are (ChatGPT and the
  // command line are English); the rest must be translated.
  const SAME_OK = new Set(['app', 'status.proPlan', 'status.step2Phrase', 'status.step3Phrase', 'queue.hintPhrase', 'safety.deleteHint', 'safety.moveHint', 'notify.pCmd']);
  const sameOk = (k) => SAME_OK.has(k) || /^help\.topics\.\w+\.(tip|tipLabel)$/.test(k) || /^talk\.(setup|add|work|continue|delegate|show|confirmOn)$/.test(k) || /^agents\.p[123]$/.test(k);
  const untranslated = [...EN_F].filter(([k, v]) => JSON.stringify(v) === JSON.stringify(RU_F.get(k)) && /[A-Za-z]{3}/.test(JSON.stringify(v)) && !sameOk(k)).map(([k]) => k);
  assert.deepEqual(untranslated, []);
  for (const [k, v] of RU_F) if (!sameOk(k)) assert.match(JSON.stringify(v), /[а-яё]/i, `${k} has Russian text`);
});

test('every string key the window uses exists in both languages (literal and built from lists)', () => {
  const used = new Set();
  // Literal keys anywhere in app.js: t('status.title'), opt('all', 'recent.allResults'), ['edit', 'queue.edit'], cond ? 'a.b' : 'c.d'.
  for (const m of APP.matchAll(/['`]([a-z]\w*(?:\.\w+)+)['`]/g)) if (SECTIONS.includes(m[1].split('.')[0])) used.add(m[1]);
  for (const m of APP.matchAll(/\bt\('(\w+)'/g)) used.add(m[1]);
  // …but not the names of host requests: rpc('queue.list').
  for (const m of APP.matchAll(/\brpc\('([\w.]+)'/g)) if (!EN_F.has(m[1])) used.delete(m[1]);
  // Keys built from the lists that drive them.
  const PAGES = arrayIn('PAGES'), STATUSES = arrayIn('STATUSES'), CATS = arrayIn('CATS'), HELP = arrayIn('HELP'), PHRASES = arrayIn('PHRASES');
  const filters = JSON.parse(/const filters = (\[[^\]]*\])/.exec(APP)[1].replace(/'/g, '"'));
  const themes = JSON.parse(/const seg = (\[[^\]]*\])/.exec(APP)[1].replace(/'/g, '"'));
  for (const k of PAGES) used.add(`nav.${k}`);
  for (const k of ['online', 'offline', 'paused']) used.add(`state.${k}`);
  for (const k of [...STATUSES, ...filters]) used.add(`queue.${k}`);
  for (const k of themes) used.add(`settings.${k}`);
  for (const k of CATS) { used.add(`safety.${k}`); used.add(`safety.${k}Hint`); }
  for (const k of callsOf('style')) { used.add(`notify.${k}`); used.add(`notify.${k}Hint`); }
  for (const k of [...callsOf('sw'), ...callsOf('pv')]) used.add(`notify.${k}`);
  for (const k of PHRASES) { used.add(`talk.${k}`); used.add(`talk.${k}Hint`); }
  assert.ok(used.size > 150, `found ${used.size} keys — the scan works`);
  assert.deepEqual([...used].filter((k) => !has(k)).sort(), []);
  // Help topics are read straight from the strings (S.help.topics[k]): every field, both languages.
  for (const k of HELP.filter((x) => x !== 'talk')) {
    for (const L of [EN, RU]) {
      const d = L.help.topics[k];
      assert.ok(d, `help.topics.${k}`);
      for (const f of ['label', 'title', 'intro', 'tip', 'tipLabel']) assert.equal(typeof d[f], 'string', `help.topics.${k}.${f}`);
      assert.ok(Array.isArray(d.steps) && d.steps.length >= 2, `help.topics.${k}.steps`);
      assert.equal(typeof L.help[d.tipLabel], 'string', `help.${d.tipLabel} (tip label of ${k})`);
    }
  }
  // Each sw('x', 'notify.x') flips the setting of the same name.
  for (const m of APP.matchAll(/\bsw\('(\w+)', '([\w.]+)'\)/g)) assert.equal(m[2], `notify.${m[1]}`);
  // Labels set by data-i18n-aria (index.html and markup in app.js).
  const aria = [...`${HTML}\n${APP}`.matchAll(/data-i18n-aria="([\w.]+)"/g)].map((m) => m[1]);
  assert.ok(aria.length >= 2);
  for (const k of aria) assert.ok(has(k), `aria label ${k}`);
});

test('page rules for the CSP: no inline scripts, handlers or style attributes; only own resources', () => {
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(HTML)?.[1];
  assert.ok(csp, 'index.html has a CSP');
  const dir = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
  assert.deepEqual(dir['default-src'], ["'self'"]);
  assert.deepEqual(dir['script-src'], ["'self'"]);
  assert.deepEqual(dir['style-src'], ["'self'"]);
  for (const k of ['frame-src', 'object-src', 'base-uri', 'form-action']) assert.deepEqual(dir[k], ["'none'"], k);
  assert.doesNotMatch(csp, /unsafe-|\*|https?:/);
  // Every <script> loads a file; no inline code, no on…= handlers, no style="" (blocked by style-src 'self').
  for (const m of HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) { assert.match(m[1], /\bsrc="app\.js"/); assert.equal(m[2].trim(), ''); }
  for (const [name, src] of [['index.html', HTML], ['app.js', APP]]) {
    assert.doesNotMatch(src, /\sstyle\s*=\s*["'`$]/, `${name}: no style attribute`);
    assert.doesNotMatch(src, /<[a-z][^>]*\son[a-z]+\s*=\s*["'`]/i, `${name}: no inline on… handler in markup`);
    assert.doesNotMatch(src, /javascript:/i, `${name}: no javascript: links`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(UI, 'app.css'), 'utf8'), /@import|url\(\s*['"]?(https?:)?\/\//i, 'css loads nothing from elsewhere');
  assert.doesNotMatch(APP, /\beval\s*\(|new Function\s*\(|innerHTML\s*\+?=\s*[^`'"]*\+/, 'no eval; markup is built from escaped templates');
  // Host answers are matched by request id only; other messages are dropped.
  assert.match(APP, /const w = m && waiting\.get\(m\.id\);\s*if \(!w\) return;/);
});

// ---- the real page in headless Chromium ---------------------------------------------------------
async function findPlaywright() {
  for (const name of ['playwright', 'playwright-core']) { try { return await import(name); } catch { /* not here */ } }
  const roots = [process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules')].filter(Boolean);
  for (const root of roots) {
    for (const base of ['playwright', 'playwright-core', path.join('@playwright', 'mcp')]) {
      const pkg = path.join(root, base, 'package.json');
      if (!fs.existsSync(pkg)) continue;
      const req = createRequire(pkg);
      for (const name of ['playwright', 'playwright-core']) { try { return req(name); } catch { /* next */ } }
    }
  }
  return null;
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

let browser = null, server = null, base = '', skipWhy = '';
before(async () => {
  const pw = await findPlaywright();
  if (!pw?.chromium) { skipWhy = 'NOT CHECKED: Playwright is not installed on this PC (npm i -g playwright)'; return; }
  // Playwright's own build, else another installed headless shell of Playwright, else headless Edge.
  const shells = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright')].filter(Boolean)
    .flatMap((d) => { try { return fs.readdirSync(d).filter((n) => /^chromium_headless_shell-\d+$/.test(n)).sort().reverse().map((n) => path.join(d, n, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); } catch { return []; } })
    .filter((f) => fs.existsSync(f));
  const tries = [{}, ...shells.map((executablePath) => ({ executablePath })), { channel: 'msedge' }];
  let first = '';
  for (const o of tries) {
    try { browser = await pw.chromium.launch({ headless: true, ...o }); break; } catch (e) { first ||= String(e.message).split('\n')[0]; }
  }
  if (!browser) { skipWhy = `NOT CHECKED: headless Chromium did not start (${first})`; return; }
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

// The tray helper's side of window.chrome.webview, with the bridge's getState shape (src/bridge.mjs rpc 'getState').
function fakeHost() {
  const ask = { delete: true, dangerous_commands: true, write_files: false, move: false, any_command: false };
  const h = window.__host = {
    calls: [], csp: [],
    st: {
      state: 'online', name: 'HOME-PC', version: '1.0.8', paused: false, email: 'ivan@example.com',
      plan: { plan: 'free', calls: 120, limit: 10000, month: '2026-10', renewUrl: 'https://bridgerator.recondeck.com/app/billing?from=pc' },
      banner: { kind: 'none', visible: false }, setupDone: false,
      settings: {
        confirm: { enabled: false, timeoutSec: 120, ask, patterns: [] }, allowedDirectories: [], readOnlyDirectories: ['D:\\Архив'],
        theme: 'dark', language: 'en', localHistory: false, telemetry: true, popupStyle: 'toast',
        notify: { sound: true, offline: true, queueDone: true, limit: true }, autostart: true, deviceName: 'HOME-PC',
      },
      queue: { todo: 1, doing: 1, done: 1, failed: 0, skipped: 0 }, pendingSetup: null,
    },
    queue: [
      { id: 'a1b2c3d4', title: 'Разобрать фото', status: 'todo', order: 1, paths: ['D:\\Фото 2025'], createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z' },
      { id: 'b2c3d4e5', title: 'Rename invoices', status: 'doing', worker: 'chat 2', order: 2, createdAt: '2026-10-20T10:00:00.000Z', updatedAt: new Date().toISOString() },
      { id: 'c3d4e5f6', title: 'Done one', status: 'done', note: '120 photos sorted', order: 3, createdAt: '2026-10-20T10:00:00.000Z', updatedAt: '2026-10-20T10:00:00.000Z', doneAt: '2026-10-20T11:00:00.000Z' },
    ],
    recent: [
      { t: Date.now() - 120000, tool: 'start_process', target: 'Get-ChildItem "C:\\Users\\Иван\\Рабочий стол"', outcome: 'ok' },
      { t: Date.now() - 60000, tool: 'write_file', target: 'D:\\Архив\\a.txt', outcome: 'refused' },
      { t: Date.now(), tool: 'start_process', target: 'rd /s /q C:\\old', outcome: 'not confirmed' },
    ],
    listeners: [],
  };
  const set = (o, k, v) => { const p = k.split('.'); let x = o; while (p.length > 1) x = x[p.shift()]; x[p[0]] = v; };
  const answer = (msg) => {
    const p = msg.params || {};
    switch (msg.method) {
      case 'getState': return JSON.parse(JSON.stringify(h.st));
      case 'queue.list': return JSON.parse(JSON.stringify(h.queue));
      case 'recent.list': return JSON.parse(JSON.stringify(h.recent));
      case 'setSetting':
        if (p.key === 'confirm.enabled') h.st.settings.confirm.enabled = p.value;
        else if (/^confirm\.\w+$/.test(p.key) && p.key !== 'confirm.timeout') h.st.settings.confirm.ask[p.key.slice(8)] = p.value;
        else if (p.key === 'confirm.timeout') h.st.settings.confirm.timeoutSec = p.value;
        else set(h.st.settings, p.key === 'telemetryEnabled' ? 'telemetry' : p.key, p.value);
        return true;
      case 'setup.decide': h.st.pendingSetup = null; return true;
      case 'queue.add': { const it = { id: `n${h.queue.length}`, title: p.title, status: 'todo', order: h.queue.length + 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; h.queue.push(it); return it; }
      case 'queue.remove': { const i = h.queue.findIndex((x) => x.id === p.id); return h.queue.splice(i, 1)[0]; }
      case 'queue.restore': h.queue.push(p.item); return p.item;
      case 'pickFolder': return 'D:\\Новая папка';
      case 'checkUpdate': return { latest: '1.0.9', current: '1.0.8', upToDate: false };
      default: return true;
    }
  };
  const post = (msg) => { h.calls.push(JSON.parse(JSON.stringify(msg))); setTimeout(() => { const r = answer(msg); for (const f of h.listeners) f({ data: { id: msg.id, result: r } }); }, 0); };
  window.chrome = { webview: { postMessage: post, postMessageWithAdditionalObjects: (msg) => post(msg), addEventListener: (type, f) => { if (type === 'message') h.listeners.push(f); } } };
  document.addEventListener('securitypolicyviolation', (e) => h.csp.push(`${e.violatedDirective} ${e.blockedURI}`));
}

async function openPage(t, hash = 'home', patch) {
  if (skipWhy) { t.skip(skipWhy); return null; }
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await page.addInitScript(fakeHost);
  if (patch) await page.addInitScript(patch);
  await page.goto(`${base}/index.html#${hash}`);
  await page.waitForSelector('#main h1, .overlay .dialog');
  page.errors = errors;
  return page;
}
const calls = (page, method) => page.evaluate((m) => window.__host.calls.filter((c) => c.method === m).map((c) => c.params), method);
const settle = (page) => page.waitForTimeout(150);
const RAW_KEY = new RegExp(`(^|[\\s>"'(])(${SECTIONS.join('|')})\\.[a-zA-Z]+(\\b|$)`);
async function noRawKeys(page, where) {
  const text = await page.evaluate(() => `${document.body.innerText}\n${[...document.querySelectorAll('[aria-label],[title],[placeholder]')].map((e) => `${e.getAttribute('aria-label') || ''} ${e.getAttribute('title') || ''} ${e.getAttribute('placeholder') || ''}`).join('\n')}`);
  const hit = text.split('\n').find((l) => RAW_KEY.test(l) && !/bridgerator\.cmd|recondeck\.com/.test(l));
  assert.equal(hit, undefined, `${where}: a string key shown instead of its text`);
}

test('window: all 7 pages render in English and Russian without script errors, CSP violations or raw keys', async (t) => {
  const page = await openPage(t);
  if (!page) return;
  const PAGES = arrayIn('PAGES');
  for (const lang of ['en', 'ru']) {
    if (lang === 'ru') {
      await page.evaluate(() => { location.hash = 'settings'; });
      await page.waitForSelector('#st-lang');
      await page.selectOption('#st-lang', 'ru');
      await page.waitForFunction(() => document.documentElement.lang === 'ru');
      assert.deepEqual(await calls(page, 'setSetting'), [{ key: 'language', value: 'ru' }]);
    }
    const L = lang === 'ru' ? RU : EN;
    for (const p of PAGES) {
      await page.evaluate((h) => { location.hash = h; }, p);
      await page.waitForFunction((cls) => document.querySelector(`#main.${cls}`), { home: 'home', queue: 'queue', automations: 'automations', agents: 'agents', delegated: 'delegated', recent: 'recent', safety: 'safety', notifications: 'notifications', settings: 'settings', help: 'helpp' }[p]);
      await settle(page);
      assert.equal(await page.textContent('#nav [aria-current="page"] .grow'), L.nav[p], `${lang} ${p}: nav`);
      await noRawKeys(page, `${lang} ${p}`);
    }
    for (const k of arrayIn('HELP')) { await page.click(`[data-topic="${k}"]`); await settle(page); await noRawKeys(page, `${lang} help ${k}`); }
    assert.equal(await page.getAttribute('#w-min', 'aria-label'), L.closeToTray);
  }
  assert.deepEqual(page.errors, []);
  assert.deepEqual(await page.evaluate(() => window.__host.csp), [], 'no CSP violations');
  await page.close();
});

test('window: theme follows the setting (dark / light / system)', async (t) => {
  const page = await openPage(t, 'settings');
  if (!page) return;
  assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
  await page.click('[data-set="theme"][data-value="light"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.click('[data-set="theme"][data-value="system"]');
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  assert.deepEqual((await calls(page, 'setSetting')).map((c) => c.value), ['light', 'system']);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('window: plan banner — the limit can\'t be dismissed, Free 80 % can; pay opens only the link from the bridge', async (t) => {
  const limit = await openPage(t, 'home', () => { window.__host.st.banner = { kind: 'limit', tone: 'red', dismissible: false, calls: 10000, limit: 10000, reset: '2026-11-01', action: 'upgrade', url: 'https://bridgerator.recondeck.com/app/billing?from=pc', visible: true }; });
  if (!limit) return;
  assert.equal(await limit.locator('.banner.red[role="alert"]').count(), 1);
  assert.equal(await limit.locator('[data-act="dismissBanner"]').count(), 0);
  await limit.click('.banner [data-act="plan"]'); await settle(limit);
  assert.deepEqual(await calls(limit, 'openUrl'), [{ url: 'https://bridgerator.recondeck.com/app/billing?from=pc' }]);
  await limit.close();
  const high = await openPage(t, 'queue', () => { window.__host.st.banner = { kind: 'free_high', tone: 'yellow', dismissible: true, calls: 8100, limit: 10000, action: 'upgrade', url: 'https://bridgerator.recondeck.com/app', visible: true }; });
  assert.match(await high.textContent('.banner.yellow'), /8,100/);
  await high.click('[data-act="dismissBanner"]'); await settle(high);
  assert.equal((await calls(high, 'dismissBanner')).length, 1);
  assert.deepEqual(high.errors, []);
  await high.close();
});

test('window: task titles, paths and the PC name are shown as text — markup in them never runs', async (t) => {
  const evil = '<img src=x onerror="window.__xss=1">Фото & "отчёт" <b>жирный</b>';
  const page = await openPage(t, 'queue', function () {
    const e = '<img src=x onerror="window.__xss=1">Фото & "отчёт" <b>жирный</b>';
    window.__host.queue[0].title = e; window.__host.queue[0].paths = ['D:\\<script>window.__xss=2</script>'];
    window.__host.st.name = '<svg onload="window.__xss=3">'; window.__host.st.settings.deviceName = '"><img src=x onerror=window.__xss=4>';
    window.__host.recent[0].target = '<img src=x onerror="window.__xss=5">';
  });
  if (!page) return;
  assert.equal(await page.textContent('.qrow[data-id="a1b2c3d4"] .t'), evil);
  assert.equal(await page.locator('#main img, #main b, #main script').count(), 0, 'no element made from the title');
  for (const p of ['home', 'recent', 'notifications', 'settings']) { await page.evaluate((h) => { location.hash = h; }, p); await settle(page); }
  assert.equal(await page.inputValue('#st-name'), '"><img src=x onerror=window.__xss=4>');
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  // A stray message from the host with an id nobody asked for is ignored.
  await page.evaluate(() => { for (const f of window.__host.listeners) f({ data: { id: 'u999999', result: { state: 'paused' } } }); for (const f of window.__host.listeners) f({ data: null }); });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('window: a long settings proposal from ChatGPT is shown as a diff; Apply / Cancel answer the bridge', async (t) => {
  const page = await openPage(t, 'home', () => { window.__host.st.pendingSetup = { id: 'sk1x2', lines: ['Folders: 1 → 2', '  + D:\\Фото', '  − C:\\Old'] }; });
  if (!page) return;
  await page.waitForSelector('.overlay .dialog');
  assert.equal(await page.textContent('.overlay pre.diff'), 'Folders: 1 → 2\n  + D:\\Фото\n  − C:\\Old');
  await page.click('.overlay [data-go]'); await settle(page);
  assert.deepEqual(await calls(page, 'setup.decide'), [{ id: 'sk1x2', apply: true }]);
  assert.equal(await page.locator('.overlay').count(), 0);
  await page.close();
  const p2 = await openPage(t, 'home', () => { window.__host.st.pendingSetup = { id: 'sk1x3', lines: ['Confirmations: off'] }; });
  await p2.waitForSelector('.overlay .dialog');
  // Esc = Cancel: the bridge gets the answer at once (it would otherwise wait 10 min with the
  // proposal hidden for good — the same proposal is never shown twice).
  await p2.keyboard.press('Escape'); await settle(p2);
  assert.equal(await p2.locator('.overlay').count(), 0);
  assert.deepEqual(await calls(p2, 'setup.decide'), [{ id: 'sk1x3', apply: false }]);
  await p2.close();
});

// X2-8 / X3-12: a refresh asked for while one runs is queued (once, full wins), never dropped.
// X2-9: a decision is sent once, however often the button is clicked while the answer is on its way.
const SLOW = () => {
  const w = window.chrome.webview, orig = w.postMessage;
  window.__slow = {};
  w.postMessage = (m) => { const ms = window.__slow[m.method]; if (ms) setTimeout(() => orig(m), ms); else orig(m); };
};
test('window: refresh during a running refresh is queued (full kept); a slow decision is sent once', async (t) => {
  const page = await openPage(t, 'home', SLOW);
  if (!page) return;
  await settle(page);
  const r = await page.evaluate(async () => {
    window.__slow.getState = 300;
    const n0 = window.__host.calls.length;
    const a = refresh(); const b = refresh(true); const c = refresh();
    const same = b === c;
    await b;
    const after = window.__host.calls.slice(n0).map((x) => x.method);
    return { same, after };
  });
  assert.equal(r.same, true, 'calls made meanwhile share ONE queued run');
  const gs = r.after.map((m, i) => (m === 'getState' ? i : -1)).filter((i) => i >= 0);
  assert.ok(gs.length >= 2, r.after.join(','));
  assert.ok(r.after.slice(gs[1]).includes('undo.list'), `the queued run is the full one: ${r.after.join(',')}`);
  await page.close();
  const p2 = await openPage(t, 'home', () => { window.__host.st.pendingSetup = { id: 'sk2x2', lines: ['Confirmations: off'] }; });
  if (!p2) return;
  await p2.waitForSelector('.overlay .dialog');
  await p2.evaluate(() => {
    const w = window.chrome.webview, orig = w.postMessage;
    w.postMessage = (m) => { if (m.method === 'setup.decide') setTimeout(() => orig(m), 300); else orig(m); };
    // The bridge counts what it is asked: record at click time.
    window.__asked = 0; const o2 = w.postMessage; w.postMessage = (m) => { if (m.method === 'setup.decide') window.__asked++; o2(m); };
  });
  await p2.click('.overlay [data-go]');
  assert.equal(await p2.isDisabled('.overlay [data-x]'), true, 'buttons off while the answer is on its way');
  await p2.click('.overlay [data-x]', { force: true }).catch(() => {});
  await p2.keyboard.press('Escape');
  await p2.waitForTimeout(500);
  assert.equal(await p2.evaluate(() => window.__asked), 1);
  assert.deepEqual(await calls(p2, 'setup.decide'), [{ id: 'sk2x2', apply: true }]);
  assert.equal(await p2.locator('.overlay').count(), 0);
  assert.deepEqual(p2.errors, []);
  await p2.close();
});

test('window: switches and buttons send the right requests to the bridge', async (t) => {
  const page = await openPage(t, 'safety');
  if (!page) return;
  assert.equal(await page.isDisabled('[data-set="confirm.delete"]'), true, 'categories are off while confirmations are off');
  await page.click('[data-set="confirm.enabled"]'); await settle(page);
  await page.click('[data-set="confirm.delete"]'); await settle(page);
  await page.selectOption('#s-timeout', '300'); await settle(page);
  await page.click('[data-adddir="readOnlyDirectories"]'); await settle(page);
  await page.locator('[data-rmdir="readOnlyDirectories"]').first().click(); await settle(page);
  await page.click('[data-adddir="allowedDirectories"]'); await settle(page);
  await page.click('[data-act="allowAll"]'); await settle(page);
  assert.deepEqual(await calls(page, 'setSetting'), [
    { key: 'confirm.enabled', value: true }, { key: 'confirm.delete', value: false }, { key: 'confirm.timeout', value: 300 },
    { key: 'readOnlyDirectories', value: ['D:\\Архив', 'D:\\Новая папка'] }, { key: 'readOnlyDirectories', value: ['D:\\Новая папка'] },
    { key: 'allowedDirectories', value: ['D:\\Новая папка'] }, { key: 'allowedDirectories', value: [] },
  ]);
  // Pause from the status page; a new task needs a title.
  await page.evaluate(() => { location.hash = 'home'; }); await page.waitForSelector('#main.home');
  await page.click('[data-act="pause"]'); await settle(page);
  assert.equal((await calls(page, 'pause')).length, 1);
  await page.evaluate(() => { location.hash = 'queue'; }); await page.waitForSelector('#main.queue');
  await page.click('[data-act="addTask"]');
  await page.click('.overlay [data-save]');
  assert.equal(await page.isVisible('#t-err'), true, 'empty title refused in the window');
  await page.fill('#t-title', 'Сжать видео');
  await page.click('.overlay [data-save]'); await settle(page);
  assert.deepEqual(await calls(page, 'queue.add'), [{ title: 'Сжать видео', paths: [] }]);
  // Delete from the row menu, then Undo puts it back.
  await page.click('.qrow[data-id="a1b2c3d4"] [data-act="qmenu"]');
  await page.click('.menu [data-m="delete"]'); await settle(page);
  assert.deepEqual(await calls(page, 'queue.remove'), [{ id: 'a1b2c3d4' }]);
  await page.click('.snack button'); await settle(page);
  assert.equal((await calls(page, 'queue.restore'))[0].item.id, 'a1b2c3d4');
  // Unlink and Uninstall ask in the window first; Cancel sends nothing.
  await page.evaluate(() => { location.hash = 'settings'; }); await page.waitForSelector('#main.settings');
  await page.click('[data-act="unlink"]'); await page.click('.overlay [data-x]'); await settle(page);
  assert.equal((await calls(page, 'unlink')).length, 0);
  await page.click('[data-act="uninstall"]'); await page.click('.overlay [data-go]'); await settle(page);
  assert.equal((await calls(page, 'uninstall')).length, 1);
  await page.click('[data-act="checkUpdate"]'); await settle(page);
  assert.match(await page.textContent('#main'), /1\.0\.9/);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(await page.evaluate(() => window.__host.csp), []);
  await page.close();
});

test('V-12 / V-9: the askSettings hint follows the switch; a confirm.ini held by another program gives a plain message', async (t) => {
  const page = await openPage(t, 'settings', () => {
    // The bridge answers confirm.enabled with the locked-file error (bridge.mjs setSetting → CONFIRM_LOCKED).
    const real = window.chrome.webview.postMessage;
    window.chrome.webview.postMessage = (msg) => {
      if (msg.method === 'setSetting' && msg.params.key === 'confirm.enabled') { window.__host.calls.push(msg); setTimeout(() => { for (const f of window.__host.listeners) f({ data: { id: msg.id, error: 'CONFIRM_LOCKED' } }); }, 0); return; }
      real(msg);
    };
  });
  if (!page) return;
  const hint = () => page.evaluate(() => document.querySelector('[data-set="askSettings"]').closest('.row').querySelector('.hint').textContent);
  assert.equal(await hint(), EN.settings.askSettingsHint);
  await page.click('[data-set="askSettings"]'); await settle(page);
  assert.equal(await hint(), EN.settings.askSettingsHintOn, 'the hint says what "on" does');
  await page.click('[data-set="askSettings"]'); await settle(page);
  assert.equal(await hint(), EN.settings.askSettingsHint);
  await page.evaluate(() => { location.hash = 'safety'; }); await page.waitForSelector('#main.safety');
  await page.click('[data-set="confirm.enabled"]'); await settle(page);
  assert.match(await page.textContent('.snack'), new RegExp(EN.settings.confirmLocked.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(await page.getAttribute('[data-set="confirm.enabled"]', 'aria-checked'), 'false', 'the switch shows the state that stayed');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('screen-reader labels are translated: no fixed English aria-label / hidden label in the window', () => {
  assert.deepEqual(APP.match(/aria-label="[^"$]+"/g) || [], [], 'app.js: every aria-label comes from t()');
  assert.deepEqual(APP.match(/class="sr">[^<$]+</g) || [], [], 'app.js: hidden labels come from t()');
  for (const tag of HTML.match(/<[^>]*aria-label="[^"]*"[^>]*>/g) || []) assert.match(tag, /data-i18n-aria="/, `index.html: ${tag}`);
});

test('home: "Let ChatGPT work without asking" opens Bridgerator\'s Permission page in ChatGPT, then shows as done', async (t) => {
  const page = await openPage(t);
  if (!page) return;
  await page.setViewportSize({ width: 1040, height: 900 });
  await page.click('[data-act="chatgptAllow"]');
  await settle(page);
  assert.deepEqual(await calls(page, 'openUrl'), [{ url: 'https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_6ad78d4a3c408191a9215fd304394c4a/permissions' }]);
  assert.equal((await calls(page, 'chatgptAllowOpened')).length, 1);
  if (process.env.UI_SHOT) await page.screenshot({ path: process.env.UI_SHOT });
  assert.equal(await page.evaluate(() => document.scrollingElement.scrollHeight <= innerHeight), true, 'home fits 1040 x 900 without a scrollbar');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('window: the 2 s refresh keeps the scroll position; finished onboarding steps are not shown', async (t) => {
  const page = await openPage(t, 'agents', () => { window.__host.st.allowOpened = true; });
  if (!page) return;
  await page.setViewportSize({ width: 900, height: 420 });
  const top = await page.evaluate(() => { const m = document.querySelector('#main'); m.scrollTop = 120; return m.scrollTop; });
  assert.ok(top > 0, 'the page scrolls at this size');
  await page.waitForTimeout(2600); // one refresh redraws #main
  assert.equal(await page.evaluate(() => document.querySelector('#main').scrollTop), top);
  await page.evaluate(() => { location.hash = 'home'; });
  await page.waitForSelector('#main.home .now');
  assert.equal(await page.$('#main .steps'), null, 'queue has tasks + Allow opened: no onboarding card');
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('window: a click on a queue row opens the task with its full result note (owner 28.10: a failed note could not be read)', async (t) => {
  const page = await openPage(t, 'queue', () => { window.__host.queue.push({ id: 'f1', title: 'Failed one', status: 'failed', note: 'FAILED: the whole long reason '.repeat(8), worker: 'w5', resultPath: 'D:\\out\\r.md', order: 4, createdAt: '2026-10-27T10:00:00.000Z', updatedAt: '2026-10-27T11:00:00.000Z' }); });
  if (!page) return;
  await page.click('.qtext[data-id="f1"]');
  await page.waitForSelector('.overlay .dialog');
  const txt = await page.textContent('.overlay .dialog');
  assert.ok(txt.includes('FAILED: the whole long reason '.repeat(8).trim()), 'whole note');
  assert.match(txt, /D:\\out\\r\.md/);
  assert.deepEqual(page.errors, []);
  await page.close();
});
