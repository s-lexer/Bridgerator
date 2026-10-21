// LOGIC: see critical-logic/bridge.md ("Extra tools" → create_document). A tiny TrueType reader for
// PDF output with the fonts every Windows PC has (Segoe UI / Arial / Tahoma): metrics for layout, a
// subset with only the glyphs used (glyph ids kept, other outlines dropped → a small file), and an
// object with the fields pdf-lib's custom-font embedder reads (it normally takes @pdf-lib/fontkit,
// which is not installed — this replaces it for plain left-to-right text, no shaping / kerning).
import fs from 'node:fs';
import path from 'node:path';

export class FontError extends Error { constructor(m) { super(m); this.code = 'FONT'; } }

const tag = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

/** Parses a .ttf (glyf outlines; CFF / collections are refused). */
export function parseTtf(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 12) throw new FontError('not a font file');
  const ver = b.readUInt32BE(0);
  if (ver !== 0x00010000 && tag(b, 0) !== 'true') throw new FontError('only TrueType (.ttf) fonts are supported');
  const n = b.readUInt16BE(4), tables = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    const off = b.readUInt32BE(o + 8), len = b.readUInt32BE(o + 12);
    if (off + len > b.length) throw new FontError('broken font file');
    tables[tag(b, o)] = b.subarray(off, off + len);
  }
  for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf', 'cmap']) if (!tables[t]) throw new FontError(`font has no ${t} table`);
  const head = tables.head, hhea = tables.hhea;
  const unitsPerEm = head.readUInt16BE(18);
  const bbox = { minX: head.readInt16BE(36), minY: head.readInt16BE(38), maxX: head.readInt16BE(40), maxY: head.readInt16BE(42) };
  const macStyle = head.readUInt16BE(44);
  const locFmt = head.readInt16BE(50);
  const numGlyphs = tables.maxp.readUInt16BE(4);
  const nHM = hhea.readUInt16BE(34);
  const hmtx = tables.hmtx;
  const advance = (g) => hmtx.readUInt16BE(4 * Math.min(g, nHM - 1));
  const cmap = readCmap(tables.cmap);
  const post = tables.post;
  const os2 = tables['OS/2'];
  const os2v = os2 ? os2.readUInt16BE(0) : 0;
  const loca = (g) => (locFmt ? tables.loca.readUInt32BE(4 * g) : tables.loca.readUInt16BE(2 * g) * 2);
  return {
    tables, unitsPerEm, bbox, numGlyphs, cmap, advance, loca,
    ascent: hhea.readInt16BE(4), descent: hhea.readInt16BE(6),
    italicAngle: post ? post.readInt32BE(4) / 65536 : 0,
    isFixedPitch: post ? post.readUInt32BE(12) !== 0 : false,
    familyClass: os2 && os2.length > 32 ? os2.readInt16BE(30) : 0,
    xHeight: os2 && os2v >= 2 && os2.length > 90 ? os2.readInt16BE(86) : 0,
    capHeight: os2 && os2v >= 2 && os2.length > 90 ? os2.readInt16BE(88) : 0,
    italic: (macStyle & 2) !== 0, bold: (macStyle & 1) !== 0,
    postscriptName: psName(tables.name),
  };
}

function readCmap(t) {
  const n = t.readUInt16BE(2);
  const subs = [];
  for (let i = 0; i < n; i++) {
    const o = 4 + i * 8;
    subs.push({ pid: t.readUInt16BE(o), eid: t.readUInt16BE(o + 2), off: t.readUInt32BE(o + 4) });
  }
  const pick = (pid, eid, fmt) => subs.find((s) => s.pid === pid && s.eid === eid && s.off + 2 <= t.length && t.readUInt16BE(s.off) === fmt);
  const s12 = pick(3, 10, 12) || pick(0, 4, 12) || pick(0, 6, 12);
  const map = new Map();
  if (s12) {
    const o = s12.off, groups = t.readUInt32BE(o + 12);
    for (let i = 0; i < groups && o + 16 + i * 12 + 12 <= t.length; i++) {
      const g = o + 16 + i * 12;
      const start = t.readUInt32BE(g), end = Math.min(t.readUInt32BE(g + 4), start + 0x10000), gid = t.readUInt32BE(g + 8);
      for (let c = start; c <= end; c++) if (gid + c - start) map.set(c, gid + c - start);
    }
    return map;
  }
  const s4 = pick(3, 1, 4) || pick(0, 3, 4) || pick(0, 4, 4) || pick(0, 1, 4);
  if (!s4) throw new FontError('font has no Unicode character map');
  const o = s4.off, segX2 = t.readUInt16BE(o + 6), segs = segX2 / 2;
  const ends = o + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  for (let i = 0; i < segs; i++) {
    const end = t.readUInt16BE(ends + 2 * i), start = t.readUInt16BE(starts + 2 * i);
    const delta = t.readInt16BE(deltas + 2 * i), ro = t.readUInt16BE(ranges + 2 * i);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let g;
      if (!ro) g = (c + delta) & 0xffff;
      else {
        const at = ranges + 2 * i + ro + 2 * (c - start);
        if (at + 2 > t.length) continue;
        g = t.readUInt16BE(at);
        if (g) g = (g + delta) & 0xffff;
      }
      if (g) map.set(c, g);
    }
  }
  return map;
}

