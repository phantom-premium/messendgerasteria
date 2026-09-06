// ---------------------------------------------------------------------------
// Liquid toggle — дословный перенос интеракции из cross-browser-liquid-toggle
// -drag-tap (jh3y, CodePen: https://codepen.io/jh3y/pen/bNVWoBW), включая
// GSAP + Draggable (та же анимация "bounce"-таймлайном, та же формула
// протяжки), только:
//   1) вместо одного захардкоженного `.liquid-toggle` на странице —
//      апгрейдится КАЖДЫЙ <input type="checkbox"> внутри .checkbox-row
//      (их несколько в разных местах приложения);
//   2) вместо Tweakpane-панели настроек — те же значения по умолчанию
//      (bounce/hue/delta/bubble/mapped/deviation/alpha), просто прописаны
//      один раз в коде вместо GUI-виджетов;
//   3) настоящий <input type="checkbox"> остаётся в DOM (спрятан через
//      .sr-only, но не удалён) — это значит, что весь остальной код
//      приложения, который читает/пишет .checked и слушает 'change',
//      продолжает работать без единой правки. Кнопка .liquid-toggle
//      становится основным интерактивным элементом (как у автора), а
//      обратная синхронизация в checkbox идёт через перехват свойства
//      .checked (Object.defineProperty) — так учитываются вообще ЛЮБЫЕ
//      программные изменения .checked откуда угодно в коде, а не только
//      те места, которые мы бы стали руками искать и переписывать.
// ---------------------------------------------------------------------------
import gsap from 'https://esm.sh/gsap@3.13.0';
import Draggable from 'https://esm.sh/gsap@3.13.0/Draggable';

gsap.registerPlugin(Draggable);

// Значения по умолчанию из config автора (то, что в демо крутится через
// Tweakpane) — здесь просто зафиксированы, без панели управления.
// deviation (радиус блюра goo-фильтра) уменьшен вдвое пропорционально
// размеру тумблера (см. --width/--height в style.css: 70×30 вместо
// авторских 140×60) — иначе на меньшем размере блюр "размазывал" бы
// бегунок сильнее, чем в оригинале, а затем ещё раз уменьшен вдвое (до 0.5) —
// именно этот блюр даёт характерный эффект "линзы/лупы" (перетекающее,
// оптически искажённое слияние бегунка с краем трека при перетаскивании);
// на маленьком тумблере в интерфейсе настроек он был заметнее и навязчивее,
// чем в исходном демо. alpha (порог контраста после блюра, отвечает за то,
// насколько резко/размыто обрезается "перетёкшая" область) чуть увеличен —
// без этого при вдвое меньшем deviation форма бегунка на глаз становилась
// слегка рыхлой по контуру.
const CONFIG = {
  deviation: 0.5,
  alpha: 20,
  bounce: true,
  delta: true,
  bubble: true,
  mapped: false,
  debug: false,
};

function applyGlobalConfig() {
  // Общий для ВСЕХ тумблеров SVG-фильтр #goo — как и у автора, параметры
  // блюра задаются JS поверх статичной разметки фильтра в index.html.
  gsap.set('#goo feGaussianBlur', { attr: { stdDeviation: CONFIG.deviation } });
  gsap.set('#goo feColorMatrix', {
    attr: { values: `1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 ${CONFIG.alpha} -10` },
  });
  // ВАЖНО: у автора тут же стоит document.documentElement.dataset.theme =
  // config.theme — но в этом приложении атрибут data-theme на <html> уже
  // занят под ЕГО СОБСТВЕННУЮ систему тем (светлая/тёмная/полночь/закат/…),
  // так что эту строку из оригинала сюда переносить нельзя — она бы затирала
  // реальную тему приложения. Сам тумблер от data-theme никак не зависит
  // (это влияло только на color-scheme в демо), так что просто не трогаем.
  document.documentElement.dataset.mapped = CONFIG.mapped;
  document.documentElement.dataset.delta = CONFIG.delta;
  document.documentElement.dataset.debug = CONFIG.debug;
  document.documentElement.dataset.bounce = CONFIG.bounce;
}

