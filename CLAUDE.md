# bmx-race-stats — Documentation CLAUDE.md

## Vue d'ensemble

Application web statique (SPA) de consultation de statistiques BMX racing, alimentée par l'API publique Sqorz **et par JSTiming** (compétitions UEC, depuis 2026-09-03). Elle permet de rechercher un coureur, visualiser ses performances par événement, comparer plusieurs coureurs, et naviguer dans les classements de championnats.

Architecture : tout-en-un dans `index.html` (HTML + CSS + JS inline, ~3000 lignes). Pas de framework, pas de build step.

---

## API Sqorz

### Base URL

```
https://our.sqorz.com
```

Pas d'authentification. Tous les endpoints sont publics et accessibles en CORS.

### Endpoints

#### 1. Région → liste des organisations

```
GET /json/region/{regionCode}
```

- `regionCode` : code ISO du pays (ex. `FR`, `BE`, `NL`)
- Retourne la liste des clubs/organisations enregistrés dans la région

```json
{
  "accounts": [
    {
      "accountCode": "string",   // identifiant org (ex: "FFCycl-BMX")
      "accountName": "string"    // nom affiché (ex: "Fédération Française de Cyclisme - BMX")
    }
  ]
}
```

#### 2. Organisation → événements et séries

```
GET /json/org/{accountCode}
```

- `accountCode` : code de l'organisation (URL-encodé si nécessaire)
- Retourne tous les événements passés/futurs et les championnats de l'organisation

```json
{
  "accountCode": "string",
  "accountName": "string",
  "events": [
    {
      "eventId": "string",
      "eventName": "string",
      "eventShortName": "string",
      "eventDate": "YYYY-MM-DD",
      "eventEndDate": "YYYY-MM-DD",
      "publish": true
    }
  ],
  "series": [
    {
      "seriesId": "string",
      "seriesName": "string",
      "publish": true
    }
  ]
}
```

#### 3. Événement → résultats complets

```
GET /json/event/{eventId}
```

- Retourne les classements de toutes les catégories pour un événement donné
- Les événements passés sont immuables (données figées)

```json
{
  "eventId": "string",
  "eventName": "string",
  "eventDate": "YYYY-MM-DD",
  "classRanks": [
    {
      "className": "string",           // ex: "Élite Hommes", "7 ans"
      "perpetualClassCode": "string",  // identifiant stable de la catégorie
      "competitorRankSummaries": [
        {
          "firstName": "string",
          "lastName": "string",
          "rank": 1,                   // classement final
          "plate": "string",           // numéro de plaque (optionnel)
          "age": 25,                   // âge (optionnel)
          "groupName": "string",       // club (optionnel)
          "competitorRankDetails": [
            {
              "phaseName": "string",   // ex: "Manche 1", "1/4 de finale", "Finale"
              "result": 3,             // position dans la phase (voir codes spéciaux ci-dessous)
              "racePosition": 2,       // position de départ / gate (optionnel)
              "phaseCode": "string",
              "phaseBlockCode": "string",
              "raceName": "string"
              // Champs chrono optionnels (épreuves chronométrées par transpondeur, secondes) :
              // "time": "35.063"  — temps de course complet
              // "hillTime": "2.628" — temps intermédiaire (ligne « hill »)
              // "corner2Time": "20.468" — temps intermédiaire (ligne « corner 2 »)
            }
          ]
        }
      ]
    }
  ]
}
```

#### 4. Série/Championnat → classement général

```
GET /json/series/{seriesId}
```

- Retourne le classement de championnat multi-manches

