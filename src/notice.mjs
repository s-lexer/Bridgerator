// Plan notices from the relay (limit reached, Pro ending/ended) and the bridge's own link notices,
// shown as a Windows notification with an "Open account" button. They never go into the ChatGPT
// chat (app rules: no upgrade links there). The link is fixed here — the relay only says which
// notice, not where to send the user. Relay values are validated strictly and reach PowerShell only
// as environment variables (escaped there), never as part of the script text.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { POWERSHELL, psArgs } from './win.mjs';
import { LABEL } from './confirm.mjs';
import { safeUrl, accountUrl } from './plan.mjs';

export const ACCOUNT_URL = 'https://bridgerator.recondeck.com/app';
const int = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : null);
const ymd = (x) => (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(x) ? x.slice(0, 10) : null);
const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// ponytail: English only for now (owner, 20.10); other languages later.
export function noticeText(n) {
  const kind = n?.kind;
  let t;
  if (kind === 'limit') {
    const calls = int(n.calls), limit = int(n.limit);
    if (calls === null || limit === null) return undefined;
    t = ['Bridgerator: monthly limit reached', `${calls} of ${limit} tool calls used. ChatGPT can't use this PC until the 1st. Turn on Pro in your account.`];
  } else if (kind === 'expiring') {
    const until = ymd(n.until);
    if (!until) return undefined;
    t = [`Bridgerator Pro ends on ${until}`, 'Pay for 30 more days in your account to keep unlimited calls.'];
  } else if (kind === 'queue_done') {
    const title = typeof n.title === 'string' ? n.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 120) : '';
    if (!title) return undefined;
    t = ['Queue task done', title];
  } else if (kind === 'queue_stalled') {
    const title = typeof n.title === 'string' ? n.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 120) : '';
    if (!title) return undefined;
    const more = int(n.more) || 0;
    t = ['ChatGPT may be waiting for you', `No activity on the queue task "${title}"${more ? ` and ${more} more` : ''} for 10 minutes. Open the ChatGPT chat: it may be asking you to allow an action, or show an error such as "model is at capacity" — press Retry there or pick another model.`];
  } else if (kind === 'settings_changed') {
    // The bridge's own change lines (describe / diffSetup): paths and labels, no relay text.
    const what = Array.isArray(n.what) ? n.what.map((w) => String(w).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()).filter(Boolean) : [];
    if (!what.length || !['ai', 'file'].includes(n.by)) return undefined;
    // Whole lines up to ~200 chars, then "+N more" (the window has the full list): nothing is cut silently.
    let all = what[0].slice(0, 200), k = 1;
    while (k < what.length && all.length + what[k].length + 3 <= 200) all += ` · ${what[k++]}`;
    if (k < what.length) all += ` · +${what.length - k} more`;
    t = ['Bridgerator settings changed', `${n.by === 'ai' ? 'By the AI' : 'In the settings file'}: ${all}. Turn this notice off in the Bridgerator window.`];
  } else if (kind === 'protection_off') {
    // Internal list only (the bridge's own labels), never relay text.
    const ok = new Set(['confirmations', 'your own patterns', ...Object.values(LABEL).map((l) => `confirmations for ${l}`)]);
    const what = Array.isArray(n.what) ? n.what.filter((w) => ok.has(w)) : [];
    if (!what.length) return undefined;
    t = ['Bridgerator: protection turned off', `${what.join(', ')} — turn back on in the Bridgerator window or: bridgerator.cmd confirm on`];
  } else if (kind === 'screenshot') {
    // On every screenshot the AI takes (screen-tool.mjs): the person always sees that it happened.
    const what = n.what === 'screen' ? 'Whole screen' : n.what === 'monitor' && int(n.monitor) ? `Monitor ${int(n.monitor)}`
      : n.what === 'window' && typeof n.title === 'string' ? `Window "${n.title.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 80)}"` : null;
    if (!what) return undefined;
    t = ['Bridgerator: the AI took a screenshot', `${what}${n.ocr ? ' (text recognized)' : ''}. You can turn screenshots or this notice off in the Bridgerator window.`];
    return { title: t[0], body: t[1], button: null, url: accountUrl() };
  } else if (kind === 'updating' || kind === 'updated') {
    // In-window update (owner 21.10: never a console): before the hidden installer, and from the new version.
    const v = typeof n.version === 'string' && /^\d+\.\d+\.\d+$/.test(n.version) ? n.version : null;
    if (!v) return undefined;
    t = kind === 'updating' ? [`Bridgerator is updating to ${v}`, 'It restarts by itself in about a minute. ChatGPT can use this PC again right after.'] : [`Bridgerator updated to ${v}`, 'Your settings are kept.'];
    return { title: t[0], body: t[1], button: null, url: accountUrl() };
  } else if (kind === 'update_available') {
    // Daily check of our site (bridge.mjs updateCheck, owner 28.10).
    const v = typeof n.version === 'string' && /^\d+\.\d+\.\d+$/.test(n.version) ? n.version : null;
    if (!v) return undefined;
    t = [`Bridgerator ${v} is available`, 'Open Bridgerator from the tray → Settings → Update now, or ask ChatGPT to update Bridgerator. Your settings are kept.'];
    return { title: t[0], body: t[1], button: null, url: accountUrl() };
  } else if (kind === 'confirm_locked') {
    // V-9: the window / tray toggle could not write confirm.ini (another program holds it): nothing changed.
    t = ['Bridgerator: the setting was not changed', 'Another program is using confirm.ini, so the confirmation setting stays as it was. Try again in a moment.'];
    return { title: t[0], body: t[1], button: null, url: accountUrl() };
  } else if (kind === 'confirm_off') {
    const label = Object.hasOwn(LABEL, n.category) ? LABEL[n.category] : null;
    if (!label) return undefined;
    t = [`Confirmations for ${label} are off`, `Turn back on: bridgerator.cmd confirm on ${n.category}`];
  } else {
    const fixed = {
      expired: ['Bridgerator Pro has ended', "You're on Free now (10,000 tool calls a month). Renew Pro in your account."],
      unlinked: ['Bridgerator: this computer is no longer linked', 'ChatGPT can no longer reach this PC. Run the install command from your account page again.'],
      offline: ['Bridgerator is offline', "ChatGPT can't reach this PC right now. Bridgerator keeps trying to reconnect."],
      replaced: ['Bridgerator: this key is used elsewhere', 'Another Bridgerator with this computer\'s key took over the link. This PC retries later; if it keeps happening, run the install command on this PC again.'],
    };
    t = Object.hasOwn(fixed, kind) ? fixed[kind] : undefined;
  }
  if (!t) return undefined;
  // Plan notices get the pay button (allowed here on the PC, never inside ChatGPT); only our own site.
  const pay = { limit: 'Upgrade to Pro', expiring: 'Renew Pro', expired: 'Renew Pro' }[kind];
  return { title: t[0], body: t[1], button: pay || 'Open account', url: pay ? safeUrl(n.renewUrl) : accountUrl() };
}

