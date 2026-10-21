// LOGIC: see critical-logic/bridge.md ("Extra tools", screen). `screen`: the list of open windows, a
// screenshot of the whole screen / one monitor / one window, and text recognition (Windows' built-in
// OCR, the languages installed on the PC) of the screen, a window or an image file. Everything runs in
// screen.ps1 (user32 + System.Drawing + Windows.Media.Ocr); no extra programs, nothing downloaded.
// Every screenshot shows a notification on the PC ("the AI took a screenshot") unless the person turned
// that off (screen.notify). Screenshots can be switched off completely (screen.enabled).
// A locked screen / sign-in screen / UAC prompt can't be captured: an honest error, never a black picture.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showNotice } from './notice.mjs';
import { fail, guard, freeName, needAction, str, int, psJson, ToolError } from './tool-lib.mjs';

const PS = fileURLToPath(new URL('./screen.ps1', import.meta.url));
export const MAX_SIDE = 1600;                 // long side of the picture sent to the AI
export const MAX_BYTES = 900 * 1024;          // JPEG bytes (base64 ≈ 1.2 MB)
const MAX_B64 = Math.ceil(MAX_BYTES / 3) * 4 + 4;
const MAX_TEXT = 60000;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tif', '.tiff']);
const ACTIONS = ['windows', 'capture', 'ocr'];

export const defs = [{
  name: 'screen',
  title: 'Screen and text recognition',
  description: 'Screenshots and text recognition on this PC. action "windows": open windows (id, title, program). '
    + '"capture": a picture of the whole screen, one monitor (monitor) or one window (window = part of its title, or window_id); save_to also keeps a full-size copy. '
    + '"ocr": the text on the screen, a window or an image file (path), recognized by Windows (languages installed on the PC; language like "en-US"). '
    + 'The person sees a notification on the PC for each screenshot. A locked screen can\'t be captured.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ACTIONS },
      window: { type: 'string', maxLength: 200, description: 'Part of the window title (any case)' },
      window_id: { type: 'integer', minimum: 1, description: 'Window id from action "windows"' },
      monitor: { type: 'integer', minimum: 1, maximum: 16, description: 'Monitor number; without it: all monitors' },
      language: { type: 'string', maxLength: 20, description: 'OCR language tag, e.g. "en-US", "ru"' },
      path: { type: 'string', maxLength: 1000, description: 'Image file for ocr instead of the screen' },
      save_to: { type: 'string', maxLength: 1000, description: 'Full path of a .png or .jpg for a full-size copy (capture)' },
    },
  },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}];

export const settings = [
  { key: 'screen.enabled', default: true, widensWhen: true, label: { en: 'Screenshots and screen text recognition', ru: 'Снимки экрана и распознавание текста' }, hint: { en: 'The AI can take a picture of the screen or a window.', ru: 'ИИ может сделать снимок экрана или окна.' } },
  { key: 'screen.notify', default: true, widensWhen: false, label: { en: 'Notify me about every screenshot', ru: 'Уведомлять о каждом снимке экрана' }, hint: { en: 'A notification "the AI took a screenshot" appears on the PC.', ru: 'На ПК появляется уведомление «ИИ сделал снимок экрана».' } },
];
const DEFAULT = Object.fromEntries(settings.map((s) => [s.key, s.default]));
function setting(ctx, key) {
  if (ctx.extra?.value) return ctx.extra.value(ctx.cfg, key);
  const [g, k] = key.split('.');
  const v = ctx.cfg?.[g]?.[k];
  return typeof v === 'boolean' ? v : DEFAULT[key];
}

const clean = (s, n = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, n);
const run = (ctx, env, timeout = 60000) => psJson(ctx, { files: [PS], env, timeout });
const check = (r) => { if (!r || r.ok !== true) throw new ToolError(r?.code || 'PS_FAILED', MESSAGES[r?.code] || clean(r?.message, 300) || 'Windows could not do it.', HINTS[r?.code] || ''); return r; };
const MESSAGES = {
  SCREEN_LOCKED: 'The screen is locked (or the sign-in screen / a Windows security prompt is open), so no screenshot can be taken until the person unlocks the PC.',
};
const HINTS = {
  SCREEN_LOCKED: 'Ask the person to unlock the PC and try again.',
  NO_WINDOW: 'Call screen with action "windows" to see the open windows.',
  NO_MONITOR: 'Leave monitor out to capture all monitors.',
  NO_OCR_LANG: 'The person can add a language with text recognition in Windows Settings → Time & language → Language & region (Add a language).',
  BAD_LANG: 'Use one of the installed languages, or leave language out.',
  BAD_IMAGE: 'Use a PNG, JPEG, BMP, GIF or TIFF file.',
  IMAGE_TOO_LARGE: 'Use a smaller image or capture one window instead of all monitors.',
  EXISTS: 'Call again: a new free name is chosen.',
};

