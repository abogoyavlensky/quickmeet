// The interface's language: English, or Russian for a browser whose first
// language is Russian, unless a signed-in person pinned one in Settings.
//
// The English sentences are the keys: the markup keeps its English text
// and marks it (`data-i18n`, and `data-i18n-placeholder`, `-title`,
// `-aria-label` for attributes), and scripts wrap a literal in `t('...')`.
// RU holds the Russian for each key; a key it lacks stays English.
// `lgx i18n-check` lists the keys RU is missing (scripts/check-i18n.mjs),
// so a literal must reach `t` as a literal, never through a variable.
//
// The account holds the choice (/api/me, `language`). This device keeps a
// copy, so a page can be drawn in the right language before /api/me
// answers. Every page writes /api/me's answer into it (`rememberLanguage`)
// and clears it on a 401, so a guest always follows the browser.

const LANGUAGE_KEY = 'quickmeet.lang';

// Storage can be refused (some private modes); the browser decides then.
const languageStore = {
  get() { try { return localStorage.getItem(LANGUAGE_KEY); } catch (e) { return null; } },
  set(value) { try { localStorage.setItem(LANGUAGE_KEY, value); } catch (e) { /* not remembered */ } },
  remove() { try { localStorage.removeItem(LANGUAGE_KEY); } catch (e) { /* not remembered */ } },
};

// The first preferred language only, the one navigator.language reports,
// so the pages and the service worker (sw.js) decide the same way.
const autoLanguage = () => (/^ru\b/i.test(navigator.language || '') ? 'ru' : 'en');
// 'auto', 'en' or 'ru': the account's choice as last seen here.
const pinnedLanguage = () => {
  const value = languageStore.get();
  return value === 'en' || value === 'ru' ? value : 'auto';
};
const lang = () => (pinnedLanguage() === 'auto' ? autoLanguage() : pinnedLanguage());
// For dates: the browser's own format while following it, else the
// pinned language's.
const localeOf = () => (pinnedLanguage() === 'auto' ? undefined : lang());

