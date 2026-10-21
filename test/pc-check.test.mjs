// pc_health: facts from PowerShell (ru-RU fixture) → findings in plain words; parts that could not be
// read are "not checked", never "fine"; the script itself parses under Windows PowerShell 5.1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyze, handle } from '../src/pc-check.mjs';
import { IS_WIN, NOT_WIN, psAst, runPs as realPs } from './helpers/ps.mjs';

const facts = JSON.parse(fs.readFileSync(new URL('./fixtures/pc-check/summary-ru.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-10-20T12:00:00Z');
const of = (area, level) => analyze(facts, NOW).filter((f) => f.area === area && (!level || f.level === level)).map((f) => f.text);

test('disks: an almost full drive and a drive whose health is "warning" are problems', () => {
  assert.match(of('disks', 'problem').join('\n'), /C: 1\.2 GB free of 238 GB .*almost full/);
  assert.match(of('disks', 'problem').join('\n'), /WDC WD10EZEX.*health warning.*back up/);
  assert.match(of('disks', 'info').join('\n'), /Samsung SSD 870 EVO 250GB" \(SSD\): health healthy/);
});

test('events: totals, critical count and unexpected shutdowns (Kernel-Power 41) by id, not by message text', () => {
  const e = of('events').join('\n');
  assert.match(e, /57 errors, 2 critical in the last 3 days/);
  assert.match(e, /turned off unexpectedly 2 time/);
});

test('drivers: a missing driver is a problem; a device turned off on purpose is only mentioned', () => {
  assert.deepEqual(of('drivers', 'problem'), ['Неизвестное устройство: no driver installed']);
  assert.match(of('drivers', 'info').join(), /1 device\(s\) turned off.*Bluetooth-адаптер/);
});

test('updates, startup, memory, uptime', () => {
  assert.match(of('updates', 'warning').join('\n'), /2026-06-01 \(KB5031455\) — 142 days ago/);
  assert.match(of('updates', 'warning').join('\n'), /restart is needed/);
  assert.deepEqual(of('startup'), ['1 programs start with Windows (1 more turned off)']);
  assert.match(of('load', 'warning').join('\n'), /Memory 94 % used/);
  assert.match(of('load', 'warning').join('\n'), /Running 20 day\(s\)/);
});

test('findings are sorted: problems first, info last', () => {
  const lv = analyze(facts, NOW).map((f) => f.level);
  const rank = { problem: 0, warning: 1, not_checked: 2, info: 3 };
  assert.deepEqual(lv, [...lv].sort((a, b) => rank[a] - rank[b]));
});

test('a part that failed to read is "not checked" with the reason, not an empty "fine"', () => {
  const f = analyze({ drivers: { error: 'Отказано в доступе' }, disks: { volumes: [], physical: { error: 'Access denied' } }, updates: { recent: [], rebootPending: false, pending: { error: '0x80072EE2' } } }, NOW);
  assert.deepEqual(f.filter((x) => x.level === 'not_checked').map((x) => x.area).sort(), ['disks', 'drivers', 'updates', 'updates']);
  assert.ok(!f.some((x) => x.text === 'All devices work'));
});

test('the tool asks PowerShell only for the requested part; summary asks for all; days are checked', async () => {
  const seen = [];
  const ctx = { runPs: async (o) => { seen.push(o.env); return { code: 0, stdout: `${JSON.stringify(facts)}\r\n`, stderr: '' }; } };
  const r = JSON.parse((await handle('pc_health', { action: 'events', days: 7 }, ctx)).content[0].text);
  assert.equal(seen[0].BRX_PARTS, 'events');
  assert.equal(seen[0].BRX_DAYS, '7');
  assert.ok(Array.isArray(r.findings));
  await handle('pc_health', { action: 'summary' }, ctx);
  assert.equal(seen[1].BRX_PARTS, 'disks,events,startup,drivers,updates,load');
  assert.equal(seen[1].BRX_PENDING, '', 'the slow Windows Update search only on request');
  await handle('pc_health', { action: 'updates', pending: true }, ctx);
  assert.equal(seen[2].BRX_PENDING, '1');
  await assert.rejects(handle('pc_health', { action: 'events', days: 99 }, ctx), (e) => e.code === 'BAD_ARGS');
  await assert.rejects(handle('pc_health', { action: 'format' }, ctx), (e) => e.code === 'BAD_ACTION');
});

test('PowerShell that prints no JSON → a plain PS_FAILED error with the first error line (CLIXML decoded)', async () => {
  const stderr = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Get-CimInstance : Отказано в доступе_x000D__x000A_</S></Objs>';
  await assert.rejects(handle('pc_health', { action: 'drivers' }, { runPs: async () => ({ code: 1, stdout: '', stderr }) }), (e) => e.code === 'PS_FAILED' && /Отказано в доступе/.test(e.message) && !/CLIXML/.test(e.message));
});

test('pc-check.ps1 parses without errors under Windows PowerShell 5.1 and is ASCII', { skip: NOT_WIN }, async () => {
  const file = fileURLToPath(new URL('../src/pc-check.ps1', import.meta.url));
  assert.ok(!/[^\x00-\x7f]/.test(fs.readFileSync(file, 'utf8')), 'non-ASCII text would need a BOM');
  const [r] = await psAst([file]);
  assert.deepEqual(r.errors, []);
});

test('real run on this PC (read-only): the load part returns numbers', { skip: IS_WIN ? false : NOT_WIN }, async () => {
  const r = JSON.parse((await handle('pc_health', { action: 'load' }, {})).content[0].text);
  assert.ok(r.details.load.memTotalMb > 0);
  assert.ok(r.findings.some((f) => f.area === 'load'));
});

test('a list part unrolled by PowerShell ({} / null for none, the item itself for one) still works (VM 21.10: INTERNAL)', () => {
  for (const drivers of [{}, null]) assert.deepEqual(analyze({ drivers }, NOW).map((f) => f.text), ['All devices work']);
  const one = analyze({ drivers: { name: 'USB', code: 28 }, startup: { name: 'x', enabled: true } }, NOW).map((f) => f.text).join('\n');
  assert.match(one, /USB/); assert.match(one, /1 programs start/);
});

test('Kernel-Power 41 is found even when it is not among the most frequent groups (counted over all events)', () => {
  const ev = { days: 3, total: 400, critical: 3, kernelPower: 3, groups: [{ log: 'Application', source: 'Application Error', id: 1000, level: 2, count: 300 }] };
  assert.match(analyze({ events: ev }, NOW).map((f) => f.text).join('\n'), /turned off unexpectedly 3 time/);
  assert.doesNotMatch(analyze({ events: { ...ev, kernelPower: 0 } }, NOW).map((f) => f.text).join('\n'), /unexpectedly/);
});

test('InstalledOn in the PC\'s own date format (ru-RU 15.10.2026, US 10/15/2026, hex FILETIME) is read right', { skip: NOT_WIN }, async () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/pc-check.ps1', import.meta.url)), 'utf8');
  const fn = /function To-Date[\s\S]*?\n\}\r?\n/.exec(src)[0];
  const r = await realPs(`${fn}
[Threading.Thread]::CurrentThread.CurrentCulture = [Globalization.CultureInfo]::GetCultureInfo('ru-RU')
$f = { param($v) $d = To-Date $v; if ($d) { $d.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) } else { $null } }
ConvertTo-Json -Compress @{ ru = (& $f '15.10.2026'); us = (& $f '10/05/2026'); hex = (& $f '01dc3e1a2b3c4d00'); bad = (& $f 'вчера'); none = (& $f '') }`);
  assert.equal(r.ru, '2026-10-15');
  assert.equal(r.us, '2026-10-05', 'slashes = M/d/yyyy, not 10 May');
  assert.match(r.hex, /^20\d\d-\d\d-\d\d$/);
  assert.equal(r.bad, null);
  assert.equal(r.none, null);
});
