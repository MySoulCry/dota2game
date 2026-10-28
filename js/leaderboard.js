/*
  Общий рейтинг поверх того же бесплатного канала, что и комнаты.

  Каждый браузер публикует свой лучший результат в отдельный retained-топик:
    dotaguess/v1/scores/{playerId}
  Таблица — объединение всех таких записей, поэтому клиенты не перезаписывают
  друг друга.

  Сервера и аккаунтов нет, но и защиты от накрутки тоже: это дружеский рейтинг,
  а не соревновательный. Имя и счёт видны всем, кто открыл таблицу.
*/
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const RC = CFG.rooms || {};
  const PREFIX = String(RC.topicPrefix || 'dotaguess/v1') + '/scores';
  const ID_KEY = 'dotaguess.playerId';

  const listeners = [];
  const entries = {};
  let started = false;

  function onUpdate(fn) {
    if (typeof fn === 'function') {
      listeners.push(fn);
    }
  }

  function emit() {
    listeners.forEach(function (fn) {
      try {
        fn(list());
      } catch (e) {
        console.error(e);
      }
    });
  }

  function playerId() {
    try {
      let id = window.localStorage.getItem(ID_KEY);
      if (!id) {
        id = 'p' + Math.random().toString(36).slice(2, 10);
        window.localStorage.setItem(ID_KEY, id);
      }
      return id;
    } catch (e) {
      return 'guest' + Math.random().toString(36).slice(2, 8);
    }
  }

  function normalize(entry, id) {
    if (!entry || typeof entry.score !== 'number') {
      return null;
    }
    return {
      id: String(id || entry.id || ''),
      name: String(entry.name || 'Игрок').slice(0, 16),
      score: Math.max(0, Math.round(entry.score)),
      correct: Math.max(0, Math.round(entry.correct || 0)),
      total: Math.max(0, Math.round(entry.total || 0)),
      streak: Math.max(0, Math.round(entry.streak || 0)),
      mode: entry.mode === 'room' ? 'room' : 'solo',
      ts: Number(entry.ts) || Date.now()
    };
  }

  function list(limit) {
    const arr = Object.keys(entries)
      .map(function (key) { return entries[key]; })
      .filter(function (e) { return e && e.score > 0; })
      .sort(function (a, b) { return b.score - a.score || a.ts - b.ts; });
    return arr.slice(0, Number(limit) || 20);
  }

  function start() {
    if (started) {
      return Promise.resolve(list());
    }
    started = true;

    const rt = window.Realtime;
    if (!rt) {
      return Promise.resolve(list());
    }

    return rt.connect().then(function () {
      rt.subscribe(PREFIX + '/+', function (payload, topic) {
        const id = String(topic).split('/').pop();
        const entry = normalize(payload, id);
        if (entry) {
          entries[id] = entry;
          emit();
        }
      });
      return list();
    }).catch(function () {
      /* без общего канала останется только локальная таблица */
      return list();
    });
  }

  function submit(entry) {
    const id = playerId();
    const data = normalize(entry, id);
    if (!data) {
      return;
    }
    data.id = id;

    const previous = entries[id];
    if (previous && previous.score >= data.score) {
      return;
    }
    entries[id] = data;
    emit();

    const rt = window.Realtime;
    if (!rt) {
      return;
    }
    rt.connect().then(function () {
      rt.publish(PREFIX + '/' + id, data, true);
    }).catch(function () {
      /* не критично: результат останется локальным */
    });
  }

  window.Leaderboard = {
    start: start,
    submit: submit,
    list: list,
    on: onUpdate,
    playerId: playerId
  };
})();
