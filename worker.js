// EMAIL DI SUPPORTO mostrata nelle pagine /privacy e /support: sostituiscila con la tua
const SUPPORT_EMAIL = "iRallySupport@icloud.com";

export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/version") {
      return new Response("iRally worker v9 (gemini-3.6-flash fisso, thinking minimal)", { headers: { "content-type": "text/plain" } });
    }
    if (new URL(request.url).pathname === "/usage") {
      const mk = "tok:" + new Date().toISOString().slice(0, 7);
      let u = { in: 0, out: 0, n: 0 };
      try { u = JSON.parse((await env.RALLY_KV.get(mk)) || '{"in":0,"out":0,"n":0}'); } catch (_) {}
      // stima con le tariffe di Gemini 2.5 Flash: 0,15$ / 1,25$ per milione di token
      const cost = (u.in / 1e6) * 0.15 + (u.out / 1e6) * 1.25;
      const body = "Mese " + mk.slice(4) + "\n"
        + "Scansioni: " + u.n + "\n"
        + "Token in:  " + u.in + "\n"
        + "Token out: " + u.out + "\n"
        + "Stima costo: $" + cost.toFixed(3) + "\n"
        + "Media a scansione: $" + (u.n ? (cost / u.n).toFixed(4) : "0");
      return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-App-Key",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const reqUrl = new URL(request.url);
    if (request.method === "GET" && reqUrl.pathname === "/privacy") return page(PRIVACY_HTML);
    if (request.method === "GET" && reqUrl.pathname === "/support") return page(SUPPORT_HTML);
    if (request.method !== "POST") return new Response("Rally scan server attivo", { headers: cors });

    const APP_KEY = "iRallyK3y9Xq7SdP2vLm2026"; // stessa stringa nell'app; cambiala quando vuoi
    if (request.headers.get("X-App-Key") !== APP_KEY) return new Response("no", { status: 401, headers: cors });

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const TRANSIENT = /high demand|overload|unavailable|try again|resource[_ ]?exhausted|rate|quota|timeout|deadline|\b429\b|\b500\b|\b503\b|internal/i;

    try {
      if (!env.GEMINI_KEY) return json({ error: "Chiave GEMINI_KEY mancante nel server" }, 200, cors);

      const body = await request.json();
      const imgB64 = body.image;
      const mode = body.mode === "timecard" ? "timecard" : "radar";
      if (!imgB64) return json({ error: "Nessuna immagine ricevuta" }, 400, cors);

      // tetto per utente (attivo solo se il KV RALLY_KV e' collegato; altrimenti non blocca)
      const deviceId = (typeof body.device === "string" ? body.device.slice(0, 64) : "");
      const lim = await checkLimit(env, ctx, deviceId);
      if (!lim.ok) return json({ error: lim.msg, limited: true }, 429, cors);

      // lista modelli ordinata, con CACHE (6 ore) per non richiederla ogni volta -> molto piu' veloce
      let ranked;
      try { ranked = await getRanked(env, mode); }
      catch (e) { return json({ error: "Lista modelli: " + String(e).slice(0,200) }, 200, cors); }
      if (!ranked || !ranked.length) return json({ error: "Nessun modello adatto disponibile" }, 200, cors);

      const prompt = mode === "timecard" ? PROMPT_TIMECARD : PROMPT_RADAR;

      async function callModel(name, noThink) {
        const genUrl = "https://generativelanguage.googleapis.com/v1beta/" + name + ":generateContent";
        // i modelli 2.5+ "ragionano" prima di rispondere e diventano lentissimi: qui lo spegniamo.
        // I Gemini 3.x hanno cambiato le regole: temperature e' deprecata e il "budget"
        // di ragionamento si chiama thinkingLevel. Mandare i parametri vecchi da errore 400.
        const isG3 = /gemini-[3-9]/i.test(name);
        const genCfg = { responseMimeType: "application/json", maxOutputTokens: 8192 };
        if (!isG3) genCfg.temperature = 0.1;
        if (noThink !== false) {
          /* "minimal" e' l'equivalente di thinkingBudget:0 sui Gemini 3 (migrazione
             indicata da Google). Con "low" il modello ragiona comunque: risposta
             lenta e token di ragionamento pagati come output a 7,50$/M. */
          genCfg.thinkingConfig = isG3 ? { thinkingLevel: "minimal" } : { thinkingBudget: 0 };
        }
        let gRes;
        const ac = new AbortController();
        const killer = setTimeout(() => { try { ac.abort(); } catch (_) {} }, 22000);
        try {
          gRes = await fetch(genUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
            body: JSON.stringify({
              contents: [{ parts: [ { text: prompt }, { inline_data: { mime_type: "image/jpeg", data: imgB64 } } ] }],
              generationConfig: genCfg,
            }),
            signal: ac.signal,
          });
        } catch (e) {
          clearTimeout(killer);
          const ab = String(e).indexOf("abort") >= 0;
          return { error: ab ? "timeout 22s" : ("rete: " + String(e)) };
        }
        clearTimeout(killer);
        let gData;
        try { gData = await gRes.json(); } catch (e) { return { error: "risposta illeggibile" }; }
        if (gData.error) return { error: (gData.error.message || gData.error.status || "errore") };
        try {
          const u = gData && gData.usageMetadata;
          if (u) { LAST_USAGE.in = u.promptTokenCount || 0; LAST_USAGE.out = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0); }
        } catch (_) {}
        const cand = gData?.candidates?.[0];
        const text = cand?.content?.parts?.[0]?.text || "";
        if (!text) return { error: "vuota (" + (cand?.finishReason || gData?.promptFeedback?.blockReason || "?") + ")" };
        return { text };
      }

      // prova i modelli in ordine; su errore temporaneo ritenta una volta, poi cambia modello
      let resultText = "", usedModel = "", lastErr = "";
      const maxModels = Math.min(4, ranked.length);
      const LAST_USAGE = { in: 0, out: 0 };
      const T0 = Date.now();
      outer:
      for (let i = 0; i < maxModels; i++) {
        if (Date.now() - T0 > 40000) break;
        const name = ranked[i];
        /* Con il modello bloccato non c'e' un ripiego: su errore temporaneo
           ("high demand", 503, timeout) conviene insistere sullo stesso modello
           con attese crescenti, invece di arrendersi al primo tentativo. */
        const BACKOFF = [800, 2500];   /* 3 tentativi in tutto: oltre, l'attesa dell'utente conta piu' del tentativo */
        for (let attempt = 0; attempt <= BACKOFF.length; attempt++) {
          if (Date.now() - T0 > 40000) break outer;   /* lascia tempo alla risposta invece di far girare la rotella */
          let r = await callModel(name);
          if (!r.text && /thinking|budget|level|temperature/i.test(String(r.error))) r = await callModel(name, false);
          if (r.text) { resultText = r.text; usedModel = name; break outer; }
          lastErr = "Google (" + name + "): " + String(r.error).slice(0, 200);
          if (TRANSIENT.test(String(r.error)) && attempt < BACKOFF.length) { await sleep(BACKOFF[attempt]); continue; }
          break;
        }
      }
      if (!resultText) return json({ error: (lastErr || "Nessun modello disponibile") + " [" + Math.round((Date.now()-T0)/1000) + "s]" }, 200, cors);

      let text = resultText.replace(/```json/gi, "").replace(/```/g, "").trim();
      let parsed;
      try { parsed = JSON.parse(text); }
      catch { return json({ error: "Formato non valido", raw: text.slice(0, 400) }, 200, cors); }

      const MS = Date.now() - T0;
      if (env.RALLY_KV) {
        const mk = "tok:" + new Date().toISOString().slice(0, 7);
        ctx.waitUntil((async () => {
          try {
            const prev = JSON.parse((await env.RALLY_KV.get(mk)) || '{"in":0,"out":0,"n":0}');
            prev.in += LAST_USAGE.in; prev.out += LAST_USAGE.out; prev.n += 1;
            await env.RALLY_KV.put(mk, JSON.stringify(prev), { expirationTtl: 60 * 60 * 24 * 400 });
          } catch (_) {}
        })());
      }
      if (mode === "timecard") return json({ card: parsed, model: usedModel, ms: MS, tok: LAST_USAGE }, 200, cors);
      const rowsOut = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.rows) ? parsed.rows : []);
      const colsOut = (parsed && !Array.isArray(parsed) && parsed.cols) ? parsed.cols : null;
      return json({ rows: rowsOut, cols: colsOut, model: usedModel, ms: MS, tok: LAST_USAGE }, 200, cors);
    } catch (e) {
      return json({ error: String(e) }, 500, cors);
    }
  },
};


