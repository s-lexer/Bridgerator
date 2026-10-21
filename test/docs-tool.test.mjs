// create_document (src/docs-tool.mjs + src/pdf-font.mjs): Word / Excel / PDF from markdown and tables,
// in folders with Cyrillic names and spaces, never overwriting, under the same folder rules as writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { PDFDocument, PDFRawStream } from 'pdf-lib';
import { handle, defs, parseMarkdown, isoDate, layoutPdf } from '../src/docs-tool.mjs';
import { loadSystemFonts, parseTtf, subsetTtf, fontkitFont, FontError } from '../src/pdf-font.mjs';
import { createPolicy } from '../src/policy.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-docs-'));
const dir = path.join(root, 'Отчёты 2026');
fs.mkdirSync(dir, { recursive: true });
// %TEMP% is under AppData: "Protect sensitive folders" off, as on a default install (21.10).
const ctxFor = (cfg = {}) => ({ cfg, policy: createPolicy({ protectSensitive: false, ...cfg }) });
const ctx = ctxFor();
const out = (r) => JSON.parse(r.content[0].text);
let fonts = null, noFont = false;
try { fonts = loadSystemFonts(); } catch (e) { noFont = `no system TrueType font (${e.message}) — PDF NOT CHECKED here`; }

const MD = `# Отчёт за октябрь

Привет, **жирный** и *курсив*, \`код\`, [сайт](https://example.com).

- один
- два
  - вложенный

3. третий
4. четвёртый

| Имя | Сумма |
|---|---|
| Иван | 100 |
| Пётр | 2026-10-20 |

\`\`\`
const x = 1;
\`\`\`

> цитата
`;

test('the tool is one definition with an action and honest hints', () => {
  assert.equal(defs.length, 1);
  const d = defs[0];
  assert.equal(d.name, 'create_document');
  assert.deepEqual(d.inputSchema.properties.action.enum, ['docx', 'xlsx', 'pdf']);
  assert.deepEqual(d.inputSchema.required, ['action', 'path']);
  assert.equal(d.annotations.readOnlyHint, false);
  assert.equal(d.annotations.destructiveHint, false);
  assert.equal(d.annotations.openWorldHint, false);
  assert.doesNotMatch(d.description, /desktop ?commander|IMPORTANT|MUST|ALWAYS/i);
});

test('markdown becomes headings, styled runs, nested and numbered list items, tables and code', async () => {
  const b = await parseMarkdown(MD);
  assert.deepEqual(b[0], { type: 'heading', level: 1, runs: [{ text: 'Отчёт за октябрь', b: false, i: false }] });
  const runs = b[1].runs;
  assert.ok(runs.some((r) => r.text === 'жирный' && r.b));
  assert.ok(runs.some((r) => r.text === 'курсив' && r.i));
  assert.ok(runs.some((r) => r.text === 'код' && r.code));
  assert.ok(runs.some((r) => r.text === ' (https://example.com)'), 'the link address is kept as text');
  const items = b.filter((x) => x.type === 'item');
  assert.deepEqual(items.map((i) => [i.level, i.ordered, i.n]), [[0, false, 1], [0, false, 2], [1, false, 1], [0, true, 3], [0, true, 4]]);
  const t = b.find((x) => x.type === 'table');
  assert.equal(t.header, true);
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[2][0][0].text, 'Пётр');
  assert.equal(b.find((x) => x.type === 'code').text, 'const x = 1;');
  assert.equal(b.find((x) => x.type === 'para' && x.quote).runs[0].text, 'цитата');
});

