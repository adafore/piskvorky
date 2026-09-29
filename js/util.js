// util.js
// util.js – pomocné funkce a konstanty.

// --- časování přítomnosti / odpojení ---
export const HEARTBEAT_MS = 2000;     // jak často klient dává "žiju"
export const ONLINE_LIMIT_MS = 20000; // obecný práh "offline" (zobrazení + báze pro kontumaci v zápase)
// Lhůta na návrat po odpojení v běžícím zápase (zadání: 2 minuty).
// Skutečná kontumace nastane cca 20 s + 120 s od posledního heartbeatu –
// práh 20 s je toleranční rezerva proti výpadkům sítě. DŮLEŽITÉ: tohle platí
// jen pro zápas, co už běží – v lobby (před startem) používáme mnohem
// přísnější LOBBY_KICK_MS níž, a jakmile turnaj běží, hráč se z turnajHraci
// kvůli odpojení NIKDY automaticky neodstraňuje (nejvýš prohraje kontumačně
// svůj aktuální zápas).
export const ODPOJ_GRACE_MS = 120000;
export const CAS_TOLERANCE_S = 1.5;   // tolerance proti nepřesnosti odhadu času při flagu

// V LOBBY (před startem turnaje) je odpojení levná záležitost – po 5 s bez
// heartbeatu hráče rovnou odebereme z místnosti (viz zadání: "ať tam
// nekoukaj lidi, co tam vlastně nejsou"). Díky HEARTBEAT_MS=2000 to jde
// spolehlivě odlišit od normální mezery mezi heartbeaty.
export const LOBBY_KICK_MS = 5000;

// Host může v lobby "vyhodit všechny" a na tuto dobu jim zablokovat
// opětovné připojení (ochrana proti spamu/rušení lobby).
export const BAN_MS = 10 * 60 * 1000;

// Normalizace jména: trim + lowercase + bez diakritiky (NFD rozklad a odstranění
// combining marks) – podle zadání musí porovnání jmen fungovat spolehlivě
// i s diakritikou ("Forejtník" ≡ "Forejtnik").
export function normalizeName(s) {
  return (s || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Klíč hráče do Firestore map – normalizované jméno bez nebezpečných znaků
// pro field path (tečky, lomítka, hranaté závorky…). Zajišťuje taky
// case-/diakritiky-insensitive unikátnost jmen v lobby.
export function nameToKey(s) {
  const n = normalizeName(s).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return n || "hrac-" + Math.abs(hashCode(String(s))).toString(36);
}

// Prioritní jména hostitele (normalizovaná – bez diakritiky, lowercase).
export const HOST_PRIORITY = ["adafore", "adam f", "adam forejtnik", "adafo"];

export function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
  return h;
}

// Escaping uživatelských vstupů do HTML (jména hráčů!).
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 630 → "10:30"
export function fmtCas(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
