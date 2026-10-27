// Bridgerator tray window: one page app, no framework. Talks to the tray helper / bridge only over
// window.chrome.webview.postMessage ({id, method, params} → {id, result | error}).
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wv = window.chrome && window.chrome.webview;

// ---- host link ---------------------------------------------------------------------------------
let seq = 0;
const waiting = new Map();
function rpc(method, params = {}, files, timeout = 180000) {
  if (!wv) return Promise.reject(new Error('not in the Bridgerator window'));
  const id = `u${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = timeout > 0 ? setTimeout(() => { if (waiting.delete(id)) reject(new Error('no answer')); }, timeout) : null;
    waiting.set(id, { resolve, reject, timer });
    const msg = { id, method, params };
    if (files && files.length && wv.postMessageWithAdditionalObjects) wv.postMessageWithAdditionalObjects(msg, files); else wv.postMessage(msg);
  });
}
if (wv) wv.addEventListener('message', (e) => {
  const m = e.data;
  if (m && m.t === 'nav' && typeof m.page === 'string') { go(m.page); return; }
  const w = m && waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id); clearTimeout(w.timer);
  if (m.error) w.reject(new Error(m.error)); else w.resolve(m.result);
});

// ---- strings -------------------------------------------------------------------------------------
let S = {};
const t = (key, vars = {}) => {
  let v = key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), S);
  if (typeof v !== 'string') return key;
  return v.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? vars[k] : `{${k}}`));
};
const nf = () => new Intl.NumberFormat(state.settings?.language === 'ru' ? 'ru-RU' : 'en-US');
async function loadLang(lang) {
  S = await (await fetch(`i18n/${lang === 'ru' ? 'ru' : 'en'}.json`)).json();
  document.documentElement.lang = lang === 'ru' ? 'ru' : 'en';
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => el.setAttribute('aria-label', t(el.dataset.i18nAria)));
}

// ---- state -------------------------------------------------------------------------------------
let state = { state: 'offline', name: '', version: '', settings: { confirm: { enabled: false, ask: {}, timeoutSec: 120 }, allowedDirectories: [], readOnlyDirectories: [] }, queue: {} };
let queueItems = [], recentItems = [], undoInfo = null;
let shownSetup = null, shownBatch = null;
let page = 'home', qFilter = 'all', rSearch = '', rResult = 'all', helpTopic = 'talk', previewTheme = null, updateInfo = null, safetyTab = 'access';
const sysDark = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const th = state.settings?.theme || 'system';
  document.documentElement.dataset.theme = th === 'system' ? (sysDark.matches ? 'dark' : 'light') : th;
}
sysDark.addEventListener('change', applyTheme);

// One refresh at a time (the 2 s poll never stacks on a slow answer); a call made meanwhile (the
// person's action, refresh(true)) is not dropped: ONE more run follows the current one (full wins).
let refreshing = null, refreshNext = null;
function refresh(full) {
  if (refreshing) {
    if (!refreshNext) { let done; const p = new Promise((r) => { done = r; }); refreshNext = { full: false, p, done }; }
    refreshNext.full ||= !!full;
    return refreshNext.p;
  }
  refreshing = refreshOnce(full).finally(() => {
    refreshing = null;
    const n = refreshNext; refreshNext = null;
    if (n) refresh(n.full).then(n.done, n.done);
  });
  return refreshing;
}
async function refreshOnce(full) {
  try {
    const prevLang = state.settings?.language;
    const next = await rpc('getState');
    if (next.settings.language !== prevLang) await loadLang(next.settings.language);
    state = next;
    applyTheme();
    if (full || page === 'queue' || page === 'home') queueItems = await rpc('queue.list');
    if (full || page === 'recent' || page === 'home') recentItems = await rpc('recent.list');
    if (full || page === 'recent' || page === 'safety') { const u = await rpc('undo.list'); undoInfo = u && Array.isArray(u.actions) ? u : null; }
  } catch { /* keep the last view */ }
  if (state.pendingSetup && state.pendingSetup.id !== shownSetup && !document.querySelector('.overlay')) { shownSetup = state.pendingSetup.id; setupDialog(state.pendingSetup); }
  if (state.pendingBatch && state.pendingBatch.id !== shownBatch && !document.querySelector('.overlay')) { shownBatch = state.pendingBatch.id; batchDialog(state.pendingBatch); }
  // Don't redraw under the person's hands: an open dialog / menu or a field being typed in.
  const typing = document.activeElement && document.activeElement.matches('#main input, #main textarea, #main select');
  if (!document.querySelector('.overlay, .menu') && !typing) render();
  else renderNav();
}

// A path shows its last segment; a command line or a URL shows whole (its last "segment" is a flag or a piece).
function lastTarget(x) {
  const s = String(x ?? '');
  return /^([A-Za-z]:[\\/]|\\\\|\/)/.test(s) ? (s.split(/[\\/]/).filter(Boolean).pop() || s) : s;
}

// ---- icons ----------------------------------------------------------------------------------------
const I = {
  home: '<path d="M3 10.5 12 3l9 7.5"></path><path d="M5 9.5V20h14V9.5"></path><path d="M10 20v-6h4v6"></path>',
  queue: '<path d="m4 6 1.5 1.5L8 5"></path><path d="m4 12 1.5 1.5L8 11"></path><path d="M4 18h4"></path><path d="M11 6h9"></path><path d="M11 12h9"></path><path d="M11 18h9"></path>',
  recent: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path>',
  safety: '<path d="M12 3 5 6v5.5c0 4.3 2.9 8 7 9.5 4.1-1.5 7-5.2 7-9.5V6l-7-3Z"></path><path d="m9 12 2 2 4-4"></path>',
  notifications: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9Z"></path><path d="M10 20a2 2 0 0 0 4 0"></path>',
  settings: '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"></path>',
  help: '<circle cx="12" cy="12" r="8.5"></circle><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.3-2.4 3.8"></path><path d="M12 17h.01"></path>',
  automations: '<rect x="3.5" y="5" width="17" height="15" rx="2.5"></rect><path d="M3.5 9.5h17"></path><path d="M8 3v4M16 3v4"></path><path d="m10.5 12.5 4 2.25-4 2.25z"></path>',
  delegated: '<path d="M4 6h10"></path><path d="M4 12h7"></path><path d="M4 18h10"></path><path d="M16 10l4 4-4 4"></path><path d="M13 14h7"></path>',
  agents: '<circle cx="7" cy="8" r="3"></circle><circle cx="17" cy="8" r="3"></circle><path d="M2.5 19a4.5 4.5 0 0 1 9 0"></path><path d="M12.5 19a4.5 4.5 0 0 1 9 0"></path><path d="M10 8h4"></path>',
};
const ico = (k, size = 18, w = 1.8) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;
const CHECK = (size, w, color = 'currentColor') => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"></path></svg>`;
const LOGO16 = '<svg width="16" height="16" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="15" fill="#2251E6"></rect><path d="M17 42 Q32 12 47 42" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round"></path><circle cx="17" cy="44" r="6.5" fill="#fff"></circle><circle cx="47" cy="44" r="6.5" fill="#7fe0ff"></circle></svg>';
const LOCK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" class="lock"><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>';
const PAGES = ['home', 'queue', 'automations', 'agents', 'delegated', 'recent', 'safety', 'notifications', 'settings', 'help'];

// ---- sidebar --------------------------------------------------------------------------------------
function renderNav() {
  const todo = (state.queue && state.queue.todo) || 0;
  const st = state.state || 'offline';
  $('#nav').innerHTML = PAGES.map((k) => `<a href="#${k}" ${k === page ? 'aria-current="page"' : ''}>${ico(k)}<span class="grow" data-t="${esc(t(`nav.${k}`))}">${esc(t(`nav.${k}`))}</span>${k === 'queue' && todo ? `<span class="badge">${todo}</span>` : ''}</a>`).join('')
    + `<div class="grow"></div><div class="nav-status"><div class="line"><span class="dot ${esc(st)}"></span>${esc(t(`state.${st}`))}</div><div class="sub">${esc(state.name || '—')} · v${esc(state.version)}</div></div>`;
}

// ---- plan banner ------------------------------------------------------------------------------------
const BICO = {
  pro_ending: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path>',
  pro_ended: '<circle cx="12" cy="12" r="8.5"></circle><path d="M12 8v5M12 16h.01"></path>',
  free_high: '<path d="M4 19h16"></path><path d="M7 15v-4M12 15V7M17 15v-6"></path>',
  limit: '<circle cx="12" cy="12" r="8.5"></circle><path d="M6 6l12 12"></path>',
};
function bannerHtml() {
  const b = state.banner;
  if (!b || !b.visible) return '';
  const loc = state.settings.language === 'ru' ? 'ru-RU' : 'en-US';
  const date = (d) => new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString(loc, { day: 'numeric', month: 'short' });
  const text = b.kind === 'pro_ending' ? (b.days <= 1 ? t('plan.proEnding1', { date: date(state.plan?.until || new Date().toISOString()) }) : t('plan.proEnding', { days: b.days, date: date(state.plan?.until || new Date().toISOString()) }))
    : b.kind === 'pro_ended' ? t('plan.proEnded')
    : b.kind === 'free_high' ? t('plan.freeHigh', { calls: nf().format(b.calls), limit: nf().format(b.limit) })
    : t('plan.limit', { date: date(b.reset) });
  return `<div class="banner ${b.tone}" role="${b.kind === 'limit' ? 'alert' : 'status'}"><svg class="bico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">${BICO[b.kind] || ''}</svg><span class="txt">${esc(text)}</span>`
    + `<button class="btn bbtn" data-act="plan">${esc(t(b.action === 'renew' ? 'plan.renew' : 'plan.upgrade'))}</button>`
    + (b.dismissible ? `<button class="icon-btn bx" data-act="dismissBanner" aria-label="${esc(t('plan.dismiss'))}" title="${esc(t('plan.dismiss'))}">✕</button>` : '<span class="bspace"></span>') + '</div>';
}

// ---- pages ------------------------------------------------------------------------------------------
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return t('status.agoNow');
  if (m < 60) return t('status.agoMin', { n: m });
  if (m < 1440) return t('status.agoHour', { n: Math.round(m / 60) });
  return t('status.agoDay', { n: Math.round(m / 1440) });
}
const toolName = (k) => { const v = t(`tools.${k}`); return v === `tools.${k}` ? k : v; };
function planLine() {
  const p = state.plan;
  const parts = [];
  if (state.email) parts.push(state.email);
  if (p) {
    if (p.plan === 'pro') parts.push(p.until ? t('status.proUntil', { date: new Date(p.until).toLocaleDateString(state.settings.language === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short' }) }) : t('status.proPlan'));
    else parts.push(t('status.freePlan'));
  }
  return parts.join(' · ');
}

const P = {};
// Keep-awake (on by default, mains power only): what the tray helper is doing right now.
function awakeLine() {
  const a = state.awake, s = state.settings;
  if (!a) return '';
  const k = s.keepAwake === false ? 'status.awakeOff' : a.on ? 'status.awakeOn' : a.want && !a.ac ? 'status.awakeBattery' : 'status.awakeIdle';
  return `<div class="awake-line ${a.on ? 'on' : ''}"><span class="dot ${a.on ? 'online' : 'offline'}"></span>${esc(t(k))}</div>`;
}
// The Bridgerator app's "Permission" page in ChatGPT (App ID of the store app). Owner 26.10: on first use ChatGPT
// asks before most actions ("Allow low-risk"); one switch to "Allow all" stops that.
const CHATGPT_PERMISSIONS = 'https://chatgpt.com/settings/plugins-settings/plugin_asdk_app_6ad78d4a3c408191a9215fd304394c4a/permissions';
P.home = () => {
  const st = state.state || 'offline';
  const c = state.queue || {};
  const ro = (state.settings.readOnlyDirectories || []).length;
  const last = recentItems[0];
  const p = state.plan;
  const usage = (p && p.plan === 'free' && p.limit ? `<div class="usage"><div class="bar"><div class="b-blue" data-w="${Math.min(100, Math.round(((p.calls || 0) / p.limit) * 100))}"></div></div><span>${esc(t('status.calls', { calls: nf().format(p.calls || 0), limit: nf().format(p.limit) }))}</span></div>` : '') + forecastLine();
  const anyTodo = queueItems.length > 0;
  return `<main class="home">${bannerHtml()}
<div class="head"><h1>${esc(t('status.title'))}</h1><div class="sub">${esc(t('status.sub'))}</div></div>
<section class="card conn" aria-label="${esc(t('aria.connection'))}">
 <div class="conn-icon ${st}">${st === 'online' ? CHECK(22, 2) : st === 'paused' ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="6" width="3.5" height="12" rx="1"></rect><rect x="13.5" y="6" width="3.5" height="12" rx="1"></rect></svg>' : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"></path></svg>'}</div>
 <div class="conn-main"><div class="title">${esc(st === 'online' ? t('status.online', { name: state.name }) : st === 'paused' ? t('status.paused') : t('status.offline'))}</div>
  <div class="sub">${esc(planLine())}</div>${usage}${awakeLine()}</div>
 <div class="conn-btns"><button class="btn btn-primary w148" data-act="openAccount">${esc(t('status.openAccount'))}</button><button class="btn btn-secondary w148" data-act="${state.paused ? 'resume' : 'pause'}">${esc(t(state.paused ? 'status.resume' : 'status.pause'))}</button></div>
</section>
<div class="tiles">
 <a class="card tile" href="#queue"><span class="k">${esc(t('status.cardQueue'))}</span><span class="v">${esc(t('status.toDo', { n: c.todo || 0 }))}</span><span class="s">${esc(t('status.queueSub', { doing: c.doing || 0, done: c.done || 0 }))}</span></a>
 <a class="card tile" href="#safety"><span class="k">${esc(t('status.cardConfirm'))}</span><span class="v">${esc(t(state.settings.confirm.enabled ? 'status.on' : 'status.off'))}</span><span class="s">${esc(ro === 1 ? t('status.roFolder1') : t('status.roFolders', { n: ro }))}</span></a>
 <a class="card tile" href="#recent"><span class="k">${esc(t('status.cardLast'))}</span><span class="v">${esc(last ? ago(last.t) : t('status.never'))}</span><span class="s" title="${esc(last ? `${last.tool} · ${last.target}` : '')}">${esc(last ? [last.tool, lastTarget(last.target)].filter(Boolean).join(' · ') : t('status.noActions'))}</span></a>
</div>
<section class="card steps" aria-label="${esc(t('aria.getStarted'))}">
 <div class="step ${state.allowOpened ? 'ok' : ''}"><span class="check ${state.allowOpened ? 'ok' : 'next'}">${state.allowOpened ? CHECK(12, 3.5) : ''}</span><div class="stack"><span class="t">${esc(t('status.stepAllow'))}</span>${state.allowOpened ? '' : `<span class="h">${esc(t('status.stepAllowHint'))}</span>`}</div>${state.allowOpened ? '' : `<button class="btn btn-secondary w112" data-act="chatgptAllow">${esc(t('status.stepAllowBtn'))}</button>`}</div>
 <div class="step ${state.setupDone ? 'ok' : ''}"><span class="check ${state.setupDone ? 'ok' : 'next'}">${state.setupDone ? CHECK(12, 3.5) : ''}</span><div class="stack"><span class="t">${esc(t('status.step2'))}</span>${state.setupDone ? '' : `<span class="h">${esc(t('status.step2Hint'))} <span class="mono">${esc(t('status.step2Phrase'))}</span></span>`}</div>${state.setupDone ? '' : `<button class="btn btn-secondary w112" data-copy="${esc(t('status.step2Phrase'))}">${esc(t('status.copyPhrase'))}</button>`}</div>
 <div class="step ${anyTodo ? 'ok' : ''}"><span class="check ${anyTodo ? 'ok' : state.setupDone ? 'next' : ''}">${anyTodo ? CHECK(12, 3.5) : ''}</span><div class="stack"><span class="t">${esc(t('status.step3'))}</span>${anyTodo ? '' : `<span class="h">${esc(t('status.step3Hint'))} <span class="mono">${esc(t('talk.work'))}</span></span>`}</div>${anyTodo ? '' : `<a class="btn btn-secondary w112" href="#queue">${esc(t('status.openQueue'))}</a>`}</div>
</section></main>`;
};

const STATUSES = ['todo', 'doing', 'done', 'failed', 'skipped'];
P.queue = () => {
  const items = queueItems;
  const count = (s) => items.filter((i) => i.status === s).length;
  const total = items.length;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const rows = items.filter((i) => qFilter === 'all' || i.status === qFilter).map((i) => {
    const note = i.status === 'doing' ? (i.note || (i.worker ? `ChatGPT (${i.worker}) · ${ago(Date.parse(i.updatedAt))}` : t('queue.noteDoing', { ago: ago(Date.parse(i.updatedAt)) }))) : (i.note || (i.paths || []).join(', ') || i.details || '');
    return `<div class="qrow" role="listitem" draggable="true" data-id="${esc(i.id)}">
<span class="grip" title="${esc(t('queue.drag'))}"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle><circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle><circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle></svg></span>
<span class="sdot ${i.status}" aria-hidden="true"></span>
<div class="qtext"><span class="t ${i.status === 'done' ? 'done' : ''}">${esc(i.title)}</span><span class="n">${esc(i.from ? `${t('queue.fromAi', { from: i.from })} · ${note}` : note)}</span></div>
<span class="qpill"><span class="pill t-${i.status}">${esc(t(`queue.${i.status}`))}</span></span>
<button class="icon-btn" data-act="qmenu" data-id="${esc(i.id)}" aria-label="${esc(t('queue.more'))}"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg></button></div>`;
  }).join('');
  const filters = ['all', 'todo', 'doing', 'done', 'failed'].map((k) => `<button role="tab" aria-selected="${k === qFilter}" data-filter="${k}">${esc(t(`queue.${k}`))}<span class="n">${k === 'all' ? total : count(k)}</span></button>`).join('');
  return `<main class="queue">${bannerHtml()}
<div class="head-row"><div class="head grow"><h1>${esc(t('queue.title'))}</h1><div class="sub">${esc(t('queue.sub'))}</div></div>
<button class="btn btn-secondary w96" data-act="clearMenu" aria-haspopup="menu">${esc(t('queue.clear'))}</button><button class="btn btn-primary w128" data-act="addTask"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>${esc(t('queue.add'))}</button></div>
<div class="usage"><div class="bar"><div class="b-green" data-w="${pct(count('done'))}"></div><div class="b-blue" data-w="${pct(count('doing'))}"></div><div class="b-red" data-w="${pct(count('failed'))}"></div></div><span>${esc(t('queue.progress', { done: count('done'), total }))}</span></div>
<div role="tablist" class="filters" aria-label="${esc(t('aria.filter'))}">${filters}</div>
<div role="list" class="card list" id="qlist">${rows || `<div class="empty">${esc(t('queue.empty'))}</div>`}</div>
<div class="hintbar"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="hint-ico"><path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.4-5.6A8.5 8.5 0 1 1 21 12Z"></path></svg>
<div class="hint-rows">${[['queue.hint', 'talk.work'], ['queue.hintContinue', 'talk.continue']].map(([l, ph]) => `<span class="txt">${esc(t(l))}</span><span class="mono phrase-chip">${esc(t(ph))}</span><button class="btn btn-hint" data-copy="${esc(t(ph))}">${esc(t('queue.copyPhrase'))}</button>`).join('')}</div></div></main>`;
};

P.recent = () => {
  const cls = (o) => (o === 'ok' ? 'done' : o === 'not confirmed' ? 'denied' : o === 'paused' ? 'paused' : 'error');
  const label = (o) => t(o === 'ok' ? 'recent.rDone' : o === 'not confirmed' ? 'recent.rDenied' : o === 'paused' ? 'recent.rPaused' : 'recent.rError');
  const q = rSearch.toLowerCase();
  const rows = recentItems.filter((e) => (rResult === 'all' || cls(e.outcome) === rResult) && (!q || `${e.tool} ${e.target}`.toLowerCase().includes(q))).map((e) => {
    const d = new Date(e.t);
    const u = e.undo && undoInfo ? undoInfo.actions.find((a) => a.id === e.undo) : null;
    const ub = u && u.noUndo && !u.undone ? `<span class="hint">${esc(t('recent.noUndo'))}</span>` : u && !u.undone ? `<button class="linkbtn" data-undo="${esc(u.id)}">${esc(t('recent.undo'))}</button>` : u && u.undone ? `<span class="hint">${esc(t('recent.undone'))}</span>` : '<span></span>';
    return `<div class="trow"><span class="time">${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</span><span>${esc(toolName(e.tool))}</span><span class="cmd" title="${esc(e.target)}">${esc(e.target)}</span><span class="pill t-${cls(e.outcome)}">${esc(label(e.outcome))}</span>${ub}</div>`;
  }).join('');
  const opt = (v, k) => `<option value="${v}" ${rResult === v ? 'selected' : ''}>${esc(t(k))}</option>`;
  return `<main class="recent">${bannerHtml()}
<div class="head"><h1>${esc(t('recent.title'))}</h1><div class="sub">${esc(t('recent.sub'))}</div></div>
<div class="head-row"><div class="searchbox"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" class="muted"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
<label for="r-search" class="sr">${esc(t('recent.search'))}</label><input id="r-search" placeholder="${esc(t('recent.search'))}" value="${esc(rSearch)}"></div>
<label for="r-result" class="sr">${esc(t('recent.result'))}</label><select id="r-result" class="select w150">${opt('all', 'recent.allResults')}${opt('done', 'recent.rDone')}${opt('error', 'recent.rError')}${opt('denied', 'recent.rDenied')}</select>
<button class="btn btn-secondary" data-act="undoDialog">${esc(t('recent.undoAll'))}</button><button class="btn btn-secondary w96" data-act="clearRecent">${esc(t('recent.clear'))}</button></div>
<div class="card table"><div class="trow th"><span>${esc(t('recent.time'))}</span><span>${esc(t('recent.action'))}</span><span>${esc(t('recent.target'))}</span><span>${esc(t('recent.result'))}</span><span></span></div>
<div class="tbody">${rows || `<div class="empty">${esc(t('recent.empty'))}</div>`}</div></div>
<div class="toggle-line"><button class="switch" role="switch" aria-checked="${!!state.settings.localHistory}" data-set="localHistory" aria-label="${esc(t('recent.keep'))}"></button><span>${esc(t('recent.keep'))}</span></div></main>`;
};

const CATS = ['delete', 'dangerous_commands', 'write_files', 'move', 'any_command', 'install', 'scheduled_scripts'];
P.safety = () => {
  const c = state.settings.confirm;
  const on = !!c.enabled;
  const cats = CATS.map((k) => `<div class="cat ${on ? '' : 'dim'}"><div class="stack"><span>${esc(t(`safety.${k}`))}</span><span class="hint">${esc(t(`safety.${k}Hint`))}</span></div>
<button class="switch" role="switch" aria-checked="${!!c.ask[k]}" aria-label="${esc(t(`safety.${k}`))}" data-set="confirm.${k}" ${on ? '' : 'disabled'}></button></div>`).join('');
  const sec = c.timeoutSec || 120;
  const opt = (v, k) => `<option value="${v}" ${sec === v ? 'selected' : ''}>${esc(t(k))}</option>`;
  const chip = (p, key, lock) => `<div class="chip">${lock ? LOCK : ''}<span title="${esc(p)}">${esc(p)}</span><button aria-label="${esc(t('safety.remove', { path: p }))}" data-rmdir="${esc(key)}" data-path="${esc(p)}">✕</button></div>`;
  const s = state.settings;
  const pre = s.preset || 'full';
  const tabs = SAFETY_TABS.map((k) => `<button role="tab" aria-selected="${k === safetyTab}" data-tab="${k}">${esc(t(`safety.tab_${k}`))}</button>`).join('');
  const presets = PRESETS.map((k) => `<button role="radio" aria-checked="${pre === k}" data-set="preset" data-value="${k}">${esc(t(`safety.${k}`))}</button>`).join('');
  const head = `<main class="safety">${bannerHtml()}
<div class="head"><h1>${esc(t('safety.title'))}</h1><div class="sub">${esc(t('safety.sub'))}</div></div>
<div class="head-row"><div role="tablist" class="filters" aria-label="${esc(t('safety.title'))}">${tabs}</div><div class="grow"></div>
<span class="flabel" id="pr-l">${esc(t('safety.preset'))}</span><div class="seg w240" role="radiogroup" aria-labelledby="pr-l">${presets}</div></div>
<div class="hint preset-hint">${esc(t(`safety.${pre}Hint`))}</div>`;
  if (safetyTab === 'undo') return head + undoTab(s);
  if (safetyTab === 'limits') return head + limitsTab(s);
  return `${head}
<div class="two">
<section class="card confirm-card" aria-labelledby="c-h"><div class="top"><div class="stack"><h2 id="c-h">${esc(t('safety.confirm'))}</h2><span class="hint">${esc(t('safety.confirmSub'))}</span></div>
<button class="switch" role="switch" aria-checked="${on}" aria-label="${esc(t('safety.confirm'))}" data-set="confirm.enabled"></button></div>
${cats}<div class="grow"></div>
<div class="foot-row"><label for="s-timeout">${esc(t('safety.autoDeny'))}</label><select id="s-timeout" class="select w132">${opt(60, 'safety.min1')}${opt(120, 'safety.min2')}${opt(300, 'safety.min5')}</select></div></section>
<section class="card folders" aria-labelledby="f-h"><h2 id="f-h">${esc(t('safety.folders'))}</h2>
${(state.settings.allowedDirectories || []).length
    ? `<div class="fgroup"><div class="head-row"><span class="flabel grow">${esc(t('safety.onlyThese'))}</span><button class="linkbtn" data-act="allowAll">${esc(t('safety.allowAll'))}</button></div>${state.settings.allowedDirectories.map((p) => chip(p, 'allowedDirectories')).join('')}
<button class="btn btn-dashed" data-adddir="allowedDirectories">${esc(t('safety.addFolder'))}</button></div>`
    : `<div class="fgroup"><div class="allfolders"><span class="dot online"></span><span class="grow">${esc(t('safety.allFolders'))}</span></div>
<button class="btn btn-dashed" data-adddir="allowedDirectories">${esc(t('safety.limit'))}</button></div>`}
<div class="fgroup"><span class="flabel">${esc(t('safety.readOnly'))} <span class="opt">${esc(t('safety.readOnlySub'))}</span></span>${(state.settings.readOnlyDirectories || []).map((p) => chip(p, 'readOnlyDirectories', true)).join('')}
<button class="btn btn-dashed" data-adddir="readOnlyDirectories">${esc(t('safety.addReadOnly'))}</button></div>
<div class="grow"></div>
<div class="cat"><div class="stack"><span>${esc(t('safety.sensitive'))}</span><span class="hint">${esc(t('safety.sensitiveHint'))}</span></div><button class="switch" role="switch" aria-checked="${s.protectSensitive === true}" aria-label="${esc(t('safety.sensitive'))}" data-set="protectSensitive"></button></div>
<div class="note"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" class="note-ico"><path d="M12 3 5 6v5.5c0 4.3 2.9 8 7 9.5 4.1-1.5 7-5.2 7-9.5V6l-7-3Z"></path></svg><span>${esc(t('safety.always'))}</span></div>
</section></div></main>`;
};
const SAFETY_TABS = ['access', 'undo', 'limits'];
const PRESETS = ['read_only', 'files', 'full'];
// A number setting as a select; a value set by ChatGPT outside the list is shown too.
const numSel = (key, cur, list, k) => `<select class="select w132" data-num="${key}" aria-label="${esc(t(k, { n: cur }))}">${[...new Set([...list, cur])].sort((a, b) => a - b).map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${esc(t(k, { n: v }))}</option>`).join('')}</select>`;
function undoTab(s) {
  const sn = s.snapshots || { enabled: true, days: 7, maxMb: 500, maxFileMb: 50 };
  const u = undoInfo || { count: 0, mb: 0 };
  return `<div class="two">
<section class="card confirm-card" aria-labelledby="rb-h"><div class="top"><div class="stack"><h2 id="rb-h">${esc(t('safety.recycle'))}</h2><span class="hint">${esc(t('safety.recycleHint'))}</span></div>
<button class="switch" role="switch" aria-checked="${s.recycleBin !== false}" aria-label="${esc(t('safety.recycle'))}" data-set="recycleBin"></button></div>
<div class="cat"><div class="stack"><span>${esc(t('safety.recycleNoBin'))}</span><span class="hint">${esc(t('safety.recycleNoBinHint'))}</span></div></div>
<div class="grow"></div><div class="note"><span>${esc(t('safety.recycleNet'))}</span></div></section>
<section class="card confirm-card" aria-labelledby="sn-h"><div class="top"><div class="stack"><h2 id="sn-h">${esc(t('safety.snapshots'))}</h2><span class="hint">${esc(t('safety.snapshotsHint'))}</span></div>
<button class="switch" role="switch" aria-checked="${sn.enabled !== false}" aria-label="${esc(t('safety.snapshots'))}" data-set="snapshots.enabled"></button></div>
<div class="cat ${sn.enabled === false ? 'dim' : ''}"><span class="grow">${esc(t('safety.keepFor'))}</span>${numSel('snapshots.days', sn.days, [1, 3, 7, 14, 30], 'safety.days')}</div>
<div class="cat ${sn.enabled === false ? 'dim' : ''}"><span class="grow">${esc(t('safety.upTo'))}</span>${numSel('snapshots.maxMb', sn.maxMb, [100, 250, 500, 1000, 2000], 'safety.mb')}</div>
<div class="cat ${sn.enabled === false ? 'dim' : ''}"><div class="stack grow"><span>${esc(t('safety.bigFile'))}</span><span class="hint">${esc(t('safety.bigFileHint'))}</span></div>${numSel('snapshots.maxFileMb', sn.maxFileMb, [10, 25, 50, 100, 200], 'safety.mb')}</div>
<div class="cat"><span class="hint grow">${esc(t('safety.used', { n: u.count || 0, mb: u.mb || 0 }))}</span></div>
<div class="grow"></div>
<div class="foot-row"><div class="grow"></div><button class="btn btn-secondary" data-act="clearSnapshots">${esc(t('safety.clearSnaps'))}</button><button class="btn btn-primary" data-act="undoDialog">${esc(t('recent.undoAll'))}</button></div></section>
</div></main>`;
}
function limitsTab(s) {
  const f = s.fuse || { enabled: false, limit: 20 };
  return `<div class="two">
<section class="card confirm-card" aria-labelledby="fu-h"><div class="top"><div class="stack"><h2 id="fu-h">${esc(t('safety.fuse'))}</h2><span class="hint">${esc(t('safety.fuseHint'))}</span></div>
<button class="switch" role="switch" aria-checked="${f.enabled === true}" aria-label="${esc(t('safety.fuse'))}" data-set="fuse.enabled"></button></div>
<div class="cat ${f.enabled ? '' : 'dim'}"><span class="grow">${esc(t('safety.fuseLimit'))}</span>${numSel('fuse.limit', f.limit, [10, 20, 50, 100, 200], 'safety.perMinute')}</div>
<div class="grow"></div></section>
<section class="card confirm-card" aria-labelledby="aw-h"><div class="top"><div class="stack"><h2 id="aw-h">${esc(t('settings.keepAwake'))}</h2><span class="hint">${esc(t('settings.keepAwakeHint'))}</span></div>
<button class="switch" role="switch" aria-checked="${s.keepAwake !== false}" aria-label="${esc(t('settings.keepAwake'))}" data-set="keepAwake"></button></div>
<div class="grow"></div></section>
</div></main>`;
}

P.notifications = () => {
  const s = state.settings;
  if (!previewTheme) previewTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  const st = s.popupStyle || 'toast';
  const style = (k) => `<button class="style-card" role="radio" aria-checked="${st === k}" data-set="popupStyle" data-value="${k}"><span class="radio" aria-hidden="true"></span><span class="stack"><span>${esc(t(`notify.${k}`))}</span><span class="hint">${esc(t(`notify.${k}Hint`))}</span></span></button>`;
  const sw = (k, key) => `<div class="row"><span class="grow">${esc(t(`notify.${k}`))}</span><button class="switch" role="switch" aria-checked="${s.notify?.[k] !== false}" aria-label="${esc(t(`notify.${k}`))}" data-set="${key}"></button></div>`;
  const pv = (k) => `<button role="radio" aria-checked="${previewTheme === k}" data-preview="${k}">${esc(t(`notify.${k}`))}</button>`;
  return `<main class="notifications">${bannerHtml()}
<div class="head"><h1>${esc(t('notify.title'))}</h1><div class="sub">${esc(t('notify.sub'))}</div></div>
<div class="styles" role="radiogroup" aria-label="${esc(t('aria.style'))}">${style('toast')}${style('popup')}</div>
<div class="nsplit"><section class="card" aria-label="${esc(t('aria.options'))}">${sw('sound', 'notify.sound')}${sw('offline', 'notify.offline')}${sw('queueDone', 'notify.queueDone')}${sw('queueStalled', 'notify.queueStalled')}${sw('settingsChanged', 'notify.settingsChanged')}${sw('limit', 'notify.limit')}</section>
<section class="preview" aria-label="${esc(t('notify.preview'))}"><div class="bar-top"><span class="b">${esc(t('notify.preview'))}</span><div class="seg" role="radiogroup" aria-label="${esc(t('aria.previewTheme'))}">${pv('light')}${pv('dark')}</div></div>
<div class="toast ${previewTheme}"><div class="app">${LOGO16}<span class="grow">Bridgerator</span><span>⋯</span></div><div class="h">${esc(t('notify.pHead'))}</div><div class="c">${esc(t('notify.pCmd'))}</div><div class="m">${esc(t('notify.pMeta', { name: state.name || 'PC' }))}</div>
<div class="btns"><span>${esc(t('notify.allow'))}</span><span>${esc(t('notify.allow10'))}</span><span>${esc(t('notify.deny'))}</span></div></div>
<div class="grow"></div><button class="btn btn-primary" data-act="testNotification">${esc(t('notify.test'))}</button></section></div></main>`;
};

// Settings of the extra tools (screen capture…): labels come with the state (bridge extra-tools.mjs), EN + RU.
const toolsCard = () => {
  // Settings that belong to a page of their own (page: 'agents') are shown there, not here.
  const list = Array.isArray(state.extraSettings) ? state.extraSettings.filter((x) => !x.page && typeof x.default === 'boolean') : [];
  if (!list.length) return '';
  const tr = (o) => (o && typeof o === 'object' ? String((state.settings.language === 'ru' ? o.ru : o.en) || o.en || '') : '');
  const rows = list.map((x) => `<div class="row tall"><div class="stack"><span>${esc(tr(x.label))}</span>${x.hint ? `<span class="hint">${esc(tr(x.hint))}</span>` : ''}</div><button class="switch" role="switch" aria-checked="${x.value === true}" aria-label="${esc(tr(x.label))}" data-set="${esc(x.key)}"></button></div>`).join('');
  return `<section class="card" aria-labelledby="tl-h"><h2 id="tl-h" class="sec-title">${esc(t('settings.tools'))}</h2>${rows}</section>`;
};
P.settings = () => {
  const s = state.settings;
  const th = s.theme || 'system';
  const seg = ['system', 'light', 'dark'].map((k) => `<button role="radio" aria-checked="${th === k}" data-set="theme" data-value="${k}">${esc(t(`settings.${k}`))}</button>`).join('');
  const p = state.plan;
  const usage = p && p.plan === 'free' && p.limit ? ` · ${t('status.calls', { calls: nf().format(p.calls || 0), limit: nf().format(p.limit) })}` : '';
  const planBtn = !p ? '' : p.plan === 'pro' ? `<button class="btn btn-secondary" data-act="plan">${esc(t('settings.manage'))}</button>` : `<button class="btn btn-secondary" data-act="plan">${esc(t('settings.upgrade'))}</button>`;
  const u = updateInfo;
  const uline = !u ? `<span class="hint ok-text">${esc(t('settings.upToDate'))}</span>` : u.checking ? `<span class="hint">${esc(t('settings.checking'))}</span>` : u.failed ? `<span class="hint warn-text">${esc(t('settings.checkFailed'))}</span>` : u.updating ? `<span class="hint">${esc(t('settings.updating'))}</span>` : u.upToDate ? `<span class="hint ok-text">${esc(t('settings.upToDate'))}</span>` : `<span class="hint warn-text">${esc(t('settings.updateAvail', { v: u.latest }))}</span>`;
  // Owner 21.10: left and right cards side by side in rows, each pair the same height.
  const left = [`<section class="card" aria-labelledby="ap-h"><h2 id="ap-h" class="sec-title">${esc(t('settings.appearance'))}</h2>
<div class="row"><span id="th-l" class="grow">${esc(t('settings.theme'))}</span><div class="seg w168" role="radiogroup" aria-labelledby="th-l">${seg}</div></div>
<div class="row"><label for="st-lang" class="grow">${esc(t('settings.language'))}</label><select id="st-lang" class="select w168"><option value="en" ${s.language !== 'ru' ? 'selected' : ''}>English</option><option value="ru" ${s.language === 'ru' ? 'selected' : ''}>Русский</option></select></div></section>`, `<section class="card" aria-labelledby="g-h"><h2 id="g-h" class="sec-title">${esc(t('settings.thisPc'))}</h2>
<div class="row"><label for="st-name" class="grow">${esc(t('settings.pcName'))}</label><input id="st-name" class="input w168" maxlength="40" value="${esc(s.deviceName || state.name || '')}"></div>
<div class="row"><span class="grow">${esc(t('settings.autostart'))}</span><button class="switch" role="switch" aria-checked="${s.autostart !== false}" aria-label="${esc(t('settings.autostart'))}" data-set="autostart"></button></div>
<div class="row"><span class="grow">${esc(t('settings.keepAwake'))}</span><button class="switch" role="switch" aria-checked="${s.keepAwake !== false}" aria-label="${esc(t('settings.keepAwake'))}" data-set="keepAwake"></button></div>
<div class="row tall"><div class="stack"><span>${esc(t('settings.askSettings'))}</span><span class="hint">${esc(t(s.askSettings === true ? 'settings.askSettingsHintOn' : 'settings.askSettingsHint'))}</span></div><button class="switch" role="switch" aria-checked="${s.askSettings === true}" aria-label="${esc(t('settings.askSettings'))}" data-set="askSettings"></button></div></section>`, `<section class="card" aria-labelledby="a-h"><h2 id="a-h" class="sec-title">${esc(t('settings.account'))}</h2>
<div class="acct"><span>${esc(state.email || state.name || '')}</span><span class="hint">${esc((p ? (p.plan === 'pro' ? t('status.proPlan') : t('status.freePlan')) : '') + usage)}</span></div>
<div class="${planBtn ? 'grid2' : 'grid1'}"><button class="btn btn-primary" data-act="openAccount">${esc(t('settings.openAccount'))}</button>${planBtn}</div>
<div class="grid1"><button class="btn btn-secondary" data-act="unlink">${esc(t('settings.unlink'))}</button></div></section>`];
  const right = [`<section class="card" aria-labelledby="p-h"><h2 id="p-h" class="sec-title">${esc(t('settings.privacy'))}</h2>
<div class="row tall"><div class="stack"><span>${esc(t('settings.stats'))}</span><span class="hint">${esc(t('settings.statsHint'))}</span></div><button class="switch" role="switch" aria-checked="${s.telemetry !== false}" aria-label="${esc(t('settings.stats'))}" data-set="telemetryEnabled"></button></div>
<div class="row tall"><div class="stack"><span>${esc(t('settings.history'))}</span><span class="hint">${esc(t('settings.historyHint'))}</span></div><button class="switch" role="switch" aria-checked="${!!s.localHistory}" aria-label="${esc(t('settings.history'))}" data-set="localHistory"></button></div></section>`, toolsCard(), `<section class="card" aria-labelledby="u-h"><h2 id="u-h" class="sec-title">${esc(t('settings.updates'))}</h2>
<div class="row tall"><div class="stack"><span>${esc(t('settings.version', { v: state.version }))}</span>${uline}</div>${updateInfo?.latest && !updateInfo.upToDate && !updateInfo.updating ? `<button class="btn btn-primary w120" data-act="update">${esc(t('settings.updateNow'))}</button>` : `<button class="btn btn-secondary w120" data-act="checkUpdate"${updateInfo?.updating ? ' disabled' : ''}>${esc(t('settings.check'))}</button>`}</div></section>`].filter(Boolean);
  return `<main class="settings">${bannerHtml()}<h1>${esc(t('settings.title'))}</h1>
<div class="pairs">${left.map((c, i) => c + (right[i] || '<div></div>')).join('')}</div>
<section class="card danger-card" aria-labelledby="x-h"><h2 id="x-h" class="sec-title">${esc(t('settings.remove'))}</h2>
<div class="row tall note-sm"><span class="grow wrap">${esc(t('settings.removeText'))}</span><button class="btn btn-danger w120" data-act="uninstall">${esc(t('settings.uninstall'))}</button></div></section></main>`;
};

const HELP = ['talk', 'start', 'queue', 'agents', 'confirm', 'folders', 'undo', 'privacy', 'trouble'];
const PHRASES = ['setup', 'add', 'work', 'continue', 'delegate', 'show', 'confirmOn'];
const phraseList = () => `<div class="phrases">${PHRASES.map((k) => `<div class="phrase"><div class="stack"><span class="mono">${esc(t(`talk.${k}`))}</span><span class="hint">${esc(t(`talk.${k}Hint`))}</span></div><button class="btn btn-secondary w96" data-copy="${esc(t(`talk.${k}`))}">${esc(t('talk.copy'))}</button></div>`).join('')}</div>`;
P.help = () => {
  if (helpTopic === 'talk') return `<main class="helpp">${bannerHtml()}<h1>${esc(t('help.title'))}</h1><div class="help">
<nav class="topics" aria-label="${esc(t('aria.helpTopics'))}">${HELP.map((k) => `<button data-topic="${k}" aria-current="${k === helpTopic ? 'page' : 'false'}">${esc(k === 'talk' ? t('talk.label') : S.help.topics[k].label)}</button>`).join('')}<div class="grow"></div>
<button class="btn btn-secondary" data-act="support">${esc(t('help.support'))}</button></nav>
<article class="card article"><h2>${esc(t('talk.title'))}</h2><p>${esc(t('talk.intro'))}</p>${phraseList()}</article></div></main>`;
  const d = S.help.topics[helpTopic];
  return `<main class="helpp">${bannerHtml()}<h1>${esc(t('help.title'))}</h1><div class="help">
<nav class="topics" aria-label="${esc(t('aria.helpTopics'))}">${HELP.map((k) => `<button data-topic="${k}" aria-current="${k === helpTopic ? 'page' : 'false'}">${esc(k === 'talk' ? t('talk.label') : S.help.topics[k].label)}</button>`).join('')}<div class="grow"></div>
<button class="btn btn-secondary" data-act="support">${esc(t('help.support'))}</button></nav>
<article class="card article"><h2>${esc(d.title)}</h2><p>${esc(d.intro)}</p><ol>${d.steps.map((s, i) => `<li><span class="num">${i + 1}</span><span>${esc(s)}</span></li>`).join('')}</ol>
<div class="tip"><span class="k">${esc(t(`help.${d.tipLabel}`))}</span><span class="mono">${esc(d.tip)}</span></div></article></div></main>`;
};

function render() {
  renderNav();
  $('#main').outerHTML = P[page]().replace('<main class="', '<main id="main" class="');
  document.querySelectorAll('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; }); // CSSOM: allowed by the CSP
}

// ---- in-window toast (Undo / Copied) ----------------------------------------------------------------
let snackTimer;
function snack(text, undo) {
  const l = $('#layer');
  l.querySelector('.snack')?.remove();
  const el = document.createElement('div');
  el.className = `snack ${undo ? '' : 'plain'}`; el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(text)}</span>${undo ? `<button class="btn btn-secondary">${esc(t('queue.undo'))}</button>` : ''}`;
  if (undo) el.querySelector('button').onclick = () => { el.remove(); undo(); };
  l.append(el);
  clearTimeout(snackTimer); snackTimer = setTimeout(() => el.remove(), undo ? 8000 : 2000);
}
const fail = (e) => snack(/CONFIRM_LOCKED/.test(String((e && e.message) || e)) ? t('settings.confirmLocked') : t('error', { msg: e.message || e }));

// ---- Undo AI changes ------------------------------------------------------------------------------------
async function runUndo(ids) {
  try {
    const r = await rpc('undo.run', { ids });
    await refresh(true);
    const n = (r && r.restored ? r.restored.length : 0), sk = (r && r.skipped) || [];
    if (!sk.length) return snack(t('recent.undoneN', { n }));
    const o = document.createElement('div');
    o.className = 'overlay';
    o.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="us-t"><h2 id="us-t">${esc(t('recent.skippedTitle', { n }))}</h2><p>${esc(t('recent.skippedText'))}</p>
<pre class="diff mono">${esc(sk.map((x) => `${x.path || '—'}: ${x.why}`).join('\n'))}</pre><div class="dlg-foot"><div class="grow"></div><button class="btn btn-primary w96" data-x>${esc(t('recent.ok'))}</button></div></section>`;
    o.querySelector('[data-x]').onclick = closeLayer;
    $('#layer').append(o); o.querySelector('[data-x]').focus();
  } catch (e) { fail(e); }
}
function undoDialog() {
  const groups = (undoInfo && undoInfo.groups) || [];
  const last = undoInfo && undoInfo.actions.find((a) => !a.undone);
  const tm = (x) => { const d = new Date(x); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const rows = [
    ...(last ? [`<div class="phrase"><div class="stack"><span>${esc(t('recent.lastChange'))}</span><span class="hint mono">${esc(`${tm(last.t)} · ${toolName(last.tool)} · ${last.label || last.paths[0] || ''}`)}</span></div><button class="btn btn-secondary w96" data-ids="${esc(last.id)}">${esc(t('recent.undo'))}</button></div>`] : []),
    ...groups.map((g) => `<div class="phrase"><div class="stack"><span>${esc(g.kind === 'task' ? t('recent.taskGroup', { title: g.title }) : t('recent.batchGroup', { from: tm(g.t0), to: tm(g.t1) }))}</span><span class="hint">${esc(t('recent.changes', { n: g.ids.length }))}</span></div><button class="btn btn-secondary w96" data-ids="${esc(g.ids.join(','))}">${esc(t('recent.undo'))}</button></div>`),
  ].join('');
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="ud-t"><h2 id="ud-t">${esc(t('recent.undoTitle'))}</h2><p>${esc(t('recent.undoText'))}</p>
<div class="phrases">${rows || `<div class="empty">${esc(t('recent.nothingToUndo'))}</div>`}</div><div class="dlg-foot"><div class="grow"></div><button class="btn btn-secondary w96" data-x>${esc(t('settings.cancel'))}</button></div></section>`;
  o.querySelector('[data-x]').onclick = closeLayer;
  o.querySelectorAll('[data-ids]').forEach((b) => { b.onclick = () => { closeLayer(); runUndo(b.dataset.ids.split(',')); }; });
  $('#layer').append(o); o.querySelector('[data-x]').focus();
}

// ---- dialogs ------------------------------------------------------------------------------------------
function closeLayer() { $('#layer').querySelectorAll('.overlay, .menu').forEach((e) => e.remove()); render(); }
function confirmDialog(title, text, goLabel, onGo) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="cd-t"><h2 id="cd-t">${esc(title)}</h2><p>${esc(text)}</p><div class="dlg-foot"><div class="grow"></div><button class="btn btn-secondary w96" data-x>${esc(t('settings.cancel'))}</button><button class="btn btn-danger w96" data-go>${esc(goLabel)}</button></div></section>`;
  o.querySelector('[data-x]').onclick = closeLayer;
  o.querySelector('[data-go]').onclick = () => { closeLayer(); onGo(); };
  $('#layer').append(o); o.querySelector('[data-x]').focus();
}

// ---- usage forecast (Status) --------------------------------------------------------------------------
// The month's pace from the relay's numbers (plan.mjs forecast); shown only here, never in ChatGPT.
function forecastLine() {
  const u = state.usage;
  if (!u) return '';
  const loc = state.settings.language === 'ru' ? 'ru-RU' : 'en-US';
  const k = u.state === 'unlimited' ? t('status.callsMonth', { calls: nf().format(u.calls) })
    : u.state === 'enough' ? t('status.forecastEnough')
    : u.state === 'runs_out' ? t('status.forecastOut', { date: new Date(`${u.date}T00:00:00`).toLocaleDateString(loc, { day: 'numeric', month: 'short' }) })
    : '';
  return k ? `<div class="hint forecast ${u.state === 'runs_out' ? 'warn-text' : ''}">${esc(k)}</div>` : '';
}

// ---- Automations (scheduled scripts) -------------------------------------------------------------------
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const when = (ms) => { const loc = state.settings.language === 'ru' ? 'ru-RU' : 'en-US'; return new Date(ms).toLocaleString(loc, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); };
function schedText(s) {
  if (!s) return t('auto.manual');
  if (s.type === 'daily') return t('auto.daily', { time: s.time });
  if (s.type === 'weekly') return t('auto.weekly', { days: s.days.map((d) => t(`auto.d_${d}`)).join(', '), time: s.time });
  if (s.type === 'hourly') return s.every === 1 ? t('auto.hourly1') : t('auto.hourly', { n: s.every });
  if (s.type === 'logon') return t('auto.logon');
  const [d, hm] = s.at.split('T'); const [y, mo, dd] = d.split('-').map(Number); const [h, mi] = hm.split(':').map(Number);
  return t('auto.once', { when: when(new Date(y, mo - 1, dd, h, mi).getTime()) });
}
function lastText(a) {
  if (a.running) return t('auto.running');
  if (!a.last) return t('auto.neverRun');
  return a.last.code === 0 ? t('auto.lastOk', { ago: ago(Date.parse(a.last.t)) }) : t('auto.lastFail', { ago: ago(Date.parse(a.last.t)), code: a.last.code });
}
P.automations = () => {
  const list = state.automations || [];
  const notifyOn = state.settings.automations ? state.settings.automations.notifySchedule !== false : true;
  const rows = list.map((a) => {
    const dot = a.running ? 'doing' : a.last && a.last.code !== 0 ? 'failed' : !a.enabled ? 'skipped' : a.last ? 'done' : 'todo';
    const parts = [schedText(a.schedule)];
    if (a.schedule && !a.scheduled) parts.push(t('auto.notScheduled'));
    else if (a.schedule && !a.enabled) parts.push(t('auto.off'));
    else if (a.next) parts.push(t('auto.next', { when: when(a.next) }));
    parts.push(lastText(a));
    return `<div class="qrow arow" role="listitem"><span class="sdot ${dot}" aria-hidden="true"></span>
<div class="qtext"><span class="t">${esc(a.name)}</span><span class="n" title="${esc(a.taskError || '')}">${esc(parts.join(' · '))}</span></div>
${a.schedule ? `<button class="switch" role="switch" aria-checked="${a.enabled && a.scheduled}" aria-label="${esc(t('auto.toggle', { name: a.name }))}" data-auto-toggle="${esc(a.id)}" ${a.scheduled ? '' : 'disabled'}></button>` : '<span></span>'}
<button class="btn btn-secondary w112" data-auto-run="${esc(a.id)}" ${a.running ? 'disabled' : ''}>${esc(t('auto.runNow'))}</button>
<button class="icon-btn" data-act="amenu" data-id="${esc(a.id)}" aria-label="${esc(t('queue.more'))}"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></svg></button></div>`;
  }).join('');
  const phrases = ['autoBackup', 'autoClean', 'autoReport'].map((k) => `<div class="phrase"><span class="mono grow">${esc(t(`auto.${k}`))}</span><button class="btn btn-secondary w96" data-copy="${esc(t(`auto.${k}`))}">${esc(t('talk.copy'))}</button></div>`).join('');
  return `<main class="automations">${bannerHtml()}
<div class="head"><h1>${esc(t('auto.title'))}</h1><div class="sub">${esc(t('auto.sub'))}</div></div>
<div role="list" class="card list" id="alist">${rows || `<div class="empty">${esc(t('auto.empty'))}</div>`}</div>
${list.length ? '' : `<section class="card phrases">${phrases}</section>`}
<div class="toggle-line"><button class="switch" role="switch" aria-checked="${notifyOn}" data-set="automations.notifySchedule" aria-label="${esc(t('auto.notify'))}"></button><span>${esc(t('auto.notify'))}</span></div></main>`;
};
function autoMenu(btn) {
  const a = (state.automations || []).find((x) => x.id === btn.dataset.id);
  if (!a) return;
  $('#layer').querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = [['log', 'auto.showLog'], ['delete', 'auto.delete']].map(([k, l]) => `<button role="menuitem" data-m="${k}" class="${k === 'delete' ? 'danger' : ''}">${esc(t(l))}</button>`).join('');
  const r = btn.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 100)}px`; m.style.left = `${Math.max(8, r.right - 180)}px`;
  m.onclick = async (e) => {
    const k = e.target.closest('[data-m]')?.dataset.m; if (!k) return;
    m.remove();
    if (k === 'log') return autoLog(a.id);
    try {
      const removed = await rpc('automation.remove', { id: a.id });
      await refresh();
      snack(t('auto.deleted', { name: a.name }), async () => { try { await rpc('automation.restore', { removed }); refresh(); } catch (err) { fail(err); } });
    } catch (err) { fail(err); }
  };
  $('#layer').append(m); m.querySelector('button').focus();
  setTimeout(() => document.addEventListener('click', function off(ev) { if (!m.contains(ev.target)) m.remove(); document.removeEventListener('click', off); }), 0);
}
async function autoLog(id) {
  let a;
  try { a = await rpc('automation.get', { id }); } catch (e) { return fail(e); }
  const o = document.createElement('div');
  o.className = 'overlay';
  const runs = (a.runs || []).map((r) => `<details class="run"><summary><span class="pill ${r.code === 0 ? 't-done' : 't-failed'}">${esc(r.code === 0 ? t('auto.ok') : t('auto.code', { code: r.code }))}</span><span>${esc(when(Date.parse(r.t)))}</span><span class="hint">${esc(t(`auto.by_${['schedule', 'manual', 'ai'].includes(r.trigger) ? r.trigger : 'schedule'}`))} · ${esc(t('auto.secs', { n: Math.max(1, Math.round(r.ms / 1000)) }))}</span></summary><pre class="diff mono">${esc(r.tail || t('auto.noOutput'))}</pre></details>`).join('');
  o.innerHTML = `<section class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="al-t"><h2 id="al-t">${esc(a.name)}</h2><p class="hint">${esc(schedText(a.schedule))}</p>
<div class="runs">${runs || `<div class="empty">${esc(t('auto.noRuns'))}</div>`}</div>
<details class="run"><summary>${esc(t('auto.script'))}</summary><pre class="diff mono">${esc(a.script)}</pre></details>
<div class="dlg-foot"><div class="grow"></div><button class="btn btn-secondary w96" data-x>${esc(t('auto.close'))}</button></div></section>`;
  o.querySelector('[data-x]').onclick = closeLayer;
  const first = o.querySelector('.runs details'); if (first) first.open = true;
  $('#layer').append(o); o.querySelector('[data-x]').focus();
}

// ---- Agents (AI ↔ AI delegation, bridge delegate.mjs) ----------------------------------------------------------
// Detected agent CLIs, per-agent allow (on once found), limits, the run log with Undo. Everything here is also
// readable / settable by the AI (bridgerator_settings `delegate`); changes from either side show on the next refresh.
const RUN_PILL = { running: 'doing', done: 'done', failed: 'failed', timeout: 'failed', interrupted: 'failed', cancelled: 'skipped' };
const AGENT_LIMITS = [['parallel', [1, 2, 3, 4], 'agents.n'], ['timeoutMin', [5, 10, 15, 30, 60, 120, 240], 'agents.minutes'], ['maxOutputKb', [8, 16, 32, 64, 128, 256], 'agents.kb'], ['undoMb', [0, 50, 100, 200, 500, 1000, 2000], 'agents.mb']];
P.agents = () => {
  const g = state.agents || { checking: true, agents: [], limits: {}, runs: [] };
  const lim = g.limits || {};
  const rows = !g.agents.length ? `<div class="empty">${esc(t(g.checking ? 'agents.checking' : 'agents.none'))}</div>` : g.agents.map((a) => {
    const st = !a.found ? t('agents.notFound') : [a.version ? `v${a.version}` : '', t(`agents.signed_${['yes', 'no', 'unknown'].includes(a.signedIn) ? a.signedIn : 'unknown'}`), a.startable ? '' : t('agents.cantStart')].filter(Boolean).join(' · ');
    const dot = !a.found ? 'skipped' : !a.startable || a.signedIn === 'no' ? 'failed' : 'done';
    return `<div class="qrow arow agrow" role="listitem"><span class="sdot ${dot}" aria-hidden="true"></span>
<div class="qtext"><span class="t">${esc(a.name)}</span><span class="n">${esc(st)}</span>${a.path ? `<span class="n mono" title="${esc(a.path)}">${esc(a.path)}</span>` : ''}</div>
<span class="hint">${esc(t('agents.allow'))}</span><button class="switch" role="switch" aria-checked="${!!(a.found && a.allowed)}" aria-label="${esc(t('agents.allowFor', { name: a.name }))}" data-set="delegate.${esc(a.id)}" ${a.found ? '' : 'disabled'}></button></div>`;
  }).join('');
  const mode = lim.mode || 'full';
  const seg = ['read', 'edit', 'full'].map((k) => `<button role="radio" aria-checked="${mode === k}" data-set="delegate.mode" data-value="${k}">${esc(t(`agents.mode_${k}`))}</button>`).join('');
  const nums = AGENT_LIMITS.map(([k, list, label]) => `<div class="cat"><span class="grow">${esc(t(`agents.${k}`))}</span>${numSel(`delegate.${k}`, Number(lim[k] ?? list[0]), list, label)}</div>`).join('');
  const phrase = (k) => `<div class="phrase"><span class="mono grow">${esc(t(`agents.${k}`))}</span><button class="btn btn-secondary w96" data-copy="${esc(t(`agents.${k}`))}">${esc(t('talk.copy'))}</button></div>`;
  return `<main class="agents">${bannerHtml()}
<div class="head-row"><div class="head grow"><h1>${esc(t('agents.title'))}</h1><div class="sub">${esc(t('agents.sub'))}</div></div><button class="btn btn-secondary" data-act="detectAgents">${esc(t('agents.refresh'))}</button></div>
<div role="list" class="card list" id="aglist">${rows}</div>
<div class="two">
<section class="card confirm-card" aria-labelledby="al-h"><div class="top"><div class="stack"><h2 id="al-h">${esc(t('agents.limits'))}</h2><span class="hint">${esc(t('agents.modeHint'))}</span></div></div>
<div class="cat"><span class="grow" id="am-l">${esc(t('agents.mode'))}</span><div class="seg w168" role="radiogroup" aria-labelledby="am-l">${seg}</div></div>${nums}
<div class="note"><span>${esc(t('agents.undoHint'))}</span></div></section>
<section class="card confirm-card phrases" aria-labelledby="ap-h"><div class="top"><div class="stack"><h2 id="ap-h">${esc(t('agents.sayChatgpt'))}</h2></div></div>${phrase('p1')}${phrase('p2')}
<div class="top"><div class="stack"><h2>${esc(t('agents.sayOther'))}</h2><span class="hint">${esc(t('agents.p3hint'))}</span></div></div>${phrase('p3')}</section></div>
</main>`;
};
// Agent tasks (owner 21.10: own page, newest on top; "Keep finished agent tasks" in Settings, on by default).
P.delegated = () => {
  const g = state.agents || { runs: [] };
  const keep = (state.extraSettings || []).find((x) => x.key === 'delegate.keepFinished')?.value !== false;
  const list = (g.runs || []).filter((r) => keep || r.state === 'running');
  const runs = list.map((r) => {
    const files = r.changed ? r.changed.modified + r.changed.created + r.changed.deleted : null;
    const meta = [when(Date.parse(r.startedAt)), r.name, t('agents.from', { from: r.from || '—' }), files === null ? '' : files ? t('agents.changed', { n: files }) : t('agents.noChanges')].filter(Boolean).join(' · ');
    const act = r.state === 'running' ? `<button class="btn btn-secondary w96" data-dcancel="${esc(r.id)}">${esc(t('agents.stop'))}</button>`
      : r.undoId && !r.undone ? `<button class="btn btn-secondary w96" data-undo="${esc(r.undoId)}">${esc(t('agents.undo'))}</button>`
      : r.undoId ? `<span class="hint w96">${esc(t('agents.undone'))}</span>` : '<span class="w96"></span>';
    return `<div class="qrow arow" role="listitem"><span class="sdot ${RUN_PILL[r.state] || 'skipped'}" aria-hidden="true"></span>
<div class="qtext"><span class="t" title="${esc(r.task || '')}">${esc(r.summary || r.task || '')}</span><span class="n">${esc(meta)}</span><span class="n mono" title="${esc(r.folder)}">${esc(r.folder)}</span></div>
<span class="qpill"><span class="pill t-${RUN_PILL[r.state] || 'skipped'}">${esc(t(`agents.st_${r.state}`))}</span></span>${act}
<button class="icon-btn" data-drun="${esc(r.id)}" aria-label="${esc(t('agents.details'))}" title="${esc(t('agents.details'))}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 11v5M12 8h.01"></path></svg></button></div>`;
  }).join('');
  return `<main class="delegated">${bannerHtml()}
<div class="head-row"><div class="head grow"><h1>${esc(t('agents.log'))}</h1><div class="sub">${esc(t(keep ? 'agents.logSub' : 'agents.logSubRunning'))}</div></div></div>
<div role="list" class="card list" id="drlist">${runs || `<div class="empty">${esc(t('agents.empty'))}</div>`}</div></main>`;
};
async function runDialog(id) {
  let r;
  try { r = await rpc('delegate.get', { id }); } catch (e) { return fail(e); }
  const o = document.createElement('div');
  o.className = 'overlay';
  const list = (k, l) => (l && l.length ? `<p class="hint">${esc(t(`agents.dlg_${k}`))}</p><pre class="diff mono">${esc(l.join('\n'))}</pre>` : '');
  const f = r.files || {};
  o.innerHTML = `<section class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="dr-t"><h2 id="dr-t">${esc(`${(state.agents?.agents || []).find((a) => a.id === r.agent)?.name || r.agent} · ${t(`agents.st_${r.state}`)}`)}</h2>
<p class="hint">${esc([t('agents.from', { from: r.from || '—' }), r.folder, r.mode].join(' · '))}</p>
<details class="run"><summary>${esc(t('agents.dlgTask'))}</summary><pre class="diff mono">${esc(r.task || '')}</pre></details>
<p class="hint">${esc(t('agents.dlgAnswer'))}</p><pre class="diff mono">${esc(r.text || r.error || '—')}</pre>
${list('modified', f.modified)}${list('created', f.created)}${list('deleted', f.deleted)}
<div class="dlg-foot"><div class="grow"></div><button class="btn btn-secondary w96" data-x>${esc(t('agents.close'))}</button></div></section>`;
  o.querySelector('[data-x]').onclick = closeLayer;
  $('#layer').append(o); o.querySelector('[data-x]').focus();
}

// ---- plan card (bridgerator_plan): many similar actions, one answer -----------------------------------------
function batchDialog(b) {
  const o = document.createElement('div');
  o.className = 'overlay';
  const rows = b.rows.map((r) => `<label class="prow"><input type="checkbox" checked data-i="${r.i}"><span class="mono">${esc(r.text)}</span></label>`).join('');
  o.innerHTML = `<section class="dialog wide" role="dialog" aria-modal="true" aria-labelledby="bd-t"><h2 id="bd-t">${esc(b.head)}</h2><p>${esc(b.title ? `${b.title} — ${t('batch.text')}` : t('batch.text'))}</p>
<div class="head-row"><button class="linkbtn" data-all>${esc(t('batch.selectAll'))}</button><button class="linkbtn" data-none>${esc(t('batch.selectNone'))}</button><div class="grow"></div><span class="hint" id="bd-n"></span></div>
<div class="plist">${rows}</div>
<div class="dlg-foot"><button class="btn btn-secondary w96" data-x>${esc(t('batch.deny'))}</button><div class="grow"></div><button class="btn btn-secondary" data-sel>${esc(t('batch.allowSel'))}</button><button class="btn btn-primary" data-go>${esc(t('batch.allowAll'))}</button></div></section>`;
  const boxes = () => [...o.querySelectorAll('input[data-i]')];
  const count = () => { const n = boxes().filter((x) => x.checked).length; $('#bd-n', o).textContent = t('batch.selected', { n, total: b.rows.length }); o.querySelector('[data-sel]').disabled = !n; };
  // Buttons off while the answer is on its way: a double click never sends two decisions.
  const decide = async (allow) => {
    if (o.dataset.busy) return;
    o.dataset.busy = '1'; o.querySelectorAll('button, input').forEach((x) => { x.disabled = true; });
    try { await rpc('batch.decide', { id: b.id, allow }); closeLayer(); } catch (e) { delete o.dataset.busy; o.querySelectorAll('button, input').forEach((x) => { x.disabled = false; }); count(); shownBatch = null; fail(e); }
  };
  o.querySelector('[data-x]').onclick = () => decide([]);
  o.querySelector('[data-go]').onclick = () => decide(b.rows.map((r) => r.i));
  o.querySelector('[data-sel]').onclick = () => decide(boxes().filter((x) => x.checked).map((x) => Number(x.dataset.i)));
  o.querySelector('[data-all]').onclick = () => { boxes().forEach((x) => { x.checked = true; }); count(); };
  o.querySelector('[data-none]').onclick = () => { boxes().forEach((x) => { x.checked = false; }); count(); };
  o.addEventListener('change', count);
  $('#layer').append(o); count(); o.querySelector('[data-x]').focus();
}

// A settings proposal from ChatGPT too long for a notification: the full diff, Apply here.
function setupDialog(ps) {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="sd-t"><h2 id="sd-t">${esc(t('setup.title'))}</h2><p>${esc(t('setup.text'))}</p>
<pre class="diff mono">${esc(ps.lines.join('\n'))}</pre><div class="dlg-foot"><div class="grow"></div><button class="btn btn-secondary w96" data-x>${esc(t('settings.cancel'))}</button><button class="btn btn-primary w96" data-go>${esc(t('setup.apply'))}</button></div></section>`;
  const decide = async (apply) => {
    if (o.dataset.busy) return;
    o.dataset.busy = '1'; o.querySelectorAll('button').forEach((x) => { x.disabled = true; });
    try { await rpc('setup.decide', { id: ps.id, apply }); closeLayer(); } catch (e) { delete o.dataset.busy; o.querySelectorAll('button').forEach((x) => { x.disabled = false; }); shownSetup = null; fail(e); }
  };
  o.querySelector('[data-x]').onclick = () => decide(false);
  o.querySelector('[data-go]').onclick = () => decide(true);
  $('#layer').append(o); o.querySelector('[data-x]').focus();
}

function taskDialog(item) {
  const it = item ? { ...item, paths: [...(item.paths || [])] } : { title: '', details: '', paths: [], status: 'todo' };
  const o = document.createElement('div');
  o.className = 'overlay';
  const draw = () => {
    o.innerHTML = `<section class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-t"><h2 id="dlg-t">${esc(t(item ? 'edit.titleEdit' : 'edit.titleNew'))}</h2>
<div class="field"><label for="t-title">${esc(t('edit.task'))}</label><input id="t-title" class="input" maxlength="200" value="${esc(it.title)}"></div>
<div class="field"><label for="t-details">${esc(t('edit.details'))} <span class="opt">${esc(t('edit.optional'))}</span></label><textarea id="t-details" class="textarea" rows="3" maxlength="4000">${esc(it.details || '')}</textarea></div>
<div class="field"><span class="flabel">${esc(t('edit.files'))}</span><div class="chips">${it.paths.map((p, i) => `<span class="chip inline"><span title="${esc(p)}">${esc(p)}</span><button aria-label="${esc(t('edit.remove', { path: p }))}" data-rm="${i}">✕</button></span>`).join('')}
<button class="btn btn-dashed" data-pick="file">${esc(t('edit.addFile'))}</button><button class="btn btn-dashed" data-pick="folder">${esc(t('edit.addFolder'))}</button></div><span class="note-sm">${esc(t('edit.dropHint'))}</span></div>
${item ? `<div class="head-row"><label for="t-status" class="flabel">${esc(t('edit.status'))}</label><select id="t-status" class="select">${STATUSES.map((s) => `<option value="${s}" ${it.status === s ? 'selected' : ''}>${esc(t(`queue.${s}`))}</option>`).join('')}</select></div>` : ''}
<span class="err" id="t-err" hidden>${esc(t('edit.needTitle'))}</span>
<div class="dlg-foot">${item ? `<button class="btn btn-danger w96" data-del>${esc(t('edit.delete'))}</button>` : ''}<div class="grow"></div><button class="btn btn-secondary w96" data-x>${esc(t('edit.cancel'))}</button><button class="btn btn-primary w96" data-save>${esc(t('edit.save'))}</button></div></section>`;
    const keep = () => { it.title = $('#t-title', o).value; it.details = $('#t-details', o).value; const s = $('#t-status', o); if (s) it.status = s.value; };
    o.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { keep(); it.paths.splice(Number(b.dataset.rm), 1); draw(); }; });
    o.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = async () => { keep(); try { const r = await rpc(b.dataset.pick === 'file' ? 'pickFiles' : 'pickFolder', {}, undefined, 0); for (const p of [].concat(r || [])) if (p && !it.paths.includes(p)) it.paths.push(p); draw(); } catch (e) { fail(e); } }; });
    o.querySelector('[data-x]').onclick = closeLayer;
    const del = o.querySelector('[data-del]'); if (del) del.onclick = () => { closeLayer(); deleteTask(item); };
    o.querySelector('[data-save]').onclick = async () => {
      keep();
      if (!it.title.trim()) { $('#t-err', o).hidden = false; $('#t-title', o).focus(); return; }
      try {
        if (item) { await rpc('queue.edit', { id: item.id, title: it.title, details: it.details, paths: it.paths }); if (it.status !== item.status) await rpc('queue.update', { id: item.id, status: it.status }); }
        else await rpc('queue.add', { title: it.title, details: it.details || undefined, paths: it.paths });
        closeLayer(); refresh();
      } catch (e) { fail(e); }
    };
    // Files dragged in from Explorer: their paths come through the host (WebView2 file objects).
    const dlg = o.querySelector('.dialog');
    dlg.ondragover = (e) => { e.preventDefault(); dlg.classList.add('drop'); };
    dlg.ondragleave = () => dlg.classList.remove('drop');
    dlg.ondrop = async (e) => {
      e.preventDefault(); dlg.classList.remove('drop'); keep();
      try { const r = await rpc('droppedPaths', {}, [...e.dataTransfer.files]); for (const p of [].concat(r || [])) if (p && !it.paths.includes(p)) it.paths.push(p); draw(); } catch (err) { fail(err); }
    };
  };
  draw();
  $('#layer').append(o); $('#t-title', o).focus();
}

async function deleteTask(item) {
  try {
    const removed = await rpc('queue.remove', { id: item.id });
    await refresh();
    snack(t('queue.deleted'), async () => { try { await rpc('queue.restore', { item: removed }); refresh(); } catch (e) { fail(e); } });
  } catch (e) { fail(e); }
}

function queueMenu(btn) {
  const item = queueItems.find((i) => i.id === btn.dataset.id);
  if (!item) return;
  $('#layer').querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  const acts = [['edit', 'queue.edit'], ['top', 'queue.toTop'], item.status === 'done' ? ['todo', 'queue.markTodo'] : ['done', 'queue.markDone'], ['delete', 'queue.delete']];
  m.innerHTML = acts.map(([a, k]) => `<button role="menuitem" data-m="${a}" class="${a === 'delete' ? 'danger' : ''}">${esc(t(k))}</button>`).join('');
  const r = btn.getBoundingClientRect();
  m.style.top = `${Math.min(r.bottom + 4, window.innerHeight - 160)}px`; m.style.left = `${Math.max(8, r.right - 180)}px`;
  m.onclick = async (e) => {
    const a = e.target.closest('[data-m]')?.dataset.m; if (!a) return;
    m.remove();
    try {
      if (a === 'edit') return taskDialog(item);
      if (a === 'delete') return deleteTask(item);
      if (a === 'top') await rpc('queue.reorder', { ids: [item.id] });
      if (a === 'done' || a === 'todo') await rpc('queue.update', { id: item.id, status: a });
      refresh();
    } catch (err) { fail(err); }
  };
  $('#layer').append(m); m.querySelector('button').focus();
  setTimeout(() => document.addEventListener('click', function off(ev) { if (!m.contains(ev.target)) { m.remove(); } document.removeEventListener('click', off); }), 0);
}

// "Clear…": done / failed + skipped / all — no dialog, Undo in the window.
function clearMenu(btn) {
  $('#layer').querySelector('.menu')?.remove();
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = [['done', 'queue.clearDone'], ['failed+skipped', 'queue.clearFailed'], ['all', 'queue.clearAll']].map(([v, k]) => `<button role="menuitem" data-c="${v}" class="${v === 'all' ? 'danger' : ''}">${esc(t(k))}</button>`).join('');
  const r = btn.getBoundingClientRect();
  m.style.top = `${r.bottom + 4}px`; m.style.left = `${Math.max(8, r.right - 200)}px`;
  m.onclick = async (e) => {
    const v = e.target.closest('[data-c]')?.dataset.c; if (!v) return;
    m.remove();
    try {
      const gone = await rpc('queue.clear', { status: v });
      await refresh();
      if (gone.length) snack(t('queue.cleared', { n: gone.length }), async () => { try { await rpc('queue.restoreMany', { items: gone }); refresh(); } catch (err) { fail(err); } });
    } catch (err) { fail(err); }
  };
  $('#layer').append(m); m.querySelector('button').focus();
  setTimeout(() => document.addEventListener('click', function off(ev) { if (!m.contains(ev.target)) m.remove(); document.removeEventListener('click', off); }), 0);
}

// ---- actions ---------------------------------------------------------------------------------------------
async function setSetting(key, value) {
  try { await rpc('setSetting', { key, value }); await refresh(); } catch (e) { fail(e); refresh(); }
}
// The title bar moves the window: the host starts the native move (no CSS app-region — it swallowed the buttons' clicks).
document.addEventListener('mousedown', (e) => { if (e.button === 0 && e.target.closest('.titlebar') && !e.target.closest('button')) rpc('drag').catch(() => {}); });
document.addEventListener('click', async (e) => {
  const el = e.target.closest('button, a');
  if (!el) return;
  if (el.closest('#layer .dialog, #layer .menu, #layer .snack')) return;
  const d = el.dataset;
  if (el.id === 'w-min') return rpc('hide').catch(() => {}); // owner 21.10: only "minimize", and it goes to the tray
  if (d.copy) { try { await navigator.clipboard.writeText(d.copy); snack(t('copied')); } catch (err) { fail(err); } return; }
  if (d.filter) { qFilter = d.filter; return render(); }
  if (d.topic) { helpTopic = d.topic; return render(); }
  if (d.preview) { previewTheme = d.preview; return render(); }
  if (d.tab) { safetyTab = d.tab; return refresh(); }
  if (d.undo) return runUndo([d.undo]);
  if (d.dcancel) return rpc('delegate.cancel', { id: d.dcancel }).then(() => refresh(), (err) => { fail(err); refresh(); });
  if (d.drun) return runDialog(d.drun);
  if (d.autoRun) { snack(t('auto.started')); return rpc('automation.run', { id: d.autoRun }).then(() => refresh(), fail); }
  if (d.autoToggle) return rpc('automation.enable', { id: d.autoToggle, on: el.getAttribute('aria-checked') !== 'true' }).then(() => refresh(), (err) => { fail(err); refresh(); });
  if (d.set) {
    const v = d.value !== undefined ? d.value : el.getAttribute('aria-checked') !== 'true';
    return setSetting(d.set, v);
  }
  if (d.rmdir) {
    const list = (state.settings[d.rmdir] || []).filter((p) => p !== d.path);
    return setSetting(d.rmdir, list);
  }
  if (d.adddir) {
    try { const p = await rpc('pickFolder', {}, undefined, 0); if (p) setSetting(d.adddir, [...(state.settings[d.adddir] || []), p]); } catch (err) { fail(err); }
    return;
  }
  switch (d.act) {
    case 'openAccount': return rpc('openUrl', { url: 'https://bridgerator.recondeck.com/app' }).catch(fail);
    case 'support': return rpc('openUrl', { url: 'https://bridgerator.recondeck.com/support' }).catch(fail);
    case 'plan': return rpc('openUrl', { url: state.banner?.url || state.plan?.renewUrl || 'https://bridgerator.recondeck.com/app' }).catch(fail);
    case 'dismissBanner': return rpc('dismissBanner').then(() => refresh(), fail);
    case 'chatgptAllow': return rpc('openUrl', { url: CHATGPT_PERMISSIONS }).then(() => rpc('chatgptAllowOpened')).then(() => refresh(), fail);
    case 'pause': case 'resume': return rpc(d.act).then(() => refresh(), fail);
    case 'addTask': return taskDialog(null);
    case 'allowAll': return setSetting('allowedDirectories', []);
    case 'qmenu': e.stopPropagation(); return queueMenu(el);
    case 'clearMenu': e.stopPropagation(); return clearMenu(el);
    case 'amenu': e.stopPropagation(); return autoMenu(el);
    case 'clearRecent': return rpc('recent.clear').then(() => { snack(t('recent.cleared')); refresh(); }, fail);
    case 'undoDialog': return undoDialog();
    case 'detectAgents': snack(t('agents.checking')); return rpc('delegate.detect').then(() => refresh(), fail);
    case 'clearSnapshots': return confirmDialog(t('safety.clearSnapsTitle'), t('safety.clearSnapsText'), t('safety.clearSnapsGo'), () => rpc('undo.clear').then(() => refresh(true), fail));
    case 'testNotification': snack(t('notify.testSent')); return rpc('testNotification').catch(fail);
    case 'update':
      try { await rpc('update', { version: updateInfo?.latest }); updateInfo = { ...updateInfo, updating: true }; } catch (err) { fail(err); }
      return render();
    case 'checkUpdate':
      updateInfo = { checking: true }; render();
      try { updateInfo = await rpc('checkUpdate'); } catch { updateInfo = { failed: true }; }
      return render();
    case 'unlink': return confirmDialog(t('settings.unlinkTitle'), t('settings.unlinkText'), t('settings.unlinkGo'), () => rpc('unlink').catch(fail));
    case 'uninstall': return confirmDialog(t('settings.uninstallTitle'), t('settings.uninstallText'), t('settings.uninstallGo'), () => rpc('uninstall').catch(fail));
    default:
  }
});
document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.id === 'st-lang') return setSetting('language', el.value);
  if (el.id === 's-timeout') return setSetting('confirm.timeout', Number(el.value));
  if (el.dataset && el.dataset.num) return setSetting(el.dataset.num, Number(el.value));
  if (el.id === 'r-result') { rResult = el.value; return render(); }
  if (el.id === 'st-name') return setSetting('deviceName', el.value.trim());
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'r-search') {
    rSearch = e.target.value;
    const pos = e.target.selectionStart; render();
    const i = $('#r-search'); i.focus(); i.setSelectionRange(pos, pos);
  }
});
document.addEventListener('keydown', (e) => {
  // Esc = the dialog's own Cancel (a settings proposal must get its answer, not just disappear).
  if (e.key === 'Escape') { const l = $('#layer'); if (l.querySelector('.overlay, .menu')) { e.preventDefault(); const x = l.querySelector('.overlay [data-x]'); if (x) x.click(); else closeLayer(); } }
  if (e.key === 'Enter' && e.target.id === 'st-name') e.target.blur();
});

// drag to reorder queue rows
let dragId = null;
document.addEventListener('dragstart', (e) => { const r = e.target.closest?.('.qrow'); if (r) { dragId = r.dataset.id; r.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; } });
document.addEventListener('dragover', (e) => { const r = e.target.closest?.('.qrow'); if (dragId && r) { e.preventDefault(); document.querySelectorAll('.drop-above').forEach((x) => x.classList.remove('drop-above')); r.classList.add('drop-above'); } });
document.addEventListener('dragend', () => { dragId = null; document.querySelectorAll('.dragging, .drop-above').forEach((x) => x.classList.remove('dragging', 'drop-above')); });
document.addEventListener('drop', async (e) => {
  const r = e.target.closest?.('.qrow');
  if (!dragId || !r) return;
  e.preventDefault();
  if (r.dataset.id === dragId) { dragId = null; return; } // dropped on itself: nothing moves
  const ids = queueItems.map((i) => i.id).filter((id) => id !== dragId);
  const at = ids.indexOf(r.dataset.id);
  if (at < 0) { dragId = null; return; }
  ids.splice(at, 0, dragId);
  dragId = null;
  try { await rpc('queue.reorder', { ids }); refresh(); } catch (err) { fail(err); }
});

// ---- routing / start -------------------------------------------------------------------------------------------
function go(p) {
  // #queue-edit:<id> opens that task (deep link from the tray / notifications).
  const m = /^queue-edit:([\w-]+)$/.exec(p);
  if (m) { page = 'queue'; location.hash = 'queue'; refresh(true).then(() => { const it = queueItems.find((i) => i.id === m[1]); if (it) taskDialog(it); }); return; }
  if (PAGES.includes(p)) { page = p; if (location.hash !== `#${p}`) location.hash = p; refresh(); }
}
window.addEventListener('hashchange', () => go(location.hash.slice(1) || 'home'));
(async () => {
  const h = location.hash.slice(1);
  page = PAGES.includes(h) ? h : 'home';
  await loadLang('en');
  await refresh(true);
  if (h && !PAGES.includes(h)) go(h);
  setInterval(() => { if (!document.hidden) refresh(); }, 2000);
})();
