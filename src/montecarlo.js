export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dbArchivio = env.DB_ARCHIVIO;
    const dbSoglie = env.DB_SOGLIE;
    
    // Configura la chiave API (con fallback di sicurezza alla tua nuova chiave)
    let apiKey = env.API_FOOTBALL_KEY;
    if (!apiKey || apiKey === "undefined" || apiKey.trim() === "") {
      apiKey = "a045158f354f22a763d193b99f52ae48";
    }

    // 1. ROTTA PARTITE ON-DEMAND (Ritorna l'HTML delle partite per l'accordion)
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
          return new Response("<p style='color: #94a3b8; padding: 10px; margin: 0;'>Nessuna partita salvata per questo campionato.</p>", {
            headers: { "Content-Type": "text/html; charset=utf-8" }
          });
        }

        let tableHtml = "<table style='width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; color: #cbd5e1;'>";
        tableHtml += "<thead><tr style='border-bottom: 1px solid #475569; text-align: left;'><th style='padding: 8px;'>Data</th><th style='padding: 8px;'>Casa</th><th style='padding: 8px; text-align: center;'>Risultato</th><th style='padding: 8px;'>Fuori</th><th style='padding: 8px;'>Stato</th></tr></thead><tbody>";

        for (let i = 0; i < matches.results.length; i++) {
          const m = matches.results[i];
          const dataLocale = new Date(m.event_date).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
          const risHome = m.goals_home !== null ? m.goals_home : "-";
          const risAway = m.goals_away !== null ? m.goals_away : "-";
          const risString = risHome + " - " + risAway;

          tableHtml += "<tr style='border-bottom: 1px solid #334155;'>";
          tableHtml += "<td style='padding: 8px;'>" + dataLocale + "</td>";
          tableHtml += "<td style='padding: 8px; font-weight: bold;'>" + m.home_team_name_api + "</td>";
          tableHtml += "<td style='padding: 8px; text-align: center; font-weight: bold; color: #10b981;'>" + risString + "</td>";
          tableHtml += "<td style='padding: 8px; font-weight: bold;'>" + m.away_team_name_api + "</td>";
          tableHtml += "<td style='padding: 8px; color: #94a3b8;'>" + m.status + "</td>";
          tableHtml += "</tr>";
        }

        tableHtml += "</tbody></table>";
        return new Response(tableHtml, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      } catch (err) {
        return new Response("Errore caricamento partite: " + err.message, { status: 500 });
      }
    }

    // 2. ROTTA DI STATO (Restituisce lo stato JSON per il Long Polling della dashboard)
    if (url.pathname === "/status") {
      try {
        const limitRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'limit'").first();
        const remainRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'remaining'").first();
        const statusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        const lastSyncRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'last_sync'").first();
        const errorRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'error'").first();

        const apiLimit = limitRes ? limitRes.value : "100";
        const apiRemaining = remainRes ? remainRes.value : "100";
        const syncStatus = statusRes ? statusRes.value : "idle";
        const lastSync = lastSyncRes ? lastSyncRes.value : "Mai sincronizzato";
        const syncError = errorRes ? errorRes.value : null;

        // Recupera gli stati individuali dei campionati
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
          limit: apiLimit,
          remaining: apiRemaining,
          status: syncStatus,
          lastSync: lastSync,
          error: syncError,
          totale: totalePartite,
          leagues: statesMap
        };

        return new Response(JSON.stringify(resObj), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 3. ROTTA PRINCIPALE (DASHBOARD)
    if (url.pathname === "/") {
      try {
        const limitRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'limit'").first();
        const remainRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'remaining'").first();
        const statusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        const lastSyncRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'last_sync'").first();
        const errorRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'error'").first();
        
        const apiLimit = limitRes ? limitRes.value : "100";
        const apiRemaining = remainRes ? remainRes.value : "100";
        const lastSync = lastSyncRes ? lastSyncRes.value : "Mai sincronizzato";
        const syncStatus = statusRes ? statusRes.value : "idle";
        const syncError = errorRes ? errorRes.value : null;

        // Recupera le leghe attive da DB_ARCHIVIO
        const leghe = await dbArchivio.prepare("SELECT div FROM regole_leghe WHERE api_id > 0").all();
        const listaLeghe = leghe.results || [];

        const countRes = await dbSoglie.prepare("SELECT COUNT(*) as totale FROM calendario_partite").first();
        const totalePartite = countRes ? countRes.totale : 0;

        let html = "<!DOCTYPE html><html><head><title>Goldbet Legislatore - Sync</title>";
        html += "<style>";
        html += "body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; margin: 0; }";
        html += ".container { max-width: 800px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); position: relative; }";
        html += ".badge { position: absolute; top: 30px; right: 30px; background: #0ea5e9; color: #fff; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 14px; box-shadow: 0 0 10px rgba(14,165,233,0.3); }";
        html += "h1 { color: #38bdf8; margin-top: 0; }";
        html += "p { color: #94a3b8; font-size: 16px; line-height: 1.6; }";
        html += ".btn { display: inline-block; background: #10b981; color: white; border: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; cursor: pointer; text-decoration: none; font-size: 16px; margin-top: 20px; }";
        html += ".btn:hover { background: #059669; }";
        html += ".btn:disabled { background: #475569; cursor: not-allowed; }";
        html += ".league-list { margin-top: 30px; }";
        html += ".league-item { background: #334155; margin-bottom: 12px; padding: 15px; border-radius: 8px; cursor: pointer; transition: background 0.2s; }";
        html += ".league-item:hover { background: #475569; }";
        html += ".league-header { display: flex; justify-content: space-between; align-items: center; font-weight: bold; }";
        html += ".accordion-content { display: none; margin-top: 15px; border-top: 1px solid #475569; padding-top: 10px; }";
        html += ".status-running { color: #f59e0b; font-weight: bold; }";
        html += ".error-box { background: #ef444422; border-left: 4px solid #ef4444; padding: 15px; margin-top: 20px; border-radius: 4px; color: #fca5a5; font-size: 14px; }";
        html += ".stats { margin-top: 30px; border-top: 1px solid #334155; padding-top: 20px; }";
        html += ".stat-item { margin-bottom: 10px; font-size: 15px; }";
        html += ".stat-label { color: #94a3b8; }";
        html += ".stat-val { font-weight: bold; color: #f1f5f9; }";
        html += "</style></head><body>";
        html += "<div class='container'>";
        html += "<div id='api-badge' class='badge'>API Rimaste: " + apiRemaining + " / " + apiLimit + "</div>";
        html += "<h1>Sincronizzatore Calendari</h1>";
        html += "<p>Scarica in background le partite dei campionati attivi in 'archivio_partite' e le memorizza in 'soglie_campionati' sovrascrivendo i vecchi dati.</p>";
        
        if (syncStatus === "running") {
          html += "<button id='sync-btn' class='btn' disabled>Sincronizzazione in corso...</button>";
          html += "<p id='sync-msg' class='status-running'>Sincronizzazione in corso (pausa di 10s anti rate-limit). Le emoji indicano lo stato di ogni lega.</p>";
        } else {
          html += "<form action='/sync' method='POST'>";
          html += "<button id='sync-btn' type='submit' class='btn'>Avvia Sincronizzazione Ora</button>";
          html += "</form>";
          html += "<p id='sync-msg' style='display:none;' class='status-running'></p>";
        }

        if (syncError) {
          html += "<div id='error-box' class='error-box'><strong>Ultimo Errore:</strong> " + syncError + "</div>";
        } else {
          html += "<div id='error-box' class='error-box' style='display:none;'></div>";
        }

        html += "<div class='league-list'>";
        html += "<h3>Stato Campionati</h3>";
        
        for (let i = 0; i < listaLeghe.length; i++) {
          const l = listaLeghe[i];
          const code = l.div;
          
          // Recupera lo stato individuale salvato in DB SOGLIE per questa lega
          const lStatusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'sync_league_' || ?").bind(code).first();
          const lStatus = lStatusRes ? lStatusRes.value : "pending";
          
          let emoji = "🔴";
          if (lStatus === "syncing") emoji = "🟡";
          if (lStatus === "completed") emoji = "🟢";

          html += "<div class='league-item' onclick='toggleLeague(\"" + code + "\")'>";
          html += "<div class='league-header'>";
          html += "<span>" + code + "</span>";
          html += "<span id='emoji-" + code + "'>" + emoji + "</span>";
          html += "</div>";
          html += "<div class='accordion-content' id='content-" + code + "'>";
          html += "Caricamento partite...";
          html += "</div>";
          html += "</div>";
        }
        html += "</div>";

        html += "<div class='stats'>";
        html += "<div class='stat-item'><span class='stat-label'>Ultimo aggiornamento: </span><span id='stat-last-sync' class='stat-val'>" + lastSync + "</span></div>";
        html += "<div class='stat-item'><span class='stat-label'>Partite attualmente salvate: </span><span id='stat-totale' class='stat-val'>" + totalePartite + "</span></div>";
        html += "</div>";
        html += "</div>";

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
        html += "    document.getElementById('api-badge').innerText = 'API Rimaste: ' + data.remaining + ' / ' + data.limit;";
        html += "    document.getElementById('stat-last-sync').innerText = data.lastSync;";
        html += "    document.getElementById('stat-totale').innerText = data.totale;";
        
        html += "    if (data.status === 'running') {";
        html += "      document.getElementById('sync-btn').disabled = true;";
        html += "      document.getElementById('sync-btn').innerText = 'Sincronizzazione in corso...';";
        html += "      document.getElementById('sync-msg').style.display = 'block';";
        html += "      document.getElementById('sync-msg').innerText = 'Sincronizzazione attiva in background (10s di pausa tra campionati).';";
        html += "    } else {";
        html += "      document.getElementById('sync-btn').disabled = false;";
        html += "      document.getElementById('sync-btn').innerText = 'Avvia Sincronizzazione Ora';";
        html += "      document.getElementById('sync-msg').style.display = 'none';";
        html += "    }";

        html += "    if (data.error) {";
        html += "      document.getElementById('error-box').style.display = 'block';";
        html += "      document.getElementById('error-box').innerHTML = '<strong>Ultimo Errore:</strong> ' + data.error;";
        html += "    } else {";
        html += "      document.getElementById('error-box').style.display = 'none';";
        html += "    }";

        html += "    for (const [code, val] of Object.entries(data.leagues)) {";
        html += "      const emojiEl = document.getElementById('emoji-' + code);";
        html += "      if (emojiEl) {";
        html += "        if (val === 'syncing') emojiEl.innerText = '🟡';";
        html += "        else if (val === 'completed') emojiEl.innerText = '🟢';";
        html += "        else emojiEl.innerText = '🔴';";
        html += "      }";
        html += "    }";
        html += "  } catch(e) {}";
        html += "}";

        // Avvia il Long Polling ogni 2.5 secondi
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

    // 4. ROTTA POST /sync (RICEZIONE E AVVIO BACKGROUND CODA)
    if (url.pathname === "/sync" && request.method === "POST") {
      try {
        const statusCheck = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        if (statusCheck && statusCheck.value === "running") {
          return new Response("", { status: 303, headers: { "Location": "/" } });
        }

        // Recupera le leghe da azzerare nel database archivio
        const leghe = await dbArchivio.prepare("SELECT div FROM regole_leghe WHERE api_id > 0").all();
        const listaLeghe = leghe.results || [];

        const resetStatements = [
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'running')"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', NULL)")
        ];

        // Resettiamo a rosso (pending) tutte le leghe attive prima di partire
        for (let i = 0; i < listaLeghe.length; i++) {
          resetStatements.push(
            dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'pending')").bind(listaLeghe[i].div)
          );
        }

        await dbSoglie.batch(resetStatements);

        // Avviamo l'esecuzione in background e ritorniamo istantaneamente alla home
        ctx.waitUntil(
          runBackgroundSync(dbArchivio, dbSoglie, apiKey)
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

// COMPITO IN BACKGROUND CON OPZIONE B + PAUSA 10 SECONDI
async function runBackgroundSync(dbArchivio, dbSoglie, apiKey) {
  try {
    const leghe = await dbArchivio.prepare("SELECT div, api_id FROM regole_leghe WHERE api_id > 0").all();
    
    if (!leghe.results || leghe.results.length === 0) {
      throw new Error("Nessun campionato attivo con un api_id valido trovato in regole_leghe.");
    }

    let totaleInserite = 0;
    let lastLimit = "100";
    let lastRemaining = "100";
    
    // Lista dei campionati estivi per l'Opzione B
    const campionatiEstivi = ["USA", "BRA", "NOR", "SWE", "IRL", "CHN"];
    
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1; // Mese corrente (1-12)

    // Ritardo di 10 secondi per tutelare i limiti API-Football
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    for (let i = 0; i < leghe.results.length; i++) {
      const lega = leghe.results[i];
      const divCode = lega.div;
      const apiId = lega.api_id;

      // Imposta lo stato della singola lega su "syncing" (Giallo 🟡)
      await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'syncing')").bind(divCode).run();

      // LOGICA OPZIONE B: Calcolo automatico della stagione
      let stagioneCorrente = currentYear;
      if (campionatiEstivi.indexOf(divCode) === -1) {
        // Campionato europeo invernale
        if (currentMonth < 7) {
          stagioneCorrente = currentYear - 1;
        } else {
          stagioneCorrente = currentYear;
        }
      }

      const apiResponse = await fetch(
        "https://v3.football.api-sports.io/fixtures?league=" + apiId + "&season=" + stagioneCorrente,
        {
          method: "GET",
          headers: {
            "x-apisports-key": apiKey
          }
        }
      );

      if (!apiResponse.ok) {
        console.log("Errore chiamata API per lega " + divCode);
        continue;
      }

      const hLimit = apiResponse.headers.get("x-ratelimit-requests-limit");
      const hRemaining = apiResponse.headers.get("x-ratelimit-requests-remaining");
      if (hLimit) lastLimit = hLimit;
      if (hRemaining) lastRemaining = hRemaining;

      const data = await apiResponse.json();

      if (data.errors && Object.keys(data.errors).length > 0) {
        const errorMsg = JSON.stringify(data.errors);
        throw new Error("Errore da API-Football: " + errorMsg);
      }

      if (data.response && data.response.length > 0) {
        const matches = data.response;
        
        // INSERT OR REPLACE: Cancella la vecchia partita con lo stesso fixture_id e la risovrascrive aggiornata
        const queryInsert = "INSERT OR REPLACE INTO calendario_partite (fixture_id, league_id, league_div, round, event_date, home_team_id_api, home_team_name_api, away_team_id_api, away_team_name_api, goals_home, goals_away, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        
        const statements = [];
        
        for (let j = 0; j < matches.length; j++) {
          const m = matches[j];
          const goalsHome = m.goals.home !== null ? m.goals.home : null;
          const goalsAway = m.goals.away !== null ? m.goals.away : null;

          statements.push(
            dbSoglie.prepare(queryInsert).bind(
              m.fixture.id,
              m.league.id,
              divCode,
              m.league.round,
              m.fixture.date,
              m.teams.home.id,
              m.teams.home.name,
              m.teams.away.id,
              m.teams.away.name,
              goalsHome,
              goalsAway,
              m.fixture.status.short
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

      // Pausa di sicurezza di 10 secondi prima del campionato successivo
      if (i < leghe.results.length - 1) {
        await delay(10000); 
      }
    }

    // Aggiorna lo stato generale su "idle" al completamento
    const adesso = new Date().toISOString();
    await dbSoglie.batch([
      dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('limit', ?)").bind(lastLimit),
      dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('remaining', ?)").bind(lastRemaining),
      dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('last_sync', ?)").bind(adesso),
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