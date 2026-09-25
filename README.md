# Piškvorkový turnaj – hotová verze

Vychází z kódu, který vygenerovalo GLM 5.3 podle zadání (viz `prompt-pro-GLM-piskvorky-turnaj.md`
z předchozí zprávy). Kód jsem prošel, opravil jeden reálný bug, doplnil obrázky
a **automatizovaně otestoval** (viz níže) – je připravený k nasazení.

## Co jsem udělal

- **Poskládal** rozhozený výstup z GLM do skutečné souborové struktury (`index.html`,
  `style.css`, `firebase-config.js`, `js/*.js`, `firestore.rules`).
- **Zapracoval 4 obrázky**, co jsi poslal: oříznuté/zprůhledněné a zmenšené pro web
  (z ~2.6 MB na ~300 KB celkem):
  - `assets/logo.png` + `assets/favicon.png` + `assets/apple-touch-icon.png` – ikonka v hlavičce a favicon (měl bílé pozadí navíc, i když jsi ho generoval s průhledností – ořízl a zprůhlednil jsem)
  - `assets/banner.jpg` – banner na úvodní (vstupní) obrazovce
  - `assets/trophy.png` – pohár na obrazovce konce turnaje (měl skutečnou průhlednost, jen zmenšeno)
  - `assets/bg-grid.jpg` – jemná mřížková textura na pozadí celé appky
- **Otestoval jsem to opravdu v prohlížeči** (Playwright, headless Chromium, žádná
  Firebase potřeba – běželo to proti dočasné napodobenině Firestore, jen pro test):
  - 2 hráči se připojí, hostitel se správně určí podle prioritního jména,
  - host nastaví hru, nehost vidí jen read-only náhled,
  - spuštění turnaje, losování, reálné tahy na desce, detekce výhry, přechod do
    fáze "hotovo", zobrazení vítěze i s pohárem – vše bez jediné JS chyby v konzoli.
  - Zvlášť jsem ověřil **remízu → odvetu** (prohozené barvy, nové hodiny) – tady
    jsem našel a **opravil skutečný bug**: pokud hráč zůstal na obrazovce hry v
    momentě remízy, viděl dál starou/plnou desku místo nové odvety
    (`js/app.js`, funkce `autoOtevriMujZapas`).
  - Logiku plánování (`scheduling.js`) jsem navíc profiltroval stovkami
    simulovaných turnajů (2–17 hráčů) pro pavouk na 1 i 3 životy i pro ligu
    s různým počtem kol – vždy doběhne do konce, součty výher/proher sedí,
    tiebreak vzorec odpovídá zadání.
  - Netestoval jsem naživo časovač na odpojení (2 min) – je to čistě časová
    záležitost, doporučuju si to po nasazení zkusit ručně (odpoj se v rozehraném
    zápase a počkej).

## Nasazení (Firebase)

1. V [Firebase konzoli](https://console.firebase.google.com) otevři projekt
   `zasedak-kv` (je v něm i stará appka Zasedací pořádek – nekoliduje, používá
   jinou kolekci).
2. **Firestore Database → Rules** – vlož obsah `firestore.rules` a publikuj.
   Pokud tam Firestore ještě není založený, založ ho (Native mode).
3. **Hosting** – buď přes Firebase CLI (`firebase init hosting`, pak
   `firebase deploy`), nebo prostě nahraj celou tuhle složku na jakýkoliv
   statický hosting (GitHub Pages apod. – žádný build krok není potřeba).
4. Lokální test před nasazením: v téhle složce spusť `npx serve .` nebo
   `python3 -m http.server` a otevři v prohlížeči – **ne** dvojklikem na
   soubor (`file://`), ES moduly to nedovolí.

Až budeš chtít později vlastní Firebase projekt místo `zasedak-kv`, stačí
vyměnit obsah `firebase-config.js` za konfiguraci nového projektu – zbytek
kódu se nemusí měnit.

## Struktura

```
index.html, style.css, firebase-config.js
js/
  fb.js          – inicializace Firebase + odhad serverového času
  util.js        – konstanty, normalizace jmen
  gomoku.js       – logika hry (deska, výherní řada)
  scheduling.js   – pavouk (1/3 životy), liga, tiebreak
  state.js        – host logika, online stav
  matchview.js    – herní obrazovka
  app.js          – orchestrace, transakce, monitory
firestore.rules
assets/           – logo, favicon, banner, trofej, pozadí
```
