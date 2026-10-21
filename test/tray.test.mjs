import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLink } from '../src/tray.mjs';
import { createQueue, queueTool } from '../src/queue.mjs';
import { createRecent, DAYS } from '../src/recent.mjs';

const lines = () => { const out = []; return { out, write: (l) => out.push(JSON.parse(l)) }; };
const tick = () => new Promise((r) => setImmediate(r));

test('tray link: ask → answer by id; unknown key = deny; timeout = deny; menu and rpc routed', async () => {
  const w = lines(), menu = [];
  const timers = [];
  const link = createLink(w.write, { onMenu: (a) => menu.push(a), onRpc: async (m, p, paths) => ({ m, p, paths }), setTimer: (fn) => { timers.push(fn); return 0; } });
  link.onLine('{"t":"ready"}');
  assert.equal(link.ready, true);
  const p1 = link.ask({ head: 'h', text: 'cmd', buttons: [['allow', 'Allow', ''], ['deny', 'Deny', 'deny']], secs: 120, host: 'PC' });
  const sent = w.out.at(-1);
  assert.equal(sent.t, 'ask');
  assert.equal(sent.attr, 'PC · auto-deny in 2 min');
  link.onLine(JSON.stringify({ t: 'answer', id: sent.id, key: 'allow' }));
  assert.equal(await p1, 'allow');
  const p2 = link.ask({ head: 'h', text: 'x', buttons: [['allow', 'Allow', ''], ['deny', 'Deny', 'deny']] });
  link.onLine(JSON.stringify({ t: 'answer', id: w.out.at(-1).id, key: 'format-c' }));
  assert.equal(await p2, 'deny');
  const p3 = link.ask({ head: 'h', text: 'x', buttons: [['allow', 'Allow', '']] });
  timers.at(-1)();
  assert.equal(await p3, 'deny', 'no answer = deny');
  link.onLine('{"t":"menu","action":"pause"}'); link.onLine('{"t":"menu","action":"rm -rf"}'); link.onLine('not json');
  assert.deepEqual(menu, ['pause']);
  link.onLine(JSON.stringify({ t: 'rpc', id: 'r1', method: 'queue.add', params: { title: 't' }, paths: ['C:\\a', 5] }));
  await tick(); await tick();
  assert.deepEqual(w.out.at(-1), { t: 'rpc-result', id: 'r1', result: { m: 'queue.add', p: { title: 't' }, paths: ['C:\\a'] } });
  const p4 = link.ask({ head: 'h', text: 'x', buttons: [['allow', 'Allow', '']] });
  link.lost();
  assert.equal(await p4, 'deny', 'helper gone = deny');
});

test('task queue: next marks doing, update with note, add/edit/reorder, stored locally', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brg-q-')), 'queue.json');
  const q = createQueue(file);
  const a = q.add({ title: 'Sort photos', paths: ['D:\\Photos'] }), b = q.add({ title: 'Rename invoices', details: 'by date' });
  assert.equal(JSON.parse(queueTool(q, 'queue_next').content[0].text).item.id, a.id);
  assert.equal(q.list('doing')[0].id, a.id);
  queueTool(q, 'queue_update', { id: a.id, status: 'done', note: '120 photos sorted' });
  assert.equal(q.list('done')[0].note, '120 photos sorted');
  assert.ok(q.list('done')[0].doneAt);
  q.reorder({ ids: [b.id] });
  assert.deepEqual(q.list().map((x) => x.id), [b.id, a.id]);
  q.edit({ id: b.id, title: 'Rename invoices 2025' });
  assert.equal(createQueue(file).list()[0].title, 'Rename invoices 2025', 'persisted');
  assert.match(queueTool(q, 'queue_update', { id: b.id, status: 'exploded' }).content[0].text, /status must be/);
  assert.match(queueTool(q, 'queue_add', { title: 'x'.repeat(201) }).content[0].text, /longer than/);
  assert.deepEqual(q.counts(), { todo: 1, doing: 0, done: 1, failed: 0, skipped: 0 });
  q.update({ id: b.id, status: 'doing' }); q.update({ id: b.id, status: 'done' });
  assert.match(JSON.parse(queueTool(q, 'queue_next').content[0].text).message, /empty/);
});

