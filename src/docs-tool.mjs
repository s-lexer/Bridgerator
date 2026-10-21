// LOGIC: see critical-logic/bridge.md ("Extra tools" → create_document). New Word / Excel / PDF files
// from markdown and tables, without Office or a browser: libraries the bundled engine already ships
// (markdown-it, jszip, exceljs, pdf-lib; see lib()) + system fonts (pdf-font.mjs). A file is never overwritten:
// an existing name gets " (2)". Paths go through the same folder rules as file writes (guard).
import fs from 'node:fs';
import path from 'node:path';
import { guard, fail, json, needAction, str, freeName } from './tool-lib.mjs';
import { loadSystemFonts, subsetTtf, MINI_FONTKIT, FontError } from './pdf-font.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// The engine's libraries (not our own dependencies): found at the top of node_modules when npm hoists
// them, else inside the engine's own node_modules (a version clash keeps them there).
export async function lib(name) {
  try { return await import(name); } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    const req = createRequire(createRequire(import.meta.url).resolve('@wonderwhy-er/desktop-commander/dist/index.js'));
    return import(pathToFileURL(req.resolve(name)).href);
  }
}

const ACTIONS = ['docx', 'xlsx', 'pdf'];
const MAX_MD = 2_000_000, MAX_CELLS = 100_000, MAX_SHEETS = 50, MAX_CELL_TEXT = 32767, MAX_PAGES = 2000;
const CELL = { type: ['string', 'number', 'boolean', 'null'] };

