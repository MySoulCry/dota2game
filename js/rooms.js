/*
  Комнаты: создание, вход по коду, поиск открытой комнаты, до 5 игроков.

  Обмен сообщениями идёт по MQTT через открытый брокер (без своего сервера).
  Хост комнаты авторитетен: он готовит вопросы, принимает ответы и считает очки.
  Если брокер недоступен, включается локальный режим через BroadcastChannel:
  тогда комнату видно только во вкладках этого браузера.
*/
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const RC = CFG.rooms || {};
  const PREFIX = CFG.rooms && CFG.rooms.topicPrefix ? CFG.rooms.topicPrefix : 'dotaguess/v1';
  const MAX_PLAYERS = Number(CFG.rooms && CFG.rooms.maxPlayers) || 5;
  const MIN_PLAYERS = Number(CFG.rooms && CFG.rooms.minPlayers) || 2;
  const BROKER = CFG.rooms && CFG.rooms.brokerUrl ? CFG.rooms.brokerUrl : 'wss://broker.emqx.io:8084/mqtt';
  const LOBBY_TTL = Number(CFG.rooms && CFG.rooms.lobbyTtlMs) || 120000;
  const DEFAULT_ROUNDS = Number(CFG.rooms && CFG.rooms.defaultRounds) || 8;
  const DEFAULT_SECONDS = Number(CFG.rooms && CFG.rooms.defaultSeconds) || 20;

  const listeners = {};

  function on(event, fn) {
    if (!listeners[event]) {
      listeners[event] = [];
    }
    listeners[event].push(fn);
  }

  function emit(event, data) {
    (listeners[event] || []).forEach(function (fn) {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    });
  }

  /* ---------- транспорт ---------- */

  const net = {
    kind: 'none',
    client: null,
    bc: null,
    subs: []
  };

  let connectPromise = null;

  function matchesFilter(filter, topic) {
    const f = filter.split('/');
    const t = topic.split('/');
    if (f.length !== t.length) {
      return false;
    }
    for (let i = 0; i < f.length; i++) {
      if (f[i] === '#') {
        return true;
      }
      if (f[i] !== '+' && f[i] !== t[i]) {
        return false;
      }
    }
    return true;
  }

  function route(topic, payloadText) {
    let payload = null;
    try {
      payload = JSON.parse(payloadText);
    } catch (e) {
      return;
    }
    net.subs.forEach(function (sub) {
      if (matchesFilter(sub.filter, topic)) {
        try {
          sub.fn(payload, topic);
        } catch (e) {
          console.error(e);
        }
      }
    });
  }

  function subscribe(filter, fn) {
    net.subs.push({ filter: filter, fn: fn });
    if (net.kind === 'mqtt' && net.client) {
      net.client.subscribe(filter, { qos: 0 });
    }
  }

  function publish(topic, obj, retain) {
    const payload = obj === null || obj === undefined ? '' : JSON.stringify(obj);
    if (net.kind === 'mqtt' && net.client) {
      net.client.publish(topic, payload, { qos: 0, retain: !!retain });
    } else if (net.kind === 'local' && net.bc) {
      net.bc.postMessage({ topic: topic, payload: payload });
    }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('не загрузился mqtt.js')); };
      document.head.appendChild(s);
    });
  }

  async function connectMqtt() {
    if (!window.mqtt) {
      await loadScript('https://unpkg.com/mqtt/dist/mqtt.min.js');
    }

    return new Promise(function (resolve, reject) {
      const clientId = 'dg_' + Math.random().toString(16).slice(2, 10);
      let settled = false;
      let client = null;

      const timer = window.setTimeout(function () {
        if (!settled) {
          settled = true;
          try { if (client) client.end(true); } catch (e) {}
          reject(new Error('брокер не отвечает'));
        }
      }, 10000);

      try {
        client = window.mqtt.connect(BROKER, {
          clientId: clientId,
          clean: true,
          connectTimeout: 8000,
          reconnectPeriod: 4000,
          keepalive: 30
        });
      } catch (e) {
        settled = true;
        window.clearTimeout(timer);
        reject(e);
        return;
      }

      client.on('connect', function () {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        resolve(client);
      });

      client.on('error', function (err) {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        try { client.end(true); } catch (e) {}
        reject(err || new Error('ошибка соединения'));
      });

      client.on('message', function (topic, payload) {
        route(topic, payload.toString());
      });
    });
  }

  function connectLocal() {
    return new Promise(function (resolve, reject) {
      if (!('BroadcastChannel' in window)) {
        reject(new Error('локальный режим не поддерживается'));
        return;
      }
      if (!net.bc) {
        const bc = new BroadcastChannel('dotaguess-local');
        bc.onmessage = function (event) {
          const data = event.data || {};
          if (data.topic) {
            route(data.topic, data.payload);
          }
        };
        net.bc = bc;
      }
      resolve(net.bc);
    });
  }

  function connect() {
    if (net.kind !== 'none') {
      return Promise.resolve(net.kind);
    }
    if (connectPromise) {
      return connectPromise;
    }

    connectPromise = connectMqtt().then(function (client) {
      net.kind = 'mqtt';
      net.client = client;
      net.subs.forEach(function (sub) { client.subscribe(sub.filter, { qos: 0 }); });
      emit('transport', { kind: 'mqtt' });
      return 'mqtt';
    }).catch(function (error) {
      return connectLocal().then(function () {
        net.kind = 'local';
        emit('transport', { kind: 'local', reason: error && error.message });
        return 'local';
      });
    }).catch(function (error) {
      connectPromise = null;
      throw new Error((error && error.message) || 'нет связи с сервером комнат');
    });

    return connectPromise;
  }

  /* ---------- состояние ---------- */

  const me = {
    id: 'p' + Math.random().toString(36).slice(2, 9),
    name: 'Игрок'
  };

  const room = {
    code: '',
    host: false,
    hostId: '',
    phase: 'lobby',
    players: [],
    settings: null,
    questions: [],
    round: -1,
    answers: {},
    questionStartedAt: 0,
    revealed: false,
    advanceTimer: 0,
    lobbyWatch: false,
    found: {}
  };

  function makeCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 5; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  }

  function publicPlayer(p) {
    return { id: p.id, name: p.name, score: p.score || 0, correct: p.correct || 0, isHost: !!p.isHost };
  }

  function snapshot() {
    return {
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      settings: room.settings,
      players: room.players.map(publicPlayer),
      isHost: room.host
    };
  }

  function stateTopic() {
    return PREFIX + '/room/' + room.code;
  }

  function inTopic() {
    return PREFIX + '/room/' + room.code + '/in';
  }

  function outTopic() {
    return PREFIX + '/room/' + room.code + '/out';
  }

  function publishState() {
    publish(stateTopic(), {
      type: 'state',
      code: room.code,
      hostId: room.hostId,
      phase: room.phase,
      players: room.players.map(publicPlayer),
      settings: room.settings,
      ts: Date.now()
    }, true);
  }

  function publishLobby() {
    if (!room.settings || room.settings.isPrivate || room.phase !== 'lobby') {
      return;
    }
    publish(PREFIX + '/lobby/' + room.code, {
      code: room.code,
      host: me.name,
      players: room.players.length,
      max: MAX_PLAYERS,
      rounds: room.settings.rounds,
      seconds: room.settings.seconds,
      ts: Date.now()
    }, true);
  }

  function clearLobby() {
    publish(PREFIX + '/lobby/' + room.code, null, true);
  }

  function out(payload) {
    const msg = Object.assign({ to: '*' }, payload);
    publish(outTopic(), msg);
  }

  function reply(targetId, payload) {
    publish(outTopic(), Object.assign({ to: idSafe(targetId) }, payload));
  }

  function idSafe(id) {
    return typeof id === 'string' && id ? id : '*';
  }

  /* ---------- сообщения хоста ---------- */

  function onHostMessage(msg) {
    if (!msg || !msg.type || !msg.from) {
      return;
    }

    if (msg.type === 'join') {
      if (room.phase !== 'lobby') {
        reply(msg.from.id, { type: 'closed', reason: 'Игра уже началась' });
        return;
      }
      if (!room.players.some(function (p) { return p.id === msg.from.id; }) &&
        room.players.length >= MAX_PLAYERS) {
        reply(msg.from.id, { type: 'closed', reason: 'Комната заполнена' });
        return;
      }
      if (!room.players.some(function (p) { return p.id === msg.from.id; })) {
        room.players.push({
          id: msg.from.id,
          name: (msg.from.name || 'Игрок').slice(0, 16),
          score: 0,
          correct: 0,
          streak: 0,
          isHost: false
        });
      }
      publishState();
      publishLobby();
      emit('state', snapshot());
      return;
    }

    if (msg.type === 'answer') {
      if (room.phase !== 'playing' || room.round < 0 || room.revealed) {
        return;
      }
      if (!room.answers[msg.from.id]) {
        room.answers[msg.from.id] = {
          choice: Number(msg.choice),
          ms: Math.max(0, Number(msg.ms) || 0)
        };
      }
      if (allAnswered()) {
        finishRound();
      }
      return;
    }

    if (msg.type === 'leave') {
      room.players = room.players.filter(function (p) { return p.id !== msg.from.id; });
      publishState();
      publishLobby();
      emit('state', snapshot());
      return;
    }

    if (msg.type === 'ping') {
      reply(msg.from.id, { type: 'pong' });
    }
  }

  function allAnswered() {
    if (!room.players.length) {
      return false;
    }
    return room.players.every(function (p) { return !!room.answers[p.id]; });
  }

  /* ---------- сообщения гостя ---------- */

  function applyState(payload) {
    if (!payload) {
      return;
    }
    room.hostId = payload.hostId || '';
    room.players = payload.players || [];
    room.settings = payload.settings || null;
    room.phase = payload.phase || 'lobby';
    emit('state', snapshot());
  }

  function onGuestMessage(payload) {
    if (!payload || (payload.to && payload.to !== '*' && payload.to !== me.id)) {
      return;
    }
    if (payload.type === 'question') {
      room.phase = 'playing';
      room.round = Number(payload.index) - 1;
      room.questionStartedAt = Date.now();
      emit('question', payload);
      return;
    }
    if (payload.type === 'reveal') {
      emit('reveal', payload);
      return;
    }
    if (payload.type === 'end') {
      room.phase = 'end';
      emit('end', payload);
      return;
    }
    if (payload.type === 'closed') {
      emit('closed', payload.reason || 'Комната закрыта');
    }
  }

  /* ---------- создание и вход ---------- */

  async function create(options) {
    await connect();
    room.host = true;
    room.hostId = me.id;
    room.code = makeCode();
    room.phase = 'lobby';
    room.round = -1;
    room.questions = [];
    room.answers = {};
    room.settings = {
      rounds: Math.max(3, Number(options && options.rounds) || DEFAULT_ROUNDS),
      seconds: Math.max(5, Number(options && options.seconds) || DEFAULT_SECONDS),
      isPrivate: !!(options && options.isPrivate)
    };
    room.players = [{ id: me.id, name: me.name, score: 0, correct: 0, streak: 0, isHost: true }];

    subscribe(inTopic(), onHostMessage);
    publishState();
    publishLobby();
    emit('state', snapshot());
    return snapshot();
  }

  async function join(code, name) {
    await connect();
    const clean = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(clean)) {
      throw new Error('Код должен быть из 5 символов');
    }

    if (name) {
      me.name = String(name).slice(0, 16);
    }

    room.host = false;
    room.code = clean;
    room.phase = 'joining';
    me.name = String(name || me.name).slice(0, 16);

    let joined = false;
    subscribe(PREFIX + '/room/' + clean, function (payload) {
      if (payload && payload.type === 'state') {
        joined = true;
        applyState(payload);
      }
    });
    subscribe(PREFIX + '/room/' + clean + '/out', onGuestMessage);

    publish(PREFIX + '/room/' + clean + '/in', {
      type: 'join',
      from: { id: me.id, name: me.name },
      ts: Date.now()
    });

    const until = Date.now() + 5000;
    while (Date.now() < until && !joined) {
      await new Promise(function (r) { window.setTimeout(r, 150); });
    }
    if (!joined) {
      throw new Error('Комната не найдена или не отвечает');
    }
    return snapshot();
  }

  function watchLobby() {
    if (room.lobbyWatch) {
      return;
    }
    room.lobbyWatch = true;
    subscribe(PREFIX + '/lobby/+', function (payload) {
      if (!payload || !payload.code) {
        return;
      }
      if (Date.now() - (Number(payload.ts) || 0) > LOBBY_TTL) {
        delete room.found[payload.code];
      } else {
        room.found[payload.code] = payload;
      }
      const list = Object.keys(room.found)
        .map(function (k) { return room.found[k]; })
        .filter(function (r) {
          return r.code !== room.code &&
            Number(r.players) < (Number(r.max) || MAX_PLAYERS) &&
            Date.now() - (Number(r.ts) || 0) < LOBBY_TTL;
        });
      emit('rooms', list);
    });
  }

  async function quickPlay(name) {
    await connect();
    if (name) {
      me.name = String(name).slice(0, 16);
    }
    subscribeLobbyWatchOnce();
    await new Promise(function (r) { window.setTimeout(r, 2200); });

    const open = Object.keys(room.found)
      .map(function (k) { return room.found[k]; })
      .filter(function (r) {
        return Date.now() - (Number(r.ts) || 0) < LOBBY_TTL &&
          Number(r.players) < (Number(r.max) || MAX_PLAYERS);
      })
      .sort(function (a, b) { return (b.players || 0) - (a.players || 0); });

    if (open.length) {
      return join(open[0].code, me.name);
    }
    return create({ rounds: DEFAULT_ROUNDS, seconds: DEFAULT_SECONDS, isPrivate: false });
  }

  function watchLobbyOnce() {
    if (!room.lobbyWatch) {
      room.lobbyWatch = true;
      subscribe(PREFIX + '/lobby/+', function (payload) {
        if (!payload || !payload.code) {
          return;
        }
        if (Date.now() - (Number(payload.ts) || 0) > LOBBY_TTL) {
          delete room.found[payload.code];
        } else {
          room.found[payload.code] = payload;
        }
        const list = Object.keys(room.found).map(function (k) { return room.found[k]; });
        emit('rooms', list.filter(function (r) {
          return r.code !== room.code && Number(r.players) < (Number(r.max) || MAX_PLAYERS);
        }));
      });
    }
  }

  function subscribeLobbyWatchOnce() {
    watchLobbyOnce();
  }

  /* ---------- партия ---------- */

  function publicQuestion(q) {
    return {
      matchId: q.matchId,
      items: q.items,
      rankName: q.rankName,
      mmr: q.mmr,
      duration: q.duration,
      gameMode: q.gameMode,
      date: q.date,
      options: q.options
    };
  }

  async function start() {
    if (!room.host) {
      return;
    }
    if (room.players.length < MIN_PLAYERS) {
      throw new Error('Нужно хотя бы ' + MIN_PLAYERS + ' игрока');
    }

    room.phase = 'loading';
    publishState();
    emit('state', snapshot());

    const rounds = room.settings.rounds;
    let questions;
    try {
      questions = await window.Questions.build(rounds);
    } catch (error) {
      room.phase = 'lobby';
      publishState();
      publishLobby();
      emit('state', snapshot());
      throw error;
    }
    if (!room.host) {
      return;
    }
    room.questions = questions;
    room.round = -1;
    room.answers = {};
    room.players.forEach(function (p) {
      p.score = 0;
      p.correct = 0;
      p.streak = 0;
    });

    clearLobby();
    room.phase = 'playing';
    publishState();
    emit('state', snapshot());
    nextQuestion();
  }

  function nextQuestion() {
    room.round += 1;
    if (room.round >= room.questions.length) {
      finishRoom();
      return;
    }
    const question = room.questions[room.round];
    room.answers = {};
    room.revealed = false;
    room.questionStartedAt = Date.now();

    const payload = {
      type: 'question',
      index: room.round + 1,
      total: room.questions.length,
      seconds: room.settings.seconds,
      question: publicQuestion(question)
    };

    out(payload);
    emit('question', payload);

    window.clearTimeout(room.advanceTimer);
    room.advanceTimer = window.setTimeout(function () {
      finishRound();
    }, room.settings.seconds * 1000 + 500);
  }

  function finishRound() {
    window.clearTimeout(room.advanceTimer);
    if (!room.host || room.phase !== 'playing' || room.revealed) {
      return;
    }
    const question = room.questions[room.round];
    if (!question) {
      return;
    }
    room.revealed = true;

    const totalMs = room.settings.seconds * 1000;
    room.players.forEach(function (p) {
      const answer = room.answers[p.id];
      if (!answer) {
        p.streak = 0;
        return;
      }
      if (answer.choice === question.correctIndex) {
        const frac = Math.max(0, Math.min(1, 1 - (answer.ms || 0) / totalMs));
        const base = 50 + Math.round(50 * frac);
        const bonus = Math.min(40, (p.streak || 0) * 10);
        p.score = (p.score || 0) + base + bonus;
        p.correct = (p.correct || 0) + 1;
        p.streak = (p.streak || 0) + 1;
      } else {
        p.streak = 0;
      }
    });

    const reveal = {
      type: 'reveal',
      index: room.round + 1,
      correctIndex: question.correctIndex,
      heroName: question.heroName,
      heroImg: question.heroImg,
      links: question.links,
      matchId: question.matchId,
      scores: room.players.map(publicPlayer)
    };

    out(reveal);
    emit('reveal', reveal);
    publishState();

    room.advanceTimer = window.setTimeout(function () {
      nextQuestion();
    }, 3400);
  }

  function finishRoom() {
    room.phase = 'end';
    window.clearTimeout(room.advanceTimer);
    const scores = room.players.slice().sort(function (a, b) {
      return (b.score || 0) - (a.score || 0);
    }).map(publicPlayer);

    out({ type: 'end', scores: scores });
    emit('end', { scores: scores });
    publishState();
  }

  function answer(choice) {
    if (room.phase !== 'playing' || room.revealed) {
      return;
    }
    const ms = Math.max(0, Date.now() - (room.questionStartedAt || Date.now()));

    if (room.host) {
      if (!room.answers[me.id]) {
        room.answers[me.id] = { choice: Number(choice), ms: ms };
      }
      if (allAnswered()) {
        finishRound();
      }
      return;
    }

    publish(inTopic(), {
      type: 'answer',
      from: { id: me.id, name: me.name },
      choice: Number(choice),
      ms: ms,
      ts: Date.now()
    });
    emit('myanswer', { choice: Number(choice) });
  }

  function leave() {
    if (room.code) {
      if (room.host) {
        out({ type: 'closed', reason: 'Хост вышел из комнаты' });
        clearLobby();
        publish(stateTopic(), null, true);
      } else {
        publish(inTopic(), { type: 'leave', from: { id: me.id }, ts: Date.now() });
      }
    }
    window.clearTimeout(room.advanceTimer);
    room.code = '';
    room.host = false;
    room.hostId = '';
    room.players = [];
    room.questions = [];
    room.round = -1;
    room.answers = {};
    room.revealed = false;
    room.phase = 'lobby';
    emit('left', {});
  }

  function restart() {
    if (!room.host) {
      return;
    }
    window.clearTimeout(room.advanceTimer);
    room.phase = 'lobby';
    room.questions = [];
    room.round = -1;
    room.answers = {};
    room.revealed = false;
    room.players.forEach(function (p) {
      p.score = 0;
      p.correct = 0;
      p.streak = 0;
    });
    publishState();
    publishLobby();
    emit('state', snapshot());
  }

  function inRoom() {
    return !!room.code;
  }

  function isHost() {
    return !!room.host;
  }

  function meInfo() {
    return { id: me.id, name: me.name };
  }

  function setMe(patch) {
    if (patch && patch.name) {
      me.name = String(patch.name).slice(0, 16);
    }
  }

  window.Rooms = {
    on: on,
    connect: connect,
    create: create,
    join: join,
    quickPlay: quickPlay,
    watchLobby: watchLobby,
    start: start,
    answer: answer,
    leave: leave,
    restart: restart,
    inRoom: inRoom,
    isHost: isHost,
    me: meInfo,
    setName: setMe,
    transport: function () { return net.kind; }
  };

  // тот же транспорт наружу: им пользуется общий рейтинг
  window.Realtime = {
    connect: connect,
    publish: publish,
    subscribe: subscribe,
    on: on,
    kind: function () { return net.kind; }
  };
})();