/** Part of a title → one window: exact title first, then the topmost window whose title contains it. */
export function pickWindow(list, query) {
  const q = clean(query).toLowerCase();
  if (!q) fail('BAD_ARGS', 'window must name a part of a window title.');
  const hits = list.filter((w) => String(w.title).toLowerCase().includes(q));
  if (!hits.length) {
    const titles = list.slice(0, 15).map((w) => `"${clean(w.title, 80)}"`).join(', ');
    fail('NO_WINDOW', `No open window has "${clean(query, 80)}" in its title.${titles ? ` Open windows: ${titles}.` : ''}`, HINTS.NO_WINDOW);
  }
  const exact = hits.find((w) => String(w.title).toLowerCase() === q);
  return { win: exact || hits[0], others: hits.length - 1 };
}

const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

// The capture runs in a second PowerShell: it checks the id still belongs to the same program.
const winEnv = (win) => ({ BRX_HWND: String(win.id), ...(Number.isInteger(win.pid) && win.pid > 0 ? { BRX_PID: String(win.pid) } : {}) });
async function target(ctx, args) {
  const windowQuery = str(args, 'window', { max: 200 });
  const windowId = args.window_id === undefined ? undefined : int(args, 'window_id', { min: 1, max: Number.MAX_SAFE_INTEGER });
  const monitor = int(args, 'monitor', { min: 1, max: 16, def: 0 });
  if ((windowQuery || windowId) && monitor) fail('BAD_ARGS', 'Use either window / window_id or monitor, not both.');
  if (windowId || windowQuery) {
    const r = check(await run(ctx, { BRX_ACTION: 'windows' }));
    const list = Array.isArray(r.windows) ? r.windows : [];
    if (windowId) {
      const win = list.find((w) => w.id === windowId);
      if (!win) fail('NO_WINDOW', 'That window is not open any more.', HINTS.NO_WINDOW);
      return { env: winEnv(win), what: 'window', win, others: 0 };
    }
    const { win, others } = pickWindow(list, windowQuery);
    return { env: winEnv(win), what: 'window', win, others };
  }
  return { env: monitor ? { BRX_MONITOR: String(monitor) } : {}, what: monitor ? 'monitor' : 'screen', monitor };
}

function saveTarget(ctx, p) {
  if (p === undefined) return undefined;
  const abs = guard(ctx, p, { write: true });
  if (!['.png', '.jpg', '.jpeg'].includes(path.extname(abs).toLowerCase())) fail('BAD_PATH', 'save_to must end with .png or .jpg.');
  if (!fs.existsSync(path.dirname(abs))) fail('BAD_PATH', `The folder "${path.dirname(abs)}" does not exist.`, 'Create the folder first or choose another one.');
  return freeName(abs);
}

function indicate(ctx, t, ocr) {
  if (!setting(ctx, 'screen.notify')) return;
  try {
    (ctx.notice ?? showNotice)({ kind: 'screenshot', what: t.what, monitor: t.monitor, title: t.win?.title, ocr }, ctx.log || (() => {}));
  } catch (e) { ctx.log?.(`[bridgerator] screenshot notice failed: ${e?.message || e}`); }
}

const describeTarget = (t) => (t.what === 'window' ? `window "${clean(t.win.title, 120)}"` : t.what === 'monitor' ? `monitor ${t.monitor}` : 'the whole screen');

function linesText(r) {
  let s = (Array.isArray(r.lines) ? r.lines : []).map((l) => clean(l, 2000)).join('\n');
  if (s.length > MAX_TEXT) s = `${s.slice(0, MAX_TEXT)}\n[… cut at ${MAX_TEXT} characters]`;
  return s;
}