test('a .docx with Cyrillic text, styles, lists, a table and the title in its properties', async () => {
  const r = out(await handle('create_document', { action: 'docx', path: path.join(dir, 'Отчёт.docx'), title: 'Отчёт ООО «Ромашка»', markdown: MD }, ctx));
  assert.equal(r.created, path.join(dir, 'Отчёт.docx'));
  const zip = await JSZip.loadAsync(fs.readFileSync(r.created));
  assert.deepEqual(Object.keys(zip.files).filter((n) => n.endsWith('/')), [], 'no folder entries');
  const doc = await zip.file('word/document.xml').async('string');
  for (const s of ['Отчёт за октябрь', 'Heading1', '<w:b/>', 'Пётр', '<w:tbl>', '<w:numId w:val="2"/>', 'Code', 'Quote', '<w:t xml:space="preserve">Отчёт ООО «Ромашка»</w:t>']) assert.ok(doc.includes(s), s);
  const num = await zip.file('word/numbering.xml').async('string');
  assert.match(num, /<w:num w:numId="2"><w:abstractNumId w:val="1"\/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="3"\/>/, 'the numbered list starts at 3');
  assert.match(await zip.file('docProps/core.xml').async('string'), /<dc:title>Отчёт ООО «Ромашка»<\/dc:title>/);
  assert.ok(r.bytes > 1000);
});

test('XML special characters and control characters are escaped / dropped in a .docx', async () => {
  const r = out(await handle('create_document', { action: 'docx', path: path.join(dir, 'спец.docx'), markdown: 'a < b & c > d "q"\u0001 end' }, ctx));
  const doc = await (await JSZip.loadAsync(fs.readFileSync(r.created))).file('word/document.xml').async('string');
  assert.ok(doc.includes('a &lt; b &amp; c &gt; d &quot;q&quot; end'));
});

test('an .xlsx from sheets keeps numbers, turns ISO dates into dates, formulas into formulas, names sheets safely', async () => {
  const sheets = [
    { name: 'Продажи: 2026/10', rows: [['Товар', 'Кол-во', 'Дата'], ['Чай', 3, '2026-10-20'], ['Кофе', 2.5, '2026-10-21T14:30'], ['Итого', '=SUM(B2:B3)', null]] },
    { name: 'Продажи: 2026/10', header: false, rows: [['x', true], ['2026-02-30', '007']] },
  ];
  const r = out(await handle('create_document', { action: 'xlsx', path: path.join(dir, 'Продажи.xlsx'), title: 'Продажи', sheets }, ctx));
  assert.equal(r.sheets, 2);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(r.created);
  const [a, b] = wb.worksheets;
  assert.equal(a.name, 'Продажи  2026 10');
  assert.notEqual(b.name, a.name, 'two sheets with one name get different names');
  assert.equal(a.getCell('A2').value, 'Чай');
  assert.equal(a.getCell('B2').value, 3);
  assert.ok(a.getCell('C2').value instanceof Date);
  assert.equal(a.getCell('C2').value.toISOString(), '2026-10-20T00:00:00.000Z');
  assert.equal(a.getCell('C3').value.toISOString(), '2026-10-21T14:30:00.000Z');
  assert.equal(a.getCell('B4').value.formula, 'SUM(B2:B3)');
  assert.equal(a.getRow(1).font?.bold, true);
  assert.equal(b.getCell('B1').value, true);
  assert.equal(b.getCell('A2').value, '2026-02-30', 'an impossible date stays text');
  assert.equal(b.getCell('B2').value, '007', 'text given as text stays text');
});

test('an .xlsx from markdown tables: one sheet per table, named by the heading, numbers and dates recognised', async () => {
  const r = out(await handle('create_document', { action: 'xlsx', path: path.join(dir, 'Из markdown.xlsx'), markdown: MD }, ctx));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(r.created);
  const ws = wb.worksheets[0];
  assert.equal(ws.name, 'Отчёт за октябрь');
  assert.equal(ws.getCell('A1').value, 'Имя');
  assert.equal(ws.getCell('B2').value, 100);
  assert.ok(ws.getCell('B3').value instanceof Date);
});

test('an .xlsx needs a table', async () => {
  await assert.rejects(handle('create_document', { action: 'xlsx', path: path.join(dir, 'нет.xlsx'), markdown: 'просто текст' }, ctx), { code: 'NO_TABLE' });
  assert.equal(fs.existsSync(path.join(dir, 'нет.xlsx')), false);
});