// Formal «вы»; buttons short, as in English.
const RU = {
  "History": "История",
  "Settings": "Настройки",
  "Sign out": "Выйти",
  "Talk to people without the meeting.": "Говорите с людьми без совещаний.",
  "A video call between two people. Start one, send the link, talk.": "Видеозвонок на двоих. Начните звонок, отправьте ссылку и говорите.",
  "Sign up": "Регистрация",
  "Sign in": "Войти",
  "Starting a call takes an account. Joining one takes only the link.": "Чтобы начать звонок, нужна учётная запись. Чтобы присоединиться, достаточно ссылки.",
  "Turn on": "Включить",
  "Not now": "Не сейчас",
  "New call": "Новый звонок",
  "Nobody to call yet. Start a call and send its link; the link stays here for next time.": "Пока звонить некому. Начните звонок и отправьте ссылку: она останется здесь для следующего раза.",
  "← Newer": "← Новее",
  "Older →": "Старше →",
  "Signed in as": "Вы вошли как",
  "Let people ring you on this device.": "Разрешите звонить вам на это устройство.",
  "To be rung on this iPhone, add quickmeet to your home screen (Share, then Add to Home Screen) and open it from there.": "Чтобы получать звонки на этом iPhone, добавьте quickmeet на экран «Домой» (Поделиться, затем «На экран „Домой“») и открывайте его оттуда.",
  "The name must be at most 64 characters.": "Имя должно быть не длиннее 64 символов.",
  "Too many attempts. Try again later.": "Слишком много попыток. Попробуйте позже.",
  "Something went wrong ({status}).": "Что-то пошло не так ({status}).",
  "in a call": "идёт звонок",
  "1 waiting": "1 ждёт",
  "Room {id}": "Комната {id}",
  "Copy link": "Скопировать ссылку",
  "Rename": "Переименовать",
  "Who is this call with?": "С кем этот звонок?",
  "Delete": "Удалить",
  "Delete this call? Its link will stop working.": "Удалить этот звонок? Его ссылка перестанет работать.",
  "Sign in · quickmeet": "Вход · quickmeet",
  "Sign in to start a call.": "Войдите, чтобы начать звонок.",
  "Email": "Почта",
  "Password": "Пароль",
  "No account yet?": "Ещё нет учётной записи?",
  "Invalid email or password.": "Неверный адрес или пароль.",
  "This address is not allowed on this instance.": "Этот адрес не допущен на этот сервер.",
  "Sign up · quickmeet": "Регистрация · quickmeet",
  "An account lets you start calls. Joining one takes only the link.": "Учётная запись позволяет начинать звонки. Чтобы присоединиться, достаточно ссылки.",
  "Have an account?": "Уже есть учётная запись?",
  "An account with this email already exists. Sign in instead.": "Учётная запись с этим адресом уже есть. Войдите в неё.",
  "Enter a valid email address.": "Введите правильный адрес почты.",
  "The password must be at least 8 characters.": "Пароль должен быть не короче 8 символов.",
  "The password must be at most 72 bytes.": "Пароль должен быть не длиннее 72 байт.",
  "Settings · quickmeet": "Настройки · quickmeet",
  "Your name": "Ваше имя",
  "Shown to the other person in a call.": "Его видит собеседник в звонке.",
  "Save name": "Сохранить имя",
  "Name saved.": "Имя сохранено.",
  "Notifications": "Уведомления",
  "When someone rings you from a call, this device shows it.": "Когда вам звонят из звонка, это устройство покажет уведомление.",
  "Back": "Назад",
  "This browser cannot receive rings.": "Этот браузер не может принимать звонки.",
  "Notifications are blocked for this site in the browser's settings.": "Уведомления для этого сайта запрещены в настройках браузера.",
  "Stop ringing this device": "Не звонить на это устройство",
  "Let people ring me on this device": "Звонить мне на это устройство",
  "Enter a name.": "Введите имя.",
  "Language": "Язык",
  "Language of the interface": "Язык интерфейса",
  "Auto (browser)": "Авто (как в браузере)",
  "Auto follows this browser's language.": "«Авто» следует языку этого браузера.",
  "History · quickmeet": "История · quickmeet",
  "Your calls, newest first.": "Ваши звонки, сначала новые.",
  "With": "С кем",
  "When": "Когда",
  "Duration": "Длительность",
  "No calls yet. They appear here once you have talked to someone.": "Звонков пока нет. Они появятся здесь, когда вы с кем-нибудь поговорите.",
  "in progress": "идёт",
  "nobody": "никто",
  "Could not load history ({status}).": "Не удалось загрузить историю ({status}).",
  "waiting for the other side…": "ждём собеседника…",
  "Camera": "Камера",
  "Microphone": "Микрофон",
  "This link does not exist.": "Такой ссылки нет.",
  "The call it led to was deleted, or the address is mistyped.": "Звонок, на который она вела, удалён, или в адресе опечатка.",
  "Start a new call": "Начать новый звонок",
  "Camera is off": "Камера выключена",
  "Join call": "Присоединиться",
  "Tap to enable sound": "Нажмите, чтобы включить звук",
  "This call already has two people in it.": "В этом звонке уже два человека.",
  "Waiting for the other person.": "Ждём собеседника.",
  "Could not ring.": "Не удалось позвонить.",
  "Leave": "Выйти из звонка",
  "Leave full screen": "Выйти из полноэкранного режима",
  "Full screen": "Во весь экран",
  "No camera found: joining with audio only.": "Камера не найдена: вы присоединитесь только со звуком.",
  "No microphone found: joining without sound.": "Микрофон не найден: вы присоединитесь без звука.",
  "No camera or microphone: you will only see and hear.": "Нет камеры и микрофона: вы будете только видеть и слышать.",
  "Camera {n}": "Камера {n}",
  "Microphone {n}": "Микрофон {n}",
  "Could not switch camera.": "Не удалось переключить камеру.",
  "Could not switch microphone.": "Не удалось переключить микрофон.",
  "Flip camera": "Перевернуть камеру",
  "Switch camera": "Сменить камеру",
  "Nobody has joined yet.": "Пока никого нет.",
  "{name} is already here.": "{name} уже здесь.",
  "Background blur is not available here.": "Размытие фона здесь недоступно.",
  "Loading blur…": "Загружаем размытие…",
  "Stop blurring": "Убрать размытие",
  "Blur background": "Размыть фон",
  "Rung": "Звоним",
  "Ring {name}": "Позвонить: {name}",
  "Ring them": "Позвонить им",
  "You are sharing your screen.": "Вы показываете свой экран.",
  "Screen sharing is not available here.": "Показ экрана здесь недоступен.",
  "Stop sharing": "Остановить показ",
  "Share screen": "Показать экран",
  "Mute": "Выключить микрофон",
  "Unmute": "Включить микрофон",
  "Stop video": "Выключить камеру",
  "Start video": "Включить камеру",
  "the other side left": "собеседник вышел",
  "Reconnecting…": "Переподключаемся…",
  "Connection lost. Join again.": "Связь потеряна. Присоединитесь снова.",
  "Copied": "Скопировано",
  "Could not reach the server ({status}).": "Не удалось связаться с сервером ({status}).",
  "Could not turn ringing on ({status}).": "Не удалось включить звонки ({status}).",
  "Notifications are not allowed for this site.": "Уведомления для этого сайта не разрешены.",
};

// The text for `key` in the current language; `{name}` in it is replaced
// from `vars`.
function t(key, vars) {
  let text = (lang() === 'ru' && RU[key]) || key;
  if (vars) text = text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
  return text;
}

// Translates every marked element. An empty mark takes the English it
// finds as its key and keeps it, so a second pass (the language changed
// after load) reads the key, never the Russian the first one wrote.
const TRANSLATED_ATTRIBUTES = ['placeholder', 'title', 'aria-label'];
function applyLanguage() {
  document.documentElement.lang = lang();
  for (const el of document.querySelectorAll('[data-i18n]')) {
    if (!el.dataset.i18n) el.dataset.i18n = el.textContent.trim();
    el.textContent = t(el.dataset.i18n);
  }
  for (const attribute of TRANSLATED_ATTRIBUTES) {
    const mark = 'data-i18n-' + attribute;
    for (const el of document.querySelectorAll(`[${mark}]`)) {
      if (!el.getAttribute(mark)) el.setAttribute(mark, el.getAttribute(attribute) || '');
      el.setAttribute(attribute, t(el.getAttribute(mark)));
    }
  }
}

// The account's choice, as /api/me gave it ('auto', 'en', 'ru'), or null
// for nobody signed in. Redraws the marked text and answers true when the
// language changed, so the page can redraw what its scripts wrote.
function rememberLanguage(value) {
  const before = lang();
  if (value) languageStore.set(value);
  else languageStore.remove();
  if (lang() === before) return false;
  applyLanguage();
  return true;
}

document.addEventListener('DOMContentLoaded', applyLanguage);
// The language is known before the page is: say it at once.
document.documentElement.lang = lang();
