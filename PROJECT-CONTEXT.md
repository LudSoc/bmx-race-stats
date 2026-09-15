# PROJECT-CONTEXT.md — Résumé du projet pour garder le contexte

> Fichier de contexte généré pour les sessions de travail. Complète `CLAUDE.md` (qui documente l'API Sqorz en détail). Lis `CLAUDE.md` pour les schémas JSON de l'API.

---

## Vue d'ensemble

**bmx-race-stats** — SPA statique de stats BMX : recherche un pilote, affiche son historique complet, stats agrégées, graphiques, championnats, comparaison de 2 pilotes. Déployée sur GitHub Pages : `https://ludsoc.github.io/bmx-race-stats/`.

**Architecture** : tout-en-un dans `index.html` (~3 440 lignes : CSS inline + HTML + 4 blocs `<script>`). Aucun framework, aucun build step. Les données viennent d'un **fichier pré-construit** `pilots-index.json` (~79 Mo) — **pas d'appels API au runtime** (sauf rien : tout est dans l'index).

C'est un outil de la suite « BMX-Race » (frères : `bmx-race-head2head`, `bmx-race-club`, `bmx-race-category`), tous partageant le même `pilots-index.json` et le même thème.

---

## Fichiers

| Fichier | Rôle |
|---------|------|
| `index.html` | L'app complète (HTML+CSS+JS inline + `common.js`). |
| `common.js` | Socle partagé 100 % sans DOM (`window.BmxCommon` : norm/escape/humanError, zScore, phases, `expandIndex` — modes `false` économe / `'chrono'` phases chronométrées seules, `loadIndexCached` à cache meta.json, helpers purs de l'indice perf, `formatDataDates`). Chargé avant `index.html` (`./common.js`) et par les apps sœurs (club/h2h/category) via `https://ludsoc.github.io/bmx-race-stats/common.js` (+ fallback local `../bmx-race-stats/common.js`). Testé par `tests/common.test.js`. Toute évolution d'une fonction partagée se fait ICI, pas dans les apps. |
| `pilots-index.json` | Index pré-calculé de tous les pilotes FR (~79 Mo). **Généré, jamais édité à la main.** |
| `uci-index.json` | Index UCI (Mondiaux BMX Racing, ~2,8 Mo). Chargé en **arrière-plan** après l'index FR, optionnel (si absent, l'app continue sans l'onglet UCI). **Généré, jamais édité à la main.** |
| `uec-index.json` | Index UEC (Coupe/Championnats d'Europe via JSTiming, ~10 Mo). Chargé en **arrière-plan** après l'index FR (onglet 🇪🇺 UEC + refresh de la recherche affichée à son arrivée), optionnel. **Généré par `build-uec.js`, jamais édité à la main.** |
| `build-index.js` | Script Node qui génère les index par région (`node build-index.js [regionCode...]` ; par défaut FR + UCI). |
| `build-uec.js` | Script Node qui génère `uec-index.json` depuis JSTiming (`node build-uec.js [--limit N] [--match SUBSTR] [--no-cache]`) — crawl des pages Inertia (`data-payload`), cache de contenu `.cache/uec/`. |
| `build-field.js` | Helper partagé : forces de plateau par classe (indice v2, spec force-plateau) — scoring v1 sur slim, ratings annuels, 2 passes, sorties `field-strength-{fr,uec}.json` (+ metas). Utilisé par `build-index.js` (FR+UCI), `build-uec.js` (UEC, run complet seul.) et en CLI (`node build-field.js <index…> <out.json>`). |
| `field-strength-fr.json` / `field-strength-uec.json` (+ `.meta.json` commitées) | `{v, generated, medFs, classes: {clé: [fs, n]}}` (~650 Ko / ~70 Ko). Chargés en **arrière-plan** (optionnels, fallback v1 silencieux), jamais édités à la main. |
| `tests/uec-parse.test.js` | Tests unitaires des helpers de parsing de `build-uec.js` (`node --test tests/`). |
| `tests/e2e-uec.js` | E2E hors navigateur : exécute l'IIFE d'`index.html` (**`common.js` pré-chargé**) avec les index réels, vérifie recherche/rendu/indice UEC + ligne 🏅 en comparaison (`node tests/e2e-uec.js`). |
| `tests/common.test.js` | Tests unitaires du socle partagé (`node --test tests/`) : utils, score de rang (cas Merlin Guigo), constance/proxy finale, dates par source, expansion, chargeur (fetch stubbé). |
| `tests/field-strength.test.js` | Tests indice v2 (`node --test tests/`) : parité consts build/client, fixture bout-en-bout (`[fs, n]`, DNF exclu), parité formule build/app sur échantillons réels (FR chrono, UEC, DNF, séries), `loadFieldStrength`, shrinkage. |
| `.github/workflows/build-index.yml` | Cron hebdo (lundi 3h UTC) : `node build-index.js` + `node build-uec.js` (dont `field-strength-{fr,uec}.json` via `build-field.js`), publication R2 (10 fichiers) et commit des metas. |
| `worker.js` | Cloudflare Worker : proxy de cache API Sqorz (KV). Utile pour chauffer le cache, pas utilisé par l'app. |
| `warm-kv.sh` | Script shell qui pré-chauffe le KV Cloudflare via le worker proxy. |
| `service-worker.js` | Service Worker PWA : cache des assets (app shell uniquement). |
| `manifest.json` + `icons/` | PWA manifest + icônes. |
| `404.html` | Page 404 avec liens vers les outils de la suite. |
| `spec.md` | Spec d'origine (très courte, obsolète par rapport au produit actuel). |
| `docs/superpowers/specs/` | Specs de design des outils frères (H2H, Club). |

---

## Flux de données dans l'app (index.html)

1. **Chargement** : `loadPilotsIndex()` charge `./pilots-index.json` puis `./uci-index.json` puis `./uec-index.json` (via `loadIndexCached`, cache client piloté par meta.json). Les index UCI et UEC sont **optionnels** (`.catch` → index vide si fichier absent). Chaque JSON est **compressé** (clés courtes) puis `expandIndex()` le décompresse en structure complète.
2. **Recherche** : `searchLocal(query)` parcourt TOUT l'index en mémoire (événements + séries), matche par tokens normalisés (`norm()` : minuscules, sans accents, sans ponctuation). Une « match » = un pilote × un événement × une classe.
3. **Filtrage par pilote** : les homonymes sont regroupés par clé `norm(firstName lastName)` → `pilotMap`. L'utilisateur choisit via `.pilot-picker` (sinon auto = pilote le plus récent).
4. **Rendu** : `render(matches, sortMode, seriesMatches, uciMatches, uciSeriesMatches, uecMatches)` partitionne d'abord les résultats par **niveau** (`levelOf(accountCode)` + constante `NATIONAL_ACCOUNTS` : 5 comptes FFC = national, reste de la France = régional, index UCI = uci, index UEC = uec, cf. spec « séparation niveaux » + spec UEC) — **Global** (premier onglet, défaut) = concaténation événements + séries des quatre niveaux. Puis affiche **2 rangées d'onglets** : rangée 1 = parties (**📊 Global / 📍 Régional / 🇫🇷 National / 🇪🇺 UEC / 🌍 UCI**, badge = engagements, masquées si vides, choix mémorisé `partPref` en localStorage) ; rangée 2 = sous-vues de la partie active (**📈 Stats** — dashboard + 4 graphiques SVG, **🏆 Championnats** — séries, **🏁 Courses** — timeline verticale), recalculées sur le seul niveau (Global = tous). Puis `initAnimations()` (count-up + IntersectionObserver sur timeline).
5. **État URL** : `?name=…&year=…&sort=…` via `pushStateUrl()`/`replaceStateUrl()`. Au load, l'état est restauré (`init()`), avec cache des résultats de recherche (6h, localStorage) pour éviter de refaire le scan.

### Compétences clés de l'index (décompressé par `expandIndex`)

- **Événement** : `{ account, event: {eventId, eventName, eventDate, eventEndDate}, classes: [{ className, perpetualClassCode, total, competitors }] }`
- **Competitor** : `{ fn→firstName, ln→lastName, rank, plate, age, gn→groupName, d→competitorRankDetails[] }`
- **Detail de phase** : `{ n→phaseName, r→result, rp→racePosition, pc→phaseCode, pbc→phaseBlockCode, rn→raceName, tm→time, ht→hillTime, ct→corner2Time }`. `expandIndex()` mappe les **champs chrono** (`tm`/`ht`/`ct`, épreuves chronométrées par transpondeur) quand présents, et `build-index.js` les conserve depuis 2026-09-02 (`slimCompetitor`). Le rendu timeline les exploite (`chronoLinesForMatch`, cf. spec chronos-transpondeur) — l'index **publié actuel** (régénéré avant cette date) ne les contient pas encore : il sera mis à jour par la prochaine régénération hebdo (cron).
- **Série** : `{ account, coOrgs[], series, rankEvents[], classes: [{ className, perpetualClassCode, total, competitors }] }`
- **Competitor série** : `{ fn, ln, sr→seriesRank, sp→seriesPoints, gn, ev→[{er→eventRank, ep→eventPoints, t→tallied}] }`

---

## Logique métier clé (fonctions dans index.html)

### Recherche & état
- `norm(s)` — normalisation (NFD, minuscules, alphanumérique + espaces). Utilisée pour matcher noms/clubs.
- `matchPilot(firstName, lastName, tokens)` — tous les tokens doivent être inclus dans le nom complet.
- `searchInIndex(index, query)` — scan mémoire générique ; `searchLocal(query)` = index FR, `searchUci(query)` = index UCI, `searchUec(query)` = index UEC.
- État UCI : `lastUciMatches` / `lastUciSeriesMatches` (remplis dans `searchSelected`, filtrés par année dans `renderFiltered`, inclus dans le cache résultats 6h sous `uciMatches`/`uciSeriesMatches`).
- État UEC : `lastUecMatches` (idem UCI, cache sous `uecMatches`) ; comparaison : `lastCompareUecMatches`. Cache résultats **V3** (nouveau champ + nouvelle source → version incrémentée).
- Dans `render()` : `pilotSource` = matches FR, ou UCI si pas de FR ; `primaryUciMatches` suivent la même clé `norm(name)` que le pilote sélectionné ; `uciStats = computeStats(primaryUciMatches)` (computeStats est déjà générique).
- `searchPilotsForAc(query)` — autocomplétion : filtre le **pré-index des noms** (`nameIndex`, construit UNE fois au chargement par `buildNameIndex()`), trie par nombre d'occurrences, max 12 (`AC_MAX`). Ne couvre que l'index FR. Chaque champ d'autocomplétion est **debouncé** (150 ms).
- `expandIndex(idx)` — convertit les clés courtes en clés longues + reconstruit `competitorRankDetails` / `seriesRankCompetitorEvents`.
- Cache résultats : `RESULTS_CACHE_KEY` (`sqorzResultsCache`, TTL 6h, clé = query normée), sauve aussi les matches UCI.

### Stats (`computeStats(matches)`)
Compteurs : `entries, events, orgs, pilots, wins, podiums, top8, dnf, dns, dsq, finalsReached, finalWins, finalPodiums, semiFinalsReached, motosRaced, motoWins, motoTop4, gateResults{}, bestRank, avgRank, avgPct, avgField, topTen, topQuarter, topHalf, firstDate, lastDate, byClass{}`.

Points délicats :
- **DNS/DNF/DSQ** : comptés depuis le `rank` final **ET** depuis les phases (`result >= 100000`). Le commit `de6196e` a ajouté la comptabilisation par phases (un pilote classé avec un DNF en phase).
- `specialResultLabel(r)` : `>= 103000` → DNS, `>= 101000` → DSQ, `>= 100000` → DNF.
- `percentile(rank, total)` : null si `total < 10`.
- `zScore(rank, total)` : rang sous hypothèse uniforme, borné ±√3, pour le graphique d'évolution.
- Phases : `isFinalPhase` (exclut semi/quart/repech/petite finale), `isMotoPhase` (/^moto/i), `isSemiPhase`, `isKnockoutPhase`.
- `gateResults[gate]` : classements en manche par ligne de départ (pour « meilleure/pire ligne »), seulement si gate 1-8 et result 1-20.

### Indice de performance (spec indice-perf-design.md + spec force-plateau v2 2026-09-08)
Échelle **0–1000**, calculé côté client, aucune donnée ajoutée. Coefs de niveau : `PERF_LEVEL_COEFS` = Régional 0,93 / National 1,0 / **UEC 1,05** / UCI 1,05. Helpers : `perfScoreRang` (500 + 500·(z/√3)^2,5 pour z > 0 via `zScore` — courbe convexe qui creuse l'écart podium vs fond de top-20, linéaire sous la médiane), `perfConstance`/`perfCoefConstance` (`0,95 + 0,1·c` ∈ [0,97, 1,05] ; finale atteinte = phase finale valide **ou** rang classé sans phases KO publiées — `perfHasKnockout`, proxy Mondiaux conservé), `perfChronoScore` (z-score sur log temps, centré, strict — biais linéaire éliminé par calibration), `perfEngagement` (blend chrono `PERF_CHRONO_W`=0,3 ; DNF/DNS/DSQ = `PERF_DNF_SCORES` gradué par phase la plus profonde atteinte via `perfDeepestPhase` : finale 700 / demi 550 / quart 400 / manche 250 — un DNF en manche n'est pas éliminatoire, seule la progression compte ; phases des non-classés conservées par `build-index.js`), `perfSeriesScore` (z sur S classés, année = dernier événement conné), `perfLevel`/`computePerfIndices` (**carrière = moyenne des moyennes annuelles**, §4.7).
**v2 (spec force-plateau)** : `BmxCommon.applyFieldScore` — `clamp(clamp(raw·coef) + 0,3·(fs−medFs))` sur les classés (même ordre qu'au build ; `fs` lue dans `field-strength-{fr,uec}.json` via `perfFrField`/`perfUecField`, fallback v1 silencieux, jamais sur DNF) ; shrinkage `perfShrinkMean` (m = 2) sur les moyennes annuelles (badges, Stats, colonne category).

Rendu : `renderPerfComponent` (composant « 🏅 Indice de performance » dans l'onglet Stats de chaque niveau : carrière + par année, avec encadré « ℹ️ Comment est-il calculé ? »), chip `🏅` sur la carte pilote (5ᵉ paramètre de `renderPilotCard` = carrière Global), badges `🏅 N · M eng.` par année dans `renderTimeline` (3ᵉ paramètre `perfByYear`). Calibré sur données réelles 2026-09-02, resserré 2026-09-08 (ancrage : médiane population ≈ 500 inchangée, HEITZ 759, Mondiaux ≈ 960–1000).

### Rendu
- `renderStatsDashboard(s)` — 4 panneaux : Palmarès, Performance, Finales, Conditions (avec best/worst gate).
- `renderStats(s)` → `renderStatsDashboard(s)` (le composant Indice est intercalé entre le dashboard et les graphiques dans la partie Stats de chaque niveau).
- **Parties par niveau** (spec « séparation niveaux », D1–D16) : `LEVELS`/`levelOf()`/`NATIONAL_ACCOUNTS` ; panneaux par partie (`levelPanels`), sous-onglets (`subTabsHtml`, `data-part-btn` / `data-subtab-btn` / `data-compare-part`), `partPref` (localStorage), comparatif par niveau (`comparePart`, `lastCompareUciMatches`, lignes dont 🏅 indice perf via `perfLevel` au niveau comparé — carrière, ou année si filtre année). Sticky hybride sur mobile (rangée 1 seule). Boutons « Masquer/Afficher » et `sectionState`/`applySectionVisibility` supprimés.
- `renderYearlyChart(matches)` — rang moyen par saison (2 axes : rang + % finales). Nécessite ≥ 2 saisons.
- `renderEvolutionChart(matches)` — z-score par date, zones colorées. Nécessite ≥ 2 engagements.
- `renderRankHistogram(matches)` — bins 1er/2e/3e/4-8/9-16/17+.
- `renderOrgDonut(matches)` — donut SVG par organisation, max 7 segments visibles + « Autres ».
- `renderChampionships(seriesMatches)` — cartes championnat avec `<details>` par manche (rang, points, tallied ✓/○, lignes `absent` en grisé = pas de résultat).
- `renderTimeline(sortedEvents, pilotColor, perfByYear = null)` — timeline verticale par année (desc), points de couleur par meilleur rang (r1/r2/r3), phases cliquables. Badge d'indice de performance par année quand `perfByYear` est fourni. **Chronos transpondeur** : sous chaque `.class-line` avec manches chronométrées, un `.chrono-block` de lignes `.chrono-line` (une par métrique `time`/`corner2Time`/`hillTime` présente) — meilleur temps du pilote, rang compétition parmi les pilotes chronométrés de la classe (retrouvée dans l'index via `findClassCompetitors`, mémoïsée), meilleur temps absolu de la classe + détenteur ; si la classe est introuvable (cache), temps seul sans rang. Rien si aucun chrono (D4).
- `renderPilotCard(matches, seriesMatches, stats)` — hero card : avatar (plaque ou initiales), club (lien vers bmx-race-club), âge, badges DNF/DNS/DSQ, compteurs.
- `renderCompareSection(...)` — comparaison 2 pilotes : lignes avec barres proportionnelles, meilleure valeur en gras, lien vers H2H.
- `phaseTag(d, ctx)` — chip de phase, avec lien race Sqorz si `raceName`+`phaseCode` dispo.

### URLs Sqorz (construction)
- `eventUrl(acc, eventId)` → `https://our.sqorz.com/org/{acc}/event/{eventId}`
- `classUrl` → `…/class/{perpetualClassCode}` ; `raceUrl` → `…/race/{raceName}%{phaseCode}?perpetualClassCode=…` (fallback `…/phase/{phaseBlockCode}`)
- `seriesUrl` / `seriesClassUrl` → `…/series/{seriesId}/classes` et `…/class/{pcc}`
- `H2H_BASE` = `https://ludsoc.github.io/bmx-race-head2head/`, `CLUB_BASE` = `https://ludsoc.github.io/bmx-race-club/` (fallback `../…` en dev `file:`).

### UI / état
- Thème : cycle **auto → clair → sombre**, icônes 🌓/☀️/🌙, script inline en `<head>` avant rendu (anti-flash).
- Onglets : rangée 1 = parties (`data-part-btn` / `data-part`, badge d'engagements), rangée 2 = sous-vues (`data-subtab-btn` / `data-subtab`). Plus de sections pliables (boutons Masquer/Afficher supprimés) ; la partie active est mémorisée dans `partPref` (localStorage).
- Recherches récentes : `recentSearches` localStorage, max 5 chips.
- Autocomplétion custom (flèches, Enter, Escape, clic).
- `humanError(e)` — messages d'erreur français humanisés (HTTP 5xx, réseau, JSON, proxys).
- Boutons : partage (`copyLink()`), retour en haut, vider le cache (localStorage.clear + reload), don Ko-fi.

---

## build-index.js (régénération des index)

- `buildRegion(regionCode, outFile)` : `region/{code}` → liste orgs → pour chaque org : `/json/org/{code}` → tous les `events` publiés → `/json/event/{id}` (slimCompetitor) ; toutes les `series` publiées → `/json/series/{id}` (slimSeriesCompetitor).
- `main()` : par défaut `FR` → `pilots-index.json` puis `UCI` → `uci-index.json` ; on peut passer une liste en CLI (ex. `node build-index.js UCI`).
- **Déduplication des séries** par nom normalisé (`norm(seriesName)`) : si 2 orgs ont la même série, on garde celle avec le plus de manches (`rankEvents`), les autres vont dans `coOrgs`.
- Filtres : événements avec `publish !== false`, classes vides sautées, phases filtrées si pas de `phaseName`/`result`. `slimCompetitor` conserve les **champs chrono** de l'API (`time`, `hillTime`, `corner2Time` → `tm`/`ht`/`ct`) quand présents (épreuves chronométrées par transpondeur — spec chronos-transpondeur).
- Sortie par région : `{ generated, orgs, events, series }` (JSON.stringify, non minifié). Le workflow GitHub commite `pilots-index.json` ET `uci-index.json`.

### Orga UEC (`build-uec.js`)

- Source **JSTiming** (`results.jstiming.com`), orga UEC = uuid `99bf5559-4864-4496-9976-9681ae1834b7` (~130 événements passés, filtrés sur `button_text_view == "Results"`).
- Par événement : round `overall` (classements finaux + `classOptions`) + chaque round de course (positions + chronos `c11`/`c12`/`c14` → `ht`/`ct`/`tm`). Jointure riders par **id JSTiming** (trim) → `jid`.
- Particularités vérifiées : dates `DD-MM-YYYY` ; classes 6-10 ans sans overall (ranks vides → `rank` absent, phases conservées) ; chronos seulement 15+/Junior/U23/Élite ; `series: []`.
- Cache de contenu `.cache/uec/` (sha256 + ETag) — le crawl hebdo ne re-traite que les pages modifiées. Extrapolation volume : **≈ 6 Mo** non compressé pour 130 événements (mesuré sur échantillon, spec D10).

### Orga UCI (`ucibmxworlds`)

- Région `UCI` = « Union Cycliste Internationale », 1 seule orga : `ucibmxworlds` (« UCI BMX Racing »).
- Contient uniquement les **Championnats du Monde / World Challenge** (classes par âge : Boys 16, Men 17-24…, Cruiser, Masters) — **pas de classes Élite/Junior** (vérifié sur les événements bruts 2024-2026). `series: []`.
- 1 édition = 4 événements (un par jour : WED/THU/FRI/SAT), ~600-800 pilotes chacun.
- **`groupName` = code pays** (AUS, USA, FRA…) et non le club local → ne pas l'utiliser pour l'identité d'un pilote (le club FR reste prioritaire dans `renderPilotCard`).

---

## Cache & infra

### Cloudflare Worker (`worker.js`)
- Proxy `https://our.sqorz.com/json/*` → KV `SQORZ_CACHE`, TTL 7j pour `/json/region/` + `/json/org/`, 4h sinon. CORS `*`. Utilisé par `warm-kv.sh` (et potentiellement d'autres outils de la suite), **pas par cette app** (qui lit l'index local).

### Service Worker (`service-worker.js`)
- Enregistré dans `index.html` (`navigator.serviceWorker.register('./service-worker.js')`). Chemins **relatifs** (`./`, `./index.html`) — l'app vit sur un sous-chemin (/bmx-race-stats/). Stratégie réseau d'abord avec fallback cache ; fallback de navigation vers le shell hors-ligne.
- **Les index de données ne sont JAMAIS cachés** (`NO_CACHE` : `pilots-index.json`, `uci-index.json`, `uec-index.json`) — ils passent directement par le navigateur.
- Bump de version : `CACHE_NAME = 'sqorz-v2'` (l'activate purge les anciens caches).

### Cache navigateur (localStorage dans index.html)
- Uniquement le **cache des résultats de recherche** (`sqorzResultsCache`, TTL 6 h, clé = query normée) — le cache des réponses API (`sqorzCache`/`fetchJsonCached`) a été **supprimé** (code mort, l'app ne fait plus d'appels API au runtime).

---

## PWA / déploiement

- `manifest.json` **lié** dans `<head>` (`<link rel="manifest">`) + `theme-color` + `apple-touch-icon` ; `start_url`/`scope` relatifs (`./`) pour le sous-chemin. Icônes 192/512 (`icons/`).
- `service-worker.js` **enregistré** (voir section Service Worker). L'app est installable (Android Chrome : bannière/menu → « Ajouter à l'écran d'accueil » ; iOS Safari : Partager → « Sur l'écran d'accueil »). Hors-ligne = shell uniquement (l'index de 79 Mo reste en ligne).
- GitHub Pages : tout est statique, aucun build. Le cron GitHub Actions régénère `pilots-index.json` + `uci-index.json` chaque lundi et les commit.

---

## Pièges & conventions à respecter

- **Ne jamais éditer `pilots-index.json` à la main** — le régénérer via `node build-index.js`.
- L'app lit l'index avec **streaming + progress bar** : tout le parsing est synchrone après téléchargement (~79 Mo décompressé) ; ne pas casser ce flux.
- Ne pas oublier le double niveau de compression : clés courtes dans le JSON, puis `expandIndex()` au chargement.
- `norm()` est partout : toute nouvelle recherche doit l'utiliser (accents, casse).
- Les codes spéciaux `>= 100000` doivent être gérés via `specialResultLabel()` (DNS ≥ 103000, DSQ ≥ 101000, DNF ≥ 100000).
- Sécurité : tout le HTML est construit par concaténation de template strings → **toujours échapper les données avec `escape()`** (XSS via noms de pilotes/clubs/événements).
- Le fichier est monolithique : toute modif JS/CSS se fait dans `index.html`, en respectant l'ordre des scripts (le gros IIFE est le script principal).
- Thème : respecter le système auto/clair/sombre (bouton + script anti-flash dans `<head>`).

---

## Historique récent (orientations)

- DNF/DNS/DSQ comptés depuis les phases ET le rang final (`de6196e`).
- Ajout bouton don Ko-fi dans le header (`0d1abe8`).
- Fix 404 : contraste, titre, emoji, touch targets (`6be64c6`).
- Cross-link H2H depuis la section comparaison (`8d9ccde`).
- Améliorations graphiques SVG mobile (liés aux commits `627f127`, `d5b7005`, `3fba092`).