test('ISO dates: only real calendar dates without a time zone', () => {
  assert.equal(isoDate('2026-10-20').date.toISOString(), '2026-10-20T00:00:00.000Z');
  assert.equal(isoDate('2026-10-20 08:05:09').time, true);
  for (const s of ['2026-13-01', '2026-02-29', '2026-10-20T25:00', '2026-10-20T10:00Z', '20.10.2026', '2026-10-20x']) assert.equal(isoDate(s), null, s);
});

test('an existing file is never overwritten: the new one gets " (2)"', async () => {
  const p = path.join(dir, 'Один и тот же.docx');
  fs.writeFileSync(p, 'старый файл');
  const r = out(await handle('create_document', { action: 'docx', path: p, markdown: 'новый' }, ctx));
  assert.equal(r.created, path.join(dir, 'Один и тот же (2).docx'));
  assert.match(r.note, /left as is/);
  assert.equal(fs.readFileSync(p, 'utf8'), 'старый файл');
  const r3 = out(await handle('create_document', { action: 'docx', path: p, markdown: 'ещё' }, ctx));
  assert.equal(r3.created, path.join(dir, 'Один и тот же (3).docx'));
});

test('a missing parent folder is created', async () => {
  const r = out(await handle('create_document', { action: 'docx', path: path.join(dir, 'Новая папка', 'Вложенная', 'Итог.docx'), markdown: 'x' }, ctx));
  assert.ok(fs.existsSync(r.created));
});

test('outside the allowed folders, in a read-only folder or in an excluded folder: refused, nothing written', async () => {
  const allowed = path.join(root, 'Разрешено'), other = path.join(root, 'Чужое');
  fs.mkdirSync(allowed); fs.mkdirSync(other);
  const target = path.join(other, 'a.docx');
  await assert.rejects(handle('create_document', { action: 'docx', path: target, markdown: 'x' }, ctxFor({ allowedDirectories: [allowed] })), { code: 'ACCESS_DENIED', message: /outside the folders allowed/ });
  await assert.rejects(handle('create_document', { action: 'docx', path: target, markdown: 'x' }, ctxFor({ readOnlyDirectories: [other] })), { code: 'ACCESS_DENIED', message: /read-only/ });
  await assert.rejects(handle('create_document', { action: 'docx', path: target, markdown: 'x' }, ctxFor({ deniedDirectories: [other] })), { code: 'ACCESS_DENIED', message: /excluded/ });
  assert.equal(fs.existsSync(target), false);
  const ok = out(await handle('create_document', { action: 'docx', path: path.join(allowed, 'a.docx'), markdown: 'x' }, ctxFor({ allowedDirectories: [allowed] })));
  assert.ok(fs.existsSync(ok.created));
});

test('bad input gets a plain answer with a code', async () => {
  const p = path.join(dir, 'x.docx');
  await assert.rejects(handle('create_document', { action: 'pptx', path: p, markdown: 'x' }, ctx), { code: 'BAD_ACTION' });
  await assert.rejects(handle('create_document', { action: 'pdf', path: p, markdown: 'x' }, ctx), { code: 'BAD_PATH', message: /must end with \.pdf/ });
  await assert.rejects(handle('create_document', { action: 'docx', path: 'Отчёт.docx', markdown: 'x' }, ctx), { code: 'BAD_PATH', message: /not a full path/ });
  await assert.rejects(handle('create_document', { action: 'docx', path: '\\\\server\\share\\a.docx', markdown: 'x' }, ctx), { code: 'BAD_PATH', message: /Network/ });
  await assert.rejects(handle('create_document', { action: 'docx', path: p, markdown: '   ' }, ctx), { code: 'EMPTY' });
  await assert.rejects(handle('create_document', { action: 'docx', path: p }, ctx), { code: 'EMPTY' });
  await assert.rejects(handle('create_document', { action: 'docx', path: p, markdown: 5 }, ctx), { code: 'BAD_ARGS' });
  await assert.rejects(handle('create_document', { action: 'xlsx', path: path.join(dir, 'x.xlsx'), sheets: [{ rows: [[{ a: 1 }]] }] }, ctx), { code: 'BAD_ARGS' });
  await assert.rejects(handle('create_document', { action: 'xlsx', path: path.join(dir, 'x.xlsx'), sheets: [{ rows: 'нет' }] }, ctx), { code: 'BAD_ARGS' });
  assert.equal(fs.existsSync(p), false);
});