export async function handle(name, args, ctx) {
  const action = needAction(args, ACTIONS);
  const lang = str(args, 'language', { max: 20 });
  if (lang && !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lang)) fail('BAD_ARGS', 'language must be a tag like "en-US" or "ru".');

  // OCR of an image file is not a screenshot: no screen setting, no notice — the folder rules apply.
  if (action === 'ocr' && args.path !== undefined) {
    const file = guard(ctx, str(args, 'path', { required: true, max: 1000 }));
    if (!IMAGE_EXT.has(path.extname(file).toLowerCase())) fail('BAD_IMAGE', 'This is not an image file.', HINTS.BAD_IMAGE);
    const st = fs.statSync(file);
    if (!st.isFile()) fail('BAD_PATH', 'path must be an image file, not a folder.');
    if (st.size > 50 * 1024 * 1024) fail('IMAGE_TOO_LARGE', 'The image is larger than 50 MB.', HINTS.IMAGE_TOO_LARGE);
    const r = check(await run(ctx, { BRX_ACTION: 'ocr', BRX_FILE: file, ...(lang ? { BRX_LANG: lang } : {}) }, 120000));
    const body = linesText(r);
    return { content: [{ type: 'text', text: `Text recognized in ${path.basename(file)} (${r.width}×${r.height}, language ${clean(r.language, 20)}):\n${body || '[no text found]'}` }] };
  }
  if (args.path !== undefined) fail('BAD_ARGS', 'path is only for action "ocr".');

  if (!setting(ctx, 'screen.enabled')) {
    fail('SCREEN_OFF', 'Screenshots are turned off on this PC.', 'The person can turn them on in the Bridgerator window (Settings), or you can ask with bridgerator_settings (screen.enabled); the person confirms it on the PC.');
  }

  if (action === 'windows') {
    const r = check(await run(ctx, { BRX_ACTION: 'windows' }));
    const windows = (Array.isArray(r.windows) ? r.windows : []).slice(0, 100).map((w) => ({ id: w.id, title: clean(w.title), program: clean(w.process, 60), ...(w.minimized ? { minimized: true } : {}) }));
    return { content: [{ type: 'text', text: JSON.stringify({ windows }, null, 2) }] };
  }

  if (action === 'ocr' && args.save_to !== undefined) fail('BAD_ARGS', 'save_to is only for action "capture".');
  const t = await target(ctx, args);
  const save = action === 'capture' ? saveTarget(ctx, args.save_to) : undefined;
  const env = { BRX_ACTION: action, ...t.env, ...(lang ? { BRX_LANG: lang } : {}), ...(save ? { BRX_SAVE: save } : {}),
    ...(action === 'capture' ? { BRX_IMAGE: '1', BRX_MAXSIDE: String(MAX_SIDE), BRX_MAXBYTES: String(MAX_BYTES) } : {}) };
  // The person is told about every picture taken (after the capture, so the notice is not in it) — also
  // when a later step failed (taken) or the run did not answer (it may have taken one).
  let raw;
  try { raw = await run(ctx, env, action === 'ocr' ? 120000 : 60000); } catch (e) { indicate(ctx, t, action === 'ocr'); throw e; }
  if (raw?.ok === true || raw?.taken === true) indicate(ctx, t, action === 'ocr');
  const r = check(raw);
  const notes = [
    ...(t.others ? [`${t.others} other window(s) also match "${clean(args.window, 80)}"; use window_id to pick another one.`] : []),
    ...(r.minimized ? ['The window is minimized: Windows may give an empty or old picture of it.'] : []),
  ];
  if (action === 'ocr') {
    const body = linesText(r);
    return { content: [{ type: 'text', text: `Text on ${describeTarget(t)} (${r.width}×${r.height}, language ${clean(r.language, 20)}):\n${body || '[no text found]'}${notes.length ? `\n\n${notes.join(' ')}` : ''}` }] };
  }
  if (typeof r.data !== 'string' || !r.data || r.data.length > MAX_B64 || !/^[A-Za-z0-9+/]+=*$/.test(r.data.slice(-64))) {
    fail('IMAGE_TOO_LARGE', 'The screenshot could not be made small enough to send.', HINTS.IMAGE_TOO_LARGE);
  }
  const head = `Screenshot of ${describeTarget(t)}: ${r.width}×${r.height}, sent as ${r.outWidth}×${r.outHeight} JPEG (${kb(r.bytes || r.data.length * 0.75)}).`;
  const saved = r.saved ? ` Full-size copy saved: ${r.saved}` : '';
  return { content: [{ type: 'text', text: `${head}${saved}${notes.length ? ` ${notes.join(' ')}` : ''}` }, { type: 'image', data: r.data, mimeType: 'image/jpeg' }] };
}
