// Classement perf : pré-calcule l'indice (fenêtre 365 j, pool FR+ : pilotes français,
// toutes courses) pour ranking_stats.
// Usage : node tools/build-perf-rankings.cjs
// Entrées : ../pilots-index.json + ../field-strength-fr.json (FR),
//   ../uec-index.json + ../field-strength-uec.json (UEC),
//   ../uci-index.json, sans force de plateau (Mondiaux, coef seul).
// Sortie : ../perf-rankings.json (+ trend vs build précédent si présent).
// Ligne : { n, club, cat, e, score, trend } + `cr` (nb d'engagements cruiser) si > 0
// (badge ⇄ côté app quand 0 < cr < e)
// + `by` (année de naissance majoritaire, pour le filtre âge réel côté app).
// `club` = club dominant des engagements FR seuls (groupName UEC/UCI = pays, ignoré).
// `cat` = catégorie dominante toutes sources (libellés EN possibles côté UEC/UCI).
// Pool = pilotes FRANÇAIS : ≥1 engagement FR avec un groupement club (les groupements
// vus en UEC/UCI sont des codes pays — un étranger en course FR sort du pool).
// Mais TOUTES leurs courses comptent (FR + UEC + UCI).
// Formule identique à la partie Global de sqorz_stats, SANS les séries (courses uniquement).
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SQORZ = path.join(DIR, '..');
const commonSrc = fs.readFileSync(path.join(SQORZ, 'common.js'), 'utf8');
const SC = new Function('window', commonSrc + '\nreturn window.SqorzCommon;')({});
const NATIONAL = new Set(['ffc', 'ffcbmxne', 'ffcbmxno', 'ffcbmxso', 'ffcbmxsudest']);

// Sources fusionnées par nom normalisé (un pilote FR+UEC+UCI n'a qu'une ligne).
// groupName UEC/UCI = pays (pas un club) : seuls les engagements FR votent pour `club`.
const SOURCES = [
  { tag: 'FR', index: 'pilots-index.json', field: 'field-strength-fr.json', club: true,
    coef: ev => (NATIONAL.has(ev.account && ev.account.accountCode) ? 1.0 : 0.93) },
  { tag: 'UEC', index: 'uec-index.json', field: 'field-strength-uec.json', club: false,
    coef: () => SC.PERF_LEVEL_COEFS.uec },
  { tag: 'UCI', index: 'uci-index.json', field: null, club: false,
    coef: () => SC.PERF_LEVEL_COEFS.uci },
  { tag: 'WC', index: 'uci-worldcup-index.json', field: null, club: false,
    coef: () => SC.PERF_LEVEL_COEFS.uci },
];
const loaded = [];
for (const s of SOURCES) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(SQORZ, s.index), 'utf8'));
    const field = s.field ? JSON.parse(fs.readFileSync(path.join(SQORZ, s.field), 'utf8')) : null;
    loaded.push({ ...s, idx, field, expanded: SC.expandIndex(idx), byClass: new Map() });
  } catch (e) { console.warn(`source ${s.tag} ignorée (${s.index}) : ${e.message}`); }
}
if (!loaded.length) throw new Error('aucune source de données');

// Codes pays = groupements vus en UEC/UCI (par construction). Un groupement FR qui en
// est un désigne un étranger en course FR — pas un club, ne qualifie pas pour le pool.
const COUNTRIES = new Set();
for (const src of loaded) {
  if (src.tag === 'FR') continue;
  for (const ev of (src.idx.events || [])) {
    for (const cls of (ev.classes || [])) {
      for (const c of (cls.competitors || [])) {
        const g = ((c.groupName || c.gn) || '').trim().toUpperCase(); // slim (gn) ou expansé
        if (g) COUNTRIES.add(g);
      }
    }
  }
}

// Fenêtre 365 j ancrée sur la dernière donnée toutes sources (robuste aux builds en retard).
let maxD = '';
for (const src of loaded) {
  for (const ev of (src.idx.events || [])) {
    const d = ev.event.eventDate || '';
    if (d > maxD) maxD = d;
  }
}
const since = String(Number(maxD.slice(0, 4)) - 1) + maxD.slice(4);

