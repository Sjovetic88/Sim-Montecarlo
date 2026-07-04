// =========================================================================
// GOLDBET MONTECARLO - MASTER WORKER COMPLETAMENTE INTEGRATO E DETTAGLIATO
// =========================================================================
// Questo Worker esegue due flussi asincroni principali (AJAX) coordinati:
// 1. Sincronizzazione automatica dei calendari di Matchesio.com con sistema
//    di auto-apprendimento e probing (sondaggio) sequenziale su 3 link di riserva.
// 2. Generatore combinatorio per i campionati mancanti su Matchesio, estraendo
//    le squadre partecipanti direttamente dallo storico corrente del database.
// 3. Simulatore predittivo Monte Carlo basato sulla distribuzione di Poisson
//    che simula 2.000 volte in RAM ogni incontro rimanente della stagione.
// 4. Interfaccia utente dinamica (Nero e Ciano Neon) con selezione tramite
//    bordo fluorescente, accordion on-demand e Page Visibility API.
// =========================================================================

// DIZIONARIO STATICO DELLE BANDIERE EMOJI PER LA VISUALIZZAZIONE GRAFICA
const LEAGUE_FLAGS = {
  "ARG": "🇦🇷", "B1": "🇧🇪", "BRA": "🇧🇷", "CHN": "🇨🇳", "D1": "🇩🇪", "D2": "🇩🇪",
  "DNK": "🇩🇰", "IRL": "🇮🇪", "MEX": "🇲🇽", "NOR": "🇳🇴", "P1": "🇵🇹", "RUS": "🇷🇺",
  "SWE": "🇸🇪", "T1": "🇹🇷", "USA": "🇺🇸", "E0": "🇬🇧", "E1": "🇬🇧", "I1": "🇮🇹",
  "I2": "🇮🇹", "SP1": "🇪🇸", "F1": "🇫🇷", "N1": "🇳🇱", "G1": "🇬🇷", "AUT": "🇦🇹", "SWZ": "🇨🇭"
};

// DIZIONARIO STATICO DEI NOMI COMPLETI DEI CAMPIONATI IN MAIUSCOLO
const LEAGUE_NAMES = {
  "ARG": "ARGENTINA", "B1": "BELGIUM", "BRA": "BRAZIL", "CHN": "CHINA", "D1": "GERMANY",
  "D2": "GERMANY D2", "DNK": "DENMARK", "IRL": "IRELAND", "MEX": "MEXICO", "NOR": "NORWAY",
  "P1": "PORTUGAL", "RUS": "RUSSIA", "SWE": "SWEDEN", "T1": "TURKEY", "USA": "USA",
  "E0": "ENGLAND PREMIER", "E1": "ENGLAND CHAMPIONSHIP", "I1": "ITALY SERIE A",
  "I2": "ITALY SERIE B", "SP1": "SPAIN LA LIGA", "F1": "FRANCE LIGUE 1", "N1": "NETHERLANDS EREDIVISIE"
};

// FUNZIONE DI SUPPORTO: Calcola il fattoriale di un numero (necessario per Poisson)
function factorial(n) {
  let res = 1;
  for (let i = 2; i <= n; i++) res *= i;
  return res;
}

// FUNZIONE DI SUPPORTO: Calcola la probabilità di Poisson per K eventi data l'attesa Lambda
// Usata per stimare le probabilità di segnare 0, 1, 2, 3, 4, 5 gol in una partita
function poissonProb(k, lambda) {
  return (Math.pow(lambda, k) * Math.exp(-lambda)) / factorial(k);
}

