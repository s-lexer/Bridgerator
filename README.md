# Bridgerator

Connect your Windows PC to ChatGPT. The assistant can read and edit files, search folders and run
PowerShell commands on **your** computer — through a bridge that only makes an **outbound**
connection. No inbound ports, no remote-desktop software.

```
ChatGPT ──OAuth 2.1 + MCP (HTTPS)──► relay (mcp.bridgerator.recondeck.com) ──WebSocket──► bridgerator on your PC ──stdio──► bundled MCP engine
```

This repository is the part that runs on your PC. It is small on purpose so you (or an AI agent
installing it for you) can read all of it: `src/bridge.mjs` (forwarder), `src/policy.mjs` (access
rules), `src/dc-isolate.mjs` (separate engine config), `src/cli.mjs` (setup/autostart), `src/pair.mjs` (browser pairing), `install.ps1` (installer). Version 1.1.0 ships as a signed Windows app (no Node.js needed); this repository is also published as the npm package for developers.

## What people use it for

- "Sort my Downloads folder by type and month" — ChatGPT lists, plans and moves the files on your PC.
- "Find every invoice PDF in Documents and rename it by date" — search and rename in plain words.
- "Why is drive C almost full?" — disk usage, big folders, what is safe to delete.
- "Check the event log for errors since yesterday" / "Read the end of this log" — diagnostics.
- Work on code: "explain how D:\\Projects\\app is built and run its tests".

Everything runs as your Windows user and only inside the folders you allow.

## Plans

Free: 10,000 tool calls per month per account, any number of PCs. Pro: $10/month, unlimited.
Details: https://bridgerator.recondeck.com/pricing

## Install (Windows)

1. Sign up at https://bridgerator.recondeck.com (or sign in with Google from ChatGPT or another AI app) and follow **Install** there: the site gives the download and the install steps for Windows.
2. A browser tab opens with a code: check that it matches the one shown by the installer and click **Connect this computer**. Done — no key to copy.