// Groupement par classe et par source (pour le chrono : meilleurs temps de LA classe).
const t0 = Date.now();
for (const src of loaded) {
  for (const ev of (src.expanded.events || [])) {
    const date = ev.event.eventDate || '';
    if (date < since) continue;
    for (const cls of (ev.classes || [])) {
      const ck = src.tag + '|' + ev.event.eventId + '|' + (cls.perpetualClassCode || cls.className || '');
      if (!src.byClass.has(ck)) src.byClass.set(ck, []);
      const arr = src.byClass.get(ck);
      for (const c of (cls.competitors || [])) arr.push(c);
    }
  }
}

// Score d'un engagement (miroir de perfEngagement dans sqorz_stats/index.html).
function engagementScore(m, comps) {
  const c = m.competitor || {};
  const rk = c.rank;
  if (typeof rk !== 'number' || rk >= 100000) {
    const depth = SC.perfDeepestPhase(c.competitorRankDetails);
    return { raw: SC.PERF_DNF_SCORES[depth] ?? SC.PERF_DNF_SCORES.moto, nDnf: 1 };
  }
  const sr = SC.perfScoreRang(rk, m.totalParticipants) ?? 250;
  const cc = SC.perfCoefConstance(SC.perfConstance(c.competitorRankDetails, rk));
  let chrono = null;
  if (comps) {
    const bests = [];
    for (const cp of comps) { const bt = SC.perfBestTime(cp.competitorRankDetails); if (bt != null) bests.push(bt); }
    if (bests.length >= 3) chrono = SC.perfChronoScore(bests, SC.perfBestTime(c.competitorRankDetails));
  }
  const raw = chrono == null ? sr * cc : (sr * cc + SC.PERF_CHRONO_W * chrono) / (1 + SC.PERF_CHRONO_W);
  return { raw, nDnf: 0 };
}

const norm = s => (s || '').toString().toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').trim().replace(/\s+/g, ' ');
// Monture : même règle que isCruiserCat côté app (ranking_stats) — code CR* ou libellé cruiser.
function isCruiserCat(cls) {
  const code = ((cls && cls.perpetualClassCode) || '').toUpperCase();
  if (code.startsWith('CR')) return true;
  return /cruiser/i.test((cls && cls.className) || '');
}
const pilots = new Map(); // key -> { n, scores, w, e, fr, cru, byVotes:Map, clubs:Map, cats:Map, catNames:Map }
for (const src of loaded) {
const expanded = src.expanded;
const byClass = src.byClass;
const field = src.field;
for (const ev of (expanded.events || [])) {
  const date = ev.event.eventDate || '';
  if (date < since) continue;
  const year = date.slice(0, 4);
  const coef = src.coef(ev);
  for (const cls of (ev.classes || [])) {
    const ck = src.tag + '|' + ev.event.eventId + '|' + (cls.perpetualClassCode || cls.className || '');
    const comps = byClass.get(ck) || null;
    const total = cls.total || (cls.competitors || []).length;
    const fsKey = (ev.account && ev.account.accountCode) + '/' + ev.event.eventId + '/' + (cls.perpetualClassCode || cls.className || '');
    for (const c of (cls.competitors || [])) {
      const name = `${c.firstName || ''} ${c.lastName || ''}`.trim();
      if (!name) continue;
      const { raw, nDnf } = engagementScore({ competitor: c, totalParticipants: total }, comps);
      const score = SC.applyFieldScore(raw, coef, fsKey, year, field, nDnf);
      let p = pilots.get(norm(name));
      if (!p) { p = { n: name, scores: 0, w: 0, e: 0, fr: 0, cru: 0, byVotes: new Map(), clubs: new Map(), cats: new Map(), catNames: new Map() }; pilots.set(norm(name), p); }
      p.scores += score;
      p.w += SC.perfWeight(total, nDnf);
      p.e++;
      // Club FR réel : groupement non vide et pas un code pays (les étrangers en course
      // FR votent avec leur pays). Seuls ces engagements qualifient pour le pool.
      const gn = (c.groupName || '').trim();
      if (src.club && gn && !COUNTRIES.has(gn.toUpperCase())) {
        p.fr++;
        p.clubs.set(gn, (p.clubs.get(gn) || 0) + 1);
      }
      if (isCruiserCat(cls)) p.cru++;
      // Année de naissance : votes (année d'épreuve − âge) par engagement (âge sportif).
      if (Number.isInteger(c.age) && c.age >= 3 && c.age <= 80) {
        const byy = Number(year) - c.age;
        if (byy > 1900) p.byVotes.set(byy, (p.byVotes.get(byy) || 0) + 1);
      }
      const catCode = cls.perpetualClassCode || cls.className || '';
      if (catCode) {
        p.cats.set(catCode, (p.cats.get(catCode) || 0) + 1);
        if (cls.className) {
          const nm = p.catNames.get(catCode) || new Map();
          nm.set(cls.className, (nm.get(cls.className) || 0) + 1);
          p.catNames.set(catCode, nm);
        }
      }
    }
  }
} // fin for ev
} // fin for src