export const defs = [{
  name: 'create_document',
  title: 'Create document',
  description: 'Creates a new Word (.docx), Excel (.xlsx) or PDF file on this PC from markdown text and/or tables, without Office. An existing file is never overwritten: the new one gets a free name like "Report (2).docx".',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action', 'path'],
    properties: {
      action: { type: 'string', enum: ACTIONS, description: 'File type to create' },
      path: { type: 'string', description: 'Full path of the new file, e.g. C:\\Users\\Name\\Documents\\Report.docx' },
      title: { type: 'string', maxLength: 300, description: 'Document title (shown at the top and in the file properties)' },
      markdown: { type: 'string', description: 'Content: # headings, paragraphs, **bold**, *italic*, `code`, - and 1. lists, | tables |, ``` code blocks. In xlsx each table becomes a sheet.' },
      sheets: {
        type: 'array', maxItems: MAX_SHEETS,
        description: 'Tables. Numbers stay numbers, dates like 2026-10-20 become dates, text starting with "=" is a formula (xlsx). In docx/pdf they follow the text.',
        items: {
          type: 'object', additionalProperties: false, required: ['rows'],
          properties: {
            name: { type: 'string', maxLength: 31 },
            header: { type: 'boolean', description: 'First row is a header (default true)' },
            rows: { type: 'array', items: { type: 'array', items: CELL } },
          },
        },
      },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}];

// ---- input → a small document model -----------------------------------------------------------
// blocks: heading {level, runs} · para {runs, quote} · item {level, ordered, n, group, runs, cont} ·
// table {rows: [[runs]], header, name?} · code {text} · hr. runs: [{ text, b, i, code }]
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g;
const cleanText = (s) => String(s).replace(CTRL, '').replace(/\t/g, '    ');
const plain = (runs) => runs.map((r) => r.text).join('');

function inlineRuns(tok) {
  const runs = [];
  let b = 0, i = 0, href = null, linkStart = 0;
  for (const c of tok?.children || []) {
    const push = (text, extra = {}) => { if (text) runs.push({ text: cleanText(text), b: b > 0, i: i > 0, ...extra }); };
    switch (c.type) {
      case 'text': push(c.content); break;
      case 'code_inline': push(c.content, { code: true }); break;
      case 'strong_open': b++; break;
      case 'strong_close': b--; break;
      case 'em_open': i++; break;
      case 'em_close': i--; break;
      case 'softbreak': push(' '); break;
      case 'hardbreak': runs.push({ text: '\n' }); break;
      case 'link_open': href = c.attrGet('href'); linkStart = runs.length; break;
      case 'link_close': {
        const shown = plain(runs.slice(linkStart));
        if (href && shown !== href && !/^mailto:/i.test(href)) push(` (${href})`);
        href = null; break;
      }
      case 'image': push(c.content || c.attrGet('alt') || ''); break;
      default: if (c.content) push(c.content);
    }
  }
  return runs;
}

export async function parseMarkdown(src) {
  const MarkdownIt = (await lib('markdown-it')).default;
  const md = new MarkdownIt('default', { html: false, linkify: false, typographer: false });
  const toks = md.parse(String(src || ''), {});
  const blocks = [];
  const lists = [];
  let group = 0, quote = 0, table = null, row = null, item = null, heading = 0;
  for (const t of toks) {
    switch (t.type) {
      case 'heading_open': heading = Number(t.tag.slice(1)); break;
      case 'heading_close': heading = 0; break;
      case 'blockquote_open': quote++; break;
      case 'blockquote_close': quote--; break;
      case 'bullet_list_open': lists.push({ ordered: false, n: 0 }); break;
      case 'ordered_list_open': lists.push({ ordered: true, n: Number(t.attrGet('start') || 1) - 1, group: ++group }); break;
      case 'bullet_list_close': case 'ordered_list_close': lists.pop(); break;
      case 'list_item_open': { const l = lists[lists.length - 1]; l.n++; item = { first: true }; break; }
      case 'list_item_close': item = null; break;
      case 'table_open': table = { rows: [], header: false }; break;
      case 'table_close': blocks.push({ type: 'table', ...table }); table = null; break;
      case 'thead_open': table.header = true; break;
      case 'tr_open': row = []; break;
      case 'tr_close': table.rows.push(row); row = null; break;
      case 'fence': case 'code_block': blocks.push({ type: 'code', text: cleanText(t.content.replace(/\n$/, '')) }); break;
      case 'hr': blocks.push({ type: 'hr' }); break;
      case 'inline': {
        const runs = inlineRuns(t);
        if (row) { row.push(runs); break; }
        if (heading) { blocks.push({ type: 'heading', level: heading, runs }); break; }
        if (item && lists.length) {
          const l = lists[lists.length - 1];
          blocks.push({ type: 'item', level: lists.length - 1, ordered: l.ordered, n: l.n, group: l.group || 0, runs, cont: !item.first, quote });
          item.first = false;
          break;
        }
        blocks.push({ type: 'para', runs, quote });
        break;
      }
      default: break;
    }
  }
  return blocks;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
/** "2026-10-20" / "2026-10-20T14:30" → a Date with that wall-clock time in UTC (Excel has no zones), else null. */
export function isoDate(s) {
  const m = ISO.exec(s);
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0, se = 0] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || h > 23 || mi > 59 || se > 59) return null;
  return { date: dt, time: m[4] !== undefined };
}

function checkSheets(sheets) {
  if (sheets === undefined) return [];
  if (!Array.isArray(sheets)) fail('BAD_ARGS', 'sheets must be a list of tables.');
  if (sheets.length > MAX_SHEETS) fail('TOO_BIG', `At most ${MAX_SHEETS} sheets at once.`);
  let cells = 0;
  return sheets.map((s, i) => {
    if (!s || typeof s !== 'object' || !Array.isArray(s.rows)) fail('BAD_ARGS', `sheets[${i}].rows must be a list of rows.`);
    if (s.name !== undefined && typeof s.name !== 'string') fail('BAD_ARGS', `sheets[${i}].name must be text.`);
    for (const r of s.rows) {
      if (!Array.isArray(r)) fail('BAD_ARGS', `sheets[${i}]: every row must be a list of cells.`);
      cells += r.length;
      if (cells > MAX_CELLS) fail('TOO_BIG', `Too many cells (more than ${MAX_CELLS.toLocaleString('en')}).`, 'Split the data into several files.');
      for (const c of r) {
        if (c !== null && !['string', 'number', 'boolean'].includes(typeof c)) fail('BAD_ARGS', `sheets[${i}]: a cell must be text, a number, true/false or null.`);
        if (typeof c === 'number' && !Number.isFinite(c)) fail('BAD_ARGS', `sheets[${i}]: numbers must be finite.`);
        if (typeof c === 'string' && c.length > MAX_CELL_TEXT) fail('TOO_BIG', `A cell is longer than ${MAX_CELL_TEXT} characters (the Excel limit).`);
      }
    }
    return { name: s.name, header: s.header !== false, rows: s.rows };
  });
}
const cellText = (c) => (c === null || c === undefined ? '' : String(c));
const sheetBlocks = (sheets) => sheets.flatMap((s) => [
  ...(s.name ? [{ type: 'heading', level: 3, runs: [{ text: cleanText(s.name) }] }] : []),
  { type: 'table', header: s.header, rows: s.rows.map((r) => r.map((c) => [{ text: cleanText(cellText(c)) }])) },
]);