/* ---- tetto per utente (Cloudflare KV) ---- */
const DAILY_LIMIT = 250;   // scansioni al giorno per utente
const HOURLY_LIMIT = 200;  // scansioni all'ora per utente
async function checkLimit(env, ctx, deviceId) {
  if (!env.RALLY_KV || !deviceId) return { ok: true }; // KV non configurato -> non blocco
  const now = new Date();
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const hour = day + String(now.getUTCHours()).padStart(2, "0");
  const dk = "d:" + deviceId + ":" + day;
  const hk = "h:" + deviceId + ":" + hour;
  let dn = 0, hn = 0;
  try {
    const [dv, hv] = await Promise.all([env.RALLY_KV.get(dk), env.RALLY_KV.get(hk)]);
    dn = parseInt(dv || "0", 10) || 0;
    hn = parseInt(hv || "0", 10) || 0;
  } catch (e) { return { ok: true }; } // se il KV non risponde, non blocco l'utente
  if (dn >= DAILY_LIMIT) return { ok: false, msg: "Limite giornaliero raggiunto (" + DAILY_LIMIT + " scansioni). Riprova domani." };
  if (hn >= HOURLY_LIMIT) return { ok: false, msg: "Troppe scansioni in poco tempo. Attendi qualche minuto e riprova." };
  ctx.waitUntil(Promise.all([
    env.RALLY_KV.put(dk, String(dn + 1), { expirationTtl: 90000 }),
    env.RALLY_KV.put(hk, String(hn + 1), { expirationTtl: 7200 }),
  ]).catch(() => {}));
  return { ok: true };
}

