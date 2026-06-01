/**
 * GOLDBET SIMULATOR v1.0 - MODULO 4: PREDICTIVE INTELLIGENCE SUITE
 * 
 * Sviluppato come "Monolito Serverless" (Strada B):
 * - "/" o "/dashboard" : Dashboard HTML/CSS/JS (Tailwind, OLED Black)
 * - "/api/leagues"     : Elenco delle leghe configurate
 * - "/api/projections" : Simulazioni Monte Carlo (10.000 iterazioni standard/nitro)
 * - "/api/expected-points" : Expected Points (xPTS) con statistiche Totali, Casa, Trasferta
 * - "/api/chaos-map"   : Mappa del Caos con Shock Match e Sfascia-Pronostici (anti-timeout)
 * - "/api/real-form"   : Analisi Forma Reale (Analisi ponderata temporale degli ultimi 5 match)
 * - "/api/debug"       : Diagnostica delle tabelle D1
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 0. Dashboard Grafica Principale (OLED Black / GOLDBET SIMULATOR Style)
      if (path === "/" || path === "/dashboard") {
        return new Response(HTML_DASHBOARD, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // 1. Endpoint: Elenco delle Leghe attive (con almeno un rating)
      if (path === "/api/leagues") {
        const leagues = await env.DB_ARCHIVIO.prepare(`
          SELECT DISTINCT rl.div, rl.nazione, rl.descrizione 
          FROM regole_leghe rl
          JOIN team_ratings tr ON rl.div = tr.current_div
          ORDER BY rl.nazione ASC
        `).all();
        return jsonResponse(leagues.results);
      }

      // 2. Endpoint: Diagnostica di Sistema
      if (path === "/api/debug") {
        const debugData = await runDiagnostics(env);
        return jsonResponse(debugData);
      }

      // 3. Endpoint: Monte Carlo Proiezioni
      if (path === "/api/projections") {
        const league = url.searchParams.get("league");
        if (!league) return jsonResponse({ error: "Parametro 'league' mancante." }, 400);

        const forceSimulate = url.searchParams.get("nitro") === "true";

        if (forceSimulate) {
          // Nitro Mode elevata a 10.000 simulazioni ad alta precisione
          const result = await runMonteCarloSimulation(league, 10000, env);
          return jsonResponse({ mode: "nitro", ...result });
        }

        const cacheKey = new Request(url.toString(), request);
        const cache = caches.default;
        let cachedResponse = await cache.match(cacheKey);
        if (cachedResponse) return cachedResponse;

        const projections = await env.DB_PRONOSTICI.prepare(
          "SELECT * FROM proiezioni_finali WHERE campionato = ? ORDER BY scudetto_prob DESC, xpts_mediana DESC"
        ).bind(league).all();

        const response = jsonResponse({ mode: "cached_db", results: projections.results });
        ctx.waitUntil(cache.put(cacheKey, response.clone()));
        return response;
      }

      // 4. Endpoint: Classifica di Merito Completa (xPTS Totale/Casa/Trasferta)
      if (path === "/api/expected-points") {
        const league = url.searchParams.get("league");
        if (!league) return jsonResponse({ error: "Parametro 'league' mancante." }, 400);

        const xptsTable = await calculateExpectedPoints(league, env);
        return jsonResponse(xptsTable);
      }

      // 5. Endpoint: La Mappa del Caos (Chaos Map con Shock Match e Sfascia-Pronostici)
      if (path === "/api/chaos-map") {
        const chaosMap = await calculateChaosMap(env);
        return jsonResponse(chaosMap);
      }

      // 6. Endpoint: Forma Reale Ponderata (Last 5 Matches)
      if (path === "/api/real-form") {
        const league = url.searchParams.get("league");
        if (!league) return jsonResponse({ error: "Parametro 'league' mancante." }, 400);

        const realForm = await calculateRealForm(league, env);
        return jsonResponse(realForm);
      }

      return jsonResponse({ error: "Endpoint non trovato." }, 404);

    } catch (err) {
      return jsonResponse({ error: "Internal Server Error", details: err.message }, 500);
    }
  },

  // Cron Trigger orario per calcolo differito a 10.000 iterazioni
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledSimulation(env));
  }
};

// --- FUNZIONI DI SUPPORTO E CALCOLI AUSILIARI ---

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=15"
    }
  });
}

function drawPoisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > L);
  return k - 1;
}

function getDixonColesTau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

async function getCurrentSeason(league, env) {
  const res = await env.DB_ARCHIVIO.prepare(
    "SELECT MAX(season) as current_season FROM matches WHERE div = ?"
  ).bind(league).first();
  return res?.current_season || null;
}

// --- CORE ENGINE 1: SIMULATORE MONTE CARLO (CON ESCLUSIONE SQUADRE INATTIVE) ---

async function runMonteCarloSimulation(league, iterations, env) {
  const rules = await env.DB_ARCHIVIO.prepare(
    "SELECT * FROM regole_leghe WHERE div = ?"
  ).bind(league).first();
  if (!rules) return { results: [], message: "Regole non configurate" };

  const calibration = await env.DB_PRONOSTICI.prepare(
    "SELECT current_rho FROM parametri_campionato WHERE campionato = ?"
  ).bind(league).first();
  const rho = calibration?.current_rho || 0;

  const currentSeason = await getCurrentSeason(league, env);
  if (!currentSeason) return { results: [], message: "Nessun match disputato per questa lega." };

  // Identificazione dinamica dei soli club attivi nella stagione corrente (Risolve il Bug di Colon)
  const activeTeamsRes = await env.DB_ARCHIVIO.prepare(`
    SELECT DISTINCT ht.name as team_name
    FROM matches m
    JOIN teams ht ON m.home_team_id = ht.id
    WHERE m.div = ? AND m.season = ?
    UNION
    SELECT DISTINCT at.name as team_name
    FROM matches m
    JOIN teams at ON m.away_team_id = at.id
    WHERE m.div = ? AND m.season = ?
  `).bind(league, currentSeason, league, currentSeason).all();

  const activeTeamNames = new Set(activeTeamsRes.results.map(r => (r.team_name || "").toUpperCase().trim()));

  const teamRows = await env.DB_ARCHIVIO.prepare(
    "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
  ).bind(league).all();
  
  // Filtriamo mantenendo solo le squadre attive nella stagione in corso
  const teams = teamRows.results.filter(t => activeTeamNames.has((t.team_name || "").toUpperCase().trim()));
  
  if (teams.length === 0) {
    return { results: [], message: "Nessun club attivo calcolato per la lega: " + league };
  }

  const teamMap = new Map();
  teams.forEach(t => {
    teamMap.set((t.team_name || "").toUpperCase().trim(), {
      name: t.team_name,
      elo: t.elo,
      alpha: t.alpha,
      beta: t.beta,
      hFactor: t.h_factor || 1.15
    });
  });

  const playedMatches = await env.DB_ARCHIVIO.prepare(`
    SELECT 
      ht.name as hometeam,
      at.name as awayteam,
      m.fthg,
      m.ftag,
      m.ftr
    FROM matches m
    JOIN teams ht ON m.home_team_id = ht.id
    JOIN teams at ON m.away_team_id = at.id
    WHERE m.div = ? AND m.season = ?
    ORDER BY m.date ASC
  `).bind(league, currentSeason).all();

  const actualStandings = {};
  teams.forEach(t => {
    actualStandings[(t.team_name || "").toUpperCase().trim()] = { points: 0, goalsScored: 0, goalsConceded: 0, played: 0 };
  });

  playedMatches.results.forEach(m => {
    const homeKey = (m.hometeam || "").toUpperCase().trim();
    const awayKey = (m.awayteam || "").toUpperCase().trim();

    if (actualStandings[homeKey] && actualStandings[awayKey]) {
      actualStandings[homeKey].played++;
      actualStandings[awayKey].played++;
      actualStandings[homeKey].goalsScored += m.fthg;
      actualStandings[homeKey].goalsConceded += m.ftag;
      actualStandings[awayKey].goalsScored += m.ftag;
      actualStandings[awayKey].goalsConceded += m.fthg;

      if (m.ftr === "H") {
        actualStandings[homeKey].points += 3;
      } else if (m.ftr === "A") {
        actualStandings[awayKey].points += 3;
      } else {
        actualStandings[homeKey].points += 1;
        actualStandings[awayKey].points += 1;
      }
    }
  });

  const playedPairs = new Set(playedMatches.results.map(m => `${(m.hometeam || "").toUpperCase().trim()}||${(m.awayteam || "").toUpperCase().trim()}`));
  const remainingCalendar = [];
  
  for (let i = 0; i < teams.length; i++) {
    for (let j = 0; j < teams.length; j++) {
      if (i === j) continue;
      const home = (teams[i].team_name || "").toUpperCase().trim();
      const away = (teams[j].team_name || "").toUpperCase().trim();
      if (!playedPairs.has(`${home}||${away}`)) {
        remainingCalendar.push({ home, away });
      }
    }
  }

  const resolvedCalendar = remainingCalendar.map(match => {
    return {
      homeKey: match.home,
      awayKey: match.away,
      homeObj: teamMap.get(match.home),
      awayObj: teamMap.get(match.away)
    };
  }).filter(m => m.homeObj && m.awayObj);

  const stats = {};
  teams.forEach(t => {
    stats[(t.team_name || "").toUpperCase().trim()] = {
      name: t.team_name,
      scudetto: 0, ucl: 0, uel: 0, uecl: 0, promo: 0, retro: 0, playoff: 0, playout: 0,
      totalPoints: 0
    };
  });

  const numTeams = teams.length; // Basato su club attivi reali
  const isPointHalvingLeague = (league.startsWith("B") || league.startsWith("AUT"));

  for (let sim = 0; sim < iterations; sim++) {
    const simStandings = {};
    teams.forEach(t => {
      const key = (t.team_name || "").toUpperCase().trim();
      simStandings[key] = { 
        points: actualStandings[key].points,
        goalsScored: actualStandings[key].goalsScored,
        goalsConceded: actualStandings[key].goalsConceded,
        played: actualStandings[key].played
      };
    });

    // 1. Fase Standard
    for (const match of resolvedCalendar) {
      if (rules.soglia_split > 0 && simStandings[match.homeKey].played >= rules.soglia_split) {
        continue; 
      }
      simulateResolvedMatch(match, simStandings, rho, rules.giornate_totali, false);
    }

    // 2. Fase Split Reale (Opzione B senza sovraccarichi)
    if (rules.soglia_split > 0) {
      const midStandings = Object.keys(simStandings).map(key => ({
        key,
        points: simStandings[key].points,
        goalsDiff: simStandings[key].goalsScored - simStandings[key].goalsConceded,
        goalsScored: simStandings[key].goalsScored
      })).sort((a, b) => b.points - a.points || b.goalsDiff - a.goalsDiff || b.goalsScored - a.goalsScored);

      const midTopGroup = new Set(midStandings.slice(0, numTeams / 2).map(x => x.key));

      if (isPointHalvingLeague) {
        Object.keys(simStandings).forEach(key => {
          simStandings[key].points = Math.ceil(simStandings[key].points / 2);
        });
      }

      const poolTeams = Array.from(midTopGroup);
      const bottomTeams = Object.keys(simStandings).filter(k => !midTopGroup.has(k));

      simulateSplitPool(poolTeams, simStandings, teamMap, rho, rules.giornate_totali);
      simulateSplitPool(bottomTeams, simStandings, teamMap, rho, rules.giornate_totali);
    }

    const finalStandings = Object.keys(simStandings).map(key => ({
      key,
      points: simStandings[key].points,
      goalsDiff: simStandings[key].goalsScored - simStandings[key].goalsConceded,
      goalsScored: simStandings[key].goalsScored
    })).sort((a, b) => b.points - a.points || b.goalsDiff - a.goalsDiff || b.goalsScored - a.goalsScored);

    finalStandings.forEach((team, rank) => {
      const idx = rank + 1;
      const s = stats[team.key];
      s.totalPoints += team.points;

      if (idx === 1) s.scudetto++;
      if (idx > 1 && idx <= rules.posti_ucl) s.ucl++;
      if (idx > rules.posti_ucl && idx <= (rules.posti_ucl + rules.posti_uel)) s.uel++;
      if (idx > (rules.posti_ucl + rules.posti_uel) && idx <= (rules.posti_ucl + rules.posti_uel + rules.posti_uecl)) s.uecl++;

      if (rules.posti_promo && idx <= rules.posti_promo) s.promo++;
      if (rules.playoff && idx > rules.posti_promo && idx <= (rules.posti_promo + rules.playoff)) s.playoff++;
      if (rules.playout && idx >= (numTeams - rules.posti_retro - rules.playout + 1) && idx <= (numTeams - rules.posti_retro)) s.playout++;
      if (idx > (numTeams - rules.posti_retro)) s.retro++;
    });
  }

  const bulkData = [];
  const timestamp = new Date().toISOString();

  for (const key of Object.keys(stats)) {
    const s = stats[key];
    const item = {
      campionato: league,
      squadra: s.name,
      scudetto_prob: (s.scudetto / iterations) * 100,
      ucl_prob: ((s.scudetto + s.ucl) / iterations) * 100,
      uel_prob: (s.uel / iterations) * 100,
      uecl_prob: (s.uecl / iterations) * 100,
      promo_prob: (s.promo / iterations) * 100,
      retro_prob: (s.retro / iterations) * 100,
      playoff_prob: (s.playoff / iterations) * 100,
      playout_prob: (s.playout / iterations) * 100,
      xpts_mediana: s.totalPoints / iterations,
      ultimo_aggiornamento: timestamp
    };
    bulkData.push(item);

    await env.DB_PRONOSTICI.prepare(`
      INSERT INTO proiezioni_finali 
      (campionato, squadra, scudetto_prob, ucl_prob, uel_prob, uecl_prob, promo_prob, retro_prob, playoff_prob, playout_prob, xpts_mediana, ultimo_aggiornamento)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(campionato, squadra) DO UPDATE SET
        scudetto_prob=excluded.scudetto_prob,
        ucl_prob=excluded.ucl_prob,
        uel_prob=excluded.uel_prob,
        uecl_prob=excluded.uecl_prob,
        promo_prob=excluded.promo_prob,
        retro_prob=excluded.retro_prob,
        playoff_prob=excluded.playoff_prob,
        playout_prob=excluded.playout_prob,
        xpts_mediana=excluded.xpts_mediana,
        ultimo_aggiornamento=excluded.ultimo_aggiornamento
    `).bind(
      item.campionato, item.squadra, item.scudetto_prob, item.ucl_prob, item.uel_prob, item.uecl_prob,
      item.promo_prob, item.retro_prob, item.playoff_prob, item.playout_prob, item.xpts_mediana, item.ultimo_aggiornamento
    ).run();
  }

  return { league, simulated_matches_remaining: resolvedCalendar.length, iterations, results: bulkData };
}

// Generazione e simulazione del mini-calendario play-off dello Split (Bug 4 Risolto)
function simulateSplitPool(pool, standings, teamMap, rho, maxGames) {
  for (let i = 0; i < pool.length; i++) {
    for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const homeKey = pool[i];
      const awayKey = pool[j];
      
      const match = {
        homeKey,
        awayKey,
        homeObj: teamMap.get(homeKey),
        awayObj: teamMap.get(awayKey)
      };
      simulateResolvedMatch(match, standings, rho, maxGames, true);
    }
  }
}

// --- CORE ENGINE 2: CLASSIFICA DI MERITO ---

async function calculateExpectedPoints(league, env) {
  const currentSeason = await getCurrentSeason(league, env);
  if (!currentSeason) return { error: "Nessun match disputato per questa lega." };

  const matches = await env.DB_ARCHIVIO.prepare(`
    SELECT 
      ht.name as hometeam,
      at.name as awayteam,
      m.fthg,
      m.ftag,
      m.ftr
    FROM matches m
    JOIN teams ht ON m.home_team_id = ht.id
    JOIN teams at ON m.away_team_id = at.id
    WHERE m.div = ? AND m.season = ?
  `).bind(league, currentSeason).all();

  // Filtriamo solo i club attivi anche nella classifica di merito
  const activeTeamsRes = await env.DB_ARCHIVIO.prepare(`
    SELECT DISTINCT ht.name as team_name
    FROM matches m
    JOIN teams ht ON m.home_team_id = ht.id
    WHERE m.div = ? AND m.season = ?
    UNION
    SELECT DISTINCT at.name as team_name
    FROM matches m
    JOIN teams at ON m.away_team_id = at.id
    WHERE m.div = ? AND m.season = ?
  `).bind(league, currentSeason, league, currentSeason).all();

  const activeTeamNames = new Set(activeTeamsRes.results.map(r => (r.team_name || "").toUpperCase().trim()));

  const teamRows = await env.DB_ARCHIVIO.prepare(
    "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
  ).bind(league).all();

  const filteredTeams = teamRows.results.filter(t => activeTeamNames.has((t.team_name || "").toUpperCase().trim()));

  const teamMap = new Map();
  filteredTeams.forEach(t => teamMap.set((t.team_name || "").toUpperCase().trim(), t));

  const calibration = await env.DB_PRONOSTICI.prepare(
    "SELECT current_rho FROM parametri_campionato WHERE campionato = ?"
  ).bind(league).first();
  const rho = calibration?.current_rho || 0;

  const table = {};
  filteredTeams.forEach(t => {
    const key = (t.team_name || "").toUpperCase().trim();
    const cleanName = t.team_name;
    const createSub = () => ({ played: 0, wins: 0, draws: 0, losses: 0, gf: 0, gs: 0, points: 0, expectedPoints: 0, xgf: 0, xgs: 0, diff: 0 });
    table[key] = { team: cleanName, tot: createSub(), home: createSub(), away: createSub() };
  });

  matches.results.forEach(m => {
    const homeKey = (m.hometeam || "").toUpperCase().trim();
    const awayKey = (m.awayteam || "").toUpperCase().trim();

    const home = teamMap.get(homeKey);
    const away = teamMap.get(awayKey);
    if (!home || !away) return;

    const eloDiff = home.elo - away.elo;
    const eloScale = 1 + eloDiff * 0.0002;
    const lambda = Math.max(0.05, home.alpha * away.beta * (home.h_factor || 1.15) * eloScale);
    const mu = Math.max(0.05, (away.alpha * home.beta) / eloScale);

    let pWin = 0, pDraw = 0, pLoss = 0;
    const maxG = 5;
    const pHG = new Array(maxG + 1).fill(0).map((_, i) => (Math.pow(lambda, i) * Math.exp(-lambda)) / factorial(i));
    const pAG = new Array(maxG + 1).fill(0).map((_, i) => (Math.pow(mu, i) * Math.exp(-mu)) / factorial(i));

    for (let h = 0; h <= maxG; h++) {
      for (let a = 0; a <= maxG; a++) {
        let prob = pHG[h] * pAG[a];
        if (h <= 1 && a <= 1) prob *= getDixonColesTau(h, a, lambda, mu, rho);
        if (h > a) pWin += prob;
        else if (h === a) pDraw += prob;
        else pLoss += prob;
      }
    }

    const sum = pWin + pDraw + pLoss;
    pWin /= sum; pDraw /= sum; pLoss /= sum;

    const xPtsHome = pWin * 3 + pDraw * 1;
    const xPtsAway = pLoss * 3 + pDraw * 1;

    const h = table[homeKey];
    const a = table[awayKey];

    // Aggiornamento Totale
    h.tot.played++; a.tot.played++;
    h.tot.gf += m.fthg; h.tot.gs += m.ftag;
    a.tot.gf += m.ftag; a.tot.gs += m.fthg;
    h.tot.expectedPoints += xPtsHome; a.tot.expectedPoints += xPtsAway;
    h.tot.xgf += lambda; h.tot.xgs += mu;
    a.tot.xgf += mu; a.tot.xgs += lambda;

    // Aggiornamento Casa
    h.home.played++;
    h.home.gf += m.fthg; h.home.gs += m.ftag;
    h.home.expectedPoints += xPtsHome;
    h.home.xgf += lambda; h.home.xgs += mu;

    // Aggiornamento Trasferta
    a.away.played++;
    a.away.gf += m.ftag; a.away.gs += m.fthg;
    a.away.expectedPoints += xPtsAway;
    a.away.xgf += mu; a.away.xgs += lambda;

    if (m.ftr === "H") {
      h.tot.wins++; h.tot.points += 3; h.home.wins++; h.home.points += 3;
      a.tot.losses++; a.away.losses++;
    } else if (m.ftr === "A") {
      a.tot.wins++; a.tot.points += 3; a.away.wins++; a.away.points += 3;
      h.tot.losses++; h.home.losses++;
    } else {
      h.tot.draws++; h.tot.points += 1; h.home.draws++; h.home.points += 1;
      a.tot.draws++; a.tot.points += 1; a.away.draws++; a.away.points += 1;
    }
  });

  Object.keys(table).forEach(k => {
    const t = table[k];
    const adjust = (obj) => {
      obj.expectedPoints = Number(obj.expectedPoints.toFixed(2));
      obj.xgf = Number(obj.xgf.toFixed(1));
      obj.xgs = Number(obj.xgs.toFixed(1));
      obj.diff = Number((obj.points - obj.expectedPoints).toFixed(2));
    };
    adjust(t.tot); adjust(t.home); adjust(t.away);
  });

  return Object.values(table);
}

function factorial(n) {
  if (n === 0 || n === 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// --- CORE ENGINE 3: INDICE DI SORPRESA (La Mappa del Caos) ---

async function calculateChaosMap(env) {
  const activeLeaguesRes = await env.DB_ARCHIVIO.prepare(`
    SELECT DISTINCT rl.div, rl.nazione, rl.descrizione 
    FROM regole_leghe rl
    JOIN team_ratings tr ON rl.div = tr.current_div
  `).all();

  const result = [];

  for (const league of activeLeaguesRes.results) {
    const currentSeason = await getCurrentSeason(league.div, env);
    if (!currentSeason) continue;

    const matches = await env.DB_ARCHIVIO.prepare(`
      SELECT 
        ht.name as hometeam,
        at.name as awayteam,
        m.fthg,
        m.ftag,
        m.ftr
      FROM matches m
      JOIN teams ht ON m.home_team_id = ht.id
      JOIN teams at ON m.away_team_id = at.id
      WHERE m.div = ? AND m.season = ?
    `).bind(league.div, currentSeason).all();

    if (matches.results.length < 15) continue;

    const teamRows = await env.DB_ARCHIVIO.prepare(
      "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
    ).bind(league.div).all();

    const teamMap = new Map();
    teamRows.results.forEach(t => teamMap.set((t.team_name || "").toUpperCase().trim(), t));

    let totalShock = 0;
    let count = 0;
    let maxShockVal = 0;
    let shockingMatch = { home: "-", away: "-", score: "-", prob: 0 };
    const upsetTracker = {};

    matches.results.forEach(m => {
      const homeKey = (m.hometeam || "").toUpperCase().trim();
      const awayKey = (m.awayteam || "").toUpperCase().trim();

      const home = teamMap.get(homeKey);
      const away = teamMap.get(awayKey);
      if (!home || !away) return;

      const eloDiff = home.elo - away.elo;
      const eloScale = 1 + eloDiff * 0.0002;
      const lambda = home.alpha * away.beta * (home.h_factor || 1.15) * eloScale;
      const mu = (away.alpha * home.beta) / eloScale;

      const sumG = lambda + mu;
      const pWin = lambda / (sumG || 1);
      const pLoss = mu / (sumG || 1);
      const pDraw = 0.26;

      let pOutcome = pDraw;
      if (m.ftr === "H") pOutcome = pWin * (1 - pDraw);
      if (m.ftr === "A") pOutcome = pLoss * (1 - pDraw);

      const shock = 1 - pOutcome;
      totalShock += shock;
      count++;

      if (shock > maxShockVal) {
        maxShockVal = shock;
        shockingMatch = {
          home: home.team_name,
          away: away.team_name,
          score: `${m.fthg}-${m.ftag}`,
          prob: Number((pOutcome * 100).toFixed(1))
        };
      }

      if (shock > 0.70) {
        const victor = m.ftr === "H" ? home.team_name : (m.ftr === "A" ? away.team_name : null);
        if (victor) {
          upsetTracker[victor] = (upsetTracker[victor] || 0) + shock;
        }
      }
    });

    let bracketBuster = "Nessuno";
    let maxUpsetScore = 0;
    Object.keys(upsetTracker).forEach(team => {
      if (upsetTracker[team] > maxUpsetScore) {
        maxUpsetScore = upsetTracker[team];
        bracketBuster = team;
      }
    });

    if (count > 0) {
      result.push({
        league: league.div,
        nazione: league.nazione || "",
        descrizione: league.descrizione || "",
        chaos_index: Number((totalShock / count * 100).toFixed(1)),
        matches_analyzed: count,
        most_shocking_match: shockingMatch,
        bracket_buster: bracketBuster
      });
    }
  }

  return result.sort((a, b) => b.chaos_index - a.chaos_index);
}

// --- CORE ENGINE 4: INDICE DI FORMA REALE (PONDERATO TEMPORALMENTE) ---

async function calculateRealForm(league, env) {
  const currentSeason = await getCurrentSeason(league, env);
  if (!currentSeason) return { error: "Stagione non trovata." };

  const teamRows = await env.DB_ARCHIVIO.prepare(
    "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
  ).bind(league).all();

  const teamMap = new Map();
  const formTable = {};
  teamRows.results.forEach(t => {
    const key = (t.team_name || "").toUpperCase().trim();
    teamMap.set(key, t);
    formTable[key] = { team: t.team_name, matches: [] };
  });

  const matches = await env.DB_ARCHIVIO.prepare(`
    SELECT 
      ht.name as hometeam,
      at.name as awayteam,
      m.fthg,
      m.ftag
    FROM matches m
    JOIN teams ht ON m.home_team_id = ht.id
    JOIN teams at ON m.away_team_id = at.id
    WHERE m.div = ? AND m.season = ?
    ORDER BY m.date DESC
  `).bind(league, currentSeason).all();

  matches.results.forEach(m => {
    const homeKey = (m.hometeam || "").toUpperCase().trim();
    const awayKey = (m.awayteam || "").toUpperCase().trim();

    const home = teamMap.get(homeKey);
    const away = teamMap.get(awayKey);
    if (!home || !away) return;

    const hForm = formTable[homeKey];
    const aForm = formTable[awayKey];

    const eloDiff = home.elo - away.elo;
    const eloScale = 1 + eloDiff * 0.0002;
    const lambda = home.alpha * away.beta * (home.h_factor || 1.15) * eloScale;
    const mu = (away.alpha * home.beta) / eloScale;

    if (hForm.matches.length < 5) {
      hForm.matches.push({
        actualScored: m.fthg,
        expectedScored: lambda,
        actualConceded: m.ftag,
        expectedConceded: mu
      });
    }

    if (aForm.matches.length < 5) {
      aForm.matches.push({
        actualScored: m.ftag,
        expectedScored: mu,
        actualConceded: m.fthg,
        expectedConceded: lambda
      });
    }
  });

  const weights = [0.35, 0.25, 0.20, 0.12, 0.08];

  return Object.values(formTable).filter(t => t.matches.length > 0).map(t => {
    let weightedAtt = 0;
    let weightedDif = 0;
    let weightSum = 0;

    t.matches.forEach((m, idx) => {
      const w = weights[idx] || 0;
      weightedAtt += (m.actualScored - m.expectedScored) * w;
      weightedDif += (m.expectedConceded - m.actualConceded) * w;
      weightSum += w;
    });

    const attRating = weightSum > 0 ? (weightedAtt / weightSum) : 0;
    const difRating = weightSum > 0 ? (weightedDif / weightSum) : 0;

    const sumActualScored = t.matches.reduce((acc, curr) => acc + curr.actualScored, 0);
    const sumExpectedScored = t.matches.reduce((acc, curr) => acc + curr.expectedScored, 0);
    const sumActualConceded = t.matches.reduce((acc, curr) => acc + curr.actualConceded, 0);
    const sumExpectedConceded = t.matches.reduce((acc, curr) => acc + curr.expectedConceded, 0);

    return {
      team: t.team,
      partiteG: t.matches.length,
      actualGoalsScored: sumActualScored,
      expectedGoalsScored: Number(sumExpectedScored.toFixed(1)),
      ratingFormaAttacco: Number(attRating.toFixed(2)),
      actualGoalsConceded: sumActualConceded,
      expectedGoalsConceded: Number(sumExpectedConceded.toFixed(1)),
      ratingFormaDifesa: Number(difRating.toFixed(2))
    };
  }).sort((a, b) => b.ratingFormaAttacco - a.ratingFormaAttacco);
}

// --- ROTAZIONE SCHEDULATA DAEMON ---

async function handleScheduledSimulation(env) {
  const targetLeague = await env.DB_PRONOSTICI.prepare(`
    SELECT campionato FROM parametri_campionato 
    WHERE is_completed = 0 
    ORDER BY last_update ASC LIMIT 1
  `).first();

  if (targetLeague) {
    await runMonteCarloSimulation(targetLeague.campionato, 10000, env);
    const nowTimestamp = new Date().toISOString();
    await env.DB_PRONOSTICI.prepare(`
      UPDATE parametri_campionato SET last_update = ? WHERE campionato = ?
    `).bind(nowTimestamp, targetLeague.campionato).run();
  }
}

// --- INTERFACCIA: DASHBOARD HTML CON TAILWIND & PROFILI COMPATTI ---

const HTML_DASHBOARD = `
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>GOLDBET SIMULATOR</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; background: #000; color: #d4d4d8; }
    .text-cyan-neon { color: #22d3ee; }
    .bg-zinc-dark { background: #09090b; }
    .border-zinc-dark { border: 1px solid #27272a; }

    /* Forzatura Scrollbar Invisibili ma Funzionanti */
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

    /* Sticky per la colonna sinistra (Squadra) */
    .sticky-col {
      position: sticky;
      left: 0;
      background: #000000;
      z-index: 10;
      border-right: 1px solid #27272a;
    }
    
    th.sticky-col {
      background: #09090b;
    }
  </style>
