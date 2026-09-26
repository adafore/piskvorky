// scheduling.js – generování a posun turnajových struktur.
// Všechny funkce jsou čisté ("nad daty z room dokumentu") a volají se uvnitř
// Firestore transakcí – díky serializaci transakcí jsou výsledky idempotentní
// a bezpečné i při současném pokusu více klientů.

import { shuffle } from "./util.js";

// ==========================================================================
// PAVOUK – 1 ŽIVOT (klasický vyřazovací strom)
// ==========================================================================
export function dalsiPow2(n) { let s = 2; while (s < n) s *= 2; return s; }

// Postaví kompletní strom: velikost = nejbližší vyšší mocnina dvojky,
// chybějící místa = "BYE" (volno). Hráči jsou náhodně rozlosováni (los).
export function postavStrom(keys) {
  const velikost = dalsiPow2(Math.max(2, keys.length));
  const pocetKol = Math.round(Math.log2(velikost));
  const dosazeni = shuffle([...keys]);
  const zapasy = [];
  for (let k = 0; k < pocetKol; k++) {
    const pocet = velikost >> (k + 1);
    for (let i = 0; i < pocet; i++) {
      const uzel = {
        id: `s${k}-${i}`, zapasId: `s${k}-${i}`, kolo: k, idx: i,
        finale: k === pocetKol - 1,
        slotA: null, slotB: null, vitez: null, duvod: null,
        stav: "ceka", hraci: null, odvet: 0
      };
      if (k === 0) {
        uzel.slotA = dosazeni[2 * i] ?? "BYE";
        uzel.slotB = dosazeni[2 * i + 1] ?? "BYE";
      }
      zapasy.push(uzel);
    }
  }
  return { velikost, zapasy };
}

// Vítěz uzlu postupuje do rodičovského zápasu (výše o kolo, index/2).
export function propagateStrom(strom, uzel) {
  if (uzel.finale) return;
  const rodic = strom.zapasy.find(u => u.kolo === uzel.kolo + 1 && u.idx === Math.floor(uzel.idx / 2));
  if (!rodic) return;
  if (uzel.idx % 2 === 0) rodic.slotA = uzel.vitez; else rodic.slotB = uzel.vitez;
}

// Projde strom (kola vzestupně => jedna průchod stačí, kaskáda volných kol
// se vyřeší průběžně):
//  - zápas s oběma reálnými hráči a stavem "ceka" => spustit (start hodin),
//  - zápas s BYE => rozhodnout bez hry (postupuje reálný hráč; při dvou
//    BYE postupuje "BYE" dál – to se stává u malých turnajů, např. 3 hráči
//    na stromu 4).
// Vrací { spustit, vyresene } – seznam uzlů, u kterých má volající transakce
// zapsat/spustit match dokument.
export function projdiStrom(strom) {
  const spustit = [], vyresene = [];
  for (const u of strom.zapasy) {
    if (u.vitez) continue;
    if (u.slotA == null || u.slotB == null) continue;
    const aBye = u.slotA === "BYE", bBye = u.slotB === "BYE";
    if (aBye || bBye) {
      u.vitez = aBye && bBye ? "BYE" : (aBye ? u.slotB : u.slotA);
      u.duvod = "bye"; u.stav = "hotovo";
      u.hraci = aBye && bBye ? null : [aBye ? u.slotB : u.slotA, null];
      vyresene.push(u);
      propagateStrom(strom, u);
    } else if (u.stav === "ceka") {
      u.stav = "probiha"; u.hraci = [u.slotA, u.slotB];
      spustit.push(u);
    }
  }
  return { spustit, vyresene };
}

