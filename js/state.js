// state.js – sdílený stav klienta + odvozené informace (kdo je host, online…).
// Drží se mimo app.js/matchview.js, aby se moduly cyklicky neimportovaly.
import { nowServer, tsMs } from "./fb.js";
import { normalizeName, HOST_PRIORITY, ONLINE_LIMIT_MS } from "./util.js";

export const S = {
  me: null,                 // { key, jmeno } po připojení
  room: null,               // poslední snapshot /turnaj/room
  zapasy: new Map(),        // id -> data zápasu (subkolekce zapasy)
  pritomnost: new Map(),    // key -> { posledniVideni, ... }
  screen: "vstup",          // vstup | lobby | prehled | hra | konec
  viewMatchId: null,        // právě otevřený zápas (hráč i divák)
  lastAutoOpen: null        // abychom auto-otevření vlastního zápasu nespamovali
};

export const hraciMap = () => S.room?.hraci ?? {};
export const jmeno = (key) => hraciMap()[key]?.jmeno ?? key;
export const turnajHraciList = () => S.room?.turnajHraci ?? [];
export const jeTurnajovyHrac = (key) => turnajHraciList().includes(key);

export function jeOnline(key) {
  const p = S.pritomnost.get(key);
  if (!p) return false;
  const ts = tsMs(p.posledniVideni);
  if (ts == null) return false;
  return (nowServer() - ts) < ONLINE_LIMIT_MS;
}

// ---------------------------------------------------------------------------
// HOST – určování hostitele.
// Pravidla (viz zadání):
//  1) hráč s prioritním jménem (normalizeName ∈ HOST_PRIORITY) má přednost,
//  2) jinak první připojený ONLINE hráč,
//  3) ve fázi "running"/"finished" je host zamčený (hostKey se nemění),
//     aby se za běhu nerozhodilo nastavení.
// Hostiteli "stačí odejít" (jít offline) a v lobby se host přepočítá –
// to odpovídá "opustil lobby před spuštěním turnaje".
// ---------------------------------------------------------------------------
export function hostKeyVypocet() {
  const list = Object.values(hraciMap()).filter(h => jeOnline(h.key));
  if (!list.length) return null;
  const priorita = list.filter(h => HOST_PRIORITY.includes(normalizeName(h.jmeno)));
  const kandidati = priorita.length ? priorita : list;
  kandidati.sort((a, b) => (tsMs(a.pridano) ?? 0) - (tsMs(b.pridano) ?? 0));
  return kandidati[0].key;
}

export function aktualniHostKey() {
  if (!S.room) return null;
  if ((S.room.fase ?? "lobby") !== "lobby") return S.room.hostKey ?? null; // zamčeno
  return hostKeyVypocet() ?? S.room.hostKey ?? null;
}

export function jsemHost() { return !!S.me && aktualniHostKey() === S.me.key; }

// ID aktuálně běžícího zápasu přihlášeného hráče (podle zrcadel v room).
export function mujAktivniZapas() {
  if (!S.me || !S.room || (S.room.fase ?? "lobby") !== "running") return null;
  const zs = [...(S.room.pavouk?.zapasy ?? []), ...(S.room.liga?.zapasy ?? [])];
  const z = zs.find(z => z.stav === "probiha" && (z.hraci ?? []).includes(S.me.key));
  return z ? (z.zapasId ?? z.id) : null;
}