```json
{
  "seriesId": "string",
  "seriesName": "string",
  "seriesRankEvents": [
    {
      "eventId": "string",
      "eventName": "string",
      "eventShortName": "string",
      "eventDate": "YYYY-MM-DD",
      "eventEndDate": "YYYY-MM-DD"
    }
  ],
  "seriesRankClasses": [
    {
      "className": "string",
      "perpetualClassCode": "string",
      "seriesRankCompetitors": [
        {
          "firstName": "string",
          "lastName": "string",
          "seriesRank": 1,             // position au championnat
          "seriesPoints": 250,         // total de points
          "groupName": "string",
          "seriesRankCompetitorEvents": [
            {
              "eventRank": 3,          // classement à cette manche (optionnel)
              "eventPoints": 40,       // points marqués à cette manche (optionnel)
              "tallied": true          // si ce résultat est compté (certains championnats permettent de "dropper" des manches)
            }
          ]
        }
      ]
    }
  ]
}
```

### Codes de résultat spéciaux

La valeur `result` dans `competitorRankDetails` peut contenir des codes > 100 000 :

| Plage | Signification |
|-------|--------------|
| `< 100 000` | Position normale (1 = 1er, 2 = 2e, etc.) |
| `100 000 – 100 999` | DNF — Did Not Finish (abandon) |
| `101 000 – 102 999` | DSQ — Disqualified (disqualifié) |
| `≥ 103 000` | DNS — Did Not Start (non partant) |

## Chronométrage transpondeur (temps de course)

Vérifié sur les données réelles (sept. 2026) : quand une épreuve est chronométrée par transpondeurs, chaque phase courue (`competitorRankDetails`) porte des champs de temps **optionnels**, en **secondes** (chaîne décimale) :

| Champ | Signification |
|-------|---------------|
| `time` | Temps de course complet (ex. `"35.063"`) |
| `hillTime` | Temps intermédiaire — ligne « hill » (ex. `"2.628"`) |
| `corner2Time` | Temps intermédiaire — ligne « corner 2 » (ex. `"20.468"`) |

Conditions d'apparition :

- Le chronométrage doit être **activé pour l'épreuve**. Champs de diagnostic au niveau événement : `eventSummary.laps`, `transponderSummary` (`transponderScoring`, `requiredTransponders`, `missingTransponders`), `lowBatteryTransponders`, `plateProblems`, `transponderProblems`.
- **Toutes les classes ne sont pas forcément chronométrées** (ex. Championnats de France 2026 : U19/U23/Élite uniquement — 562 phases chronométrées / 1 061). Un coureur sans lecture transpondeur (DNF/DNS, transpondeur manquant) n'a pas de `time` sur la manche.
- Mesures de référence : Mondiaux UCI 2026 → 2 401 phases chronométrées / 3 829. Courses de club ou de ligue sans chrono → aucun champ de temps (ex. `transponderScoring: false`).

