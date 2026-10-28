/*
  Интерфейс и логика викторины: одиночная игра, комнаты, рейтинги.
*/
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const UI = window.UI || {};
  const toast = typeof UI.toast === 'function' ? UI.toast : function () {};
  const store = UI.store || {
    get: function () { return null; },
    set: function () {}
  };
  const Questions = window.Questions;
  const Rooms = window.Rooms;
  const Leaderboard = window.Leaderboard || null;
  const Monetize = window.Monetize || null;

  const BOARD_KEY = 'dotaguess.board.v1';
  const NICK_KEY = 'dotaguess.name';
  const NICK_LOCK_KEY = 'dotaguess.nickLocked';
  const SOLO_ROUNDS = 10;
  const SOLO_SECONDS = 20;

  function $(id) {
    return document.getElementById(id);
  }

  const el = {
    screens: document.querySelectorAll('.screen'),

    name: $('player-name'),
    nickHint: $('nick-hint'),
    homeBest: $('home-best'),
    homeGames: $('home-games'),
    homePlace: $('home-place'),
    btnSolo: $('btn-solo'),
    btnOnlineHome: $('btn-online-home'),
    navHome: $('nav-home'),
    goSolo: $('go-solo'),
    goOnline: $('go-online'),
    goBoard: $('go-board'),

    createRounds: $('create-rounds'),
    createTime: $('create-time'),
    createPrivate: $('create-private'),
    btnCreate: $('btn-create'),
    joinCode: $('join-code'),
    btnJoin: $('btn-join'),
    btnQuick: $('btn-quick'),
    roomsList: $('rooms-list'),
    roomsEmpty: $('rooms-empty'),
    onlineStatus: $('online-status'),

    roomCode: $('room-code'),
    btnCopy: $('btn-copy'),
    roomLink: $('room-link'),
    roomSettings: $('room-settings'),
    roomPlayers: $('room-players'),
    btnStart: $('btn-start'),
    btnLeave: $('btn-leave'),
    roomStatus: $('room-status'),

    quizBack: $('quiz-back'),
    qRound: $('q-round'),
    qTotal: $('q-total'),
    qScore: $('q-score'),
    qStreak: $('q-streak'),
    qTimer: $('q-timerbar'),
    qRank: $('q-rank'),
    qMmr: $('q-mmr'),
    qDuration: $('q-duration'),
    qMode: $('q-mode'),
    qItems: $('q-items'),
    qOptions: $('q-options'),
    qLinks: $('q-links'),
    qHint: $('q-hint'),
    qNext: $('q-next'),
    qStatus: $('q-status'),
    qRoomlist: $('q-roomlist'),

    resultKicker: $('result-kicker'),
    resultTitle: $('result-title'),
    resultScore: $('result-score'),
    resultStats: $('result-stats'),
    resultRoom: $('result-room'),
    btnAgain: $('btn-again'),
    btnResultHome: $('btn-result-home'),

    boardBody: $('board-body'),
    boardEmpty: $('board-empty')
  };

  const G = {
    mode: 'solo',
    questions: [],
    index: 0,
    total: 0,
    score: 0,
    correct: 0,
    streak: 0,
    bestStreak: 0,
    current: null,
    picked: -1,
    locked: true,
    busy: false,
    hintUsed: false,
    seconds: SOLO_SECONDS,
    deadline: 0,
    ticker: 0,
    timerCb: null
  };

  let roomPlayers = [];

  /* ---------- мелочи ---------- */

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function shuffle(list) {
    const arr = list.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function nickname() {
    const typed = el.name ? el.name.value.trim() : '';
    const name = (typed || store.get(NICK_KEY) || 'Игрок').slice(0, 16);
    if (typed) {
      store.set(NICK_KEY, name);
    }
    return name;
  }

  // для перехода по ссылке имя не спрашиваем — генерируем сами
  function autoNickname() {
    const typed = el.name ? el.name.value.trim() : '';
    const stored = (typed || store.get(NICK_KEY) || '').trim();
    if (stored && stored !== 'Игрок') {
      return stored.slice(0, 16);
    }
    const name = 'Гость' + Math.floor(100 + Math.random() * 900);
    store.set(NICK_KEY, name);
    if (el.name) {
      el.name.value = name;
    }
    return name;
  }

  // Один ник на устройство: имя фиксируется после первой завершённой игры.
  function nickLocked() {
    return store.get(NICK_LOCK_KEY) === '1';
  }

  function applyNickLock() {
    const locked = nickLocked();
    if (el.name) {
      el.name.readOnly = locked;
      el.name.classList.toggle('is-locked', locked);
      if (locked) {
        el.name.value = store.get(NICK_KEY) || el.name.value;
      }
    }
    if (el.nickHint) {
      el.nickHint.hidden = !locked;
    }
  }

  function lockNickname() {
    if (nickLocked()) {
      return;
    }
    store.set(NICK_KEY, nickname());
    store.set(NICK_LOCK_KEY, '1');
    applyNickLock();
  }

  function showScreen(name) {
    el.screens.forEach(function (node) {
      node.classList.toggle('is-active', node.id === 'screen-' + name);
    });
    window.scrollTo(0, 0);
  }

  // экран итогов: рекламный блок монтируем только когда он реально виден
  function showResultScreen() {
    showScreen('result');
    if (Monetize && typeof Monetize.mountGameOver === 'function') {
      Monetize.mountGameOver();
    }
  }

  function setOnlineStatus(text) {
    if (el.onlineStatus) {
      el.onlineStatus.textContent = text;
    }
  }

  function stopTimer() {
    if (G.ticker) {
      window.clearInterval(G.ticker);
      G.ticker = 0;
    }
    G.timerCb = null;
  }

  function startTimer(seconds, onExpire) {
    stopTimer();
    const total = Math.max(1, seconds) * 1000;
    const startedAt = Date.now();

    if (el.qTimer) {
      el.qTimer.style.width = '100%';
      el.qTimer.classList.remove('is-low');
    }

    G.timerCb = onExpire;
    G.ticker = window.setInterval(function () {
      const left = Math.max(0, total - (Date.now() - startedAt));
      if (el.qTimer) {
        const pct = left / total * 100;
        el.qTimer.style.width = pct.toFixed(2) + '%';
        el.qTimer.classList.toggle('is-low', pct < 30);
      }
      if (left <= 0) {
        const fn = G.timerCb;
        stopTimer();
        if (fn) {
          fn();
        }
      }
    }, 100);
  }

  /* ---------- рейтинги ---------- */

  const Board = {
    all: function () {
      try {
        const raw = window.localStorage.getItem(BOARD_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
      } catch (e) {
        return [];
      }
    },
    save: function (list) {
      try {
        window.localStorage.setItem(BOARD_KEY, JSON.stringify(list.slice(0, 100)));
      } catch (e) {}
    },
    add: function (entry) {
      const list = this.all();
      list.push(entry);
      list.sort(function (a, b) {
        return (b.score || 0) - (a.score || 0) || (a.date || 0) - (b.date || 0);
      });
      this.save(list);
      return list;
    },
    place: function (score) {
      return this.all().filter(function (e) { return (e.score || 0) > score; }).length + 1;
    }
  };

  function renderBoard() {
    if (!el.boardBody) {
      return;
    }
    const list = Leaderboard ? Leaderboard.list(20) : [];
    const meId = Leaderboard ? Leaderboard.playerId() : '';
    el.boardBody.innerHTML = '';
    if (el.boardEmpty) {
      el.boardEmpty.hidden = list.length > 0;
    }
    list.forEach(function (e, i) {
      const tr = document.createElement('tr');
      if (e.id && e.id === meId) {
        tr.className = 'is-me';
      }
      const acc = e.total ? Math.round((e.correct || 0) / e.total * 100) : 0;
      tr.innerHTML = '<td>' + (i + 1) + '</td><td>' + esc(e.name) + '</td><td>' +
        (e.score || 0) + '</td><td>' + acc + '%</td><td>' + (e.streak || 0) + '</td>';
      el.boardBody.appendChild(tr);
    });
  }

  function updateHomeStats() {
    const list = Board.all();
    const best = list.reduce(function (max, e) { return Math.max(max, e.score || 0); }, 0);
    if (el.homeBest) {
      el.homeBest.textContent = String(best);
    }
    if (el.homeGames) {
      el.homeGames.textContent = String(list.length);
    }
    if (el.homePlace) {
      const mine = list.filter(function (e) { return e.name === nickname(); })[0];
      el.homePlace.textContent = mine ? String(Board.place(mine.score)) : '—';
    }
  }

  /* ---------- отрисовка вопроса ---------- */

  function paintLoading() {
    el.qItems.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'question__loading';
    note.textContent = 'Загружаем реальные матчи из OpenDota… Первый раз это может занять до минуты.';
    el.qItems.appendChild(note);

    el.qOptions.innerHTML = '';
    el.qLinks.hidden = true;
    el.qNext.hidden = true;
    el.qHint.hidden = true;
    el.qRoomlist.hidden = true;
    el.qStatus.hidden = true;
    el.qRank.textContent = 'Загрузка';
    el.qMmr.textContent = '—';
    el.qDuration.textContent = '—';
    el.qMode.textContent = '—';
    el.qRound.textContent = '—';
    el.qTotal.textContent = '—';
  }

  function setLoadingText(text) {
    const note = el.qItems.querySelector('.question__loading');
    if (note) {
      note.textContent = text;
    }
  }

  function paintError(message) {
    el.qOptions.innerHTML = '';
    el.qLinks.hidden = true;
    el.qNext.hidden = true;
    el.qHint.hidden = true;
    el.qRoomlist.hidden = true;
    el.qStatus.hidden = true;
    el.qRank.textContent = 'Ошибка';
    el.qMmr.textContent = '—';
    el.qDuration.textContent = '—';
    el.qMode.textContent = '—';

    el.qItems.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'question__error';

    const text = document.createElement('p');
    text.className = 'question__loading';
    text.textContent = message;
    box.appendChild(text);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn--primary';
    retry.textContent = 'Повторить';
    retry.addEventListener('click', function () {
      startSolo();
    });
    box.appendChild(retry);

    el.qItems.appendChild(box);
  }

  function paintQuestion(question, round, total) {
    el.qRound.textContent = String(round);
    el.qTotal.textContent = String(total);
    el.qRank.textContent = question.rankName || 'Ранг скрыт';
    el.qMmr.textContent = question.mmr || '—';
    el.qDuration.textContent = question.duration || '—';
    el.qMode.textContent = question.gameMode || 'Матч';

    el.qItems.innerHTML = '';
    (question.items || []).forEach(function (item) {
      const node = document.createElement('div');
      node.className = 'item';
      if (item.img) {
        const img = document.createElement('img');
        img.src = item.img;
        img.alt = item.n || 'предмет';
        img.loading = 'lazy';
        img.onerror = function () { img.remove(); };
        node.appendChild(img);
      }
      const name = document.createElement('span');
      name.className = 'item__name';
      name.textContent = item.n || '';
      node.appendChild(name);
      node.title = item.n || '';
      el.qItems.appendChild(node);
    });

    el.qLinks.hidden = true;
    el.qLinks.innerHTML = '';
    el.qStatus.hidden = true;
    el.qStatus.textContent = '';
    el.qNext.hidden = true;
  }

  function optionIndexFromButton(node) {
    return Number(node.dataset.index);
  }

  function paintOptionsByIndex(options, onPick) {
    el.qOptions.innerHTML = '';
    (options || []).forEach(function (option, index) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'option';
      btn.dataset.index = String(index);

      const img = document.createElement('img');
      img.className = 'option__img';
      img.src = option.img;
      img.alt = '';
      img.loading = 'lazy';
      img.onerror = function () { img.style.visibility = 'hidden'; };

      const name = document.createElement('span');
      name.className = 'option__name';
      name.textContent = option.name;

      btn.appendChild(img);
      btn.appendChild(name);
      btn.addEventListener('click', function () { onPick(index, btn); });
      el.qOptions.appendChild(btn);
    });
  }

  function updateQuizHeader() {
    el.qScore.textContent = String(G.score);
    el.qStreak.textContent = 'Серия ' + G.streak;
  }

  function revealAnswer(question, picked, correctIndex, points) {
    G.locked = true;
    stopTimer();

    const nodes = el.qOptions.querySelectorAll('.option');
    Array.prototype.forEach.call(nodes, function (node) {
      const i = optionIndexFromButton(node);
      node.disabled = true;
      if (i === correctIndex) {
        node.classList.add('is-correct');
      }
      if (picked >= 0 && i === picked) {
        node.classList.add(picked === correctIndex ? 'is-picked-correct' : 'is-wrong');
      }
    });

    el.qLinks.hidden = false;
    el.qLinks.innerHTML = '';
    (question.links || []).forEach(function (link) {
      const a = document.createElement('a');
      a.className = 'link';
      a.href = link.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = link.label + ' ↗';
      el.qLinks.appendChild(a);
    });

    el.qHint.hidden = true;
    el.qStatus.hidden = false;

    if (G.mode === 'solo') {
      el.qStatus.textContent = points > 0
        ? 'Верно! +' + points + ' очков. Это ' + question.heroName + '.'
        : 'Мимо. Это ' + question.heroName + '.';
      el.qNext.hidden = false;
    } else {
      el.qStatus.textContent = (picked >= 0 && picked === correctIndex)
        ? 'Верно! Это ' + question.heroName + '.'
        : 'Это ' + question.heroName + '.';
    }
  }

  /* ---------- одиночная игра ---------- */

  async function startSolo() {
    if (G.busy) {
      return;
    }
    if (Rooms && Rooms.inRoom()) {
      Rooms.leave();
    }

    G.busy = true;
    G.mode = 'solo';
    G.index = 0;
    G.score = 0;
    G.correct = 0;
    G.streak = 0;
    G.bestStreak = 0;
    G.hintUsed = false;
    G.current = null;
    G.locked = true;

    showScreen('play');
    paintLoading();

    try {
      const questions = await Questions.build(SOLO_ROUNDS, setLoadingText);
      G.questions = questions;
      G.total = questions.length;
      G.busy = false;
      nextSoloQuestion();
    } catch (error) {
      G.busy = false;
      const message = (error && error.message) ? error.message : 'Не удалось загрузить матчи.';
      console.error('Не удалось собрать вопросы:', error);
      paintError(message);
      toast('Матчи не загрузились. ' + message);
    }
  }

  function nextSoloQuestion() {
    if (G.index >= G.questions.length) {
      finishSolo();
      return;
    }

    const question = G.questions[G.index];
    G.current = question;
    G.locked = false;
    G.picked = -1;
    G.hintUsed = false;
    G.seconds = SOLO_SECONDS;

    paintQuestion(question, G.index + 1, G.total);
    paintOptionsByIndex(question.options, soloPick);
    updateQuizHeader();

    el.qHint.hidden = false;
    el.qHint.disabled = false;
    el.qRound.textContent = String(G.index + 1);
    el.qTotal.textContent = String(G.total);
    el.qRoomlist.hidden = true;

    G.deadline = Date.now() + SOLO_SECONDS * 1000;
    startTimer(SOLO_SECONDS, function () { soloPick(-1); });
  }

  function soloPick(index) {
    if (G.locked || !G.current) {
      return;
    }
    const question = G.current;
    const correct = index === question.correctIndex;
    const left = Math.max(0, (G.deadline - Date.now()) / 1000);
    const frac = Math.max(0, Math.min(1, left / G.seconds));

    let points = 0;
    if (correct) {
      G.streak += 1;
      G.bestStreak = Math.max(G.bestStreak, G.streak);
      points = 50 + Math.round(50 * frac) + Math.min(40, G.streak * 10);
      G.score += points;
      G.correct += 1;
    } else {
      G.streak = 0;
    }
    G.picked = index;

    updateQuizHeader();
    revealAnswer(question, index, question.correctIndex, points);
  }

  function finishSolo() {
    const entry = {
      name: nickname(),
      score: G.score,
      correct: G.correct,
      total: G.total,
      streak: G.bestStreak,
      mode: 'solo',
      date: Date.now()
    };
    Board.add(entry);
    lockNickname();
    if (Leaderboard) {
      Leaderboard.submit(entry);
    }
    const place = Leaderboard
      ? Leaderboard.list(100).filter(function (row) { return (row.score || 0) > entry.score; }).length + 1
      : Board.place(entry.score);
    renderBoard();
    updateHomeStats();

    if (el.resultKicker) {
      el.resultKicker.textContent = 'Итог';
    }
    if (el.resultTitle) {
      el.resultTitle.textContent = 'Игра окончена';
    }
    if (el.resultScore) {
      el.resultScore.textContent = String(entry.score);
    }
    if (el.resultStats) {
      el.resultStats.textContent = 'Правильно ' + entry.correct + ' из ' + entry.total +
        ' · лучшая серия ' + entry.streak + ' · место в таблице #' + place;
    }
    if (el.resultRoom) {
      el.resultRoom.innerHTML = '';
    }
    showResultScreen();
  }

  /* ---------- подсказка 50/50 ---------- */

  function useHint() {
    if (G.hintUsed || G.locked || !G.current) {
      return;
    }
    const current = G.current;

    const apply = function () {
      G.hintUsed = true;
      el.qHint.hidden = true;

      const nodes = Array.prototype.slice.call(el.qOptions.querySelectorAll('.option'));
      const wrong = nodes.filter(function (node) {
        return optionIndexFromButton(node) !== current.correctIndex && !node.disabled;
      });
      shuffle(wrong).slice(0, 2).forEach(function (node) {
        node.disabled = true;
        node.classList.add('is-eliminated');
      });
    };

    const isPro = Monetize && typeof Monetize.isPro === 'function' && Monetize.isPro();
    const adsOn = CFG.ads && CFG.ads.enabled;

    if (!isPro && adsOn && Monetize && typeof Monetize.showRewarded === 'function') {
      Monetize.showRewarded(apply);
      return;
    }
    apply();
  }

  /* ---------- комнаты: экран и лобби ---------- */

  async function ensureOnline() {
    if (Rooms.transport && Rooms.transport() !== 'none') {
      return true;
    }
    setOnlineStatus('Подключаемся к серверу комнат…');
    try {
      await Rooms.connect();
      return true;
    } catch (error) {
      setOnlineStatus('Не удалось подключиться: ' + (error && error.message ? error.message : 'нет сети'));
      toast('Нет связи с сервером комнат');
      return false;
    }
  }

  // переход по ссылке-приглашению: сразу в комнату, без кнопок
  async function autoJoin(code) {
    showScreen('online');
    setOnlineStatus('Присоединяемся к комнате ' + code + '…');
    const name = autoNickname();

    if (!(await ensureOnline())) {
      setOnlineStatus('Код ' + code + ' уже вписан — нажми «Войти», когда появится связь.');
      return;
    }

    try {
      Rooms.setName(name);
      await Rooms.join(code, name);
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.toString());
      } catch (e) {
        /* не критично */
      }
      showScreen('room');
    } catch (error) {
      const message = error && error.message ? error.message : 'ошибка';
      toast('Не удалось войти в комнату: ' + message);
      setOnlineStatus('Комната ' + code + ' не ответила. Проверь код или попроси новую ссылку.');
    }
  }

  function roomShareLink(code) {
    return window.location.origin + window.location.pathname + '?room=' + code;
  }

  function renderRoomLobby(state) {
    if (!state) {
      return;
    }
    roomPlayers = state.players || [];

    if (el.roomCode) {
      el.roomCode.textContent = state.code || '-----';
    }
    if (el.roomLink) {
      const link = roomShareLink(state.code || '');
      el.roomLink.textContent = state.settings && state.settings.isPrivate
        ? 'Ссылка для друга: ' + link
        : 'Открытая комната · ' + link;
    }
    if (el.roomSettings && state.settings) {
      el.roomSettings.textContent = state.settings.rounds + ' раундов · ' +
        state.settings.seconds + ' с на вопрос · ' +
        (state.settings.isPrivate ? 'по коду' : 'открытая');
    }

    if (el.roomPlayers) {
      el.roomPlayers.innerHTML = '';
      roomPlayers.forEach(function (player, i) {
        const li = document.createElement('li');
        li.className = 'player' + (player.isHost ? ' is-host' : '');
        li.innerHTML = '<span class="player__n">' + (i + 1) + '</span>' +
          '<span class="player__name">' + esc(player.name) + '</span>' +
          (player.isHost ? '<span class="player__tag">хост</span>' : '');
        el.roomPlayers.appendChild(li);
      });
    }

    const host = Rooms.isHost();
    if (el.btnStart) {
      el.btnStart.hidden = !host;
      el.btnStart.disabled = roomPlayers.length < 2;
    }

    if (el.roomStatus) {
      const localMode = typeof Rooms.transport === 'function' && Rooms.transport() === 'local';
      if (host) {
        el.roomStatus.textContent = 'Игроков: ' + roomPlayers.length + '/5. Начать можно от 2.';
      } else {
        el.roomStatus.textContent = 'Ждём, когда хост начнёт игру…';
      }
      if (localMode) {
        el.roomStatus.textContent += ' Внимание: онлайн-канал недоступен, комнату видно только в этом браузере.';
      }
    }
  }

  function renderRoomBoard(scores) {
    if (G.mode !== 'room') {
      el.qRoomlist.hidden = true;
      return;
    }
    const list = (scores || roomPlayers).slice().sort(function (a, b) {
      return (b.score || 0) - (a.score || 0);
    });
    const me = Rooms.me();

    el.qRoomlist.hidden = false;
    el.qRoomlist.innerHTML = '';
    list.forEach(function (player, i) {
      const row = document.createElement('div');
      row.className = 'score-row' + (player.id === me.id ? ' is-me' : '');
      row.innerHTML = '<span class="score-row__place">' + (i + 1) + '</span>' +
        '<span class="score-row__name">' + esc(player.name) + '</span>' +
        '<span class="score-row__score">' + (player.score || 0) + '</span>';
      el.qRoomlist.appendChild(row);
    });
  }

  function renderRoomsList(list) {
    if (!el.roomsList) {
      return;
    }
    el.roomsList.innerHTML = '';
    const rooms = (list || []).filter(function (r) {
      return Number(r.players) < (Number(r.max) || 5);
    });

    if (el.roomsEmpty) {
      el.roomsEmpty.hidden = rooms.length > 0;
    }

    rooms.forEach(function (r) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'room-row';
      btn.innerHTML = '<span class="room-row__code">' + esc(r.code) + '</span>' +
        '<span class="room-row__meta">' + (r.players || 1) + '/' + (r.max || 5) +
        ' · ' + (r.rounds || 8) + ' раундов</span>' +
        '<span class="room-row__go">Войти</span>';
      btn.addEventListener('click', async function () {
        if (!(await ensureOnline())) {
          return;
        }
        try {
          await Rooms.join(r.code, nickname());
          showScreen('room');
        } catch (error) {
          toast(error && error.message ? error.message : 'Не удалось войти');
        }
      });
      el.roomsList.appendChild(btn);
    });
  }

  /* ---------- комнаты: игровые события ---------- */

  function onRoomState(state) {
    if (!state) {
      return;
    }
    renderRoomLobby(state);

    if (!Rooms.inRoom()) {
      return;
    }
    if (state.phase === 'lobby' || state.phase === 'loading') {
      showScreen('room');
      if (state.phase === 'loading' && el.roomStatus) {
        el.roomStatus.textContent = 'Готовим вопросы из реальных матчей…';
      }
    }
  }

  function onRoomQuestion(payload) {
    G.mode = 'room';
    G.current = payload.question;
    G.picked = -1;
    G.locked = false;
    G.seconds = payload.seconds;

    showScreen('play');
    paintQuestion(payload.question, payload.index, payload.total);
    G.total = payload.total;
    paintOptionsByIndex(payload.question.options, function (index) {
      if (G.locked) {
        return;
      }
      G.locked = true;
      G.picked = index;
      stopTimer();
      Rooms.answer(index);
      Array.prototype.forEach.call(el.qOptions.querySelectorAll('.option'), function (node) {
        node.disabled = true;
      });
      el.qStatus.hidden = false;
      el.qStatus.textContent = 'Ответ принят. Ждём остальных…';
    });

    el.qRound.textContent = String(payload.index);
    el.qTotal.textContent = String(payload.total);
    el.qScore.textContent = '—';
    el.qStreak.textContent = 'онлайн';
    el.qHint.hidden = true;
    el.qRoomlist.hidden = false;
    renderRoomBoard();

    startTimer(payload.seconds, function () {
      if (!G.locked) {
        G.locked = true;
        Rooms.answer(-1);
        el.qStatus.hidden = false;
        el.qStatus.textContent = 'Время вышло. Ждём остальных…';
      }
    });
  }

  function onRoomReveal(reveal) {
    stopTimer();
    if (!G.current) {
      return;
    }
    if (reveal && Array.isArray(reveal.scores)) {
      roomPlayers = reveal.scores;
    }
    const question = {
      links: (reveal && reveal.links) || [],
      heroName: (reveal && reveal.heroName) || ''
    };
    const correctIndex = reveal && typeof reveal.correctIndex === 'number'
      ? reveal.correctIndex
      : G.current.correctIndex;

    revealAnswer(question, G.picked, correctIndex, 0);
    renderRoomBoard(roomPlayers);
    el.qStatus.textContent = (G.picked >= 0 && G.picked === correctIndex)
      ? 'Верно! Это ' + question.heroName + '.'
      : 'Это ' + question.heroName + '. Ждём следующий вопрос…';
  }

  function onRoomEnd(data) {
    stopTimer();
    const scores = (data && data.scores) || roomPlayers;
    roomPlayers = scores;
    const me = Rooms.me();
    const mine = scores.filter(function (p) { return p.id === me.id; })[0];

    const entry = {
      name: nickname(),
      score: mine ? mine.score || 0 : 0,
      correct: mine ? mine.correct || 0 : 0,
      total: G.total || 0,
      streak: 0,
      mode: 'room',
      date: Date.now()
    };
    if (entry.score > 0) {
      Board.add(entry);
      lockNickname();
      if (Leaderboard) {
        Leaderboard.submit(entry);
      }
      renderBoard();
      updateHomeStats();
    }

    if (el.resultKicker) {
      el.resultKicker.textContent = 'Итоги';
    }
    if (el.resultTitle) {
      el.resultTitle.textContent = 'Итоги комнаты';
    }
    if (el.resultScore) {
      el.resultScore.textContent = String(entry.score);
    }
    if (el.resultStats) {
      el.resultStats.textContent = me.name + ' · правильно ' + entry.correct + ' из ' + (G.total || '—');
    }
    if (el.resultRoom) {
      el.resultRoom.innerHTML = '';
      scores.forEach(function (p, i) {
        const row = document.createElement('div');
        row.className = 'score-row' + (p.id === me.id ? ' is-me' : '');
        row.innerHTML = '<span class="score-row__place">' + (i + 1) + '</span>' +
          '<span class="score-row__name">' + esc(p.name) + '</span>' +
          '<span class="score-row__score">' + (p.score || 0) + '</span>';
        el.resultRoom.appendChild(row);
      });
    }
    showResultScreen();
  }

  /* ---------- инициализация ---------- */

  function bindEvents() {
    if (el.btnSolo) { el.btnSolo.addEventListener('click', startSolo); }
    if (el.goSolo) { el.goSolo.addEventListener('click', startSolo); }

    if (el.navHome) { el.navHome.addEventListener('click', function () { showScreen('home'); }); }

    if (el.goBoard) {
      el.goBoard.addEventListener('click', function () {
        renderBoard();
        showScreen('board');
      });
    }

    if (el.goOnline) {
      el.goOnline.addEventListener('click', function () {
        showScreen('online');
        ensureOnline().then(function (ok) {
          if (ok) {
            Rooms.watchLobby();
            setOnlineStatus('Готово. Создай комнату или войди по коду.');
          }
        });
      });
    }
    if (el.btnOnlineHome) {
      el.btnOnlineHome.addEventListener('click', function () {
        showScreen('online');
        ensureOnline().then(function (ok) {
          if (ok) {
            Rooms.watchLobby();
          }
        });
      });
    }

    if (el.qNext) {
      el.qNext.addEventListener('click', function () {
        if (G.mode !== 'solo') {
          return;
        }
        G.index += 1;
        nextSoloQuestion();
      });
    }
    if (el.qHint) {
      el.qHint.addEventListener('click', useHint);
    }

    if (el.quizBack) {
      el.quizBack.addEventListener('click', function () {
        if (G.mode === 'room') {
          if (window.confirm('Выйти из комнаты?')) {
            Rooms.leave();
          }
          return;
        }
        stopTimer();
        showScreen('home');
      });
    }

    if (el.btnCreate) {
      el.btnCreate.addEventListener('click', async function () {
        if (!(await ensureOnline())) {
          return;
        }
        Rooms.setName(nickname());
        try {
          await Rooms.create({
            rounds: Number(el.createRounds && el.createRounds.value) || 8,
            seconds: Number(el.createTime && el.createTime.value) || 20,
            isPrivate: !!(el.createPrivate && el.createPrivate.checked)
          });
          showScreen('room');
        } catch (error) {
          toast(error && error.message ? error.message : 'Не удалось создать комнату');
        }
      });
    }

    if (el.btnJoin) {
      el.btnJoin.addEventListener('click', async function () {
        const code = (el.joinCode && el.joinCode.value ? el.joinCode.value : '').trim().toUpperCase();
        if (code.length < 5) {
          toast('Введи код из 5 символов');
          return;
        }
        if (!(await ensureOnline())) {
          return;
        }
        try {
          await Rooms.join(code, nickname());
          showScreen('room');
        } catch (error) {
          toast(error && error.message ? error.message : 'Не удалось войти');
        }
      });
    }

    if (el.btnQuick) {
      el.btnQuick.addEventListener('click', async function () {
        if (!(await ensureOnline())) {
          return;
        }
        Rooms.setName(nickname());
        try {
          await Rooms.quickPlay(nickname());
          showScreen('room');
        } catch (error) {
          toast(error && error.message ? error.message : 'Не удалось найти игру');
        }
      });
    }

    if (el.btnStart) {
      el.btnStart.addEventListener('click', async function () {
        try {
          await Rooms.start();
        } catch (error) {
          toast(error && error.message ? error.message : 'Не удалось начать игру');
        }
      });
    }

    if (el.btnLeave) {
      el.btnLeave.addEventListener('click', function () {
        Rooms.leave();
      });
    }

    if (el.btnCopy) {
      el.btnCopy.addEventListener('click', function () {
        const code = el.roomCode ? el.roomCode.textContent : '';
        const link = roomShareLink(code);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(function () {
            toast('Ссылка скопирована');
          }).catch(function () {
            toast('Код комнаты: ' + code);
          });
        } else {
          toast('Код комнаты: ' + code);
        }
      });
    }

    if (el.btnAgain) {
      el.btnAgain.addEventListener('click', function () {
        if (G.mode === 'room') {
          if (Rooms.isHost()) {
            Rooms.restart();
            showScreen('room');
          } else {
            toast('Хост может запустить комнату заново');
          }
          return;
        }
        startSolo();
      });
    }

    if (el.btnResultHome) {
      el.btnResultHome.addEventListener('click', function () {
        showScreen('home');
        updateHomeStats();
      });
    }

    if (el.name) {
      el.name.addEventListener('input', function () {
        store.set(NICK_KEY, el.name.value.trim().slice(0, 16));
        updateHomeStats();
      });
    }

    /* события комнат */
    Rooms.on('transport', function (info) {
      if (info && info.kind === 'local') {
        setOnlineStatus('Онлайн-сервер недоступен — включён локальный режим: комнату видно только во вкладках этого браузера.');
      } else {
        setOnlineStatus('Онлайн-режим: комнаты доступны по всему интернету, до 5 игроков.');
      }
    });
    Rooms.on('rooms', renderRoomsList);
    Rooms.on('state', onRoomState);
    Rooms.on('question', onRoomQuestion);
    Rooms.on('reveal', onRoomReveal);
    Rooms.on('end', onRoomEnd);
    Rooms.on('closed', function (reason) {
      toast(reason || 'Комната закрыта');
      showScreen('online');
    });
    Rooms.on('left', function () {
      stopTimer();
      showScreen('online');
    });
  }

  function init() {
    if (el.name) {
      el.name.value = store.get(NICK_KEY) || '';
    }
    applyNickLock();

    bindEvents();
    renderBoard();
    updateHomeStats();

    if (Leaderboard) {
      Leaderboard.on(renderBoard);
      Leaderboard.start().then(function () {
        renderBoard();
      }).catch(function () {
        /* общий рейтинг недоступен — таблица останется пустой до первой игры */
      });
    }

    // каталоги героев и предметов подтягиваем в фоне, чтобы игра стартовала быстрее
    if (Questions && typeof Questions.warm === 'function') {
      window.setTimeout(function () {
        Questions.warm();
      }, 800);
    }

    // офлайн-кэш и установка как приложение
    if ('serviceWorker' in navigator && window.location.protocol === 'https:') {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function () {
          /* кэш не критичен */
        });
      });
    }

    const params = new URLSearchParams(window.location.search);
    const code = (params.get('room') || '').trim().toUpperCase();
    if (code && /^[A-Z0-9]{5}$/.test(code)) {
      if (el.joinCode) {
        el.joinCode.value = code;
      }
      autoJoin(code);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