test('size limits: too much markdown, too many cells, a too long cell', async () => {
  const p = path.join(dir, 'big.xlsx');
  await assert.rejects(handle('create_document', { action: 'docx', path: path.join(dir, 'big.docx'), markdown: 'a'.repeat(2_000_001) }, ctx), { code: 'BAD_ARGS', message: /longer than/ });
  const rows = Array.from({ length: 1001 }, () => Array(100).fill(1));
  await assert.rejects(handle('create_document', { action: 'xlsx', path: p, sheets: [{ rows }] }, ctx), { code: 'TOO_BIG', message: /100,000/ });
  await assert.rejects(handle('create_document', { action: 'xlsx', path: p, sheets: [{ rows: [['я'.repeat(32768)]] }] }, ctx), { code: 'TOO_BIG' });
  await assert.rejects(handle('create_document', { action: 'xlsx', path: p, sheets: Array(51).fill({ rows: [[1]] }) }, ctx), { code: 'TOO_BIG' });
});

test('not a TrueType font → FontError', () => {
  assert.throws(() => parseTtf(new Uint8Array(4)), FontError);
  assert.throws(() => parseTtf(new Uint8Array(Buffer.from('OTTO\0\0\0\0\0\0\0\0'))), /only TrueType/);
});

test('a font subset keeps glyph ids and maps exactly the used characters', { skip: noFont }, () => {
  const used = new Set([...'Привет, Hello 1/3'].map((c) => c.codePointAt(0)));
  const sub = subsetTtf(fonts.r, used);
  const again = parseTtf(sub);
  assert.deepEqual([...again.cmap.keys()].sort((a, b) => a - b), [...used].filter((c) => fonts.r.cmap.has(c)).sort((a, b) => a - b));
  for (const c of used) assert.equal(again.cmap.get(c), fonts.r.cmap.get(c));
  assert.equal(again.numGlyphs, fonts.r.numGlyphs);
  assert.ok(sub.length < fonts.r.tables.glyf.length / 4, `subset ${sub.length} bytes`);
  const fk = fontkitFont(sub);
  assert.equal(fk.layout('Пр').glyphs[0].id, fonts.r.cmap.get('П'.codePointAt(0)));
  assert.equal(fk.layout('😀').glyphs[0].id, 0, 'a character the font lacks → .notdef');
  assert.equal(fk.cff, false);
  assert.equal(typeof fk.head.macStyle.italic, 'boolean');
});

test('long text flows over pages with page numbers; a long word is broken', { skip: noFont }, () => {
  const blocks = [{ type: 'para', runs: [{ text: 'Слово '.repeat(3000) }] }, { type: 'para', runs: [{ text: 'Ы'.repeat(500) }] }];
  const pages = layoutPdf({ title: 'Тест', blocks }, fonts);
  assert.ok(pages.length > 3);
  assert.ok(pages.every((p, i) => p.some((it) => it.text === `${i + 1} / ${pages.length}`)));
  const xs = pages.flat().filter((it) => it.t === 'text').map((it) => it.x);
  assert.ok(Math.min(...xs) >= 56 - 0.01 && Math.max(...xs) < 595.28 - 56);
});

