// gomoku.js – čistá logika hry, bez Firebase a bez DOM.
// Deska se NEUKLÁDÁ – rekonstruuje se ze seznamu tahů (jednoduchý zdroj pravdy,
// historie tahů zdarma, menší dokumenty).
//
// DŮLEŽITÉ: tah i buňky výherní řady se ukládají jako objekty {r, c}, NE jako
// pole [r, c]. Firestore nepodporuje pole polí ("nested arrays") jako hodnotu
// pole dokumentu – pole objektů ale bez problému ano.

// 0 = prázdné, 1 = ✕ (hráč hraci[0]), 2 = ◯ (hráč hraci[1])
export function postavDesku(velikost, tahy) {
  const d = Array.from({ length: velikost }, () => new Array(velikost).fill(0));
  (tahy ?? []).forEach((t, i) => { const r = t.r, c = t.c; if (d[r] && d[r][c] !== undefined) d[r][c] = (i % 2) + 1; });
  return d;
}

// Vítězná řada vznikne vždy ta, která obsahuje POSLEDNÍ položený kámen
// (před tímto tahem výhra neexistovala) – stačí kontrolovat 4 směry
// od posledního tahu. Vrací pole buněk {r,c} řady (pro zvýraznění) nebo null.
export function vyherniRada(deska, r, c, delkaRady) {
  const val = deska[r]?.[c];
  if (!val) return null;
  const n = deska.length;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    const bunky = [{ r, c }];
    for (const smer of [1, -1]) {
      let rr = r + dr * smer, cc = c + dc * smer;
      while (rr >= 0 && rr < n && cc >= 0 && cc < n && deska[rr][cc] === val) {
        bunky.push({ r: rr, c: cc });
        rr += dr * smer; cc += dc * smer;
      }
    }
    if (bunky.length >= delkaRady) return bunky;
  }
  return null;
}

// Souřadnice tahu pro historii: sloupce A…Y, řádky 1…25.
export function souradnice(r, c) {
  return String.fromCharCode(65 + c) + (r + 1);
}