// Разметка — 1:1 со структурой автора (индикатор → knockout+mask →
// indicator__liquid/wrapper/liquids/liquid__track/shadow/cover), включая
// debug-копии слоёв (они невидимы по умолчанию, см. style.css). Не перенесены
// только иллюстративная стрелка "tap and drag" и ссылка на автора — это
// декорации конкретно демо-страницы CodePen, не часть самого тумблера.
const LIQUID_TOGGLE_INNER_HTML = `
  <div class="debug debug--knockout">
    <div class="knockout knockout--debug">
      <div class="indicator indicator--masked"><div class="mask"></div></div>
    </div>
  </div>
  <div class="knockout">
    <div class="indicator indicator--masked"><div class="mask"></div></div>
  </div>
  <div class="debug debug--indicator">
    <div class="indicator__liquid indicator__liquid--debug">
      <div class="shadow"></div>
      <div class="wrapper"><div class="liquids"><div class="liquid__shadow"></div><div class="liquid__track"></div></div></div>
      <div class="cover"></div>
    </div>
  </div>
  <div class="indicator__liquid">
    <div class="shadow"></div>
    <div class="wrapper"><div class="liquids"><div class="liquid__shadow"></div><div class="liquid__track"></div></div></div>
    <div class="cover"></div>
  </div>`;

function setupInteraction(toggle, checkbox) {
  // Единая точка фиксации нового состояния: обновляет aria-pressed, реальный
  // checkbox (через нативный сеттер, не наш перехваченный — см. ниже) и
  // рассылает input/change, чтобы остальной код приложения увидел изменение
  // ровно так же, как если бы кликнули по обычному чекбоксу.
  const nativeCheckedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
  const commit = (pressed) => {
    toggle.setAttribute('aria-pressed', String(pressed));
    if (checkbox.checked !== pressed) {
      nativeCheckedSetter.call(checkbox, pressed);
      checkbox.dispatchEvent(new Event('input', { bubbles: true }));
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  // Ровно та же таймлайн-анимация тапа/клика, что у автора: сперва "вспухает"
  // (bubble), с задержкой едет через весь трек, потом опадает обратно.
  const toggleState = async () => {
    toggle.dataset.pressed = true;
    if (CONFIG.bubble) toggle.dataset.active = true;
    await Promise.allSettled(
      !CONFIG.bounce ? toggle.getAnimations({ subtree: true }).map((a) => a.finished) : []
    );
    const pressed = toggle.matches('[aria-pressed=true]');
    gsap.timeline({
      onComplete: () => {
        gsap.delayedCall(0.05, () => {
          toggle.dataset.active = false;
          toggle.dataset.pressed = false;
          commit(!pressed);
        });
      },
    }).to(toggle, {
      '--complete': pressed ? 0 : 100,
      duration: 0.12,
      delay: CONFIG.bounce && CONFIG.bubble ? 0.18 : 0,
    });
  };

  // Протяжка — тоже дословно как у автора, просто trigger указывает на ЭТОТ
  // конкретный toggle (у автора было `handle: '.liquid-toggle'` глобально
  // по селектору, что годится только для единственного инстанса на странице).
  const proxy = document.createElement('div');
  Draggable.create(proxy, {
    allowContextMenu: true,
    trigger: toggle,
    onDragStart: function () {
      const toggleBounds = toggle.getBoundingClientRect();
      const pressed = toggle.matches('[aria-pressed=true]');
      this.dragBounds = pressed
        ? toggleBounds.left - this.pointerX
        : toggleBounds.left + toggleBounds.width - this.pointerX;
      toggle.dataset.active = true;
    },
    onDrag: function () {
      const pressed = toggle.matches('[aria-pressed=true]');
      const dragged = this.x - this.startX;
      const complete = gsap.utils.clamp(
        0, 100,
        pressed
          ? gsap.utils.mapRange(this.dragBounds, 0, 0, 100, dragged)
          : gsap.utils.mapRange(0, this.dragBounds, 0, 100, dragged)
      );
      this.complete = complete;
      gsap.set(toggle, { '--complete': complete, '--delta': Math.min(Math.abs(this.deltaX), 12) });
    },
    onDragEnd: function () {
      gsap.fromTo(toggle, { '--complete': this.complete }, {
        '--complete': this.complete >= 50 ? 100 : 0,
        duration: 0.15,
        onComplete: () => {
          gsap.delayedCall(0.05, () => {
            toggle.dataset.active = false;
            commit(this.complete >= 50);
          });
        },
      });
    },
    onPress: function () {
      this.__pressTime = Date.now();
      toggle.dataset.active = 'true';
      toggle.dataset.pressed = 'true';
    },
    onRelease: function () {
      this.__releaseTime = Date.now();
      gsap.set(toggle, { '--delta': 0 });
      if (this.__releaseTime - this.__pressTime <= 150) {
        toggleState();
        return;
      }
      if (!this.isDragging) {
        toggle.dataset.active = 'false';
        toggle.dataset.pressed = 'false';
      }
    },
  });

  toggle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') toggleState();
    if (e.key === ' ') e.preventDefault(); // не скроллить страницу пробелом
  });
  toggle.addEventListener('keyup', (e) => {
    if (e.key === ' ') toggleState();
  });

  return { commit };
}

