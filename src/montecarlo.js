/**
 * GOLDBET ANALYST v1.0 - MODULO 4: PREDICTIVE INTELLIGENCE SUITE
 * 
 * Identità Visiva: GOLDBET GUARDIAN (OLED Black, Tailwind CSS, Intestazioni a 2 Livelli)
 * 
 * Sviluppato come "Monolito Serverless" (Strada B):
 * - "/" o "/dashboard" : Fornisce la Dashboard HTML/CSS/JS (Tailwind, OLED Black)
 * - "/api/leagues"     : Elenco delle leghe configurate
 * - "/api/projections" : Simulazioni Monte Carlo (Standard / Nitro Mode)
 * - "/api/expected-points" : Expected Points (xPTS)
 * - "/api/chaos-map"   : Indice di Sorpresa globale (La Mappa del Caos)
 * - "/api/real-form"   : Analisi Forma Reale (Ultime 5 partite xG vs Gol reali)
 * - "/api/debug"       : Diagnostica delle tabelle D1
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 0. Dashboard Grafica Principale (OLED Black / GOLDBET GUARDIAN Style)
      if (path === "/" || path === "/dashboard") {
        return new Response(HTML_DASHBOARD, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      // 1. Endpoint: Elenco delle Leghe
      if (path === "/api/leagues") {
        const leagues = await env.DB_ARCHIVIO.prepare(
          "SELECT div, nazione, descrizione FROM regole_leghe ORDER BY nazione ASC"
        ).all();
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
          const result = await runMonteCarloSimulation(league, 2000, env);
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

      // 4. Endpoint: Classifica di Merito (xPTS)
      if (path === "/api/expected-points") {
        const league = url.searchParams.get("league");
        if (!league) return jsonResponse({ error: "Parametro 'league' mancante." }, 400);

        const xptsTable = await calculateExpectedPoints(league, env);
        return jsonResponse(xptsTable);
      }

      // 5. Endpoint: La Mappa del Caos (Chaos Map)
      if (path === "/api/chaos-map") {
        const chaosMap = await calculateChaosMap(env);
        return jsonResponse(chaosMap);
      }

      // 6. Endpoint: Forma Reale (Last 5 Matches)
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

// --- STRUMENTO DI DIAGNOSTICA (DEBUG) ---

async function runDiagnostics(env) {
  const diagnostics = { database_archivio: {}, database_pronostici: {}, allineamento_codici: {} };
  try {
    const regoleCount = await env.DB_ARCHIVIO.prepare("SELECT COUNT(*) as count FROM regole_leghe").first();
    const matchesCount = await env.DB_ARCHIVIO.prepare("SELECT COUNT(*) as count FROM matches").first();
    const ratingsCount = await env.DB_ARCHIVIO.prepare("SELECT COUNT(*) as count FROM team_ratings").first();
    const lastSeason = await env.DB_ARCHIVIO.prepare("SELECT MAX(season) as season FROM matches").first();

    diagnostics.database_archivio = {
      righe_regole_leghe: regoleCount?.count || 0,
      righe_matches: matchesCount?.count || 0,
      righe_team_ratings: ratingsCount?.count || 0,
      stagione_piu_recente_globale: lastSeason?.season || "Nessuna"
    };

    const parametriCount = await env.DB_PRONOSTICI.prepare("SELECT COUNT(*) as count FROM parametri_campionato").first();
    const proiezioniCount = await env.DB_PRONOSTICI.prepare("SELECT COUNT(*) as count FROM proiezioni_finali").first();

    diagnostics.database_pronostici = {
      righe_parametri_campionato: parametriCount?.count || 0,
      righe_proiezioni_finali: proiezioniCount?.count || 0
    };

    const esempioRegola = await env.DB_ARCHIVIO.prepare("SELECT div FROM regole_leghe LIMIT 3").all();
    const esempioMatch = await env.DB_ARCHIVIO.prepare("SELECT DISTINCT div FROM matches LIMIT 3").all();
    const esempioRating = await env.DB_ARCHIVIO.prepare("SELECT DISTINCT current_div FROM team_ratings LIMIT 3").all();

    diagnostics.allineamento_codici = {
      sigle_in_regole_leghe: esempioRegola.results.map(r => r.div),
      sigle_in_matches: esempioMatch.results.map(r => r.div),
      sigle_in_team_ratings: esempioRating.results.map(r => r.current_div)
    };
  } catch (err) {
    diagnostics.errore_diagnostica = err.message;
  }
  return diagnostics;
}

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

// --- CORE ENGINE 1: SIMULATORE MONTE CARLO (OTTIMIZZATO) ---

async function runMonteCarloSimulation(league, iterations, env) {
  const rules = await env.DB_ARCHIVIO.prepare(
    "SELECT * FROM regole_leghe WHERE div = ?"
  ).bind(league).first();
  if (!rules) throw new Error("Regole non trovate per la lega: " + league);

  const calibration = await env.DB_PRONOSTICI.prepare(
    "SELECT current_rho FROM parametri_campionato WHERE campionato = ?"
  ).bind(league).first();
  const rho = calibration?.current_rho || 0;

  const teamRows = await env.DB_ARCHIVIO.prepare(
    "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
  ).bind(league).all();
  if (!teamRows.results || teamRows.results.length === 0) {
    throw new Error("Nessun rating trovato per la lega: " + league);
  }

  const teams = teamRows.results;
  const teamMap = new Map();
  teams.forEach(t => {
    teamMap.set(t.team_name.toUpperCase().trim(), {
      name: t.team_name,
      elo: t.elo,
      alpha: t.alpha,
      beta: t.beta,
      hFactor: t.h_factor || 1.15
    });
  });

  const currentSeason = await getCurrentSeason(league, env);
  if (!currentSeason) throw new Error("Impossibile determinare la stagione corrente per " + league);

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
    actualStandings[t.team_name.toUpperCase().trim()] = { points: 0, goalsScored: 0, goalsConceded: 0, played: 0 };
  });

  playedMatches.results.forEach(m => {
    const homeKey = m.hometeam.toUpperCase().trim();
    const awayKey = m.awayteam.toUpperCase().trim();

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

  const playedPairs = new Set(playedMatches.results.map(m => `${m.hometeam.toUpperCase().trim()}||${m.awayteam.toUpperCase().trim()}`));
  const remainingCalendar = [];
  
  for (let i = 0; i < teams.length; i++) {
    for (let j = 0; j < teams.length; j++) {
      if (i === j) continue;
      const home = teams[i].team_name.toUpperCase().trim();
      const away = teams[j].team_name.toUpperCase().trim();
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
    stats[t.team_name.toUpperCase().trim()] = {
      name: t.team_name,
      scudetto: 0, ucl: 0, uel: 0, uecl: 0, promo: 0, retro: 0, playoff: 0, playout: 0,
      totalPoints: 0
    };
  });

  const numTeams = rules.num_squadre;
  const isPointHalvingLeague = (league.startsWith("B") || league.startsWith("AUT"));

  for (let sim = 0; sim < iterations; sim++) {
    const simStandings = {};
    teams.forEach(t => {
      const key = t.team_name.toUpperCase().trim();
      simStandings[key] = { 
        points: actualStandings[key].points,
        goalsScored: actualStandings[key].goalsScored,
        goalsConceded: actualStandings[key].goalsConceded,
        played: actualStandings[key].played
      };
    });

    for (const match of resolvedCalendar) {
      if (rules.soglia_split > 0 && simStandings[match.homeKey].played >= rules.soglia_split) {
        continue; 
      }
      simulateResolvedMatch(match, simStandings, rho, rules.giornate_totali, false);
    }

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

      for (const match of resolvedCalendar) {
        const sameGroup = (midTopGroup.has(match.homeKey) && midTopGroup.has(match.awayKey)) || 
                          (!midTopGroup.has(match.homeKey) && !midTopGroup.has(match.awayKey));
        
        if (sameGroup) {
          simulateResolvedMatch(match, simStandings, rho, rules.giornate_totali, true);
        }
      }
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

function simulateResolvedMatch(match, standings, rho, maxGames, isSplitPhase) {
  const home = match.homeObj;
  const away = match.awayObj;

  let alphaH = home.alpha;
  let betaH = home.beta;
  let alphaA = away.alpha;
  let betaA = away.beta;

  const eloDiff = home.elo - away.elo;
  const eloScale = 1 + eloDiff * 0.0002;

  let lambda = alphaH * betaA * home.hFactor * eloScale;
  let mu = (alphaA * betaH) / eloScale;

  lambda = Math.max(0.05, Math.min(8.0, lambda));
  mu = Math.max(0.05, Math.min(8.0, mu));

  const gamesLeftH = maxGames - standings[match.homeKey].played;
  const gamesLeftA = maxGames - standings[match.awayKey].played;

  if (gamesLeftH <= 6 || isSplitPhase) {
    const hPoints = standings[match.homeKey].points;
    const aPoints = standings[match.awayKey].points;
    if (Math.abs(hPoints - aPoints) < 6) {
      lambda *= 1.05;
    } else if (hPoints > 45 && hPoints < 55) {
      lambda *= 0.95;
    }
  }

  const homeGoals = drawPoisson(lambda);
  const awayGoals = drawPoisson(mu);

  let finalHomeGoals = homeGoals;
  let finalAwayGoals = awayGoals;
  if (homeGoals <= 1 && awayGoals <= 1) {
    const tau = getDixonColesTau(homeGoals, awayGoals, lambda, mu, rho);
    if (Math.random() > tau) {
      if (Math.random() > 0.5) {
        finalHomeGoals = finalAwayGoals;
      }
    }
  }

  standings[match.homeKey].played++;
  standings[match.awayKey].played++;
  standings[match.homeKey].goalsScored += finalHomeGoals;
  standings[match.homeKey].goalsConceded += finalAwayGoals;
  standings[match.awayKey].goalsScored += finalAwayGoals;
  standings[match.awayKey].goalsConceded += finalHomeGoals;

  if (finalHomeGoals > finalAwayGoals) {
    standings[match.homeKey].points += 3;
  } else if (finalAwayGoals > finalHomeGoals) {
    standings[match.awayKey].points += 3;
  } else {
    standings[match.homeKey].points += 1;
    standings[match.awayKey].points += 1;
  }
}

// --- CORE ENGINE 2: CLASSIFICA DI MERITO (Expected Points - xPTS) ---

async function calculateExpectedPoints(league, env) {
  const currentSeason = await getCurrentSeason(league, env);
  if (!currentSeason) return { error: "Nessuna partita disputata per la stagione corrente." };

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

  const teamRows = await env.DB_ARCHIVIO.prepare(
    "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
  ).bind(league).all();

  const teamMap = new Map();
  teamRows.results.forEach(t => teamMap.set(t.team_name.toUpperCase().trim(), t));

  const calibration = await env.DB_PRONOSTICI.prepare(
    "SELECT current_rho FROM parametri_campionato WHERE campionato = ?"
  ).bind(league).first();
  const rho = calibration?.current_rho || 0;

  const xPtsTable = {};
  teamRows.results.forEach(t => {
    const key = t.team_name.toUpperCase().trim();
    xPtsTable[key] = { team: t.team_name, actualPoints: 0, expectedPoints: 0, diff: 0, played: 0 };
  });

  matches.results.forEach(m => {
    const homeKey = m.hometeam.toUpperCase().trim();
    const awayKey = m.awayteam.toUpperCase().trim();

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
        if (h <= 1 && a <= 1) {
          prob *= getDixonColesTau(h, a, lambda, mu, rho);
        }
        if (h > a) pWin += prob;
        else if (h === a) pDraw += prob;
        else pLoss += prob;
      }
    }

    const sum = pWin + pDraw + pLoss;
    pWin /= sum; pDraw /= sum; pLoss /= sum;

    const xPtsHome = pWin * 3 + pDraw * 1;
    const xPtsAway = pLoss * 3 + pDraw * 1;

    xPtsTable[homeKey].played++;
    xPtsTable[awayKey].played++;
    xPtsTable[homeKey].expectedPoints += xPtsHome;
    xPtsTable[awayKey].expectedPoints += xPtsAway;

    if (m.ftr === "H") xPtsTable[homeKey].actualPoints += 3;
    else if (m.ftr === "A") xPtsTable[awayKey].actualPoints += 3;
    else {
      xPtsTable[homeKey].actualPoints += 1;
      xPtsTable[awayKey].actualPoints += 1;
    }
  });

  return Object.values(xPtsTable).map(t => {
    t.expectedPoints = Number(t.expectedPoints.toFixed(2));
    t.diff = Number((t.actualPoints - t.expectedPoints).toFixed(2));
    return t;
  }).sort((a, b) => b.expectedPoints - a.expectedPoints);
}

function factorial(n) {
  if (n === 0 || n === 1) return 1;
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

// --- CORE ENGINE 3: INDICE DI SORPRESA (La Mappa del Caos) ---

async function calculateChaosMap(env) {
  const leaguesRes = await env.DB_ARCHIVIO.prepare("SELECT div, nazione, descrizione FROM regole_leghe").all();
  const result = [];

  for (const league of leaguesRes.results) {
    const currentSeason = await getCurrentSeason(league.div, env);
    if (!currentSeason) continue;

    const matches = await env.DB_ARCHIVIO.prepare(`
      SELECT 
        ht.name as hometeam,
        at.name as awayteam,
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
    teamRows.results.forEach(t => teamMap.set(t.team_name.toUpperCase().trim(), t));

    let totalShock = 0;
    let count = 0;

    matches.results.forEach(m => {
      const homeKey = m.hometeam.toUpperCase().trim();
      const awayKey = m.awayteam.toUpperCase().trim();

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

      totalShock += (1 - pOutcome);
      count++;
    });

    if (count > 0) {
      result.push({
        league: league.div,
        nazione: league.nazione,
        descrizione: league.descrizione,
        chaos_index: Number((totalShock / count * 100).toFixed(1)),
        matches_analyzed: count
      });
    }
  }

  return result.sort((a, b) => b.chaos_index - a.chaos_index);
}

// --- CORE ENGINE 4: INDICE DI FORMA REALE ---

async function calculateRealForm(league, env) {
  const currentSeason = await getCurrentSeason(league, env);
  if (!currentSeason) return { error: "Stagione non trovata." };

  const teamRows = await env.DB_ARCHIVIO.prepare(
    "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
  ).bind(league).all();

  const teamMap = new Map();
  const formTable = {};
  teamRows.results.forEach(t => {
    const key = t.team_name.toUpperCase().trim();
    teamMap.set(key, t);
    formTable[key] = { team: t.team_name, actualGoalsScored: 0, expectedGoalsScored: 0, actualGoalsConceded: 0, expectedGoalsConceded: 0, ratingFormaAttacco: 0, ratingFormaDifesa: 0, partiteG: 0 };
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
    const homeKey = m.hometeam.toUpperCase().trim();
    const awayKey = m.awayteam.toUpperCase().trim();

    const home = teamMap.get(homeKey);
    const away = teamMap.get(awayKey);
    if (!home || !away) return;

    const hForm = formTable[homeKey];
    const aForm = formTable[awayKey];

    const eloDiff = home.elo - away.elo;
    const eloScale = 1 + eloDiff * 0.0002;
    const lambda = home.alpha * away.beta * (home.h_factor || 1.15) * eloScale;
    const mu = (away.alpha * home.beta) / eloScale;

    if (hForm.partiteG < 5) {
      hForm.partiteG++;
      hForm.actualGoalsScored += m.fthg;
      hForm.expectedGoalsScored += lambda;
      hForm.actualGoalsConceded += m.ftag;
      hForm.expectedGoalsConceded += mu;
    }

    if (aForm.partiteG < 5) {
      aForm.partiteG++;
      aForm.actualGoalsScored += m.ftag;
      aForm.expectedGoalsScored += mu;
      aForm.actualGoalsConceded += m.fthg;
      aForm.expectedGoalsConceded += lambda;
    }
  });

  return Object.values(formTable).map(t => {
    t.ratingFormaAttacco = Number((t.actualGoalsScored - t.expectedGoalsScored).toFixed(2));
    t.ratingFormaDifesa = Number((t.expectedGoalsConceded - t.actualGoalsConceded).toFixed(2));
    t.expectedGoalsScored = Number(t.expectedGoalsScored.toFixed(2));
    t.expectedGoalsConceded = Number(t.expectedGoalsConceded.toFixed(2));
    return t;
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
      UPDATE parametri_campionato 
      SET last_update = ? 
      WHERE campionato = ?
    `).bind(nowTimestamp, targetLeague.campionato).run();
  }
}

// --- INTERFACCIA: DASHBOARD HTML CON TAILWIND & INT. A 2 LIVELLI ---

const HTML_DASHBOARD = `
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>GOLDBET GUARDIAN</title>
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
      GOLDBET <span class="text-cyan-400 not-italic ml-1">GUARDIAN</span>
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
    <button id="nitro-btn" class="bg-amber-500 hover:bg-amber-400 text-black px-3 py-1.5 rounded text-[10px] font-black tracking-wider uppercase transition-all shrink-0" onclick="triggerNitro()">NITRO SIM (2K)</button>
  </div>

  <!-- INFORMAZIONI LEGA ATTIVA -->
  <div class="px-4 py-2 bg-zinc-950 border-b border-zinc-900 flex justify-between items-center text-[10px] uppercase font-bold text-zinc-500 tracking-wider">
    <span id="league-info">Caricamento...</span>
    <span class="text-cyan-400" id="league-code">GLOBAL</span>
  </div>

  <!-- DASHBOARD PRINCIPALE (TABELLA A 2 LIVELLI) -->
  <div class="m-3 overflow-x-auto rounded-lg border border-zinc-800 bg-black no-scrollbar">
    <table class="w-full border-collapse text-center">
      <thead id="table-head"></thead>
      <tbody id="table-body" class="text-xs"></tbody>
    </table>
  </div>

  <!-- ANIMAZIONE LOADING -->
  <div id="loading" class="p-12 text-center text-xs font-bold tracking-widest text-zinc-500 uppercase">Dati in elaborazione...</div>

  <!-- NOTIFICA FLOAT TOAST -->
  <div id="toast" class="fixed bottom-4 left-4 right-4 bg-zinc-950 border border-cyan-500 text-cyan-400 p-3 rounded-lg text-xs font-bold text-center select-none shadow-xl shadow-cyan-500/10 transition-all duration-300 transform translate-y-20 opacity-0 z-[1000]"></div>

  <script>
    let activeTab = 'chaos';
    let currentLeague = 'ARG';
    let leagues = [];

    async function init() {
      try {
        const res = await fetch('/api/leagues');
        leagues = await res.json();
        
        const selector = document.getElementById('league-selector');
        selector.innerHTML = '';
        leagues.forEach(l => {
          const opt = document.createElement('option');
          opt.value = l.div;
          opt.textContent = \`\${l.nazione.toUpperCase()} - \${l.descrizione.toUpperCase()}\`;
          selector.appendChild(opt);
        });

        if (leagues.length > 0) {
          currentLeague = leagues[0].div;
          selector.value = currentLeague;
        }

        switchTab('chaos');
      } catch (err) {
        showToast("Errore di inizializzazione: " + err.message);
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
      if (tab === 'chaos') {
        controlBar.style.display = 'none';
      } else {
        controlBar.style.display = 'flex';
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
      showToast("Motore simulativo ad alte prestazioni avviato (2K cicli)...");

      try {
        const res = await fetch(\`/api/projections?league=\${currentLeague}&nitro=true\`);
        const data = await res.json();
        showToast("Simulazione completata e registrata con successo!");
        if (activeTab === 'projections') {
          renderProjections(data.results);
        }
      } catch (err) {
        showToast("Errore di esecuzione: " + err.message);
      } finally {
        btn.textContent = 'NITRO SIM (2K)';
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
        leagueInfo.textContent = matched ? matched.descrizione : currentLeague;
        leagueCode.textContent = currentLeague;
      }

      try {
        if (activeTab === 'chaos') {
          const res = await fetch('/api/chaos-map');
          const data = await res.json();
          renderChaosMap(data);
        } else if (activeTab === 'projections') {
          const res = await fetch(\`/api/projections?league=\${currentLeague}\`);
          const data = await res.json();
          renderProjections(data.results || []);
        } else if (activeTab === 'xpts') {
          const res = await fetch(\`/api/expected-points?league=\${currentLeague}\`);
          const data = await res.json();
          renderExpectedPoints(data);
        } else if (activeTab === 'form') {
          const res = await fetch(\`/api/real-form?league=\${currentLeague}\`);
          const data = await res.json();
          renderRealForm(data);
        }
        loading.style.display = 'none';
      } catch (err) {
        loading.style.display = 'none';
        showToast("Errore nel recupero dati: " + err.message);
      }
    }

    // --- LOGICHE DI RENDERING TABELLE A 2 LIVELLI (DIRETTIVA GOLDBET COERENTE) ---

    function renderChaosMap(data) {
      const thead = document.getElementById('table-head');
      const tbody = document.getElementById('table-body');

      thead.innerHTML = \`
        <tr class="bg-zinc-900 text-cyan-400 text-[10px] font-black border-b border-zinc-700">
          <th colspan="3" class="p-2 border-r border-zinc-800 text-left sticky-col">INFORMAZIONI GENERALI</th>
          <th colspan="1" class="p-2">METRICHE</th>
        </tr>
        <tr class="bg-zinc-950 text-zinc-500 text-[9px] uppercase tracking-widest border-b border-zinc-800">
          <th class="p-2 text-left sticky-col">LEGA</th>
          <th class="p-2 text-left">NAZIONE</th>
          <th class="p-2 text-left border-r border-zinc-800">DESCRIZIONE</th>
          <th class="p-2">CAOS INDEX</th>
        </tr>
      \`;

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="p-4 text-center text-zinc-500">Nessun dato sufficiente rilevato.</td></tr>';
        return;
      }

      data.forEach(item => {
        let chaosColor = 'text-green-500';
        if (item.chaos_index > 70) chaosColor = 'text-red-500';
        else if (item.chaos_index > 55) chaosColor = 'text-amber-500';

        tbody.innerHTML += \`
          <tr class="border-b border-zinc-900 hover:bg-zinc-900/40">
            <td class="p-2 text-left font-black text-white text-[10.5px] uppercase sticky-col">\${item.league}</td>
            <td class="p-2 text-left text-zinc-400 font-bold">\${item.nazione.toUpperCase()}</td>
            <td class="p-2 text-left text-zinc-400 border-r border-zinc-900 text-ellipsis overflow-hidden whitespace-nowrap">\${item.descrizione.toUpperCase()}</td>
            <td class="p-2 font-bold \${chaosColor}">\${item.chaos_index}%</td>
          </tr>
        \`;
      });
    }

    function renderProjections(data) {
      const thead = document.getElementById('table-head');
      const tbody = document.getElementById('table-body');

      thead.innerHTML = \`
        <tr class="bg-zinc-900 text-cyan-400 text-[10px] font-black border-b border-zinc-700">
          <th colspan="2" class="p-2 border-r border-zinc-800 text-left sticky-col">PROIEZIONE STANDARD</th>
          <th colspan="4" class="p-2 border-r border-zinc-800">PIAZZAMENTI COPA</th>
          <th colspan="4" class="p-2">COMPETIZIONI DI LEGA</th>
        </tr>
        <tr class="bg-zinc-950 text-zinc-500 text-[9px] uppercase tracking-widest border-b border-zinc-800">
          <th class="p-2 text-left sticky-col">SQUADRA</th>
          <th class="p-2 border-r border-zinc-800">xPTS PROG</th>
          <th class="p-2">SCUDETTO</th>
          <th class="p-2">CHAMPIONS</th>
          <th class="p-2">EUROPA L.</th>
          <th class="p-2 border-r border-zinc-800">CONFERENCE</th>
          <th class="p-2">PROMOZIONE</th>
          <th class="p-2">PLAYOFF</th>
          <th class="p-2">PLAYOUT</th>
          <th class="p-2">RETROCES.</th>
        </tr>
      \`;

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" class="p-4 text-center text-zinc-500">Dati assenti. Usa NITRO SIM per avviare.</td></tr>';
        return;
      }

      data.forEach(item => {
        tbody.innerHTML += \`
          <tr class="border-b border-zinc-900 hover:bg-zinc-900/40">
            <td class="p-2 text-left font-black text-white text-[10.5px] uppercase sticky-col">\${item.squadra}</td>
            <td class="p-2 font-black text-cyan-400 border-r border-zinc-900">\${item.xpts_mediana.toFixed(1)}</td>
            <td class="p-2 font-bold \${item.scudetto_prob > 50 ? 'text-amber-400' : 'text-zinc-600'}">\${item.scudetto_prob.toFixed(1)}%</td>
            <td class="p-2 font-bold \${item.ucl_prob > 50 ? 'text-cyan-400' : 'text-zinc-600'}">\${item.ucl_prob.toFixed(1)}%</td>
            <td class="p-2 font-bold \${item.uel_prob > 50 ? 'text-orange-400' : 'text-zinc-600'}">\${item.uel_prob.toFixed(1)}%</td>
            <td class="p-2 font-bold border-r border-zinc-900 \${item.uecl_prob > 50 ? 'text-emerald-400' : 'text-zinc-600'}">\${item.uecl_prob.toFixed(1)}%</td>
            <td class="p-2 font-bold \${item.promo_prob > 50 ? 'text-emerald-400' : 'text-zinc-600'}">\${item.promo_prob.toFixed(1)}%</td>
            <td class="p-2 font-bold \${item.playoff_prob > 50 ? 'text-purple-400' : 'text-zinc-600'}">\${item.playoff_prob.toFixed(1)}%</td>
            <td class="p-2 font-bold \${item.playout_prob > 50 ? 'text-purple-400' : 'text-zinc-600'}">\${item.playout_prob.toFixed(1)}%</td>
            <td class="p-2 font-bold \${item.retro_prob > 50 ? 'text-red-500' : 'text-zinc-600'}">\${item.retro_prob.toFixed(1)}%</td>
          </tr>
        \`;
      });
    }

    function renderExpectedPoints(data) {
      const thead = document.getElementById('table-head');
      const tbody = document.getElementById('table-body');

      thead.innerHTML = \`
        <tr class="bg-zinc-900 text-cyan-400 text-[10px] font-black border-b border-zinc-700">
          <th colspan="3" class="p-2 border-r border-zinc-800 text-left sticky-col">CLASSIFICA REALE</th>
          <th colspan="2" class="p-2">METRICA MERITO</th>
        </tr>
        <tr class="bg-zinc-950 text-zinc-500 text-[9px] uppercase tracking-widest border-b border-zinc-800">
          <th class="p-2 text-left sticky-col">SQUADRA</th>
          <th class="p-2">PG</th>
          <th class="p-2 border-r border-zinc-800">PUNTI REALI</th>
          <th class="p-2">EXPECTED POINTS</th>
          <th class="p-2">SCOSTAMENTO (DIFF)</th>
        </tr>
      \`;

      if (data.length === 0 || data.error) {
        tbody.innerHTML = \`<tr><td colspan="5" class="p-4 text-center text-zinc-500">\${data.error || 'Dati non disponibili.'}</td></tr>\`;
        return;
      }

      data.forEach(item => {
        const isOverperforming = item.diff > 0;
        const diffClass = isOverperforming ? 'text-red-500' : (item.diff < 0 ? 'text-green-500' : 'text-zinc-500');
        const sign = isOverperforming ? '+' : '';

        tbody.innerHTML += \`
          <tr class="border-b border-zinc-900 hover:bg-zinc-900/40">
            <td class="p-2 text-left font-black text-white text-[10.5px] uppercase sticky-col">\${item.team}</td>
            <td class="p-2 text-zinc-400 font-bold">\${item.played}</td>
            <td class="p-2 text-zinc-400 font-bold border-r border-zinc-900">\${item.actualPoints}</td>
            <td class="p-2 font-bold text-cyan-400">\${item.expectedPoints.toFixed(2)}</td>
            <td class="p-2 font-black \${diffClass}">\${sign}\${item.diff}</td>
          </tr>
        \`;
      });
    }

    function renderRealForm(data) {
      const thead = document.getElementById('table-head');
      const tbody = document.getElementById('table-body');

      thead.innerHTML = \`
        <tr class="bg-zinc-900 text-cyan-400 text-[10px] font-black border-b border-zinc-700">
          <th colspan="2" class="p-2 border-r border-zinc-800 text-left sticky-col">DATI GENERALI</th>
          <th colspan="3" class="p-2 border-r border-zinc-800">REPARTO ATTACCO (xG)</th>
          <th colspan="3" class="p-2">REPARTO DIFESA (xGA)</th>
        </tr>
        <tr class="bg-zinc-950 text-zinc-500 text-[9px] uppercase tracking-widest border-b border-zinc-800">
          <th class="p-2 text-left sticky-col">SQUADRA</th>
          <th class="p-2 border-r border-zinc-800">PG</th>
          <th class="p-2">REALI</th>
          <th class="p-2">ATTESI</th>
          <th class="p-2 border-r border-zinc-800">RATING FORM</th>
          <th class="p-2">REALI</th>
          <th class="p-2">ATTESI</th>
          <th class="p-2">RATING FORM</th>
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
          <tr class="border-b border-zinc-900 hover:bg-zinc-900/40">
            <td class="p-2 text-left font-black text-white text-[10.5px] uppercase sticky-col">\${item.team}</td>
            <td class="p-2 text-zinc-400 border-r border-zinc-900 font-bold">\${item.partiteG}</td>
            <td class="p-2 text-zinc-300">\text-zinc-300\${item.actualGoalsScored}</td>
            <td class="p-2 text-zinc-500 font-bold">\${item.expectedGoalsScored}</td>
            <td class="p-2 font-black border-r border-zinc-900 \${attClass}">\${item.ratingFormaAttacco > 0 ? '+' : ''}\${item.ratingFormaAttacco}</td>
            <td class="p-2 text-zinc-300">\${item.actualGoalsConceded}</td>
            <td class="p-2 text-zinc-500 font-bold">\${item.expectedGoalsConceded}</td>
            <td class="p-2 font-black \${difClass}">\${item.ratingFormaDifesa > 0 ? '+' : ''}\${item.ratingFormaDifesa}</td>
          </tr>
        \`;
      });
    }

    window.onload = init;
  </script>
</body>
</html>
`;