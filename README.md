# Stats Pilote BMX

**[🇬🇧 English](#english) · [🇫🇷 Français](#français)**

Part of [BMX-Race Hub](https://ludsoc.github.io/bmx-race-hub/) — BMX Race statistics tools.

---

## English

Look up any BMX Race pilot and explore their full history: results by event, progression over time, category rankings, and multi-pilot comparisons.

### Features

- Full-text pilot search across all French BMX organizations
- Complete result history per event and per category
- Z-score progression chart (normalized performance metric)
- Multi-pilot comparison on the same chart
- Championship series rankings
- Shareable URL (saves selected pilot)

### Live

**[ludsoc.github.io/bmx-race-stats](https://ludsoc.github.io/bmx-race-stats/)**

### Tech

HTML/CSS/JS, no framework, no build step. Shared core (`BmxCommon` in `common.js`: utils, index loader, perf index). Pilot index pre-built from the public [Sqorz API](https://our.sqorz.com), refreshed weekly. Cloudflare Worker used as an API cache proxy.

> Community project, not affiliated with Sqorz.

---

## Français

Recherchez n'importe quel pilote BMX Race et explorez son historique complet : résultats par événement, progression dans le temps, classements par catégorie et comparaisons multi-pilotes.

### Fonctionnalités

- Recherche plein texte sur l'ensemble des organisations BMX françaises
- Historique complet des résultats par événement et par catégorie
- Graphique de progression par score Z (métrique de performance normalisée)
- Comparaison multi-pilotes sur le même graphique
- Classements de championnats (séries)
- URL partageable (mémorise le pilote sélectionné)

### Accès

**[ludsoc.github.io/bmx-race-stats](https://ludsoc.github.io/bmx-race-stats/)**

### Technique

HTML/CSS/JS, sans framework, sans étape de build. Socle partagé (`BmxCommon` dans `common.js` : utils, chargeur d'index, indice de perf). Index des pilotes pré-construit depuis l'[API publique Sqorz](https://our.sqorz.com), rafraîchi chaque semaine. Worker Cloudflare utilisé comme proxy de cache API.

> Projet communautaire non officiel, non affilié à Sqorz.

## Licence

Ce projet est sous licence **GNU Affero General Public License v3 (AGPLv3)** — voir `LICENSE`.

Concrètement : vous pouvez utiliser, modifier et repartager ce code (y compris hébergé
sur le web), **à condition de repartager vos modifications sous la même licence**.
© 2026 ludovic.socie — versions antérieures au 14/09/2026 diffusées sous licence MIT.
