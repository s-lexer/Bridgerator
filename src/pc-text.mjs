// The questions on the PC (toast / fallback window) in the PC's language (config.json `language`,
// en | ru — the same choice as the window). The bridge writes every question in English; this file
// turns the fixed texts (headers, buttons, fixed sentences, the "auto-deny in 2 min" line) into
// Russian just before they are shown. Commands, paths and names stay as they are.
// LOGIC: critical-logic/bridge.md ("Questions on the PC: language").

const RU = {
  // headers (confirm.mjs HEAD, bridge.mjs, automations.mjs)
  'ChatGPT wants to delete files': 'ChatGPT хочет удалить файлы',
  'ChatGPT wants to run a system command': 'ChatGPT хочет выполнить системную команду',
  'ChatGPT wants to change a file': 'ChatGPT хочет изменить файл',
  'ChatGPT wants to move or rename': 'ChatGPT хочет переместить или переименовать',
  'ChatGPT wants to run a command': 'ChatGPT хочет выполнить команду',
  'ChatGPT wants to install or update a program': 'ChatGPT хочет установить или обновить программу',
  'ChatGPT wants to schedule a script': 'ChatGPT хочет поставить сценарий на расписание',
  'ChatGPT wants to change a scheduled script': 'ChatGPT хочет изменить сценарий на расписании',
  'ChatGPT wants to do something your rules ask about': 'ChatGPT хочет сделать то, о чём просят спрашивать ваши правила',
  'ChatGPT asks to stop confirming actions on this PC. Allow?': 'ChatGPT просит больше не спрашивать подтверждений на этом ПК. Разрешить?',
  'Bridgerator settings file changed': 'Файл настроек Bridgerator изменён',
  'ChatGPT suggests Bridgerator settings': 'ChatGPT предлагает настройки Bridgerator',
  'ChatGPT wants to change Bridgerator settings': 'ChatGPT хочет изменить настройки Bridgerator',
  'ChatGPT scheduled a script on this PC': 'ChatGPT поставил сценарий на расписание на этом ПК',
  'Test notification': 'Пробное уведомление',
  // fixed sentences
  'After that, deletions and system commands run without asking you. Turn it back on any time: bridgerator.cmd confirm on': 'После этого удаление и системные команды выполняются без вопроса. Включить снова можно в любой момент: bridgerator.cmd confirm on',
  'Too many changes for a notification — review them in the Bridgerator window.': 'Слишком много изменений для уведомления — посмотрите их в окне Bridgerator.',
  'Every task in the Bridgerator queue will be removed.': 'Все задачи в очереди Bridgerator будут удалены.',
  'Bridgerator paused itself. Continue? No answer = it stays paused.': 'Bridgerator поставил себя на паузу. Продолжить? Нет ответа = пауза остаётся.',
  'This is how Bridgerator asks before risky actions. Nothing will run.': 'Так Bridgerator спрашивает перед рискованными действиями. Ничего не будет выполнено.',
  // buttons
  Allow: 'Разрешить', 'Allow 10 min': 'Разрешить на 10 мин', 'Allow always': 'Разрешать всегда', Deny: 'Запретить',
  Apply: 'Применить', Keep: 'Оставить', Cancel: 'Отмена', Clear: 'Очистить', Continue: 'Продолжить', 'Keep paused': 'Оставить паузу',
  Delete: 'Удалить', Show: 'Показать', 'Turn off': 'Выключить', 'Allow all': 'Разрешить всё', 'Review…': 'Просмотреть…',
};
// "auto-deny in 2 min": the word for what happens without an answer.
const AUTO_RU = { 'auto-deny': 'авто-запрет', 'auto-cancel': 'авто-отмена', 'auto-keep': 'авто-сохранение', closes: 'закроется' };
// What a changed confirm.ini would turn off (confirm.mjs weakerBy / LABEL).
const OFF_RU = {
  confirmations: 'подтверждения', 'your own patterns': 'ваши шаблоны',
  'confirmations for deletions': 'подтверждения удаления', 'confirmations for system commands': 'подтверждения системных команд',
  'confirmations for file changes': 'подтверждения изменения файлов', 'confirmations for moves and renames': 'подтверждения перемещений',
  'confirmations for commands': 'подтверждения команд', 'confirmations for installing programs': 'подтверждения установки программ',
  'confirmations for scheduled scripts': 'подтверждения сценариев на расписании',
};
const PLAN_VERB_RU = { move: 'переместить', write: 'записать', edit: 'изменить', create: 'создать', run: 'выполнить', do: 'выполнить' };
/** Russian plural: forms = [1 файл, 2 файла, 5 файлов] → the form for n. */
export function ruPlural(n, [one, few, many]) {
  const a = Math.abs(Math.trunc(n)) % 100, b = a % 10;
  return a >= 11 && a <= 14 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
}
// Plan card nouns (batch.mjs): after the verb ("переместить 1 файл", "выполнить 2 команды") and in the
// mixed list ("214 перемещений, 1 команда"). English singular/plural both map to one entry.
const PLAN_OBJ_RU = { file: ['файл', 'файла', 'файлов'], folder: ['папку', 'папки', 'папок'], command: ['команду', 'команды', 'команд'], action: ['действие', 'действия', 'действий'] };
const PLAN_LIST_RU = { move: ['перемещение', 'перемещения', 'перемещений'], write: ['запись', 'записи', 'записей'], edit: ['правка', 'правки', 'правок'], 'new folder': ['новая папка', 'новые папки', 'новых папок'], command: ['команда', 'команды', 'команд'] };
const planCount = (n, word, forms) => { const f = forms[word.replace(/s$/, '')]; return f ? `${n} ${ruPlural(Number(n), f)}` : null; };

