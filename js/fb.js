// fb.js – inicializace Firebase + odhad serverového času.
// Firestore neumí nativně "kolik je na serveru", ale hodiny hráčů musí být
// ukotvené k serveru (anti-drift/cheating). Proto si každý klient odhaduje
// odchylku svých hodin vůči serveru (NTP-style) z odezvy svých zápisů
// (heartbeat) – serverTimestamp se zapíše, v odpovědi se vrátí vyřešená
// hodnota a z rozdílu časů odečtu polovinu RTT.
import { firebaseConfig } from "../firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, doc, collection, onSnapshot, setDoc,
  runTransaction, getDocs, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export { doc, collection, onSnapshot, setDoc, runTransaction, getDocs, writeBatch, serverTimestamp };

// Jedna jediná "místnost" – singleton dokument pro celý stav turnaje.
export const ROOM_REF = doc(db, "turnaj", "room");
// Subkolekce zápasy (jeden dokument = jeden zápas).
export const ZAPASY_COL = collection(db, "turnaj", "room", "zapasy");
// Subkolekce presence – heartbeaty. ÚMYSELNĚ mimo room dokument:
// Firestore doporučuje max ~1 zápis/s na dokument; 30 hráčů × heartbeat
// by jediný dokument místnosti přetížilo a zápisy by se ztrácely.
export const PRITOMNOST_COL = collection(db, "turnaj", "room", "pritomnost");
export const zapasRef = (id) => doc(db, "turnaj", "room", "zapasy", id);
export const pritomnostRef = (key) => doc(db, "turnaj", "room", "pritomnost", key);

// ---------- odhad serverového času ----------
let _offset = 0;           // serverNow − localNow (ms)
let _kalibrovano = false;
export function nowServer() { return Date.now() + _offset; }
export function jeKalibrovano() { return _kalibrovano; }
export function kalibrujOffset(zadanoLocal, doraziloLocal, serverTsMs) {
  const rtt = doraziloLocal - zadanoLocal;
  if (rtt < 0 || rtt > 20000) return;               // rozumná pojistka
  const o = serverTsMs - (zadanoLocal + rtt / 2);   // NTP odhad
  if (Math.abs(o) < 10 * 60 * 1000) { _offset = o; _kalibrovano = true; }
}
// Bezpečné přečtení millis z Firestore Timestamp (nebo null).
export function tsMs(ts) {
  if (ts && typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts === "number") return ts;
  return null;
}
