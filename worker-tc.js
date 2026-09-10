/* ============================================================
   iRally - WORKER DELLA SOLA TABELLA DI MARCIA
   Separato dal worker del radar di proposito: una modifica qui
   non puo' toccare il radar, e viceversa.

   ALL'OSSO PER SCELTA: un modello, una chiamata, nessun ripiego,
   nessun tentativo multiplo. O risponde in pochi secondi, o dice
   esattamente cosa ha risposto Google. Se un domani serve
   ritentare, si aggiunge QUI e non altrove.
   ============================================================ */

/* Il modello si sceglie dal pannello Cloudflare (Settings > Variables > MODEL),
   senza toccare il codice: cosi' si provano modelli piu' economici in
   sicurezza, uno alla volta. Se la variabile manca, vale questo. */
const DEFAULT_MODEL = "gemini-3.6-flash";
const APP_KEY = "iRallyK3y9Xq7SdP2vLm2026";   // stessa stringa dell'app
const TIMEOUT_MS = 20000;                      // oltre, meglio un errore chiaro che far aspettare

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
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, cors || {}),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-App-Key",
    };

    const MODEL = (env && env.MODEL && String(env.MODEL).trim()) || DEFAULT_MODEL;
    if (url.pathname === "/version") {
      return new Response("iRally worker TABELLA v2 - modello: " + MODEL
        + (env && env.MODEL ? " (da variabile MODEL)" : " (predefinito)"),
        { headers: { "content-type": "text/plain" } });
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return new Response("iRally: server tabella di marcia attivo", { headers: cors });
    if (request.headers.get("X-App-Key") !== APP_KEY) return new Response("no", { status: 401, headers: cors });

    const T0 = Date.now();
    try {
      if (!env.GEMINI_KEY) return json({ error: "Chiave GEMINI_KEY mancante nel server" }, 200, cors);

      const body = await request.json();
      if (!body || !body.image) return json({ error: "Immagine mancante" }, 200, cors);

      /* thinkingLevel "minimal" = l'equivalente del vecchio thinkingBudget:0.
         Senza, i Gemini 3 ragionano al massimo: lentissimi e token di
         ragionamento pagati come output. */
      const payload = {
        contents: [{
          role: "user",
          parts: [
            { text: PROMPT_TIMECARD },
            { inline_data: { mime_type: "image/jpeg", data: body.image } },
          ],
        }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingLevel: "minimal" },
        },
      };

      const ctrl = new AbortController();
      const tmo = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await fetch(
          "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent",
          {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
            body: JSON.stringify(payload),
            signal: ctrl.signal,
          }
        );
      } catch (e) {
        clearTimeout(tmo);
        const secs = Math.round((Date.now() - T0) / 1000);
        return json({ error: (e && e.name === "AbortError")
          ? "Google non ha risposto entro " + (TIMEOUT_MS / 1000) + "s"
          : "Rete verso Google non raggiungibile [" + secs + "s]" }, 200, cors);
      }
      clearTimeout(tmo);

      let data = await res.json();

      /* "high demand" / 503 = Google sovraccarico per pochi secondi.
         UN solo ritentativo dopo 2,5 s: di piu' significherebbe far aspettare. */
      if (data.error && /high demand|overload|unavailable|\b503\b/i.test(String(data.error.message || ""))) {
        await new Promise(r => setTimeout(r, 2500));
        try {
          const res2 = await fetch(
            "https://generativelanguage.googleapis.com/v1beta/models/" + MODEL + ":generateContent",
            { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY }, body: JSON.stringify(payload) }
          );
          data = await res2.json();
        } catch (_) { /* si tiene l'errore del primo tentativo */ }
      }

      const secs = Math.round((Date.now() - T0) / 1000);

      /* errore di Google riportato COM'E': niente messaggi generici,
         cosi' si capisce subito se e' quota, sovraccarico o altro */
      if (data.error) {
        return json({ error: "Google: " + String(data.error.message || data.error).slice(0, 300) + " [" + secs + "s]" }, 200, cors);
      }

      let text = "";
      try { text = data.candidates[0].content.parts.map(p => p.text || "").join(""); } catch (_) {}
      if (!text) {
        const why = (data.candidates && data.candidates[0] && data.candidates[0].finishReason) || "risposta vuota";
        return json({ error: "Nessuna risposta dal modello (" + why + ") [" + secs + "s]" }, 200, cors);
      }

      let card;
      try {
        card = JSON.parse(text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
      } catch (_) {
        return json({ error: "Formato non valido dal modello [" + secs + "s]" }, 200, cors);
      }

      const u = (data.usageMetadata) || {};
      return json({
        card: card,
        model: MODEL,
        ms: Date.now() - T0,
        tok: { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0 },
      }, 200, cors);

    } catch (e) {
      return json({ error: "Errore interno del server: " + String(e && e.message || e).slice(0, 200) }, 200, cors);
    }
  },
};