// ==========================================================================
// PAVOUK – 3 ŽIVOTY (triple elimination, dynamické párování)
// ---------------------------------------------------------------------------
// Rozhodnutí: místo předpočítaného "trojitého" stromu (jehož správná
// konstrukce je notoricky složitá u lichých počtů a volných kol) používám
// osvědčený formát "3 životy / 3 strikes":
//  - hráč s 3. prohrou vypadává,
//  - po každém skončení zápasu se přešledují VŠECHNI volní hráči a spárují:
//      a) nejdřív ve skupinách se stejným počtem proher (hlavní/dolní pavouk),
//      b) jednotlivci bez partnera ze sousedních skupin (dolní pavouk
//         "vtéká" do vyššího – klasické chování),
//      c) čeká hráč s nejméně prohrami (vítěz hlavního pavouka čeká,
//         až se dohraje spodek – to je v pavouku nevyhnutelné),
//  - poslední dva hráči hrají GRANDFINÁLE – sérii zápasů, dokud jeden
//    z nich nezíská třetí prohru (přesná semantika "3 životů", obdoba
//    bracket resetu klasického triple elimination; sérii je ohraničená).
// Hlavní přínos oproti pevnému stromu: zápasy běží souběžně kde to jde
// (požadavek zadání: vítězové nesmí zbytečně čekat) a formát funguje
// pro libovolný počet hráčů včetně 2.
// ==========================================================================
export function naplanujZivoty(pavouk, hraciMap, turnajHraci) {
  const nove = [];
  const aktivni = new Set(pavouk.zapasy.filter(z => z.stav === "probiha").flatMap(z => z.hraci ?? []));
  const zivi = nazivu(hraciMap, turnajHraci);
  const volni = zivi.filter(k => !aktivni.has(k));
  if (volni.length < 2) return nove;

  // Deterministické ID (proti duplicitám při souběžných transakcích).
  const mk = (a, b, vetev) => {
    pavouk.vlna++;
    nove.push({ id: `z${pavouk.vlna}-${[a, b].sort().join("x")}`, kolo: pavouk.vlna, vetev, hraci: [a, b], vitez: null, duvod: null, stav: "probiha" });
  };

  // Grandfinále: poslední dva hráči turnaje.
  if (zivi.length === 2) { mk(volni[0], volni[1], "finale"); return nove; }

  // Skupiny podle počtu proher.
  const skupiny = new Map();
  for (const k of volni) {
    const p = hraciMap[k]?.prohry ?? 0;
    if (!skupiny.has(p)) skupiny.set(p, []);
    skupiny.get(p).push(k);
  }
  const jednotlivci = [];
  for (const p of [...skupiny.keys()].sort((a, b) => a - b)) {
    const g = shuffle(skupiny.get(p));
    while (g.length >= 2) mk(g.pop(), g.pop(), vetevZProher(p));
    if (g.length === 1) jednotlivci.push({ k: g[0], p });
  }
  // Jednotlivci: párují se jen sousední skupiny (0↔1, 1↔2); nikdy 0↔2,
  // aby vítěz hlavního pavouka "neplaval" hned do spodku.
  jednotlivci.sort((a, b) => b.p - a.p);
  for (let i = 0; i + 1 < jednotlivci.length; i += 2) {
    const x = jednotlivci[i], y = jednotlivci[i + 1];
    if (Math.abs(x.p - y.p) <= 1) mk(x.k, y.k, vetevZProher(Math.max(x.p, y.p)));
  }
  // Pojistka proti uváznutí (teoreticky nemá nastat, ale turnaj se nesmí
  // zastavit): pokud nikdo nehraje a nikdo se nedá spárovat, spáruj dva
  // hráče s nejvíce prohrami.
  if (!nove.length && aktivni.size === 0 && volni.length >= 2) {
    const s = [...volni].sort((a, b) => (hraciMap[b]?.prohry ?? 0) - (hraciMap[a]?.prohry ?? 0));
    mk(s[0], s[1], vetevZProher(hraciMap[s[0]]?.prohry ?? 0));
  }
  return nove;
}

function vetevZProher(p) { return p <= 0 ? "hlavni" : p === 1 ? "dolni1" : "dolni2"; }

