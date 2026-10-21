// A real bridge in its own process, like `bridgerator.cmd run` on a PC but without the tray helper
// (no tray icon / windows on the test PC): optional key-less pairing (src/pair.mjs), the real engine
// (startDesktopCommander) and the real link (connect). Questions on the PC go to the parent test over
// IPC; notifications are caught (helpers/no-popups.mjs) and reported. Started by helpers via
// startBridgeChild(); argv[2] = JSON options file.
import { shown } from './no-popups.mjs';
import fs from 'node:fs';
import path from 'node:path';

const send = (o) => { try { process.send?.(o); } catch { /* parent gone */ } };
if (process.argv[2]) {
  const o = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const log = (l) => send({ ev: 'log', line: String(l) });
  const { startDesktopCommander, connect } = await import('../../src/bridge.mjs');
  const { pair } = await import('../../src/pair.mjs');
  let token = o.token;
  if (o.pair) {
    const got = await pair(o.site, o.name, { fp: o.fp || '', open: (url) => send({ ev: 'open', url }), log, everyMs: 200 });
    token = got.token;
    send({ ev: 'paired', name: got.name, email: got.email || '' });
  }
  let seq = 0;
  const waiting = new Map();
  const ask = (q) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); send({ ev: 'ask', id, q }); });
  const dir = o.configDir;
  fs.mkdirSync(dir, { recursive: true });
  const configFile = path.join(dir, 'config.json');
  if (!fs.existsSync(configFile)) fs.writeFileSync(configFile, JSON.stringify({ relay: o.relay, token, allowedDirectories: o.allowedDirectories || [], deniedDirectories: o.deniedDirectories || [], readOnlyDirectories: o.readOnlyDirectories || [] }, null, 2));
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const dc = await startDesktopCommander({ ...cfg, dcConfigDir: path.join(dir, 'dc'), configDir: dir, confirmIni: path.join(dir, 'confirm.ini'), configFile }, log, { ask });
  dc.onLink = (state, name) => { dc.linkState = state; if (name) dc.linkName = name; send({ ev: 'link', state, name: name || '' }); };
  dc.setPaused = (v) => { dc.paused = v; dc.onMode(dc.mode()); };
  let notified = 0;
  setInterval(() => { for (; notified < shown.length; notified++) send({ ev: 'notice', toast: shown[notified].toast, head: shown[notified].head }); }, 50).unref();
  process.on('message', async (m) => {
    if (m.cmd === 'answer') { waiting.get(m.id)?.(m.key); waiting.delete(m.id); }
    if (m.cmd === 'pause') dc.setPaused(m.on === true);
    if (m.cmd === 'rpc') { try { send({ ev: 'rpc', id: m.id, result: await dc.rpc(m.method, m.params || {}) }); } catch (e) { send({ ev: 'rpc', id: m.id, error: String(e.message) }); } }
    if (m.cmd === 'resources') send({ ev: 'resources', id: m.id, list: process.getActiveResourcesInfo() });
    if (m.cmd === 'exit') { await dc.close().catch(() => {}); process.exit(0); }
  });
  connect({ relay: o.relay, token, notify: {} }, dc, log);
  send({ ev: 'started', token });
}
