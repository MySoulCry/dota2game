/*
  Monetization — реклама, донат и платная версия в одном месте.

  Сейчас всё выключено и ничего не требует: настройки берутся из js/config.js.
  Когда появятся рекламные/платёжные ссылки — проверь, что они не противоречат
  правилам провайдера и законодательству (для ЕС нужен баннер согласия на cookie).
*/
(function () {
  'use strict';

  const CFG = (window.APP_CONFIG && typeof window.APP_CONFIG === 'object') ? window.APP_CONFIG : {};
  const BRAND = CFG.brand || {};
  const ADS = CFG.ads || {};
  const SLOTS = ADS.slots || {};
  const YT = ADS.yandex || {};
  const PROVIDER = String(ADS.provider || 'none').toLowerCase();

  const PRO_KEY = 'dotaguess.pro';

  /* ---------- мелочи для всего сайта ---------- */

  const store = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    },
    set(key, value) {
      try {
        if (value === null || value === undefined || value === '') {
          window.localStorage.removeItem(key);
        } else {
          window.localStorage.setItem(key, value);
        }
      } catch (e) {
        /* режим инкогнито — просто не запоминаем */
      }
    }
  };

  let toastTimer = 0;

  function toast(message) {
    let node = document.getElementById('toast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'toast';
      node.className = 'toast';
      node.setAttribute('role', 'status');
      document.body.appendChild(node);
    }
    node.textContent = message;
    node.classList.add('is-visible');
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      node.classList.remove('is-visible');
    }, 3400);
  }

  window.UI = { toast: toast, store: store };

  /* ---------- платная версия (убрать рекламу) ---------- */

  let pro = store.get(PRO_KEY) === '1';

  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('pro') === '1') {
      pro = true;
      store.set(PRO_KEY, '1');
    }
    if (params.get('pro') === '0') {
      pro = false;
      store.set(PRO_KEY, null);
    }
  } catch (e) {
    /* старый браузер без URLSearchParams — не критично */
  }

  function isPro() {
    return pro;
  }

  function applyPro() {
    document.body.classList.toggle('is-pro', pro);
    const btn = document.getElementById('btn-pro');
    if (btn) {
      btn.textContent = pro ? 'Реклама отключена' : 'Убрать рекламу';
    }
    document.querySelectorAll('.ad-slot').forEach(function (slot) {
      slot.classList.toggle('is-pro', pro);
    });
  }

  /* ---------- рекламные блоки: Яндекс РСЯ (для РФ) и AdSense ---------- */

  let adsensePromise = null;
  let yandexPromise = null;
  const rendered = {};
  let bannerMounted = false;
  let gameOverMounted = false;

  function hasYandex() {
    return !!(ADS.enabled && (YT.banner || YT.gameOver));
  }

  function loadYandex() {
    if (window.Ya && window.Ya.Context && window.Ya.Context.AdvManager) {
      return Promise.resolve(true);
    }
    // очередь колбэков должна существовать до загрузки скрипта
    window.yaContextCb = window.yaContextCb || [];
    if (!hasYandex()) {
      return Promise.resolve(false);
    }
    if (yandexPromise) {
      return yandexPromise;
    }
    yandexPromise = new Promise(function (resolve) {
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://yandex.ru/ads/system/context.js';
      script.onload = function () { resolve(true); };
      script.onerror = function () { resolve(false); };
      document.head.appendChild(script);
    });
    return yandexPromise;
  }

  function renderYandex(container, blockId) {
    container.innerHTML = '';
    const holder = document.createElement('div');
    holder.id = 'yandex_rtb_' + blockId.replace(/[^\w-]/g, '_');
    container.appendChild(holder);

    loadYandex().then(function (ok) {
      if (!ok) {
        return;
      }
      window.yaContextCb = window.yaContextCb || [];
      window.yaContextCb.push(function () {
        try {
          window.Ya.Context.AdvManager.render({
            blockId: blockId,
            renderTo: holder.id,
            async: true
          });
        } catch (e) {
          /* блокировщик или сеть — остаётся пусто */
        }
      });
    });
  }

  function loadAdSense() {
    if (window.adsbygoogle) {
      return Promise.resolve(true);
    }
    if (!ADS.client) {
      return Promise.resolve(false);
    }
    if (adsensePromise) {
      return adsensePromise;
    }
    adsensePromise = new Promise(function (resolve) {
      const script = document.createElement('script');
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' +
        encodeURIComponent(ADS.client);
      script.onload = function () {
        resolve(true);
      };
      script.onerror = function () {
        resolve(false);
      };
      document.head.appendChild(script);
    });
    return adsensePromise;
  }

  function renderAdsense(container, slotId) {
    loadAdSense().then(function (ok) {
      if (!ok || !container.isConnected) {
        return;
      }
      const ins = document.createElement('ins');
      ins.className = 'adsbygoogle';
      ins.style.display = 'block';
      ins.setAttribute('data-ad-client', ADS.client);
      ins.setAttribute('data-ad-slot', slotId);
      ins.setAttribute('data-ad-format', 'auto');
      ins.setAttribute('data-full-width-responsive', 'true');
      container.appendChild(ins);
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch (e) {
        /* блокировщик рекламы — ничего страшного */
      }
    });
  }

  function placeholder(container) {
    const note = document.createElement('p');
    note.className = 'ad-slot__note';
    note.textContent = pro
      ? ''
      : (ADS.enabled
        ? 'Рекламный блок. Проверь настройки рекламы в js/config.js.'
        : 'Рекламный блок. Подключи Яндекс Рекламу (РСЯ) в js/config.js — и он появится здесь.');
    container.appendChild(note);
  }

  function renderSlot(container, place) {
    if (!container) {
      return;
    }
    container.innerHTML = '';

    if (pro) {
      return;
    }

    const blockId = YT[place];
    const slotId = SLOTS[place];

    if (PROVIDER === 'yandex') {
      if (!ADS.enabled || !blockId) {
        placeholder(container);
        return;
      }
      if (rendered[blockId]) {
        return;
      }
      rendered[blockId] = true;
      renderYandex(container, blockId);
      return;
    }

    if (PROVIDER === 'adsense') {
      if (!ADS.enabled || !ADS.client || !slotId) {
        placeholder(container);
        return;
      }
      if (rendered[slotId]) {
        return;
      }
      rendered[slotId] = true;
      renderAdsense(container, slotId);
      return;
    }

    placeholder(container);
  }

  // баннер под контентом монтируем сразу, блок на экране итогов — когда он
  // показан: рекламная сеть не любит контейнеры нулевого размера
  function mountAds() {
    if (bannerMounted) {
      return;
    }
    bannerMounted = true;
    renderSlot(document.getElementById('ad-banner-body'), 'banner');
  }

  function mountGameOver() {
    if (gameOverMounted) {
      return;
    }
    gameOverMounted = true;
    renderSlot(document.getElementById('ad-over-body'), 'gameOver');
  }

  /* ---------- rewarded: «посмотри рекламу — продолжим полёт» ---------- */

  let rewardTimer = 0;

  function closeRewarded() {
    const modal = document.getElementById('rewarded');
    if (modal) {
      modal.classList.remove('is-visible');
    }
    window.clearInterval(rewardTimer);
    rewardTimer = 0;
  }

  function showRewarded(onReward) {
    if (typeof onReward !== 'function') {
      return;
    }

    // Настоящий провайдер награды: открываем его страницу и засчитываем награду.
    if (ADS.rewardedUrl) {
      window.open(ADS.rewardedUrl, '_blank', 'noopener');
      onReward();
      return;
    }

    const modal = document.getElementById('rewarded');
    const countEl = document.getElementById('rewarded-count');
    if (!modal || !countEl) {
      onReward();
      return;
    }

    let left = Math.max(1, Number(ADS.rewardedSeconds) || 5);
    countEl.textContent = String(left);
    modal.classList.add('is-visible');
    window.clearInterval(rewardTimer);

    rewardTimer = window.setInterval(function () {
      left -= 1;
      countEl.textContent = String(Math.max(0, left));
      if (left <= 0) {
        closeRewarded();
        onReward();
      }
    }, 1000);
  }

  /* ---------- донат и покупка ---------- */

  function openDonate() {
    if (BRAND.donateUrl) {
      window.open(BRAND.donateUrl, '_blank', 'noopener');
      return;
    }
    toast('Ссылка на донат пока не настроена: впиши donateUrl в js/config.js');
  }

  function openPro() {
    if (pro) {
      toast('Реклама уже отключена — спасибо за поддержку!');
      return;
    }
    if (!BRAND.proUrl) {
      toast('Ссылка на покупку не настроена: впиши proUrl в js/config.js');
      return;
    }
    window.open(BRAND.proUrl, '_blank', 'noopener');
    toast('После оплаты открой сайт по ссылке с ?pro=1, чтобы включить версию без рекламы.');
  }

  /* ---------- инициализация ---------- */

  function init() {
    if (BRAND.name) {
      document.title = BRAND.name + ' — браузерная аркада';
      const nameNode = document.getElementById('brand-name');
      if (nameNode) {
        nameNode.textContent = BRAND.name;
      }
    }
    if (BRAND.tagline) {
      const tagNode = document.getElementById('brand-tagline');
      if (tagNode) {
        tagNode.textContent = BRAND.tagline;
      }
    }

    applyPro();
    mountAds();

    const donate = document.getElementById('btn-donate');
    if (donate) {
      donate.addEventListener('click', openDonate);
    }
    const donateOver = document.getElementById('btn-donate-over');
    if (donateOver) {
      donateOver.addEventListener('click', openDonate);
    }
    const proBtn = document.getElementById('btn-pro');
    if (proBtn) {
      proBtn.addEventListener('click', openPro);
    }
    const cancel = document.getElementById('rewarded-cancel');
    if (cancel) {
      cancel.addEventListener('click', function () {
        closeRewarded();
        toast('Награда не получена.');
      });
    }
  }

  window.Monetize = {
    init: init,
    isPro: isPro,
    openDonate: openDonate,
    openPro: openPro,
    mountAds: mountAds,
    mountGameOver: mountGameOver,
    showRewarded: showRewarded
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
