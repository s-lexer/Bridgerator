// Bridgerator bridge: runs on the user's PC.
//   - starts the bundled open-source Desktop Commander MCP server as a child over stdio;
//   - pushes this PC's limits (allowedDirectories, blockedCommands) into it at startup;
//   - opens ONE outbound WebSocket to the relay (no inbound port is opened on this PC);
//   - forwards each relay `call` through the policy (excluded folders, disabled tools) to Desktop
//     Commander and sends the filtered result back.
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createPolicy, debrand } from './policy.mjs';

const RECONNECT_MS = 5000;
const DC_ENTRY = createRequire(import.meta.url).resolve('@wonderwhy-er/desktop-commander/dist/index.js');
const ISOLATE = new URL('./dc-isolate.mjs', import.meta.url).href;

export async function startDesktopCommander(cfg, log = console.log) {
  if (!cfg.dcConfigDir) throw new Error('dcConfigDir missing');
  const transport = new StdioClientTransport({
    command: process.execPath,
    // Own Desktop Commander config (dc-isolate.mjs): a DC the user runs elsewhere keeps its limits.
    args: ['--import', ISOLATE, DC_ENTRY],
    // No calls home: telemetry kill-switch, and remote feature flags (onboarding page, promo text
    // injected into tool results, A/B tests) replaced by an empty local set.
    env: { ...process.env, DC_TELEMETRY_ENABLED: 'false', DESKTOP_COMMANDER_DISABLE_TELEMETRY: '1', DC_FLAG_URL: 'data:application/json,{"flags":{}}', BRIDGERATOR_DC_CONFIG_DIR: cfg.dcConfigDir },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'bridgerator', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  // The PC owner's limits go into Desktop Commander's own config; the model can't change them
  // (set_config_value is never exposed to the relay, see policy.ALWAYS_HIDDEN).
  const set = (key, value) => client.callTool({ name: 'set_config_value', arguments: { key, value } });
  await set('allowedDirectories', cfg.allowedDirectories || []);
  if (Array.isArray(cfg.blockedCommands)) await set('blockedCommands', cfg.blockedCommands);
  await set('telemetryEnabled', false);
  const policy = createPolicy(cfg);
  const { tools } = await client.listTools();
  const visible = tools.filter(policy.visible).map(debrand);
  // MCP Apps widgets (file preview, config view) — served to ChatGPT through the relay as-is.
  const resources = ((await client.listResources().catch(() => ({ resources: [] }))).resources || []).map(debrand);
  const resourceUris = new Set(resources.map((r) => r.uri));
  log(`[bridgerator] engine up: ${visible.length} tools; allowed=${JSON.stringify(cfg.allowedDirectories || [])} excluded=${JSON.stringify(cfg.deniedDirectories || [])}`);
  if (!(cfg.allowedDirectories || []).length) log('[bridgerator] WARNING: allowedDirectories is empty — file tools can reach the whole disk');

  async function call(name, args) {
    const refusal = policy.check(name, args);
    if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true };
    try {
      // Results are NOT debranded: they carry the user's own file contents verbatim.
      return policy.filter(await client.callTool({ name, arguments: args || {} }), name, args);
    } catch (e) {
      return { content: [{ type: 'text', text: `bridge error: ${e?.message || e}` }], isError: true };
    }
  }
  async function readResource(uri) {
    if (!resourceUris.has(uri)) return { error: 'unknown resource' };
    try { return { result: debrand(await client.readResource({ uri })) }; } catch (e) { return { error: String(e?.message || e) }; }
  }
  return { client, tools: visible, resources, call, readResource, close: () => client.close() };
}

export function connect(cfg, dc, log = console.log) {
  const ws = new WebSocket(cfg.relay, { handshakeTimeout: 15000 });
  let alive = false;
  ws.on('open', () => {
    alive = true;
    ws.send(JSON.stringify({ type: 'hello', token: cfg.token, tools: dc.tools, resources: dc.resources }));
    log('[bridgerator] linked to relay, waiting for calls');
  });
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'welcome') { log(`[bridgerator] registered as "${msg.device}"`); return; }
    if (msg.type === 'read_resource' && msg.callId) {
      const r = await dc.readResource(msg.uri);
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'result', callId: msg.callId, ...r }));
      return;
    }
    if (msg.type !== 'call' || !msg.callId) return;
    const result = await dc.call(msg.name, msg.args || {});
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'result', callId: msg.callId, result }));
  });
  const die = (why) => {
    if (ws._down) return;
    ws._down = true;
    log(`[bridgerator] disconnected (${why}); reconnecting in ${RECONNECT_MS / 1000}s`);
    setTimeout(() => connect(cfg, dc, log), RECONNECT_MS);
  };
  ws.on('close', (code) => {
    if (code === 4003) { log('[bridgerator] relay rejected the device token — run `bridgerator setup --token <new token>`'); process.exit(2); }
    die(`close ${code}`);
  });
  ws.on('error', (e) => { if (!alive) die(`connect: ${e.message}`); });
  return ws;
}
