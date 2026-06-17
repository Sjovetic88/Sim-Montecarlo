// ABBINAMENTO CODICI -> SLUG DI MATCHESIO
const MATCHESIO_SLUGS = {
  "E0": "premier-league-gb-eng",
  "E1": "championship-gb-eng",
  "D1": "bundesliga-de",
  "I1": "serie-a-it",
  "SP1": "la-liga-es",
  "F1": "ligue-1-fr",
  "N1": "eredivisie-nl",
  "B1": "first-division-a-be",
  "P1": "primeira-liga-pt",
  "T1": "super-lig-tr",
  "DNK": "superliga-dk",
  "USA": "mls-us",
  "BRA": "serie-a-br",
  "ARG": "liga-profesional-ar",
  "NOR": "eliteserien-no",
  "SWE": "allsvenskan-se",
  "IRL": "premier-division-ie",
  "MEX": "liga-mx-mx",
  "CHN": "super-league-cn",
  "RUS": "premier-league-ru"
};

// DIZIONARIO PER RECREARE LA GRAFICA DELLA TUA FOTO (BANDIERE E NOMI PAESI)
const LEAGUE_FLAGS = {
  "ARG": "🇦🇷", "B1": "🇧🇪", "BRA": "🇧🇷", "CHN": "🇨🇳", "D1": "🇩🇪", "D2": "🇩🇪",
  "DNK": "🇩🇰", "IRL": "🇮🇪", "MEX": "🇲🇽", "NOR": "🇳🇴", "P1": "🇵🇹", "RUS": "🇷🇺",
  "SWE": "🇸🇪", "T1": "🇹🇷", "USA": "🇺🇸", "E0": "🇬🇧", "E1": "🇬🇧", "I1": "🇮🇹",
  "I2": "🇮🇹", "SP1": "🇪🇸", "F1": "🇫🇷", "N1": "🇳🇱", "G1": "🇬🇷", "AUT": "🇦🇹", "SWZ": "🇨🇭"
};

