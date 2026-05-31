/**
 * GOLDBET ANALYST v1.0 - MODULO 4: PREDICTIVE INTELLIGENCE SUITE
 * 
 * Funzionalità integrate:
 * 1. Simulatore Monte Carlo della Stagione (Gestione Split Belgio/Austria e Tensione Agonistica)
 * 2. Classifica di Merito (Expected Points - xPTS)
 * 3. Indice di Sorpresa (La Mappa del Caos)
 * 4. Indice di Forma Reale (Analisi degli sbilanciamenti rispetto ai gol attesi degli ultimi 5 match)
 */

export default {
  // Gestore delle richieste HTTP (Dashboard SPA / Richieste Nitro)
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
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

// --- FUNZIONI DI SUPPORTO E DI GESTIONE ERRORI ---

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=60"
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

// Estrazione della stagione corrente basata sul record più recente nel database
async function getCurrentSeason(league, env) {
  const res = await env.DB_ARCHIVIO.prepare(
    "SELECT MAX(season) as current_season FROM matches WHERE div = ?"
  ).bind(league).first();
  return res?.current_season || null;
}

// --- CORE ENGINE 1: SIMULATORE MONTE CARLO ---

async function runMonteCarloSimulation(league, iterations, env) {
  // A. Recupero Regole della Lega
  const rules = await env.DB_ARCHIVIO.prepare(
    "SELECT * FROM regole_leghe WHERE div = ?"
  ).bind(league).first();
  if (!rules) throw new Error("Regole non trovate per la lega: " + league);

  // B. Recupero Parametro Rho calibrato
  const calibration = await env.DB_PRONOSTICI.prepare(
    "SELECT current_rho FROM parametri_campionato WHERE campionato = ?"
  ).bind(league).first();
  const rho = calibration?.current_rho || 0;

  // C. Recupero Rating e Forze Squadre
  const teamRows = await env.DB_ARCHIVIO.prepare(
    "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
  ).bind(league).all();
  if (!teamRows.results || teamRows.results.length === 0) {
    throw new Error("Nessun rating trovato per la lega: " + league);
  }

  const teams = teamRows.results;
  const teamMap = new Map();
  teams.forEach(t => {
    teamMap.set(t.team_name, {
      name: t.team_name,
      elo: t.elo,
      alpha: t.alpha,
      beta: t.beta,
      hFactor: t.h_factor || 1.15
    });
  });

  // D. Recupero Match Giocati e Costruzione Classifica Attuale
  const currentSeason = await getCurrentSeason(league, env);
  if (!currentSeason) throw new Error("Impossibile determinare la stagione corrente per " + league);

  const playedMatches = await env.DB_ARCHIVIO.prepare(
    "SELECT hometeam, awayteam, fthg, ftag, ftr FROM matches WHERE div = ? AND season = ? ORDER BY date ASC"
  ).bind(league, currentSeason).all();

  // Inizializzazione Classifica Reale
  const actualStandings = {};
  teams.forEach(t => {
    actualStandings[t.team_name] = { points: 0, goalsScored: 0, goalsConceded: 0, played: 0 };
  });

  playedMatches.results.forEach(m => {
    if (actualStandings[m.hometeam] && actualStandings[m.awayteam]) {
      actualStandings[m.hometeam].played++;
      actualStandings[m.awayteam].played++;
      actualStandings[m.hometeam].goalsScored += m.fthg;
      actualStandings[m.hometeam].goalsConceded += m.ftag;
      actualStandings[m.awayteam].goalsScored += m.ftag;
      actualStandings[m.awayteam].goalsConceded += m.fthg;

      if (m.ftr === "H") {
        actualStandings[m.hometeam].points += 3;
      } else if (m.ftr === "A") {
        actualStandings[m.awayteam].points += 3;
      } else {
        actualStandings[m.hometeam].points += 1;
        actualStandings[m.awayteam].points += 1;
      }
    }
  });

  // E. Sottrazione per ottenere il Calendario Rimanente
  const playedPairs = new Set(playedMatches.results.map(m => `${m.hometeam}||${m.awayteam}`));
  const remainingCalendar = [];
  
  for (let i = 0; i < teams.length; i++) {
    for (let j = 0; j < teams.length; j++) {
      if (i === j) continue;
      const home = teams[i].team_name;
      const away = teams[j].team_name;
      if (!playedPairs.has(`${home}||${away}`)) {
        remainingCalendar.push({ home, away });
      }
    }
  }

  // F. Contatori Statistici per le 10.000 (o 2.000) Iterazioni
  const stats = {};
  teams.forEach(t => {
    stats[t.team_name] = {
      scudetto: 0, ucl: 0, uel: 0, uecl: 0, promo: 0, retro: 0, playoff: 0, playout: 0,
      totalPoints: 0
    };
  });

  const numTeams = rules.num_squadre;
  const isPointHalvingLeague = (league.startsWith("B") || league.startsWith("AUT")); // Belgio o Austria

  // LOOP DI MONTE CARLO
  for (let sim = 0; sim < iterations; sim++) {
    const simStandings = {};
    teams.forEach(t => {
      simStandings[t.team_name] = { 
        name: t.team_name,
        points: actualStandings[t.team_name].points,
        goalsScored: actualStandings[t.team_name].goalsScored,
        goalsConceded: actualStandings[t.team_name].goalsConceded,
        played: actualStandings[t.team_name].played
      };
    });

    // Simulazione del Calendario Standard
    for (const match of remainingCalendar) {
      // Controllo per le Leghe con Split (se si supera la soglia di sbarramento, saltiamo le simulazioni inter-poule temporaneamente)
      if (rules.soglia_split > 0 && simStandings[match.home].played >= rules.soglia_split) {
        continue; 
      }

      simulateMatch(match.home, match.away, simStandings, teamMap, rho, rules.giornate_totali, false);
    }

    // Gestione dello "Split" (Campionati Dinamici come Belgio/Austria/Scozia)
    if (rules.soglia_split > 0) {
      // 1. Classifica temporanea alla soglia di split
      const midStandings = Object.values(simStandings).sort((a, b) => b.points - a.points || (b.goalsScored - b.goalsConceded) - (a.goalsScored - a.goalsConceded));
      const midTopGroup = new Set(midStandings.slice(0, numTeams / 2).map(x => x.name));

      // 2. Applicazione eventuale dimezzamento punti (Belgio e Austria)
      if (isPointHalvingLeague) {
        teams.forEach(t => {
          simStandings[t.team_name].points = Math.ceil(simStandings[t.team_name].points / 2);
        });
      }

      // 3. Simulazione della seconda fase (scontri diretti all'interno del proprio gruppo)
      for (const match of remainingCalendar) {
        const sameGroup = (midTopGroup.has(match.home) && midTopGroup.has(match.away)) || 
                          (!midTopGroup.has(match.home) && !midTopGroup.has(match.away));
        
        if (sameGroup) {
          simulateMatch(match.home, match.away, simStandings, teamMap, rho, rules.giornate_totali, true);
        }
      }
    }

    // Calcolo Classifica Finale per l'iterazione corrente
    const finalStandings = Object.values(simStandings).sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const gdB = b.goalsScored - b.goalsConceded;
      const gdA = a.goalsScored - a.goalsConceded;
      if (gdB !== gdA) return gdB - gdA;
      return b.goalsScored - a.goalsScored;
    });

    // Aggiornamento dei contatori obiettivi basato sulle regole della lega
    finalStandings.forEach((team, rank) => {
      const idx = rank + 1; // Classifica da 1 a N
      const s = stats[team.name];
      s.totalPoints += team.points;

      if (idx === 1) s.scudetto++;
      
      // Zona Coppe Europee
      if (idx > 1 && idx <= rules.posti_ucl) s.ucl++;
      if (idx > rules.posti_ucl && idx <= (rules.posti_ucl + rules.posti_uel)) s.uel++;
      if (idx > (rules.posti_ucl + rules.posti_uel) && idx <= (rules.posti_ucl + rules.posti_uel + rules.posti_uecl)) s.uecl++;

      // Promozione e Playoff/Playout
      if (rules.posti_promo && idx <= rules.posti_promo) s.promo++;
      if (rules.playoff && idx > rules.posti_promo && idx <= (rules.posti_promo + rules.playoff)) s.playoff++;
      if (rules.playout && idx >= (numTeams - rules.posti_retro - rules.playout + 1) && idx <= (numTeams - rules.posti_retro)) s.playout++;

      // Zona Retrocessione
      if (idx > (numTeams - rules.posti_retro)) s.retro++;
    });
  }

  // G. Preparazione ed invio dei risultati per il Database
  const bulkData = [];
  const timestamp = new Date().toISOString();

  for (const teamName of Object.keys(stats)) {
    const s = stats[teamName];
    const item = {
      campionato: league,
      squadra: teamName,
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

    // Scrittura immediata o differita in DB_PRONOSTICI
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

  return { league, simulated_matches_remaining: remainingCalendar.length, iterations, results: bulkData };
}

// Funzione interna per simulare il singolo match con correzione ELO, Dixon-Coles e Tensione Agonistica
function simulateMatch(homeName, awayName, standings, teamMap, rho, maxGames, isSplitPhase) {
  const home = teamMap.get(homeName);
  const away = teamMap.get(awayName);

  let alphaH = home.alpha;
  let betaH = home.beta;
  let alphaA = away.alpha;
  let betaA = away.beta;

  // 1. Integrazione dello Scarto ELO (Sensibilità 0.0002 come da accordi Modulo 3)
  const eloDiff = home.elo - away.elo;
  const eloScale = 1 + eloDiff * 0.0002;

  // 2. Calcolo dei Gol Attesi Lamda (Home) e Mu (Away)
  let lambda = alphaH * betaA * home.hFactor * eloScale;
  let mu = (alphaA * betaH) / eloScale;

  // Limiti di sicurezza per evitare valori matematicamente impossibili
  lambda = Math.max(0.05, Math.min(8.0, lambda));
  mu = Math.max(0.05, Math.min(8.0, mu));

  // 3. Tensione Agonistica (Applicata nelle ultime 6 giornate della stagione regolare o nella fase split)
  const gamesLeftH = maxGames - standings[homeName].played;
  const gamesLeftA = maxGames - standings[awayName].played;

  if (gamesLeftH <= 6 || isSplitPhase) {
    // Se la squadra è in lotta per traguardi o salvezza, riceve un bonus del 5% di intensità.
    // Se è nella zona neutra del limbo, cala l'attenzione (-5% di malus).
    // Nota: la logica semplificata simula questa oscillazione sulla base della deviazione dei punti.
    const hPoints = standings[homeName].points;
    const aPoints = standings[awayName].points;
    if (Math.abs(hPoints - aPoints) < 6) {
      lambda *= 1.05; // Intensità da scontro diretto
    } else if (hPoints > 45 && hPoints < 55) {
      lambda *= 0.95; // Effetto vacanza mentale
    }
  }

  // 4. Calcolo del Risultato esatto tramite Poisson
  const homeGoals = drawPoisson(lambda);
  const awayGoals = drawPoisson(mu);

  // 5. Correzione Dixon-Coles tramite parametro Rho (influenza i pareggi a bassi gol)
  let finalHomeGoals = homeGoals;
  let finalAwayGoals = awayGoals;
  if (homeGoals <= 1 && awayGoals <= 1) {
    const tau = getDixonColesTau(homeGoals, awayGoals, lambda, mu, rho);
    if (Math.random() > tau) {
      // Se il fattore correttivo fallisce, ridistribuiamo l'esito verso un pareggio o punteggio plausibile
      if (Math.random() > 0.5) {
        finalHomeGoals = finalAwayGoals; // Forza il pareggio
      }
    }
  }

  // Aggiornamento statistiche del match simulato
  standings[homeName].played++;
  standings[awayName].played++;
  standings[homeName].goalsScored += finalHomeGoals;
  standings[homeName].goalsConceded += finalAwayGoals;
  standings[awayName].goalsScored += finalAwayGoals;
  standings[awayName].goalsConceded += finalHomeGoals;

  if (finalHomeGoals > finalAwayGoals) {
    standings[homeName].points += 3;
  } else if (finalAwayGoals > finalHomeGoals) {
    standings[awayName].points += 3;
  } else {
    standings[homeName].points += 1;
    standings[awayName].points += 1;
  }
}

// --- CORE ENGINE 2: CLASSIFICA DI MERITO (Expected Points - xPTS) ---

async function calculateExpectedPoints(league, env) {
  const currentSeason = await getCurrentSeason(league, env);
  if (!currentSeason) return { error: "Nessuna partita disputata per la stagione corrente." };

  const matches = await env.DB_ARCHIVIO.prepare(
    "SELECT hometeam, awayteam, fthg, ftag, ftr FROM matches WHERE div = ? AND season = ?"
  ).bind(league, currentSeason).all();

  const teamRows = await env.DB_ARCHIVIO.prepare(
    "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
  ).bind(league).all();

  const teamMap = new Map();
  teamRows.results.forEach(t => teamMap.set(t.team_name, t));

  const calibration = await env.DB_PRONOSTICI.prepare(
    "SELECT current_rho FROM parametri_campionato WHERE campionato = ?"
  ).bind(league).first();
  const rho = calibration?.current_rho || 0;

  const xPtsTable = {};
  teamRows.results.forEach(t => {
    xPtsTable[t.team_name] = { team: t.team_name, actualPoints: 0, expectedPoints: 0, diff: 0, played: 0 };
  });

  matches.results.forEach(m => {
    const home = teamMap.get(m.hometeam);
    const away = teamMap.get(m.awayteam);
    if (!home || !away) return;

    // Calcolo probabilità reali tramite Dixon-Coles Poisson
    const eloDiff = home.elo - away.elo;
    const eloScale = 1 + eloDiff * 0.0002;
    const lambda = Math.max(0.05, home.alpha * away.beta * (home.h_factor || 1.15) * eloScale);
    const mu = Math.max(0.05, (away.alpha * home.beta) / eloScale);

    // Calcolo probabilità esatte (fino a max 5 gol per lato)
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

    // Normalizzazione
    const sum = pWin + pDraw + pLoss;
    pWin /= sum; pDraw /= sum; pLoss /= sum;

    // Assegnazione Punti Reali ed Expected Points
    const xPtsHome = pWin * 3 + pDraw * 1;
    const xPtsAway = pLoss * 3 + pDraw * 1;

    xPtsTable[m.hometeam].played++;
    xPtsTable[m.awayteam].played++;
    xPtsTable[m.hometeam].expectedPoints += xPtsHome;
    xPtsTable[m.awayteam].expectedPoints += xPtsAway;

    if (m.ftr === "H") xPtsTable[m.hometeam].actualPoints += 3;
    else if (m.ftr === "A") xPtsTable[m.awayteam].actualPoints += 3;
    else {
      xPtsTable[m.hometeam].actualPoints += 1;
      xPtsTable[m.awayteam].actualPoints += 1;
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

    const matches = await env.DB_ARCHIVIO.prepare(
      "SELECT hometeam, awayteam, ftr FROM matches WHERE div = ? AND season = ?"
    ).bind(league.div, currentSeason).all();

    if (matches.results.length < 15) continue; // Salta se i dati sono insufficienti per fare statistica

    const teamRows = await env.DB_ARCHIVIO.prepare(
      "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
    ).bind(league.div).all();

    const teamMap = new Map();
    teamRows.results.forEach(t => teamMap.set(t.team_name, t));

    let totalShock = 0;
    let count = 0;

    matches.results.forEach(m => {
      const home = teamMap.get(m.hometeam);
      const away = teamMap.get(m.awayteam);
      if (!home || !away) return;

      const eloDiff = home.elo - away.elo;
      const eloScale = 1 + eloDiff * 0.0002;
      const lambda = home.alpha * away.beta * (home.h_factor || 1.15) * eloScale;
      const mu = (away.alpha * home.beta) / eloScale;

      // Probabilità semplificata dell'esito
      const sumG = lambda + mu;
      const pWin = lambda / (sumG || 1);
      const pLoss = mu / (sumG || 1);
      const pDraw = 0.26; // Stima empirica di baseline per i pareggi

      let pOutcome = pDraw;
      if (m.ftr === "H") pOutcome = pWin * (1 - pDraw);
      if (m.ftr === "A") pOutcome = pLoss * (1 - pDraw);

      // Lo shock è l'inverso della probabilità assegnata all'evento reale: 1 - P_esito
      totalShock += (1 - pOutcome);
      count++;
    });

    if (count > 0) {
      result.push({
        league: league.div,
        nazione: league.nazione,
        descrizione: league.descrizione,
        chaos_index: Number((totalShock / count * 100).toFixed(1)), // Percentuale di imprevedibilità
        matches_analyzed: count
      });
    }
  }

  return result.sort((a, b) => b.chaos_index - a.chaos_index);
}

// --- CORE ENGINE 4: INDICE DI FORMA REALE (Last 5 Matches xG vs Real Goals) ---

async function calculateRealForm(league, env) {
  const currentSeason = await getCurrentSeason(league, env);
  if (!currentSeason) return { error: "Stagione non trovata." };

  const teamRows = await env.DB_ARCHIVIO.prepare(
    "SELECT team_name, elo, alpha, beta, h_factor FROM team_ratings WHERE current_div = ?"
  ).bind(league).all();

  const teamMap = new Map();
  const formTable = {};
  teamRows.results.forEach(t => {
    teamMap.set(t.team_name, t);
    formTable[t.team_name] = { team: t.team_name, actualGoalsScored: 0, expectedGoalsScored: 0, actualGoalsConceded: 0, expectedGoalsConceded: 0, ratingFormaAttacco: 0, ratingFormaDifesa: 0, partiteG: 0 };
  });

  // Estraiamo tutti i match della lega ordinati per data per pescare solo gli ultimi 5 di ogni squadra
  const matches = await env.DB_ARCHIVIO.prepare(
    "SELECT hometeam, awayteam, fthg, ftag FROM matches WHERE div = ? AND season = ? ORDER BY date DESC"
  ).bind(league, currentSeason).all();

  matches.results.forEach(m => {
    const home = teamMap.get(m.hometeam);
    const away = teamMap.get(m.awayteam);
    if (!home || !away) return;

    // Estraiamo solo gli ultimi 5 match effettivi per ogni squadra
    const hForm = formTable[m.hometeam];
    const aForm = formTable[m.awayteam];

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
    // Differenza tra gol fatti e gol attesi (positivo = freddezza sotto porta / sovra-performance)
    t.ratingFormaAttacco = Number((t.actualGoalsScored - t.expectedGoalsScored).toFixed(2));
    // Differenza tra gol subiti e attesi subiti (negativo = ottima fase difensiva o portiere in stato di grazia)
    t.ratingFormaDifesa = Number((t.expectedGoalsConceded - t.actualGoalsConceded).toFixed(2));
    
    t.expectedGoalsScored = Number(t.expectedGoalsScored.toFixed(2));
    t.expectedGoalsConceded = Number(t.expectedGoalsConceded.toFixed(2));
    return t;
  }).sort((a, b) => b.ratingFormaAttacco - a.ratingFormaAttacco);
}

// --- ROTAZIONE SCHEDULATA DAEMON ---

async function handleScheduledSimulation(env) {
  // Trova il campionato che non viene aggiornato da più tempo
  const targetLeague = await env.DB_PRONOSTICI.prepare(`
    SELECT campionato FROM parametri_campionato 
    WHERE is_completed = 0 
    ORDER BY last_update ASC LIMIT 1
  `).first();

  if (targetLeague) {
    // Esegue la simulazione standard completa a 10.000 iterazioni in background per evitare timeout
    await runMonteCarloSimulation(targetLeague.campionato, 10000, env);
    
    // Aggiorna il timestamp di completamento nel database dei pronostici
    const nowTimestamp = new Date().toISOString();
    await env.DB_PRONOSTICI.prepare(`
      UPDATE parametri_campionato 
      SET last_update = ? 
      WHERE campionato = ?
    `).bind(nowTimestamp, targetLeague.campionato).run();
  }
}