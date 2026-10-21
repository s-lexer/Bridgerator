// A bare wss:// endpoint that plays the relay side by hand (old relays, broken messages, close
// codes), for tests of the bridge's own link loop (src/bridge.mjs connect()).
import https from 'node:https';
import WebSocket, { WebSocketServer } from 'ws';

export async function startFakeRelay({ key, cert }) {
  const srv = https.createServer({ key, cert });
  const wss = new WebSocketServer({ server: srv, path: '/link' });
  const conns = [], waiters = [];
  wss.on('connection', (ws) => {
    const c = { ws, msgs: [], waiters: [] };
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { m = { raw: String(raw) }; }
      c.msgs.push(m);
      for (const w of c.waiters.splice(0)) w();
    });
    c.closed = new Promise((r) => ws.on('close', (code) => r(code)));
    /** Next message from the bridge matching `pred` (already received ones count). */
    c.next = async (pred = () => true) => {
      for (;;) {
        const i = c.msgs.findIndex(pred);
        if (i >= 0) return c.msgs.splice(i, 1)[0];
        await new Promise((r) => c.waiters.push(r));
      }
    };
    c.send = (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o));
    conns.push(c);
    for (const w of waiters.splice(0)) w();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  let taken = 0;
  return {
    url: `wss://localhost:${srv.address().port}/link`,
    get count() { return conns.length; },
    /** The next connection of the bridge (in order). */
    async next() {
      while (conns.length <= taken) await new Promise((r) => waiters.push(r));
      return conns[taken++];
    },
    close: () => new Promise((r) => { for (const c of conns) c.ws.terminate(); wss.close(); srv.close(r); }),
  };
}

export { WebSocket };
