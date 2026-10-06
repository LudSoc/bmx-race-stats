# Audit — sqorz_stats

**Date :** août 2026 — **Périmètre :** code, performance, infrastructure, données, accessibilité, sécurité.
Chaque constat est **vérifié** (mesures ou lecture du code) ; les propositions sont priorisées.

---

## 1. Vue d'ensemble

SPA statique (1 fichier `index.html`, ~3 600 lignes HTML+CSS+JS inline) qui recherche un pilote BMX dans un index pré-calculé (`pilots-index.json`, ~79 Mo, régénéré chaque semaine) + un index UCI (`uci-index.json`, ~3 Mo) ajouté récemment. Déployée sur GitHub Pages. Aucun build, aucun framework, **aucun test**.

Points forts constatés :
- Échappement systématique des données via `escape()` (bonne hygiène XSS) ; liens externes `rel="noopener"`.
- Base accessibilité déjà solide (focus-visible, contrastes, touch targets — cf. historique de commits).
- Pipeline de données propre (index pré-calculé → scan mémoire → rendu), architecture multi-régions récemment refactorée.

---

## 2. Constats par domaine

### A. Code mort & PWA inerte

| Constat | Preuve | Impact |
|---|---|---|
| **Bloc cache API Sqorz mort** (`fetchJsonCached`, `_cache`, `persistCache`, `ttlFor`, `clearSqorzCache`, consts `CACHE_*`) : jamais appelé, et il référence une fonction `fetchJson` **inexistante** (bug latent : planterait si appelé). | `grep fetchJson` : seules les lignes 1398/1402 dans index.html | ~40 lignes de dette + bug caché. **Supprimer.** |
| **Service worker jamais enregistré** — `service-worker.js` n'est référencé nulle part dans `index.html` (0 occurrence). | `code_search serviceWorker` : 0 résultat | Pas d'offline, fichier inerte. **Enregistrer (avec chemins relatifs, cf. infra) ou supprimer.** |
| **`manifest.json` + `icons/` jamais référencés** — pas de `<link rel="manifest">`, pas d'`apple-touch-icon`, pas de meta `theme-color`. | `code_search manifest/theme-color` : 0 résultat | PWA entièrement inerte alors que le manifest est promis. **Soit finaliser la PWA, soit retirer.** |
| `computeStats()` calcule `byClass` (meilleure catégorie) qui n'est **jamais affiché**. | lignes 2021-2024 vs aucun usage en rendu | Gâchis de calcul + fonctionnalité prête à l'emploi. |
| `spec.md` obsolète (produit bien plus avancé). | lecture | Documenter ou archiver. |

### B. Performance (le sujet n°1)

