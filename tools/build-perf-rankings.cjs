// Classement perf : pré-calcule l'indice (fenêtre 365 j, pool FR) pour ranking_stats.
// Usage : node tools/build-perf-rankings.cjs
// Entrées : ../pilots-index.json + ../field-strength-fr.json + ../../club_stats/clubs.json.
// Sortie : ../perf-rankings.json (+ trend vs build précédent si présent).
// Formule identique à la partie Global de sqorz_stats, SANS les séries (courses uniquement).
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SQORZ = path.join(DIR, '..');
const commonSrc = fs.readFileSync(path.join(SQORZ, 'common.js'), 'utf8');
const SC = new Function('window', commonSrc + '\nreturn window.SqorzCommon;')({});
const NATIONAL = new Set(['ffc', 'ffcbmxne', 'ffcbmxno', 'ffcbmxso', 'ffcbmxsudest']);

const idx = JSON.parse(fs.readFileSync(path.join(SQORZ, 'pilots-index.json'), 'utf8'));
const field = JSON.parse(fs.readFileSync(path.join(SQORZ, 'field-strength-fr.json'), 'utf8'));

// Fenêtre 365 j ancrée sur la dernière donnée (robuste aux builds en retard).
let maxD = '';
for (const ev of (idx.events || [])) {
  const d = ev.event.eventDate || '';
  if (d > maxD) maxD = d;
}
const since = String(Number(maxD.slice(0, 4)) - 1) + maxD.slice(4);

// Index FR expansé + groupement par classe (pour le chrono : meilleurs temps de LA classe).
const t0 = Date.now();
const expanded = SC.expandIndex(idx);
const byClass = new Map(); // `${eventId}|${code||name}` -> [expanded competitors]
for (const ev of (expanded.events || [])) {
  const date = ev.event.eventDate || '';
  if (date < since) continue;
  for (const cls of (ev.classes || [])) {
    const ck = ev.event.eventId + '|' + (cls.perpetualClassCode || cls.className || '');
    if (!byClass.has(ck)) byClass.set(ck, []);
    const arr = byClass.get(ck);
    for (const c of (cls.competitors || [])) arr.push(c);
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
const pilots = new Map(); // key -> { n, scores, w, e, clubs:Map, cats:Map, catNames:Map }
for (const ev of (expanded.events || [])) {
  const date = ev.event.eventDate || '';
  if (date < since) continue;
  const year = date.slice(0, 4);
  const coef = NATIONAL.has(ev.account && ev.account.accountCode) ? 1.0 : 0.93;
  for (const cls of (ev.classes || [])) {
    const ck = ev.event.eventId + '|' + (cls.perpetualClassCode || cls.className || '');
    const comps = byClass.get(ck) || null;
    const total = cls.total || (cls.competitors || []).length;
    const fsKey = (ev.account && ev.account.accountCode) + '/' + ev.event.eventId + '/' + (cls.perpetualClassCode || cls.className || '');
    for (const c of (cls.competitors || [])) {
      const name = `${c.firstName || ''} ${c.lastName || ''}`.trim();
      if (!name) continue;
      const { raw, nDnf } = engagementScore({ competitor: c, totalParticipants: total }, comps);
      const score = SC.applyFieldScore(raw, coef, fsKey, year, field, nDnf);
      let p = pilots.get(norm(name));
      if (!p) { p = { n: name, scores: 0, w: 0, e: 0, clubs: new Map(), cats: new Map(), catNames: new Map() }; pilots.set(norm(name), p); }
      p.scores += score;
      p.w += SC.perfWeight(total, nDnf);
      p.e++;
      if (c.groupName) p.clubs.set(c.groupName, (p.clubs.get(c.groupName) || 0) + 1);
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
}

const rows = [];
const catLegend = new Map(); // code -> nom affiché
for (const p of pilots.values()) {
  if (p.e < 3) continue;
  const mean = p.scores / p.e;
  const score = Math.round(SC.perfShrinkMean(mean, p.w));
  const club = [...p.clubs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const cat = [...p.cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  const catName = [...((p.catNames.get(cat) || new Map()).entries())].sort((a, b) => b[1] - a[1])[0]?.[0] || cat;
  if (cat && !catLegend.has(cat)) catLegend.set(cat, catName);
  rows.push({ n: p.n, club, cat, e: p.e, score });
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
  _meta: { generated: new Date().toISOString().slice(0, 10), windowFrom: since, windowTo: maxD, pool: 'FR', count: rows.length },
  cats: Object.fromEntries(catLegend),
  rows,
};
fs.writeFileSync(outPath, JSON.stringify(out) + '\n');
console.log(`rows: ${rows.length}, fenêtre ${since} → ${maxD}, taille: ${(fs.statSync(outPath).size / 1024).toFixed(0)} Ko, ${(Date.now() - t0) / 1000}s`);