const rows = [];
const catLegend = new Map(); // code -> nom affiché
for (const p of pilots.values()) {
  if (p.e < 3) continue;
  if (!p.fr) continue; // pool français : ≥1 engagement FR avec un club réel
  const mean = p.scores / p.e;
  const score = Math.round(SC.perfShrinkMean(mean, p.w));
  const club = [...p.clubs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const cat = [...p.cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const catName = [...((p.catNames.get(cat) || new Map()).entries())].sort((a, b) => b[1] - a[1])[0]?.[0] || cat;
  if (cat && !catLegend.has(cat)) catLegend.set(cat, catName);
  const row = { n: p.n, club, cat, e: p.e, score };
  if (p.cru > 0) row.cr = p.cru; // engagements cruiser (mixte 20"+cruiser si 0 < cr < e)
  if (p.byVotes.size) {
    // Année de naissance majoritaire (écarts résiduels = anniversaires en saison ou homonymes).
    row.by = [...p.byVotes.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  }
  rows.push(row);
}
rows.sort((a, b) => b.score - a.score || b.e - a.e || (a.n < b.n ? -1 : 1));

// Rangs standard (1,2,2,4) : position de la 1re ligne à ce score (lignes triées
// score desc, e desc, nom asc — même ordre recalculé côté app, champ non stocké).
// Trend vs build précédent (fichier déjà en place, sinon "N").
function stdRanks(sorted) {
  const map = new Map();
  let rank = 0, prevScore = null;
  sorted.forEach((r, i) => {
    if (r.score !== prevScore) { rank = i + 1; prevScore = r.score; }
    if (!map.has(r.n)) map.set(r.n, rank);
  });
  return map;
}
const outPath = path.join(SQORZ, 'perf-rankings.json');
let prev = new Map();
try {
  const old = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const oldSorted = [...(old.rows || [])].sort((a, b) => b.score - a.score || b.e - a.e || (a.n < b.n ? -1 : 1));
  prev = stdRanks(oldSorted);
} catch {}
const cur = stdRanks(rows);
rows.forEach(r => {
  const pr = prev.get(r.n);
  r.trend = pr == null ? 'N' : pr - cur.get(r.n);
});

const out = {
  _meta: { generated: new Date().toISOString().slice(0, 10), windowFrom: since, windowTo: maxD, pool: 'FR+', count: rows.length },
  cats: Object.fromEntries(catLegend),
  rows,
};
fs.writeFileSync(outPath, JSON.stringify(out) + '\n');
console.log(`rows: ${rows.length}, fenêtre ${since} → ${maxD}, taille: ${(fs.statSync(outPath).size / 1024).toFixed(0)} Ko, ${(Date.now() - t0) / 1000}s`);