// Settings change lines (settings-tool.mjs describe, "Label: value", joined by " · "): label and on/off in Russian.
const LINE_RU = {
  Confirmations: 'Подтверждения', 'No answer = Deny after': 'Нет ответа = запрет через', Folders: 'Папки', 'Read-only': 'Только чтение',
  'Excluded folders': 'Исключённые папки', 'Start with Windows': 'Запуск вместе с Windows', 'Usage stats': 'Статистика использования',
  'Local history': 'Локальная история', Theme: 'Тема', Language: 'Язык', 'Pop-up style': 'Вид уведомлений', 'Computer name': 'Имя компьютера',
  'Terminal (commands)': 'Терминал (команды)', Terminal: 'Терминал', 'Protect sensitive folders': 'Защищать важные папки', 'Recycle Bin instead of deleting': 'Корзина вместо удаления',
  'Keep the PC awake while ChatGPT works': 'Не давать ПК засыпать, пока ChatGPT работает', 'Ask before AI changes settings': 'Спрашивать перед изменением настроек ИИ',
  Access: 'Доступ', 'Snapshots and Undo': 'Снимки и отмена', 'Keep snapshots (days)': 'Хранить снимки (дней)', 'Snapshots up to (MB)': 'Снимки до (МБ)',
  'Snapshot files up to (MB)': 'Файлы в снимках до (МБ)', 'Pause on mass deletes / moves': 'Пауза при массовом удалении / перемещении', 'Mass-action limit per minute': 'Лимит массовых действий в минуту',
};
// "Confirm <confirm.mjs LABEL>".
const CONFIRM_RU = { deletions: 'удаление', 'system commands': 'системные команды', 'file changes': 'изменение файлов', 'moves and renames': 'перемещения и переименования', commands: 'команды', 'installing programs': 'установку программ', 'scheduled scripts': 'сценарии на расписании' };
const VALUE_RU = { on: 'вкл', off: 'выкл', unchanged: 'без изменений', 'all (except always-blocked)': 'все (кроме всегда закрытых)' };
/** Extra tools (extra-tools.mjs) add their own setting labels: { en: ru }. */
export const addRuLabels = (map) => Object.assign(LINE_RU, map);
const ruLine = (l) => {
  const m = /^(.+?): (.*)$/s.exec(l);
  if (!m) return null;
  const what = m[1].startsWith('Confirm ') && Object.hasOwn(CONFIRM_RU, m[1].slice(8)) && CONFIRM_RU[m[1].slice(8)];
  const label = Object.hasOwn(LINE_RU, m[1]) ? LINE_RU[m[1]] : what ? `Подтверждать ${what}` : null;
  return label && `${label}: ${Object.hasOwn(VALUE_RU, m[2]) ? VALUE_RU[m[2]] : m[1] === 'Folders' ? m[2].replace(/^only /, 'только ') : m[2]}`;
};
const ruLines = (t) => { const out = t.split(' · ').map(ruLine); return out.includes(null) ? null : out.join(' · '); };