const ICON_URL = new URL('../assets/icon-64.png', import.meta.url);
export const ICON = fileURLToPath(ICON_URL);
export function toastXml({ title, body, button, url = accountUrl() }) {
  const link = xml(safeUrl(url));
  return `<toast activationType="protocol" launch="${link}"><visual><binding template="ToastGeneric"><image placement="appLogoOverride" src="${xml(ICON_URL.href)}"/><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual>`
    + (button ? `<actions><action content="${xml(button)}" activationType="protocol" arguments="${link}"/></actions>` : '') + '</toast>';
}

// Fixed script: the texts come in through BR_TOAST (the ready XML, escaped above).
const PS = `$k = 'HKCU:\\Software\\Classes\\AppUserModelId\\Bridgerator'
if (-not (Test-Path $k)) { New-Item $k -Force | Out-Null }
New-ItemProperty $k -Name DisplayName -Value 'Bridgerator' -Force | Out-Null
if ($env:BR_ICON -and (Test-Path $env:BR_ICON)) { New-ItemProperty $k -Name IconUri -Value $env:BR_ICON -Force | Out-Null }
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$x = New-Object Windows.Data.Xml.Dom.XmlDocument
$x.LoadXml($env:BR_TOAST)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Bridgerator').Show([Windows.UI.Notifications.ToastNotification]::new($x))`;

// `done` runs once the notification is shown (or could not be): lets the caller exit after it.
export function showNotice(n, log = console.log, done = () => {}) {
  const t = noticeText(n);
  if (!t) return done();
  log(`[bridgerator] notice: ${t.title} — ${t.body} ${accountUrl()}`);
  if (process.platform !== 'win32') return done();
  // Own app id under HKCU (no admin): the notification header reads "Bridgerator", not "Windows PowerShell".
  execFile(POWERSHELL, psArgs(PS), { windowsHide: true, timeout: 20000, env: { ...process.env, BR_TOAST: toastXml(t), BR_ICON: ICON } }, (e) => { if (e) log(`[bridgerator] notification failed: ${e.message}`); done(); });
}