// ---- DOCX --------------------------------------------------------------------------------------
const x = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function wRuns(runs) {
  return runs.map((r) => {
    if (r.text === '\n') return '<w:r><w:br/></w:r>';
    // Element order inside rPr is fixed by the OOXML schema (Word refuses files that break it).
    const pr = `${r.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : ''}${r.b ? '<w:b/>' : ''}${r.i ? '<w:i/>' : ''}${r.code ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}`;
    return `<w:r>${pr ? `<w:rPr>${pr}</w:rPr>` : ''}<w:t xml:space="preserve">${x(r.text)}</w:t></w:r>`;
  }).join('');
}
const wP = (runs, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${wRuns(runs)}</w:p>`;
const TEXT_W = 9638; // A4 minus 2 cm margins, twips

function docxBody(title, blocks) {
  const out = [];
  const nums = new Map(); // ordered group → { numId, level }
  if (title) out.push(wP([{ text: title }], '<w:pStyle w:val="Title"/>'));
  for (const bl of blocks) {
    if (bl.type === 'heading') out.push(wP(bl.runs, `<w:pStyle w:val="Heading${Math.min(bl.level, 3)}"/>`));
    else if (bl.type === 'para') out.push(wP(bl.runs, bl.quote ? '<w:pStyle w:val="Quote"/>' : ''));
    else if (bl.type === 'item') {
      const ind = 720 * (bl.level + 1);
      if (bl.cont) { out.push(wP(bl.runs, `<w:ind w:left="${ind}"/>`)); continue; }
      let numId = 1;
      if (bl.ordered) { if (!nums.has(bl.group)) nums.set(bl.group, { numId: nums.size + 2, level: bl.level, start: bl.n }); numId = nums.get(bl.group).numId; }
      out.push(wP(bl.runs, `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${Math.min(bl.level, 8)}"/><w:numId w:val="${numId}"/></w:numPr>`));
    } else if (bl.type === 'code') for (const line of bl.text.split('\n')) out.push(wP([{ text: line }], '<w:pStyle w:val="Code"/>'));
    else if (bl.type === 'hr') out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>');
    else if (bl.type === 'table') {
      const cols = Math.max(1, ...bl.rows.map((r) => r.length));
      const w = Math.floor(TEXT_W / cols);
      const rows = bl.rows.map((r, ri) => {
        const head = bl.header && ri === 0;
        const cells = Array.from({ length: cols }, (_, ci) => {
          const runs = (r[ci] || []).map((run) => (head ? { ...run, b: true } : run));
          return `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}</w:tcPr>${wP(runs, '<w:spacing w:after="0"/>')}</w:tc>`;
        }).join('');
        return `<w:tr>${head ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
      }).join('');
      out.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${w}"/>`.repeat(cols)}</w:tblGrid>${rows}</w:tbl>`, '<w:p/>');
    }
  }
  return { body: out.join(''), nums: [...nums.values()] };
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:sz w:val="48"/><w:szCs w:val="48"/></w:rPr></w:style>
${[1, 2, 3].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${[0, 360, 280, 200][n]}" w:after="80"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="${[0, 36, 30, 26][n]}"/><w:szCs w:val="${[0, 36, 30, 26][n]}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/><w:contextualSpacing/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="567"/></w:pPr><w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:tblPr><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>`).join('')}</w:tblBorders></w:tblPr></w:style>
</w:styles>`;
const lvls = (fmt) => Array.from({ length: 9 }, (_, l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${fmt === 'bullet' ? ['•', '◦', '▪'][l % 3] : `%${l + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('');
const numbering = (nums) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('bullet')}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${lvls('decimal')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${nums.map((n) => `<w:num w:numId="${n.numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="${Math.min(n.level, 8)}"><w:startOverride w:val="${Math.max(1, n.start)}"/></w:lvlOverride></w:num>`).join('')}</w:numbering>`;

export async function buildDocx({ title, blocks }) {
  const JSZip = (await lib('jszip')).default;
  const { body, nums } = docxBody(title, blocks);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const zip0 = new JSZip();
  // No folder entries in the package (Office's own files have none).
  const zip = { file: (n, d) => zip0.file(n, d, { createFolders: false }), generateAsync: (o) => zip0.generateAsync(o) };
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
  zip.file('docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${title ? `<dc:title>${x(title)}</dc:title>` : ''}<dc:creator>Bridgerator</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file('word/styles.xml', STYLES);
  zip.file('word/numbering.xml', numbering(nums));
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W_NS}><w:body>${body || '<w:p/>'}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---- XLSX --------------------------------------------------------------------------------------
const NUM = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;
function sheetName(n, i, used) {
  let s = cleanText(n || `Sheet${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31) || `Sheet${i + 1}`;
  let k = 2;
  const base = s;
  while (used.has(s.toLowerCase())) s = `${base.slice(0, 27)} (${k++})`;
  used.add(s.toLowerCase());
  return s;
}
export async function buildXlsx({ title, sheets }) {
  const ExcelJS = (await lib('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Bridgerator';
  if (title) wb.title = title;
  wb.calcProperties = { fullCalcOnLoad: true };
  const used = new Set();
  sheets.forEach((s, si) => {
    const ws = wb.addWorksheet(sheetName(s.name, si, used));
    const widths = [];
    s.rows.forEach((r, ri) => {
      const row = ws.getRow(ri + 1);
      r.forEach((c, ci) => {
        const cell = row.getCell(ci + 1);
        let shown = cellText(c);
        if (typeof c === 'string') {
          const d = !(s.header && ri === 0) && isoDate(c.trim());
          if (s.textOnly) {
            if (NUM.test(c.trim()) && !(s.header && ri === 0)) cell.value = Number(c.trim());
            else if (d) { cell.value = d.date; cell.numFmt = d.time ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd'; } else cell.value = cleanText(c);
          } else if (c.startsWith('=') && c.length > 1) { cell.value = { formula: c.slice(1) }; shown = ''; }
          else if (d) { cell.value = d.date; cell.numFmt = d.time ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd'; } else cell.value = cleanText(c);
        } else if (c !== null && c !== undefined) cell.value = c;
        widths[ci] = Math.max(widths[ci] || 0, Math.min(60, shown.length));
      });
      if (s.header && ri === 0) row.font = { bold: true };
    });
    widths.forEach((w, i) => { ws.getColumn(i + 1).width = Math.max(8, w + 2); });
    if (s.header && s.rows.length > 1) ws.views = [{ state: 'frozen', ySplit: 1 }];
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---- PDF ---------------------------------------------------------------------------------------
const A4 = [595.28, 841.89], M = 56, BODY = 11;
const keyOf = (r) => (r.code ? 'm' : r.b && r.i ? 'bi' : r.b ? 'b' : r.i ? 'i' : 'r');

/** Lays the blocks out into pages of draw items with the fonts' metrics (pass 1, no PDF yet). */
export function layoutPdf({ title, blocks }, fonts) {
  const [W, H] = A4, width = W - 2 * M;
  const pages = [];
  let page, y;
  const newPage = () => { page = []; pages.push(page); y = H - M; if (pages.length > MAX_PAGES) fail('TOO_BIG', `The PDF would have more than ${MAX_PAGES} pages.`, 'Split the content into several files.'); };
  newPage();
  const f = (k) => fonts[k] || fonts.r;
  const has = (k, ch) => f(k).cmap.has(ch.codePointAt(0));
  const fix = (k, t) => Array.from(t, (ch) => (has(k, ch) || ch === ' ' || ch === ' ' ? ch : (has('r', ch) ? ch : '?'))).join('');
  // A no-break space (code-block indentation) measures as a space when the font has no glyph for it.
  const wOf = (k, t, size) => { const ft = f(k); let s = 0; for (const ch of t) { const c = ch.codePointAt(0); const g = ft.cmap.get(c) || (c === 0xa0 ? ft.cmap.get(32) : 0) || 0; s += ft.advance(g); } return (s * size) / ft.unitsPerEm; };
  const asc = (size) => (fonts.r.ascent / fonts.r.unitsPerEm) * size;
  const lh = (size) => ((fonts.r.ascent - fonts.r.descent) / fonts.r.unitsPerEm) * size * 1.08;

  /** runs → lines of segments [{ text, k, dx }] within maxW. */
  function wrap(runs, size, maxW) {
    const lines = [];
    let line = [], lw = 0;
    const flush = () => { while (line.length && !line[line.length - 1].text.trim()) { lw -= line[line.length - 1].w; line.pop(); } lines.push(line); line = []; lw = 0; };
    const add = (text, k) => {
      const w = wOf(k, text, size);
      const last = line[line.length - 1];
      if (last && last.k === k) { last.text += text; last.w += w; } else line.push({ text, k, w });
      lw += w;
    };
    for (const r of runs) {
      if (r.text === '\n') { flush(); continue; }
      const k = keyOf(r);
      // Breaks at white space except the no-break space (it keeps code indentation and runs of spaces).
      for (const piece of fix(k, r.text).split(/([^\S ]+)/)) {
        if (!piece) continue;
        if (/^[^\S ]+$/.test(piece)) { if (line.length) add(' ', k); continue; }
        const w = wOf(k, piece, size);
        if (lw + w <= maxW) { add(piece, k); continue; }
        if (line.length) flush();
        if (w <= maxW) { add(piece, k); continue; }
        let rest = piece;
        while (rest) {
          let n = 1;
          const chars = Array.from(rest);
          while (n < chars.length && wOf(k, chars.slice(0, n + 1).join(''), size) <= maxW - lw) n++;
          add(chars.slice(0, n).join(''), k);
          rest = chars.slice(n).join('');
          if (rest) flush();
        }
      }
    }
    if (line.length || !lines.length) flush();
    return lines.map((l) => { let dx = 0; return l.map((s) => { const o = { text: s.text, k: s.k, dx }; dx += s.w; return o; }); });
  }
  const need = (h) => { if (y - h < M) newPage(); };
  const text = (segs, x, top, size, color) => { for (const s of segs) if (s.text.trim()) page.push({ t: 'text', text: s.text, k: s.k, x: x + s.dx, y: top - asc(size), size, color }); };
  function paragraph(runs, { size = BODY, indent = 0, color, before = 0, after = 6, marker, bar } = {}) {
    const lines = wrap(runs, size, width - indent);
    const h = lh(size);
    y -= before;
    lines.forEach((segs, i) => {
      need(h);
      if (i === 0 && marker) text([{ text: marker, k: 'r', dx: 0 }], M + indent - wOf('r', marker, size) - 6, y, size, color);
      if (bar) page.push({ t: 'rect', x: M + indent - 10, y: y - h, w: 2, h, color: [0.75, 0.75, 0.75] });
      text(segs, M + indent, y, size, color);
      y -= h;
    });
    y -= after;
  }
  function table(bl) {
    const size = 10, pad = 4, h = lh(size);
    const cols = Math.max(1, ...bl.rows.map((r) => r.length));
    const runsAt = (r, c, ri) => (r[c] || []).map((x) => (bl.header && ri === 0 ? { ...x, b: true } : x));
    const nat = Array(cols).fill(0);
    bl.rows.forEach((r, ri) => { for (let c = 0; c < cols; c++) nat[c] = Math.max(nat[c], runsAt(r, c, ri).reduce((s, x) => s + wOf(keyOf(x), fix(keyOf(x), x.text), size), 0)); });
    for (let c = 0; c < cols; c++) nat[c] += 2 * pad + 1;
    let cw;
    const total = nat.reduce((a, b) => a + b, 0);
    if (total <= width) cw = nat.map((n) => n + (width - total) / cols);
    else {
      const fair = width / cols;
      cw = nat.map((n) => Math.min(n, fair));
      const left = width - cw.reduce((a, b) => a + b, 0);
      const want = nat.map((n, i) => n - cw[i]), sumWant = want.reduce((a, b) => a + b, 0);
      if (sumWant > 0) cw = cw.map((w, i) => w + (left * want[i]) / sumWant);
    }
    const maxLines = Math.max(1, Math.floor((A4[1] - 2 * M - 2 * pad - (bl.header ? h + 2 * pad : 0)) / h) - 1);
    const rowsLaid = bl.rows.map((r, ri) => {
      const cells = cw.map((w, c) => wrap(runsAt(r, c, ri), size, w - 2 * pad).slice(0, maxLines));
      return { cells, height: Math.max(...cells.map((l) => l.length)) * h + 2 * pad, head: bl.header && ri === 0 };
    });
    const drawRow = (row) => {
      let x = M;
      row.cells.forEach((lines, c) => {
        page.push({ t: 'rect', x, y: y - row.height, w: cw[c], h: row.height, border: true, fill: row.head ? [0.95, 0.95, 0.95] : null });
        lines.forEach((segs, i) => text(segs, x + pad, y - pad - i * h, size));
        x += cw[c];
      });
      y -= row.height;
    };
    y -= 4;
    rowsLaid.forEach((row, i) => {
      if (y - row.height < M) { newPage(); if (bl.header && i > 0) drawRow(rowsLaid[0]); }
      drawRow(row);
    });
    y -= 10;
  }
  if (title) paragraph([{ text: cleanText(title), b: true }], { size: 22, after: 12 });
  for (const bl of blocks) {
    if (bl.type === 'heading') paragraph(bl.runs.map((r) => ({ ...r, b: true })), { size: [0, 18, 15, 13, 12, 12, 12][bl.level] || 12, before: 8, after: 4 });
    else if (bl.type === 'para') paragraph(bl.runs, bl.quote ? { indent: 14 * bl.quote, color: [0.35, 0.35, 0.35], bar: true } : {});
    else if (bl.type === 'item') {
      const indent = 18 * (bl.level + 1);
      const bullet = has('r', '•') ? '•' : '-';
      paragraph(bl.runs, { indent, after: 2, marker: bl.cont ? undefined : (bl.ordered ? `${bl.n}.` : bullet) });
    } else if (bl.type === 'code') {
      const size = 9.5, h = lh(size);
      y -= 2;
      for (const raw of bl.text.split('\n')) {
        for (const segs of wrap([{ text: raw.replace(/ /g, '\u00a0') || '\u00a0', code: true }], size, width - 8)) {
          need(h);
          page.push({ t: 'rect', x: M, y: y - h, w: width, h, fill: [0.95, 0.95, 0.95] });
          text(segs.map((s) => ({ ...s, text: s.text.replace(/\u00a0/g, ' ') })), M + 4, y, size);
          y -= h;
        }
      }
      y -= 8;
    } else if (bl.type === 'hr') { need(12); page.push({ t: 'line', x1: M, x2: M + width, y: y - 6 }); y -= 12; }
    else if (bl.type === 'table') table(bl);
  }
  if (pages.length > 1) pages.forEach((p, i) => { const s = `${i + 1} / ${pages.length}`; p.push({ t: 'text', text: s, k: 'r', x: W - M - wOf('r', s, 8), y: M / 2, size: 8, color: [0.5, 0.5, 0.5] }); });
  return pages;
}

export async function buildPdf({ title, blocks }, { fonts, fontDir } = {}) {
  let fs0;
  try { fs0 = fonts || loadSystemFonts(fontDir); } catch (e) { if (e instanceof FontError) fail('NO_FONT', 'No usable system font for PDF was found on this PC.', 'Create a .docx instead, or check that C:\\Windows\\Fonts has Segoe UI or Arial.'); throw e; }
  const pages = layoutPdf({ title, blocks }, fs0);
  const { PDFDocument, rgb } = await lib('pdf-lib');
  const doc = await PDFDocument.create();
  doc.registerFontkit(MINI_FONTKIT);
  doc.setCreator('Bridgerator'); doc.setProducer('Bridgerator');
  if (title) doc.setTitle(title);
  const usedBy = {};
  for (const p of pages) for (const it of p) if (it.t === 'text') { const set = (usedBy[it.k] ||= new Set()); for (const ch of it.text) set.add(ch.codePointAt(0)); }
  const embedded = {};
  for (const [k, set] of Object.entries(usedBy)) embedded[k] = await doc.embedFont(subsetTtf(fs0[k] || fs0.r, set), { subset: false });
  const grey = rgb(0.65, 0.65, 0.65);
  for (const items of pages) {
    const page = doc.addPage(A4);
    for (const it of items) {
      if (it.t === 'rect') page.drawRectangle({ x: it.x, y: it.y, width: it.w, height: it.h, ...(it.fill ? { color: rgb(...it.fill) } : {}), ...(it.color ? { color: rgb(...it.color) } : {}), ...(it.border ? { borderColor: grey, borderWidth: 0.5 } : {}) });
      else if (it.t === 'line') page.drawLine({ start: { x: it.x1, y: it.y }, end: { x: it.x2, y: it.y }, thickness: 0.7, color: grey });
    }
    for (const it of items) if (it.t === 'text') page.drawText(it.text, { x: it.x, y: it.y, size: it.size, font: embedded[it.k], ...(it.color ? { color: rgb(...it.color) } : {}) });
  }
  return { bytes: Buffer.from(await doc.save()), pages: pages.length };
}

// ---- the tool ----------------------------------------------------------------------------------
export async function handle(name, args, ctx) {
  const action = needAction(args, ACTIONS);
  const want = str(args, 'path', { required: true, max: 1000 });
  if (path.extname(want).toLowerCase() !== `.${action}`) fail('BAD_PATH', `The file name must end with .${action} for action "${action}".`, `Use a path like ...\\Report.${action}.`);
  // One line without control characters (a control character makes the docx / xlsx XML invalid).
  const title = str(args, 'title', { max: 300 }) === undefined ? undefined : cleanText(args.title).replace(/\s+/g, ' ').trim() || undefined;
  const markdown = str(args, 'markdown', { max: MAX_MD });
  const sheets = checkSheets(args.sheets);
  if (!markdown?.trim() && !sheets.length && !title) fail('EMPTY', 'There is nothing to put in the document.', 'Pass markdown text and/or sheets.');
  const blocks = markdown ? await parseMarkdown(markdown) : [];
  let bytes, extra = {};
  if (action === 'xlsx') {
    let all = sheets;
    if (!all.length) {
      // Markdown tables → one sheet each, named by the heading above them.
      let lastHead = '';
      all = [];
      for (const b of blocks) {
        if (b.type === 'heading') lastHead = plain(b.runs);
        if (b.type === 'table') all.push({ name: lastHead || undefined, header: b.header, rows: b.rows.map((r) => r.map(plain)), textOnly: true });
      }
      if (!all.length) fail('NO_TABLE', 'An Excel file needs a table.', 'Pass sheets: [{ name, rows: [[...]] }] or a markdown table.');
    }
    bytes = await buildXlsx({ title, sheets: all });
    extra = { sheets: all.length };
  } else {
    const model = { title, blocks: [...blocks, ...sheetBlocks(sheets)] };
    if (action === 'docx') bytes = await buildDocx(model);
    else { const r = await buildPdf(model, { fonts: ctx?.fonts, fontDir: ctx?.fontDir }); bytes = r.bytes; extra = { pages: r.pages }; }
  }
  let target = freeName(guard(ctx, want, { write: true }));
  if (target !== path.resolve(want)) guard(ctx, target, { write: true });
  // Same confirmation as a file write ("Writing files" category), when it is on.
  const stop = await ctx?.gate?.gate?.('write_file', { path: target });
  if (stop) return stop;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { fs.writeFileSync(target, bytes, { flag: 'wx' }); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    target = freeName(target);              // created by someone else in between
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
  return json({ created: target, bytes: bytes.length, ...extra, ...(target !== path.resolve(want) ? { note: 'A file with the requested name already existed; it was left as is.' } : {}) });
}
