// DIZIONARIO EMOTICON BANDIERE
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

    // 1. ROTTA PARTITE ON-DEMAND (Accordion dettagliato)
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

    // 2. ROTTA DI STATO JSON (Per il Long Polling)
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

    // 3. ROTTA POST /mode (Stato schermo On/Off)
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

    // 4. ROTTA POST /pause (Segnale di interruzione)
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

    // 5. ROTTA POST /reset (Svuotamento completo del database)
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
        
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 6. ROTTA PRINCIPALE (DASHBOARD)
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

        // Estrazione di TUTTI i campionati (attivi e inattivi) ordinati alfabeticamente per codice ID (id ASC)
        // MODIFICA 1: Rimosso is_active=1 per scaricare la lista completa
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
        
        // Bordo Ciano Neon per la card selezionata
        html += ".league-item.selected { border-color: #00ebff !important; box-shadow: 0 0 10px rgba(0, 235, 255, 0.4); }";
        
        // Stile per i campionati inattivi
        html += ".league-item.inactive { opacity: 0.45; cursor: not-allowed; border-color: #0f172a; }";
        html += ".league-item.inactive:hover { background: #0f172a; }";
        
        html += ".league-header { display: flex; justify-content: space-between; align-items: center; font-weight: bold; font-size: 14px; letter-spacing: 0.5px; }";
        html += ".league-header span.title { display: flex; align-items: center; gap: 8px; color: #ffffff; }";
        html += ".league-header span.pct { color: #00ebff; font-weight: 800; }";
        html += ".league-header span.lock { color: #ef4444; font-weight: bold; }";
        
        html += ".league-sub { font-size: 11px; color: #64748b; margin-top: 6px; display: flex; align-items: center; gap: 6px; }";
        html += ".accordion-content { display: none; margin-top: 15px; border-top: 1px solid #1e293b; padding-top: 12px; overflow-x: auto; }";
        
        html += ".status-running-msg { text-align: center; color: #f59e0b; font-size: 13px; font-weight: bold; margin-bottom: 15px; }";
        html += ".error-box { background: #ef444422; border-left: 4px solid #ef4444; padding: 12px; margin-bottom: 20px; border-radius: 4px; color: #fca5a5; font-size: 13px; }";
        
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
        
        // Intestazione
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

        // Elenco campionati (MODIFICA 3: Tutti deselezionati e spenti all'avvio)
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

          // MODIFICA 4: Rimossa emoticon pallone ⚽ di fallback
          const flag = l.emoji || "";
          const fullLabel = code + " " + l.name;

          const lastMatchRes = await dbSoglie.prepare("SELECT MAX(event_date) as ultima FROM calendario_partite WHERE league_div = ?").bind(code).first();
          const ultimaData = lastMatchRes && lastMatchRes.ultima ? new Date(lastMatchRes.ultima).toLocaleDateString("it-IT", { year: "numeric", month: "2-digit", day: "2-digit" }) : "N.D.";

          // Se il campionato è spento (is_active = 0) impostiamo la classe "inactive" e l'emoji ⛔
          if (isActive === 0) {
            html += "<div class='league-item inactive' id='card-" + code + "'>";
            html += "<div class='league-header'>";
            html += "<span class='title'><span>" + flag + "</span> " + fullLabel + "</span>";
            html += "<span class='lock'>⛔</span>"; // MODIFICA 1: Emoji di bloccato per i disattivi
            html += "</div>";
            html += "<div class='league-sub'>";
            html += "<span>⚠️</span> <span>Campionato non abilitato dal Legislatore</span>";
            html += "</div>";
            html += "</div>";
          } else {
            // Se attivo, impostiamo onclick e comportamento standard (Spento di default all'avvio)
            html += "<div class='league-item' id='card-" + code + "' onclick='toggleLeague(\"" + code + "\")' data-active='1'>";
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

        // CODICE JAVASCRIPT LATO CLIENT
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
        // NON carichiamo tutte le partite insieme per evitare di rallentare lo schermo del telefono
        html += "      }";
        html += "    }";
        html += "  }";
        html += "}";

        html += "function toggleNitro() {";
        html += "  const btn = document.getElementById('btn-nitro');";
        html += "  btn.classList.toggle('nitro-active');";
        html += "}";

        // Avvio Sincronizzazione asincrona dei soli campionati selezionati (Ciano Neon)
        html += "async function startSync() {";
        html += "  if (globalStatus === 'running') return;";
        const selectedCards = "document.querySelectorAll('.league-item.selected[data-active=\"1\"]')";
        html += "  const selected = Array.from(" + selectedCards + ").map(c => c.id.replace('card-', ''));";
        html += "  if (selected.length === 0) {";
        html += "    alert('Tocca i campionati per accenderli di ciano prima di avviare!');";
        html += "    return;";
        html += "  }";
        
        html += "  const nitroActive = document.getElementById('btn-nitro').classList.contains('nitro-active') ? '1' : '0';";
        html += "  document.getElementById('btn-start').disabled = true;";
        html += "  document.getElementById('btn-reset').disabled = true;";
        html += "  document.getElementById('sync-msg').style.display = 'block';";
        html += "  document.getElementById('sync-msg').innerText = 'Sincronizzazione avviata in background...';";
        
        html += "  await fetch('/sync?leagues=' + selected.join(',') + '&nitro=' + nitroActive, { method: 'POST' });";
        html += "  updateStatus();";
        html += "}";

        html += "async function triggerPause() {";
        html += "  const msgEl = document.getElementById('sync-msg');";
        html += "  if (msgEl) { msgEl.innerText = 'Pausa richiesta... attesa completamento download corrente.'; }";
        html += "  await fetch('/pause', { method: 'POST' });";
        html += "  updateStatus();";
        html += "}";

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
        html += "      if (" + elMsg + ") { " + elMsg + ".style.display = 'block'; " + elMsg + ".innerText = 'Sincronizzazione attiva in background.'; }";
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
        // Solo per le card selezionate cambiamo il messaggio di sub-testo
        const cardHasSelected = "document.getElementById('card-' + code).classList.contains('selected')";
        html += "          if (subEl && " + cardHasSelected + ") subEl.innerText = 'Download del calendario in corso...';";
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

    // 7. ROTTA POST /sync (RICEZIONE SELEZIONE E AVVIO BACKGROUND)
    if (url.pathname === "/sync" && request.method === "POST") {
      try {
        const statusCheck = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
        if (statusCheck && statusCheck.value === "running") {
          return new Response(JSON.stringify({ error: "Sincronizzazione gia in corso" }), { status: 400 });
        }

        const leaguesStr = url.searchParams.get("leagues");
        const nitroStr = url.searchParams.get("nitro") || "0";

        if (!leaguesStr) {
          return new Response(JSON.stringify({ error: "Nessun campionato selezionato" }), { status: 400 });
        }

        const listLeagues = leaguesStr.split(",");

        const resetStatements = [
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('status', 'running')"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('error', NULL)"),
          dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('nitro_mode', ?)").bind(nitroStr)
        ];

        for (let i = 0; i < listLeagues.length; i++) {
          resetStatements.push(
            dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'pending')").bind(listLeagues[i])
          );
        }

        await dbSoglie.batch(resetStatements);

        // Avvio asincrono in background
        ctx.waitUntil(
          runBackgroundSync(dbArchivio, dbSoglie, listLeagues)
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

// COMPITO IN BACKGROUND COMPLETAMENTE INTERATTIVO CON INTEGRAZIONE PAUSA E NITRO DINAMICO DA DATABASE
async function runBackgroundSync(dbArchivio, dbSoglie, selectedLeagues) {
  try {
    let totaleInserite = 0;
    let rilevataStagione = "N.D.";
    
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    for (let i = 0; i < selectedLeagues.length; i++) {
      const divCode = selectedLeagues[i];

      // CONTROLLO ATTIVO DELLA PAUSA AD OGNI STEP
      const statusCheck = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'status'").first();
      if (statusCheck && (statusCheck.value === "paused" || statusCheck.value === "idle")) {
        console.log("Processo interrotto o messo in pausa dall'utente.");
        break;
      }

      // MODIFICA 2: Estrazione dello slug della lega direttamente dal database 'soglie_campionati' (tabella api_status)
      const slugRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'slug_' || ?").bind(divCode).first();
      
      if (!slugRes || !slugRes.value) {
        console.log("Nessuno slug Matchesio trovato in DB per " + divCode);
        continue;
      }

      const slug = slugRes.value.split(",");

      // Imposta lo stato della lega corrente su "syncing" (Giallo 🟡)
      await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'syncing')").bind(divCode).run();

      let apiResponse = null;
      let successSlug = null;

      // PROBING AUTOMATICO DEI 3 CANDIDATI (Risolve il problema dei finti 404)
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
          successSlug = currentSlug;
          break; // Abbiamo trovato l'indirizzo funzionante!
        }
      }

      if (!apiResponse || !apiResponse.ok) {
        console.log("Errore scaricamento calendario da Matchesio per " + divCode);
        // Segniamo come fallito (rosso 🔴) se nessuno dei 3 link funziona
        await dbSoglie.prepare("INSERT OR REPLACE INTO api_status (metric, value) VALUES ('sync_league_' || ?, 'pending')").bind(divCode).run();
        continue;
      }

      const matches = await apiResponse.json();

      if (matches && matches.length > 0) {
        if (matches[0].season) {
          rilevataStagione = matches[0].season;
        }

        const queryInsert = "INSERT OR REPLACE INTO calendario_partite (fixture_id, league_id, league_div, round, event_date, home_team_name_api, home_team_id_local, away_team_name_api, away_team_id_local, goals_home, goals_away, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
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

          const homeLocalId = 0;
          const awayLocalId = 0;

          statements.push(
            dbSoglie.prepare(queryInsert).bind(
              m.id,
              0, 
              divCode,
              roundString,
              timestampPartita,
              m.homeTeam,
              homeLocalId,
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

      // REGOLAZIONE DINAMICA DELLA VELOCITÀ LEGGENDO IL DATABASE AD OGNI INTERVALLO (Inclusa automazione schermo On/Off)
      const nitroRes = await dbSoglie.prepare("SELECT value FROM api_status WHERE metric = 'nitro_mode'").first();
      const currentNitro = nitroRes ? nitroRes.value : "1";
      const delayTime = currentNitro === "1" ? 1200 : 10000;

      if (i < selectedLeagues.length - 1) {
        await delay(delayTime); 
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