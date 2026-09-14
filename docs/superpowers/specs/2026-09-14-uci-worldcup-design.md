# Spec — Coupe du monde UCI BMX Racing (`uci-worldcup-index.json`)

Intégrer les manches de Coupe du monde UCI (Elite / U23 Hommes & Femmes) comme **4ᵉ source**,
au même titre que l'UEC : absentes de Sqorz comme de l'index UCI actuel (World Challenge =
catégories d'âge uniquement, pas d'Elite). Statut : **décisions prises le 2026-09-14.**
Référence API : `GET https://www.uci.org/api/calendar/results/{eventCode}?discipline=BMX&raceType=A&raceName={title}`
(sans auth, sans CORS → crawl Node uniquement ; `robots.txt: Allow: /`).

## 1. Découverte (vérifiée le 2026-09-14)

- `sitemap.xml` → pages `/race-hub/*bmx*world-cup*` (filtrer freestyle/cyclo-cross/MTB).
- Chaque page race-hub embarque son `ResultsAccordion` : 4 items `{title, eventCode, raceType}`
  (ex. Round 5 Mentougou 2026 : `D2EV366531` + 3 autres ; Worlds 2026 Brisbane : 6 codes).
- Métadonnées page : `raceTitle` (lieu), `raceStartDate` (ISO).
- Couverture : ~23 manches avec données (2023 R1/R3/R4/R7-R10, 2024 R1-R6, 2025 R2-R6,
  2026 R1-R4 + à venir). **Trous connus** (ancien template sans accordion) : 2023 R2/R5/R6,
  2024 R7/R8, 2025 R1 — ignorées avec avertissement, re-testées à chaque crawl.
- Périmètre **D1 — ACTÉ** : Coupe du monde 2023+ (aligné UEC). Championnats du monde Elite
  (race-hubs 2022-2026) : **hors scope v1** (extension triviale : mêmes pages, mêmes codes).

## 2. Format API (vérifié en réel, Mondiaux 2026 Brisbane)

```json
{ "results": [{ "headerType": "rider", "values":
    { "rank": "1", "firstname": "Jesse", "lastname": "ASMUS", "age": 23,
      "nationality": "AUS", "points": "750", "result": "" } }],
  "podium": { "podium": [{ "firstname": "…", "time": "" }], "discipline": "bmx-racing" },
  "headers": [...] }
```

- `rank` : chaîne numérique (jamais de codes DNX observés — les non-classés sont absents).
- `result`/`time` : vides sur le Virsac observé (pas de chronos ; si un jour remplis : `time`).
- `age` + `nationality` : alimentent `age`/`gn` (et les votes `by` du ranking).
- Volume : ~25-70 coureurs/classe, 4 classes/manche → ~3-4k engagements au total.

## 3. Mapping vers le format slim (aligné `uec-index.json`)

- Orga unique : `{ accountCode: 'uciworldcup', accountName: 'UCI BMX Racing World Cup' }`.
- 1 événement par manche : `eventId: 'wc<year>r<round>'` (ex. `wc2026r5`),
  `eventName: 'Coupe du monde #5 – Mentougou 2026'`, `eventDate` = `raceStartDate` (jour),
  `url` = page race-hub (les liens CDM pointent vers uci.org, jamais Sqorz).
- Classes : `ME/WE/MU23/WU23` (`Men Elite`, `Women Elite`, `Men U23`, `Women U23`),
  `total` = nb de résultats, `series: []` (comme UEC).
- Coureurs : `{ fn, ln, rank: Number, gn: nationality, age: Number }`, `d: []` (pas de phases —
  même régime que l'UCI Challenge : rang final seul, constance par défaut).
- Noms directs (`firstname`/`lastname` API — pas de découpage comme JSTiming).

## 4. Niveaux & coefs — **D2 — ACTÉ : fusion dans le niveau UCI existant**

Pas de 6ᵉ onglet : la Coupe du monde rejoint le niveau **🌍 UCI** (même instance, même coef
**×1,05**, même absence de force de plateau). Justification : pas de recouvrement significatif
(Challenge = classes d'âge amateurs, WC = Elite/U23) ; `levelOf()` ne connaît que le FR de
toute façon (niveaux UEC/UCI identifiés par l'index d'origine). Alternative écartée : onglet
dédié (~60 points de touche : LEVELS, cache, compare, perf — disproportionné).
- `sqorz_stats` : `searchUci()` boucle sur `[uciIndex, wcIndex]` (séries : Challenge seul),
  `wcIndex` chargé en arrière-plan comme UEC, `INDEX_CACHE_URLS.wc`, pied `UCI` = max des
  deux dates. Pas de changement de cache (fusion en amont : `lastUciMatches` contient
  déjà les deux, format inchangé, pas de bump de version).
- `perf` (app + ranking) : coef UCI 1,05 automatique via le niveau ; ranking =
  4ᵉ source `{ tag: 'WC', coef: 1.05, field: null, club: false }` (votes `by` via `age`).
- `h2h_stats` : chargement comme UEC (`allEvents` += wcIndex) — les duels de pros y gagnent.
- `category_stats`, `club_stats`, `hub-search` : **skip v1** (pas de classes jeunes ;
  `gn` = pays, pas un club).

## 5. Robustesse build (`build-uciworldcup.js`, miroir de `build-uec.js`)

- CLI `--limit N` / `--match SUBSTR` / `--no-cache`, `DELAY_MS = 150`, retry ×3, UA navigateur.
- Cache de contenu `.cache/uciworldcup/` (sha256 par URL) : le crawl hebdo ne re-traite que
  les pages modifiées ; sitemap re-lu à chaque fois (nouvelles manches auto-découvertes).
- Sorties : `uci-worldcup-index.json` + `.events.ndjson` + `.meta.json` (même forme que UEC).
- Tolérance : manche sans accordion / API en échec / classe vide → skip + warn, jamais d'échec.
- `robots.txt` revérifié à chaque session (abuse = stop).

## 6. Pipeline & coûts

- Workflow `build-index.yml` : `node build-uciworldcup.js` + metas (`uci-worldcup`) +
  publication R2 (`uci-worldcup-index.json`, `.events.ndjson`). Zéro infra, zéro coût.
- Apps : chargement **paresseux** comme UEC (second plan, optionnel — jamais de page blanche).

## 7. Tests (suites vertes exigées)

- `tests/uci-worldcup-parse.test.js` : extraction accordion (eventCodes + raceType),
  mapping rider→slim (rank/âge/pays, rangs non numériques ignorés), nommage eventId,
  filtre sitemap (World Cup BMX Racing uniquement).
- Recette : `--match sarrians` puis volume total (~23 manches, ~4 classes, 0 erreur bloquante).

## 8. Effort estimé

~1 jour : recon faite (API + sitemap + gabarits validés en réel), build + cache (3 h),
conso 3 apps + ranking + cron (4 h), tests + recette (2 h).
