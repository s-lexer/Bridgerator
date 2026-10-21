// Fake agent CLIs installed the way npm does it (a .cmd shim → a node script), in a fake profile with a
// Cyrillic name: Codex and Claude Code under %APPDATA%\npm, Gemini CLI in a folder on the PATH.
// Sign-in files: Codex auth.json and Gemini oauth_creds.json exist (dummy text), Claude Code has none.
// Nothing real is started: the scripts are test/fixtures/delegate/fake-agent.cjs.
import fs from 'node:fs';
import path from 'node:path';

const FAKE = new URL('../fixtures/delegate/fake-agent.cjs', import.meta.url);
// What npm's cmd-shim writes (CRLF).
export const npmShim = (rel) => ['@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`, ''].join('\r\n');

function install(dir, bin, rel) {
  const script = path.join(dir, rel);
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.copyFileSync(FAKE, script);
  fs.writeFileSync(path.join(dir, `${bin}.cmd`), npmShim(rel));
}

/** → { home, env, appData, local, npmDir, geminiDir } — env is what createDelegate gets (PATH = the gemini folder only). */
export function fakeAgents(root, { codex = true, claude = true, gemini = true } = {}) {
  const home = path.join(root, 'Мария Иванова');
  const appData = path.join(home, 'AppData', 'Roaming'), local = path.join(home, 'AppData', 'Local');
  const npmDir = path.join(appData, 'npm'), geminiDir = path.join(root, 'Программы', 'gemini');
  for (const d of [npmDir, local, geminiDir]) fs.mkdirSync(d, { recursive: true });
  if (codex) install(npmDir, 'codex', 'node_modules\\@openai\\codex\\bin\\codex.js');
  if (claude) install(npmDir, 'claude', 'node_modules\\@anthropic-ai\\claude-code\\cli.js');
  if (gemini) install(geminiDir, 'gemini', 'node_modules\\@google\\gemini-cli\\dist\\index.js');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"dummy":true}');
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), 'model = "x"\n\n[mcp_servers.bridgerator]\nurl = "https://example.invalid/mcp"\n\n[mcp_servers.bridgerator.env]\nX = "1"\n\n[mcp_servers."two words"]\ncommand = "x"\n\n[mcp_servers.files-2]\ncommand = "y"\n');
  fs.mkdirSync(path.join(home, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini', 'oauth_creds.json'), '{"dummy":true}');
  const env = { USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: local, PATH: [geminiDir, 'relative\\bin', '.'].join(';'), SystemRoot: process.env.SystemRoot || 'C:\\Windows', TEMP: process.env.TEMP || '', TMP: process.env.TMP || '' };
  return { home, env, appData, local, npmDir, geminiDir };
}
