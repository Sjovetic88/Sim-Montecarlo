export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Assegnazione dei database D1 dai binding del wrangler.toml
    const dbArchivio = env.DB_ARCHIVIO;
    const dbSoglie = env.DB_SOGLIE;
    
    // Configura la chiave API (Utilizza la chiave fornita o una variabile segreta se configurata)
    const apiKey = env.API_FOOTBALL_KEY || "10f28027ede24679b3c8d4b9cfc8948e";

    // Gestione della rotta principale (Dashboard di controllo con indicatore API rimaste)
    if (url.pathname === "/") {
      try {
        // Recupera i limiti API memorizzati nel DB SOGLIE
        const limitRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'limit'").first();
        const remainRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'remaining'").first();
        const lastSyncRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'last_sync'").first();
        
        const apiLimit = limitRes ? limitRes.value : "100";
        const apiRemaining = remainRes ? remainRes.value : "100";
        const lastSync = lastSyncRes ? lastSyncRes.value : "Mai sincronizzato";

        // Conta le partite salvate nel calendario locale del DB SOGLIE
        const countRes = await dbSoglie.prepare("SELECT COUNT(*) as totale FROM calendario_partite").first();
        const totalePartite = countRes ? countRes.totale : 0;

        // Costruzione dell'HTML mediante concatenazione stringhe pulite (senza backtick)
        let html = "<!DOCTYPE html><html><head><title>Goldbet Legislatore - Sync</title>";
        html += "<style>";
        html += "body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; margin: 0; }";
        html += ".container { max-width: 800px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); position: relative; }";
        html += ".badge { position: absolute; top: 30px; right: 30px; background: #0ea5e9; color: #fff; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 14px; box-shadow: 0 0 10px rgba(14,165,233,0.3); }";
        html += "h1 { color: #38bdf8; margin-top: 0; }";
        html += "p { color: #94a3b8; font-size: 16px; line-height: 1.6; }";
        html += ".btn { display: inline-block; background: #10b981; color: white; border: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; cursor: pointer; text-decoration: none; font-size: 16px; margin-top: 20px; transition: background 0.2s; }";
        html += ".btn:hover { background: #059669; }";
        html += ".stats { margin-top: 30px; border-top: 1px solid #334155; padding-top: 20px; }";
        html += ".stat-item { margin-bottom: 10px; font-size: 15px; }";
        html += ".stat-label { color: #94a3b8; }";
        html += ".stat-val { font-weight: bold; color: #f1f5f9; }";
        html += "</style></head><body>";
        html += "<div class='container'>";
        html += "<div class='badge'>API Rimaste: " + apiRemaining + " / " + apiLimit + "</div>";
        html += "<h1>Sincronizzatore Calendari</h1>";
        html += "<p>Questo modulo scarica in modo sicuro le partite future dei campionati attivi da API-Football e le memorizza nel database locale 'soglie_campionati'. I dati vengono allineati con i campionati censiti in 'archivio_partite'.</p>";
        
        html += "<form action='/sync' method='POST'>";
        html += "<button type='submit' class='btn'>Avvia Sincronizzazione Ora</button>";
        html += "</form>";

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

    // Rotta POST /sync per avviare il processo di importazione
    if (url.pathname === "/sync" && request.method === "POST") {
      try {
        // 1. LEGGE LE REGOLE DAL DATABASE ARCHIVIO_PARTITE (dove risiede regole_leghe)
        const leghe = await dbArchivio.prepare("SELECT div, api_id FROM regole_leghe WHERE api_id > 0").all();
        
        if (!leghe.results || leghe.results.length === 0) {
          return new Response("Nessun campionato attivo con un api_id valido trovato in regole_leghe (DB_ARCHIVIO).", { status: 400 });
        }

        let totaleInserite = 0;
        let lastLimit = "100";
        let lastRemaining = "100";
        const stagioneCorrente = "2024";

        const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        // Loop di richiesta sequenziale per rispettare i limiti di frequenza dell'API
        for (let i = 0; i < leghe.results.length; i++) {
          const lega = leghe.results[i];
          const divCode = lega.div;
          const apiId = lega.api_id;

          const apiResponse = await fetch(
            "https://v3.football.api-sports.io/fixtures?league=" + apiId + "&season=" + stagioneCorrente,
            {
              method: "GET",
              headers: {
                "x-apisports-key": apiKey,
                "x-rapidapi-key": apiKey
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

          if (data.response && data.response.length > 0) {
            const matches = data.response;
            
            // Query di inserimento sul database SOGLIE
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

            // Scrittura batch protetta sul database SOGLIE
            if (statements.length > 0) {
              await dbSoglie.batch(statements);
              totaleInserite += statements.length;
            }
          }

          if (i < leghe.results.length - 1) {
            await delay(1200); 
          }
        }

        // 2. SCRIVE LO STATO DELL'API NEL DATABASE SOGLIE
        const adesso = new Date().toISOString();
        await dbSoglie.batch([
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('limit', ?)").bind(lastLimit),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('remaining', ?)").bind(lastRemaining),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('last_sync', ?)").bind(adesso)
        ]);

        return new Response("Sincronizzazione completata! Partite elaborate in " + dbSoglie.name + ": " + totaleInserite, {
          status: 303,
          headers: { "Location": "/" }
        });

      } catch (err) {
        return new Response("Errore durante la sincronizzazione: " + err.message, { status: 500 });
      }
    }

    return new Response("Risorsa non trovata", { status: 404 });
  }
};