// ==========================================================================
// LIGA – kruhový (Bergerův) rozpis
// ---------------------------------------------------------------------------
// Páry se předpočítají pro celý turnaj (rotace s fixním prvním hráčem),
// kola se hrají postupně (zápasy v rámci kola souběžně). Při lichém počtu
// hráčů se přidá fiktivní "null" – hráč, který na něj narazí, má dané kolo
// VOLNO: nehraje a nedostává ani výhru, ani prohru (řešení "bye" ze zadání).
// Požadovaný počet kol se omezí na maximum dané počtem hráčů.
// ==========================================================================
export function postavLigu(keys, pozadovanaKola) {
  const maxKol = keys.length % 2 === 1 ? keys.length : keys.length - 1;
  const pocetKol = Math.max(1, Math.min(pozadovanaKola, maxKol));
  const arr = shuffle([...keys]);
  if (arr.length % 2 === 1) arr.push(null); // fiktivní "volno"
  const n = arr.length;
  const rozpis = [], volna = {};
  for (let r = 0; r < n - 1; r++) {
    const dvojice = [];
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a == null && b != null) (volna[b] ??= []).push(r);
      else if (b == null && a != null) (volna[a] ??= []).push(r);
      else if (a != null && b != null) dvojice.push([a, b]);
    }
    rozpis.push(dvojice);
    arr.splice(1, 0, arr.pop()); // rotace ostatních
  }
  const zapasy = [];
  rozpis.slice(0, pocetKol).forEach((dvojice, k) =>
    dvojice.forEach(([a, b], i) => zapasy.push({
      id: `l${k}-${i}`, kolo: k, vetev: "liga", hraci: [a, b],
      vitez: null, duvod: null, stav: "ceka", auxA: 0, auxB: 0
    })));
  // POZOR: "rozpis" (pole polí dvojic) se záměrně NEVRACÍ – Firestore
  // nepodporuje pole polí ("nested arrays") jako hodnotu pole dokumentu.
  // Počet kol se dál nese jako prosté číslo (pocetKol), páry jsou už i tak
  // rozepsané do zapasy[].hraci (plochá pole stringů, to Firestore vadit nebude).
  return { pocetKol, zapasy, volna, aktivniKolo: 0 };
}

// ==========================================================================
// LIGA – tabulka a tiebreak
// ==========================================================================
// Tabulka se počítá průběžně ze zrcadlích záznamů zápasů (jeden zdroj pravdy).
// Pořadí: výhry ↓, remízy ↓, pomocné body ↓, jméno ↑.
export function ligaTabulka(hraciMap, liga, turnajHraci) {
  const tab = new Map((turnajHraci ?? []).map(k => [k, { key: k, jmeno: hraciMap[k]?.jmeno ?? k, vyhry: 0, remizy: 0, prohry: 0, aux: 0, odehrano: 0 }]));
  for (const z of liga.zapasy ?? []) {
    if (z.stav !== "hotovo") continue;
    const [a, b] = z.hraci ?? [];
    const ra = tab.get(a), rb = tab.get(b);
    if (!ra || !rb) continue;
    ra.odehrano++; rb.odehrano++;
    ra.aux += z.auxA ?? 0; rb.aux += z.auxB ?? 0;
    if (z.vitez == null) { ra.remizy++; rb.remizy++; }
    else if (z.vitez === a) { ra.vyhry++; rb.prohry++; }
    else { rb.vyhry++; ra.prohry++; }
  }
  return [...tab.values()].sort((x, y) =>
    y.vyhry - x.vyhry || y.remizy - x.remizy || y.aux - x.aux || x.jmeno.localeCompare(y.jmeno, "cs"));
}