</head>
<body class="bg-black text-zinc-300">

  <!-- HEADER ELITE -->
  <header class="flex justify-between items-center p-5 bg-black border-b border-zinc-800 sticky top-0 z-50">
    <h1 class="text-2xl font-black italic tracking-tighter text-white flex items-center select-none">
      GOLDBET <span class="text-cyan-400 not-italic ml-1">SIMULATOR</span>
      <div class="h-2 w-2 rounded-full bg-cyan-500 animate-pulse ml-3"></div>
    </h1>
    <div class="flex gap-3">
      <button class="text-white hover:text-cyan-400 transition-all text-xl" onclick="switchTab('chaos')">🛡️</button>
      <button class="text-white hover:text-cyan-400 transition-all text-xl" onclick="switchTab('projections')">📊</button>
    </div>
  </header>

  <!-- BARRA DI NAVIGAZIONE INTERNA (TABS COMPATTE) -->
  <div class="flex gap-2 p-3 overflow-x-auto no-scrollbar bg-zinc-950 border-b border-zinc-900 sticky top-[73px] z-40">
    <button class="btn-tab bg-zinc-900 text-zinc-400 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider" onclick="switchTab('chaos')">La Mappa del Caos</button>
    <button class="btn-tab bg-zinc-900 text-zinc-400 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider" onclick="switchTab('projections')">Monte Carlo</button>
    <button class="btn-tab bg-zinc-900 text-zinc-400 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider" onclick="switchTab('xpts')">Classifica di Merito</button>
    <button class="btn-tab bg-zinc-900 text-zinc-400 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider" onclick="switchTab('form')">Forma Reale</button>
  </div>

  <!-- CONTROL PANEL (SELETTORE E TASTO NITRO) -->
  <div class="p-3 flex items-center justify-between gap-3 border-b border-zinc-900 bg-black" id="control-bar" style="display: none;">
    <select id="league-selector" class="bg-zinc-900 border border-zinc-800 text-white rounded p-1.5 text-xs font-bold outline-none flex-grow max-w-xs" onchange="onLeagueChanged()"></select>
    <button id="nitro-btn" class="bg-amber-500 hover:bg-amber-400 text-black px-3 py-1.5 rounded text-[10px] font-black tracking-wider uppercase transition-all shrink-0" onclick="triggerNitro()">NITRO SIM (10K)</button>
  </div>

  <!-- SUB-BARRA DI FILTRAGGIO (CLASSIFICA DI MERITO) -->
  <div class="p-2 flex gap-2 bg-zinc-900 border-b border-zinc-800 justify-center" id="merit-filters" style="display: none;">
    <button class="btn-filter bg-cyan-400 text-black px-3 py-1 rounded text-[9px] font-black uppercase" id="filter-tot" onclick="changeMeritScope('tot')">TOTALI</button>
    <button class="btn-filter bg-zinc-950 text-zinc-500 px-3 py-1 rounded text-[9px] font-black uppercase" id="filter-home" onclick="changeMeritScope('home')">CASA</button>
    <button class="btn-filter bg-zinc-950 text-zinc-500 px-3 py-1 rounded text-[9px] font-black uppercase" id="filter-away" onclick="changeMeritScope('away')">TRASFERTA</button>
  </div>

  <!-- INFORMAZIONI LEGA ATTIVA -->
  <div class="px-4 py-2 bg-zinc-950 border-b border-zinc-900 flex justify-between items-center text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
    <span id="league-info">Caricamento...</span>
    <span class="text-cyan-400" id="league-code">GLOBAL</span>
  </div>

  <!-- DASHBOARD PRINCIPALE -->
  <div class="m-3 overflow-x-auto rounded-lg border border-zinc-800 bg-black no-scrollbar">
    <table class="w-full border-collapse text-center">
      <thead id="table-head"></thead>
      <tbody id="table-body" class="text-xs"></tbody>
    </table>
  </div>

  <!-- POP-UP MODALE: GLASSMORPHISM PER LA MAPPA DEL CAOS -->
  <div id="chaos-modal" class="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[1000] p-4 hidden">
    <div class="bg-zinc-950 border border-zinc-800 p-6 rounded-xl max-w-md w-full relative shadow-2xl shadow-cyan-500/10">
      <span class="absolute top-4 right-4 cursor-pointer text-zinc-500 hover:text-white text-xl select-none" onclick="closeChaosModal()">✖️</span>
      <h2 id="modal-title" class="text-cyan-400 font-black text-lg mb-4 italic uppercase tracking-wider">REGISTRO SCONVOLGIMENTI</h2>
      
      <div class="space-y-4">
        <div class="bg-zinc-900 p-4 rounded border border-zinc-800">
          <div class="text-[9px] text-zinc-500 uppercase tracking-widest font-black mb-1">🔥 SHOCK MATCH DELL'ANNO</div>
          <div class="text-white font-black text-sm uppercase animate-pulse" id="modal-shock-match">-</div>
          <div class="text-[10px] text-zinc-400 mt-1">Risultato Reale: <span class="font-bold text-white" id="modal-shock-score">-</span></div>
          <div class="text-[10px] text-cyan-400 mt-0.5">Probabilità di Esito del Modello: <span class="font-bold text-white font-mono" id="modal-shock-prob">0%</span></div>
        </div>

        <div class="bg-zinc-900 p-4 rounded border border-zinc-800">
          <div class="text-[9px] text-zinc-500 uppercase tracking-widest font-black mb-1">⚠️ SQUADRA "SFASCIA-PRONOSTICI"</div>
          <div class="text-amber-400 font-black text-sm uppercase" id="modal-bracket-buster">-</div>
          <p class="text-[10px] text-zinc-400 mt-1">Questo club genera sistematicamente scostamenti massivi rispetto ai rating attesi, rappresentando l'anomalia tattica principale della lega.</p>
        </div>
      </div>
    </div>
  </div>

  <!-- ANIMAZIONE LOADING -->
  <div id="loading" class="p-12 text-center text-xs font-bold tracking-widest text-zinc-500 uppercase">Dati in elaborazione...</div>

  <!-- NOTIFICA FLOAT TOAST -->
  <div id="toast" class="fixed bottom-4 left-4 right-4 bg-zinc-950 border border-cyan-500 text-cyan-400 p-3 rounded-lg text-xs font-bold text-center select-none shadow-xl shadow-cyan-500/10 transition-all duration-300 transform translate-y-20 opacity-0 z-[1000]"></div>

  <script>
    let activeTab = 'chaos';
    let currentLeague = 'ARG';
    let leagues = [];
    let meritData = [];
    let meritScope = 'tot';
    let rawChaosData = [];

    async function init() {
      try {
        const res = await fetch('/api/leagues');
        leagues = await res.json();
        
        const selector = document.getElementById('league-selector');
        selector.innerHTML = '';
        leagues.forEach(l => {
          const opt = document.createElement('option');
          opt.value = l.div;
          const nazioneSafe = (l.nazione || l.div || "").toUpperCase();
          const descrizioneSafe = (l.descrizione || "").toUpperCase();
          opt.textContent = \`\${nazioneSafe} - \${descrizioneSafe}\`;
          selector.appendChild(opt);
        });

        if (leagues.length > 0) {
          currentLeague = leagues[0].div;
          selector.value = currentLeague;
        }

        switchTab('chaos');
      } catch (err) {
        showToast("Errore di caricamento: " + err.message);
      }
    }

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.className = toast.className.replace("translate-y-20 opacity-0", "translate-y-0 opacity-100");
      setTimeout(() => {
        toast.className = toast.className.replace("translate-y-0 opacity-100", "translate-y-20 opacity-0");
      }, 4000);
    }

    function switchTab(tab) {
      activeTab = tab;
      
      const buttons = document.querySelectorAll('.btn-tab');
      const tabNames = ['chaos', 'projections', 'xpts', 'form'];
      
      buttons.forEach((btn, idx) => {
        if (tabNames[idx] === tab) {
          btn.className = "btn-tab bg-cyan-400 text-black px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider";
        } else {
          btn.className = "btn-tab bg-zinc-900 text-zinc-400 px-3 py-1.5 rounded-full text-[10px] font-black uppercase tracking-wider";
        }
      });

      const controlBar = document.getElementById('control-bar');
      const meritFilters = document.getElementById('merit-filters');

      if (tab === 'chaos') {
        controlBar.style.display = 'none';
        meritFilters.style.display = 'none';
      } else if (tab === 'xpts') {
        controlBar.style.display = 'flex';
        meritFilters.style.display = 'flex';
      } else {
        controlBar.style.display = 'flex';
        meritFilters.style.display = 'none';
      }

      loadData();
    }

    function onLeagueChanged() {
      currentLeague = document.getElementById('league-selector').value;
      loadData();
    }

    async function triggerNitro() {
      const btn = document.getElementById('nitro-btn');
      btn.textContent = 'RUNNING...';
      btn.className = btn.className.replace("bg-amber-500", "bg-zinc-800 text-zinc-500 cursor-not-allowed");
      btn.disabled = true;
      showToast("GOLDBET SIMULATOR avviato (10.000 simulazioni di Monte Carlo)...");

      try {
        const res = await fetch(\`/api/projections?league=\${currentLeague}&nitro=true\`);
        const data = await res.json();
        showToast("Monte Carlo completato e salvato nel database.");
        if (activeTab === 'projections') {
          renderProjections(data.results);
        }
      } catch (err) {
        showToast("Errore di simulazione: " + err.message);
      } finally {
        btn.textContent = 'NITRO SIM (10K)';
        btn.className = btn.className.replace("bg-zinc-800 text-zinc-500 cursor-not-allowed", "bg-amber-500 text-black");
        btn.disabled = false;
      }
    }

    async function loadData() {
      const loading = document.getElementById('loading');
      const tbody = document.getElementById('table-body');
      const thead = document.getElementById('table-head');
      
      loading.style.display = 'block';
      tbody.innerHTML = '';
      thead.innerHTML = '';

      const leagueInfo = document.getElementById('league-info');
      const leagueCode = document.getElementById('league-code');
      const matched = leagues.find(l => l.div === currentLeague);

      if (activeTab === 'chaos') {
        leagueInfo.textContent = 'MAPPA GLOBALE DEL DISORDINE';
        leagueCode.textContent = 'GLOBAL';
      } else {
        const descrizioneSafe = matched ? (matched.descrizione || "").toUpperCase() : currentLeague;
        leagueInfo.textContent = descrizioneSafe;
        leagueCode.textContent = currentLeague;
      }

      try {
        if (activeTab === 'chaos') {
          const res = await fetch('/api/chaos-map');
          rawChaosData = await res.json();
          renderChaosMap(rawChaosData);
        } else if (activeTab === 'projections') {
          const res = await fetch(\`/api/projections?league=\${currentLeague}\`);
          const data = await res.json();
          renderProjections(data.results || []);
        } else if (activeTab === 'xpts') {
          const res = await fetch(\`/api/expected-points?league=\${currentLeague}\`);
          meritData = await res.json();
          renderExpectedPoints();
        } else if (activeTab === 'form') {
          const res = await fetch(\`/api/real-form?league=\${currentLeague}\`);
          const data = await res.json();
          renderRealForm(data);
        }
        loading.style.display = 'none';
      } catch (err) {
        loading.style.display = 'none';
        showToast("Errore nel caricamento dei dati: " + err.message);
      }
    }

    function changeMeritScope(scope) {
      meritScope = scope;
      document.querySelectorAll('.btn-filter').forEach(btn => {
        btn.className = "btn-filter bg-zinc-950 text-zinc-500 px-3 py-1 rounded text-[9px] font-black uppercase";
      });
      document.getElementById(\`filter-\${scope}\`).className = "btn-filter bg-cyan-400 text-black px-3 py-1 rounded text-[9px] font-black uppercase";
      renderExpectedPoints();
    }

    function openChaosModal(league) {
      const item = rawChaosData.find(d => d.league === league);
      if (!item) return;

      const descrizioneSafe = (item.descrizione || "").toUpperCase();
      document.getElementById('modal-title').textContent = \`Dati Caos - \s\${descrizioneSafe}\`;
      
      const mMatch = item.most_shocking_match;
      document.getElementById('modal-shock-match').textContent = \`\${mMatch.home} vs \${mMatch.away}\`;
      document.getElementById('modal-shock-score').textContent = mMatch.score;
      document.getElementById('modal-shock-prob').textContent = \`\${mMatch.prob}%\`;

      document.getElementById('modal-bracket-buster').textContent = item.bracket_buster;

      document.getElementById('chaos-modal').classList.remove('hidden');
    }

    function closeChaosModal() {
      document.getElementById('chaos-modal').classList.add('hidden');
    }

    // --- RENDERING TABELLE CON INTESTAZIONI A DUE LIVELLI ---

    function renderChaosMap(data) {
      const thead = document.getElementById('table-head');
      const tbody = document.getElementById('table-body');

      thead.innerHTML = \`
        <tr class="bg-zinc-900 text-cyan-400 text-[10px] font-black border-b border-zinc-700">
          <th colspan="3" class="p-1 border-r border-zinc-800 text-left sticky-col">REGISTRI DI ANALISI GENERALI</th>
          <th colspan="1" class="p-1">METRICHE</th>
        </tr>
        <tr class="bg-zinc-950 text-zinc-500 text-[9px] uppercase tracking-widest border-b border-zinc-800">
          <th class="p-1 text-left sticky-col">LEGA</th>
          <th class="p-1 text-left">NAZIONE</th>
          <th class="p-1 text-left border-r border-zinc-800">DESCRIZIONE</th>
          <th class="p-1">CAOS INDEX</th>
        </tr>
      \`;

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-zinc-500">Nessun dato di caos disponibile.</td></tr>';
        return;
      }

      data.forEach(item => {
        let chaosColor = 'text-green-500';
        if (item.chaos_index > 70) chaosColor = 'text-red-500';
        else if (item.chaos_index > 55) chaosColor = 'text-amber-500';

        const nazioneSafe = (item.nazione || "").toUpperCase();
        const descrizioneSafe = (item.descrizione || "").toUpperCase();

        tbody.innerHTML += \`
          <tr class="border-b border-zinc-900 hover:bg-zinc-900/40 cursor-pointer text-[10.5px]" onclick="openChaosModal('\${item.league}')">
            <td class="p-1.5 text-left font-black text-white uppercase sticky-col">\${item.league}</td>
            <td class="p-1.5 text-left text-zinc-400 font-bold">\${nazioneSafe}</td>
            <td class="p-1.5 text-left text-zinc-400 border-r border-zinc-900 text-ellipsis overflow-hidden whitespace-nowrap">\${descrizioneSafe}</td>
            <td class="p-1.5 font-bold \${chaosColor} font-mono">\${item.chaos_index}%</td>
          </tr>
        \`;
      });
    }

    function renderProjections(data) {
      const thead = document.getElementById('table-head');
      const tbody = document.getElementById('table-body');

      thead.innerHTML = \`
        <tr class="bg-zinc-900 text-cyan-400 text-[10px] font-black border-b border-zinc-700">
          <th colspan="2" class="p-1 border-r border-zinc-800 text-left sticky-col">PROIEZIONE STANDARD</th>
          <th colspan="4" class="p-1 border-r border-zinc-800">PIAZZAMENTI COPA</th>
          <th colspan="4" class="p-1">COMPETIZIONI DI LEGA</th>
        </tr>
        <tr class="bg-zinc-950 text-zinc-500 text-[9px] uppercase tracking-widest border-b border-zinc-800">
          <th class="p-1 text-left sticky-col">SQUADRA</th>
          <th class="p-1 border-r border-zinc-800">xPTS PROG</th>
          <th class="p-1">🏆</th>
          <th class="p-1">CHL</th>
          <th class="p-1">UEL</th>
          <th class="p-1 border-r border-zinc-800">UECL</th>
          <th class="p-1">PROM.</th>
          <th class="p-1">P.OFF</th>
          <th class="p-1">P.OUT</th>
          <th class="p-1">🔴</th>
        </tr>
      \`;

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="p-4 text-center text-zinc-500">Dati assenti. Usa NITRO SIM per avviare.</td></tr>';
        return;
      }

      data.forEach(item => {
        tbody.innerHTML += \`
          <tr class="border-b border-zinc-900 hover:bg-zinc-900/40 text-[10.5px]">
            <td class="p-1.5 text-left font-black text-white uppercase sticky-col">\ \${item.squadra}</td>
            <td class="p-1.5 font-black text-cyan-400 border-r border-zinc-900 font-mono">\${item.xpts_mediana.toFixed(1)}</td>
            <td class="p-1.5 font-bold \${item.scudetto_prob > 50 ? 'text-amber-400' : 'text-zinc-600'} font-mono">\${item.scudetto_prob.toFixed(1)}%</td>
            <td class="p-1.5 font-bold \${item.ucl_prob > 50 ? 'text-cyan-400' : 'text-zinc-600'} font-mono">\${item.ucl_prob.toFixed(1)}%</td>
            <td class="p-1.5 font-bold \${item.uel_prob > 50 ? 'text-orange-400' : 'text-zinc-600'} font-mono">\${item.uel_prob.toFixed(1)}%</td>
            <td class="p-1.5 font-bold border-r border-zinc-900 \${item.uecl_prob > 50 ? 'text-emerald-400' : 'text-zinc-600'} font-mono">\${item.uecl_prob.toFixed(1)}%</td>
            <td class="p-1.5 font-bold \${item.promo_prob > 50 ? 'text-emerald-400' : 'text-zinc-600'} font-mono">\${item.promo_prob.toFixed(1)}%</td>
            <td class="p-1.5 font-bold \${item.playoff_prob > 50 ? 'text-purple-400' : 'text-zinc-600'} font-mono">\${item.playoff_prob.toFixed(1)}%</td>
            <td class="p-1.5 font-bold \${item.playout_prob > 50 ? 'text-purple-400' : 'text-zinc-600'} font-mono">\${item.playout_prob.toFixed(1)}%</td>
            <td class="p-1.5 font-bold \${item.retro_prob > 50 ? 'text-red-500' : 'text-zinc-600'} font-mono">\${item.retro_prob.toFixed(1)}%</td>
          </tr>
        \`;
      });
    }

    function renderExpectedPoints() {
      const thead = document.getElementById('table-head');
      const tbody = document.getElementById('table-body');

      thead.innerHTML = \`
        <tr class="bg-zinc-900 text-cyan-400 text-[10px] font-black border-b border-zinc-700">
          <th colspan="7" class="p-1 border-r border-zinc-800 text-left sticky-col">CLASSIFICA REALE STATISTICHE</th>
          <th colspan="4" class="p-1">VALORI ATTESI E DIFFERENZE</th>
        </tr>
        <tr class="bg-zinc-950 text-zinc-500 text-[9px] uppercase tracking-widest border-b border-zinc-800">
          <th class="p-1 text-left sticky-col">SQUADRA</th>
          <th class="p-1">PT</th>
          <th class="p-1">V</th>
          <th class="p-1">N</th>
          <th class="p-1">S</th>
          <th class="p-1">GF</th>
          <th class="p-1 border-r border-zinc-800">GS</th>
          <th class="p-1">xPT</th>
          <th class="p-1">xGF</th>
          <th class="p-1">xGS</th>
          <th class="p-1">DIFF</th>
        </tr>
      \`;

      if (!meritData || meritData.length === 0 || meritData.error) {
        tbody.innerHTML = \`<tr><td colspan="11" class="p-4 text-center text-zinc-500">\${meritData?.error || 'Dati non disponibili.'}</td></tr>\`;
        return;
      }

      const formatted = meritData.map(item => {
        const block = item[meritScope];
        return {
          team: item.team,
          points: block.points,
          wins: block.wins,
          draws: block.draws,
          losses: block.losses,
          gf: block.gf,
          gs: block.gs,
          xpt: block.expectedPoints,
          xgf: block.xgf,
          xgs: block.xgs,
          diff: block.diff
        };
      }).sort((a, b) => b.xpt - a.xpt);

      formatted.forEach(item => {
        const isOverperforming = item.diff > 0;
        const diffClass = isOverperforming ? 'text-red-500' : (item.diff < 0 ? 'text-green-500' : 'text-zinc-500');
        const sign = isOverperforming ? '+' : '';

        tbody.innerHTML += \`
          <tr class="border-b border-zinc-900 hover:bg-zinc-900/40 text-[10.5px]">
            <td class="p-1.5 text-left font-black text-white uppercase sticky-col">\${item.team}</td>
            <td class="p-1.5 text-white font-black font-mono">\${item.points}</td>
            <td class="p-1.5 text-zinc-400 font-mono">\${item.wins}</td>
            <td class="p-1.5 text-zinc-400 font-mono">\${item.draws}</td>
            <td class="p-1.5 text-zinc-400 font-mono">\${item.losses}</td>
            <td class="p-1.5 text-zinc-400 font-mono">\${item.gf}</td>
            <td class="p-1.5 text-zinc-400 border-r border-zinc-900 font-mono">\${item.gs}</td>
            <td class="p-1.5 text-cyan-400 font-black font-mono">\${item.xpt.toFixed(2)}</td>
            <td class="p-1.5 text-zinc-500 font-mono">\\ \${item.xgf.toFixed(1)}</td>
            <td class="p-1.5 text-zinc-500 font-mono">\${item.xgs.toFixed(1)}</td>
            <td class="p-1.5 font-black font-mono \${diffClass}">\${sign}\${item.diff.toFixed(2)}</td>
          </tr>
        \`;
      });
    }

    function renderRealForm(data) {
      const thead = document.getElementById('table-head');
      const tbody = document.getElementById('table-body');

      thead.innerHTML = \`
        <tr class="bg-zinc-900 text-cyan-400 text-[10px] font-black border-b border-zinc-700">
          <th colspan="2" class="p-1 border-r border-zinc-800 text-left sticky-col">DATI GENERALI</th>
          <th colspan="3" class="p-1 border-r border-zinc-800">REPARTO ATTACCO (xG - PESATO)</th>
          <th colspan="3" class="p-1">REPARTO DIFESA (xGA - PESATO)</th>
        </tr>
        <tr class="bg-zinc-950 text-zinc-500 text-[9px] uppercase tracking-widest border-b border-zinc-800">
          <th class="p-1 text-left sticky-col">SQUADRA</th>
          <th class="p-1 border-r border-zinc-800">PG</th>
          <th class="p-1">REALI</th>
          <th class="p-1">ATTESI</th>
          <th class="p-1 border-r border-zinc-800">RATING FORM</th>
          <th class="p-1">REALI</th>
          <th class="p-1">ATTESI</th>
          <th class="p-1">RATING FORM</th>
        </tr>
      \`;

      if (data.length === 0 || data.error) {
        tbody.innerHTML = \`<tr><td colspan="8" class="p-4 text-center text-zinc-500">\${data.error || 'Dati non calcolabili.'}</td></tr>\`;
        return;
      }

      data.forEach(item => {
        const attClass = item.ratingFormaAttacco > 0 ? 'text-green-500' : (item.ratingFormaAttacco < 0 ? 'text-red-500' : 'text-zinc-500');
        const difClass = item.ratingFormaDifesa > 0 ? 'text-green-500' : (item.ratingFormaDifesa < 0 ? 'text-red-500' : 'text-zinc-500');

        tbody.innerHTML += \`
          <tr class="border-b border-zinc-900 hover:bg-zinc-900/40 text-[10.5px]">
            <td class="p-1.5 text-left font-black text-white uppercase sticky-col">\${item.team}</td>
            <td class="p-1.5 text-zinc-400 border-r border-zinc-900 font-mono font-bold">\${item.partiteG}</td>
            <td class="p-1.5 text-zinc-300 font-mono">\${item.actualGoalsScored}</td>
            <td class="p-1.5 text-zinc-500 font-mono font-bold">\${item.expectedGoalsScored.toFixed(1)}</td>
            <td class="p-1.5 font-black border-r border-zinc-900 font-mono \${attClass}">\${item.ratingFormaAttacco > 0 ? '+' : ''}\${item.ratingFormaAttacco.toFixed(2)}</td>
            <td class="p-1.5 text-zinc-300 font-mono">\${item.actualGoalsConceded}</td>
            <td class="p-1.5 text-zinc-500 font-mono font-bold">\${item.expectedGoalsConceded.toFixed(1)}</td>
            <td class="p-1.5 font-black font-mono \${difClass}">\${item.ratingFormaDifesa > 0 ? '+' : ''}\${item.ratingFormaDifesa.toFixed(2)}</td>
          </tr>
        \`;
      });
    }

    window.onload = init;
  </script>
</body>
</html>
`;