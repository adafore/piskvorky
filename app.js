import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  doc,
  onSnapshot,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const statusEl = document.getElementById("status");

// ---------- Definice rozvržení ----------
// Fyzika: vlevo nahoře učitel, pod ním blok lavic po 4 židlích (5 řad),
// vpravo od něj blok lavic po 3 židlích (5 řad).
function buildFyzika() {
  const left = document.getElementById("f-block-left");
  const right = document.getElementById("f-block-right");
  left.innerHTML = "";
  right.innerHTML = "";

  for (let row = 0; row < 5; row++) {
    left.appendChild(makeBench("f-L", row, 4));
    right.appendChild(makeBench("f-R", row, 3));
  }
}

// Normal: 5 řad, v každé řadě 3 lavice po 2 židlích (6 židlí na řadu).
function buildNormal() {
  const grid = document.getElementById("n-grid");
  grid.innerHTML = "";

  for (let row = 0; row < 5; row++) {
    const rowEl = document.createElement("div");
    rowEl.className = "normal-row";
    for (let bench = 0; bench < 3; bench++) {
      rowEl.appendChild(makeBench(`n-r${row}`, bench, 2));
    }
    grid.appendChild(rowEl);
  }
}

function makeBench(prefix, rowIndex, count) {
  const bench = document.createElement("div");
  bench.className = "bench";
  for (let c = 0; c < count; c++) {
    const id = `${prefix}-r${rowIndex}-c${c}`;
    bench.appendChild(makeSeat(id));
  }
  return bench;
}

function makeSeat(id) {
  const seat = document.createElement("div");
  seat.className = "seat";
  seat.dataset.id = id;
  seat.innerHTML = `<span class="seat-name"></span>`;
  seat.addEventListener("click", () => onSeatClick(id));
  seatElements[id] = seat;
  return seat;
}

buildFyzika();
buildNormal();

// teacher seat click
document
  .querySelector('[data-id="f-teacher"]')
  .addEventListener("click", () => onSeatClick("f-teacher"));
seatElementsRegisterTeacher();

function seatElementsRegisterTeacher() {
  seatElements["f-teacher"] = document.querySelector('[data-id="f-teacher"]');
}

// ---------- Přepínání tříd ----------
const btnFyzika = document.getElementById("btn-fyzika");
const btnNormal = document.getElementById("btn-normal");
const layoutFyzika = document.getElementById("layout-fyzika");
const layoutNormal = document.getElementById("layout-normal");

let currentClass = "fyzika";

btnFyzika.addEventListener("click", () => switchClass("fyzika"));
btnNormal.addEventListener("click", () => switchClass("normal"));

function switchClass(name) {
  currentClass = name;
  btnFyzika.classList.toggle("active", name === "fyzika");
  btnNormal.classList.toggle("active", name === "normal");
  layoutFyzika.classList.toggle("hidden", name !== "fyzika");
  layoutNormal.classList.toggle("hidden", name !== "normal");
  subscribeToClass(name);
}

// ---------- Firestore napojení ----------
// Struktura: kolekce "classrooms", dokument "fyzika" / "normal",
// pole "seats" je mapa { seatId: jméno }
const seatElements = {};
let unsubscribe = null;

function subscribeToClass(name) {
  if (unsubscribe) unsubscribe();
  const ref = doc(db, "classrooms", name);
  unsubscribe = onSnapshot(
    ref,
    (snap) => {
      const data = snap.exists() ? snap.data() : { seats: {} };
      renderSeats(name, data.seats || {});
      setStatus("Připojeno");
    },
    (err) => {
      console.error(err);
      setStatus("Chyba připojení k Firebase: " + err.message);
    }
  );
}

function renderSeats(className, seats) {
  // vyčistit jen prvky patřící aktuální třídě (prefix f- nebo n-)
  const prefix = className === "fyzika" ? "f-" : "n-";
  Object.entries(seatElements).forEach(([id, el]) => {
    if (!id.startsWith(prefix)) return;
    const name = seats[id] || "";
    el.classList.toggle("filled", !!name);
    const nameEl = el.querySelector(".seat-name");
    if (nameEl) nameEl.textContent = name;
  });
}

async function onSeatClick(id) {
  const el = seatElements[id];
  const current = el.querySelector(".seat-name")?.textContent || "";
  const name = prompt("Tvoje jméno na tuto židli:", current);
  if (name === null) return; // zrušeno

  const trimmed = name.trim();
  const ref = doc(db, "classrooms", currentClass);

  try {
    setStatus("Ukládám...");
    await setDoc(
      ref,
      { seats: { [id]: trimmed } },
      { merge: true }
    );
    setStatus("Uloženo");
  } catch (err) {
    console.error(err);
    setStatus("Chyba při ukládání: " + err.message);
  }
}

function setStatus(text) {
  statusEl.textContent = text;
  clearTimeout(setStatus._t);
  setStatus._t = setTimeout(() => (statusEl.textContent = ""), 2500);
}

// spustit
switchClass("fyzika");