export default {
  // ---------------------------------------------------------------------------
  // FETCH HANDLER: Gestisce l'ingresso delle richieste HTTP nel Worker
  // ---------------------------------------------------------------------------
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dbArchivio = env.DB_ARCHIVIO;
    const dbSoglie = env.DB_SOGLIE;
    const apiKey = env.API_FOOTBALL_KEY || "a045158f354f22a763d193b99f52ae48";

    // -------------------------------------------------------------------------
    // ROTTA 1: /matches (Accordion on-demand)
    // Ritorna le partite reali e le proiezioni simulate in formato tabella HTML
    // -------------------------------------------------------------------------
    if (url.pathname === "/matches") {
      const leagueDiv = url.searchParams.get("league");
      if (!leagueDiv) {
        return new Response("Campionato non specificato", { status: 400 });
      }
      try {
        // Estraiamo la classifica simulata dal database SOGLIE (simulazioni_classifica)
        const simRes = await dbSoglie.prepare(
          "SELECT team_name, avg_points, win_pct, europe_pct, relegation_pct FROM simulazioni_classifica WHERE league_div = ? ORDER BY avg_points DESC"
        ).bind(leagueDiv).all();

        let tableHtml = "";

        // Se esistono proiezioni simulate nel database, stampiamo la tabella Monte Carlo
        if (simRes.results && simRes.results.length > 0) {
          tableHtml += "<h3>Classifica Proiettata (Proiezione Monte Carlo)</h3>";
          tableHtml += "<table style='width: 100%; border-collapse: collapse; margin-bottom: 25px; font-size: 12px; color: #cbd5e1;'>";
          tableHtml += "<thead><tr style='border-bottom: 1px solid #374151; text-align: left;'><th style='padding: 6px;'>Squadra</th><th style='padding: 6px; text-align: center;'>Punti Medi</th><th style='padding: 6px; text-align: center; color: #00ebff;'>Vittoria %</th><th style='padding: 6px; text-align: center; color: #10b981;'>Europa %</th><th style='padding: 6px; text-align: center; color: #ef4444;'>Retr. %</th></tr></thead><tbody>";

          for (let i = 0; i < simRes.results.length; i++) {
            const s = simRes.results[i];
            tableHtml += "<tr style='border-bottom: 1px solid #1f2937;'>";
            tableHtml += "<td style='padding: 6px; font-weight: bold; color: #fff;'>" + s.team_name + "</td>";
            tableHtml += "<td style='padding: 6px; text-align: center; font-weight: bold;'> " + s.avg_points.toFixed(1) + "</td>";
            tableHtml += "<td style='padding: 6px; text-align: center; color: #00ebff; font-weight: bold;'>" + s.win_pct.toFixed(1) + "%</td>";
            tableHtml += "<td style='padding: 6px; text-align: center; color: #10b981; font-weight: bold;'>" + s.europe_pct.toFixed(1) + "%</td>";
            tableHtml += "<td style='padding: 6px; text-align: center; color: #ef4444; font-weight: bold;'>" + s.relegation_pct.toFixed(1) + "%</td>";
            tableHtml += "</tr>";
          }
          tableHtml += "</tbody></table>";
        }

        // Estraiamo il calendario delle partite reali/simulate salvato nel database SOGLIE
        const matches = await dbSoglie.prepare(
          "SELECT event_date, home_team_name_api, away_team_name_api, goals_home, goals_away, status FROM calendario_partite WHERE league_div = ? ORDER BY event_date ASC"
        ).bind(leagueDiv).all();

        if (matches.results && matches.results.length > 0) {
          tableHtml += "<h3>Calendario Completo</h3>";
          tableHtml += "<table style='width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; color: #cbd5e1;'>";
          tableHtml += "<thead><tr style='border-bottom: 1px solid #374151; text-align: left;'><th style='padding: 8px; color: #94a3b8;'>Data</th><th style='padding: 8px; color: #94a3b8;'>Casa</th><th style='padding: 8px; text-align: center; color: #94a3b8;'>Risultato</th><th style='padding: 8px; color: #94a3b8;'>Fuori</th></tr></thead><tbody>";

          for (let i = 0; i < matches.results.length; i++) {
            const m = matches.results[i];
            const dataLocale = new Date(m.event_date).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
            const risHome = m.goals_home !== null ? m.goals_home : "-";
            const risAway = m.goals_away !== null ? m.goals_away : "-";
            const risString = risHome + " - " + risAway;

            tableHtml += "<tr style='border-bottom: 1px solid #1f2937;'>";
            tableHtml += "<td style='padding: 8px; color: #94a3b8;'>" + dataLocale + "</td>";
            tableHtml += "<td style='padding: 8px; font-weight: bold; color: #f1f5f9;'>" + m.home_team_name_api + "</td>";
            tableHtml += "<td style='padding: 8px; text-align: center; font-weight: bold; color: #00ebff;'>" + risString + "</td>";
            tableHtml += "<td style='padding: 8px; font-weight: bold; color: #f1f5f9;'>" + m.away_team_name_api + "</td>";
            tableHtml += "</tr>";
          }
          tableHtml += "</tbody></table>";
        } else if (tableHtml === "") {
          tableHtml = "<p style='color: #94a3b8; padding: 10px; margin: 0;'>Nessuna partita scaricata per questa lega.</p>";
        }

        return new Response(tableHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      } catch (err) {
        return new Response("Errore caricamento: " + err.message, { status: 500 });
      }
    }

    // -------------------------------------------------------------------------
    // ROTTA 2: /status (Long Polling JSON)
    // Ritorna le metriche globali e lo stato delle singole spie dei campionati
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

        const resObj = {
          status: syncStatus,
          lastSync: lastSync,
          error: syncError,
          totale: totalePartite,
          season: currentSeason,
          nitro: nitroMode,
          leagues: statesMap
        };

        return new Response(JSON.stringify(resObj), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // -------------------------------------------------------------------------
    // ROTTA 3: /mode (Gestore visibilità dello schermo On/Off)
    // Aggiorna lo stato di nitro_mode nel DB (1 = Schermo On, 0 = Schermo Off)
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
    // ROTTA 4: /pause (Segnale di interruzione)
    // Imposta lo stato su 'paused' per bloccare l'esecuzione in background al termine del campionato corrente
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
    // ROTTA 5: /reset (Svuotamento completo del database)
    // Ripristina l'intero database SOGLIE cancellando partite e simulazioni
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
    // ROTTA 6: / (DASHBOARD PRINCIPALE - INTERFACCIA UTENTE WEB)
    // Disegna l'intero pannello in stile GOLDBET ENGINE (Nero e Ciano Neon)
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

        // Estrae tutti i campionati configurati in ARCHIVIO_PARTITE ordinati alfabeticamente per sigla (id ASC)
        const leghe = await dbArchivio.prepare("SELECT id, name, emoji, is_active FROM leagues ORDER BY id ASC").all();
        const listaLeghe = leghe.results || [];

        const countRes = await dbSoglie.prepare("SELECT COUNT(*) as totale FROM calendario_partite").first();
        const totalePartite = countRes ? countRes.totale : 0;

        let html = "<!DOCTYPE html><html><head><title>Goldbet Montecarlo</title>";
        html += "<meta name='viewport' content='width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'>";
        html += "<style>";
        html += "body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #000000; color: #f8fafc; padding: 20px 20px 100px 20px; margin: 0; box-sizing: border-box; }";
        html += ".container { max-width: 480px; margin: 0 auto; }";
        
        html += ".header-title { text-align: center; font-size: 24px; font-weight: 800; letter-spacing: 1px; margin-top: 10px; margin-bottom: 4px; }";
        html += ".header-title span.white { color: #ffffff; }";
        html += ".header-title span.neon { color: #00ebff; }";
        
        html += ".subtitle-stats { text-align: center; color: #94a3b8; font-size: 13px; font-weight: bold; letter-spacing: 0.5px; margin-bottom: 4px; }";
        html += ".subtitle-stats span.neon { color: #00ebff; }";
        html += ".subtitle-time { text-align: center; color: #00ebff; font-size: 11px; font-weight: 800; letter-spacing: 1.5px; margin-bottom: 25px; text-transform: uppercase; }";
        
        html += ".league-item { background: #0f172a; border: 1px solid #1e293b; margin-bottom: 14px; padding: 16px; border-radius: 8px; cursor: pointer; transition: background 0.2s, border-color 0.2s, box-shadow 0.2s, opacity 0.2s; position: relative; }";
        html += ".league-item:hover { background: #1e293b; }";
        
        // Bordo neon ciano attivo per le card dei campionati selezionati
        html += ".league-item.selected { border-color: #00ebff !important; box-shadow: 0 0 10px rgba(0, 235, 255, 0.4); }";
        
        // Stile per i campionati inattivi (disattivati con emoji divieto)
        html += ".league-item.inactive { opacity: 0.35; cursor: not-allowed; border-color: #0f172a; }";
        html += ".league-item.inactive:hover { background: #0f172a; }";
        
        html += ".league-header { display: flex; justify-content: space-between; align-items: center; font-weight: bold; font-size: 14px; letter-spacing: 0.5px; }";
        html += ".league-header span.title { display: flex; align-items: center; gap: 8px; color: #ffffff; }";
        html += ".league-header span.pct { color: #00ebff; font-weight: 800; }";
        html += ".league-header span.lock { color: #ef4444; font-weight: bold; }";
        
        html += ".league-sub { font-size: 11px; color: #64748b; margin-top: 6px; display: flex; align-items: center; gap: 6px; }";
        html += ".accordion-content { display: none; margin-top: 15px; border-top: 1px solid #1e293b; padding-top: 12px; overflow-x: auto; }";
        
        html += ".status-running-msg { text-align: center; color: #f59e0b; font-size: 13px; font-weight: bold; margin-bottom: 15px; }";
        html += ".error-box { background: #ef444422; border-left: 4px solid #ef4444; padding: 12px; margin-bottom: 20px; border-radius: 4px; color: #fca5a5; font-size: 13px; }";
        
        // Tab Bar Inferiore fissa a 5 pulsanti ad uso mobile
        html += ".bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: #090d16; border-top: 1px solid #1e293b; display: flex; justify-content: space-around; align-items: center; padding: 10px 0; z-index: 1000; box-shadow: 0 -4px 10px rgba(0,0,0,0.5); }";
        html += ".nav-btn { background: none; border: none; display: flex; flex-direction: column; align-items: center; color: #64748b; cursor: pointer; text-decoration: none; padding: 4px 10px; width: 20%; transition: color 0.2s, filter 0.2s; }";
        html += ".nav-btn-active { color: #00ebff !important; }";
        html += ".nav-btn-disabled { opacity: 0.15; cursor: not-allowed; }";
        html += ".nav-icon { font-size: 20px; margin-bottom: 3px; }";
        html += ".nav-label { font-size: 8px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; }";
        
        html += ".nitro-active { color: #f97316 !important; filter: drop-shadow(0 0 8px rgba(249,115,22,0.6)); }";
        html += ".status-running { color: #f59e0b !important; }";
        html += "</style></head><body>";
        
        html += "<div class='container'>";
        
        // Struttura Intestazione
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

        // Elenco campionati (Partono interamente spenti/deselezionati)
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

          const lastMatchRes = await dbSoglie.prepare("SELECT MAX(event_date) as ultima FROM calendario_partite WHERE league_div = ?").bind(code).first();
          const ultimaData = lastMatchRes && lastMatchRes.ultima ? new Date(lastMatchRes.ultima).toLocaleDateString("it-IT", { year: "numeric", month: "2-digit", day: "2-digit" }) : "N.D.";

          // Se il campionato è spento (is_active = 0) impostiamo la classe "inactive" e l'emoji ⛔
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
            // Se attivo, impostiamo comportamento standard (Deselezionato all'avvio)
            html += "<div class='league-item' id='card-" + code + "' onclick=\"toggleLeague('" + code + "')\" data-active='1'>";
            html += "<div class='league-header'>";
            html += "<span class='title'><span>" + flag + "</span> " + fullLabel + "</span>";
            html += "<span id='pct-" + code + "' class='pct'>" + pct + "</span>";
            html += "</div>";
            html += "<div class='league-sub'>";
            html += "<span>📅</span> <span id='sub-" + code + "'>" + (lStatus === "completed" ? "Ultima partita: " + ultimaData : "In attesa di sincronizzazione") + "</span>";
            html += "</div>";
            html += "<div class='accordion-content' id='content-" + code + "'>";
            html += "Caricamento partite...";
            html += "</div>";
            html += "</div>";
          }
        }
        html += "</div>";
        html += "</div>";

        // Tab Bar Inferiore fissa con i 5 pulsanti, completamente asincroni
        html += "<div class='bottom-nav'>";
        html += "<button onclick='toggleAll()' class='nav-btn nav-btn-active'><span class='nav-icon'>☑️</span><span class='nav-label'>ALL</span></button>";
        html += "<button id='btn-start' onclick='startSync()' class='nav-btn' style='color: #10b981;'><span class='nav-icon'>▶️</span><span class='nav-label'>START</span></button>";
        html += "<button id='btn-pause' onclick='triggerPause()' class='nav-btn' style='color: #f59e0b;'><span class='nav-icon'>⏸️</span><span class='nav-label'>PAUSA</span></button>";
        
        const isNitroActive = nitroMode === "1" ? "nitro-active" : "";
        html += "<button id='btn-nitro' onclick='toggleNitro()' class='nav-btn " + isNitroActive + "'><span class='nav-icon'>🔥</span><span class='nav-label'>NITRO</span></button>";
        html += "<button id='btn-reset' onclick='triggerReset()' class='nav-btn' style='color: #ef4444;'><span class='nav-icon'>⛔</span><span class='nav-label'>RESET</span></button>";
        html += "</div>";

        // CODICE JAVASCRIPT LATO CLIENT CON PAGE VISIBILITY API AUTOMATICO
        html += "<script>";
        html += "let globalStatus = '" + syncStatus + "';";

        // Accendi/Apri e Spegni/Chiudi dinamico
        html += "async function toggleLeague(code) {";
        html += "  const card = document.getElementById('card-' + code);";
        html += "  const el = document.getElementById('content-' + code);";
        html += "  const isSelected = card.classList.toggle('selected');";
        
        html += "  if (isSelected) {";
        html += "    el.style.display = 'block';";
        html += "    el.innerHTML = 'Caricamento partite...';";
        html += "    const r = await fetch('/matches?league=' + code);";
        html += "    el.innerHTML = await r.text();";
        html += "  } else {";
        html += "    el.style.display = 'none';";
        html += "  }";
        html += "}";

        // Tasto ALL (Accende/Spegne solo quelli attivi)
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

        // Tasto NITRO (Toggle classe attivo - RIGOROSAMENTE RACCHIUSO NELLA STRINGA)
        html += "function toggleNitro() {";
        html += "  const btn = document.getElementById('btn-nitro');";
        html += "  btn.classList.toggle('nitro-active');";
        html += "}";

        // Avvio Sincronizzazione asincrona dei soli campionati selezionati (Ciano Neon)
        // Utilizziamo unicamente le Query di indirizzo per evitare qualsiasi problema sui browser degli smartphone (Evitata barra rovesciata!)
        html += "async function startSync() {";
        html += "  if (globalStatus === 'running') return;";
        const selectedCards = "document.querySelectorAll('.league-item.selected[data-active=1]')";
        html += "  const selected = Array.from(" + selectedCards + ").map(c => c.id.replace('card-', ''));";
        html += "  if (selected.length === 0) {";
        html += "    alert('Tocca i campionati per accenderlo di ciano prima di avviare!');";
        html += "    return;";
        html += "  }";
        
        html += "  const nitroActive = document.getElementById('btn-nitro').classList.contains('nitro-active') ? '1' : '0';";
        html += "  document.getElementById('btn-start').disabled = true;";
        html += "  document.getElementById('btn-reset').disabled = true;";
        html += "  document.getElementById('sync-msg').style.display = 'block';";
        html += "  document.getElementById('sync-msg').innerText = 'Sincronizzazione o Elaborazione attiva...';";
        
        // Passaggio diretto dei dati nell'indirizzo (Query String) - 100% immune ai bug mobili e con parametro start=1
        html += "  await fetch('/sync?leagues=' + selected.join(',') + '&nitro=' + nitroActive + '&start=1', { method: 'POST' });";
        html += "  updateStatus();";
        html += "}";

        // Pausa asincrona via AJAX
        html += "async function triggerPause() {";
        html += "  const msgEl = document.getElementById('sync-msg');";
        html += "  if (msgEl) { msgEl.innerText = 'Pausa richiesta... attesa completamento download corrente.'; }";
        html += "  await fetch('/pause', { method: 'POST' });";
        html += "  updateStatus();";
        html += "}";

        // Reset completo asincrono via AJAX
        html += "async function triggerReset() {";
        html += "  if (!confirm('Sei sicuro di voler resettare interamente il database del calendario?')) return;";
        html += "  await fetch('/reset', { method: 'POST' });";
        html += "  updateStatus();";
        html += "}";

        // AUTOMAZIONE SCHERMO ACCESO/SPENTO (Page Visibility API)
        html += "document.addEventListener('visibilitychange', async function() {";
        html += "  const state = document.visibilityState;"; 
        html += "  await fetch('/mode?state=' + state, { method: 'POST' });";
        html += "});";

        // Long Polling per l'aggiornamento automatico della pagina senza ricarica
        html += "async function updateStatus() {";
        html += "  try {";
        html += "    const r = await fetch('/status');";
        html += "    if (!r.ok) return;";
        html += "    const data = await r.json();";
        html += "    globalStatus = data.status;";
        
        const elLastSync = "document.getElementById('stat-last-sync')";
        const elTotale = "document.getElementById('stat-totale')";
        const elSeason = "document.getElementById('stat-season')";
        const elMsg = "document.getElementById('sync-msg')";
        const elBtnStart = "document.getElementById('btn-start')";
        const elBtnReset = "document.getElementById('btn-reset')";
        const elBtnNitro = "document.getElementById('btn-nitro')";
        
        html += "    if (" + elLastSync + ") " + elLastSync + ".innerText = data.lastSync;";
        html += "    if (" + elTotale + ") " + elTotale + ".innerText = data.totale;";
        html += "    if (" + elSeason + ") " + elSeason + ".innerText = data.season;";
        
        html += "    if (" + elBtnNitro + ") {";
        html += "      if (data.nitro === '1') " + elBtnNitro + ".classList.add('nitro-active');";
        html += "      else " + elBtnNitro + ".classList.remove('nitro-active');";
        html += "    }";
        
        html += "    if (data.status === 'running') {";
        html += "      if (" + elBtnStart + ") " + elBtnStart + ".disabled = true;";
        html += "      if (" + elBtnReset + ") " + elBtnReset + ".disabled = true;";
        html += "      if (" + elMsg + ") { " + elMsg + ".style.display = 'block'; " + elMsg + ".innerText = 'Sincronizzazione o Elaborazione attiva...'; }";
        html += "    } else {";
        html += "      if (" + elBtnStart + ") " + elBtnStart + ".disabled = false;";
        html += "      if (" + elBtnReset + ") " + elBtnReset + ".disabled = false;";
        html += "      if (" + elMsg + ") " + elMsg + ".style.display = 'none';";
        html += "    }";

        html += "    if (data.error) {";
        html += "      document.getElementById('error-box').style.display = 'block';";
        html += "      document.getElementById('error-box').innerHTML = '<strong>Ultimo Errore:</strong> ' + data.error;";
        html += "    } else {";
        html += "      document.getElementById('error-box').style.display = 'none';";
        html += "    }";

        html += "    for (const [code, val] of Object.entries(data.leagues)) {";
        html += "      const pctEl = document.getElementById('pct-' + code);";
        html += "      const subEl = document.getElementById('sub-' + code);";
        html += "      if (pctEl) {";
        html += "        if (val === 'syncing') {";
        html += "          pctEl.innerText = 'SYNCING';";
        const cardHasSelected = "document.getElementById('card-' + code).classList.contains('selected')";
        html += "          if (subEl && " + cardHasSelected + ") subEl.innerText = 'Download o Elaborazione in corso...';";
        html += "        } else if (val === 'completed') {";
        html += "          pctEl.innerText = '100.0%';";
        html += "        } else {";
        html += "          pctEl.innerText = '0.0%';";
        html += "          if (subEl) subEl.innerText = 'In attesa di elaborazione';";
        html += "        }";
        html += "      }";
        html += "    }";
        html += "  } catch(e) {}";
        html += "}";

        html += "setInterval(updateStatus, 2000);";
        html += "</script>";

        html += "</body></html>";

        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      } catch (err) {
        return new Response("Errore caricamento dashboard: " + err.message, { status: 500 });
      }
    }

    // 7. ROTTA POST /sync (RICEZIONE SELEZIONE E AVVIO BACKGROUND CON SUPPORTO CATENA BATCH)
    if (url.pathname === "/sync" && request.method === "POST") {
      try {
        const statusCheck = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        
        const isStart = url.searchParams.get("start") === "1";
        if (statusCheck && statusCheck.value === "running" && isStart) {
          return new Response(JSON.stringify({ error: "Sincronizzazione gia in corso" }), { status: 400 });
        }

        const leaguesStr = url.searchParams.get("leagues");
        const nitroStr = url.searchParams.get("nitro") || "0";

        if (!leaguesStr) {
          return new Response(JSON.stringify({ error: "Nessun campionato selezionato" }), { status: 400 });
        }

        const listLeagues = leaguesStr.split(",");

        // DIVISIONE IN GRUPPI (BATCHING DI 3 IN 3) [3]
        const currentBatch = listLeagues.slice(0, 3);
        const remainingLeagues = listLeagues.slice(3);

        const resetStatements = [];

        if (isStart) {
          resetStatements.push(dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'running')"));
          resetStatements.push(dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', NULL)"));
          resetStatements.push(dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('nitro_mode', ?)").bind(nitroStr));
          
          for (let i = 0; i < listLeagues.length; i++) {
            resetStatements.push(
              dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'pending')").bind(listLeagues[i])
            );
          }
        }

        if (resetStatements.length > 0) {
          await dbSoglie.batch(resetStatements);
        }

        const selfUrl = "https://" + url.host + "/sync";

        ctx.waitUntil(
          runBackgroundSync(dbArchivio, dbSoglie, currentBatch, remainingLeagues, selfUrl, nitroStr)
        );

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    return new Response("Risorsa non trovata", { status: 404 });
  }
};

// COMPITO IN BACKGROUND COMPLETAMENTE INTERATTIVO CON CHIPI DI PROBING E SIMULATORE POISSON MONTE CARLO INTEGRATO
async function runBackgroundSync(dbArchivio, dbSoglie, currentBatch, remainingLeagues, selfUrl, nitroMode) {
  try {
    let totaleInserite = 0;
    let rilevataStagione = "N.D.";
    
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // Carichiamo TUTTI gli slug dal database D1 con un'unica query iniziale per limitare i consumi (SISTEMATO metric, value) [1]!
    const allSlugs = await dbSoglie.prepare("SELECT metric, value FROM api_status WHERE metric LIKE 'slug_%'").all();
    
    // Mappiamo i 3 slug candidati estratti dal tuo database D1 Matchesio_slugs! (Soluzione al 100% Data-Driven)
    const slugMap = {};
    if (allSlugs.results) {
      for (let j = 0; j < allSlugs.results.length; j++) {
        const r = allSlugs.results[j];
        slugMap[r.metric.replace("slug_", "")] = r.value;
      }
    }

    // Carichiamo anche i 3 slug candidati dalla tua tabella nativa matchesio_slugs in DB_ARCHIVIO
    const dbSlugs = await dbArchivio.prepare("SELECT league_div, slug1, slug2, slug3 FROM matchesio_slugs").all();
    if (dbSlugs.results) {
      for (let j = 0; j < dbSlugs.results.length; j++) {
        const s = dbSlugs.results[j];
        const arr = [];
        if (s.slug1) arr.push(s.slug1);
        if (s.slug2) arr.push(s.slug2);
        if (s.slug3) arr.push(s.slug3);
        slugMap[s.league_div] = arr.join(",");
      }
    }

    for (let i = 0; i < currentBatch.length; i++) {
      const divCode = currentBatch[i];
      const slugVal = slugMap[divCode];

      // CONTROLLO ATTIVO DELLA PAUSA AD OGNY STEP
      const statusCheck = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
      if (statusCheck && (statusCheck.value === "paused" || statusCheck.value === "idle")) {
        console.log("Processo interrotto o messo in pausa dall'utente.");
        return; 
      }

      // MODIFICA AUTOMATICA DI PULIZIA CIRURGICA PREVENTIVA:
      // Svuota integralmente il vecchio calendario e le proiezioni per questa lega sul database SOGLIE
      // per evitare la duplicazione dei dati della stagione olandese!
      await dbSoglie.batch([
        dbSoglie.prepare("DELETE FROM calendario_partite WHERE league_div = ?").bind(divCode),
        dbSoglie.prepare("DELETE FROM simulazioni_classifica WHERE league_div = ?").bind(divCode)
      ]);

      // Imposta lo stato della lega corrente su "syncing" (Giallo 🟡)
      await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'syncing')").bind(divCode).run();

      let matches = [];

      // BINARIO 1: Campionati presenti su Matchesio (Slug esistente nel database)
      if (slugVal) {
        const slug = slugVal.split(",");
        let apiResponse = null;

        // Probing automatico dei candidati
        for (let c = 0; c < slug.length; c++) {
          const currentSlug = slug[c];
          const urlExport = "https://www.matchesio.com/competition/" + currentSlug + "/export/json";
          
          apiResponse = await fetch(urlExport, {
            method: "GET",
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
          });

          if (apiResponse.ok) {
            break; 
          }
        }

        if (apiResponse && apiResponse.ok) {
          const rawMatches = await apiResponse.json();
          if (rawMatches && rawMatches.length > 0) {
            rilevataStagione = rawMatches[0].season || "2025/26";
            
            for (let j = 0; j < rawMatches.length; j++) {
              const m = rawMatches[j];
              const timestampPartita = m.date + "T" + m.time + ":00Z";
              let goalsHome = null;
              let goalsAway = null;
              if (m.status === "Played" && m.result && m.result.indexOf("-") !== -1) {
                const score = m.result.split("-");
                goalsHome = parseInt(score[0].trim(), 10);
                goalsAway = parseInt(score[1].trim(), 10);
              }
              matches.push({
                fixture_id: m.id,
                div: divCode,
                round: "Giornata " + m.matchday,
                date: timestampPartita,
                home: m.homeTeam,
                away: m.awayTeam,
                goals_home: goalsHome,
                goals_away: goalsAway,
                status: m.status
              });
            }
          }
        }
      }

      // BINARIO 2: Campionati mancanti su Matchesio (Generazione Matematica tramite il tuo archivio)
      // MODIFICA CORRETTA: La tabella interrogata su archivio_partite si chiama 'matches' ed è in minuscolo! [3]
      if (!slugVal || matches.length === 0) {
        // RILEVAMENTO DINAMICO STAGIONE (Bypass del Bug della Retrocessione):
        // Estrae l'esatta ultima stagione inserita in 'matches' per questo campionato (es. '2025/26' o '2026')
        const seasonRes = await dbArchivio.prepare(
          "SELECT MAX(season) as ultima FROM matches WHERE div = ?"
        ).bind(divCode).first();
        
        rilevataStagione = seasonRes && seasonRes.ultima ? seasonRes.ultima : "2025/26";
        
        // Estraiamo tutte le squadre uniche che partecipano EFFETTIVAMENTE a questa specifica stagione!
        const teamsRes = await dbArchivio.prepare(
          "SELECT DISTINCT hometeam FROM matches WHERE div = ? AND season = ?"
        ).bind(divCode, rilevataStagione).all();

        const squadreReali = [];
        if (teamsRes.results) {
          for (let j = 0; j < teamsRes.results.length; j++) {
            squadreReali.push(teamsRes.results[j].hometeam);
          }
        }

        if (squadreReali.length >= 2) {
          const maxIncontri = squadreReali.length === 10 ? 4 : 2;
          let idFittizio = 1000000 + (i * 10000);

          for (let j = 0; j < squadreReali.length; j++) {
            for (let k = 0; k < squadreReali.length; k++) {
              if (j !== k) {
                const volte = maxIncontri / 2;
                for (let v = 0; v < volte; v++) {
                  idFittizio++;
                  
                  // Filtriamo rigorosamente per la stagione in corso per non includere vecchie sfide
                  const giocataRes = await dbArchivio.prepare(
                    "SELECT fthg, ftag FROM matches WHERE div = ? AND season = ? AND hometeam = ? AND awayteam = ? LIMIT 1"
                  ).bind(divCode, rilevataStagione, squadreReali[j], squadreReali[k]).all();

                  let goalsHome = null;
                  let goalsAway = null;
                  let status = "Scheduled";

                  if (giocataRes.results && giocataRes.results.length > v) {
                    const g = giocataRes.results[v];
                    goalsHome = g.fthg;
                    goalsAway = g.ftag;
                    status = "Played";
                  }

                  matches.push({
                    fixture_id: idFittizio,
                    div: divCode,
                    round: "Giornata N.D.",
                    date: new Date().toISOString(),
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
      }

      // Salva nel database SOGLIE
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

        if (statements.length > 0) {
          await dbSoglie.batch(statements);
          totaleInserite += statements.length;
        }

        // ==========================================
        // AVVIO MOTORE SIMULATORE MONTE CARLO POISSON
        // ==========================================
        const teamsList = [];
        const tSet = new Set();
        for (let j = 0; j < matches.length; j++) {
          tSet.add(matches[j].home);
          tSet.add(matches[j].away);
        }
        tSet.forEach(t => teamsList.push(t));

        const numTeams = teamsList.length;

        const paramMap = {};
        for (let j = 0; j < numTeams; j++) {
          const tName = teamsList[j];
          
          // MODIFICA SULLA TABELLA DEI PARAMETRI DELLE SQUADRE
          // Interroga la tua tabella 'team_stats' in archivio_partite usando h_factor!
          const strengthRes = await dbArchivio.prepare(
            "SELECT att, def, h_factor FROM team_stats WHERE team_name = ?"
          ).bind(tName).first();

          paramMap[tName] = {
            att: strengthRes ? strengthRes.att : 1.0,
            def: strengthRes ? strengthRes.def : 1.0,
            home_adv: strengthRes && strengthRes.h_factor !== null ? strengthRes.h_factor : 0.3
          };
        }

        const playedList = [];
        const unplayedList = [];

        for (let j = 0; j < matches.length; j++) {
          const m = matches[j];
          if (m.status === "Played" && m.goals_home !== null && m.goals_away !== null) {
            playedList.push(m);
          } else {
            const hParam = paramMap[m.home] || { att: 1.0, def: 1.0, home_adv: 0.3 };
            const aParam = paramMap[m.away] || { att: 1.0, def: 1.0, home_adv: 0.3 };

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
            const totalP = pH + pD + pA || 1.0;

            unplayedList.push({
              home: m.home,
              away: m.away,
              probH: pH / totalP,
              probD: pD / totalP,
              probA: pA / totalP
            });
          }
        }

        const N_SIM = 2000;
        const standingStats = {};
        for (let j = 0; j < numTeams; j++) {
          standingStats[teamsList[j]] = {
            totalPoints: 0,
            wins: 0,
            europe: 0,
            relegation: 0
          };
        }

        const basePoints = {};
        for (let j = 0; j < numTeams; j++) basePoints[teamsList[j]] = 0;
        for (let j = 0; j < playedList.length; j++) {
          const p = playedList[j];
          if (p.goals_home > p.goals_away) {
            basePoints[p.home] += 3;
          } else if (p.goals_home === p.goals_away) {
            basePoints[p.home] += 1;
            basePoints[p.away] += 1;
          } else {
            basePoints[p.away] += 3;
          }
        }

        for (let sim = 0; sim < N_SIM; sim++) {
          const simStandings = {};
          for (let j = 0; j < numTeams; j++) {
            simStandings[teamsList[j]] = basePoints[teamsList[j]];
          }

          for (let j = 0; j < unplayedList.length; j++) {
            const u = unplayedList[j];
            const rand = Math.random();

            if (rand < u.probH) {
              simStandings[u.home] += 3;
            } else if (rand < u.probH + u.probD) {
              simStandings[u.home] += 1;
              simStandings[u.away] += 1;
            } else {
              simStandings[u.away] += 3;
            }
          }

          const sortedSim = [];
          for (let j = 0; j < numTeams; j++) {
            sortedSim.push({ team: teamsList[j], points: simStandings[teamsList[j]] });
          }
          sortedSim.sort((a, b) => b.points - a.points);

          for (let rank = 0; rank < sortedSim.length; rank++) {
            const teamName = sortedSim[rank].team;
            const points = sortedSim[rank].points;

            standingStats[teamName].totalPoints += points;
            if (rank === 0) standingStats[teamName].wins++;
            if (rank < 4) standingStats[teamName].europe++;
            if (rank >= numTeams - 3) standingStats[teamName].relegation++;
          }
        }

        const simStatements = [];
        const querySimInsert = "INSERT OR REPLACE INTO simulazioni_classifica (league_div, team_name, avg_points, win_pct, europe_pct, relegation_pct) VALUES (?, ?, ?, ?, ?, ?)";
        
        for (let j = 0; j < numTeams; j++) {
          const tName = teamsList[j];
          const stats = standingStats[tName];

          const avgPoints = stats.totalPoints / N_SIM;
          const winPct = (stats.wins / N_SIM) * 100;
          const europePct = (stats.europe / N_SIM) * 100;
          const relegationPct = (stats.relegation / N_SIM) * 100;

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

        if (simStatements.length > 0) {
          await dbSoglie.batch(simStatements);
        }
      }

      // Imposta lo stato della lega su "completed" (Verde 🟢)
      await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'completed')").bind(divCode).run();

      // REGOLAZIONE DINAMICA DELLA VELOCITÀ LEGGENDO IL DATABASE AD OGNI INTERVALLO
      const nitroRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'nitro_mode'").first();
      const currentNitro = nitroRes ? nitroRes.value : "1";
      const delayTime = currentNitro === "1" ? 1200 : 10000;

      // Pausa di sicurezza con tempo dinamico (10s Normal / 1.2s Nitro)
      if (i < currentBatch.length - 1 || remainingLeagues.length > 0) {
        const delayMs = (i < currentBatch.length - 1) ? delayTime : 2000;
        await delay(delayMs); 
      }
    }

    // CATENA RICORSIVA PER EVITARE I LIMITI DI SUBREQUEST [3]
    if (remainingLeagues.length > 0) {
      const nextUrl = selfUrl + "?leagues=" + remainingLeagues.join(",") + "&nitro=" + nitroMode;
      await fetch(nextUrl, { method: "POST" });
    } else {
      const adesso = new Date().toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
      await dbSoglie.batch([
        dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('last_sync', ?)").bind(adesso),
        dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('current_season', ?)").bind(rilevataStagione),
        dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'idle')")
      ]);
    }

  } catch (err) {
    console.error("Errore background sync: " + err.message);
    try {
      await dbSoglie.batch([
        dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'idle')"),
        dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', ?)").bind(err.message)
      ]);
    } catch (dbErr) {
      console.error("Impossibile salvare l'errore nel DB: " + dbErr.message);
    }
  }
}