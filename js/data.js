/*
  Данные: каталоги героев и предметов + сборка вопросов из реальных
  завершённых матчей Dota 2 через бесплатный OpenDota API.

  Наружу отдаётся только window.Questions.
*/
(function () {
  'use strict';

  const CFG = window.APP_CONFIG || {};
  const API_CFG = CFG.api || {};
  const API = API_CFG.openDota || 'https://api.opendota.com';
  const IMG = 'https://cdn.cloudflare.steamstatic.com';
  const POOL_SIZE = Math.max(4, Number(API_CFG.poolSize) || 12);
  const CACHE_MS = Math.max(1, Number(API_CFG.cacheMinutes) || 20) * 60 * 1000;
  const HERO_CACHE_MS = Math.max(1, Number(API_CFG.heroCacheDays) || 7) * 24 * 60 * 60 * 1000;
  const MIN_RANK = Number(API_CFG.minRankTier) || 0;

  const HEROES_KEY = 'dotaguess.catalog.heroes.v2';
  const ITEMS_KEY = 'dotaguess.catalog.items.v2';
  const POOL_KEY = 'dotaguess.pool.v4';

  // rank_tier: 11..15 Herald, 21..25 Guardian, ... 71..75 Divine, 80 Immortal
  const TIERS = [
    null,
    ['Herald', 0, 770],
    ['Guardian', 770, 1540],
    ['Crusader', 1540, 2310],
    ['Archon', 2310, 3080],
    ['Legend', 3080, 3850],
    ['Ancient', 3850, 4620],
    ['Divine', 4620, 5420],
    ['Immortal', 5420, 6200]
  ];

  const GAME_MODES = {
    1: 'All Pick',
    2: 'Captains Mode',
    3: 'Random Draft',
    4: 'Single Draft',
    5: 'All Random',
    16: 'Captains Draft',
    18: 'Ability Draft',
    19: 'Event',
    22: 'Ranked All Pick'
  };

  const state = {
    heroes: null,
    items: null,
    heroesById: null,
    itemsById: null
  };

  /* ---------- кэш и сеть ---------- */

  function cacheGet(key, ttl) {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        return null;
      }
      const box = JSON.parse(raw);
      if (!box || !box.v || !box.exp || box.exp < Date.now()) {
        return null;
      }
      return box.v;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(key, value, ttl) {
    try {
      window.localStorage.setItem(key, JSON.stringify({ v: value, exp: Date.now() + ttl }));
    } catch (e) {
      /* переполнение или приватный режим — просто не кэшируем */
    }
  }

  async function getJSON(path) {
    const controller = new AbortController();
    const timer = window.setTimeout(function () { controller.abort(); }, 12000);
    try {
      const res = await fetch(API + path, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });
      if (!res.ok) {
        throw new Error('OpenDota ответил ' + res.status + ' на ' + path);
      }
      try {
        return await res.json();
      } catch (e) {
        throw new Error('OpenDota вернул не JSON на ' + path);
      }
    } finally {
      window.clearTimeout(timer);
    }
  }

  /* ---------- герои и предметы ---------- */

  function heroImage(hero) {
    if (hero.img) {
      return IMG + hero.img;
    }
    const short = String(hero.name || '').replace('npc_dota_hero_', '');
    return IMG + '/apps/dota2/images/dota_react/heroes/' + short + '.png';
  }

  function normalizeHero(hero) {
    const short = String(hero.name || '').replace('npc_dota_hero_', '');
    return {
      id: Number(hero.id),
      name: hero.localized_name || short,
      attr: hero.primary_attr || '',
      img: heroImage(hero)
    };
  }

  function prettyItemName(name) {
    const small = { of: 1, the: 1, and: 1, a: 1, in: 1, an: 1 };
    return String(name || '')
      .replace(/^item_/, '')
      .split('_')
      .filter(function (word) { return !!word; })
      .map(function (word, index) {
        if (index > 0 && small[word]) {
          return word;
        }
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join(' ');
  }

  // /api/constants/items — объект «внутреннее имя → запись» (id, img, dname).
  // /api/items не существует (404), поэтому каталог берём отсюда.
  function itemFromConstants(name, entry) {
    const id = Number(entry && entry.id);
    if (!id || !entry) {
      return null;
    }
    if (/^recipe/i.test(name)) {
      return null;
    }
    const img = entry.img ? IMG + entry.img : '';
    if (!img) {
      return null;
    }
    return { id: id, n: entry.dname || entry.localized_name || prettyItemName(name), img: img };
  }

  async function loadItems() {
    try {
      const map = await getJSON('/api/constants/items');
      const list = [];
      const seen = {};
      Object.keys(map || {}).forEach(function (name) {
        const item = itemFromConstants(name, map[name]);
        if (item && !seen[item.id]) {
          seen[item.id] = true;
          list.push(item);
        }
      });
      if (list.length) {
        return list;
      }
    } catch (e) {
      /* пробуем запасной источник */
    }

    // Запасной вариант: плоская карта id → внутреннее имя, иконки собираем сами.
    const ids = await getJSON('/api/constants/item_ids');
    const list = [];
    Object.keys(ids || {}).forEach(function (key) {
      const id = Number(key);
      const name = ids[key];
      if (!id || !name || /^recipe/i.test(name)) {
        return;
      }
      list.push({
        id: id,
        n: prettyItemName(name),
        img: IMG + '/apps/dota2/images/dota_react/items/' + name + '.png'
      });
    });
    if (!list.length) {
      throw new Error('не удалось загрузить список предметов');
    }
    return list;
  }

  async function ensureCatalogs() {
    if (state.heroes && state.items) {
      return state;
    }

    let heroes = cacheGet(HEROES_KEY, HERO_CACHE_MS);
    let items = cacheGet(ITEMS_KEY, HERO_CACHE_MS);

    if (!heroes || !heroes.length) {
      const raw = await getJSON('/api/heroes');
      heroes = (raw || []).map(normalizeHero).filter(function (h) { return h.id && h.name; });
      if (!heroes.length) {
        throw new Error('не удалось загрузить список героев');
      }
      cacheSet(HEROES_KEY, heroes, HERO_CACHE_MS);
    }

    if (!items || !items.length) {
      items = await loadItems();
      cacheSet(ITEMS_KEY, items, HERO_CACHE_MS);
    }

    const heroesById = {};
    heroes.forEach(function (h) { heroesById[h.id] = h; });
    const itemsById = {};
    items.forEach(function (it) { itemsById[it.id] = it; });

    state.heroes = heroes;
    state.items = items;
    state.heroesById = heroesById;
    state.itemsById = itemsById;

    return state;
  }

  /* ---------- ранги ---------- */

  function rankInfo(rankTier) {
    const rt = Number(rankTier) || 0;
    if (!rt) {
      return { tier: 0, star: 0, name: 'Ранг скрыт', mmr: 'MMR неизвестен' };
    }
    const tier = Math.min(8, Math.max(1, Math.floor(rt / 10)));
    const star = rt % 10;
    const row = TIERS[tier];
    const mid = Math.round(((row[1] + row[2]) / 2) / 50) * 50;
    return {
      tier: tier,
      star: star,
      name: row[0] + (star ? ' ' + star : ''),
      mmr: '≈ ' + mid.toLocaleString('ru-RU') + ' MMR'
    };
  }

  /* ---------- матчи ---------- */

  function countItems(player) {
    let n = 0;
    for (let i = 0; i < 6; i++) {
      if (player['item_' + i]) {
        n += 1;
      }
    }
    return n;
  }

  function averageRankTier(match) {
    const players = Array.isArray(match.players) ? match.players : [];
    let sum = 0;
    let n = 0;
    players.forEach(function (p) {
      const rt = Number(p && p.rank_tier) || 0;
      if (rt >= 11 && rt <= 85) {
        sum += rt;
        n += 1;
      }
    });
    return n ? Math.round(sum / n) : 0;
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function formatDate(unix) {
    const d = new Date((Number(unix) || 0) * 1000);
    if (!Number.isFinite(d.getTime())) {
      return '';
    }
    try {
      return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
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

  function buildOptions(hero, heroes) {
    const pool = heroes.filter(function (h) { return h.id !== hero.id; });
    const sameAttr = shuffle(pool.filter(function (h) { return h.attr === hero.attr; })).slice(0, 3);
    const usedIds = {};
    usedIds[hero.id] = true;
    sameAttr.forEach(function (h) { usedIds[h.id] = true; });
    const rest = shuffle(pool.filter(function (h) { return !usedIds[h.id]; })).slice(0, 2);

    const options = shuffle(sameAttr.concat(rest)).map(function (h) {
      return { id: h.id, name: h.name, img: h.img };
    });
    options.push({ id: hero.id, name: hero.name, img: hero.img });

    // перемешиваем вместе с правильным ответом
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = options[i];
      options[i] = options[j];
      options[j] = tmp;
    }

    let correctIndex = 0;
    options.forEach(function (opt, i) {
      if (opt.id === hero.id) {
        correctIndex = i;
      }
    });

    return { options: options, correctIndex: correctIndex };
  }

  function questionFromMatch(match, catalogs, meta) {
    if (!match || !match.match_id) {
      return null;
    }
    // страховка: в вопросы попадают только рейтинговые матчи, Turbo — никогда
    if (Number(match.lobby_type) !== 7 || Number(match.game_mode) === 23) {
      return null;
    }
    if (Number(match.duration) < 900) {
      return null;
    }
    const players = Array.isArray(match.players) ? match.players : [];
    const candidates = players.filter(function (p) {
      return p && p.hero_id && countItems(p) >= 5 && catalogs.heroesById[p.hero_id];
    });
    if (!candidates.length) {
      return null;
    }

    // приоритет матчам с известным рангом не ниже выбранного
    const ranked = MIN_RANK ? candidates.filter(function (p) {
      return (Number(p.rank_tier) || 0) >= MIN_RANK;
    }) : [];
    const pool = ranked.length && Math.random() < 0.75 ? ranked : candidates;
    const player = pool[Math.floor(Math.random() * pool.length)];
    const hero = catalogs.heroesById[player.hero_id];

    const items = [];
    for (let i = 0; i < 6; i++) {
      const id = player['item_' + i];
      const item = id ? catalogs.itemsById[id] : null;
      if (item) {
        items.push(item);
      }
    }
    if (items.length < 4) {
      return null;
    }

    const rank = rankInfo(player.rank_tier || (meta && meta.avg_rank_tier) || averageRankTier(match));
    const choice = buildOptions(hero, catalogs.heroes);

    return {
      matchId: match.match_id,
      heroId: hero.id,
      heroName: hero.name,
      heroImg: hero.img,
      heroAttr: hero.attr,
      items: items,
      rankTier: Number(player.rank_tier) || 0,
      rankName: rank.name,
      mmr: rank.mmr,
      duration: formatDuration(match.duration),
      gameMode: GAME_MODES[match.game_mode] || 'Матч',
      date: formatDate(match.start_time),
      links: [
        { label: 'OpenDota', url: 'https://www.opendota.com/matches/' + match.match_id },
        { label: 'Dotabuff', url: 'https://www.dotabuff.com/matches/' + match.match_id }
      ],
      options: choice.options,
      correctIndex: choice.correctIndex
    };
  }

  // Ранговый матч: lobby_type 7 (Ranked matchmaking), без Turbo (game_mode 23),
  // и достаточно длинный, чтобы сборка успела сложиться.
  function isRankedMatch(match) {
    if (!match || !match.match_id) {
      return false;
    }
    if (Number(match.lobby_type) !== 7) {
      return false;
    }
    if (Number(match.game_mode) === 23) {
      return false;
    }
    return Number(match.duration) >= 900;
  }

  // детали матчей пачками, вместе с исходной записью (в ней есть avg_rank_tier)
  async function fetchMatchDetails(matches) {
    const out = [];
    for (let i = 0; i < matches.length; i += 6) {
      const batch = matches.slice(i, i + 6);
      const results = await Promise.all(batch.map(function (m) {
        return getJSON('/api/matches/' + m.match_id)
          .then(function (data) { return data ? { match: data, meta: m } : null; })
          .catch(function () { return null; });
      }));
      results.forEach(function (row) {
        if (row) {
          out.push(row);
        }
      });
    }
    return out;
  }

  async function refillPool(catalogs) {
    const questions = [];
    const accounts = [];
    const seenAccount = {};
    const seenMatch = {};

    // 1. Свежие публичные матчи дают «затравку»: в них есть ники игроков,
    //    у которых точно есть рейтинговые игры (в самом фиде рейтинговых почти нет).
    const list = await getJSON('/api/publicMatches');
    const parsed = (Array.isArray(list) ? list : []).filter(function (m) {
      return m && m.match_id && Number(m.duration) > 0;
    });
    if (!parsed.length) {
      throw new Error('OpenDota не вернул готовые матчи — попробуй ещё раз через минуту');
    }

    const seeds = shuffle(parsed).slice(0, 6);
    seeds.forEach(function (m) {
      seenMatch[m.match_id] = true;
    });

    const seedDetails = await fetchMatchDetails(seeds);
    seedDetails.forEach(function (row) {
      const players = Array.isArray(row.match.players) ? row.match.players : [];
      players.forEach(function (p) {
        const accountId = p && p.account_id;
        if (accountId && accounts.length < 6 && !seenAccount[accountId]) {
          seenAccount[accountId] = true;
          accounts.push(accountId);
        }
      });
      if (questions.length < POOL_SIZE && isRankedMatch(row.match)) {
        const q = questionFromMatch(row.match, catalogs, row.meta);
        if (q) {
          questions.push(q);
        }
      }
    });

    // 2. Рейтинговая история этих игроков: там рейтинговых матчей уже много.
    if (accounts.length && questions.length < POOL_SIZE) {
      const histories = await Promise.all(accounts.map(function (id) {
        return getJSON('/api/players/' + id + '/matches?limit=20').catch(function () {
          return [];
        });
      }));

      const ranked = [];
      histories.forEach(function (rows) {
        (Array.isArray(rows) ? rows : []).forEach(function (m) {
          if (!m || !m.match_id || seenMatch[m.match_id] || !isRankedMatch(m)) {
            return;
          }
          seenMatch[m.match_id] = true;
          ranked.push(m);
        });
      });

      const picked = shuffle(ranked).slice(0, POOL_SIZE + 2);
      const details = await fetchMatchDetails(picked);
      details.forEach(function (row) {
        if (questions.length >= POOL_SIZE) {
          return;
        }
        const q = questionFromMatch(row.match, catalogs, row.meta);
        if (q) {
          questions.push(q);
        }
      });
    }

    if (!questions.length) {
      throw new Error('Не нашлось рейтинговых матчей — попробуй ещё раз через минуту');
    }
    return questions;
  }

  async function build(count) {
    const rounds = Math.max(1, Number(count) || 10);
    const catalogs = await ensureCatalogs();

    let pool = cacheGet(POOL_KEY, CACHE_MS);
    if (!Array.isArray(pool) || pool.length < Math.min(rounds, 6)) {
      pool = await refillPool(catalogs);
      cacheSet(POOL_KEY, pool, CACHE_MS);
    }

    const out = [];
    while (out.length < rounds) {
      const batch = shuffle(pool);
      for (let i = 0; i < batch.length && out.length < rounds; i++) {
        out.push(batch[i]);
      }
    }
    return out;
  }

  window.Questions = {
    build: build,
    rankInfo: rankInfo,
    formatDuration: formatDuration
  };
})();