const LEAGUE_NAMES = {
  "ARG": "ARGENTINA", "B1": "BELGIUM", "BRA": "BRAZIL", "CHN": "CHINA", "D1": "GERMANY",
  "D2": "GERMANY D2", "DNK": "DENMARK", "IRL": "IRELAND", "MEX": "MEXICO", "NOR": "NORWAY",
  "P1": "PORTUGAL", "RUS": "RUSSIA", "SWE": "SWEDEN", "T1": "TURKEY", "USA": "USA",
  "E0": "ENGLAND PREMIER", "E1": "ENGLAND CHAMPIONSHIP", "I1": "ITALY SERIE A",
  "I2": "ITALY SERIE B", "SP1": "SPAIN LA LIGA", "F1": "FRANCE LIGUE 1", "N1": "NETHERLANDS EREDIVISIE"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dbArchivio = env.DB_ARCHIVIO;
    const dbSoglie = env.DB_SOGLIE;

    // 1. ROTTA PARTITE ON-DEMAND (Accordion integrato nella grafica scura)
    if (url.pathname === "/matches") {
      const leagueDiv = url.searchParams.get("league");
      if (!leagueDiv) {
        return new Response("Campionato non specificato", { status: 400 });
      }
      try {
        const matches = await dbSoglie.prepare(
          "SELECT event_date, home_team_name_api, away_team_name_api, goals_home, goals_away, status FROM calendario_partite WHERE league_div = ? ORDER BY event_date ASC"
        ).bind(leagueDiv).all();

        if (!matches.results || matches.results.length === 0) {
          return new Response("<p style='color: #94a3b8; padding: 10px; margin: 0;'>Nessuna partita scaricata per questa lega.</p>", {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }

        let tableHtml = "<table style='width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; color: #cbd5e1;'>";
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
        return new Response(tableHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      } catch (err) {
        return new Response("Errore caricamento: " + err.message, { status: 500 });
      }
    }

    // 2. ROTTA DI STATO JSON (Per Long Polling)
    if (url.pathname === "/status") {
      try {
        const lastSyncRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'last_sync'").first();
        const statusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        const errorRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'error'").first();
        const seasonRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'current_season'").first();

        const lastSync = lastSyncRes ? lastSyncRes.value : "MAI AGGIORNATO";
        const syncStatus = statusRes ? statusRes.value : "idle";
        const syncError = errorRes ? errorRes.value : null;
        const currentSeason = seasonRes ? seasonRes.value : "N.D.";

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
          leagues: statesMap
        };

        return new Response(JSON.stringify(resObj), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 3. ROTTA POST /reset (Ripristino completo del DB)
    if (url.pathname === "/reset" && request.method === "POST") {
      try {
        const resetStatements = [
          dbSoglie.prepare("DELETE FROM calendario_partite"),
          dbSoglie.prepare("UPDATE api_status SET value = 'pending' WHERE metric LIKE 'sync_league_%'"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('last_sync', 'DATI RESETTATI')"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('current_season', 'N.D.')"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', NULL)"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'idle')")
        ];
        await dbSoglie.batch(resetStatements);
        
        return new Response("", {
          status: 303,
          headers: { "Location": "/" }
        });
      } catch (err) {
        return new Response("Errore reset: " + err.message, { status: 500 });
      }
    }

    // 4. ROTTA PRINCIPALE (DASHBOARD - Grafica identica al tuo Screenshot)
    if (url.pathname === "/") {
      try {
        const statusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        const lastSyncRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'last_sync'").first();
        const errorRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'error'").first();
        const seasonRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'current_season'").first();
        
        const lastSync = lastSyncRes ? lastSyncRes.value : "MAI AGGIORNATO";
        const syncStatus = statusRes ? statusRes.value : "idle";
        const syncError = errorRes ? errorRes.value : null;
        const currentSeason = seasonRes ? seasonRes.value : "N.D.";

        const leghe = await dbArchivio.prepare("SELECT div FROM regole_leghe WHERE api_id > 0").all();
        const listaLeghe = leghe.results || [];

        const countRes = await dbSoglie.prepare("SELECT COUNT(*) as totale FROM calendario_partite").first();
        const totalePartite = countRes ? countRes.totale : 0;

        let html = "<!DOCTYPE html><html><head><title>Goldbet Montecarlo</title>";
        html += "<meta name='viewport' content='width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no'>";
        html += "<style>";
        html += "body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #000000; color: #f8fafc; padding: 20px 20px 100px 20px; margin: 0; box-sizing: border-box; }";
        html += ".container { max-width: 480px; margin: 0 auto; }";
        
        // Stile del titolo in stile GOLDBET ENGINE
        html += ".header-title { text-align: center; font-size: 24px; font-weight: 800; letter-spacing: 1px; margin-top: 10px; margin-bottom: 4px; }";
        html += ".header-title span.white { color: #ffffff; }";
        html += ".header-title span.neon { color: #00ebff; }";
        
        html += ".subtitle-stats { text-align: center; color: #94a3b8; font-size: 13px; font-weight: bold; letter-spacing: 0.5px; margin-bottom: 4px; }";
        html += ".subtitle-stats span.neon { color: #00ebff; }";
        html += ".subtitle-time { text-align: center; color: #00ebff; font-size: 11px; font-weight: 800; letter-spacing: 1.5px; margin-bottom: 25px; text-transform: uppercase; }";
        
        // Stile delle Card dei campionati
        html += ".league-item { background: #0f172a; border: 1px solid #1e293b; margin-bottom: 14px; padding: 16px; border-radius: 8px; cursor: pointer; transition: background 0.2s, border-color 0.2s; }";
        html += ".league-item:hover { background: #1e293b; border-color: #334155; }";
        html += ".league-header { display: flex; justify-content: space-between; align-items: center; font-weight: bold; font-size: 14px; letter-spacing: 0.5px; }";
        html += ".league-header span.title { display: flex; align-items: center; gap: 8px; color: #ffffff; }";
        html += ".league-header span.pct { color: #00ebff; font-weight: 800; }";
        html += ".league-sub { font-size: 11px; color: #64748b; margin-top: 6px; display: flex; align-items: center; gap: 6px; }";
        html += ".accordion-content { display: none; margin-top: 15px; border-top: 1px solid #1e293b; padding-top: 12px; overflow-x: auto; }";
        
        // Notifiche ed errori
        html += ".status-running-msg { text-align: center; color: #f59e0b; font-size: 13px; font-weight: bold; margin-bottom: 15px; }";
        html += ".error-box { background: #ef444422; border-left: 4px solid #ef4444; padding: 12px; margin-bottom: 20px; border-radius: 4px; color: #fca5a5; font-size: 13px; }";
        
        // Tab Bar Inferiore fissa in stile nativo
        html += ".bottom-nav { position: fixed; bottom: 0; left: 0; right: 0; background: #090d16; border-top: 1px solid #1e293b; display: flex; justify-content: space-around; align-items: center; padding: 10px 0; z-index: 1000; box-shadow: 0 -4px 10px rgba(0,0,0,0.5); }";
        html += ".nav-btn { background: none; border: none; display: flex; flex-direction: column; align-items: center; color: #64748b; cursor: pointer; text-decoration: none; padding: 4px 10px; }";
        html += ".nav-btn-active { color: #00ebff !important; }";
        html += ".nav-btn-disabled { opacity: 0.25; cursor: not-allowed; }";
        html += ".nav-icon { font-size: 20px; margin-bottom: 3px; }";
        html += ".nav-label { font-size: 9px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; }";
        html += "</style></head><body>";
        
        html += "<div class='container'>";
        
        // Titolo in Stile GOLDBET MONTECARLO
        html += "<div class='header-title'><span class='white'>GOLDBET</span> <span class='neon'>MONTECARLO</span></div>";
        html += "<div class='subtitle-stats'><span id='stat-totale' class='neon'>" + totalePartite + "</span> PARTITE SALVATE | STAGIONE <span id='stat-season' class='neon'>" + currentSeason + "</span></div>";
        html += "<div class='subtitle-time'>ULTIMO AGGIORNAMENTO <span id='stat-last-sync'>" + lastSync + "</span></div>";

        if (syncStatus === "running") {
          html += "<div id='sync-msg' class='status-running-msg'>Sincronizzazione in corso... ricarica tra poco per seguire l'avanzamento.</div>";
        } else {
          html += "<div id='sync-msg' style='display:none;' class='status-running-msg'></div>";
        }

        if (syncError) {
          html += "<div id='error-box' class='error-box'><strong>Ultimo Errore:</strong> " + syncError + "</div>";
        } else {
          html += "<div id='error-box' class='error-box' style='display:none;'></div>";
        }

        // Elenco campionati
        html += "<div class='league-list'>";
        
        for (let i = 0; i < listaLeghe.length; i++) {
          const l = listaLeghe[i];
          const code = l.div;
          
          const lStatusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'sync_league_' || ?").bind(code).first();
          const lStatus = lStatusRes ? lStatusRes.value : "pending";
          
          // Definiamo il testo della percentuale in stile Engine
          let pct = "0.0%";
          let emoji = "🔴";
          if (lStatus === "syncing") {
            pct = "SYNCING";
            emoji = "🟡";
          } else if (lStatus === "completed") {
            pct = "100.0%";
            emoji = "🟢";
          }

          const flag = LEAGUE_FLAGS[code] || "⚽";
          const fullLabel = LEAGUE_NAMES[code] || code;

          // Recuperiamo la data dell'ultimo match salvato per questo campionato
          const lastMatchRes = await dbSoglie.prepare("SELECT MAX(event_date) as ultima FROM calendario_partite WHERE league_div = ?").bind(code).first();
          const ultimaData = lastMatchRes && lastMatchRes.ultima ? new Date(lastMatchRes.ultima).toLocaleDateString("it-IT", { year: "numeric", month: "2-digit", day: "2-digit" }) : "N.D.";

          html += "<div class='league-item' onclick='toggleLeague(\"" + code + "\")'>";
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
        html += "</div>";
        html += "</div>"; // Chiude container

        // Tab Bar Inferiore fissa con i 6 pulsanti del tuo Screenshot (start e reset attivi)
        html += "<div class='bottom-nav'>";
        
        // 1. ALL (Visuale)
        html += "<div class='nav-btn nav-btn-disabled'><span class='nav-icon'>☑️</span><span class='nav-label'>ALL</span></div>";
        
        // 2. PROCESS (🔄 Cliccabile: Aggiorna lo stato della pagina)
        html += "<button onclick='window.location.reload()' class='nav-btn nav-btn-active'><span class='nav-icon'>🔄</span><span class='nav-label'>PROCESS</span></button>";
        
        // 3. START (▶️ Cliccabile: Avvia Sincronizzazione)
        if (syncStatus === "running") {
          html += "<div class='nav-btn nav-btn-disabled'><span class='nav-icon'>▶️</span><span class='nav-label' style='color: #475569;'>START</span></div>";
        } else {
          html += "<form id='sync-form' action='/sync' method='POST' style='margin:0;'>";
          html += "<button type='submit' class='nav-btn' style='color: #10b981;'><span class='nav-icon'>▶️</span><span class='nav-label'>START</span></button>";
          html += "</form>";
        }

        // 4. PAUSA (Visuale)
        html += "<div class='nav-btn nav-btn-disabled'><span class='nav-icon'>⏸️</span><span class='nav-label'>PAUSA</span></div>";
        
        // 5. NITRO (Visuale)
        html += "<div class='nav-btn nav-btn-disabled'><span class='nav-icon'>🔥</span><span class='nav-label'>NITRO</span></div>";
        
        // 6. RESET (⛔ Cliccabile: Cancella i dati con conferma)
        if (syncStatus === "running") {
          html += "<div class='nav-btn nav-btn-disabled'><span class='nav-icon'>⛔</span><span class='nav-label' style='color: #475569;'>RESET</span></div>";
        } else {
          html += "<form action='/reset' method='POST' onsubmit=\"return confirm('Sei sicuro di voler azzerare ed eliminare tutte le partite dal database?')\" style='margin:0;'>";
          html += "<button type='submit' class='nav-btn' style='color: #ef4444;'><span class='nav-icon'>⛔</span><span class='nav-label'>RESET</span></button>";
          html += "</form>";
        }

        html += "</div>"; // Chiude bottom-nav

        // CODICE JAVASCRIPT LATO CLIENT (Gestisce l'interfaccia interattiva dell'utente)
        html += "<script>";
        html += "async function toggleLeague(code) {";
        html += "  const el = document.getElementById('content-' + code);";
        html += "  if (el.style.display === 'block') {";
        html += "    el.style.display = 'none';";
        html += "  } else {";
        html += "    el.style.display = 'block';";
        html += "    el.innerHTML = 'Caricamento partite...';";
        html += "    const r = await fetch('/matches?league=' + code);";
        html += "    el.innerHTML = await r.text();";
        html += "  }";
        html += "}";

        html += "async function updateStatus() {";
        html += "  try {";
        html += "    const r = await fetch('/status');";
        html += "    if (!r.ok) return;";
        html += "    const data = await r.json();";
        html += "    document.getElementById('stat-last-sync').innerText = data.lastSync;";
        html += "    document.getElementById('stat-totale').innerText = data.totale;";
        html += "    document.getElementById('stat-season').innerText = data.season;";
        
        html += "    if (data.status === 'running') {";
        html += "      document.getElementById('sync-msg').style.display = 'block';";
        html += "      document.getElementById('sync-msg').innerText = 'Sincronizzazione in corso... ricarica tra poco per seguire l\\\'avanzamento.';";
        html += "    } else {";
        html += "      document.getElementById('sync-msg').style.display = 'none';";
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
        html += "          if (subEl) subEl.innerText = 'Download del calendario in corso...';";
        html += "        } else if (val === 'completed') {";
        html += "          pctEl.innerText = '100.0%';";
        html += "        } else {";
        html += "          pctEl.innerText = '0.0%';";
        html += "          if (subEl) subEl.innerText = 'In attesa di sincronizzazione';";
        html += "        }";
        html += "      }";
        html += "    }";
        html += "  } catch(e) {}";
        html += "}";

        html += "setInterval(updateStatus, 2500);";
        html += "</script>";

        html += "</body></html>";

        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      } catch (err) {
        return new Response("Errore caricamento dashboard: " + err.message, { status: 500 });
      }
    }

    // 5. ROTTA POST /sync (RICEZIONE E AVVIO BACKGROUND)
    if (url.pathname === "/sync" && request.method === "POST") {
      try {
        const statusCheck = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        if (statusCheck && statusCheck.value === "running") {
          return new Response("", { status: 303, headers: { "Location": "/" } });
        }

        const leghe = await dbArchivio.prepare("SELECT div FROM regole_leghe WHERE api_id > 0").all();
        const listaLeghe = leghe.results || [];

        const resetStatements = [
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'running')"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', NULL)")
        ];

        for (let i = 0; i < listaLeghe.length; i++) {
          resetStatements.push(
            dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'pending')").bind(listaLeghe[i].div)
          );
        }

        await dbSoglie.batch(resetStatements);

        // Avvio background asincrono pulito
        ctx.waitUntil(
          runBackgroundSync(dbArchivio, dbSoglie)
        );

        return new Response("", {
          status: 303,
          headers: { "Location": "/" }
        });

      } catch (err) {
        return new Response("Errore avvio sincronizzazione: " + err.message, { status: 500 });
      }
    }

    return new Response("Risorsa non trovata", { status: 404 });
  }
};

// COMPITO IN BACKGROUND TOTALMENTE SCONNESSO DA VECCHIA API-FOOTBALL
async function runBackgroundSync(dbArchivio, dbSoglie) {
  try {
    const leghe = await dbArchivio.prepare("SELECT div FROM regole_leghe WHERE api_id > 0").all();
    
    if (!leghe.results || leghe.results.length === 0) {
      throw new Error("Nessun campionato attivo con un api_id valido trovato in regole_leghe.");
    }

    let totaleInserite = 0;
    let rilevataStagione = "N.D.";
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    for (let i = 0; i < leghe.results.length; i++) {
      const lega = leghe.results[i];
      const divCode = lega.div;
      const slug = MATCHESIO_SLUGS[divCode];

      if (!slug) {
        console.log("Nessuno slug Matchesio trovato per il codice " + divCode);
        continue;
      }

      // Imposta lo stato della lega su "syncing" (Giallo 🟡)
      await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'syncing')").bind(divCode).run();

      // INDIRIZZO DIRETTO DI SCARICAMENTO JSON GRATUITO DA MATCHESIO
      const urlExport = "https://www.matchesio.com/competition/" + slug + "/export/json";
      
      const apiResponse = await fetch(urlExport, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      });

      if (!apiResponse.ok) {
        console.log("Errore scaricamento calendario da Matchesio per " + divCode);
        continue;
      }

      const matches = await apiResponse.json();

      if (matches && matches.length > 0) {
        // Estrae il nome della stagione reale (es. "2025/26") direttamente dalla prima riga del file Matchesio
        if (matches[0].season) {
          rilevataStagione = matches[0].season;
        }

        // INSERT OR REPLACE: Cancella la vecchia partita con lo stesso fixture_id (m.id) e la risovrascrive aggiornata
        const queryInsert = "INSERT OR REPLACE INTO calendario_partite (fixture_id, league_id, league_div, round, event_date, home_team_id_api, home_team_name_api, home_team_id_local, away_team_id_api, away_team_name_api, away_team_id_local, goals_home, goals_away, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        const statements = [];

        for (let j = 0; j < matches.length; j++) {
          const m = matches[j];
          
          const timestampPartita = m.date + "T" + m.time + ":00Z";
          const roundString = "Giornata " + m.matchday;

          let goalsHome = null;
          let goalsAway = null;
          if (m.status === "Played" && m.result && m.result.indexOf("-") !== -1) {
            const score = m.result.split("-");
            goalsHome = parseInt(score[0].trim(), 10);
            goalsAway = parseInt(score[1].trim(), 10);
          }

          // Disabilitata temporaneamente la validazione degli alias per scaricare tutto subito
          const homeLocalId = 0;
          const awayLocalId = 0;

          statements.push(
            dbSoglie.prepare(queryInsert).bind(
              m.id,
              0, 
              divCode,
              roundString,
              timestampPartita,
              0, 
              m.homeTeam,
              homeLocalId,
              0, 
              m.awayTeam,
              awayLocalId,
              goalsHome,
              goalsAway,
              m.status
            )
          );
        }

        if (statements.length > 0) {
          await dbSoglie.batch(statements);
          totaleInserite += statements.length;
        }
      }

      // Imposta lo stato della lega su "completed" (Verde 🟢)
      await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'completed')").bind(divCode).run();

      // Pausa di sicurezza di 10 secondi per tutelare i limiti di rete del server
      if (i < leghe.results.length - 1) {
        await delay(10000); 
      }
    }

    const adesso = new Date().toLocaleString("it-IT", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    await dbSoglie.batch([
      dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('last_sync', ?)").bind(adesso),
      dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('current_season', ?)").bind(rilevataStagione),
      dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'idle')")
    ]);

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