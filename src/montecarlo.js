/**
 * GOLDBET ANALYST v1.0 - MODULO 4: PREDICTIVE INTELLIGENCE SUITE
 * 
 * Funzionalità integrate:
 * 1. Simulatore Monte Carlo della Stagione (Gestione Split Belgio/Austria e Tensione Agonistica)
 * 2. Classifica di Merito (Expected Points - xPTS)
 * 3. Indice di Sorpresa (La Mappa del Caos)
 * 4. Indice di Forma Reale (Analisi degli sbilanciamenti rispetto ai gol attesi degli ultimi 5 match)
 * 5. Diagnostica di Sistema (/api/debug)
 * 
 * Ottimizzazione Relazionale: Utilizza JOIN sulla tabella 'teams' tramite ID numerici
 * per evitare disallineamenti di stringhe da football-data.co.uk.
 */

export default {
  // Gestore delle richieste HTTP
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // 0. Endpoint di Debug (Diagnostica del Database)
      if (path === "/api/debug") {
        const debugData = await runDiagnostics(env);
        return jsonResponse(debugData);
      }

      // 1. Endpoint: Simulazione Nitro o Lettura Proiezioni
      if (path === "/api/projections") {
        const league = url.searchParams.get("league");
        if (!league) return jsonResponse({ error: "Parametro 'league' mancante." }, 400);

        const forceSimulate = url.searchParams.get("nitro") === "true";

        if (forceSimulate) {
          // Nitro Mode: esegue una simulazione rapida a 2.000 iterazioni in tempo reale
          const result = await runMonteCarloSimulation(league, 2000, env);
          return jsonResponse({ mode: "nitro", ...result });
        }

        // Lettura ordinaria da DB_PRONOSTICI (con caching Edge di 2 ore)
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

      // 2. Endpoint: Classifica di Merito (Expected Points - xPTS)
      if (path === "/api/expected-points") {
        const league = url.searchParams.get("league");
        if (!league) return jsonResponse({ error: "Parametro 'league' mancante." }, 400);

        const xptsTable = await calculateExpectedPoints(league, env);
        return jsonResponse(xptsTable);
      }

      // 3. Endpoint: Indice di Sorpresa (La Mappa del Caos)
      if (path === "/api/chaos-map") {
        const chaosMap = await calculateChaosMap(env);
        return jsonResponse(chaosMap);
      }

      // 4. Endpoint: Indice di Forma Reale (Ultime 5 Partite)
      if (path === "/api/real-form") {
        const league = url.searchParams.get("league");
        if (!league) return jsonResponse({ error: "Parametro 'league' mancante." }, 400);

        const realForm = await calculateRealForm(league, env);
        return jsonResponse(realForm);
      }

      // Risposta di cortesia per la Home Page
      if (path === "/") {
        return jsonResponse({
          status: "online",
          module: "Predictive Intelligence Suite v1.0",
          endpoints_disponibili: [
            "/api/debug",
            "/api/chaos-map",
            "/api/projections?league=SIGLA",
            "/api/expected-points?league=SIGLA",
            "/api/real-form?league=SIGLA"
          ]
        });
      }

      return jsonResponse({ error: "Endpoint non trovato." }, 404);

    } catch (err) {
      return jsonResponse({ error: "Internal Server Error", details: err.message }, 500);
    }
  },

  // Daemon orario (Cron Trigger): simula a rotazione la lega con aggiornamento più vecchio
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduledSimulation(env));
  }
};

// --- STRUMENTO DI DIAGNOSTICA (DEBUG) ---

async function runDiagnostics(env) {
  const diagnostics = {
    database_archivio: {},
    database_pronostici: {},
    allineamento_codici: {}
  };

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

// --- FUNZIONI DI SUPPORTO E DI GESTIONE ---

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=10"
    }
  });
}

// Generatore Poisson tramite algoritmo di Knuth (ultra-veloce)
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

// Algoritmo di correzione Dixon-Coles per punteggi bassi (0-0, 1-0, 0-1, 1-1)
function getDixonColesTau(x, y, lambda, mu, rho) {
  if (x === 0 && y === 0) return 1 - lambda * mu * rho;
  if (x === 1 && y === 0) return 1 + mu * rho;
  if (x === 0 && y === 1) return 1 + lambda * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

// Estrazione della stagione corrente basata sul record più recente nel database per la specifica lega
async function getCurrentSeason(league, env) {
  const res = await env.DB_ARCHIVIO.prepare(
    "SELECT MAX(season) as current_season FROM matches WHERE div = ?"
  ).bind(league).first();
  return res?.current_season || null;
}

// --- CORE ENGINE 1: SIMULATORE MONTE CARLO ---

async function runMonteCarloSimulation(league, iterations, env) {
  const rules = await env.DB_ARCHIVIO.prepare(
    "SELECT * FROM regole_leghe WHERE div = ?"
  ).bind(league).first();
  if (!rules) throw new Error("Regole non trovate per la lega: " + league);

  const calibration = await env.DB_PRONOSTICI.prepare(
    "SELECT current_rho FROM parametri_campionato WHERE campionato = ?"
  ).bind(league).first();
  const rho = calibration?.current_rho || 0;

  // Caricamento dei rating in memoria con chiave in UPPERCASE per allineamento perfetto
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

  // Estrazione partite giocate con JOIN relazionale su 'teams' per nomi ufficiali
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

  // Creazione del calendario rimanente
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

  // Pre-risoluzione dei puntatori in memoria prima di lanciare il ciclo Monte Carlo
  const resolvedCalendar = remainingCalendar.map(match => {
    return {
      homeKey: match.home,
      awayKey: match.away,
      homeObj: teamMap.get(match.home),
      awayObj: teamMap.get(match.away)
    };
  }).filter(m => m.homeObj && m.awayObj); // Esclude eventuali accoppiamenti orfani

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

  // LOOP DI MONTE CARLO (Altamente ottimizzato)
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

    // Simulazione calendario standard
    for (const match of resolvedCalendar) {
      if (rules.soglia_split > 0 && simStandings[match.homeKey].played >= rules.soglia_split) {
        continue; 
      }
      simulateResolvedMatch(match, simStandings, rho, rules.giornate_totali, false);
    }

    // Gestione dello split
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

// Funzione interna per simulare il singolo match pre-risolto in memoria
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

    if (matches.results.length < 15) continue; // Salta se i dati sono troppo scarsi

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