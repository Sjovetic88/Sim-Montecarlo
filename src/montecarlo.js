// MAPPATURA CODICI FOOTBALL-DATA -> SLUG DI MATCHESIO
// Aggiungi o modifica qui gli abbinamenti se necessario
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dbArchivio = env.DB_ARCHIVIO;
    const dbSoglie = env.DB_SOGLIE;

    // 1. ROTTA PARTITE ON-DEMAND (Accordion dettagliato)
    if (url.pathname === "/matches") {
      const leagueDiv = url.searchParams.get("league");
      if (!leagueDiv) {
        return new Response("Campionato non specificato", { status: 400 });
      }
      try {
        const matches = await dbSoglie.prepare(
          "SELECT event_date, home_team_name_api, away_team_name_api, goals_home, goals_away, status, home_team_id_local, away_team_id_local FROM calendario_partite WHERE league_div = ? ORDER BY event_date ASC"
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

          // Se la squadra non è associata (ID locale è NULL), coloriamo il nome in arancione per avvisare
          const homeStyle = m.home_team_id_local === null ? "color: #f59e0b; font-weight: bold;" : "font-weight: bold;";
          const awayStyle = m.away_team_id_local === null ? "color: #f59e0b; font-weight: bold;" : "font-weight: bold;";

          tableHtml += "<tr style='border-bottom: 1px solid #334155;'>";
          tableHtml += "<td style='padding: 8px;'>" + dataLocale + "</td>";
          tableHtml += "<td style='padding: 8px; " + homeStyle + "'>" + m.home_team_name_api + "</td>";
          tableHtml += "<td style='padding: 8px; text-align: center; font-weight: bold; color: #10b981;'>" + risString + "</td>";
          tableHtml += "<td style='padding: 8px; " + awayStyle + "'>" + m.away_team_name_api + "</td>";
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

    // 2. ROTTA DI STATO JSON (Per Long Polling)
    if (url.pathname === "/status") {
      try {
        const lastSyncRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'last_sync'").first();
        const statusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        const errorRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'error'").first();
        const seasonRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'current_season'").first();

        const lastSync = lastSyncRes ? lastSyncRes.value : "Mai sincronizzato";
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

        // Recuperiamo eventuali alias pendenti non ancora registrati (con team_id = NULL)
        const pendingAliases = await dbArchivio.prepare("SELECT COUNT(*) as totale FROM team_aliases WHERE team_id IS NULL").first();
        const numPending = pendingAliases ? pendingAliases.totale : 0;

        const resObj = {
          status: syncStatus,
          lastSync: lastSync,
          error: syncError,
          totale: totalePartite,
          season: currentSeason,
          pending: numPending,
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
        const statusRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        const lastSyncRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'last_sync'").first();
        const errorRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'error'").first();
        const seasonRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'current_season'").first();
        
        const lastSync = lastSyncRes ? lastSyncRes.value : "Mai sincronizzato";
        const syncStatus = statusRes ? statusRes.value : "idle";
        const syncError = errorRes ? errorRes.value : null;
        const currentSeason = seasonRes ? seasonRes.value : "N.D.";

        const leghe = await dbArchivio.prepare("SELECT div FROM regole_leghe WHERE api_id > 0").all();
        const listaLeghe = leghe.results || [];

        const countRes = await dbSoglie.prepare("SELECT COUNT(*) as totale FROM calendario_partite").first();
        const totalePartite = countRes ? countRes.totale : 0;

        const pendingAliases = await dbArchivio.prepare("SELECT COUNT(*) as totale FROM team_aliases WHERE team_id IS NULL").first();
        const numPending = pendingAliases ? pendingAliases.totale : 0;

        let html = "<!DOCTYPE html><html><head><title>Goldbet Legislatore - Sync</title>";
        html += "<style>";
        html += "body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #0f172a; color: #f8fafc; padding: 40px; margin: 0; }";
        html += ".container { max-width: 800px; margin: 0 auto; background: #1e293b; padding: 30px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); position: relative; }";
        html += ".badge { position: absolute; top: 30px; right: 30px; background: #10b981; color: #fff; padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 14px; box-shadow: 0 0 10px rgba(16,185,129,0.3); }";
        html += "h1 { color: #38bdf8; margin-top: 0; }";
        html += "p { color: #94a3b8; font-size: 16px; line-height: 1.6; }";
        html += ".btn { display: inline-block; background: #3b82f6; color: white; border: none; padding: 12px 24px; border-radius: 6px; font-weight: bold; cursor: pointer; text-decoration: none; font-size: 16px; margin-top: 20px; }";
        html += ".btn:hover { background: #2563eb; }";
        html += ".btn:disabled { background: #475569; cursor: not-allowed; }";
        html += ".league-list { margin-top: 30px; }";
        html += ".league-item { background: #334155; margin-bottom: 12px; padding: 15px; border-radius: 8px; cursor: pointer; transition: background 0.2s; }";
        html += ".league-item:hover { background: #475569; }";
        html += ".league-header { display: flex; justify-content: space-between; align-items: center; font-weight: bold; }";
        html += ".accordion-content { display: none; margin-top: 15px; border-top: 1px solid #475569; padding-top: 10px; }";
        html += ".status-running { color: #f59e0b; font-weight: bold; }";
        html += ".error-box { background: #ef444422; border-left: 4px solid #ef4444; padding: 15px; margin-top: 20px; border-radius: 4px; color: #fca5a5; font-size: 14px; }";
        html += ".alert-box { background: #f59e0b22; border-left: 4px solid #f59e0b; padding: 15px; margin-top: 20px; border-radius: 4px; color: #fde047; font-size: 14px; }";
        html += ".stats { margin-top: 30px; border-top: 1px solid #334155; padding-top: 20px; }";
        html += ".stat-item { margin-bottom: 10px; font-size: 15px; }";
        html += ".stat-label { color: #94a3b8; }";
        html += ".stat-val { font-weight: bold; color: #f1f5f9; }";
        html += "</style></head><body>";
        html += "<div class='container'>";
        html += "<div class='badge'>FREE MODE</div>";
        html += "<h1>Sincronizzatore Calendari</h1>";
        html += "<p>Scarica in background i calendari di Matchesio.com per i campionati di 'archivio_partite' e associa in tempo reale i nomi delle squadre.</p>";
        
        if (syncStatus === "running") {
          html += "<button id='sync-btn' class='btn' disabled>Sincronizzazione in corso...</button>";
          html += "<p id='sync-msg' class='status-running'>Sincronizzazione attiva in background (10 secondi di ritardo protettivo per non essere bloccati).</p>";
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

        // Box di allerta per alias non configurati (con team_id = NULL)
        if (numPending > 0) {
          html += "<div id='alert-box' class='alert-box'><strong>Attenzione:</strong> Ci sono " + numPending + " squadre di Matchesio non ancora associate nel tuo database. I loro nomi sono mostrati in arancione nell'accordion. Associale impostando il corretto team_id in 'team_aliases'.</div>";
        } else {
          html += "<div id='alert-box' class='alert-box' style='display:none;'></div>";
        }

        html += "<div class='league-list'>";
        html += "<h3>Stato Campionati</h3>";
        
        for (let i = 0; i < listaLeghe.length; i++) {
          const l = listaLeghe[i];
          const code = l.div;
          
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
        html += "<div class='stat-item'><span class='stat-label'>Stagione Rilevata: </span><span id='stat-season' class='stat-val'>" + currentSeason + "</span></div>";
        html += "<div class='stat-item'><span class='stat-label'>Ultimo aggiornamento: </span><span id='stat-last-sync' class='stat-val'>" + lastSync + "</span></div>";
        html += "<div class='stat-item'><span class='stat-label'>Partite attualmente salvate: </span><span id='stat-totale' class='stat-val'>" + totalePartite + "</span></div>";
        html += "</div>";
        html += "</div>";

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
        
        html += "    if (data.pending > 0) {";
        html += "      document.getElementById('alert-box').style.display = 'block';";
        html += "      document.getElementById('alert-box').innerHTML = '<strong>Attenzione:</strong> Ci sono ' + data.pending + ' squadre di Matchesio non ancora associate nel tuo database. I loro nomi sono mostrati in arancione nell\\\'accordion. Associale impostando il corretto team_id in \\\'team_aliases\\\'.';";
        html += "    } else {";
        html += "      document.getElementById('alert-box').style.display = 'none';";
        html += "    }";

        html += "    if (data.status === 'running') {";
        html += "      document.getElementById('sync-btn').disabled = true;";
        html += "      document.getElementById('sync-btn').innerText = 'Sincronizzazione in corso...';";
        html += "      document.getElementById('sync-msg').style.display = 'block';";
        html += "      document.getElementById('sync-msg').innerText = 'Sincronizzazione attiva in background (10 secondi di pausa tra campionati).';";
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

    // 4. ROTTA POST /sync (RICEZIONE E AVVIO BACKGROUND)
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

        // Avvio background asincrono
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

// COMPITO IN BACKGROUND CON PAUSA DI 10 SECONDI E VALIDAZIONE ALIAS AUTOMATICA
async function runBackgroundSync(dbArchivio, dbSoglie) {
  try {
    const leghe = await dbArchivio.prepare("SELECT div FROM regole_leghe WHERE api_id > 0").all();
    
    if (!leghe.results || leghe.results.length === 0) {
      throw new Error("Nessun campionato attivo con un api_id valido trovato in regole_leghe.");
    }

    let totaleInserite = 0;
    let rilevataStagione = "N.D.";
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // MEMORIA RAM DI CACHE PER GLI ALIAS (Riduce le query di lettura del 97%)
    const aliasCache = {};

    for (let i = 0; i < leghe.results.length; i++) {
      const lega = leghe.results[i];
      const divCode = lega.div;
      const slug = MATCHESIO_SLUGS[divCode];

      if (!slug) {
        console.log("Nessuno slug Matchesio trovato per il codice " + divCode);
        continue;
      }

      // Imposta la lega corrente su "syncing" (Giallo 🟡)
      await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'syncing')").bind(divCode).run();

      // Scarica direttamente il file JSON ufficiale gratuito della stagione corrente
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
        // Estrae il nome della stagione (es. "2025/26") direttamente dalla prima riga del file!
        if (matches[0].season) {
          rilevataStagione = matches[0].season;
        }

        const queryInsert = "INSERT OR REPLACE INTO calendario_partite (fixture_id, league_id, league_div, round, event_date, home_team_id_api, home_team_name_api, home_team_id_local, away_team_id_api, away_team_name_api, away_team_id_local, goals_home, goals_away, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
        const statements = [];

        for (let j = 0; j < matches.length; j++) {
          const m = matches[j];
          
          // Formattazione data e ora in timestamp ISO standard per il DB
          const timestampPartita = m.date + "T" + m.time + ":00Z";
          const roundString = "Giornata " + m.matchday;

          // GESTIONE DEI RISULTATI
          let goalsHome = null;
          let goalsAway = null;
          if (m.status === "Played" && m.result && m.result.indexOf("-") !== -1) {
            const score = m.result.split("-");
            goalsHome = parseInt(score[0].trim(), 10);
            goalsAway = parseInt(score[1].trim(), 10);
          }

          // RISOLUZIONE ALIAS SQUADRA IN CASA (con Cache)
          const homeName = m.homeTeam;
          let homeLocalId = null;
          if (aliasCache[homeName] !== undefined) {
            homeLocalId = aliasCache[homeName];
          } else {
            const aliasRes = await dbArchivio.prepare("SELECT team_id FROM team_aliases WHERE alias = ?").bind(homeName).first();
            if (aliasRes) {
              homeLocalId = aliasRes.team_id;
              aliasCache[homeName] = homeLocalId;
            } else {
              // Squadra sconosciuta: la inseriamo con team_id = NULL in archivio_partite
              await dbArchivio.prepare("INSERT OR IGNORE INTO team_aliases (alias, team_id) VALUES (?, NULL)").bind(homeName).run();
              aliasCache[homeName] = null;
            }
          }

          // RISOLUZIONE ALIAS SQUADRA OSPITE (con Cache)
          const awayName = m.awayTeam;
          let awayLocalId = null;
          if (aliasCache[awayName] !== undefined) {
            awayLocalId = aliasCache[awayName];
          } else {
            const aliasRes = await dbArchivio.prepare("SELECT team_id FROM team_aliases WHERE alias = ?").bind(awayName).first();
            if (aliasRes) {
              awayLocalId = aliasRes.team_id;
              aliasCache[awayName] = awayLocalId;
            } else {
              // Squadra sconosciuta: la inseriamo con team_id = NULL in archivio_partite
              await dbArchivio.prepare("INSERT OR IGNORE INTO team_aliases (alias, team_id) VALUES (?, NULL)").bind(awayName).run();
              aliasCache[awayName] = null;
            }
          }

          statements.push(
            dbSoglie.prepare(queryInsert).bind(
              m.id,
              0, // ID di default per la lega
              divCode,
              roundString,
              timestampPartita,
              0, // ID fittizio API Casa
              homeName,
              homeLocalId,
              0, // ID fittizio API Ospite
              awayName,
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

      // Pausa di sicurezza di 10 secondi per tutelare la stabilità di rete
      if (i < leghe.results.length - 1) {
        await delay(10000); 
      }
    }

    // Aggiorna lo stato generale su "idle" al completamento
    const adesso = new Date().toISOString();
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