/* ---- cache della lista modelli (persiste finche' l'isolate resta caldo) ---- */
let CACHE = { radar: null, timecard: null, at: 0 };   // una cache per tipo di lavoro
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 ore

/* ---- MODELLI: ordine deciso da noi, non "il piu' recente che passa" ----
   Il primo che risulta davvero disponibile viene usato sempre. Cosi' la
   velocita' non cambia da un giorno all'altro perche' Google pubblica un
   modello nuovo. Se un giorno spariscono tutti, si torna alla scelta
   automatica (in fondo alla lista). */
/* MODELLO BLOCCATO: un solo modello, nessun ripiego automatico.
   I modelli leggeri leggevano male le tabelle di marcia (un T.C. in piu') e i
   risultati cambiavano da un giorno all'altro senza che il codice cambiasse.
   Meglio un errore chiaro ("riprova") che una lettura sbagliata presa per buona.
   Google ha chiuso gemini-2.5-flash ai nuovi utenti: il sostituto indicato e' 3.6-flash. */
/* Modello scelto in base al LAVORO, per avere la qualita' dove serve
   senza pagarla dove non serve:
     - radar: 30-40 pagine a gara, ma il compito e' semplice (numeri stampati;
       il ritaglio vero lo fa detectTable() sui pixel, non l'AI) -> modello lite.
     - tabella di marcia: 2-3 pagine a gara, ma numeri SCRITTI A MANO e una
       struttura che se sbagliata manda all'aria tutti i calcoli -> modello pieno.
   Prezzi (set. 2026, per milione di token in/out):
     3.5-flash-lite  0,30 / 2,50   ~0,002 $ a pagina
     3.6-flash       1,50 / 7,50   ~0,008 $ a pagina */
const PREFERRED_BY_MODE = {
  radar:    ["gemini-3.6-flash"],
  timecard: ["gemini-3.6-flash"],
};
/* PROVATO E BOCCIATO (7 set 2026): gemini-3.5-flash-lite sul radar.
   Costa 4 volte meno ma risponde con JSON non valido -> "Formato non valido",
   pagine perse a caso. NON rimetterlo senza una prova su piu' road book. */