function psName(t) {
  if (!t) return 'Font';
  const count = t.readUInt16BE(2), strOff = t.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    const pid = t.readUInt16BE(o), nameId = t.readUInt16BE(o + 6), len = t.readUInt16BE(o + 8), off = t.readUInt16BE(o + 10);
    if (nameId !== 6) continue;
    const raw = t.subarray(strOff + off, strOff + off + len);
    let s = '';
    if (pid === 3 || pid === 0) for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
    else s = raw.toString('latin1');
    s = s.replace(/[^A-Za-z0-9-]/g, '');
    if (s) return s.slice(0, 60);
  }
  return 'Font';
}

const pad4 = (buf) => (buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf);
function checksum(buf) {
  const p = pad4(buf);
  let s = 0;
  for (let i = 0; i < p.length; i += 4) s = (s + p.readUInt32BE(i)) >>> 0;
  return s;
}

/**
 * A new .ttf with the same glyph ids but only the outlines of `codePoints` (plus composite parts
 * and .notdef), a cmap of only those characters, post format 3 (no glyph names).
 */
export function subsetTtf(font, codePoints) {
  const { tables, numGlyphs, loca } = font;
  const glyf = tables.glyf;
  const keep = new Set([0]);
  const map = [];
  for (const c of codePoints) { const g = font.cmap.get(c); if (g) { map.push([c, g]); keep.add(g); } }
  // Composite glyphs reference other glyphs: keep those too.
  const stack = [...keep];
  while (stack.length) {
    const g = stack.pop();
    const s = loca(g), e = loca(g + 1);
    if (e - s < 10 || glyf.readInt16BE(s) >= 0) continue;
    let o = s + 10;
    for (let guard = 0; guard < 64 && o + 4 <= e; guard++) {
      const flags = glyf.readUInt16BE(o), comp = glyf.readUInt16BE(o + 2);
      if (comp < numGlyphs && !keep.has(comp)) { keep.add(comp); stack.push(comp); }
      o += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0);
      if (!(flags & 0x20)) break;
    }
  }
  const parts = [], newLoca = Buffer.alloc(4 * (numGlyphs + 1));
  let at = 0;
  for (let g = 0; g < numGlyphs; g++) {
    newLoca.writeUInt32BE(at, 4 * g);
    if (!keep.has(g)) continue;
    const s = loca(g), e = loca(g + 1);
    if (e > s) { const d = pad4(Buffer.from(glyf.subarray(s, e))); parts.push(d); at += d.length; }
  }
  newLoca.writeUInt32BE(at, 4 * numGlyphs);
  // cmap: one format-12 subtable (3,10) with the used characters, as consecutive groups.
  map.sort((a, b) => a[0] - b[0]);
  const groups = [];
  for (const [c, g] of map) {
    const last = groups[groups.length - 1];
    if (last && c === last[1] + 1 && g === last[2] + (c - last[0])) last[1] = c; else groups.push([c, c, g]);
  }
  const cmap = Buffer.alloc(12 + 16 + groups.length * 12);
  cmap.writeUInt16BE(0, 0); cmap.writeUInt16BE(1, 2);
  cmap.writeUInt16BE(3, 4); cmap.writeUInt16BE(10, 6); cmap.writeUInt32BE(12, 8);
  cmap.writeUInt16BE(12, 12); cmap.writeUInt32BE(16 + groups.length * 12, 16); cmap.writeUInt32BE(groups.length, 24);
  groups.forEach(([s, e, g], i) => { cmap.writeUInt32BE(s, 28 + i * 12); cmap.writeUInt32BE(e, 32 + i * 12); cmap.writeUInt32BE(g, 36 + i * 12); });
  const head = Buffer.from(tables.head);
  head.writeUInt32BE(0, 8);           // checkSumAdjustment, set below
  head.writeInt16BE(1, 50);           // long loca
  const post = Buffer.alloc(32);
  if (tables.post) tables.post.copy(post, 0, 0, Math.min(32, tables.post.length));
  post.writeUInt32BE(0x00030000, 0);
  const out = { head, hhea: tables.hhea, maxp: tables.maxp, hmtx: tables.hmtx, loca: newLoca, glyf: Buffer.concat(parts), cmap, post };
  for (const t of ['OS/2', 'name', 'cvt ', 'fpgm', 'prep']) if (tables[t]) out[t] = tables[t];
  const tags = Object.keys(out).sort();
  const n = tags.length;
  let sr = 1, es = 0;
  while (sr * 2 <= n) { sr *= 2; es++; }
  const dir = Buffer.alloc(12 + 16 * n);
  dir.writeUInt32BE(0x00010000, 0); dir.writeUInt16BE(n, 4); dir.writeUInt16BE(sr * 16, 6); dir.writeUInt16BE(es, 8); dir.writeUInt16BE(n * 16 - sr * 16, 10);
  let off = dir.length;
  const bodies = [];
  tags.forEach((t, i) => {
    const data = out[t];
    const o = 12 + 16 * i;
    dir.write(t, o, 4, 'latin1'); dir.writeUInt32BE(checksum(data), o + 4); dir.writeUInt32BE(off, o + 8); dir.writeUInt32BE(data.length, o + 12);
    const padded = pad4(Buffer.from(data));
    bodies.push(padded); off += padded.length;
  });
  const file = Buffer.concat([dir, ...bodies]);
  const headAt = dir.readUInt32BE(12 + 16 * tags.indexOf('head') + 8);
  file.writeUInt32BE((0xb1b0afba - checksum(file)) >>> 0, headAt + 8);
  return new Uint8Array(file.buffer, file.byteOffset, file.length);
}