// Pomocné body (tiebreak) – KONKRÉTNÍ VZOREC ze zadání ("rychlá výhra = dobře,
// rychlá prohra = špatně"), založený na zbývajícím čase na hodinách v momentě
// konce zápasu:
//   výhra:   +100 + floor(10 * zbyvaViteze / casNaHrace)      → 100 až 110
//            (čím rychleji vítěz vyhrál, tím víc mu zbylo času → vyšší bonus)
//   prohra:  -50 - floor(50 * zbyvaViteze / casNaHrace)       → -50 až -100
//            (čím rychleji prohrál, tím víc času soupeři zbylo → větší postih)
//   remíza:  +25 pro oba (plná deska bez řady)
//   kontumace: pevně +100 / -100 (čekání na nenastoupivšího soupeře
//            rychlostním bonusem odměňovat nechceme)
export function auxZaZapas(hraciPole, vitez, duvod, zbyvaViteze, casNaHrace) {
  const [a, b] = hraciPole;
  const out = { auxA: 0, auxB: 0 };
  if (duvod === "remiza") { out.auxA = 25; out.auxB = 25; return out; }
  if (vitez == null) return out;
  const vitezIdx = vitez === a ? 0 : 1;
  if (duvod === "kontumace") {
    if (vitezIdx === 0) { out.auxA = 100; out.auxB = -100; } else { out.auxA = -100; out.auxB = 100; }
    return out;
  }
  const podil = Math.max(0, Math.min(1, (zbyvaViteze ?? 0) / (casNaHrace || 1)));
  const w = 100 + Math.floor(10 * podil);
  const l = -50 - Math.floor(50 * podil);
  if (vitezIdx === 0) { out.auxA = w; out.auxB = l; } else { out.auxA = l; out.auxB = w; }
  return out;
}

// Konečné umístění v lize se sdíleným pořadím při shodných statistikách.
export function priradPoradiLize(hraciMap, tabulka) {
  let poradi = 0, predchozi = null;
  tabulka.forEach((r, i) => {
    const klic = `${r.vyhry}/${r.remizy}/${r.aux}`;
    if (klic !== predchozi) { poradi = i + 1; predchozi = klic; }
    if (hraciMap[r.key]) hraciMap[r.key].poradi = poradi;
  });
}

// ==========================================================================
// SPOLEČNÉ
// ==========================================================================
// Umístění vyřazeného hráče = počet dosud neumístěných hráčů (včetně něj).
// Funguje pro pavouk 1 život (první vyřazený = poslední místo) i 3 životy.
export function priradPoradi(hraciMap, key) {
  const neumistenych = Object.values(hraciMap).filter(h => h.poradi == null).length;
  if (hraciMap[key]) hraciMap[key].poradi = neumistenych;
}

export function nazivu(hraciMap, turnajHraci) {
  return (turnajHraci ?? []).filter(k => hraciMap[k] && hraciMap[k].poradi == null);
}

// Továrna na dokument zápasu. Deska se neukládá – rekonstruuje se z tahy[].
// "ceka" = čeká na zaplnění slotů (pavouk/liga), "probiha" = běží hodiny.
export function novyZapasDoc(nast, { id, hraci, kolo, vetev, typ, aktivni }) {
  return {
    id, kolo, vetev,
    popis: popisZapasu(typ, vetev, kolo),
    hraci: hraci ?? [null, null],
    tahy: [],
    naTahu: hraci ? hraci[0] : null,
    tahZahajen: null,
    zbyva1: nast.casNaHrace, zbyva2: nast.casNaHrace,
    stav: aktivni ? "probiha" : "ceka",
    vitez: null, duvodKonec: null, viteznaRada: null,
    zacatek: null, konec: null,
    velikostPole: nast.velikostPole, delkaRady: nast.delkaRady, casNaHrace: nast.casNaHrace
  };
}

export function popisZapasu(typ, vetev, kolo) {
  if (typ === "liga") return `Liga – kolo ${kolo + 1}`;
  if (vetev === "finale") return typ === "strom" ? "Finále" : "Grandfinále";
  if (typ === "strom") return `Kolo ${kolo + 1}`;
  const v = { hlavni: "Hlavní pavouk", dolni1: "Dolní pavouk", dolni2: "Dolní pavouk 2" }[vetev] ?? "";
  return `${v} – zápas ${kolo}`;
}