/** One English text → Russian (unknown text stays English). */
export function ruText(t) {
  if (typeof t !== 'string' || !t) return t;
  if (Object.hasOwn(RU, t)) return RU[t];
  let m;
  if ((m = /^Turn off (.+)\?$/.exec(t))) return `Выключить: ${m[1].split(', ').map((x) => OFF_RU[x] || x).join(', ')}?`;
  if ((m = /^Apply: (.+)\?$/s.exec(t))) return `Применить: ${m[1]}?`;
  if ((m = /^ChatGPT wants to clear (\d+) tasks?$/.exec(t))) return `ChatGPT хочет удалить задачи из очереди: ${m[1]}`;
  if ((m = /^ChatGPT deleted or moved (\d+) files in a minute$/.exec(t))) return `ChatGPT удалил или переместил файлов за минуту: ${m[1]}`;
  if ((m = /^ChatGPT wants to delete (\d+) items? for good$/.exec(t))) return `ChatGPT хочет удалить безвозвратно: ${m[1]}`;
  if ((m = /^No Recycle Bin on that drive: (.*)$/s.exec(t))) return `На этом диске нет Корзины: ${m[1]}`;
  // Plan card (batch.mjs headline): "ChatGPT wants to move 214 files" / "… to do 220 actions (214 moves, 6 commands)".
  if ((m = /^ChatGPT wants to (move|write|edit|create|run|do) (\d+) ([a-z ]+?)( \((.+)\))?$/.exec(t))) {
    const head = planCount(m[2], m[3], PLAN_OBJ_RU);
    const list = m[5] ? m[5].split(', ').map((x) => { const p = /^(\d+) ([a-z ]+)$/.exec(x); return p && planCount(p[1], p[2], PLAN_LIST_RU); }) : [];
    if (head && !list.includes(null)) return `ChatGPT хочет ${PLAN_VERB_RU[m[1]]} ${head}${list.length ? ` (${list.join(', ')})` : ''}`;
  }
  return t;
}

/** The attribution line under a question: "PC-NAME · auto-deny in 2 min". */
export function attrLine(host, auto, secs, lang) {
  const ru = lang === 'ru';
  const when = secs >= 120 && secs % 60 === 0 ? `${secs / 60} ${ru ? 'мин' : 'min'}` : `${secs} ${ru ? 'с' : 's'}`;
  return `${host} · ${ru ? AUTO_RU[auto] || auto : auto} ${ru ? 'через' : 'in'} ${when}`;
}

/** A question as it is shown on a PC with language `lang` (head, text, button labels, auto word). */
export function localizeAsk(q, lang) {
  if (lang !== 'ru') return q;
  return {
    ...q,
    head: ruText(q.head),
    // Change lines only in the settings question (never in a command or path the AI wrote).
    text: q.head === 'ChatGPT wants to change Bridgerator settings' || q.head === 'ChatGPT suggests Bridgerator settings' ? ruLines(q.text) ?? ruText(q.text)
      : q.head === 'Bridgerator settings file changed' && /^Apply: (.+)\?$/s.test(q.text) ? `Применить: ${ruLines(q.text.slice(7, -1)) ?? q.text.slice(7, -1)}?` : ruText(q.text),
    buttons: (q.buttons || []).map(([k, label, kind]) => [k, ruText(label), kind]),
    auto: q.auto ? AUTO_RU[q.auto] || q.auto : q.auto,
  };
}