/**
 * What pdf-lib's CustomFontEmbedder / deriveFontFlags read from a fontkit font. characterSet = every
 * character of the (subset) cmap, so the widths and ToUnicode cover exactly the used characters.
 */
export function fontkitFont(bytes) {
  const f = parseTtf(bytes);
  const glyphs = new Map();
  const glyph = (id, cp) => {
    let g = glyphs.get(id);
    if (!g) { g = { id, advanceWidth: f.advance(id), codePoints: cp === undefined ? [] : [cp] }; glyphs.set(id, g); }
    return g;
  };
  const characterSet = [...f.cmap.keys()].sort((a, b) => a - b);
  for (const c of characterSet) glyph(f.cmap.get(c), c);
  const forCp = (c) => (f.cmap.has(c) ? glyph(f.cmap.get(c), c) : glyph(0));
  return {
    characterSet, unitsPerEm: f.unitsPerEm, postscriptName: f.postscriptName, bbox: f.bbox,
    ascent: f.ascent, descent: f.descent, capHeight: f.capHeight, xHeight: f.xHeight, italicAngle: f.italicAngle, cff: false,
    post: { isFixedPitch: f.isFixedPitch }, head: { macStyle: { italic: f.italic, bold: f.bold } }, 'OS/2': { sFamilyClass: f.familyClass },
    glyphForCodePoint: forCp,
    layout: (text) => ({ glyphs: Array.from(String(text), (ch) => forCp(ch.codePointAt(0))), positions: [] }),
  };
}
/** pdfDoc.registerFontkit(MINI_FONTKIT). */
export const MINI_FONTKIT = { create: (bytes) => fontkitFont(bytes) };

// System fonts, best first; each family: regular, bold, italic, bold italic (missing ones fall back).
const FAMILIES = [
  ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
  ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
  ['tahoma.ttf', 'tahomabd.ttf'],
  ['verdana.ttf', 'verdanab.ttf', 'verdanai.ttf', 'verdanaz.ttf'],
];
const MONO = ['consola.ttf', 'cour.ttf', 'lucon.ttf'];
export const fontDir = (env = process.env) => path.join(env.WINDIR || env.SystemRoot || 'C:\\Windows', 'Fonts');

/** → { r, b, i, bi, m } parsed fonts (keys missing → fall back to r / b), or throws FontError. */
export function loadSystemFonts(dir = fontDir()) {
  const load = (name) => {
    try { const bytes = fs.readFileSync(path.join(dir, name)); const f = parseTtf(bytes); return f.cmap.has(0x410) ? f : null; } catch { return null; }
  };
  for (const [r, b, i, bi] of FAMILIES) {
    const reg = load(r);
    if (!reg) continue;
    const out = { r: reg, b: (b && load(b)) || reg };
    out.i = (i && load(i)) || reg;
    out.bi = (bi && load(bi)) || out.b;
    out.m = MONO.map(load).find(Boolean) || reg;
    return out;
  }
  throw new FontError(`no usable system font (Segoe UI, Arial, Tahoma or Verdana) in ${dir}`);
}
