// app.js – orchestrace celé aplikace: připojení, presence, host, lobby,
// přehledy, transakce tahů/konců zápasů, monitory (čas/odpojení), reset.
import {
  db, ROOM_REF, ZAPASY_COL, PRITOMNOST_COL, zapasRef, pritomnostRef,
  onSnapshot, setDoc, runTransaction, getDocs, writeBatch, serverTimestamp,
  nowServer, kalibrujOffset, tsMs
} from "./fb.js";
import {
  nameToKey, esc, clamp, fmtCas,
  HEARTBEAT_MS, ONLINE_LIMIT_MS, ODPOJ_GRACE_MS, CAS_TOLERANCE_S
} from "./util.js";
import { postavDesku, vyherniRada } from "./gomoku.js";
import {
  postavStrom, projdiStrom, propagateStrom, naplanujZivoty, postavLigu,
  ligaTabulka, priradPoradiLize, auxZaZapas, priradPoradi, nazivu,
  novyZapasDoc
} from "./scheduling.js";
import { S, jmeno, hraciMap, jeOnline, hostKeyVypocet, aktualniHostKey, jsemHost,
         mujAktivniZapas, turnajHraciList, jeTurnajovyHrac } from "./state.js";
import { renderHru, updateClocks } from "./matchview.js";

const $ = (sel) => document.querySelector(sel);