The installer downloads the signed Bridgerator app for Windows (`bridgerator.exe` with Node.js inside — nothing else to install; x64 and ARM64), checks it (SHA256 of the download and of every file), puts it into `%LOCALAPPDATA%\Bridgerator\app` and runs `bridgerator.cmd setup`. No admin rights needed. An older npm install is replaced, its key and settings kept. If the WebView2 runtime (used by the window) is missing, it is installed for your user only (Microsoft's installer, signature checked); without it the account page opens instead of the window. `-UseNpm` installs the npm package instead (your Node.js 22+, or a portable Node.js 24 LTS, checksum-verified; the package SHA256-checked, `--ignore-scripts`). Works under the default Restricted execution policy. `-NoTelemetry` turns off the usage counts (see Privacy).


Update later the same way (the key and settings are kept). Prefer to read first? Download `install.ps1` from the site, read it, then run it.
Servers or PCs without a browser: create a device key in your account (Add a computer → Advanced) and pass `-Token <device key>` to the installer.

Manual install (PowerShell): `$env:PUPPETEER_SKIP_DOWNLOAD=1; npm.cmd install -g bridgerator --ignore-scripts`, then `bridgerator.cmd setup` (or `bridgerator.cmd setup --token <key>`). The variable skips a ~700 MB Chrome download that only PDF export needs; PDF export fetches a browser itself on first use.

Other MCP clients (Claude, Codex, Cursor, VS Code and others): server URL `https://mcp.bridgerator.recondeck.com/mcp`, OAuth sign-in. Apps that cannot do OAuth can use a personal access key from your account page (Authorization: Bearer).

## Access rules — what the assistant can and cannot touch

Config: `%APPDATA%\Bridgerator\config.json` (written by `setup` and the window; a running bridge picks up a hand edit within seconds — lowering protection waits for Apply in a notification on the PC). Every setting can also be read and changed by the assistant with `bridgerator_settings`; its changes apply at once, unless you turn on `askSettings` (below).

By default nothing is restricted (like the engine on its own), except that **deletions go to the Recycle Bin** and **file changes can be undone**.

| Key | Meaning | Default |
|---|---|---|
| `allowedDirectories` | File tools work only inside these folders. Empty = all folders except the always-blocked ones. | empty (all folders) |
| `deniedDirectories` | Folders excluded **inside** the allowed ones (enforced by Bridgerator, see below). Always excluded, can't be removed: Bridgerator itself — `%APPDATA%\Bridgerator`, `%LOCALAPPDATA%\Bridgerator` (snapshots too), the package in `%APPDATA%\npm`. | none |
| `protectSensitive` | "Protect sensitive folders": also excludes `%APPDATA%\npm`, Startup, `Documents\WindowsPowerShell`/`PowerShell`, `~\.ssh .aws .azure .kube .docker .gnupg .config .npmrc .git-credentials .gitconfig .claude`, `~\AppData`. | `false` |
| `recycleBin` | A plain delete command (`Remove-Item`, `del`, `erase`, `rd`/`rmdir`, `rm` with literal paths or a wildcard in the last part) moves the items to the Recycle Bin instead; no Recycle Bin on that drive (network, many USB sticks) → asked on the PC first. Scripts, pipelines and other programs that delete are not caught: a safety net, not a guarantee. | `true` |
| `snapshots` | `{enabled, days, maxMb, maxFileMb}`: a copy of a file before the assistant writes, edits, moves or (through the Recycle Bin path) deletes it, in `%LOCALAPPDATA%\Bridgerator\snapshots`; Undo in the window (Recent → Undo, "Undo AI changes…" per task / batch) and `bridgerator_undo`. A file changed after the assistant's action is never overwritten. Bigger files get no copy ("no undo"). | on, 7 days, 500 MB, 50 MB |
| `fuse` | `{enabled, limit}`: more than `limit` deletions / moves within a minute → Bridgerator pauses itself and asks on the PC whether to continue (no answer = stays paused). | off, 20 |
| `askSettings` | "Ask before the AI changes settings": when on, an AI change that lowers protection or widens access (`bridgerator_settings`, `bridgerator_setup`) waits for Apply on the PC; raising protection still applies at once. Off: every AI change applies at once. | `false` |
| `keepAwake` | The PC doesn't go to sleep while the assistant works or the task queue has work (mains power only; the screen can still turn off). | `true` |
| `readOnlyDirectories` | Readable, but `write_file`, `edit_block`, `move_file` (either side), `create_directory` are refused. The terminal is not bound by it. `bridgerator.cmd read-only add\|remove <dir>` | none |
| `confirm.ini` (next to config.json) | Off by default. When on, a Windows notification on the PC (Allow / Allow 10 min / Deny, "Allow always" in its `...` menu; no answer in 2 min = Deny) before **risky** calls: `delete` and `dangerous_commands` (pattern lists, a safety net — an obfuscated command can slip through), optionally `write_files`, `move`, `any_command`, plus your own `[patterns]`. Re-read on every call. A hand edit of the file that lowers protection waits for Apply / Keep on the PC; the last applied state is kept in `confirm.approved` next to it, so a deleted or broken `confirm.ini` comes back with that state. `bridgerator.cmd confirm on\|off [category]`; the assistant can only ask (`request_confirm_off`, approved on the PC). If notifications are off for Bridgerator, a small window in the bottom-right is used instead; with Do Not Disturb the request is denied after 2 minutes. | off |
| `blockedCommands` | A safety net of the engine: refuses commands by their first word. Not a security boundary. Leave it out to keep the built-in list. | built-in list (`format`, `diskpart`, `reg`, `net`, `sc`, `runas`, `netsh`, `takeown`, …) |
| `telemetryEnabled` | Anonymous usage counts (see Privacy). `bridgerator.cmd telemetry off\|on` | `true` |
| `disabledTools` | Tools the assistant can't use. The access presets set the terminal here: Read only (terminal off + every folder read-only), Files (terminal off), Full (default). `start_process`, `interact_with_process`, `kill_process` stay listed and are refused while the terminal is off. | none |

Full file, search and terminal toolset, including ChatGPT widgets (file preview,
config view). Hidden: `set_config_value` (would let the assistant change its own limits), feedback and
usage-stats tools, `write_pdf` and `get_recent_tool_calls`; `read_file` with `isUrl` and UNC / device
paths (`\\server\share`, `\\?\`, `\\.\`) are refused. Path arguments are checked at any depth.

How exclusions work (`src/policy.mjs`): every path argument is resolved (symlinks and junctions
included) and refused if it lies inside an excluded folder; result lines that mention an excluded
path (search hits, recursive listings) are removed. The file tools can't reach the settings folder; the
settings tool (`bridgerator_settings`) can't change those folders, and with `askSettings` on it lowers protection only after your OK on the PC.

⚠ **The terminal is not a folder sandbox.** A shell command runs with your Windows user's rights
and can read anything you can. Bridgerator refuses commands that literally name an excluded folder,
but that is a courtesy, not a boundary. If folder limits must be strict, add the terminal tools to
`disabledTools`.

The bridge runs as **your** Windows user (hidden scheduled task at logon), never as SYSTEM.

Bridgerator gives its bundled engine its **own** config folder (`%APPDATA%\Bridgerator\dc`, see `src/dc-isolate.mjs`): if you already run the same open-source MCP server for Claude or another app, its settings and folder limits are not touched. The engine keeps a local log of recent tool calls in that folder (the per-call argument log is turned off); it never leaves your PC.

## Tray, window and task queue

While the bridge runs, a tray icon shows its state (green online, grey offline, yellow paused; a
yellow / red badge when Pro is ending or the Free limit is near). Right-click: status line, **Open
Bridgerator**, **Task queue**, **Confirm on this PC** (on / off), **Pause** (15 min, 1 hour, until
resumed), **Open account**, **Help**, **Quit**. Double-click opens the window: Status, Task queue, Automations, Agents,
Agent tasks, Last actions, Safety (confirmations, folders, read-only folders), Notifications, Settings
(cards in pairs; theme System / Light / Dark for the window and our pop-ups, English / Russian, computer name,
start with Windows, usage stats, local history, ask before the AI changes settings, updates, uninstall), Help. Minimize hides the window to the tray. Notifications can also go to Telegram (@BridgeratorBot, linked in your account): counts and statuses only, never file contents.
The tray helper (`src/tray.ps1`, hidden PowerShell, stdin/stdout JSON lines, no network) also shows
the confirmation and setup notifications. The window is WebView2 (`ui/`; SDK DLLs in
`vendor/webview2`, official NuGet package Microsoft.Web.WebView2 1.0.4258.31, SHA256 in
`vendor/webview2/SHA256SUMS.txt`); without the runtime the account page opens instead.
Stored only on this PC: the task queue (`%APPDATA%\Bridgerator\queue.json`; tools `queue_list`,
`queue_next`, `queue_update`, `queue_add`, `queue_edit`, `queue_reorder`) and the recent calls with
their command / path (memory; `recent.jsonl` for 7 days only with "Keep a local history" on).

**Several chats at once.** Several ChatGPT chats can work on the same PC in parallel: calls run
concurrently (a slow command doesn't hold up other chats), `queue_next` never hands the same task to
two chats, and at most 8 actions run at a time — extra ones wait up to 30 s, then get a "busy" answer
that is not counted.

## Talk to ChatGPT

Say these in any ChatGPT chat with Bridgerator connected (several chats can work at once):

| Say | What happens |
|---|---|
| `Set up Bridgerator` | Nothing to configure: the defaults (all folders, terminal on, Recycle Bin, Undo) are the setup. ChatGPT limits access only if you ask for limits ("only this folder", "read only"), and that applies at once. |
| `Add these tasks to my Bridgerator queue: …` | The tasks go into the queue on this PC (up to 100 at a time). |
| `Work through my Bridgerator queue` | ChatGPT takes the tasks one by one and marks each done / failed with a note. |
| `Continue my Bridgerator queue` | In a new chat: picks up tasks another chat left unfinished for 30 min. |
| `Show my Bridgerator settings` | Folders, confirmations, notifications — what is set now (`bridgerator_settings`). |
| `Turn on confirmations for deletions` | Applies at once. With "Ask before the AI changes settings" on, lowering protection (e.g. turning confirmations off) needs your OK on the PC. |

Folders: with no list (the default) ChatGPT may work in all folders except the always-blocked ones;
with a list, only in those folders. The assistant's changes apply at once; with "Ask before the AI changes settings" on, widening access (adding a folder to the list, going back to all folders) needs your OK on the PC.

## Commands

```
bridgerator.cmd setup [--token <key> | --pair] [--allow <dir>]... [--deny <dir>]... [--read-only <dir>]... [--language en|ru] [--no-telemetry]
                                                                          # pair in the browser (no key yet, key rejected, or --pair) + config + autostart + start
bridgerator.cmd run                                                       # foreground (what autostart runs)
bridgerator.cmd stop                                                      # stop it (starts again at the next logon)
bridgerator.cmd status [--json]                                           # running / online / key rejected (+ config with --json)
bridgerator.cmd doctor [--json]                                           # check the install, connection and settings
bridgerator.cmd confirm on|off [category]                                 # confirmation on this PC (confirm.ini)
bridgerator.cmd read-only add|remove <dir>                                # read-only folders
bridgerator.cmd telemetry on|off                                          # anonymous usage counts
bridgerator.cmd uninstall --all                                           # THE uninstall: stop, remove autostart, settings + key, the program files (app folder or npm package) and the Node.js the installer added
bridgerator.cmd uninstall [--keep-config]                                 # stop, remove autostart and %APPDATA%\Bridgerator (kept with --keep-config); program files stay
```
Log: `%APPDATA%\Bridgerator\bridge.log`. Stopping the bridge cuts access immediately. After uninstalling, also remove the computer on the account page: https://bridgerator.recondeck.com/app

## Privacy

File contents and command output go to ChatGPT (OpenAI) as tool results; the relay forwards them
in memory and does not store them. Engine telemetry, remote feature flags and any browser pop-ups are turned off by the bridge.

Bridgerator's own usage counts (`src/telemetry.mjs`, HTTPS to `https://bridgerator.recondeck.com/t`):
events install, update, uninstall and a daily heartbeat with a random install id, bridge version,
Windows version, OS language, Node.js version, and per-tool call / error counts of the last 24 h.
Never paths, file names, commands, arguments, outputs or your e-mail. Off: `bridgerator.cmd telemetry off`,
`"telemetryEnabled": false`, or the installer's `-NoTelemetry`.
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
портов нет. Установка — одна строка PowerShell, затем подтверждение компьютера во вкладке браузера (см. выше).
Разрешённые папки — `allowedDirectories`, исключения внутри них — `deniedDirectories`
(исключения обеспечивает сам Bridgerator). Терминал папками не
ограничивается — для строгих границ выключите его через `disabledTools`.