test('a PDF: A4 pages, embedded subset font, Cyrillic searchable through ToUnicode, title, table header repeated', { skip: noFont }, async () => {
  const rows = [['№', 'Название'], ...Array.from({ length: 80 }, (_, i) => [i + 1, `Строка номер ${i + 1}`])];
  const r = out(await handle('create_document', { action: 'pdf', path: path.join(dir, 'Отчёт.pdf'), title: 'Отчёт 2026', markdown: MD, sheets: [{ name: 'Список', rows }] }, ctx));
  assert.ok(r.pages >= 2, `pages ${r.pages}`);
  const bytes = fs.readFileSync(r.created);
  assert.ok(bytes.length < 400_000, `PDF ${bytes.length} bytes — font subset expected`);
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), r.pages);
  assert.equal(doc.getTitle(), 'Отчёт 2026');
  assert.deepEqual(doc.getPage(0).getSize(), { width: 595.28, height: 841.89 });
  const streams = [];
  let fontFiles = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) { try { streams.push(zlib.inflateSync(obj.contents).toString('latin1')); } catch { streams.push(Buffer.from(obj.contents).toString('latin1')); } }
    if (obj?.get && obj.get(doc.context.obj('FontFile2'))) fontFiles++;
  }
  assert.ok(fontFiles >= 2, 'regular + bold fonts embedded');
  const cmaps = streams.filter((s) => s.includes('beginbfchar') || s.includes('beginbfrange')).join('\n').toUpperCase();
  for (const ch of 'ОтчёПр') assert.ok(cmaps.includes(`<${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`), `ToUnicode has ${ch}`);
});

test('a PDF without a usable system font: plain error with a code, nothing written', async () => {
  const empty = fs.mkdtempSync(path.join(root, 'шрифты-'));
  const p = path.join(dir, 'Без шрифта.pdf');
  await assert.rejects(handle('create_document', { action: 'pdf', path: p, markdown: 'текст' }, { ...ctx, fontDir: empty }), { code: 'NO_FONT', hint: /\.docx/ });
  assert.equal(fs.existsSync(p), false);
});

test('a table longer than a page repeats its header row on the next page', { skip: noFont }, () => {
  const rows = [[[{ text: 'Название' }]], ...Array.from({ length: 90 }, (_, i) => [[{ text: `Строка ${i + 1}` }]])];
  const pages = layoutPdf({ blocks: [{ type: 'table', header: true, rows }] }, fonts);
  assert.ok(pages.length >= 2);
  for (const p of pages) {
    const first = p.filter((it) => it.t === 'text').sort((a, b) => b.y - a.y)[0];
    assert.equal(first.text, 'Название');
    assert.equal(first.k, 'b');
  }
});

// Text as a PDF reader extracts it: the content stream's glyph ids mapped back through each font's ToUnicode.
async function pdfText(bytes) {
  const { PDFName, PDFDict } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes);
  const inflate = (s) => { try { return zlib.inflateSync(s.contents).toString('latin1'); } catch { return Buffer.from(s.contents).toString('latin1'); } };
  let all = '';
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources().lookup(PDFName.of('Font'), PDFDict);
    const maps = {};
    for (const [k, ref] of fonts.entries()) {
      const cm = inflate(doc.context.lookup(doc.context.lookup(ref).get(PDFName.of('ToUnicode'))));
      const m = new Map();
      for (const [, g, u] of cm.matchAll(/<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]+)>/g)) m.set(g.toUpperCase(), Buffer.from(u, 'hex').swap16().toString('utf16le'));
      maps[k.asString().slice(1)] = m;
    }
    const content = page.node.Contents();
    const cs = (content.asArray ? content.asArray().map((r) => doc.context.lookup(r)) : [content]).map(inflate).join('\n');
    let font = null;
    for (const [, f, hex] of cs.matchAll(/\/([^\s/]+) [\d.]+ Tf|<([0-9A-Fa-f]*)> Tj/g)) {
      if (f) { font = maps[f]; continue; }
      all += hex.toUpperCase().match(/.{4}/g).map((g) => font.get(g) ?? '\ufffd').join('') + '\n';
    }
  }
  return all;
}