function upgradeLiquidToggle(checkbox) {
  if (!checkbox || checkbox.dataset.ltUpgraded) return;
  checkbox.dataset.ltUpgraded = '1';

  // Настоящий чекбокс остаётся полностью рабочим для остального кода
  // приложения, просто визуально прячем его и убираем из таб-порядка —
  // фокус/клавиатуру теперь обслуживает сама .liquid-toggle кнопка.
  checkbox.classList.add('sr-only');
  checkbox.tabIndex = -1;

  const label = checkbox.closest('.checkbox-row');
  const labelText = (label && label.querySelector('.cr-label') || label)?.textContent?.trim();

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'liquid-toggle';
  toggle.setAttribute('aria-label', labelText || 'toggle');
  toggle.setAttribute('aria-pressed', checkbox.checked ? 'true' : 'false');
  toggle.style.setProperty('--complete', checkbox.checked ? 100 : 0);
  toggle.innerHTML = LIQUID_TOGGLE_INNER_HTML;
  checkbox.insertAdjacentElement('afterend', toggle);

  const { commit } = setupInteraction(toggle, checkbox);

  // Перехватываем .checked — и клики по visualless-чекбоксу (label всё ещё
  // прокликивает его — если по label кликнули мимо самой кнопки, checkbox
  // всё равно переключится нативно), и программные присваивания из
  // остального кода приложения (загрузка настроек с сервера, откат Premium-
  // гейта и т.д.) сразу отражаются на визуале кнопки.
  const nativeDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
  Object.defineProperty(checkbox, 'checked', {
    configurable: true,
    get() { return nativeDescriptor.get.call(checkbox); },
    set(value) {
      nativeDescriptor.set.call(checkbox, value);
      toggle.setAttribute('aria-pressed', value ? 'true' : 'false');
      gsap.set(toggle, { '--complete': value ? 100 : 0 });
    },
  });
  // Обычный клик прямо по label (мимо самой кнопки, но всё ещё внутри
  // .checkbox-row) — нативное поведение label уже переключает спрятанный
  // checkbox; ловим его 'change' и синхронизируем aria-pressed на кнопке.
  checkbox.addEventListener('change', () => {
    toggle.setAttribute('aria-pressed', checkbox.checked ? 'true' : 'false');
    gsap.set(toggle, { '--complete': checkbox.checked ? 100 : 0 });
  });
}

function upgradeAllIn(root) {
  root.querySelectorAll('.checkbox-row input[type="checkbox"]:not([data-lt-upgraded])').forEach(upgradeLiquidToggle);
}

function init() {
  applyGlobalConfig();
  upgradeAllIn(document);
  // .checkbox-row в модалках/шторках рендерится динамически (например,
  // "Разрешить групповые звонки" при редактировании канала) — следим за
  // всем DOM и апгрейдим новые чекбоксы по мере появления, а не дописываем
  // вызов в каждое место рендера по отдельности.
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches && node.matches('.checkbox-row input[type="checkbox"]')) upgradeLiquidToggle(node);
        else if (node.querySelectorAll) upgradeAllIn(node);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