test('recent history: last 100 in memory; local file only when kept; 7-day retention; clear', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brg-r-')), 'recent.jsonl');
  let t = Date.now();
  const r = createRecent(file, { now: () => t });
  for (let i = 0; i < 120; i++) r.record('start_process', { command: `echo ${i}` }, 'ok');
  assert.equal(r.list().length, 100);
  assert.equal(r.list()[0].target, 'echo 119');
  assert.equal(fs.existsSync(file), false, 'nothing written while "keep" is off');
  const k = createRecent(file, { keepFile: true, now: () => t });
  k.record('write_file', { path: 'C:\\old.txt' }, 'ok');
  t += (DAYS + 1) * 86400000;
  k.record('read_file', { path: 'C:\\new.txt' }, 'ok');
  const again = createRecent(file, { keepFile: true, now: () => t });
  assert.deepEqual(again.list().map((e) => e.target), ['C:\\new.txt'], 'older than 7 days dropped');
  again.clear();
  assert.equal(fs.existsSync(file), false);
});

test('queue under parallel chats: 3 queue_next → 3 different items, worker shown; atomic file; restore after delete', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brg-q2-')), 'queue.json');
  const q = createQueue(file);
  for (const t of ['a', 'b', 'c', 'd']) q.add({ title: t });
  const got = await Promise.all(['chat 1', 'chat 2', 'chat 3'].map(async (w) => JSON.parse(queueTool(q, 'queue_next', { worker: w }).content[0].text).item));
  assert.equal(new Set(got.map((i) => i.id)).size, 3);
  assert.deepEqual(got.map((i) => i.worker), ['chat 1', 'chat 2', 'chat 3']);
  assert.deepEqual(createQueue(file).list('doing').length, 3, 'file is whole and up to date');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['queue.json'], 'no temp files left');
  const removed = q.remove({ id: got[1].id });
  q.restore({ item: removed });
  assert.equal(q.list()[1].id, got[1].id, 'back at its place');
});

test('several questions at once: answers go to the right call by id', async () => {
  const w = lines();
  const link = createLink(w.write, { setTimer: () => 0 });
  link.onLine('{"t":"ready"}');
  const b = [['allow', 'Allow', ''], ['allow10', 'Allow 10 min', ''], ['deny', 'Deny', 'deny']];
  const ps = [link.ask({ head: 'a', text: '1', buttons: b }), link.ask({ head: 'b', text: '2', buttons: b }), link.ask({ head: 'c', text: '3', buttons: b })];
  const ids = w.out.filter((m) => m.t === 'ask').map((m) => m.id);
  assert.equal(new Set(ids).size, 3);
  link.onLine(JSON.stringify({ t: 'answer', id: ids[2], key: 'deny' }));
  link.onLine(JSON.stringify({ t: 'answer', id: ids[0], key: 'allow10' }));
  link.onLine(JSON.stringify({ t: 'answer', id: ids[1], key: 'allow' }));
  assert.deepEqual(await Promise.all(ps), ['allow10', 'allow', 'deny']);
});

test('queue: add many at once, clear by status (window Undo restores), stale "doing" is resumed first', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'brg-q3-')), 'queue.json');
  let t = Date.parse('2026-10-20T10:00:00Z');
  const q = createQueue(file, { now: () => new Date(t).toISOString() });
  const added = JSON.parse(queueTool(q, 'queue_add', { items: [{ title: 'one' }, { title: 'two', paths: ['D:\\x'] }, { title: 'three' }] }).content[0].text).items;
  assert.equal(added.length, 3);
  assert.match(queueTool(q, 'queue_add', { items: [] }).content[0].text, /1–100/);
  assert.match(queueTool(q, 'queue_add', { items: Array.from({ length: 101 }, () => ({ title: 'x' })) }).content[0].text, /1–100/);
  const first = JSON.parse(queueTool(q, 'queue_next', { worker: 'chat A' }).content[0].text).item;
  t += 31 * 60 * 1000;                                   // chat A went quiet
  const resumed = JSON.parse(queueTool(q, 'queue_next', { worker: 'chat B' }).content[0].text).item;
  assert.equal(resumed.id, first.id); assert.equal(resumed.resumed, true); assert.equal(resumed.resumedFrom, 'chat A'); assert.equal(resumed.worker, 'chat B');
  assert.equal(JSON.parse(queueTool(q, 'queue_next', {}).content[0].text).item.title, 'two', 'not stale: the next todo');
  q.update({ id: added[0].id, status: 'done' }); q.update({ id: added[1].id, status: 'failed' });
  const list = JSON.parse(queueTool(q, 'queue_list', {}).content[0].text);
  assert.deepEqual(list.counts, { todo: 1, doing: 0, done: 1, failed: 1, skipped: 0 });
  assert.deepEqual(Object.keys(list.items[0]).sort(), ['id', 'status', 'title', 'updatedAt']);
  assert.equal(JSON.parse(queueTool(q, 'queue_clear', { status: 'done' }).content[0].text).removed, 1);
  assert.match(queueTool(q, 'queue_clear', { status: 'all' }).content[0].text, /needs the person/);
  const gone = q.clear({ status: 'all' });
  assert.equal(q.list().length, 0);
  q.restoreMany({ items: gone });
  assert.deepEqual(q.list().map((x) => x.title), ['two', 'three'], 'Undo puts them back in order');
});