Depuis 2026-09-02, `slimCompetitor` (`build-index.js`) **conserve** ces champs sous clés courtes (`tm`/`ht`/`ct`), et l'app les affiche (sous-ligne « ⏱ Chronos » dans la timeline, via `expandIndex()` + `chronoLinesForMatch`) — cf. `docs/superpowers/specs/2026-09-02-chronos-transpondeur-design.md`. Libellés d'affichage : `time` → « ⏱️ Chrono », `corner2Time` → « ⏱️ Virage 1 », `hillTime` → « ⏱️ Butte ». Exclusion : les phases DNF/DNS/DSQ (`result ≥ 100 000`) ne comptent **jamais** dans le calcul, même si elles portent un temps (souvent 0 ou temps d'abandon) ; un temps ≤ 0 n'est jamais compté non plus (`isNotTimedPhase`). **Time trial** : runs en solo, `result` vaut 1 pour tout le monde (1er de son run) — `isTimeTrialPhase` (`common.js`, phases `Time Trial`/`Super Final`, codes TT/TTF) : `phaseTag` montre le chrono (jamais de « 1er »), les stats excluent ces phases des victoires/podiums/finales (seul le rang final compte). NB : les détails manipulés par l'app sont en clés **expandées** (`result`, `time`…), pas en clés courtes (`r`, `tm`…) — `isNotTimedPhase` teste donc `result`, pas `r`. ⚠️ **L'index publié actuel** (régénéré avant cette date) ne les contient pas encore : il sera mis à jour par la prochaine régénération hebdo (cron), après quoi les chronos apparaîtront sans autre changement (impact : +~0,65 Mo gzip au total, mesuré).

**Temps réel (hors périmètre public)** : l'API **LAN** du poste de chronométrage (« Local Web Services », cf. docs.sqorz.com) expose `getRaceDetails` (option `identifyBestTimes`) et le canal Socket.IO `/event/raceSummary` — réseau local de l'organisateur uniquement ; l'API internet `/json/event/{id}` est mise à jour ~toutes les 30 s.

## Indice de performance (🏅, 0–1000)

Feature **100 % côté client** (spec `docs/superpowers/specs/2026-09-02-indice-perf-design.md`, correctif saturation §7.4 le 2026-09-08, v2 force-plateau le 2026-09-08 : spec `2026-09-08-force-plateau-shrinkage-design.md`) : un score 0–1000 par pilote, par année et carrière, qui combine rang pondéré par les participants (`zScore` → `500 + 500·(z/√3)^2,5` pour z > 0, linéaire sous la médiane), **force du plateau adverse** (`+0,3·(fs−medFs)`, lue dans `field-strength-{fr,uec}.json`, jamais sur DNF), constance par phase (±5 %, proxy « classé ⇒ finales » seulement sans phases KO publiées — Mondiaux), chrono transpondeur (z-score sur log temps, centré, strict — poids `PERF_CHRONO_W` = 0,3), classements de séries (même z, année = dernier événement), sous coefs de niveau légers (Régional 0,93 / National 1,0 / UCI 1,05, clamp [5,1000]), **shrinkage des moyennes annuelles vers 500** (`(n·mean + 2·500)/(n+2)`). DNF/DNS/DSQ final = pénalité graduée par la phase atteinte (`PERF_DNF_SCORES` : finale ≈ 700 · demi ≈ 550 · quart ≈ 400 · manche/inconnu ≈ 250, × coef).

Affichage : chip **🏅 carrière** sur la carte pilote (tous niveaux), composant « 🏅 Indice de performance » dans l'onglet **Stats** de chaque partie (carrière + par année, avec encadré « ℹ️ Comment est-il calculé ? »), badges **🏅 … · N eng.** à côté des séparateurs d'année de la timeline. Calibré sur données réelles (2026-09-02, resserré 2026-09-08) : médiane population ≈ 500, front runners > 800, HEITZ 759 / ANJOUBAULT 629 (carrière = moyenne des moyennes annuelles). Depuis la spec UEC : `PERF_LEVEL_COEFS.uec = 1,05` (comme UCI) ; les pilotes non classés en UEC (classes 6-10 ans sans overall) sont pénalisés via `perfDeepestPhase` sur leurs phases conservées.

---

## Source JSTiming (UEC — Coupe/Championnats d'Europe)

Depuis la spec `docs/superpowers/specs/2026-09-03-uec-jstiming-design.md`, les compétitions UEC (publiées sur `results.jstiming.com`, absentes de Sqorz) sont intégrées comme **4ᵉ niveau** « 🇪🇺 UEC » entre National et UCI :

- **Plateforme** : Laravel + Inertia (SPA Vue) — les données sont embarquées en JSON dans l'attribut `data-payload` du HTML (HTML-unescape + `JSON.parse`). Pas d'API dédiée, **pas de CORS** → crawl côté Node uniquement (`build-uec.js`). `robots.txt` : rien d'interdit.
- **Endpoints** : `GET /` (liste des organisateurs, UEC = `99bf5559-…`), `GET /{orgUuid}?page=N` (événements passés, 15/page, ~130 événements, 9 pages), `GET /event/{uuid}` (round par défaut), `GET /event/{uuid}/{roundSlug}` (`moto-1round-1`, `moto-2lcq`, `moto-3`, `14-finals`, `12-finals`, `finals`, `overall`…).
- **Format** : `heats` (une course par heat, `class_code` = G15/B15/MJ/MU/ME/WJ/WU/WE…) contenant `riders` (`id` stable type `"10076737690G"` — **à trimmer**, `name` « Prénom NOM », `rank`, `result`, `additional_columns`). Le round `overall` donne le classement final par classe ; les rounds de course donnent les positions par course + chronos (`c11`=Start, `c12`=Split 1, `c14`=Finish quand `*_cname` le dit).
- **Pièges vérifiés en recette** : `start_date`/`end_date` au format **`DD-MM-YYYY`** (→ `jdToIso`) ; classes 6-10 ans **sans classement overall** (`colRank: "G"`, ranks vides → pilotes avec phases mais `rank` absent, géré par l'indice de perf via `perfDeepestPhase`) ; le slug `moto-2lcq` contient **toutes** les manches 2 (pas seulement les LCQ) ; chronos seulement pour les classes 15+/Junior/U23/Élite ; `column_name_result` = `Time` seulement sur les heats chronométrés.
- **Mapping D6** : Finish→`time` (« ⏱️ Chrono »), Split 1→`corner2Time` (« ⏱️ Virage 1 »), Start→`hillTime` (« ⏱️ Butte ») — réutilise tout le pipeline chrono existant.
- **Sorties** : `uec-index.json` + `uec-index.events.ndjson` + `uec-index.meta.json` (format slim aligné : `fn/ln/gn/rank/plate/d[n,r,tm,ct,ht]` + `jid` → `riderId` après `expandIndex()`), orga unique `uec` (« UEC — Union Européenne de Cyclisme »), `series: []` (D4 : JSTiming n'expose aucune série multi-manches).
- **Cache de contenu** (`.cache/uec/`, sha256 par URL + ETag) : le crawl hebdo ne re-traite que les pages modifiées. `DELAY_MS=150`, retry ×3.
- **Tests** : `node --test tests/uec-parse.test.js` (helpers de parsing) et `node tests/e2e-uec.js` (E2E hors navigateur avec index réels ; nécessite `uec-index.json` — cf. `node build-uec.js --limit 3`).

## Organisation UCI (Mondiaux)

- Région : `GET /json/region/UCI` → 1 orga : `ucibmxworlds` (« UCI BMX Racing »)
- Événements : `GET /json/org/ucibmxworlds` → Championnats du Monde BMX (World Challenge), un événement par jour, `uciEvent: true`, `series: []`
- Particularités : `groupName` = code pays ; pas de classes Élite/Junior dans cette orga

## PWA

- `manifest.json` lié dans `<head>` (`<link rel="manifest">`, `theme-color`, `apple-touch-icon`) ; `start_url`/`scope` relatifs (`./`)
- `service-worker.js` enregistré (`navigator.serviceWorker.register('./service-worker.js')`) ; `CACHE_NAME = 'bmx-v5'`
- Stratégie : réseau d'abord, fallback cache ; fallback de navigation vers le shell ; `pilots-index.json`/`uci-index.json` jamais mis en cache
- Hors-ligne : shell uniquement (l'index de 79 Mo reste en ligne)

## URLs web Sqorz (navigation)

À partir des données API, on peut construire des URLs de navigation vers le site Sqorz :

```
Événement :       https://our.sqorz.com/org/{accountCode}/event/{eventId}
Classe d'event :  https://our.sqorz.com/org/{accountCode}/event/{eventId}/class/{perpetualClassCode}
Course/Race :     https://our.sqorz.com/org/{accountCode}/event/{eventId}/race/{raceName}%{phaseCode}?perpetualClassCode={perpetualClassCode}
Phase :           https://our.sqorz.com/org/{accountCode}/event/{eventId}/phase/{phaseBlockCode}
Série :           https://our.sqorz.com/org/{accountCode}/series/{seriesId}/classes
Classe de série : https://our.sqorz.com/org/{accountCode}/series/{seriesId}/class/{perpetualClassCode}
```

---

## Stratégie de cache

### Cache proxy Cloudflare (`worker.js`)

Toutes les requêtes API passent par un worker Cloudflare qui met en cache les réponses dans Cloudflare KV :

- TTL **7 jours** pour `/json/region/` (données quasi-statiques)
- TTL **4 heures** pour tous les autres endpoints

### Cache navigateur (`localStorage`)

L'application ne fait **aucun appel API au runtime** (tout vient des index) : le seul cache localStorage restant est le **cache des résultats de recherche** (`bmxResultsCache`, TTL 6 h, clé = query normalisée, stocké sous forme *slim*). L'ancien cache de réponses API (`bmxCache`/`fetchJsonCached`) a été supprimé (code mort).

Le cache *slim* compresse automatiquement les clés JSON pour économiser de l'espace :

| Champ original | Clé compressée |
|----------------|----------------|
| `firstName` | `fn` |
| `lastName` | `ln` |
| `groupName` | `gn` |
| `competitorRankDetails` | `d` |
| `seriesRank` | `sr` |
| `seriesPoints` | `sp` |
| `racePosition` | `rp` |
| `phaseCode` | `pc` |
| `phaseBlockCode` | `pbc` |
| `raceName` | `rn` |

---

## Index des pilotes (`pilots-index.json`)

Fichier pré-construit (≈79 Mo) généré par `build-index.js` et régénéré hebdomadairement. Il agrège tous les pilotes de toutes les organisations de la région FR et permet la recherche côté client sans requête API.

Structure interne : tableau de pilotes avec leurs participations à des événements, indexé par nom normalisé.

Pour regénérer : `node build-index.js` (fait toutes les requêtes API région → orgs → events).

## Index UCI (`uci-index.json`)

Fichier séparé (≈2,8 Mo) généré par le même `build-index.js` à partir de la région `UCI` (orga `ucibmxworlds` — « UCI BMX Racing »). Chargé par l'app en parallèle de l'index FR ; s'il est absent, l'app fonctionne sans la partie UCI.

- Contient uniquement les Championnats du Monde / World Challenge (classes par âge) — **pas de classes Élite/Junior** ; `series: []`.
- 1 édition = 4 événements (un par jour : WED/THU/FRI/SAT).
- `groupName` = code pays (ex. `FRA`) et non le club local.

## Navigation par niveaux (Global / Régional / National / UEC / UCI)

Depuis la spec `docs/superpowers/specs/2026-09-02-separation-niveaux-design.md` (+ UEC : spec `2026-09-03-uec-jstiming-design.md`), la vue pilote est organisée en **2 rangées d'onglets** :

1. **Rangée 1 — parties** : `📊 Global | 📍 Régional | 🇫🇷 National | 🇪🇺 UEC | 🌍 UCI` (constante `LEVELS` dans `index.html`, clés `global|regional|national|uec|uci`).
   - **Global** = agrégation des quatre niveaux (événements + séries concaténés, toutes stats confondues) — **défaut au premier rendu** (aucun `partPref` mémorisé).
   - **National** = les 5 comptes FFC (`NATIONAL_ACCOUNTS` : `ffc` + 4 zones `ffcbmxne/no/so/sudest`) — 185 événements / 35 séries ; **Régional** = toutes les autres orgs de l'index FR (520 événements / 73 séries, vérifié : aucun croisement entre les deux groupes) ; **UEC** = l'index `uec-index.json` (JSTiming, événements uniquement) ; **UCI** = l'index `uci-index.json`.
   - Les matches UEC/UCI sont identifiés par l'index d'origine (`lastUecMatches`/`lastUciMatches`), **pas par `levelOf()`** (qui ne connaît que les comptes FR).
   - Une partie n'est affichée que si le pilote actif a des données à ce niveau (badge = nombre d'engagements). La partie choisie est mémorisée en `localStorage` (`partPref`) ; sans préférence, repli sur la première partie disponible (donc Global). Le mini-sélecteur de la comparaison 2 pilotes propose les mêmes parties (Global compris).
2. **Rangée 2 — sous-vues** (de la partie active, défaut Stats) : `📈 Stats | 🏆 Championnats | 🏁 Courses`, chacune recalculée sur les seuls résultats du niveau.

La comparaison 2 pilotes a son propre mini-sélecteur de niveau (mêmes parties, Global compris ; **défaut = Global** s'il est dispo, sinon la partie active — `comparePart` + `lastCompareUciMatches`, puis indépendant). Les boutons « Masquer/Afficher » des blocs ont été supprimés (D12). Le matching réutilise `norm()` et la clé pilote (`norm(firstName lastName)`) commune aux deux index.

---

## Fichiers clés

| Fichier | Rôle |
|---------|------|
| `index.html` | Application complète (HTML/CSS/JS inline, ~3500 lignes) |
| `build-index.js` | Script de génération des index (`pilots-index.json` FR + `uci-index.json` UCI) |
| `build-uec.js` | Script de génération de l'index UEC (`uec-index.json`) depuis JSTiming — crawl Node, cache `.cache/uec/` |
| `build-uciworldcup.js` | Script de génération de l'index Coupe du monde UCI (`uci-worldcup-index.json`) depuis l'API uci.org — crawl Node, cache `.cache/uciworldcup/`, spec `docs/superpowers/specs/2026-09-14-uci-worldcup-design.md` |
| `build-field.js` | Helper partagé : forces de plateau par classe (indice v2) — scoring v1 sur slim, ratings annuels, 2 passes, sorties `field-strength-{fr,uec}.json` (+ metas). Utilisé par `build-index.js`, `build-uec.js`, et en CLI |
| `field-strength-fr.json` / `field-strength-uec.json` | `{v, generated, medFs, classes: {clé: [fs, n]}}` — forces de plateau (jamais édités à la main, metas commitées, données sur R2) |
| `uec-index.json` | Index UEC (Coupe/Championnats d'Europe) — ne pas éditer à la main |
| `uci-worldcup-index.json` | Index Coupe du monde UCI (Elite/U23, API uci.org) — ne pas éditer à la main |
| `uci-index.json` | Index UCI (Mondiaux BMX Racing) — ne pas éditer à la main |
| `worker.js` | Cloudflare Worker — proxy de cache API |
| `service-worker.js` | Service Worker — cache du shell de l'app (PWA, enregistré dans `index.html`, chemins relatifs, index de données exclus du cache) |
| `pilots-index.json` | Index pré-calculé de tous les pilotes (ne pas éditer à la main) |
| `manifest.json` | Manifest PWA |
| `warm-kv.sh` | Script shell pour pré-chauffer le cache Cloudflare KV |

---

## Modèle de données métier (BMX)

```
Région (ex: FR)
  └── Organisation (ex: club local, fédération nationale)
        ├── Événement (compétition sur 1-2 jours)
        │     └── Catégorie / Classe (ex: "Élite Hommes", "7 ans garçons")
        │           └── Coureur
        │                 └── Détails par phase (Manche 1, 2, 3, 1/4, 1/2, Finale)
        └── Série (championnat multi-manches)
              └── Catégorie
                    └── Coureur (classement + points par manche)
```

Une **phase** = une course. Les phases typiques en BMX :
- Manches qualificatives (Manche 1, 2, 3)
- Quarts de finale, Demi-finales
- Finale (petite finale, grande finale)

Un **perpetualClassCode** identifie une catégorie de façon stable à travers différents événements et organisations, permettant de comparer les résultats d'un même coureur dans la même catégorie sur plusieurs compétitions.