const PIN_MODEL = true;   // true = usa solo i modelli qui sopra, niente scelta automatica
async function getRanked(env, mode) {
  const PREFERRED = PREFERRED_BY_MODE[mode] || PREFERRED_BY_MODE.radar;
  const now = Date.now();
  const ck = mode === "timecard" ? "timecard" : "radar";
  if (CACHE[ck] && (now - CACHE.at) < CACHE_TTL) return CACHE[ck];

  const listRes = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: { "x-goog-api-key": env.GEMINI_KEY },
  });
  const listData = await listRes.json();
  if (listData.error) {
    if (CACHE[ck]) return CACHE[ck]; // se la lista fallisce ma ho una cache, la riuso
    throw new Error(listData.error.message || "lista modelli non disponibile");
  }

  const usable = (listData.models || []).filter(m =>
    (m.supportedGenerationMethods || []).includes("generateContent") &&
    /gemini/i.test(m.name) &&
    !/(image|tts|audio|live|embedding|aqa)/i.test(m.name)
  );
  const ver = m => { const x = String(m.name).match(/gemini-(\d+(?:\.\d+)?)/i); return x ? parseFloat(x[1]) : 0; };
  const byNewest = arr => arr.slice().sort((a, b) => ver(b) - ver(a));
  const flash     = byNewest(usable.filter(m => /flash/i.test(m.name) && !/lite/i.test(m.name)));
  const flashLite = byNewest(usable.filter(m => /flash/i.test(m.name) &&  /lite/i.test(m.name)));
  const flashAny  = byNewest(usable.filter(m => /flash/i.test(m.name)));
  const allUsable = byNewest(usable);

  const ranked = [];
  const seen = new Set();
  // prima i modelli scelti da noi, nell'ordine, se esistono davvero
  PREFERRED.forEach(pref => {
    const hit = usable.find(m => String(m.name).replace(/^models\//, "") === pref);
    if (hit && !seen.has(hit.name)) { seen.add(hit.name); ranked.push(hit.name); }
  });
  // rete di sicurezza automatica: attiva solo se il modello NON e' bloccato
  if (!PIN_MODEL) {
    [flash, flashLite, flashAny, allUsable].forEach(arr =>
      arr.forEach(m => { if (!seen.has(m.name)) { seen.add(m.name); ranked.push(m.name); } })
    );
  }

  if (ranked.length) { CACHE[ck] = ranked; CACHE.at = now; }
  return ranked;
}

/* ============ PROMPT RADAR (road book) — invariato ============ */
const PROMPT_RADAR = `Analizza questa pagina di road book (radar) di rally.
E' una griglia con: colonna sinistra DISTANZE (sottocolonne "Totali" e "Parziali"), colonna centrale DIREZIONE (disegni tulip), colonna INFORMAZIONI (cartelli con nomi di localita).
Ogni riferimento ha un NUMERO (1,2,3...) in un quadratino in basso a sinistra della sua cella. Il DISEGNO del riferimento sta SOPRA quel quadratino.
REGOLA FONDAMENTALE: ogni quadratino numerato e' un riferimento SEPARATO, anche quando tra due disegni NON c'e' una linea orizzontale e stanno molto vicini. Non unire MAI due numeri in un solo elemento: se vedi i numeri 1 e 2, devi restituire DUE oggetti. I numeri sono consecutivi (1,2,3...) senza salti: se ne manca uno, cercalo meglio.
Per OGNI quadratino numerato restituisci un oggetto:
- "num": numero (intero)
- "numbox": rettangolo del solo quadratino con il numero, formato [ymin,xmin,ymax,xmax], interi 0-1000
- "rowbox": rettangolo dell'INTERA RIGA della tabella, delimitata dalle linee orizzontali sopra e sotto: dal bordo sinistro del tabellone (inizio colonna TOT.) fino al bordo destro della colonna INFORMAZIONI, ESCLUSA la colonna piu' a destra con la distanza regressiva / "distanza dal C.O.". Formato [ymin,xmin,ymax,xmax], interi 0-1000. E' il dato PIU' IMPORTANTE: misuralo con cura sulle linee della tabella. Ogni rowbox contiene UN SOLO numerino.
- "km": colonna "Totali" (stringa es. "0,30"; se vuota "")
- "parz": colonna "Parziali" (stringa; se vuota "")
- "nota": testo cartelli INFORMAZIONI (stringa, puo' essere "")
- "box": rettangolo attorno a disegno tulip + cartelli di quel riferimento (fascia centrale + centro-destra, SOPRA il numero), ESCLUSA la colonna sinistra distanze e la colonna destra "Distanza dal C.O.". Formato [ymin,xmin,ymax,xmax], interi 0-1000 (y dall'alto).
Restituisci un oggetto JSON: { "cols": { "left": X, "infoEnd": X }, "rows": [ ...oggetti sopra, ordinati per "num" crescente... ] }
dove "cols.left" e' la coordinata x (0-1000) del bordo sinistro del tabellone (inizio colonna TOT.) e "cols.infoEnd" e' la x del bordo destro della colonna INFORMAZIONI (subito prima della colonna della distanza regressiva). Sono uguali per tutte le righe della pagina.`;

/* ============ PROMPT TIME CARD (multi-formato) ============ */
const PROMPT_TIMECARD = `Stai leggendo la TABELLA DI MARCIA / TIME CARD di un rally italiano, fotografata (potrebbe essere ruotata: leggila nel verso giusto). Esistono molti formati diversi (FIA/Targa Florio con etichette in inglese, oppure formati regionali italiani a colori): i campi sono gli stessi ma DISPOSTI IN MODO DIVERSO a seconda della gara.

ESTRAI SOLTANTO i valori PRE-STAMPATI dalla macchina (carattere regolare, dentro le caselle). IGNORA tutto cio' che e' scritto a MANO (grafia irregolare, penna o matita) e le caselle EVIDENZIATE IN GIALLO o AZZURRO scritte a mano (sono orari reali): actual/provisional start, ora di arrivo o partenza reale, finish time, time taken, tempo impiegato, tempo residuo scritto a mano, numero di gara, firme, frecce. Il colore NON conta per decidere: lo stampato puo' essere nero, blu, rosso, arancione o grigio; conta solo se e' a STAMPA o a MANO.

La card e' una sequenza di CONTROLLI dall'alto verso il basso. Ogni riga/blocco ha un CODICE nella colonna di sinistra:
- CONTROLLO ORARIO: "T.C. 5", "C.O. 5D", "CO 11B", "SETTORE 18" (spesso con lettere A/B/C/D). Puo' avere testo: Riordino, Assistenza, Service, Regroup, Partenza, Arrivo.
- PROVA SPECIALE: "PS 6", "P.S. 7", "S.S. 9", di solito con nome e distanza in km (es. "PS 12 Moruri 3  12,89 km", "S.S. 9 - Scillato La Generosa 3  14,80 km").

REGOLA BLOCCATA (verificata su Targa Florio, 7 set 2026 - non riscrivere senza rileggerla):
[REGOLA BLOCCATA - confermata da Roberto il 7 settembre 2026, non modificare]
Il PRIMO controllo della pagina e' la PARTENZA di sezione: NON creare un leg per lui.
Lo riconosci perche' ha un orario di partenza (Provisional Start / Actual Start / Partenza / Start Time) e NON ha un tempo imposto in ingresso.
Compare soltanto come "from" del primo leg: il suo codice (es. "T.C. 0") non deve mai finire in un "to".
Se nel blocco della partenza e' stampato un tempo imposto, quello appartiene alla tratta verso il controllo SUCCESSIVO, non alla partenza.

Crea un elemento "leg" per OGNI controllo dal SECONDO in poi (i leg sono le TRATTE fra due controlli, quindi sono sempre UNO IN MENO dei controlli stampati):
- "from": codice del controllo PRECEDENTE. Per il primo leg e' il codice del controllo di partenza: lascialo "" solo se quel codice e' davvero illeggibile.
- "to": codice del controllo di QUESTA riga.
- "target": il TEMPO IMPOSTO STAMPATO di questa tratta. Etichette possibili: "Tempo imposto", "Tempo di settore", "Tempo PS", "Target Time", "New Target Time", "TEMPO IMPOSTO". E' una DURATA breve in ore/minuti, es. "00 30", "0 53", "01 26", "1 17". Normalizzala SEMPRE come "HH:MM" (es. "0 53" -> "00:53", "1 17" -> "01:17"). "" se assente. ATTENZIONE: NON e' un orario dell'orologio (tipo 16:24, 13:30): quelli sono transiti/partenze, NON metterli qui. Se ci sono sia "Target Time" sia "New Target Time", usa "Target Time" (usa "New Target Time" solo se "Target Time" e' assente).
- "theo": l'ORARIO TEORICO stampato di transito o partenza di questo controllo, se stampato. Etichette: "Transito CO", "Transito teorico", "Teorico CO", "Ora transito", "Orario teorico", "Partenza teorica". Formato "HH:MM". "" se assente o presente solo a mano.
- "ss": nome della prova speciale se la riga e' una PS/SS, altrimenti "".
- "km": distanza della prova come stampata (es. "12,89", "14,80"), altrimenti "".
- "desc": testo descrittivo stampato (Assistenza, Riordino, Service IN/OUT, Partenza, Arrivo...), altrimenti "".

Restituisci SOLO questo JSON, senza markdown:
{ "rally": nome del rally stampato in alto ("" se illeggibile), "section": numero di sezione stampato ("" se assente), "date": data stampata ("" se assente), "legs": [ ... ] }
Ordina i legs dall'alto verso il basso come sono stampati.`;

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...cors } });
}


