// Run INSIDE a built app folder by bridgerator.exe (test/exe-dist.test.mjs copies it there for the run):
// the real engine child started through the exe (`--import dc-isolate.mjs` + module hooks), a file
// round trip with Cyrillic text, ripgrep search (rg.exe), the terminal, and sharp's native module.
// argv: <config dir> <work dir> → one JSON line.
import fs from 'node:fs';
import path from 'node:path';
import { startEngine } from './src/bridge.mjs';

const [dir, work] = process.argv.slice(2);
const text = (r) => (r?.content || []).map((c) => c.text || '').join('\n');
const out = { execPath: process.execPath };
const dc = await startEngine({ allowedDirectories: [work], deniedDirectories: [], readOnlyDirectories: [], protectSensitive: false, dcConfigDir: path.join(dir, 'dc'), configDir: dir }, () => {}, { ask: async () => 'deny' });
try {
  out.tools = dc.tools.length;
  const f = path.join(work, 'заметка needle.txt');
  out.write = text(await dc.call('write_file', { path: f, content: 'привет needle' }));
  out.read = text(await dc.call('read_file', { path: f }));
  const s = text(await dc.call('start_search', { path: work, pattern: 'needle', searchType: 'content' }));
  const sid = (s.match(/session[^\w]*([\w-]{6,})/i) || [])[1];
  let hits = s;
  if (sid) { await new Promise((r) => setTimeout(r, 2500)); hits += '\n' + text(await dc.call('get_more_search_results', { sessionId: sid })); }
  out.search = hits;
  out.shell = text(await dc.call('start_process', { command: 'Write-Output ("ok-" + (6*7))', timeout_ms: 20000 }));
  out.dcConfig = fs.existsSync(path.join(dir, 'dc', 'config.json'));
  // One of our own tools running a package .ps1 (read-only): signed scripts still load the way runFilesPs reads them.
  const pc = await dc.call('pc_health', { action: 'load' });
  out.pcHealth = { isError: !!pc.isError, text: text(pc).slice(0, 300) };
  const sharp = (await import('sharp')).default;
  out.sharpPng = (await sharp({ create: { width: 2, height: 2, channels: 3, background: '#2251e6' } }).png().toBuffer()).subarray(1, 4).toString();
} catch (e) { out.error = String(e?.stack || e); }
await dc.close().catch(() => {});
console.log(JSON.stringify(out));
process.exit(0);