// ============================ TOAST / MODAL ================================
let statusTimer = null;
function setStatus(text) {
  const el = $("#status");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

let modalResolv = null;
function confirmDialog(titulek, text, okText = "Potvrdit") {
  return new Promise(res => {
    modalResolv = res;
    $("#modal-title").textContent = titulek;
    $("#modal-text").textContent = text;
    $("#modal-ok").textContent = okText;
    $("#modal-overlay").classList.remove("hidden");
  });
}
function closeModal(vysledek) {
  $("#modal-overlay").classList.add("hidden");
  if (modalResolv) { modalResolv(vysledek); modalResolv = null; }
}
$("#modal-ok").addEventListener("click", () => closeModal(true));
$("#modal-cancel").addEventListener("click", () => closeModal(false));
$("#modal-overlay").addEventListener("click", e => { if (e.target === $("#modal-overlay")) closeModal(false); });

// ============================ NASTAVENÍ ====================================
function normalizujNastaveni(n = {}) {
  // Clamp všude: a) aby nastavení nešlo rozbít, b) délka řady nesmí být
  // větší než deska (výhra by byla nemožná → jen remízy).
  const velikostPole = clamp(Math.round(+n.velikostPole || 15), 5, 25);
  return {
    velikostPole,
    casNaHrace: clamp(Math.round(+n.casNaHrace || 600), 60, 1800),
    delkaRady: clamp(Math.round(+n.delkaRady || 5), 3, Math.min(10, velikostPole)),
    rezim: n.rezim === "liga" ? "liga" : "pavouk",
    pocetZivotu: +n.pocetZivotu === 3 ? 3 : 1,
    pocetKol: clamp(Math.round(+n.pocetKol || 4), 2, 10)
  };
}
function vychoziRoom() {
  return { fase: "lobby", hostKey: null, hostJmeno: null, hraci: {}, nastaveni: normalizujNastaveni({}) };
}

// ============================ PŘIPOJENÍ ====================================
// Jméno se normalizuje (case-insensitive + bez diakritiky) na klíč hráče.
// Stejné jméno může použít i víc zařízení najednou (vědomě neblokujeme) –
// ať už jde o návrat po odpojení, nebo prosté sdílení jednoho hráče víc
// lidmi/zařízeními zároveň (oba pak mají stejná práva dělat tahy za tuhle
// identitu). Pozdě připojený NOVÝ hráč se během turnaje stává divákem
// (pavouk je uzamčený od startu; do lobby se vrací jen resetem od hosta).
async function pripoj(jmenoRaw) {
  const zadane = jmenoRaw.trim().replace(/\s+/g, " ");
  const err = $("#join-error");
  err.textContent = "";
  if (zadane.length < 2) { err.textContent = "Zadej jméno (aspoň 2 znaky)."; return; }
  if (zadane.length > 20) { err.textContent = "Jméno je moc dlouhé (max 20 znaků)."; return; }
  const key = nameToKey(zadane);
  $("#join-btn").disabled = true;
  setStatus("Připojuji…");
  try {
    let jizOnline = false;
    await runTransaction(db, async (tx) => {
      // POZOR: Firestore transakce vyžaduje VŠECHNA čtení PŘED prvními
      // zápisy; a pro jistotu zapisujeme každý dokument jen jednou.
      const rs = await tx.get(ROOM_REF);
      const rd = rs.exists() ? rs.data() : {};
      const hm = rd.hraci ?? {};

      // Stejné jméno smí použít i víc zařízení/lidí najednou (schválně
      // neblokujeme) – klidně tím sdílí jednoho hráče (např. si chce s
      // někým "půjčit" tah, nebo se omylem připojil ze dvou zařízení).
      // Jen si to poznamenáme, ať to dole umíme hráči zmínit v hlášce.
      if (hm[key]) {
        const ps = await tx.get(pritomnostRef(key));
        const ts = ps.exists() ? tsMs(ps.data().posledniVideni) : null;
        jizOnline = ts != null && (nowServer() - ts) < ONLINE_LIMIT_MS;
      }

      // Jediný zápis do room: vytvoření výchozího stavu (pokud dokument
      // ještě neexistuje) + případná registrace nového hráče.
      const roomPatch = rs.exists() ? {} : vychoziRoom();
      if (!hm[key]) {
        roomPatch.hraci = { ...hm, [key]: { key, jmeno: zadane, pridano: serverTimestamp(), prohry: 0, poradi: null } };
      }
      if (Object.keys(roomPatch).length) tx.set(ROOM_REF, roomPatch, { merge: true });

      // Offline hráč (nebo druhé zařízení stejného jména) se stejným klíčem
      // => navázání (rekonekt/sdílení): statistiky i zobrazované jméno se
      // zachovají, jen obnovíme presence.
      tx.set(pritomnostRef(key), { key, jmeno: hm[key]?.jmeno ?? zadane, posledniVideni: serverTimestamp() }, { merge: true });
    });
    S.me = { key, jmeno: zadane };
    localStorage.setItem("piskvorky-jmeno", zadane);
    setStatus(jizOnline ? "Připojen! (sdílíš hráče s někým dalším)" : "Připojen!");
    startApp();
  } catch (e) {
    err.textContent = e.message || "Připojení se nepovedlo.";
    setStatus("Připojení se nepovedlo");
  } finally {
    $("#join-btn").disabled = false;
  }
}

$("#form-join").addEventListener("submit", e => { e.preventDefault(); pripoj($("#join-name").value); });
$("#join-name").value = localStorage.getItem("piskvorky-jmeno") ?? "";

// ============================ HEARTBEAT ====================================
// Heartbeat přes Web Worker: prohlížeče throttlují časovače na pozadí
// (až 1×/min) – worker drží heartbeat při životě, takže hráč s otevřenou
// záložkou "nezmizí" jen proto, že není na popředí.
let calPending = null, lastCalTs = 0;
function heartbeat() {
  if (!S.me) return;
  calPending = { zadano: Date.now() };
  setDoc(pritomnostRef(S.me.key), { key: S.me.key, jmeno: S.me.jmeno, posledniVideni: serverTimestamp() }, { merge: true }).catch(() => {});
}
function startHeartbeat() {
  try {
    const w = new Worker(URL.createObjectURL(new Blob([`setInterval(()=>postMessage(1),${HEARTBEAT_MS})`], { type: "text/javascript" })));
    w.onmessage = heartbeat;
  } catch { setInterval(heartbeat, HEARTBEAT_MS); }
  heartbeat();
}

// ============================ ODBĚRY / RENDER ==============================
let posledniFase = null, lastHostZapis = null, lobbyKey = "", divakToastUtan = false;

function startApp() {
  onSnapshot(ROOM_REF, snap => {
    S.room = snap.exists() ? snap.data() : vychoziRoom();
    if (!snap.exists()) setDoc(ROOM_REF, vychoziRoom(), { merge: true }).catch(() => {});
    // Trvalá persistence hostitele v lobby (kdokoliv to může zapsat –
    // výsledek je deterministický, konverguje; za běhu se nezapisuje).
    if ((S.room.fase ?? "lobby") === "lobby") {
      const d = hostKeyVypocet();
      if (d && d !== S.room.hostKey && d !== lastHostZapis) {
        lastHostZapis = d;
        setDoc(ROOM_REF, { hostKey: d, hostJmeno: jmeno(d) }, { merge: true }).catch(() => {});
      }
    }
    render();
  }, err => { console.error(err); setStatus("Chyba připojení k Firebase: " + err.message); });

  onSnapshot(ZAPASY_COL, snap => {
    S.zapasy.clear();
    snap.forEach(d => S.zapasy.set(d.id, d.data()));
    render();
  }, err => console.error(err));

  onSnapshot(PRITOMNOST_COL, snap => {
    S.pritomnost.clear();
    snap.forEach(d => S.pritomnost.set(d.id, d.data()));
    // Kalibrace odchylky serverového času z vlastního heartbeatu.
    if (S.me && calPending) {
      const ts = tsMs(S.pritomnost.get(S.me.key)?.posledniVideni);
      if (ts != null && ts > lastCalTs) {
        kalibrujOffset(calPending.zadano, Date.now(), ts);
        lastCalTs = ts; calPending = null;
      }
    }
    render();
  }, err => console.error(err));

  startHeartbeat();
  setInterval(updateClocks, 300);   // hodiny ve všech pohledech
  setInterval(monitor, 2500);       // pasivní detekce času/odpojení
}

function render() {
  if (!S.me || !S.room) return;
  const fase = S.room.fase ?? "lobby";

  // Toasty při změně fáze.
  if (fase !== posledniFase) {
    if (fase === "running") setStatus("Turnaj začíná! 🎮");
    if (fase === "finished" && S.room.vitez) setStatus(`🏁 Turnaj skončil – vítěz: ${jmeno(S.room.vitez)}`);
    if (fase === "running" && !jeTurnajovyHrac(S.me.key) && !divakToastUtan) {
      divakToastUtan = true;
      setStatus("Turnaj už běží – sleduješ jako divák 👀");
    }
    posledniFase = fase;
  }

  // Přepínání obrazovek podle fáze (uživatel si může z přehledu/konce přepnout sám).
  // "vstup" je počáteční stav klienta při KAŽDÉM načtení stránky (i pro
  // hráče, co se připojuje pozdě jako divák do rozjetého/dohraného turnaje) –
  // proto se musí řešit stejně jako přechod z "lobby", jinak zůstane hráč
  // trčet na vstupní obrazovce s hlavičkou hlásící "Turnaj skončil" a bez
  // možnosti se kamkoliv dostat.
  if (fase === "lobby") {
    if (S.screen !== "lobby") S.screen = "lobby";
  } else if (S.screen === "vstup" || S.screen === "lobby") {
    S.screen = fase === "finished" ? "konec" : "prehled";
  }
  if (fase === "running") autoOtevriMujZapas();

  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  const el = document.getElementById("screen-" + S.screen);
  if (el) el.classList.remove("hidden");

  renderHeader();
  if (S.screen === "lobby") renderLobby();
  else if (S.screen === "prehled") renderPrehled();
  else if (S.screen === "hra") renderHru();
  else if (S.screen === "konec") renderKonec();
  updateClocks();
}

// Automatické otevření vlastního rozehraného zápasu (kromě situace, kdy
// záměrně sleduji cizí zápas – pak jen upozorním toastem).
function autoOtevriMujZapas() {
  const myId = mujAktivniZapas();
  if (!myId || myId === S.viewMatchId || myId === S.lastAutoOpen) return;
  // Byl jsem už na obrazovce svého (teď nahrazeného) zápasu? Typicky po remíze,
  // kdy vznikne rovnou odveta (nové zapasId) a hráč zůstává na "hra" – bez téhle
  // větve by dál koukal na starou/plnou desku skončeného zápasu.
  const bylJsemNaSvem = S.screen === "hra" && S.viewMatchId === S.lastAutoOpen;
  S.lastAutoOpen = myId;
  setStatus("Začal tvůj zápas! ⚔");
  if (S.screen !== "hra" || bylJsemNaSvem) { S.viewMatchId = myId; S.screen = "hra"; }
}

function renderHeader() {
  const fase = S.room.fase ?? "lobby";
  const faseTxt = { lobby: "Lobby", running: "Turnaj probíhá", finished: "Turnaj skončil" }[fase];
  const online = Object.keys(hraciMap()).filter(jeOnline).length;
  let meta = `<span class="chip ${fase === "running" ? "live" : ""}">${faseTxt}</span>`;
  const hk = aktualniHostKey();
  if (hk) meta += `<span class="chip host">👑 ${esc(jmeno(hk))}</span>`;
  if (S.me) meta += `<span class="chip me">${esc(S.me.jmeno)}</span>`;
  meta += `<span class="chip">👥 online: ${online}</span>`;
  $("#header-meta").innerHTML = meta;

  let nav = "";
  const myId = mujAktivniZapas();
  if (S.screen === "hra") nav += `<button class="btn btn-secondary" data-nav="prehled">📋 Přehled</button>`;
  if (fase === "running" && myId && S.viewMatchId !== myId) nav += `<button class="btn btn-primary" data-nav="muj">⚔ Můj zápas</button>`;
  if (fase === "finished" && S.screen === "konec") nav += `<button class="btn btn-secondary" data-nav="prehled">📋 Průběh turnaje</button>`;
  if (fase === "finished" && S.screen === "prehled") nav += `<button class="btn btn-secondary" data-nav="konec">🏁 Výsledky</button>`;
  if (jsemHost() && fase === "running") nav += `<button class="btn btn-ghost" data-nav="ukoncit">⏹ Ukončit turnaj</button>`;
  if (jsemHost() && fase === "finished") nav += `<button class="btn btn-ghost" data-nav="reset">▶ Nové kolo</button>`;
  $("#header-nav").innerHTML = nav;
}

$("#header-nav").addEventListener("click", e => {
  const b = e.target.closest("[data-nav]");
  if (!b) return;
  if (b.dataset.nav === "prehled") { S.viewMatchId = null; S.screen = "prehled"; render(); }
  if (b.dataset.nav === "konec") { S.screen = "konec"; render(); }
  if (b.dataset.nav === "muj") { const id = mujAktivniZapas(); if (id) { S.viewMatchId = id; S.screen = "hra"; render(); } }
  if (b.dataset.nav === "reset") resetTurnaje(false);
  if (b.dataset.nav === "ukoncit") resetTurnaje(true);
});

// ============================ LOBBY ========================================
function renderLobby() {
  const kont = $("#screen-lobby");
  const nast = normalizujNastaveni(S.room.nastaveni);
  const hm = hraciMap();
  const host = jsemHost();
  const edit = host && (S.room.fase ?? "lobby") === "lobby";

  // Re-render lobby jen když se něco relevantního změní (jinak by re-render
  // „skákal“ Hostovi ve formuláři při každém snapshotu).
  const list = Object.values(hm).sort((a, b) =>
    (jeOnline(b.key) ? 1 : 0) - (jeOnline(a.key) ? 1 : 0) || (tsMs(a.pridano) ?? 0) - (tsMs(b.pridano) ?? 0));
  const key = JSON.stringify([Object.keys(hm).length, aktualniHostKey(), nast, edit, list.map(h => h.key + jeOnline(h.key))]);
  if (key === lobbyKey) return;
  lobbyKey = key;

  const offline = list.filter(h => !jeOnline(h.key)).length;
  const playersHtml = list.map(h => `
    <div class="pl-row ${jeOnline(h.key) ? "" : "off"}">
      <span class="pl-avatar">${esc((h.jmeno ?? "?").slice(0, 2).toUpperCase())}</span>
      <span class="pl-name">${esc(h.jmeno)}</span>
      ${aktualniHostKey() === h.key ? '<span class="crown" title="host">👑</span>' : ""}
      ${!jeOnline(h.key) ? '<span class="badge-offline">offline</span>' : ""}
    </div>`).join("") || `<p class="t-soft" style="font-size:.85rem">Ještě nikdo není online…</p>`;

  let settingsHtml;
  if (edit) {
    const opt = (from, to, sel) => Array.from({ length: to - from + 1 }, (_, i) => {
      const v = from + i;
      return `<option value="${v}" ${v === sel ? "selected" : ""}>${v}</option>`;
    }).join("");
    const minOpt = Math.min(10, nast.velikostPole);
    settingsHtml = `
      <div class="settings-grid">
        <label>Velikost pole
          <select id="set-velikost">${opt(5, 25, nast.velikostPole)}</select></label>
        <label>Čas na hráče
          <select id="set-cas">${[1, 2, 3, 5, 10, 15, 20, 30].map(m => `<option value="${m * 60}" ${m * 60 === nast.casNaHrace ? "selected" : ""}>${m} min</option>`).join("")}</select></label>
      </div>
      <div class="field"><span class="field-label">Délka výherní řady</span>
        <select id="set-rada">${opt(3, minOpt, Math.min(nast.delkaRady, minOpt))}</select></div>
      <div class="field"><span class="field-label">Formát turnaje</span>
        <div class="switcher">
          <button data-set-rezim="pavouk" class="${nast.rezim === "pavouk" ? "active" : ""}">🕸 Pavouk</button>
          <button data-set-rezim="liga" class="${nast.rezim === "liga" ? "active" : ""}">🏆 Liga</button>
        </div></div>
      ${nast.rezim === "pavouk" ? `<div class="field"><span class="field-label">Počet životů</span>
        <div class="switcher">
          <button data-set-zivoty="1" class="${nast.pocetZivotu === 1 ? "active" : ""}">1 život</button>
          <button data-set-zivoty="3" class="${nast.pocetZivotu === 3 ? "active" : ""}">3 životy</button>
        </div></div>` : `<div class="field"><span class="field-label">Počet kol</span>
          <select id="set-kola">${opt(2, 10, nast.pocetKol)}</select></div>`}
      ${offline ? `<div class="warn-note">⚠ ${offline} ${offline === 1 ? "hráč je" : "hráči jsou"} offline. Turnaj můžeš spustit i tak – jejich zápasy skončí kontumačně, pokud se nevrátí (duchy necháváme v pavoukovi záměrně, ať nikdo „nezmizí“ omylem).</div>` : ""}
      <div class="lobby-actions">
        <button id="btn-start" class="btn btn-primary btn-lg" ${Object.keys(hm).length < 2 ? "disabled" : ""}>
          Spustit turnaj (${Object.keys(hm).length} ${Object.keys(hm).length === 1 ? "hráč" : "hráčů"})
        </button>
        ${Object.keys(hm).length < 2 ? `<p class="lobby-note">Na start turnaje jsou potřeba aspoň 2 hráči.</p>` : ""}
      </div>`;
  } else {
    const r = (label, val) => `<div class="readonly-row"><span class="t-soft">${label}</span><b>${val}</b></div>`;
    settingsHtml = `
      ${r("Velikost pole", `${nast.velikostPole}×${nast.velikostPole}`)}
      ${r("Čas na hráče", fmtCas(nast.casNaHrace))}
      ${r("Délka výherní řady", nast.delkaRady)}
      ${r("Formát", nast.rezim === "liga" ? "Liga" : "Pavouk")}
      ${nast.rezim === "pavouk" ? r("Počet životů", nast.pocetZivotu) : r("Počet kol", nast.pocetKol)}
      <p class="lobby-note">${aktualniHostKey() ? `Nastavení může měnit jen host (${esc(jmeno(aktualniHostKey()))}).` : "Čeká se na hostitele…"}</p>`;
  }

  kont.innerHTML = `
    <div class="lobby-grid">
      <div class="panel"><h3>👥 Hráči (${list.filter(h => jeOnline(h.key)).length} online)</h3>
        <div class="player-list">${playersHtml}</div></div>
      <div class="panel"><h3>⚙️ Nastavení hry ${edit ? "" : "– jen pro čtení"}</h3>
        ${settingsHtml}</div>
    </div>`;

  if (edit) {
    const uloz = async (patch) => {
      const nast2 = normalizujNastaveni({ ...normalizujNastaveni(S.room.nastaveni), ...patch });
      setStatus("Ukládám…");
      try { await setDoc(ROOM_REF, { nastaveni: nast2 }, { merge: true }); setStatus("Uloženo"); }
      catch (e) { setStatus("Chyba ukládání: " + e.message); }
    };
    kont.querySelectorAll("select").forEach(sel => sel.addEventListener("change", () => {
      const map = { "set-velikost": ["velikostPole", +sel.value], "set-cas": ["casNaHrace", +sel.value], "set-rada": ["delkaRady", +sel.value], "set-kola": ["pocetKol", +sel.value] }[sel.id];
      if (map) uloz({ [map[0]]: map[1] });
    }));
    kont.querySelectorAll("[data-set-rezim]").forEach(b => b.addEventListener("click", () => uloz({ rezim: b.dataset.setRezim })));
    kont.querySelectorAll("[data-set-zivoty]").forEach(b => b.addEventListener("click", () => uloz({ pocetZivotu: +b.dataset.setZivoty })));
    const start = kont.querySelector("#btn-start");
    if (start) start.addEventListener("click", startTurnaje);
  }
}

// ============================ START TURNAJE ================================
async function startTurnaje() {
  if (!jsemHost()) { setStatus("Spustit turnaj může jen host."); return; }
  setStatus("Losuji a spouštím turnaj…");
  try {
    await runTransaction(db, async (tx) => {
      const rs = await tx.get(ROOM_REF);
      const rd = rs.exists() ? rs.data() : {};
      if ((rd.fase ?? "lobby") !== "lobby") throw new Error("Turnaj už byl spuštěn.");
      const hm = rd.hraci ?? {};
      const keys = Object.keys(hm);
      if (keys.length < 2) throw new Error("Potřebuji aspoň 2 hráče.");
      const nast = normalizujNastaveni(rd.nastaveni);

      let pavouk = null, liga = null;
      if (nast.rezim === "pavouk") {
        if (nast.pocetZivotu === 3) {
          pavouk = { typ: "zivoty", vlna: 0, zapasy: [] };
          for (const n of naplanujZivoty(pavouk, hm, keys)) {
            pavouk.zapasy.push(n);
            tx.set(zapasRef(n.id), aktivujDoc(nast, { id: n.id, kolo: n.kolo, vetev: n.vetev, typ: "zivoty", hraci: n.hraci }));
          }
        } else {
          const strom = postavStrom(keys);
          projdiStrom(strom); // v paměti vyřeší volná kola a označí starty
          pavouk = { typ: "strom", velikost: strom.velikost, zapasy: strom.zapasy };
          for (const u of strom.zapasy) {
            let data;
            if (u.stav === "hotovo") data = byeDoc(nast, u);
            else if (u.stav === "probiha") data = aktivujDoc(nast, { id: u.zapasId, kolo: u.kolo, vetev: u.finale ? "finale" : "hlavni", typ: "strom", hraci: u.hraci });
            else data = novyZapasDoc(nast, { id: u.zapasId, kolo: u.kolo, vetev: u.finale ? "finale" : "hlavni", typ: "strom", hraci: null });
            tx.set(zapasRef(u.zapasId), data);
          }
        }
      } else {
        liga = postavLigu(keys, nast.pocetKol);
        if (liga.pocetKol < nast.pocetKol) setStatus(`Liga má pro ${keys.length} hráčů jen ${liga.pocetKol} kol.`);
        for (const z of liga.zapasy) {
          if (z.kolo === 0) z.stav = "probiha";
          tx.set(zapasRef(z.id), z.kolo === 0
            ? aktivujDoc(nast, { id: z.id, kolo: z.kolo, vetev: "liga", typ: "liga", hraci: z.hraci })
            : novyZapasDoc(nast, { id: z.id, kolo: z.kolo, vetev: "liga", typ: "liga", hraci: z.hraci }));
        }
      }
      // nastavení se zápisem fáze "running" efektivně zamkne (editovat lze jen v lobby)
      tx.set(ROOM_REF, { fase: "running", turnajHraci: keys, nastaveni: nast, pavouk, liga, vitez: null }, { merge: true });
    });
    setStatus("Turnaj spuštěn! 🎮");
  } catch (e) {
    setStatus("Start se nepovedl: " + e.message);
  }
}

function aktivujDoc(nast, o) {
  return { ...novyZapasDoc(nast, { ...o, aktivni: true }), tahZahajen: serverTimestamp(), zacatek: serverTimestamp() };
}
function byeDoc(nast, u) {
  return {
    ...novyZapasDoc(nast, { id: u.zapasId, kolo: u.kolo, vetev: u.finale ? "finale" : "hlavni", typ: "strom", hraci: u.hraci }),
    stav: "hotovo", duvodKonec: "bye", vitez: u.vitez === "BYE" ? null : u.vitez, konec: serverTimestamp()
  };
}

// ============================ TAHY =========================================
// Tah hráče – transakce nad dokumentem zápasu. Pokud tah zakládá vítěznou
// řadu / remízu / pozdní tah (čas už vypršel), transakce ROVNOU zapisuje
// i konec zápasu + posun turnaje (atomicky, v jedné transakci přes zápas
// i room). Validace (jsem na tahu, volné pole) běží na aktuálních datech
// na serveru, takže dvojkliky a souběhy nic nerozbijí.
async function proveTah(r, c) {
  const id = S.viewMatchId;
  const md = id ? S.zapasy.get(id) : null;
  if (!md || !S.me) return;
  if (md.stav !== "probiha") { setStatus("Zápas už skončil."); return; }
  if (md.naTahu !== S.me.key) { setStatus("Nejsi na tahu."); return; }
  try {
    await runTransaction(db, async (tx) => {
      const mRef = zapasRef(id);
      const ms = await tx.get(mRef);
      const m = ms.data();
      if (!m || m.stav !== "probiha") throw new Error("Zápas mezitím skončil.");
      if (m.naTahu !== S.me.key) throw new Error("Nejsi na tahu.");
      const size = m.velikostPole;
      if (r < 0 || r >= size || c < 0 || c >= size) throw new Error("Mimo desku.");
      const deska = postavDesku(size, m.tahy);
      if (deska[r][c]) throw new Error("Pole je už obsazené.");

      const mujIdx = m.hraci[0] === S.me.key ? 0 : 1;
      const start = tsMs(m.tahZahajen) ?? nowServer();
      const mojeZbyva = (mujIdx === 0 ? m.zbyva1 : m.zbyva2) - Math.max(0, (nowServer() - start) / 1000);

      if (mojeZbyva <= 0) {
        // Tah přišel pozdě => prohra na čas (vyřešíme tady, ať to nevisí).
        const rs = await tx.get(ROOM_REF);
        const rd = rs.exists() ? rs.data() : {};
        const konecne = vypocitejKonecneCasy(m);
        tx.update(mRef, { stav: "hotovo", vitez: m.hraci[1 - mujIdx], duvodKonec: "cas", zbyva1: konecne[0], zbyva2: konecne[1], konec: serverTimestamp(), naTahu: null });
        const zmeny = upravRoomPoKonci(rd, m, { vitez: m.hraci[1 - mujIdx], duvod: "cas", konecne });
        for (const d of zmeny.noveDoky) tx.set(d.ref, d.data);
        if (Object.keys(zmeny.roomUpdate).length) tx.set(ROOM_REF, zmeny.roomUpdate, { merge: true });
        return;
      }

      const tahy = [...m.tahy, { r, c }];
      const rada = vyherniRada(postavDesku(size, tahy), r, c, m.delkaRady);

      if (rada) {
        const rs = await tx.get(ROOM_REF);
        const rd = rs.exists() ? rs.data() : {};
        const konecne = mujIdx === 0 ? [mojeZbyva, m.zbyva2] : [m.zbyva1, mojeZbyva];
        tx.update(mRef, { tahy, stav: "hotovo", vitez: S.me.key, duvodKonec: "rada", viteznaRada: rada, zbyva1: konecne[0], zbyva2: konecne[1], konec: serverTimestamp(), naTahu: null });
        const zmeny = upravRoomPoKonci(rd, { ...m, tahy }, { vitez: S.me.key, duvod: "rada", konecne });
        for (const d of zmeny.noveDoky) tx.set(d.ref, d.data);
        if (Object.keys(zmeny.roomUpdate).length) tx.set(ROOM_REF, zmeny.roomUpdate, { merge: true });
      } else if (tahy.length >= size * size) {
        // Plná deska bez řady => remíza (v pavouku odveta, v lize se počítá).
        const rs = await tx.get(ROOM_REF);
        const rd = rs.exists() ? rs.data() : {};
        const konecne = mujIdx === 0 ? [mojeZbyva, m.zbyva2] : [m.zbyva1, mojeZbyva];
        tx.update(mRef, { tahy, stav: "hotovo", vitez: null, duvodKonec: "remiza", zbyva1: konecne[0], zbyva2: konecne[1], konec: serverTimestamp(), naTahu: null });
        const zmeny = upravRoomPoKonci(rd, { ...m, tahy }, { vitez: null, duvod: "remiza", konecne });
        for (const d of zmeny.noveDoky) tx.set(d.ref, d.data);
        if (Object.keys(zmeny.roomUpdate).length) tx.set(ROOM_REF, zmeny.roomUpdate, { merge: true });
      } else {
        const zmena = { tahy, naTahu: m.hraci[1 - mujIdx], tahZahajen: serverTimestamp() };
        zmena[mujIdx === 0 ? "zbyva1" : "zbyva2"] = Math.max(0, mojeZbyva);
        tx.update(mRef, zmena);
      }
    });
  } catch (e) {
    setStatus(e.message || "Tah se nepovedl.");
  }
}

// Klik na buňku desky (delegace na sekci herní obrazovky).
$("#screen-hra").addEventListener("click", e => {
  if (e.target.closest("[data-back]")) { S.viewMatchId = null; S.screen = (S.room?.fase ?? "lobby") === "finished" ? "konec" : "prehled"; render(); return; }
  const cell = e.target.closest(".cell");
  if (cell && S.viewMatchId) proveTah(+cell.dataset.r, +cell.dataset.c);
});

// ============================ KONEC ZÁPASU =================================
// Sdílená logika posunu turnaje po skončení zápasu. Mutuje data room
// (zrcadla, statistiky, umístění, fáze) a vrací zápisy nových match dokumentů
// (starty dalších zápasů / odvety). Volá se VŽDY uvnitř transakce.
function upravRoomPoKonci(rd, md, vysl) {
  const nast = normalizujNastaveni(rd.nastaveni);
  const hm = rd.hraci ?? {};
  const noveDoky = [];
  const roomUpdate = {};
  const zrcadlo = (list) => list.find(z => (z.zapasId ?? z.id) === md.id || z.id === md.id);

  if (rd.pavouk?.typ === "strom") {
    const strom = rd.pavouk;
    const uzel = strom.zapasy.find(u => u.zapasId === md.id);
    if (!uzel) return { roomUpdate: {}, noveDoky };
    if (vysl.duvod === "remiza") {
      // ODVETA: stejný uzel stromu, prohozené barvy, nové hodiny.
      uzel.odvet = (uzel.odvet ?? 0) + 1;
      uzel.zapasId = `${uzel.id}-r${uzel.odvet}`;
      uzel.stav = "probiha"; uzel.vitez = null; uzel.duvod = null;
      noveDoky.push({ ref: zapasRef(uzel.zapasId), data: aktivujDoc(nast, { id: uzel.zapasId, kolo: uzel.kolo, vetev: uzel.finale ? "finale" : "hlavni", typ: "strom", hraci: [md.hraci[1], md.hraci[0]] }) });
    } else {
      uzel.vitez = vysl.vitez; uzel.duvod = vysl.duvod; uzel.stav = "hotovo";
      const porazeny = md.hraci.find(k => k !== vysl.vitez);
      if (vysl.vitez && porazeny && hm[porazeny]) {
        hm[porazeny].prohry = (hm[porazeny].prohry ?? 0) + 1;
        priradPoradi(hm, porazeny);
      }
      if (vysl.vitez) {
        propagateStrom(strom, uzel);
        const { spustit, vyresene } = projdiStrom(strom);
        for (const u of spustit) noveDoky.push({ ref: zapasRef(u.zapasId), data: aktivujDoc(nast, { id: u.zapasId, kolo: u.kolo, vetev: u.finale ? "finale" : "hlavni", typ: "strom", hraci: u.hraci }) });
        for (const u of vyresene) noveDoky.push({ ref: zapasRef(u.zapasId), data: byeDoc(nast, u) });
        if (uzel.finale) { // vítěz finále = vítěz turnaje
          if (hm[vysl.vitez]) hm[vysl.vitez].poradi = 1;
          roomUpdate.fase = "finished"; roomUpdate.vitez = vysl.vitez;
        }
      }
    }
    roomUpdate.pavouk = strom; roomUpdate.hraci = hm;
  } else if (rd.pavouk?.typ === "zivoty") {
    const pav = rd.pavouk;
    const zrc = pav.zapasy.find(z => z.id === md.id);
    if (!zrc) return { roomUpdate: {}, noveDoky };
    zrc.vitez = vysl.vitez; zrc.duvod = vysl.duvod; zrc.stav = "hotovo";
    if (vysl.duvod === "remiza") {
      // Odveta hned (prohozené barvy) – hráči zůstávají spárovaní.
      pav.vlna++;
      const nid = `${md.id}-r${pav.vlna}`;
      pav.zapasy.push({ id: nid, kolo: pav.vlna, vetev: zrc.vetev, hraci: [md.hraci[1], md.hraci[0]], vitez: null, duvod: null, stav: "probiha" });
      noveDoky.push({ ref: zapasRef(nid), data: aktivujDoc(nast, { id: nid, kolo: pav.vlna, vetev: zrc.vetev, typ: "zivoty", hraci: [md.hraci[1], md.hraci[0]] }) });
    } else {
      const porazeny = md.hraci.find(k => k !== vysl.vitez);
      if (vysl.vitez && porazeny && hm[porazeny]) {
        hm[porazeny].prohry = (hm[porazeny].prohry ?? 0) + 1;
        if (hm[porazeny].prohry >= nast.pocetZivotu) priradPoradi(hm, porazeny); // 3. prohra = ven
      }
      const zivi = nazivu(hm, rd.turnajHraci ?? []);
      if (zivi.length <= 1) {
        if (zivi.length === 1) {
          if (hm[zivi[0]]) hm[zivi[0]].poradi = 1;
          roomUpdate.fase = "finished"; roomUpdate.vitez = zivi[0];
        }
      } else {
        // Přeplánování VŠECH volných hráčů – souběžnost podle zadání.
        for (const n of naplanujZivoty(pav, hm, rd.turnajHraci ?? [])) {
          pav.zapasy.push(n);
          noveDoky.push({ ref: zapasRef(n.id), data: aktivujDoc(nast, { id: n.id, kolo: n.kolo, vetev: n.vetev, typ: "zivoty", hraci: n.hraci }) });
        }
      }
    }
    roomUpdate.pavouk = pav; roomUpdate.hraci = hm;
  } else if (rd.liga) {
    const liga = rd.liga;
    const zrc = zrcadlo(liga.zapasy);
    if (!zrc) return { roomUpdate: {}, noveDoky };
    zrc.vitez = vysl.vitez; zrc.duvod = vysl.duvod; zrc.stav = "hotovo";
    // pomocné body (tiebreak) – vzorec v scheduling.js
    const zbyvaViteze = vysl.vitez == null ? null : (vysl.vitez === md.hraci[0] ? vysl.konecne[0] : vysl.konecne[1]);
    const aux = auxZaZapas(md.hraci, vysl.vitez, vysl.duvod, zbyvaViteze, md.casNaHrace ?? nast.casNaHrace);
    zrc.auxA = aux.auxA; zrc.auxB = aux.auxB;
    if (zrc.kolo === liga.aktivniKolo) {
      const koloHotove = liga.zapasy.every(z => z.kolo !== liga.aktivniKolo || z.stav === "hotovo");
      if (koloHotove) {
        const dalsi = liga.aktivniKolo + 1;
        if (dalsi < liga.pocetKol) {
          liga.aktivniKolo = dalsi;
          for (const z of liga.zapasy.filter(z => z.kolo === dalsi)) {
            z.stav = "probiha";
            noveDoky.push({ ref: zapasRef(z.id), data: aktivujDoc(nast, { id: z.id, kolo: z.kolo, vetev: "liga", typ: "liga", hraci: z.hraci }) });
          }
        } else {
          const tab = ligaTabulka(hm, liga, rd.turnajHraci ?? []);
          priradPoradiLize(hm, tab);
          roomUpdate.fase = "finished"; roomUpdate.vitez = tab[0]?.key ?? null;
        }
      }
    }
    roomUpdate.liga = liga; roomUpdate.hraci = hm;
  }
  return { roomUpdate, noveDoky };
}

// Zmražení finálních časů při konci zápasu (kontumace/čas – z bank a uplynulého času).
function vypocitejKonecneCasy(md) {
  let z1 = md.zbyva1 ?? 0, z2 = md.zbyva2 ?? 0;
  const start = tsMs(md.tahZahajen);
  if (start != null && md.naTahu) {
    const uplynulo = Math.max(0, (nowServer() - start) / 1000);
    if (md.naTahu === md.hraci[0]) z1 = Math.max(0, z1 - uplynulo);
    else if (md.naTahu === md.hraci[1]) z2 = Math.max(0, z2 - uplynulo);
  }
  return [z1, z2];
}

// Ukončení zápasu z monitoru (čas / kontumace) – idempotentní transakce:
// kdokoliv ji spustí jako první, zvítězí; ostatní už uvidí stav "hotovo".
async function ukonciZapas(id, vysl) {
  try {
    await runTransaction(db, async (tx) => {
      const mRef = zapasRef(id);
      const ms = await tx.get(mRef);
      const m = ms.data();
      if (!m || m.stav !== "probiha") return;
      const rs = await tx.get(ROOM_REF);
      const rd = rs.exists() ? rs.data() : {};
      const konecne = vypocitejKonecneCasy(m);
      tx.update(mRef, { stav: "hotovo", vitez: vysl.vitez ?? null, duvodKonec: vysl.duvod, viteznaRada: null, zbyva1: konecne[0], zbyva2: konecne[1], konec: serverTimestamp(), naTahu: null });
      const zmeny = upravRoomPoKonci(rd, m, { ...vysl, konecne });
      for (const d of zmeny.noveDoky) tx.set(d.ref, d.data);
      if (Object.keys(zmeny.roomUpdate).length) tx.set(ROOM_REF, zmeny.roomUpdate, { merge: true });
    });
  } catch (e) { console.warn("ukonciZapas:", e); }
}

// ============================ MONITORY =====================================
// Každý klient (i divák) pasivně kontroluje běžící zápasy:
//  1) vypršel čas hráče na tahu (podle serverových timestampů) => prohra na čas,
//  2) hráč je offline déle než ~20 s + 2 minuty => kontumace;
//     jsou-li offline oba déle než lhůta, prohrává ten, kdo je offline DÉLE
//     (rozhodnutí: je "na vině" víc).
// Díky serverovým timestampům je detekce konzistentní u všech klientů;
// transakce zajišťují, že se zápas ukončí právě jednou.
async function monitor() {
  if (!S.room || (S.room.fase ?? "lobby") !== "running") return;
  const zs = [...(S.room.pavouk?.zapasy ?? []), ...(S.room.liga?.zapasy ?? [])];
  const now = nowServer();
  for (const z of zs) {
    if (z.stav !== "probiha") continue;
    const md = S.zapasy.get(z.zapasId ?? z.id);
    if (!md || md.stav !== "probiha" || !md.hraci?.[0] || !md.hraci?.[1]) continue;
    const start = tsMs(md.tahZahajen);
    if (start != null && md.naTahu && md.hraci.includes(md.naTahu)) {
      const idx = md.hraci.indexOf(md.naTahu);
      const zbyva = (idx === 0 ? md.zbyva1 : md.zbyva2) - (now - start) / 1000;
      if (zbyva <= -CAS_TOLERANCE_S) {
        queueEnd(md.id, { vitez: md.hraci[1 - idx], duvod: "cas" });
        continue;
      }
    }
    const offline = md.hraci.map(k => {
      const ts = tsMs(S.pritomnost.get(k)?.posledniVideni);
      return { k, ts, za: ts == null ? null : (now - ts) / 1000 };
    }).filter(o => o.za != null && o.za > (ONLINE_LIMIT_MS + ODPOJ_GRACE_MS) / 1000);
    if (offline.length === 2) {
      const vinik = offline.reduce((a, b) => (a.za >= b.za ? a : b));
      queueEnd(md.id, { vitez: md.hraci.find(k => k !== vinik.k), duvod: "kontumace" });
    } else if (offline.length === 1) {
      queueEnd(md.id, { vitez: md.hraci.find(k => k !== offline[0].k), duvod: "kontumace" });
    }
  }
}
function queueEnd(id, vysl) {
  // Drobný náhodný skluz, ať nespustí transakci všech 30 klientů ve stejný ms.
  setTimeout(() => ukonciZapas(id, vysl), 300 + Math.random() * 1200);
}

// ============================ PŘEHLED ======================================
$("#screen-prehled").addEventListener("click", e => {
  const el = e.target.closest("[data-open]");
  if (el) { S.viewMatchId = el.dataset.open; S.screen = "hra"; render(); }
});

function renderPrehled() {
  const kont = $("#screen-prehled");
  const rd = S.room;
  if (rd?.pavouk?.typ === "strom") kont.innerHTML = htmlStrom(rd);
  else if (rd?.pavouk?.typ === "zivoty") kont.innerHTML = htmlZivoty(rd);
  else if (rd?.liga) kont.innerHTML = htmlLiga(rd);
  else kont.innerHTML = `<p class="t-soft">Turnaj ještě nebyl spuštěn.</p>`;
}

function bmatchRadka(slot, idx, uzel) {
  let jmenoTxt, trida = "bmatch-row";
  if (slot == null) jmenoTxt = `<span class="t-soft">postupuje…</span>`;
  else if (slot === "BYE") jmenoTxt = `<span class="t-soft">volno</span>`;
  else {
    if (uzel.stav === "hotovo" && uzel.vitez === slot) trida += " winner";
    if (uzel.stav === "hotovo" && uzel.vitez && uzel.vitez !== "BYE" && uzel.vitez !== slot) trida += " out";
    jmenoTxt = esc(jmeno(slot));
  }
  const md = uzel.stav === "probiha" ? S.zapasy.get(uzel.zapasId) : null;
  return `<div class="${trida}"><span class="sym sym-${idx === 0 ? "x" : "o"}"></span>
    <span class="bmatch-name">${jmenoTxt}</span>
    ${md ? `<span class="mini-clock" data-clock="${uzel.zapasId}|${idx}"></span>` : ""}</div>`;
}

function htmlStrom(rd) {
  const kola = [];
  for (const u of rd.pavouk.zapasy) (kola[u.kolo] ??= []).push(u);
  const cols = kola.map((uzly, k) => `
    <div class="bracket-col">
      <div class="bracket-head">${uzly[0].finale ? "Finále" : `Kolo ${k + 1}`}</div>
      ${uzly.map(u => {
        const klik = u.stav === "probiha" || (u.stav === "hotovo" && u.duvod !== "bye" && u.vitez && u.vitez !== "BYE");
        return `<div class="bmatch ${u.stav === "probiha" ? "live" : ""} ${klik ? "click" : ""}" ${klik ? `data-open="${u.zapasId}"` : ""}>
          ${bmatchRadka(u.slotA, 0, u)}${bmatchRadka(u.slotB, 1, u)}</div>`;
      }).join("")}
    </div>`).join("");
  return `<h3 style="margin:4px 0 12px">🕸 Pavouk <span class="t-soft" style="font-size:.8rem;font-weight:500">(${turnajHraciList().length} hráčů)</span></h3>
    <div class="bracket">${cols}</div>
    <p class="hint">Klikni na zápas a sleduj ho naživo (i jako divák). „Volno“ = postup bez soupeře (bye).</p>`;
}

function htmlZivoty(rd) {
  const nast = normalizujNastaveni(rd.nastaveni);
  const hm = hraciMap();
  const zivi = nazivu(hm, turnajHraciList());
  const zivotu = nast.pocetZivotu;
  const chips = zivi
    .sort((a, b) => (hm[a].prohry ?? 0) - (hm[b].prohry ?? 0))
    .map(k => `<span class="zivot-chip">${esc(jmeno(k))} ${Array.from({ length: zivotu }, (_, i) =>
      `<span class="heart ${i < zivotu - (hm[k].prohry ?? 0) ? "on" : ""}">♥</span>`).join("")}</span>`).join("");
  const aktivni = rd.pavouk.zapasy.filter(z => z.stav === "probiha");
  const hotove = rd.pavouk.zapasy.filter(z => z.stav === "hotovo").reverse();
  const duv = { rada: "řada", cas: "čas", kontumace: "kontumace", remiza: "remíza", bye: "volno" };
  return `
    <h3 style="margin:4px 0 12px">🕸 Pavouk na ${zivotu} ${zivotu === 1 ? "život" : "životy"}</h3>
    ${zivi.length === 2 ? `<div class="finale-banner">🏆 <b>Grandfinále</b>: ${zivi.map(k => esc(jmeno(k))).join(" vs ")} – hraje se, dokud jeden nezíská ${zivotu}. prohru.</div>` : ""}
    <div class="zivoty-head">${chips}</div>
    <div class="section-title">Probíhající zápasy</div>
    <div class="match-cards">${aktivni.map(z => mcard(z)).join("") || `<p class="t-soft">Právě nic – čeká se na volné hráče…</p>`}</div>
    <div class="section-title">Dokončené zápasy</div>
    <div class="hist-list">${hotove.map(z => `
      <div class="hist-row"><span class="sym sym-x"></span>${esc(jmeno(z.hraci[0]))} vs <span class="sym sym-o"></span>${esc(jmeno(z.hraci[1]))}
        <span class="duvod">${z.vitez ? `vyhrál ${esc(jmeno(z.vitez))} (${duv[z.duvod] ?? ""})` : "remíza → odveta"}</span></div>`).join("") || `<p class="t-soft">Zatím žádné výsledky.</p>`}</div>`;
}

// Zrcadla zápasů v room dokumentu nemají pole "popis" (má ho jen dokument
// zápasu v subkolekci) – vezmeme ho odtud, pokud existuje.
function popisZrc(z) {
  return S.zapasy.get(z.zapasId ?? z.id)?.popis ?? z.popis ?? "";
}

function mcard(z) {
  const id = z.zapasId ?? z.id;
  return `<div class="mcard" data-open="${id}">
    <div class="popis">${esc(popisZrc(z))}</div>
    <div class="mcard-row"><span class="sym sym-x"></span>${esc(jmeno(z.hraci[0]))} <span class="mini-clock" data-clock="${id}|0"></span></div>
    <div class="mcard-row"><span class="sym sym-o"></span>${esc(jmeno(z.hraci[1]))} <span class="mini-clock" data-clock="${id}|1"></span></div>
  </div>`;
}

function htmlLiga(rd) {
  const liga = rd.liga;
  const hm = hraciMap();
  const tab = ligaTabulka(hm, liga, turnajHraciList());
  const aktualni = liga.aktivniKolo ?? 0;
  const volno = new Set(Object.entries(liga.volna ?? {}).filter(([, kola]) => kola.includes(aktualni)).map(([k]) => k));
  const kolaHtml = Array.from({ length: liga.pocetKol }, (_, k) => {
    const zs = liga.zapasy.filter(z => z.kolo === k);
    const aktual = k === aktualni && zs.some(z => z.stav !== "hotovo");
    const hotove = zs.every(z => z.stav === "hotovo");
    return `<div class="section-title">Kolo ${k + 1} ${aktual ? "· právě hraje" : hotove ? "· hotovo" : ""}</div>
      <div class="match-cards">${zs.map(z => {
        if (z.stav === "hotovo") {
          const vysl = z.vitez == null ? "remíza" : `vyhrál ${esc(jmeno(z.vitez))}`;
          return `<div class="mcard" data-open="${z.id}" style="opacity:.85">
            <div class="popis">${esc(popisZrc(z))}</div>
            <div class="mcard-row"><span class="sym sym-x"></span>${esc(jmeno(z.hraci[0]))} ${z.vitez === z.hraci[0] ? "✓" : ""}</div>
            <div class="mcard-row"><span class="sym sym-o"></span>${esc(jmeno(z.hraci[1]))} ${z.vitez === z.hraci[1] ? "✓" : ""}</div>
            <div class="t-soft" style="font-size:.75rem">${vysl}</div></div>`;
        }
        return mcard(z);
      }).join("")}</div>`;
  }).join("");
  return `
    <h3 style="margin:4px 0 6px">🏆 Liga</h3>
    <div class="liga-progress">Kolo ${Math.min(aktualni + 1, liga.pocetKol)} z ${liga.pocetKol}
      ${volno.size ? `· volno má: ${[...volno].map(k => esc(jmeno(k))).join(", ")}` : ""}</div>
    ${kolaHtml}
    <div class="section-title">Tabulka <span class="t-soft" style="font-weight:500;font-size:.78rem">(pořadí: výhry → remízy → pomocné body)</span></div>
    <table class="tabulka">
      <thead><tr><th>#</th><th>Hráč</th><th class="num">V</th><th class="num">R</th><th class="num">P</th><th class="num">Pom. body</th></tr></thead>
      <tbody>${tab.map((r, i) => `
        <tr class="${S.me && r.key === S.me.key ? "ja" : ""}">
          <td class="poradi-b">${i + 1}</td><td>${esc(r.jmeno)}</td>
          <td class="num">${r.vyhry}</td><td class="num">${r.remizy}</td><td class="num">${r.prohry}</td><td class="num">${r.aux}</td>
        </tr>`).join("")}</tbody>
    </table>`;
}

// ============================ KONEC ========================================
function renderKonec() {
  const kont = $("#screen-konec");
  const rd = S.room;
  const nast = normalizujNastaveni(rd.nastaveni);
  const hm = hraciMap();
  const vitez = rd.vitez;
  const modTxt = rd.liga ? "liga" : rd.pavouk?.typ === "zivoty" ? `pavouk na ${nast.pocetZivotu} životy` : "vyřazovací pavouk";
  const poradi = turnajHraciList().slice().sort((a, b) => (hm[a]?.poradi ?? 99) - (hm[b]?.poradi ?? 99));
  const medal = (p) => p === 1 ? "🥇" : p === 2 ? "🥈" : p === 3 ? "🥉" : `${p}.`;
  const radky = poradi.map(k => {
    const h = hm[k] ?? {};
    const stats = rd.liga
      ? (() => { const t = ligaTabulka(hm, rd.liga, turnajHraciList()).find(r => r.key === k); return t ? `${t.vyhry} V · ${t.remizy} R · ${t.prohry} P · ${t.aux} pom. bodů` : ""; })()
      : `${h.prohry ?? 0} proher`;
    return `<tr class="${S.me && k === S.me.key ? "ja" : ""}"><td class="poradi-b">${medal(h.poradi ?? "–")}</td><td>${esc(h.jmeno ?? k)}</td><td class="t-soft">${stats}</td></tr>`;
  }).join("");
  kont.innerHTML = `
    <div class="konec-hero">
      <div class="confetti"><i></i><i></i><i></i><i></i><i></i></div>
      <img class="trofej-img" src="assets/trophy.png" alt="Vítězný pohár" width="200" height="200">
      <h2>Vítěz turnaje: ${vitez ? esc(jmeno(vitez)) : "–"}</h2>
      <p class="t-soft">${modTxt} • ${turnajHraciList().length} hráčů</p>
    </div>
    <table class="tabulka"><thead><tr><th>Umístění</th><th>Hráč</th><th>Statistika</th></tr></thead><tbody>${radky}</tbody></table>
    <div class="konec-actions">
      <button class="btn btn-secondary" data-go-prehled>📋 Zobrazit průběh</button>
      ${jsemHost() ? `<button class="btn btn-danger" data-reset>▶ Nové kolo (vrátit lobby)</button>` : `<span class="t-soft" style="align-self:center;font-size:.82rem">Na nové kolo čekáme na hosta 👑</span>`}
    </div>`;
}
$("#screen-konec").addEventListener("click", e => {
  if (e.target.closest("[data-go-prehled]")) { S.screen = "prehled"; render(); }
  if (e.target.closest("[data-reset]")) resetTurnaje(false);
});

// ============================ RESET ========================================
// Pouze host. Po dohraném turnaji stačí jedno potvrzení (nic se netratí –
// výsledky jsou už hotové). Uprostřed rozehraného turnaje ("předčasné"
// ukončení, jePredcasne=true) je to destruktivní akce, která zahodí rozehrané
// zápasy – proto host musí projít DVĚMA potvrzeními za sebou.
// Statistiky se vynulují, zápasy se smažou (po dávkách – writeBatch limit 500).
async function resetTurnaje(jePredcasne) {
  if (!jsemHost()) { setStatus(jePredcasne ? "Ukončit turnaj může jen host." : "Spustit nové kolo může jen host."); return; }

  if (jePredcasne) {
    const ok1 = await confirmDialog(
      "Ukončit probíhající turnaj?",
      "Turnaj ještě neskončil – rozehrané zápasy i dosavadní výsledky se nenávratně ztratí a všichni se vrátí do lobby. Fakt to chceš udělat?",
      "Ano, ukončit"
    );
    if (!ok1) return;
    const ok2 = await confirmDialog(
      "Opravdu, opravdu?",
      "Poslední kontrola – tohle už nejde vzít zpět. Ukončit rozehraný turnaj?",
      "Ano, jsem si jistý/á"
    );
    if (!ok2) return;
  } else {
    const ok = await confirmDialog(
      "Nové kolo?",
      "Vymaže se průběh dohraného turnaje a všichni se vrátí do lobby. Nastavení zůstane zachované. Pokračovat?",
      "Vymazat a vrátit lobby"
    );
    if (!ok) return;
  }

  setStatus(jePredcasne ? "Ukončuji turnaj…" : "Připravuji nové kolo…");
  try {
    // 1) smazat všechny dokumenty zápasů (po dávkách – writeBatch limit 500)
    const snap = await getDocs(ZAPASY_COL);
    const davky = [];
    let batch = writeBatch(db), n = 0;
    snap.forEach(d => {
      batch.delete(d.ref);
      if (++n === 400) { davky.push(batch); batch = writeBatch(db); n = 0; }
    });
    if (n > 0) davky.push(batch);
    await Promise.all(davky.map(b => b.commit()));

    // 2) vrátit místnost do lobby; hráči zůstávají, statistiky se vynulují.
    //    Pavouk/liga/vítěz se "vynulují" přes null – kód všude pracuje s
    //    `?? []` / `?.`, takže null je bezpečná "prázdná" hodnota.
    const hm = hraciMap();
    const hraciReset = {};
    Object.entries(hm).forEach(([k, h]) => { hraciReset[k] = { ...h, prohry: 0, poradi: null }; });
    await setDoc(ROOM_REF, {
      fase: "lobby",
      vitez: null,
      pavouk: null,
      liga: null,
      turnajHraci: null,
      hraci: hraciReset
    }, { merge: true });

    // 3) vyčistit lokální stav klienta (aby se UI vrátilo do lobby a toasty
    //    mohly znovu reagovat na další spuštění turnaje).
    //    Render necháme na nejbližším snapshotu – on přepne obrazovky sám.
    S.viewMatchId = null;
    S.lastAutoOpen = null;
    S.screen = "lobby";
    posledniFase = null;
    lobbyKey = "";
    divakToastUtan = false;
    setStatus(jePredcasne ? "Turnaj ukončen – lobby je zpátky." : "Lobby je zpátky – můžeš spustit nové kolo.");
  } catch (e) {
    setStatus("Nepovedlo se to: " + e.message);
  }
}
