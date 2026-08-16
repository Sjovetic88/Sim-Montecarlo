// =========================================================================
// GOLDBET MONTECARLO - MASTER WORKER COMPLETAMENTE OPTIMIZZATO E DETTAGLIATO
// =========================================================================
// Sincronizzatore e simulatore predittivo sequenziale ad altissime prestazioni.
// Previene il superamento dei limiti di Cloudflare delegando la coda al browser.
// =========================================================================

// Dizionario statico contenente le emoji delle bandiere per i campionati
const LEAGUE_FLAGS = {
  "ARG": "🇦🇷", "B1": "🇧🇪", "BRA": "🇧🇷", "CHN": "🇨🇳", "D1": "🇩🇪", "D2": "🇩🇪",
  "DNK": "🇩🇰", "IRL": "🇮🇪", "MEX": "🇲🇽", "NOR": "🇳🇴", "P1": "🇵🇹", "RUS": "🇷🇺",
  "SWE": "🇸🇪", "T1": "🇹🇷", "USA": "🇺🇸", "E0": "🇬🇧", "E1": "🇬🇧", "I1": "🇮🇹",
  "I2": "🇮🇹", "SP1": "🇪🇸", "F1": "🇫🇷", "N1": "🇳🇱", "G1": "🇬🇷", "AUT": "🇦🇹", "SWZ": "🇨🇭"
};

// Dizionario statico contenente i nomi estesi dei campionati gestiti
const LEAGUE_NAMES = {
  "ARG": "ARGENTINA", "B1": "BELGIUM", "BRA": "BRAZIL", "CHN": "CHINA", "D1": "GERMANY",
  "D2": "GERMANY D2", "DNK": "DENMARK", "IRL": "IRELAND", "MEX": "MEXICO", "NOR": "NORWAY",
  "P1": "PORTUGAL", "RUS": "RUSSIA", "SWE": "SWEDEN", "T1": "TURKEY", "USA": "USA",
  "E0": "ENGLAND PREMIER", "E1": "ENGLAND CHAMPIONSHIP", "I1": "ITALY SERIE A",
  "I2": "ITALY SERIE B", "SP1": "SPAIN LA LIGA", "F1": "FRANCE LIGUE 1", "N1": "NETHERLANDS EREDIVISIE"
};