test('every [BrWin]::Member the helper calls is a public static member OF BrWin (a class closed too early broke keep-awake)', () => {
  const ps = fs.readFileSync(new URL('../src/tray.ps1', import.meta.url), 'utf8');
  const start = ps.indexOf('public static class BrWin {');
  const body = ps.slice(start, ps.indexOf('\n}\n', start));
  const used = [...new Set([...ps.matchAll(/\[BrWin\]::(\w+)/g)].map((m) => m[1]))];
  assert.ok(used.includes('Awake') && used.includes('Drag') && used.includes('MainForm'));
  for (const n of used) assert.match(body, new RegExp(`public static [^;{(]*\\b${n}\\b`), n);
});

test('tray.ps1 (A4): HICON destroyed + icon redrawn only on change; prewarm never opens the browser; every exit hides the icon', () => {
  const ps = fs.readFileSync(new URL('../src/tray.ps1', import.meta.url), 'utf8');
  assert.match(ps, /DestroyIcon\(IntPtr h\)/);
  assert.match(ps, /\[BrWin\]::DestroyIcon\(\$oldH\)/);
  assert.match(ps, /\$script:iconKey -ne /, 'icon only rebuilt when state/badge changed');
  assert.doesNotMatch(ps, /(?<!if \(-not \$Prewarm\) \{ )& \$openAccount; return/, 'every fallback to the browser is guarded by -not $Prewarm');
  assert.doesNotMatch(ps, /\$script:forceClose/, 'the flag is shared through $W (each closure has its own $script:)');
  assert.match(ps, /\$W\.forceClose = \$true/, 'a failed init really closes the window (real run: powershell.test.mjs)');
  assert.match(ps, /finally \{ Remove-Tray \}/);
  assert.match(ps, /'exit' \{ Remove-Tray/);
});

test('startTray (A4): EPIPE on helper stdin does not crash; close() ends stdin and cancels the restart timer', async () => {
  if (process.platform !== 'win32') return;
  const { startTray } = await import('../src/tray.mjs');
  const { EventEmitter } = await import('node:events');
  const kids = [];
  const spawn = () => {
    const c = new EventEmitter(); c.stdin = new EventEmitter(); c.stdin.write = (l) => { (c.lines ||= []).push(l); c.stdin.emit('error', new Error('EPIPE')); }; c.stdin.end = () => { c.ended = true; };
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}; c.stdout.resume = () => {}; c.stdout.pause = () => {}; c.kill = () => { c.killed = true; };
    kids.push(c); return c;
  };
  const tray = startTray({ spawn, log: () => {} });
  assert.equal(kids.length, 1);
  assert.ok(kids[0].stdin.listenerCount('error') >= 1, 'stdin has an error listener');
  kids[0].emit('exit', 1);
  tray.close();
  assert.ok(kids[0].ended, 'stdin ended: the helper removes its own icon');
  assert.ok(kids[0].lines.includes('{"t":"exit"}\n'), "'exit' sent first: the helper's own exit path");
});

test('V-3: questions follow the PC language — headers, fixed texts, buttons and the "auto-deny in 2 min" line in Russian; commands stay', async () => {
  const w = lines();
  const link = createLink(w.write, { setTimer: () => 0 });
  link.onLine('{"t":"ready"}');
  void link.ask({ head: 'ChatGPT wants to change Bridgerator settings', text: 'Read-only: −C:\\RO', buttons: [['allow', 'Apply', ''], ['deny', 'Cancel', 'deny']], secs: 120, host: 'PC', auto: 'auto-cancel', lang: 'ru' });
  let m = w.out.at(-1);
  assert.equal(m.head, 'ChatGPT хочет изменить настройки Bridgerator');
  assert.equal(m.detail, 'Только чтение: −C:\\RO', 'the label is Russian (V2-5), the path is not touched');
  assert.deepEqual(m.buttons, [['allow', 'Применить', ''], ['deny', 'Отмена', 'deny']]);
  assert.equal(m.attr, 'PC · авто-отмена через 2 мин'); assert.equal(m.lang, 'ru');
  void link.ask({ head: 'ChatGPT wants to delete files', text: 'Remove-Item C:\\x', buttons: [['allow', 'Allow', ''], ['allow10', 'Allow 10 min', ''], ['always', 'Allow always', ''], ['deny', 'Deny', 'deny']], secs: 45, host: 'PC', lang: 'ru' });
  m = w.out.at(-1);
  assert.equal(m.head, 'ChatGPT хочет удалить файлы'); assert.equal(m.detail, 'Remove-Item C:\\x');
  assert.deepEqual(m.buttons.map((b) => b[1]), ['Разрешить', 'Разрешить на 10 мин', 'Разрешать всегда', 'Запретить']);
  assert.equal(m.attr, 'PC · авто-запрет через 45 с');
  void link.ask({ head: 'ChatGPT wants to delete files', text: 'x', buttons: [['deny', 'Deny', 'deny']], secs: 120, host: 'PC' });
  assert.equal(w.out.at(-1).head, 'ChatGPT wants to delete files', 'English PC: unchanged');
  assert.equal(w.out.at(-1).attr, 'PC · auto-deny in 2 min');
});

test('V-3: every fixed question text of the bridge has a Russian version (no English header left on a Russian PC)', async () => {
  const { ruText, localizeAsk } = await import('../src/pc-text.mjs');
  const src = ['confirm.mjs', 'bridge.mjs', 'automations.mjs', 'batch.mjs'].map((f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
  const fixed = new Set();
  for (const [, x] of src.matchAll(/head: '([^']+)'/g)) fixed.add(x);
  for (const [, x] of src.matchAll(/\['[a-z0-9]+', '([^']+)', '(?:deny)?'\]/g)) fixed.add(x);
  const { HEAD_TEXTS } = { HEAD_TEXTS: [...src.matchAll(/^\s+[a-z_]+: '(ChatGPT wants[^']+)'/gm)].map((x) => x[1]) };
  for (const h of HEAD_TEXTS) fixed.add(h);
  assert.ok(fixed.size > 20, `found ${fixed.size} texts`);
  for (const x of fixed) assert.notEqual(ruText(x), x, `no Russian for "${x}"`);
  // Built texts.
  for (const x of ['ChatGPT wants to clear 3 tasks', 'ChatGPT deleted or moved 25 files in a minute', 'ChatGPT wants to delete 2 items for good', 'Turn off confirmations for deletions, your own patterns?',
    'ChatGPT wants to move 214 files', 'ChatGPT wants to do 220 actions (214 moves, 6 commands)', 'ChatGPT wants to create 1 folder']) assert.doesNotMatch(ruText(x), /wants|deleted|Turn off|moves|commands|folder\b/, x);
  assert.equal(ruText('Turn off confirmations for deletions, your own patterns?'), 'Выключить: подтверждения удаления, ваши шаблоны?');
  assert.equal(localizeAsk({ head: 'x', text: 'y', buttons: [] }, 'en').head, 'x');
});

test('VR-6/VR-14: Russian plan-card headlines use the plural form for the number (1 файл, 2 файла, 5 файлов)', async () => {
  const { ruText, ruPlural } = await import('../src/pc-text.mjs');
  const { headline } = await import('../src/batch.mjs');
  const F = ['файл', 'файла', 'файлов'];
  for (const [n, w] of [[0, 'файлов'], [1, 'файл'], [2, 'файла'], [4, 'файла'], [5, 'файлов'], [11, 'файлов'], [12, 'файлов'], [14, 'файлов'], [21, 'файл'], [22, 'файла'], [101, 'файл'], [111, 'файлов'], [214, 'файлов'], [1002, 'файла']]) assert.equal(ruPlural(n, F), w, String(n));
  assert.equal(ruText('ChatGPT wants to move 1 file'), 'ChatGPT хочет переместить 1 файл');
  assert.equal(ruText('ChatGPT wants to move 2 files'), 'ChatGPT хочет переместить 2 файла');
  assert.equal(ruText('ChatGPT wants to move 214 files'), 'ChatGPT хочет переместить 214 файлов');
  assert.equal(ruText('ChatGPT wants to run 1 command'), 'ChatGPT хочет выполнить 1 команду');
  assert.equal(ruText('ChatGPT wants to run 5 commands'), 'ChatGPT хочет выполнить 5 команд');
  assert.equal(ruText('ChatGPT wants to create 3 folders'), 'ChatGPT хочет создать 3 папки');
  assert.equal(ruText('ChatGPT wants to do 220 actions (214 moves, 6 commands)'), 'ChatGPT хочет выполнить 220 действий (214 перемещений, 6 команд)');
  assert.equal(ruText('ChatGPT wants to do 2 actions (1 move, 1 command)'), 'ChatGPT хочет выполнить 2 действия (1 перемещение, 1 команда)');
  assert.equal(ruText('ChatGPT wants to do 23 actions (21 writes, 1 edit, 1 new folder)'), 'ChatGPT хочет выполнить 23 действия (21 запись, 1 правка, 1 новая папка)');
  // Every headline batch.mjs can build comes out fully Russian.
  const tools = ['move_file', 'write_file', 'edit_block', 'create_directory', 'start_process'];
  for (const k of tools) for (const n of [1, 2, 5, 21]) assert.doesNotMatch(ruText(headline(Array.from({ length: n }, () => ({ tool: k })))).replace(/^ChatGPT /, ''), /[a-z]{3,}/, `${k} ${n}`);
  const mixed = ruText(headline([...Array(3)].map(() => ({ tool: 'move_file' })).concat([{ tool: 'start_process' }, { tool: 'create_directory' }, { tool: 'create_directory' }])));
  assert.equal(mixed, 'ChatGPT хочет выполнить 6 действий (3 перемещения, 1 команда, 2 новые папки)');
});

test('V-3 / V-4 / V-5 / V-6 (tray.ps1): menu labels in both languages; the fallback reason is logged once; the account page of the linked site; prewarm log', async () => {
  const ps = fs.readFileSync(new URL('../src/tray.ps1', import.meta.url), 'utf8');
  const lib = fs.readFileSync(new URL('../src/ask-lib.ps1', import.meta.url), 'utf8');
  const keys = (lang) => [...(ps.match(new RegExp(`^  ${lang} = @\\{(.+)\\}$`, 'm')) || ['', ''])[1].matchAll(/(\w+) = '/g)].map((x) => x[1]).sort();
  assert.ok(keys('en').length >= 18); assert.deepEqual(keys('ru'), keys('en'), 'same menu keys in Russian');
  assert.match(ps, /'state', 'name', 'todo', 'confirm', 'theme', 'lang'/, 'the language comes with every state');
  for (const mi of ['miOpen', 'miConfOn', 'miConfOff', 'miPause', 'p15', 'p60', 'pInf', 'miResume', 'miAcc', 'miHelp', 'miQuit']) assert.match(ps, new RegExp(`\\$${mi}\\.Text = L '`), `${mi} relabelled`);
  assert.match(lib, /\$q\.lang -eq 'ru'/, 'fallback window and "stop asking" suffix follow the language');
  // V-4: popupStyle = toast but the own window → the reason in bridge.log, once per reason.
  assert.match(ps, /function Write-FallbackWhy/);
  assert.match(ps, /catch \{ if \("\$_" -ne 'compact pop-up chosen'\) \{ Write-FallbackWhy "\$_" \}; Show-AskWindow/);
  assert.match(ps, /Write-FallbackWhy "Windows could not show the notification \(\$\(\$p\.w\.FailCode\)\)"/);
  assert.match(lib, /public string FailCode;/);
  // V-5: BR_ACCOUNT (a staging install opens staging), checked; the linked host may be opened.
  assert.match(ps, /\$account = if \(\$env:BR_ACCOUNT -match '\^https:/);
  assert.match(ps, /\$x\.Host -eq 'bridgerator\.recondeck\.com' -or \$x\.Host -eq \$siteHost/);
  // V-6: the prewarm log never says the account page opens.
  assert.match(ps, /if \(\$Prewarm\) \{ ' - prewarm skipped, tried again when the window is opened' \} else \{ ', opening the account page' \}/);
  // V-8: the window's WebView2 is disposed on every exit.
  assert.match(ps, /function Remove-Tray \{[\s\S]*?\$script:wv\.Dispose\(\)/);
});

test('V-5: startTray passes the linked site\'s account page to the helper (only a plain https …/app address)', async () => {
  if (process.platform !== 'win32') return;
  const { startTray } = await import('../src/tray.mjs');
  const { EventEmitter } = await import('node:events');
  const envs = [];
  const spawn = (cmd, args, o) => {
    envs.push(o.env);
    const c = new EventEmitter(); c.stdin = new EventEmitter(); c.stdin.write = () => {}; c.stdin.end = () => {};
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}; c.stdout.resume = () => {}; c.stdout.pause = () => {}; c.kill = () => {};
    return c;
  };
  startTray({ spawn, log: () => {}, account: 'https://staging.bridgerator.recondeck.com/app' }).close();
  startTray({ spawn, log: () => {}, account: "https://evil.example/app'; calc; '" }).close();
  assert.equal(envs[0].BR_ACCOUNT, 'https://staging.bridgerator.recondeck.com/app');
  assert.equal(envs[1].BR_ACCOUNT, undefined);
});

test('V2-5: settings change lines (describe) are Russian on a ru PC — labels and on/off; paths stay', async () => {
  const { ruText, localizeAsk } = await import('../src/pc-text.mjs');
  const { describe } = await import('../src/settings-tool.mjs');
  const cur = { allowedDirectories: [], readOnlyDirectories: [] };
  const keys = [['confirm.enabled', false], ['confirm.delete', true], ['confirm.install', true], ['confirm.timeout', 60], ['allowedDirectories', []], ['readOnlyDirectories', ['C:\\Data']],
    ['terminal', true], ['protectSensitive', false], ['askSettings', false], ['snapshots.enabled', false], ['fuse.limit', 50], ['autostart', true]];
  const lines = keys.map(([key, value]) => describe(cur, { key, value }));
  const settingsQ = (text) => localizeAsk({ head: 'ChatGPT wants to change Bridgerator settings', text, buttons: [] }, 'ru').text;
  for (const l of lines) assert.doesNotMatch(settingsQ(l), /\b(on|off|Confirm\w*|Folders|Terminal|Read-only|all|after)\b/, l);
  assert.equal(settingsQ(lines.slice(0, 2).join(' · ')), 'Подтверждения: выкл · Подтверждать удаление: вкл');
  // Elsewhere (a command the AI wrote) nothing is rewritten; prototype names are no labels.
  assert.equal(localizeAsk({ head: 'ChatGPT wants to run a command', text: 'Language: on', buttons: [] }, 'ru').text, 'Language: on');
  assert.equal(settingsQ('Confirm constructor: on'), 'Confirm constructor: on');
  // bridgerator_setup's question (setup-tool diffSetup lines).
  assert.equal(localizeAsk({ head: 'ChatGPT suggests Bridgerator settings', text: 'Terminal: off · Confirmations: on', buttons: [] }, 'ru').text, 'Терминал: выкл · Подтверждения: вкл');
  assert.equal(localizeAsk({ head: 'ChatGPT suggests Bridgerator settings', text: 'Folders: only D:\\a', buttons: [] }, 'ru').text, 'Папки: только D:\\a');
  assert.equal(settingsQ('Computer name: only desk'), 'Имя компьютера: only desk', 'a free value is never rewritten');
  assert.equal(localizeAsk({ head: 'ChatGPT suggests Bridgerator settings', text: 'Too many changes for a notification — review them in the Bridgerator window.', buttons: [] }, 'ru').text, 'Слишком много изменений для уведомления — посмотрите их в окне Bridgerator.');
  assert.equal(localizeAsk({ head: 'Bridgerator settings file changed', text: `Apply: ${lines[5]}?`, buttons: [] }, 'ru').text, 'Применить: Только чтение: +C:\\Data?');
  assert.equal(settingsQ('Something new: on'), 'Something new: on', 'an unknown line stays English');
});