/* ============ PAGINE STATICHE: PRIVACY e SUPPORTO ============ */
function page(html) {
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
}

const PAGE_CSS = `body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:0 auto;padding:28px 20px 60px;line-height:1.65;color:#1c1e24;background:#fafafa}
h1{font-size:26px;margin:8px 0 2px}h2{font-size:19px;margin-top:30px}h3{font-size:16px;margin-top:22px}
.small{color:#666;font-size:13px}a{color:#0a66c2}hr{border:0;border-top:1px solid #ddd;margin:36px 0}
li{margin:6px 0}`;

const PRIVACY_HTML = `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>iRally &mdash; Privacy Policy</title>
<style>${PAGE_CSS}</style></head><body>
<h1>Privacy Policy &mdash; iRally</h1>
<p class="small">Ultimo aggiornamento: 24 agosto 2026 &middot; <a href="#en">English version below</a></p>

<p><b>iRally</b> &egrave; un'app per la navigazione e la gestione dei tempi nei rally. &Egrave; progettata per funzionare senza account e per tenere i tuoi dati sul tuo dispositivo. Titolare del trattamento: Roberto Dapr&agrave; (Italia) &mdash; contatto: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>

<h2>Dati trattati e finalit&agrave;</h2>
<h3>1. Dati salvati solo sul dispositivo</h3>
<p>Impostazioni, prove, tabelle di marcia, note del roadbook, contatore dei chilometri gratuiti e backup restano <b>in locale sul tuo iPhone</b>. Non abbiamo accesso a questi dati. Si eliminano cancellando i dati dell'app o disinstallandola; i backup esportati manualmente restano sotto il tuo controllo.</p>
<h3>2. Posizione (GPS)</h3>
<p>La posizione &egrave; usata <b>esclusivamente sul dispositivo</b> per calcolare velocit&agrave;, distanze e contachilometri. Non viene inviata ai nostri server n&eacute; a terzi, e non viene registrata una cronologia degli spostamenti da parte nostra.</p>
<h3>3. Scanner AI (foto di radar e tabelle di marcia)</h3>
<p>Quando usi lo scanner, la foto che scegli viene inviata tramite connessione cifrata al nostro server (Cloudflare) e da l&igrave; all'API <b>Google Gemini</b> per estrarre il testo. Le immagini sono trattate al solo scopo di restituirti il risultato della scansione; non le usiamo per altri fini. Insieme alla richiesta viene inviato un <b>identificativo anonimo del dispositivo</b> (generato casualmente dall'app) usato solo per limiti d'uso e prevenzione abusi. Il trattamento da parte di Google avviene secondo i termini dei servizi API di Google.</p>
<h3>4. Acquisti e abbonamenti</h3>
<p>I pagamenti sono gestiti interamente da <b>Apple</b>: non riceviamo n&eacute; conserviamo dati di pagamento. Per verificare lo stato dell'abbonamento usiamo <b>RevenueCat</b>, che tratta un identificativo anonimo e le informazioni della transazione Apple (senza dati di carta). Puoi gestire o disdire l'abbonamento dalle impostazioni del tuo Apple ID.</p>
<h3>5. Notifiche</h3>
<p>Le sveglie sui timbri sono <b>notifiche locali</b> programmate sul dispositivo: nessun server di notifiche, nessun dato inviato.</p>

<h2>Cosa NON facciamo</h2>
<ul>
<li>Nessuna pubblicit&agrave; e nessuna vendita o cessione di dati.</li>
<li>Nessun tracciamento tra app o siti di terzi, nessun profilo pubblicitario.</li>
<li>Nessuna registrazione o account richiesto.</li>
</ul>

<h2>Conservazione</h2>
<p>I dati locali restano sul dispositivo finch&eacute; non li elimini. Le immagini inviate allo scanner sono trattate per il tempo necessario alla scansione. I dati di abbonamento sono conservati da Apple/RevenueCat secondo le rispettive politiche.</p>

<h2>I tuoi diritti (GDPR)</h2>
<p>Puoi esercitare i diritti previsti dagli artt. 15&ndash;22 del GDPR (accesso, rettifica, cancellazione, limitazione, opposizione) scrivendo a <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Hai inoltre diritto di reclamo al Garante per la protezione dei dati personali.</p>

<h2>Minori</h2>
<p>L'app non &egrave; destinata a minori di 13 anni e non raccoglie consapevolmente dati di minori.</p>

<h2>Modifiche</h2>
<p>Eventuali modifiche a questa informativa saranno pubblicate a questo indirizzo con la data di aggiornamento.</p>

<hr id="en">
<h1>Privacy Policy &mdash; iRally (English)</h1>
<p class="small">Last updated: August 24, 2026</p>
<p><b>iRally</b> is a rally navigation and timing app, designed to work without accounts and to keep your data on your device. Data controller: Roberto Dapr&agrave; (Italy) &mdash; contact: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>.</p>
<ul>
<li><b>On-device data:</b> settings, stages, time cards, roadbook notes, free-km counter and backups stay on your iPhone. We have no access to them. Delete them by clearing the app data or uninstalling.</li>
<li><b>Location (GPS):</b> processed on-device only, to compute speed, distances and the trip meter. It is never sent to our servers or third parties.</li>
<li><b>AI scanner:</b> photos you select are sent over an encrypted connection to our server (Cloudflare) and forwarded to the Google Gemini API to extract text, solely to return the scan result. A randomly generated anonymous device identifier is included for rate limiting and abuse prevention only.</li>
<li><b>Purchases:</b> payments are handled entirely by Apple; we never receive payment details. Subscription status is verified via RevenueCat, which processes an anonymous identifier and Apple transaction data.</li>
<li><b>Notifications:</b> stamp alarms are local notifications scheduled on the device.</li>
<li><b>We do not</b> show ads, sell data, or track you across apps or websites. No account is required.</li>
</ul>
<p>You may exercise your GDPR rights (access, rectification, erasure, restriction, objection) by writing to <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. The app is not directed to children under 13. Changes to this policy will be posted at this URL.</p>
</body></html>`;