1. **Gel du thread principal au chargement** : `JSON.parse` de ~79 Mo + `expandIndex()` sur le thread UI → blocage de plusieurs secondes (pire sur mobile). Vérifié : l'index fait 78,9 Mo (75 Mo en `Content-Length`), mémoire heap ~400-600 Mo.
2. **Autocomplétion sans debounce** : `searchPilotsForAc()` scanne l'index complet **à chaque frappe** (`input` → `updateDropdown(searchPilotsForAc(input.value))`, ligne 1604). Pour un nom court, plusieurs millions d'entrées parcourues → latence visible.
3. **Recherche O(entier de l'index)** à chaque recherche : acceptable pour un clic, mais couplé à l'autocomplétion ça devient coûteux.
4. **Poids réseau** : 79 Mo (gzip ~15-20 Mo) à télécharger à chaque session (index non caché en localStorage — seul le *résultat* de recherche est caché 6 h).

### C. Infrastructure & déploiement

1. **Croissance du repo git (98 Mo mesurés)** : `pilots-index.json` (79 Mo) est committé **chaque semaine** par le workflow. Le champ `generated` (timestamp) change à chaque build → commit hebdo systématique, même sans changement de données. Risque : limite GitHub (avertissement 50 Mo, limite dure 100 Mo/fichier), clones très lents, historique qui gonfle.
2. **Aucun test** : ni unitaire (`node --test` possible), ni e2e, ni validation de forme de l'index dans le workflow. Une régression (ex. le bug `fetchJson`) peut passer inaperçue.
3. **Service worker (si activé) à corriger pour le sous-chemin** : `ASSETS = ['/', '/index.html']` — sur `ludsoc.github.io/sqorz-stats/`, `/` pointe vers la racine du domaine. Utiliser des chemins relatifs (`'./'`, `'./index.html'`). *(corrigé avec la stratégie réseau d'abord, chemins relatifs)*
4. **Service worker (si activé) à corriger pour le sous-chemin** : `ASSETS = ['/', '/index.html']` — sur `ludsoc.github.io/sqorz-stats/`, `/` pointe vers la racine du domaine. Utiliser des chemins relatifs (`'./'`, `'./index.html'`).

### D. Robustesse

1. Échec de l'index UCI **silencieux** (`.catch` → on continue sans) : acceptable, mais un message discret (« données UCI indisponibles ») serait plus clair.
2. `saveResultsCache` : pour un nom courant (ex. « dupont » → 257 événements), le payload slim peut approcher le quota localStorage (5 Mo) → échec silencieux (attrapé) → re-scan à chaque visite. À surveiller ou à plafonner (ex. garder les 100 premiers résultats).
3. Aucun monitoring/alerting si la régénération hebdo de l'index échoue (pas de notification en cas de changement de l'API Sqorz).

### E. Accessibilité & UX

1. **Onglets** : pas de navigation clavier (flèches), `aria-controls` / `aria-labelledby` manquants entre `role="tab"` et `role="tabpanel"`.
2. **SVG des graphiques** : pas de `role="img"` / `aria-label` (seuls quelques `<title>` existent).
3. **`aria-live="polite"` sur `#results`** : l'annonce du HTML complet des résultats aux lecteurs d'écran peut être très verbeuse — préférer un résumé court dans un `aria-live` dédié.
4. Pas de `<noscript>`.
5. Rendu : sections pliables, thème auto/clair/sombre, timeline animée (IntersectionObserver) — bien.

### F. Sécurité

- Échappement cohérent (`escape()`) sur les données pilotes/clubs/événements → RAS.
- `rel="noopener noreferrer"` sur tous les liens externes → RAS.
- Aucune donnée sensible stockée. L'URL partagée (`?name=`) ne contient que le nom du pilote.

### G. Données

1. **Index UCI = Challenge uniquement** (classes par âge ; pas d'Élite/Junior — vérifié sur les événements bruts 2024-2026). Les pilotes Élite français n'apparaîtront pas dans l'onglet UCI tant que les Mondiaux Élite ne seront pas publiés ailleurs sur Sqorz.
2. Couverture : FR + UCI seulement. L'architecture multi-régions permet d'ajouter d'autres pays facilement.
3. Les données sont figées à la régénération hebdo : délai d'une semaine entre un résultat et sa disponibilité.

---

## 3. Améliorations proposées (priorisées)

### 🔴 Priorité haute — fiabilité & performance

1. **Web Worker pour le parse + la recherche** : déplacer `JSON.parse` + `expandIndex` + `searchInIndex`/`searchPilotsForAc` dans un worker → zéro gel UI, mémoire isolée. (Changement structuré : l'app passe en `postMessage`.)
2. **Optimiser l'autocomplétion** : debounce (~150-200 ms) + pré-index léger des noms (nom → {count, groupName}) construit une fois au chargement (ou dans le worker), pour ne plus scanner 79 Mo à chaque frappe.
3. **Sortir `pilots-index.json` du dépôt git** : l'héberger sur un CDN/objet (R2 public, GitHub Releases, ou branche dédiée) et committer seulement un pointeur de version. Arrête la croissance du repo (98 Mo) et le risque de limite GitHub. Le workflow uploade + commit le numéro de version.
4. **Supprimer le code mort** (bloc cache API + `fetchJson` inexistant) et **trancher la PWA** : soit enregistrer le SW avec chemins relatifs + lier `manifest.json`/icônes, soit retirer ces fichiers.
5. **Tests minimaux + CI** : `node --test` sur `norm`, `specialResultLabel`, `computeStats`, `slimCompetitor` (extraire ces fonctions pures dans un module partagé) ; dans le workflow : `node --check` + validation de la forme de l'index (présence de `events`/`series`, tailles attendues).

### 🟡 Priorité moyenne — fonctionnalités utiles

6. **Afficher la « meilleure catégorie »** (`byClass` déjà calculé) dans le dashboard.
7. **Export CSV** des résultats du pilote (bouton, ~15 lignes de code, très demandé).
8. **Navigation clavier des onglets** + `aria-controls`/`aria-labelledby` + `role="img"`/`aria-label` sur les SVG.
9. **Filtres dans les résultats** : par catégorie (`perpetualClassCode`) et par club (`groupName`).
10. **Deep-link du pilote homonyme** : `?name=…&pilot=<clé normalisée>` pour figer la sélection du `pilot-picker`.
11. **Réduire la taille de l'index** : ne garder que les champs utilisés par le rendu, compresser (champs déjà courts), envisager un split par année/lettre chargé à la demande, ou un format binaire/`ArrayBuffer` (~3-5× plus léger).

### 🟢 Idées d'ajouts (vision produit)

12. **Mondiaux Élite/Junior UCI** : chercher sous quels comptes Sqorz ils sont publiés (fédérations hôtes ?) et les ajouter à `buildRegion`.
13. **Multi-pays** (BE, CH, NL, IT…) : l'architecture `buildRegion(regionCode, outFile)` + chargement optionnel le permet déjà — l'onglet « 🌍 » pourrait devenir multi-régions.
14. **Graphique de progression des points de série** par manche (données `seriesRankCompetitorEvents` déjà disponibles).
15. **« Nouveaux résultats »** : comparer la date du dernier résultat à la dernière visite (localStorage) et le signaler.
16. **Comparaison de 3-4 pilotes** (au-delà du H2H actuel).
17. **Impression/PDF** : feuille CSS `@media print` propre pour la fiche pilote.
18. **i18n EN** (le README est déjà bilingue ; le code ne l'est pas).
19. **Analytics léger et respectueux de la vie privée** (ex. Plausible/GoatCounter, à choisir via un comparatif) — optionnel.

---

## 4. Risques principaux

| Risque | Gravité | Mitigation |
|---|---|---|
| Croissance git (~98 Mo, +79 Mo/semaine) → limite GitHub, clones lents | Élevée | Sortir l'index du repo (n°3) |
| Gel UI de plusieurs secondes au chargement (mobile) | Élevée | Web Worker (n°1) |
| Régénération hebdo silencieusement cassée (API Sqorz change) | Moyenne | Tests + validation CI + alerte workflow |
| Autocomplétion lente sur requêtes courtes | Moyenne | Debounce + pré-index (n°2) |
| Quota localStorage dépassé sur noms courants (cache résultats) | Faible | Plafonner le cache |

---

## 5. Résumé exécutif

Le projet est sain fonctionnellement (bonnes pratiques XSS/a11y, pipeline de données clair, feature UCI proprement intégrée). Les deux chantiers qui comptent vraiment : **(1) la performance de chargement** (Web Worker + autocomplétion), et **(2) l'infrastructure git** (l'index de 79 Mo committé chaque semaine fait grossir le repo — le sortir de git). Viennent ensuite : suppression du code mort / PWA inerte, tests minimaux, et les fonctionnalités « meilleure catégorie » / export CSV / filtres / onglets accessibles.

## 6. Suivi d'avancement

- ✅ **Action 2** (autocomplétion) : debounce 150 ms + pré-index des noms (`nameIndex`/`buildNameIndex`) — parité vérifiée sur les vraies données.
- ✅ **Action 4** (code mort + PWA) : bloc `sqorzCache`/`fetchJsonCached` supprimé (et son bug latent `fetchJson` inexistant) ; PWA finalisée — manifest lié (`start_url`/`scope` relatifs), SW enregistré (`sqorz-v2`, chemins relatifs, `NO_CACHE` sur les index, fallback de navigation).
- ⬜ **Action 1** (Web Worker) — pas encore fait.
- ⬜ **Action 3** (sortir l'index du repo git) — pas encore fait.
- ⬜ **Action 5** (tests + CI) — pas encore fait.
