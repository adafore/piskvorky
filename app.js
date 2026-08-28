import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore,
  doc,
  onSnapshot,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ---------- Reference na prvky stránky ----------
const statusEl = document.getElementById("status");
const btnFyzika = document.getElementById("btn-fyzika");
const btnNormal = document.getElementById("btn-normal");
const layoutFyzika = document.getElementById("layout-fyzika");
const layoutNormal = document.getElementById("layout-normal");

const modalOverlay = document.getElementById("modal-overlay");
const modalInput = document.getElementById("modal-input");
const modalSave = document.getElementById("modal-save");
const modalCancel = document.getElementById("modal-cancel");
const modalClear = document.getElementById("modal-clear");

// Musí existovat dřív, než se začnou vytvářet židle (jinak se JS zastaví na chybě
// a nic se nevykreslí ani nereaguje na klik).
const seatElements = {};
let currentClass = "fyzika";
let activeSeatId = null;
let unsubscribe = null;

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
  seat.innerHTML = `<span class="seat-icon"></span><span class="seat-name"></span>`;
  seat.addEventListener("click", () => openModal(id));
  seatElements[id] = seat;
  return seat;
}

// vykreslit obě třídy hned na startu
buildFyzika();
buildNormal();

// učitelská židle je napevno v HTML
const teacherSeatEl = document.querySelector('[data-id="f-teacher"]');
teacherSeatEl.addEventListener("click", () => openModal("f-teacher"));
seatElements["f-teacher"] = teacherSeatEl;

// ---------- Přepínání tříd ----------
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
function subscribeToClass(name) {
  if (unsubscribe) unsubscribe();
  const ref = doc(db, "classrooms", name);
  unsubscribe = onSnapshot(
    ref,
    (snap) => {
      const data = snap.exists() ? snap.data() : { seats: {} };
      renderSeats(name, data.seats || {});
    },
    (err) => {
      console.error(err);
      setStatus("Chyba připojení k Firebase: " + err.message);
    }
  );
}

function renderSeats(className, seats) {
  const prefix = className === "fyzika" ? "f-" : "n-";
  Object.entries(seatElements).forEach(([id, el]) => {
    if (!id.startsWith(prefix)) return;
    const name = seats[id] || "";
    el.classList.toggle("filled", !!name);
    const nameEl = el.querySelector(".seat-name");
    if (nameEl) nameEl.textContent = name;
  });
}

// ---------- Modal na zadání jména ----------
function openModal(id) {
  activeSeatId = id;
  const el = seatElements[id];
  const current = el.querySelector(".seat-name")?.textContent || "";
  modalInput.value = current;
  modalOverlay.classList.remove("hidden");
  setTimeout(() => modalInput.focus(), 50);
}

function closeModal() {
  modalOverlay.classList.add("hidden");
  activeSeatId = null;
}

modalCancel.addEventListener("click", closeModal);

modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

document.addEventListener("keydown", (e) => {
  if (modalOverlay.classList.contains("hidden")) return;
  if (e.key === "Escape") closeModal();
  if (e.key === "Enter") saveSeat(modalInput.value);
});

modalSave.addEventListener("click", () => saveSeat(modalInput.value));
modalClear.addEventListener("click", () => saveSeat(""));

async function saveSeat(rawName) {
  if (!activeSeatId) return;
  const id = activeSeatId;
  const trimmed = rawName.trim();
  const ref = doc(db, "classrooms", currentClass);

  closeModal();

  try {
    setStatus("Ukládám...");
    await setDoc(ref, { seats: { [id]: trimmed } }, { merge: true });
    setStatus(trimmed ? "Uloženo" : "Židle uvolněna");
  } catch (err) {
    console.error(err);
    setStatus("Chyba při ukládání: " + err.message);
  }
}

// ---------- Toast se stavem ----------
let statusTimer = null;
function setStatus(text) {
  statusEl.textContent = text;
  statusEl.classList.add("show");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => statusEl.classList.remove("show"), 2000);
}

// spustit
switchClass("fyzika");
