// ---------- Локализация интерфейса ----------
// Полный перевод каждой строки во всём приложении (тысячи мест — чаты,
// звонки, админ-панель, всплывающие сообщения) — отдельная большая задача.
// Сейчас переведена основная "рамка" интерфейса: нижняя панель, заголовки
// разделов, экран входа, список настроек и подстраницы устройств/языка —
// то, что видно постоянно и сразу. Остальные экраны и сообщения по-прежнему
// на русском и будут переводиться постепенно.
//
// Как это работает:
// - I18N[lang][key] — сам словарь.
// - t(key) — вернуть перевод под текущий язык (или сам key, если перевода нет —
//   так отсутствие строки в словаре не ломает интерфейс, просто виден ключ).
// - translateStaticDom() — проходит по всем [data-i18n]/[data-i18n-placeholder]
//   элементам и подставляет текущий перевод. Вызывается один раз при
//   загрузке и заново при каждой смене языка.
// - applyLanguagePref(lang) — переключить язык: применить, закэшировать в
//   localStorage (для мгновенной отрисовки на следующей загрузке ДО ответа
//   сервера — так же, как currentThemePref в app.js) и обновить DOM.

const I18N = {
  ru: {
    nav_chats: 'Чаты', nav_calls: 'Звонки', nav_settings: 'Настройки',
    header_calls: 'Звонки', header_settings: 'Настройки', header_admin: '🛡 Админ-панель',

    auth_tab_login: 'Войти', auth_tab_register: 'Регистрация', auth_tab_qr: 'По QR-коду',
    auth_username_ph: 'Логин', auth_password_ph: 'Пароль', auth_login_btn: 'Войти',
    auth_displayname_ph: 'Ваше имя', auth_register_password_ph: 'Пароль (мин. 4 символа)',
    auth_register_btn: 'Зарегистрироваться',
    auth_qr_hint: 'Отсканируйте код камерой телефона, на котором вы уже вошли в Asteria, либо в этом устройстве откройте Настройки → Устройства → «Подтвердить вход по коду» и введите код ниже.',

    auth_brand: 'Asteria',
    auth_action_login: 'Войти', auth_action_register: 'Зарегистрироваться',
    auth_next_btn: 'Далее',
    auth_login_username_prompt: 'Введите логин',
    auth_login_password_prompt: 'Введите пароль',
    auth_reg_username_prompt: 'Придумайте логин',
    auth_reg_password_prompt: 'Придумайте пароль',
    auth_reg_name_label: 'Укажите имя',
    auth_reg_bio_label: 'Добавьте описание',
    auth_reg_bio_ph: 'Немного о себе (необязательно)',
    auth_err_enter_username: 'Введите логин',
    auth_err_user_not_found: 'Пользователь с таким логином не найден',
    auth_err_username_taken: 'Такой логин уже используется',
    auth_err_password_short: 'Пароль должен быть не короче 4 символов',
    auth_err_enter_name: 'Укажите имя',

    settings_change_photo: 'Изменить фотографию',
    settings_premium: 'Asteria Premium',
    settings_my_profile: 'Мой профиль',
    settings_wallet: 'Кошелёк',
    settings_favorites: 'Избранное',
    settings_recent_calls: 'Недавние звонки',
    settings_devices: 'Устройства',
    settings_folders: 'Папки с чатами',
    settings_notifications: 'Уведомления и звуки',
    settings_privacy: 'Конфиденциальность',
    settings_storage: 'Данные и память',
    settings_appearance: 'Оформление',
    settings_powersaving: 'Энергосбережение',
    settings_language: 'Язык',
    settings_admin_panel: 'Админ-панель',
    settings_logout: 'Выйти из аккаунта',

    lang_ru: 'Русский', lang_en: 'English',
    lang_footnote: 'Переведена основная часть интерфейса; отдельные экраны и сообщения пока на русском.',

    devices_this_device: 'Это устройство',
    devices_other_sessions: 'Другие сеансы',
    devices_revoke_others: 'Завершить все другие сеансы',
    devices_confirm_by_code: '📷 Подтвердить вход по коду',
  },
  en: {
    nav_chats: 'Chats', nav_calls: 'Calls', nav_settings: 'Settings',
    header_calls: 'Calls', header_settings: 'Settings', header_admin: '🛡 Admin panel',

    auth_tab_login: 'Log in', auth_tab_register: 'Sign up', auth_tab_qr: 'QR code',
    auth_username_ph: 'Username', auth_password_ph: 'Password', auth_login_btn: 'Log in',
    auth_displayname_ph: 'Your name', auth_register_password_ph: 'Password (4+ characters)',
    auth_register_btn: 'Sign up',
    auth_qr_hint: 'Scan this code with the camera on a phone where you\u2019re already signed in to Asteria, or on that device open Settings → Devices → "Confirm sign-in by code" and enter the code below.',

    auth_brand: 'Asteria',
    auth_action_login: 'Log in', auth_action_register: 'Sign up',
    auth_next_btn: 'Next',
    auth_login_username_prompt: 'Enter your username',
    auth_login_password_prompt: 'Enter your password',
    auth_reg_username_prompt: 'Choose a username',
    auth_reg_password_prompt: 'Choose a password',
    auth_reg_name_label: 'Enter your name',
    auth_reg_bio_label: 'Add a description',
    auth_reg_bio_ph: 'A little about you (optional)',
    auth_err_enter_username: 'Enter a username',
    auth_err_user_not_found: 'No user found with this username',
    auth_err_username_taken: 'This username is already taken',
    auth_err_password_short: 'Password must be at least 4 characters',
    auth_err_enter_name: 'Enter your name',

    settings_change_photo: 'Change photo',
    settings_premium: 'Asteria Premium',
    settings_my_profile: 'My profile',
    settings_wallet: 'Wallet',
    settings_favorites: 'Favorites',
    settings_recent_calls: 'Recent calls',
    settings_devices: 'Devices',
    settings_folders: 'Chat folders',
    settings_notifications: 'Notifications and sounds',
    settings_privacy: 'Privacy',
    settings_storage: 'Data and storage',
    settings_appearance: 'Appearance',
    settings_powersaving: 'Power saving',
    settings_language: 'Language',
    settings_admin_panel: 'Admin panel',
    settings_logout: 'Log out',

    lang_ru: 'Русский', lang_en: 'English',
    lang_footnote: 'The main interface is translated; some screens and messages are still in Russian.',

    devices_this_device: 'This device',
    devices_other_sessions: 'Other sessions',
    devices_revoke_others: 'Log out of all other sessions',
    devices_confirm_by_code: '📷 Confirm sign-in by code',
  },
};

const LANGUAGE_STORAGE_KEY = 'asteria_language_pref';
let currentLanguagePref = 'ru';

function t(key) {
  const dict = I18N[currentLanguagePref] || I18N.ru;
  return (dict && dict[key]) || (I18N.ru[key]) || key;
}

function translateStaticDom() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder));
  });
  document.documentElement.lang = currentLanguagePref;
}

function applyLanguagePref(lang) {
  currentLanguagePref = (lang === 'en') ? 'en' : 'ru';
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, currentLanguagePref); } catch (e) { /* localStorage недоступен — просто не кэшируем */ }
  translateStaticDom();
  if (typeof highlightActiveLanguageRadio === 'function') highlightActiveLanguageRadio();
}

// Применяем как можно раньше — до логина, до ответа сервера (см. ту же
// логику для темы оформления в app.js).
try { applyLanguagePref(localStorage.getItem(LANGUAGE_STORAGE_KEY) || 'ru'); } catch (e) { applyLanguagePref('ru'); }