// Calcola il fattoriale di un numero intero (necessario per la formula di Poisson)
function factorial(n) {
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

// Calcola la probabilità di Poisson per K eventi data una media attesa Lambda (es. gol attesi)
function poissonProb(k, lambda) {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

// Traduttore dinamico per allineare i formati delle stagioni con il DB di archivio
// Converte formati come "2025/2026" o "2025/26" in "2526", lasciando inalterato "2026"
function translateSeason(seasonStr) {
  if (!seasonStr) return "2026";
  const trimmed = seasonStr.trim();
  if (trimmed.indexOf("/") !== -1) {
    const parts = trimmed.split("/");
    const part1 = parts[0].trim();
    const part2 = parts[1].trim();
    const y1 = part1.substring(part1.length - 2);
    const y2 = part2.substring(part2.length - 2);
    return y1 + y2;
  }
  if (trimmed.indexOf("-") !== -1) {
    const parts = trimmed.split("-");
    const part1 = parts[0].trim();
    const part2 = parts[1].trim();
    const y1 = part1.substring(part1.length - 2);
    const y2 = part2.substring(part2.length - 2);
    return y1 + y2;
  }
  return trimmed;
}

// Algoritmo di Hashing Polinomiale per generare ID numerici unici a partire da una stringa.
// Previene le collisioni di primary key fra calendari di campionati diversi.
function generateNumericHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

export default {
  // Gestore principale delle richieste HTTP in ingresso nel Worker Cloudflare
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dbArchivio = env.DB_ARCHIVIO;
    const dbSoglie = env.DB_SOGLIE;

    // -------------------------------------------------------------------------
    // ROTTA 1: GET /matches
    // Restituisce le tabelle delle classifiche simulate e del calendario reale
    // -------------------------------------------------------------------------
    if (url.pathname === "/matches") {
      const leagueDiv = url.searchParams.get("league");
      if (!leagueDiv) {
        return new Response("Campionato mancante", { status: 400 });
      }
      try {
        // Estrae la classifica risultante dalle simulazioni Monte Carlo salvata nel DB SOGLIE
        const simRes = await dbSoglie.prepare(
          "SELECT team_name, avg_points, win_pct, europe_pct, relegation_pct FROM simulazioni_classifica WHERE league_div = ? ORDER BY avg_points DESC"
        ).bind(leagueDiv).all();

        // Estrae il calendario delle partite reali e simulate salvate nel DB SOGLIE
        const matches = await dbSoglie.prepare(
          "SELECT event_date, home_team_name_api, away_team_name_api, goals_home, goals_away, status FROM calendario_partite WHERE league_div = ? ORDER BY event_date ASC"
        ).bind(leagueDiv).all();

        // Ritorna i dati strutturati in JSON per il rendering leggero ed efficiente client-side
        return new Response(JSON.stringify({
          standings: simRes.results || [],
          calendar: matches.results || []
        }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // -------------------------------------------------------------------------
    // ROTTA 2: GET /cron-trigger
    // Endpoint richiamabile da cron-job.org per l'elaborazione automatica delle 7:00
    // -------------------------------------------------------------------------
    if (url.pathname === "/cron-trigger") {
      const token = url.searchParams.get("token");
      const expectedToken = env.CRON_TOKEN || "goldbet_cron_secret_777";
      if (token !== expectedToken) {
        return new Response("Non autorizzato", { status: 401 });
      }

      // Avvia l'elaborazione sequenziale automatica di tutte le leghe attive in background
      ctx.waitUntil(
        runAutomatedCronSync(dbArchivio, dbSoglie)
      );

      return new Response(JSON.stringify({ success: true, message: "Sincronizzazione automatica avviata" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // -------------------------------------------------------------------------
    // ROTTA 3: GET /status
    // Ritorna le metriche generali, lo stato e il progresso di gioco di ogni lega
    // -------------------------------------------------------------------------
    if (url.pathname === "/status") {
      try {
        const lastSyncRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'last_sync'").first();
        const statusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        const errorRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'error'").first();
        const seasonRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'current_season'").first();
        const nitroRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'nitro_mode'").first();

        const lastSync = lastSyncRes ? lastSyncRes.value : "MAI AGGIORNATO";
        const syncStatus = statusRes ? statusRes.value : "idle";
        const syncError = errorRes ? errorRes.value : null;
        const currentSeason = seasonRes ? seasonRes.value : "N.D.";
        const nitroMode = nitroRes ? nitroRes.value : "1";

        const leagueStates = await dbSoglie.prepare("SELECT metric, value FROM api_status WHERE metric LIKE 'sync_league_%'").all();
        const statesMap = {};
        if (leagueStates.results) {
          for (let i = 0; i < leagueStates.results.length; i++) {
            const r = leagueStates.results[i];
            const code = r.metric.replace("sync_league_", "");
            statesMap[code] = r.value;
          }
        }

        const countRes = await dbSoglie.prepare("SELECT COUNT(*) as totale FROM calendario_partite").first();
        const totalePartite = countRes ? countRes.totale : 0;

        // Query cumulativa per ottenere il conteggio totale e giocato di tutti i campionati
        const progressRes = await dbSoglie.prepare(
          "SELECT league_div, COUNT(*) as totale, SUM(CASE WHEN status = 'Played' THEN 1 ELSE 0 END) as giocate FROM calendario_partite GROUP BY league_div"
        ).all();
        const progressMap = {};
        if (progressRes.results) {
          for (let i = 0; i < progressRes.results.length; i++) {
            const pr = progressRes.results[i];
            progressMap[pr.league_div] = {
              totale: pr.totale,
              giocate: pr.giocate || 0
            };
          }
        }

        const resObj = {
          status: syncStatus,
          lastSync: lastSync,
          error: syncError,
          totale: totalePartite,
          season: currentSeason,
          nitro: nitroMode,
          leagues: statesMap,
          progress: progressMap
        };

        return new Response(JSON.stringify(resObj), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // -------------------------------------------------------------------------
    // ROTTA 4: POST /mode
    // Aggiorna lo stato visivo dello schermo per regolare dinamicamente la velocità
    // -------------------------------------------------------------------------
    if (url.pathname === "/mode" && request.method === "POST") {
      try {
        const state = url.searchParams.get("state");
        const val = state === "visible" ? "1" : "0";
        await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('nitro_mode', ?)").bind(val).run();
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // -------------------------------------------------------------------------
    // ROTTA 5: POST /pause
    // Invia un segnale di pausa salvando lo stato 'paused' nel database SOGLIE
    // -------------------------------------------------------------------------
    if (url.pathname === "/pause" && request.method === "POST") {
      try {
        await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'paused')").run();
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // -------------------------------------------------------------------------
    // ROTTA 6: POST /reset
    // Cancella tutti i dati pregressi di calendario e proiezioni per ripartire da zero
    // -------------------------------------------------------------------------
    if (url.pathname === "/reset" && request.method === "POST") {
      try {
        const resetStatements = [
          dbSoglie.prepare("DELETE FROM calendario_partite"),
          dbSoglie.prepare("DELETE FROM simulazioni_classifica"),
          dbSoglie.prepare("UPDATE api_status SET value = 'pending' WHERE metric LIKE 'sync_league_%'"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('last_sync', 'DATI RESETTATI')"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('current_season', 'N.D.')"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', NULL)"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'idle')")
        ];
        await dbSoglie.batch(resetStatements);
        
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // -------------------------------------------------------------------------
    // ROTTA 8: GET / (DASHBOARD)
    // Costruisce e serve la pagina web con gestione sequenziale del browser e Wake Lock
    // -------------------------------------------------------------------------
    if (url.pathname === "/") {
      try {
        const statusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        const lastSyncRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'last_sync'").first();
        const errorRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'error'").first();
        const seasonRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'current_season'").first();
        const nitroRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'nitro_mode'").first();
        
        const lastSync = lastSyncRes ? lastSyncRes.value : "MAI AGGIORNATO";
        const syncStatus = statusRes ? statusRes.value : "idle";
        const syncError = errorRes ? errorRes.value : null;
        const currentSeason = seasonRes ? seasonRes.value : "N.D.";
        const nitroMode = nitroRes ? nitroRes.value : "1";

        // Estrae la lista dei campionati configurati nel database ARCHIVIO
        const leghe = await dbArchivio.prepare("SELECT id, name, emoji, is_active FROM leagues ORDER BY id ASC").all();
        const listaLeghe = leghe.results || [];

        const countRes = await dbSoglie.prepare("SELECT COUNT(*) as totale FROM calendario_partite").first();
        const totalePartite = countRes ? countRes.totale : 0;

        // Caricamento cumulativo iniziale del progresso per non fare query ripetitive
        const progRes = await dbSoglie.prepare(
          "SELECT league_div, COUNT(*) as totale, SUM(CASE WHEN status = 'Played' THEN 1 ELSE 0 END) as giocate FROM calendario_partite GROUP BY league_div"
        ).all();
        const initialProgress = {};
        if (progRes.results) {
          for (let p = 0; p < progRes.results.length; p++) {
            const pr = progRes.results[p];
            initialProgress[pr.league_div] = {
              totale: pr.totale,
              giocate: pr.giocate || 0
            };
          }
        }

        let html = "<!DOCTYPE html><html><head><title>Goldbet Montecarlo</title>";
        html += "<meta name='viewport' content='width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'>";
        html += "<style>";
        html += "body { font-family:'Segoe UI',sans-serif; background:#000; color:#f8fafc; padding:10px 10px 100px 10px; margin:0; box-sizing:border-box; }";
        html += ".container { max-width:480px; margin:0 auto; }";
        html += ".header-title { text-align:center; font-size:24px; font-weight:800; letter-spacing:1px; margin-top:10px; margin-bottom:4px; }";
        html += ".header-title span.white { color:#fff; }";
        html += ".header-title span.neon { color:#00ebff; }";
        html += ".subtitle-stats { text-align:center; color:#94a3b8; font-size:12px; font-weight:bold; margin-bottom:4px; }";
        html += ".subtitle-stats span.neon { color:#00ebff; }";
        html += ".subtitle-time { text-align:center; color:#00ebff; font-size:10px; font-weight:800; letter-spacing:1px; margin-bottom:25px; text-transform:uppercase; }";
        html += ".league-item { background:#0f172a; border:1px solid #1e293b; margin-bottom:12px; padding:14px; border-radius:8px; cursor:pointer; position:relative; transition:box-shadow 0.2s; }";
        html += ".league-item:hover { background:#1e293b; }";
        html += ".league-item.selected { border-color:#00ebff !important; box-shadow:0 0 10px rgba(0,235,255,0.4); }";
        html += ".league-item.nitro-glowing { border-color:#f97316 !important; box-shadow:0 0 15px rgba(249,115,22,0.6); }";
        html += ".league-item.inactive { opacity:0.35; cursor:not-allowed; }";
        html += ".league-header { display:flex; justify-content:space-between; align-items:center; font-weight:bold; font-size:14px; }";
        html += ".league-header span.title { display:flex; align-items:center; gap:8px; color:#fff; }";
        html += ".league-header span.pct { color:#00ebff; font-weight:800; }";
        html += ".league-header span.lock { color:#ef4444; font-weight:bold; }";
        html += ".league-sub { font-size:11px; color:#64748b; margin-top:4px; }";
        html += ".accordion-content { display:none; margin-top:10px; border-top:1px solid #1e293b; padding-top:10px; }";
        html += ".tab-btn { background:none; border:1px solid #1e293b; color:#64748b; padding:6px 12px; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold; margin-right:6px; }";
        html += ".tab-btn.active { border-color:#00ebff; color:#00ebff; }";
        html += ".tab-content { display:none; margin-top:10px; }";
        html += ".tab-content.active { display:block; }";
        html += ".bottom-nav { position:fixed; bottom:0; left:0; right:0; background:#090d16; border-top:1px solid #1e293b; display:flex; justify-content:space-around; padding:10px 0; z-index:1000; }";
        html += ".nav-btn { background:none; border:none; display:flex; flex-direction:column; align-items:center; color:#64748b; cursor:pointer; width:20%; }";
        html += ".nav-btn-active { color:#00ebff !important; }";
        html += ".nav-icon { font-size:20px; margin-bottom:3px; }";
        html += ".nav-label { font-size:7.5px; font-weight:bold; text-transform:uppercase; }";
        html += ".nitro-active { color:#f97316 !important; filter:drop-shadow(0 0 8px rgba(249,115,22,0.6)); }";
        html += "table { width:100%; border-collapse:collapse; font-size:11px; color:#cbd5e1; margin-top:5px; }";
        html += "th,td { padding:6px; text-align:left; border-bottom:1px solid #1e293b; }";
        html += "th { color:#94a3b8; font-weight:bold; }";
        html += "</style></head><body>";
        html += "<div class='container'>";
        html += "<div class='header-title'><span class='white'>GOLDBET</span> <span class='neon'>MONTECARLO</span></div>";
        html += "<div class='subtitle-stats'><span id='stat-totale' class='neon'>" + totalePartite + "</span> PARTITE SALVATE | STAGIONE <span id='stat-season' class='neon'>" + currentSeason + "</span></div>";
        html += "<div class='subtitle-time'>ULTIMO AGGIORNAMENTO <span id='stat-last-sync'>" + lastSync + "</span></div>";

        if (syncStatus === "running") {
          html += "<div id='sync-msg' class='status-running-msg'>Sincronizzazione o Elaborazione attiva... ricarica tra poco per seguire l'avanzamento.</div>";
        } else {
          html += "<div id='sync-msg' style='display:none;' class='status-running-msg'></div>";
        }

        if (syncError) {
          html += "<div id='error-box' class='error-box'><strong>Ultimo Errore:</strong> " + syncError + "</div>";
        } else {
          html += "<div id='error-box' class='error-box' style='display:none;'></div>";
        }

        html += "<div class='league-list'>";
        
        for (let i = 0; i < listaLeghe.length; i++) {
          const l = listaLeghe[i];
          const code = l.id;
          const isActive = l.is_active;
          
          const lStatusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'sync_league_' || ?").bind(code).first();
          const lStatus = lStatusRes ? lStatusRes.value : "pending";
          
          let pct = "0.0%";
          if (lStatus === "syncing") {
            pct = "SYNCING";
          } else if (lStatus === "completed") {
            pct = "100.0%";
          }

          const flag = l.emoji || "";
          const fullLabel = code + " " + l.name;

          // Inserisce il progresso "Giocate/Totale" invece della sola data nell'interfaccia iniziale
          const pInfo = initialProgress[code] || { totale: 0, giocate: 0 };
          const tot = pInfo.totale;
          const gio = pInfo.giocate;

          if (isActive === 0) {
            html += "<div class='league-item inactive' id='card-" + code + "'>";
            html += "<div class='league-header'>";
            html += "<span class='title'><span>" + flag + "</span> " + fullLabel + "</span>";
            html += "<span class='lock'>⛔</span>";
            html += "</div>";
            html += "<div class='league-sub'>";
            html += "<span>⚠️</span> <span>Campionato non abilitato dal Legislatore</span>";
            html += "</div>";
            html += "</div>";
          } else {
            // Genera la card attiva con un legame d'ascolto onclick sicuro e senza caratteri di escape
            // BUG FIX: Isolata la card con event.stopPropagation() sull'accordion-content per evitare il collasso automatico al click dei tab
            html += "<div class='league-item' id='card-" + code + "' onclick='toggleLeague(" + '"' + code + '"' + ")' data-active='1'>";
            html += "<div class='league-header'>";
            html += "<span class='title'><span>" + flag + "</span> " + fullLabel + "</span>";
            html += "<span id='pct-" + code + "' class='pct'>" + pct + "</span>";
            html += "</div>";
            html += "<div class='league-sub'>";
            html += "<span>📅</span> <span id='sub-" + code + "'>" + (lStatus === "completed" ? "Giocate: " + gio + " / " + tot : "Calendario calcolato autonomamente") + "</span>";
            html += "</div>";
            html += "<div class='accordion-content' id='content-" + code + "' onclick='event.stopPropagation()'>";
            html += "Caricamento partite...";
            html += "</div>";
            html += "</div>";
          }
        }
        html += "</div>";
        html += "</div>";

        // BARRA DI NAVIGAZIONE A 5 PULSANTI (ALL, START, PAUSA, NITRO, RESET)
        html += "<div class='bottom-nav'>";
        html += "<button onclick='toggleAll()' class='nav-btn nav-btn-active'><span class='nav-icon'>☑️</span><span class='nav-label'>ALL</span></button>";
        html += "<button id='btn-start' onclick='startSequentialSync()' class='nav-btn' style='color: #10b981;'><span class='nav-icon'>▶️</span><span class='nav-label'>START</span></button>";
        html += "<button id='btn-pause' onclick='pauseSequentialSync()' class='nav-btn' style='color: #f59e0b;'><span class='nav-icon'>⏸️</span><span class='nav-label'>PAUSA</span></button>";
        
        const isNitroActive = nitroMode === "1" ? "nitro-active" : "";
        html += "<button id='btn-nitro' onclick='toggleNitro()' class='nav-btn " + isNitroActive + "'><span class='nav-icon'>🔥</span><span class='nav-label'>NITRO</span></button>";
        html += "<button id='btn-reset' onclick='triggerReset()' class='nav-btn' style='color: #ef4444;'><span class='nav-icon'>⛔</span><span class='nav-label'>RESET</span></button>";
        html += "</div>";

        // CODICE JAVASCRIPT CLIENT CON LOGICA DI CODA E GESTIONE DEL SONNO (WAKE LOCK)
        html += "<script>";
        html += "let queue = [];";
        html += "let queueIndex = -1;";
        html += "let isSyncRunning = false;";
        html += "let wakeLock = null;";

        // Richiede il blocco del sonno per tenere lo schermo sempre attivo
        html += "async function requestWakeLock() {";
        html += "  try {";
        html += "    if ('wakeLock' in navigator) {";
        html += "      wakeLock = await navigator.wakeLock.request('screen');";
        html += "    }";
        html += "  } catch (err) {}";
        html += "}";

        // Rilascia lo schermo permettendo lo standby normale
        html += "function releaseWakeLock() {";
        html += "  if (wakeLock !== null) {";
        html += "    wakeLock.release();";
        html += "    wakeLock = null;";
        html += "  }";
        html += "}";

        // Rileva lo spegnimento dello schermo o il cambio scheda per mettere in pausa automatica
        html += "document.addEventListener('visibilitychange', async function() {";
        html += "  const state = document.visibilityState;";
        html += "  await fetch('/mode?state=' + state, { method: 'POST' });";
        html += "  if (state === 'visible') {";
        html += "    if (isSyncRunning) { await requestWakeLock(); }";
        html += "  } else {";
        html += "    pauseSequentialSync();";
        html += "  }";
        html += "});";

        // Espande e mostra i dettagli del campionato con la mini-barra di navigazione (Quoted correttamente tramite String.fromCharCode)
        html += "async function toggleLeague(code) {";
        html += "  const card = document.getElementById('card-' + code);";
        html += "  const el = document.getElementById('content-' + code);";
        html += "  const isSelected = card.classList.toggle('selected');";
        html += "  const q = String.fromCharCode(34);";
        html += "  const s = String.fromCharCode(39);";
        html += "  if (isSelected) {";
        html += "    el.style.display = 'block';";
        html += "    el.innerHTML = '<div class=tabs-nav>' +";
        html += "      '<button id=btn-tab-classifica-' + code + ' class=' + s + 'tab-btn active' + s + ' onclick=' + s + 'switchTab(' + q + code + q + ',' + q + 'classifica' + q + ')' + s + '>🏆 Classifica</button>' +";
        html += "      '<button id=btn-tab-calendario-' + code + ' class=tab-btn onclick=' + s + 'switchTab(' + q + code + q + ',' + q + 'calendario' + q + ')' + s + '>📅 Calendario</button>' +";
        html += "      '</div>' +";
        html += "      '<div id=tab-classifica-' + code + ' class=\"tab-content active\">Caricamento proiezioni...</div>' +";
        html += "      '<div id=tab-calendario-' + code + ' class=tab-content>Caricamento calendario...</div>';";
        
        html += "    const r = await fetch('/matches?league=' + code);";
        html += "    const data = await r.json();";
        html += "    renderStandings(code, data.standings);";
        html += "    renderCalendar(code, data.calendar);";
        html += "  } else {";
        html += "    el.style.display = 'none';";
        html += "  }";
        html += "}";

        // Navigazione interna tra i due pannelli della card (Classifica vs Calendario)
        html += "function switchTab(code, tab) {";
        html += "  const tabClassifica = document.getElementById('tab-classifica-' + code);";
        html += "  const tabCalendario = document.getElementById('tab-calendario-' + code);";
        html += "  const btnClassifica = document.getElementById('btn-tab-classifica-' + code);";
        html += "  const btnCalendario = document.getElementById('btn-tab-calendario-' + code);";
        html += "  if (tab === 'classifica') {";
        html += "    tabClassifica.classList.add('active');";
        html += "    tabCalendario.classList.remove('active');";
        html += "    btnClassifica.classList.add('active');";
        html += "    btnCalendario.classList.remove('active');";
        html += "  } else {";
        html += "    tabClassifica.classList.remove('active');";
        html += "    tabCalendario.classList.add('active');";
        html += "    btnClassifica.classList.remove('active');";
        html += "    btnCalendario.classList.add('active');";
        html += "  }";
        html += "}";

        // Disegna la classifica proiettata formattandola in tabella
        html += "function renderStandings(code, standings) {";
        html += "  const container = document.getElementById('tab-classifica-' + code);";
        html += "  if (!standings || standings.length === 0) {";
        html += "    container.innerText = 'Nessuna classifica calcolata.';";
        html += "    return;";
        html += "  }";
        html += "  let table = '<table><thead><tr><th>Squadra</th><th>Punti</th><th style=\"color:#00ebff\">Vittoria %</th><th style=\"color:#10b981\">Europa %</th><th style=\"color:#ef4444\">Retr %</th></tr></thead><tbody>';";
        html += "  for (let i = 0; i < standings.length; i++) {";
        html += "    const s = standings[i];";
        html += "    table += '<tr><td><b>' + s.team_name + '</b></td><td>' + s.avg_points.toFixed(1) + '</td><td style=\"color:#00ebff;font-weight:bold\">' + s.win_pct.toFixed(1) + '%</td><td style=\"color:#10b981\">' + s.europe_pct.toFixed(1) + '%</td><td style=\"color:#ef4444\">' + s.relegation_pct.toFixed(1) + '%</td></tr>';";
        html += "  }";
        html += "  table += '</tbody></table>';";
        html += "  container.innerHTML = table;";
        html += "}";

        // Disegna il calendario partite formattandolo in tabella
        html += "function renderCalendar(code, calendar) {";
        html += "  const container = document.getElementById('tab-calendario-' + code);";
        html += "  if (!calendar || calendar.length === 0) {";
        html += "    container.innerText = 'Nessuna partita trovata.';";
        html += "    return;";
        html += "  }";
        html += "  let table = '<table><thead><tr><th>Data</th><th>Incontro</th><th style=\"text-align:center\">Risultato</th></tr></thead><tbody>';";
        html += "  for (let i = 0; i < calendar.length; i++) {";
        html += "    const m = calendar[i];";
        html += "    const d = new Date(m.event_date).toLocaleDateString('it-IT', {day:'2-digit',month:'2-digit'});";
        html += "    const r = m.goals_home !== null ? m.goals_home + ' - ' + m.goals_away : '-';";
        html += "    table += '<tr><td>' + d + '</td><td>' + m.home_team_name_api + ' - ' + m.away_team_name_api + '</td><td style=\"text-align:center;color:#00ebff;font-weight:bold\">' + r + '</td></tr>';";
        html += "  }";
        html += "  table += '</tbody></table>';";
        html += "  container.innerHTML = table;";
        html += "}";

        // Seleziona o deseleziona tutti i campionati attivi a schermo
        html += "function toggleAll() {";
        html += "  const cards = document.querySelectorAll('.league-item[data-active=\"1\"]');";
        html += "  const allSelected = Array.from(cards).every(c => c.classList.contains('selected'));";
        html += "  for (let i = 0; i < cards.length; i++) {";
        html += "    const card = cards[i];";
        html += "    const code = card.id.replace('card-', '');";
        html += "    const el = document.getElementById('content-' + code);";
        html += "    if (allSelected) {";
        html += "      card.classList.remove('selected');";
        html += "      el.style.display = 'none';";
        html += "    } else {";
        html += "      if (!card.classList.contains('selected')) {";
        html += "        card.classList.add('selected');";
        html += "      }";
        html += "    }";
        html += "  }";
        html += "}";

        // Avvia la catena di elaborazione sequenziale gestita dal browser
        html += "async function startSequentialSync() {";
        html += "  if (isSyncRunning) return;";
        html += "  const selectedCards = document.querySelectorAll('.league-item.selected[data-active=\"1\"]');";
        html += "  queue = Array.from(selectedCards).map(c => c.id.replace('card-', ''));";
        html += "  if (queue.length === 0) {";
        html += "    alert('Attiva almeno un campionato (bordo ciano) prima di avviare!');";
        html += "    return;";
        html += "  }";
        html += "  isSyncRunning = true;";
        html += "  queueIndex = 0;";
        html += "  await requestWakeLock();";
        html += "  document.getElementById('btn-start').disabled = true;";
        html += "  document.getElementById('btn-reset').disabled = true;";
        html += "  document.getElementById('sync-msg').style.display = 'block';";
        html += "  document.getElementById('sync-msg').innerText = 'Sincronizzazione sequenziale attiva...';";
        html += "  processNextInQueue();";
        html += "}";

        // Elabora il prossimo elemento della coda richiamando le chiamate sequenziali singole
        html += "async function processNextInQueue() {";
        html += "  if (!isSyncRunning) return;";
        html += "  if (queueIndex >= queue.length) {";
        html += "    finishSyncChain();";
        html += "    return;";
        html += "  }";
        html += "  const currentLeague = queue[queueIndex];";
        html += "  const pctEl = document.getElementById('pct-' + currentLeague);";
        html += "  const card = document.getElementById('card-' + currentLeague);";
        html += "  if (pctEl) pctEl.innerText = 'SYNCING';";
        html += "  const isNitro = document.getElementById('btn-nitro').classList.contains('nitro-active') ? '1' : '0';";
        
        // Applica l'effetto fuoco neon se la Nitro è attiva
        html += "  if (isNitro === '1' && card) {";
        html += "    card.classList.add('nitro-glowing');";
        html += "  }";
        
        html += "  try {";
        html += "    const res = await fetch('/sync?league=' + currentLeague + '&nitro=' + isNitro, { method: 'POST' });";
        html += "    const data = await res.json();";
        html += "    if (data.success) {";
        html += "      if (pctEl) pctEl.innerText = '100.0%';";
        html += "      if (card && card.classList.contains('selected')) {";
        html += "        const contentEl = document.getElementById('content-' + currentLeague);";
        html += "        if (contentEl) {";
        html += "          const r = await fetch('/matches?league=' + currentLeague);";
        html += "          const innerData = await r.json();";
        html += "          renderStandings(currentLeague, innerData.standings);";
        html += "          renderCalendar(currentLeague, innerData.calendar);";
        html += "        }";
        html += "      }";
        html += "    } else {";
        html += "      if (pctEl) pctEl.innerText = 'ERRORE';";
        html += "    }";
        html += "  } catch (e) {";
        html += "    if (pctEl) pctEl.innerText = 'ERRORE';";
        html += "  }";
        
        // Spegne l'effetto fiamma a fine elaborazione della card
        html += "  if (card) card.classList.remove('nitro-glowing');";
        
        html += "  queueIndex++;";
        html += "  const delayTime = isNitro === '1' ? 1200 : 10000;";
        
        // Mostra un conto alla rovescia reale se siamo a velocità normale
        html += "  if (isNitro !== '1' && queueIndex < queue.length) {";
        html += "    let timer = 10;";
        html += "    const interval = setInterval(() => {";
        html += "      timer--;";
        html += "      document.getElementById('sync-msg').innerText = 'Pausa di sicurezza... Prossimo campionato tra ' + timer + 's';";
        html += "      if (timer <= 0) clearInterval(interval);";
        html += "    }, 1000);";
        html += "  }";
        
        html += "  setTimeout(processNextInQueue, delayTime);";
        html += "}";

        // Mette in pausa l'esecuzione della coda client-side (Rimossi gli apostrofi con escape per evitare errori JS)
        html += "function pauseSequentialSync() {";
        html += "  isSyncRunning = false;";
        html += "  releaseWakeLock();";
        html += "  document.getElementById('btn-start').disabled = false;";
        html += "  document.getElementById('btn-reset').disabled = false;";
        html += "  document.getElementById('sync-msg').innerText = 'Processo in pausa.';";
        html += "}";

        // Conclude la catena impostando lo stato finale corretto
        html += "function finishSyncChain() {";
        html += "  isSyncRunning = false;";
        html += "  releaseWakeLock();";
        html += "  document.getElementById('btn-start').disabled = false;";
        html += "  document.getElementById('btn-reset').disabled = false;";
        html += "  document.getElementById('sync-msg').style.display = 'none';";
        html += "  updateStatus();";
        html += "}";

        // Richiede un reset completo del database via asincrona (Rimosso l'apostrofo con escape per stabilità del codice)
        html += "async function triggerReset() {";
        html += "  if (!confirm('Vuoi davvero cancellare il calendario e le simulazioni?')) return;";
        html += "  await fetch('/reset', { method: 'POST' });";
        html += "  updateStatus();";
        html += "}";

        // Interroga continuamente lo stato generale per tenere aggiornato il pannello
        // (BLINDATA con html += e protetta da esecuzioni server-side improvvise)
        html += "async function updateStatus() {";
        html += "  try {";
        html += "    const r = await fetch('/status');";
        html += "    if (!r.ok) return;";
        html += "    const data = await r.json();";
        html += "    const elLastSync = document.getElementById('stat-last-sync');";
        html += "    const elTotale = document.getElementById('stat-totale');";
        html += "    const elSeason = document.getElementById('stat-season');";
        html += "    if (elLastSync) elLastSync.innerText = data.lastSync;";
        html += "    if (elTotale) elTotale.innerText = data.totale;";
        html += "    if (elSeason) elSeason.innerText = data.season;";
        html += "    if (data.error) {";
        html += "      document.getElementById('error-box').style.display = 'block';";
        html += "      document.getElementById('error-box').innerHTML = '<strong>Ultimo Errore:</strong> ' + data.error;";
        html += "    } else {";
        html += "      document.getElementById('error-box').style.display = 'none';";
        html += "    }";
        
        // Aggiornamento dinamico client-side del contatore "Giocate / Totale"
        html += "    for (const [code, val] of Object.entries(data.leagues)) {";
        html += "      const subEl = document.getElementById('sub-' + code);";
        html += "      if (subEl && val === 'completed' && data.progress && data.progress[code]) {";
        html += "        const prog = data.progress[code];";
        html += "        subEl.innerText = 'Giocate: ' + prog.giocate + ' / ' + prog.totale;";
        html += "      }";
        html += "    }";
        
        html += "  } catch(e) {}";
        html += "}";

        html += "setInterval(updateStatus, 3000);";
        html += "</script>";
        html += "</body></html>";

        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      } catch (err) {
        return new Response("Errore di rendering: " + err.message, { status: 500 });
      }
    }

    // -------------------------------------------------------------------------
    // ROTTA 7: POST /sync
    // Endpoint centrale. Sincronizza ed esegue 2.000 simulazioni per UN SOLO campionato
    // -------------------------------------------------------------------------
    if (url.pathname === "/sync" && request.method === "POST") {
      const divCode = url.searchParams.get("league");
      if (!divCode) {
        return new Response(JSON.stringify({ error: "Campionato non specificato" }), { status: 400 });
      }

      try {
        // Avvia l'elaborazione sincrona robusta per la singola lega a 2000 simulazioni (manuale)
        await syncAndSimulateLeague(divCode, dbArchivio, dbSoglie, 2000);

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        // Registra eventuali messaggi di errore riscontrati nella tabella del database di stato
        await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', ?)").bind(err.message).run();
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return new Response("Rotta non esistente", { status: 404 });
  }
};

// =========================================================================
// FUNZIONI SUPPORTO BACKGROUND CRON AUTOMATICO (token e 1000 simulazioni)
// =========================================================================

// Funzione interna richiamata in background dal cron-job esterno delle 7:00
async function runAutomatedCronSync(dbArchivio, dbSoglie) {
  try {
    await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'running')").run();
    await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', NULL)").run();

    const leghe = await dbArchivio.prepare("SELECT id FROM leagues WHERE is_active = 1").all();
    const listaLeghe = leghe.results || [];

    for (let i = 0; i < listaLeghe.length; i++) {
      const code = listaLeghe[i].id;

      // Esegue la sincronizzazione autonoma riducendo a 1.000 simulazioni per non superare i limiti di CPU
      await syncAndSimulateLeague(code, dbArchivio, dbSoglie, 1000);

      // Piccola pausa di sicurezza tra un campionato e l'altro
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'idle')").run();
  } catch (err) {
    await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'idle')").run();
    await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', ?)").bind(err.message).run();
  }
}

// Sincronizzatore unico riutilizzabile sia per l'avvio manuale che per il cron automatico
async function syncAndSimulateLeague(divCode, dbArchivio, dbSoglie, nSim) {
  let rilevataStagione = "N.D.";

  await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'syncing')").bind(divCode).run();

  await dbSoglie.batch([
    dbSoglie.prepare("DELETE FROM calendario_partite WHERE league_div = ?").bind(divCode),
    dbSoglie.prepare("DELETE FROM simulazioni_classifica WHERE league_div = ?").bind(divCode)
  ]);

  let matches = [];

  const seasonRes = await dbArchivio.prepare(
    "SELECT MAX(season) as ultima FROM matches WHERE div = ?"
  ).bind(divCode).first();
  
  rilevataStagione = seasonRes && seasonRes.ultima ? seasonRes.ultima : "2025/26";
  
  // CORREZIONE: Utilizzato let per dichiarare correttamente dbSeason in Strict Mode
  let dbSeason = translateSeason(rilevataStagione);
  
  const teamsRes = await dbArchivio.prepare(
    "SELECT DISTINCT hometeam FROM matches WHERE div = ? AND season = ?"
  ).bind(divCode, dbSeason).all();

  const squadreReali = [];
  if (teamsRes.results) {
    for (let j = 0; j < teamsRes.results.length; j++) {
      squadreReali.push(teamsRes.results[j].hometeam);
    }
  }

  if (squadreReali.length >= 2) {
    const maxIncontri = squadreReali.length === 10 ? 4 : 2;

    for (let j = 0; j < squadreReali.length; j++) {
      for (let k = 0; k < squadreReali.length; k++) {
        if (j !== k) {
          const volte = maxIncontri / 2;
          for (let v = 0; v < volte; v++) {
            const matchKey = divCode + "_" + squadreReali[j] + "_" + squadreReali[k] + "_" + v;
            const fixtureId = generateNumericHash(matchKey);
            
            const giocataRes = await dbArchivio.prepare(
              "SELECT fthg, ftag, date FROM matches WHERE div = ? AND season = ? AND hometeam = ? AND awayteam = ? ORDER BY date ASC"
            ).bind(divCode, dbSeason, squadreReali[j], squadreReali[k]).all();

            let goalsHome = null;
            let goalsAway = null;
            let status = "Scheduled";
            let matchDate = "";

            if (giocataRes.results && giocataRes.results.length > v) {
              const g = giocataRes.results[v];
              goalsHome = g.fthg;
              goalsAway = g.ftag;
              status = "Played";
              if (g.date) {
                matchDate = g.date + "T15:00:00Z";
              } else {
                matchDate = new Date().toISOString();
              }
            } else {
              let d = new Date();
              d.setDate(d.getDate() + (j * 7));
              matchDate = d.toISOString();
            }

            matches.push({
              fixture_id: fixtureId,
              div: divCode,
              round: "Giornata N.D.",
              date: matchDate,
              home: squadreReali[j],
              away: squadreReali[k],
              goals_home: goalsHome,
              goals_away: goalsAway,
              status: status
            });
          }
        }
      }
    }
  }

  if (matches.length > 0) {
    const queryInsert = "INSERT OR REPLACE INTO calendario_partite (fixture_id, league_id, league_div, round, event_date, home_team_name_api, home_team_id_local, away_team_name_api, away_team_id_local, goals_home, goals_away, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    const statements = [];

    for (let j = 0; j < matches.length; j++) {
      const m = matches[j];
      statements.push(
        dbSoglie.prepare(queryInsert).bind(
          m.fixture_id,
          0, 
          divCode,
          m.round,
          m.date,
          m.home,
          0, 
          m.away,
          0, 
          m.goals_home,
          m.goals_away,
          m.status
        )
      );
    }
    await dbSoglie.batch(statements);

    const teamsList = [];
    const tSet = new Set();
    for (let j = 0; j < matches.length; j++) {
      tSet.add(matches[j].home);
      tSet.add(matches[j].away);
    }
    tSet.forEach(function(t) { teamsList.push(t); });

    const numTeams = teamsList.length;
    const teamToIndex = {};
    for (let j = 0; j < numTeams; j++) {
      teamToIndex[teamsList[j]] = j;
    }

    // CORREZIONE: Interroga la tabella classifica_elite tramite team_aliases 
    // usando la colonna verificata team_id (trattino basso) senza errori
    const paramList = [];
    for (let j = 0; j < numTeams; j++) {
      const tName = teamsList[j];
      const strengthRes = await dbArchivio.prepare(
        "SELECT e.attacco, e.difesa, e.h_factor FROM team_aliases a LEFT JOIN classifica_elite e ON a.team_id = e.team_id WHERE a.alias = ?"
      ).bind(tName).first();

      let attVal = 1.0;
      let defVal = 1.0;
      let hVal = 0.3;
      if (strengthRes) {
        if (strengthRes.attacco !== null) attVal = strengthRes.attacco;
        if (strengthRes.difesa !== null) defVal = strengthRes.difesa;
        if (strengthRes.h_factor !== null) hVal = strengthRes.h_factor;
      }
      paramList.push({ att: attVal, def: defVal, home_adv: hVal });
    }

    // INTEGRAZIONE: Autocalcolo dinamico delle forze se la tabella team_ratings è vuota per questo campionato
    let hasRealStats = false;
    for (let j = 0; j < numTeams; j++) {
      if (paramList[j].att !== 1.0 || paramList[j].def !== 1.0) {
        hasRealStats = true;
        break;
      }
    }

    if (!hasRealStats) {
      let totalPlayed = 0;
      let totalGoals = 0;
      const teamGoalsScored = new Array(numTeams).fill(0);
      const teamGoalsConceded = new Array(numTeams).fill(0);
      const teamPlayedCount = new Array(numTeams).fill(0);

      for (let j = 0; j < matches.length; j++) {
        const m = matches[j];
        if (m.status === "Played" && m.goals_home !== null && m.goals_away !== null) {
          const hIdx = teamToIndex[m.home];
          const aIdx = teamToIndex[m.away];
          teamGoalsScored[hIdx] += m.goals_home;
          teamGoalsConceded[hIdx] += m.goals_away;
          teamPlayedCount[hIdx]++;

          teamGoalsScored[aIdx] += m.goals_away;
          teamGoalsConceded[aIdx] += m.goals_home;
          teamPlayedCount[aIdx]++;

          totalGoals += (m.goals_home + m.goals_away);
          totalPlayed++;
        }
      }

      const avgGoalsPerTeamGame = totalPlayed > 0 ? (totalGoals / (totalPlayed * 2)) : 1.2;

      for (let j = 0; j < numTeams; j++) {
        const played = teamPlayedCount[j] || 1;
        const scoredAvg = teamGoalsScored[j] / played;
        const concededAvg = teamGoalsConceded[j] / played;

        paramList[j] = {
          att: avgGoalsPerTeamGame > 0 ? (scoredAvg / avgGoalsPerTeamGame) : 1.0,
          def: avgGoalsPerTeamGame > 0 ? (concededAvg / avgGoalsPerTeamGame) : 1.0,
          home_adv: 0.25
        };
      }
    }

    const basePoints = new Array(numTeams).fill(0);
    const unplayedList = [];

    for (let j = 0; j < matches.length; j++) {
      const m = matches[j];
      const homeIdx = teamToIndex[m.home];
      const awayIdx = teamToIndex[m.away];

      if (m.status === "Played" && m.goals_home !== null && m.goals_away !== null) {
        if (m.goals_home > m.goals_away) {
          basePoints[homeIdx] += 3;
        } else if (m.goals_home === m.goals_away) {
          basePoints[homeIdx] += 1;
          basePoints[awayIdx] += 1;
        } else {
          basePoints[awayIdx] += 3;
        }
      } else {
        const hParam = paramList[homeIdx];
        const aParam = paramList[awayIdx];

        const lambda = hParam.att * aParam.def * (1.0 + hParam.home_adv);
        const mu = aParam.att * hParam.def;

        let pH = 0; let pD = 0; let pA = 0;
        for (let h = 0; h <= 5; h++) {
          for (let a = 0; a <= 5; a++) {
            const p = poissonProb(h, lambda) * poissonProb(a, mu);
            if (h > a) pH += p;
            else if (h === a) pD += p;
            else pA += p;
          }
        }
        let totalP = pH + pD + pA;
        if (totalP === 0) totalP = 1.0;

        unplayedList.push({
          homeIdx: homeIdx,
          awayIdx: awayIdx,
          probH: pH / totalP,
          probD: pD / totalP,
          probA: pA / totalP
        });
      }
    }

    const totalPoints = new Array(numTeams).fill(0);
    const wins = new Array(numTeams).fill(0);
    const europe = new Array(numTeams).fill(0);
    const relegation = new Array(numTeams).fill(0);

    for (let sim = 0; sim < nSim; sim++) {
      const simPoints = new Array(numTeams);
      for (let t = 0; t < numTeams; t++) {
        simPoints[t] = basePoints[t];
      }

      for (let j = 0; j < unplayedList.length; j++) {
        const u = unplayedList[j];
        const rand = Math.random();

        if (rand < u.probH) {
          simPoints[u.homeIdx] += 3;
        } else if (rand < u.probH + u.probD) {
          simPoints[u.homeIdx] += 1;
          simPoints[u.awayIdx] += 1;
        } else {
          simPoints[u.awayIdx] += 3;
        }
      }

      const indices = [];
      for (let t = 0; t < numTeams; t++) {
        indices.push(t);
      }
      indices.sort(function(a, b) {
        return simPoints[b] - simPoints[a];
      });

      for (let rank = 0; rank < numTeams; rank++) {
        const tIdx = indices[rank];
        totalPoints[tIdx] += simPoints[tIdx];
        if (rank === 0) wins[tIdx]++;
        if (rank < 4) europe[tIdx]++;
        if (rank >= numTeams - 3) relegation[tIdx]++;
      }
    }

    const simStatements = [];
    const querySimInsert = "INSERT OR REPLACE INTO simulazioni_classifica (league_div, team_name, avg_points, win_pct, europe_pct, relegation_pct) VALUES (?, ?, ?, ?, ?, ?)";
    
    for (let j = 0; j < numTeams; j++) {
      const tName = teamsList[j];
      const avgPoints = totalPoints[j] / nSim;
      const winPct = (wins[j] / nSim) * 100;
      const europePct = (europe[j] / nSim) * 100;
      const relegationPct = (relegation[j] / nSim) * 100;

      simStatements.push(
        dbSoglie.prepare(querySimInsert).bind(
          divCode,
          tName,
          avgPoints,
          winPct,
          europePct,
          relegationPct
        )
      );
    }
    await dbSoglie.batch(simStatements);
  }

  await dbSoglie.batch([
    dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'completed')").bind(divCode),
    dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('current_season', ?)").bind(rilevataStagione),
    dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('last_sync', ?)").bind(new Date().toLocaleString("it-IT"))
  ]);
}