const SUPPORT_HTML = `<!DOCTYPE html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>iRally &mdash; Supporto</title>
<style>${PAGE_CSS}</style></head><body>
<h1>iRally &mdash; Supporto / Support</h1>
<p><b>iRally</b> &egrave; l'app per piloti e navigatori: trip GPS, tabelle di marcia, scanner AI di radar e tabelle, sveglie sui timbri.</p>
<h2>Contatti</h2>
<p>Per assistenza, segnalazioni o richieste scrivi a <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a>. Rispondiamo di norma entro 48 ore.<br>
<span class="small">For support in English, write to the same address.</span></p>
<h2>Domande frequenti</h2>
<h3>Come ripristino un acquisto?</h3>
<p>Apri il paywall (una funzione Pro qualsiasi) e tocca &ldquo;Ripristina acquisti&rdquo; con lo stesso Apple ID usato per l'acquisto.</p>
<h3>Come disdico l'abbonamento?</h3>
<p>Dalle impostazioni del tuo Apple ID: <a href="https://apps.apple.com/account/subscriptions">apps.apple.com/account/subscriptions</a>. La disdetta ha effetto a fine periodo gi&agrave; pagato.</p>
<h3>Lo scanner non legge bene una pagina</h3>
<p>Scatta la foto dall'alto, ben illuminata e senza tagli ai bordi. Se il problema persiste, inviaci la foto via email e la analizziamo.</p>
<h2>Privacy</h2>
<p><a href="/privacy">Informativa privacy completa</a>.</p>
</body></html>`;
