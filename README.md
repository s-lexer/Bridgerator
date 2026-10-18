# Bridgerator

Connect your Windows PC to ChatGPT. The assistant can read and edit files, search folders and run
PowerShell commands on **your** computer — through a bridge that only makes an **outbound**
connection. No inbound ports, no remote-desktop software.

```
ChatGPT ──OAuth 2.1 + MCP (HTTPS)──► relay (mcp.bridgerator.recondeck.com) ──WebSocket──► bridgerator on your PC ──stdio──► bundled MCP engine
```

This repository is the part that runs on your PC. It is small on purpose so you (or an AI agent
installing it for you) can read all of it: `src/bridge.mjs` (forwarder), `src/policy.mjs` (access
rules), `src/dc-isolate.mjs` (separate engine config), `src/cli.mjs` (setup/autostart), `install.ps1` (installer).

## Plans

Free: 15,000 tool calls per month per account, any number of PCs. Pro: $15/month, unlimited.
Details: https://bridgerator.recondeck.com/pricing

## Install (Windows)

1. Create an account and a device key at https://bridgerator.recondeck.com.
2. In PowerShell (no admin rights needed):
   ```powershell
   & ([scriptblock]::Create((irm https://bridgerator.recondeck.com/install.ps1))) -Token <device key>
   ```
   It installs Node.js LTS if missing (winget), installs this package and runs `bridgerator setup`.
   Prefer to read first? Download `install.ps1`, read it, run it with `-Token`.
3. In ChatGPT: Settings → Apps & Connectors → Advanced → Developer mode → Create → URL
   `https://mcp.bridgerator.recondeck.com/mcp`, authentication OAuth, sign in with your account.

Manual install: `npm install -g github:s-lexer/bridgerator` then `bridgerator setup --token <key>`.

## Access rules — what the assistant can and cannot touch

Config: `%APPDATA%\Bridgerator\config.json` (written by `setup`, edit and restart to change).

| Key | Meaning | Default |
|---|---|---|
| `allowedDirectories` | File tools work only inside these folders (enforced by the engine). Empty = whole disk. | your user folder |
| `deniedDirectories` | Folders excluded **inside** the allowed ones (enforced by Bridgerator, see below). | `~\.ssh`, `~\AppData` |
| `blockedCommands` | Commands the engine refuses to run. Leave it out to keep the built-in list. | built-in list (`format`, `diskpart`, `reg`, `net`, `sc`, `runas`, `netsh`, `takeown`, …) |
| `disabledTools` | Tools never shown to the assistant, e.g. `["start_process","interact_with_process"]` to turn the terminal off. | none |

Full file, search and terminal toolset, including ChatGPT widgets (file preview,
config view). Hidden: `set_config_value` (would let the assistant change its own limits), feedback and
usage-stats tools.

How exclusions work (`src/policy.mjs`): every path argument is resolved (symlinks and junctions
included) and refused if it lies inside an excluded folder; result lines that mention an excluded
path (search hits, recursive listings) are removed; `set_config_value` is never exposed, so the
assistant cannot change these limits.

⚠ **The terminal is not a folder sandbox.** A shell command runs with your Windows user's rights
and can read anything you can. Bridgerator refuses commands that literally name an excluded folder,
but that is a courtesy, not a boundary. If folder limits must be strict, add the terminal tools to
`disabledTools`.

The bridge runs as **your** Windows user (hidden scheduled task at logon), never as SYSTEM.

Bridgerator gives its bundled engine its **own** config folder (`%APPDATA%\Bridgerator\dc`, see `src/dc-isolate.mjs`): if you already run the same open-source MCP server for Claude or another app, its settings and folder limits are not touched. The engine keeps a local log of recent tool calls in that folder; it never leaves your PC.

## Commands

```
bridgerator setup --token <key> [--allow <dir>]... [--deny <dir>]...   # config + autostart + start
bridgerator run                                                       # foreground (what autostart runs)
bridgerator status                                                    # config (token masked) + log tail
bridgerator uninstall                                                 # stop + remove autostart
```
Log: `%APPDATA%\Bridgerator\bridge.log`. Stopping the bridge cuts access immediately.

## Privacy

File contents and command output go to ChatGPT (OpenAI) as tool results; the relay forwards them
in memory and does not store them. Engine telemetry, remote feature flags and any browser pop-ups are turned off by the bridge.
Policy: https://bridgerator.recondeck.com/privacy

## Development

`npm test` — policy unit tests plus an end-to-end run against the real bundled engine
(throw-away folders; asserts that an existing config of the same engine stays byte-identical).

## License

MIT. The bundled open-source MCP engine is MIT-licensed as well; its copyright notice is kept in
`LICENSE` and the dependency is listed in `package.json`.

---

### По-русски коротко
Bridgerator подключает ваш ПК к ChatGPT: файлы, поиск, терминал. Мост только исходящий, входящих
портов нет. Установка — одна строка PowerShell с ключом устройства из кабинета (см. выше).
Разрешённые папки — `allowedDirectories`, исключения внутри них — `deniedDirectories`
(исключения обеспечивает сам Bridgerator). Терминал папками не
ограничивается — для строгих границ выключите его через `disabledTools`.
