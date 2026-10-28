/*
  Аналитика: счётчик Яндекс.Метрики, если он задан в js/config.js.
  Подключается на всех страницах сайта — нужен, чтобы видеть реальных
  посетителей (и это один из пунктов, на которые смотрит модерация РСЯ).
*/
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const ANALYTICS = CFG.analytics || {};
  const id = String(ANALYTICS.yandexMetrika || '').trim();

  if (!/^\d{5,10}$/.test(id)) {
    return;
  }

  (function (m, e, t, r, i, k, a) {
    m[i] = m[i] || function () {
      (m[i].a = m[i].a || []).push(arguments);
    };
    m[i].l = 1 * new Date();
    for (let j = 0; j < document.scripts.length; j++) {
      if (document.scripts[j].src === r) {
        return;
      }
    }
    k = e.createElement(t);
    a = e.getElementsByTagName(t)[0];
    k.async = 1;
    k.src = r;
    a.parentNode.insertBefore(k, a);
  })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');

  try {
    window.ym(Number(id), 'init', {
      clickmap: true,
      trackLinks: true,
      accurateTrackBounce: true,
      webvisor: true
    });
  } catch (e) {
    /* блокировщик или сеть — не мешаем игре */
  }
})();
