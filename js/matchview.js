// matchview.js – vykreslení herní obrazovky (hráč i divák/spectator)
// + průběžná aktualizace hodin a varování (tik po ~300 ms, bez re-renderu).
import { S, jmeno, jeOnline } from "./state.js";
import { nowServer, tsMs } from "./fb.js";
import { postavDesku, souradnice } from "./gomoku.js";
import { esc, fmtCas, ONLINE_LIMIT_MS, ODPOJ_GRACE_MS } from "./util.js";

// Zbývající čas hráče idx v zápase md (v sekundách).
// Jádro anti-drift logiky: čas je ukotven k serverovému timestampu
// (tahZahajen) + bance času; běží tedy i tehdy, když hráč aplikaci zavře.
export function zbyvaHrace(md, idx) {
  const banka = idx === 0 ? md.zbyva1 : md.zbyva2;
  if (md.stav !== "probiha") return banka ?? 0; // po konci: zmražená finální čísla
  if (md.naTahu !== md.hraci?.[idx]) return banka ?? 0;
  const start = tsMs(md.tahZahajen);
  if (start == null) return banka ?? 0;
  return Math.max(0, (banka ?? 0) - (nowServer() - start) / 1000);
}

function duvodText(d) {
  return { rada: "vítězná řada", cas: "vypršel čas", kontumace: "kontumace", remiza: "remíza", bye: "volno" }[d] ?? "";
}

export function renderHru() {
  const kont = document.getElementById("screen-hra");
  const md = S.viewMatchId ? S.zapasy.get(S.viewMatchId) : null;
  if (!md || !S.me) {
    kont.innerHTML = `<div class="game-missing" style="text-align:center;padding:30px">
      <p class="t-soft">Zápas není k dispozici.</p>
      <button class="btn btn-secondary" data-back>Zpět na přehled</button></div>`;
    return;
  }
  const jsemHrac = (md.hraci ?? []).includes(S.me.key);
  const naTahuJsem = md.stav === "probiha" && md.naTahu === S.me.key;
  // Rebuild jen při strukturální změně (tahy / stav / vítěz / moje šance táhnout).
  const klic = `${md.id}|${md.tahy.length}|${md.stav}|${md.vitez ?? ""}|${naTahuJsem}|${md.popis ?? ""}`;
  if (kont.dataset.postaveno !== klic) {
    kont.dataset.postaveno = klic;
    kont.innerHTML = htmlHry(md, jsemHrac, naTahuJsem);
  }
  updateClocks();
}

function htmlHry(md, jsemHrac, naTahuJsem) {
  const karta = (idx) => {
    const k = md.hraci?.[idx];
    if (!k) return `<div class="player-card"><span class="t-soft">čeká…</span></div>`;
    const aktivni = md.stav === "probiha" && md.naTahu === k;
    return `<div class="player-card pc-${idx === 0 ? "x" : "o"} ${aktivni ? "active" : ""}">
      <span class="sym sym-${idx === 0 ? "x" : "o"}"></span>
      <span class="pc-name">${esc(jmeno(k))}${S.me && k === S.me.key ? ' <span class="chip-ty">ty</span>' : ""}<span class="badge-offline" data-offline="${md.id}|${idx}"></span></span>
      <span class="clock" data-clock="${md.id}|${idx}">–:––</span>
    </div>`;
  };

  let status;
  if (md.stav === "ceka") {
    status = `<div class="game-note t-soft">⏳ Čeká na vyplnění pavouka…</div>`;
  } else if (md.stav === "hotovo") {
    if (md.duvodKonec === "remiza") {
      status = `<div class="result-banner remiza">🤝 <b>Remíza</b> – deska je plná a nikdo nemá řadu. Hraje se <b>odveta</b> s prohozenými barvami!</div>`;
    } else if (md.duvodKonec === "bye") {
      status = `<div class="result-banner">😴 Volno (bye) – bez soupeře se nepostupuje hrou.</div>`;
    } else if (md.vitez) {
      const doplnek = md.duvodKonec === "rada" ? ` (${md.delkaRady} v řadě)` : "";
      status = `<div class="result-banner">🏆 <b>${esc(jmeno(md.vitez))}</b> vyhrává – ${duvodText(md.duvodKonec)}${doplnek}.</div>`;
    } else {
      status = `<div class="result-banner">Zápas skončil.</div>`;
    }
  } else {
    status = `<div class="game-note" data-turn="${md.id}"></div><div class="warn" data-warn="${md.id}"></div>`;
  }

  // Deska – rekonstruovaná ze seznamu tahů.
  const deska = postavDesku(md.velikostPole, md.tahy);
  const posledni = md.tahy[md.tahy.length - 1];
  const winSet = new Set((md.viteznaRada ?? []).map(([r, c]) => r + "," + c));
  let cells = "";
  for (let r = 0; r < md.velikostPole; r++) {
    for (let c = 0; c < md.velikostPole; c++) {
      const v = deska[r][c];
      let cls = "cell";
      if (v === 1) cls += " s1"; else if (v === 2) cls += " s2";
      if (posledni && posledni[0] === r && posledni[1] === c) cls += " last";
      if (winSet.has(r + "," + c)) cls += " win";
      cells += `<div class="${cls}" data-r="${r}" data-c="${c}"></div>`;
    }
  }

  const hist = md.tahy.map((t, i) =>
    `${i + 1}. <span class="${i % 2 ? "ho" : "hx"}">${i % 2 ? "◯" : "✕"}</span> ${souradnice(t[0], t[1])}`
  ).join("<br>");

  return `
    <div class="game-top">
      <button class="btn btn-ghost" data-back>⟵ Přehled</button>
      <span class="game-popis">${esc(md.popis ?? "")}</span>
    </div>
    <div class="players-row">${karta(0)}<div class="vs">vs</div>${karta(1)}</div>
    ${status}
    <div class="board-wrap">
      <div class="board ${naTahuJsem ? "playable" : ""}" style="--n:${md.velikostPole}">${cells}</div>
    </div>
    ${!jsemHrac && md.stav === "probiha" ? `<div class="spectator-note">👁 Sleduješ jako divák – tahy vidíš v reálném čase.</div>` : ""}
    <details class="historie">
      <summary>Historie tahů (${md.tahy.length})</summary>
      <div class="historie-list">${hist || "<span class='t-soft'>Zatím žádné tahy.</span>"}</div>
    </details>`;
}