test('VM10-17 / B2-31: PDF text maps back to the same Cyrillic through ToUnicode; code keeps indentation and runs of spaces', { skip: noFont }, async () => {
  const r = out(await handle('create_document', { action: 'pdf', path: path.join(dir, 'текст.pdf'), markdown: 'Привет мир, **жирный** текст\n\n```\nif (x) {\n    отступ  два\n}\n```' }, ctx));
  const t = await pdfText(fs.readFileSync(r.created));
  assert.match(t, /Привет мир,/); assert.match(t, /жирный/);
  assert.match(t, /^ {4}отступ {2}два$/m, t);
});

// V-2: a real PDF reader (pypdf / PyMuPDF, when Python has one) gives back the same Cyrillic. The text comes
// back as ASCII-escaped JSON: a console code page (cp1251 / cp866) must not turn it into "????" again.
const PY = `import json, sys
out = {}
try:
    import pypdf
    out['pypdf'] = '\\n'.join(p.extract_text() for p in pypdf.PdfReader(sys.argv[1]).pages)
except ImportError: pass
try:
    import pymupdf
    out['pymupdf'] = '\\n'.join(p.get_text() for p in pymupdf.open(sys.argv[1]))
except ImportError: pass
print(json.dumps(out))`;
const pyReaders = (() => { const r = spawnSync('python', ['-I', '-c', 'import json; print(json.dumps(1))'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }); return r.status === 0; })();
test('V-2: pypdf / PyMuPDF extract the Cyrillic text of our PDF', { skip: noFont || (!pyReaders && 'no python here') }, async () => {
  const r = out(await handle('create_document', { action: 'pdf', path: path.join(dir, 'извлечь.pdf'), title: 'Отчёт', markdown: 'Привет мир, **жирный** текст ёЁ «кавычки» №5' }, ctx));
  const p = spawnSync('python', ['-I', '-c', PY, r.created], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(p.status, 0, p.stderr);
  const got = JSON.parse(p.stdout.trim().split(/\r?\n/).pop());
  if (!Object.keys(got).length) return; // python without a PDF reader: the ToUnicode test above still runs
  for (const [lib, text] of Object.entries(got)) {
    const flat = text.replace(/\s+/g, ' ');
    for (const w of ['Отчёт', 'Привет мир,', 'жирный', 'текст ёЁ «кавычки» №5']) assert.ok(flat.includes(w), `${lib}: "${w}" not in ${JSON.stringify(flat)}`);
    assert.ok(!flat.includes('\ufffd'), `${lib}: replacement characters`);
  }
});

test('B2-29: a title with control characters gives a valid .docx / .xlsx (characters dropped, one line)', async () => {
  const r = out(await handle('create_document', { action: 'docx', path: path.join(dir, 'заголовок.docx'), title: 'Итоги\u0001 года\nдва', markdown: 'x' }, ctx));
  const core = await (await JSZip.loadAsync(fs.readFileSync(r.created))).file('docProps/core.xml').async('string');
  assert.match(core, /<dc:title>Итоги года два<\/dc:title>/);
  const x = out(await handle('create_document', { action: 'xlsx', path: path.join(dir, 'заголовок.xlsx'), title: 'A\u0002B', sheets: [{ rows: [['a']] }] }, ctx));
  const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(x.created);
  assert.equal(wb.title, 'AB');
});

test('B2-39: create_document asks like a file write when that confirmation is on; denied → nothing written', async () => {
  const seen = [];
  const deny = { ...ctx, gate: { gate: async (tool, a) => { seen.push([tool, a.path]); return { content: [{ type: 'text', text: 'Not done — denied' }], isError: true, notConfirmed: true }; } } };
  const want = path.join(dir, 'спросить.docx');
  const r = await handle('create_document', { action: 'docx', path: want, markdown: 'x' }, deny);
  assert.equal(r.notConfirmed, true); assert.ok(!fs.existsSync(want));
  assert.deepEqual(seen, [['write_file', want]]);
  const ok = { ...ctx, gate: { gate: async () => null } };
  assert.ok(fs.existsSync(out(await handle('create_document', { action: 'docx', path: want, markdown: 'x' }, ok)).created));
});
