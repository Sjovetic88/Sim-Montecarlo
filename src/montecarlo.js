export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dbArchivio = env.DB_ARCHIVIO;
    const dbSoglie = env.DB_SOGLIE;
    
    // SISTEMA DI CONTROLLO BLINDATO DELLA CHIAVE API
    // Se la variabile di Cloudflare è vuota o scritta come stringa "undefined", forziamo la tua chiave reale
    let apiKey = env.API_FOOTBALL_KEY;
    if (!apiKey || apiKey === "undefined" || apiKey.trim() === "") {
      apiKey = "10f28027ede24679b3c8d4b9cfc8948e";
    }

    // 1. ROTTA PRINCIPALE (DASHBOARD)
    if (url.pathname === "/") {
      try {
        const limitRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'limit'").first();
        const remainRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'remaining'").first();
        const lastSyncRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'last_sync'").first();
        const statusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        const errorRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'error'").first();
        
        const apiLimit = limitRes ? limitRes.value : "100";
        const apiRemaining = remainRes ? remainRes.value : "100";
        const lastSync = lastSyncRes ? lastSyncRes.value : "Mai sincronizzato";
        const syncStatus = statusRes ? statusRes.value : "idle";
        const syncError = errorRes ? errorRes.value : null;

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
        html += ".stats { margin-top: 30px; border-top: 1px solid #334155; padding-top: 20px; }";
        html += ".stat-item { margin-bottom: 10px; font-size: 15px; }";
        html += ".stat-label { color: #94a3b8; }";
        html += ".stat-val { font-weight: bold; color: #f1f5f9; }";
        html += ".status-running { color: #f59e0b; font-weight: bold; }";
        html += ".error-box { background: #ef444422; border-left: 4px solid #ef4444; padding: 15px; margin-top: 20px; border-radius: 4px; color: #fca5a5; font-size: 14px; line-height: 1.5; }";
        html += "</style></head><body>";
        html += "<div class='container'>";
        html += "<div class='badge'>API Rimaste: " + apiRemaining + " / " + apiLimit + "</div>";
        html += "<h1>Sincronizzatore Calendari</h1>";
        html += "<p>Questo modulo scarica in background le partite future dei campionati attivi da API-Football e le memorizza nel database 'soglie_campionati'.</p>";
        
        if (syncStatus === "running") {
          html += "<button class='btn' disabled>Sincronizzazione in corso...</button>";
          html += "<p class='status-running'>La sincronizzazione è attiva in background. Ricarica la pagina tra 30 secondi per vedere i risultati.</p>";
        } else {
          html += "<form action='/sync' method='POST'>";
          html += "<button type='submit' class='btn'>Avvia Sincronizzazione Ora</button>";
          html += "</form>";
        }

        if (syncError) {
          html += "<div class='error-box'><strong>Ultimo Errore registrato:</strong> " + syncError + "</div>";
        }

        html += "<div class='stats'>";
        html += "<div class='stat-item'><span class='stat-label'>Ultimo aggiornamento: </span><span class='stat-val'>" + lastSync + "</span></div>";
        html += "<div class='stat-item'><span class='stat-label'>Partite attualmente salvate: </span><span class='stat-val'>" + totalePartite + "</span></div>";
        html += "</div>";
        html += "</div></body></html>";

        return new Response(html, {
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      } catch (err) {
        return new Response("Errore nel caricamento della dashboard: " + err.message, { status: 500 });
      }
    }

    // 2. ROTTA POST /sync (AVVIO DELLA CODA IN BACKGROUND)
    if (url.pathname === "/sync" && request.method === "POST") {
      try {
        const statusCheck = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        if (statusCheck && statusCheck.value === "running") {
          return new Response("", { status: 303, headers: { "Location": "/" } });
        }

        await dbSoglie.batch([
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'running')"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', NULL)")
        ]);

        // Stampiamo un log di controllo per verificare quale chiave stiamo caricando
        console.log("Inizio sincronizzazione. Chiave utilizzata (prime 4 lettere): " + apiKey.substring(0, 4));

        ctx.waitUntil(
          runBackgroundSync(dbArchivio, dbSoglie, apiKey)
        );

        return new Response("", {
          status: 303,
          headers: { "Location": "/" }
        });

      } catch (err) {
        return new Response("Errore nell'avvio della sincronizzazione: " + err.message, { status: 500 });
      }
    }

    return new Response("Risorsa non trovata", { status: 404 });
  }
};

// FUNZIONE IN BACKGROUND
async function runBackgroundSync(dbArchivio, dbSoglie, apiKey) {
  try {
    const leghe = await dbArchivio.prepare("SELECT div, api_id FROM regole_leghe WHERE api_id > 0").all();
    
    if (!leghe.results || leghe.results.length === 0) {
      throw new Error("Nessun campionato attivo con un api_id valido trovato in regole_leghe (DB_ARCHIVIO).");
    }

    let totaleInserite = 0;
    let lastLimit = "100";
    let lastRemaining = "100";
    const stagioneCorrente = "2024";

    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    for (let i = 0; i < leghe.results.length; i++) {
      const lega = leghe.results[i];
      const divCode = lega.div;
      const apiId = lega.api_id;

      // Chiamata con Header pulito e specifico per API-Sports
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

      if (i < leghe.results.length - 1) {
        await delay(1200); 
      }
    }

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