// Průběžná aktualizace všech dynamických textů (voláno tikáním z app.js).
export function updateClocks() {
  document.querySelectorAll("[data-clock]").forEach(el => {
    const [id, idxS] = el.dataset.clock.split("|");
    const md = S.zapasy.get(id);
    if (!md || !md.hraci?.[+idxS]) { if (!el.textContent) el.textContent = "–:––"; return; }
    const idx = +idxS;
    const s = zbyvaHrace(md, idx);
    el.textContent = fmtCas(s);
    const card = el.closest(".player-card");
    if (card) {
      card.classList.toggle("low", md.stav === "probiha" && s < 60);
      card.classList.toggle("critical", md.stav === "probiha" && md.naTahu === md.hraci[idx] && s <= 15);
    }
  });
  document.querySelectorAll("[data-offline]").forEach(el => {
    const [id, idxS] = el.dataset.offline.split("|");
    const k = S.zapasy.get(id)?.hraci?.[+idxS];
    el.textContent = k && !jeOnline(k) ? "· offline" : "";
  });
  document.querySelectorAll("[data-turn]").forEach(el => {
    const md = S.zapasy.get(el.dataset.turn);
    if (!md || md.stav !== "probiha" || !md.naTahu || !md.hraci?.includes(md.naTahu)) { el.textContent = ""; return; }
    const sym = md.naTahu === md.hraci[0] ? '<span class="hx">✕</span>' : '<span class="ho">◯</span>';
    el.innerHTML = `Na tahu: ${sym} <b>${esc(jmeno(md.naTahu))}</b>`;
  });
  // Odpojovací varování: odpojený hráč má 2 minuty na návrat (kontumace).
  // Pokud jsou offline oba, ukážeme toho, kdo je offline déle (ten prohraje
  // dřív) – stejná priorita jako v pasivním monitoru v app.js.
  document.querySelectorAll("[data-warn]").forEach(el => {
    const md = S.zapasy.get(el.dataset.warn);
    if (!md || md.stav !== "probiha") { el.textContent = ""; return; }
    const now = nowServer();
    let nejhorsi = null;
    for (const k of md.hraci ?? []) {
      const ts = tsMs(S.pritomnost.get(k)?.posledniVideni);
      if (ts == null) continue;
      const offlineS = (now - ts) / 1000;
      if (offlineS > ONLINE_LIMIT_MS / 1000 && (!nejhorsi || offlineS > nejhorsi.offlineS)) {
        nejhorsi = { k, offlineS };
      }
    }
    if (!nejhorsi) { el.textContent = ""; return; }
    const zb = Math.max(0, (ONLINE_LIMIT_MS + ODPOJ_GRACE_MS) / 1000 - nejhorsi.offlineS);
    el.textContent = `⏳ ${jmeno(nejhorsi.k)} je offline – pokud se do ${fmtCas(zb)} nevrátí, prohraje kontumačně.`;
  });
}
