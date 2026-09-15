#!/usr/bin/env node
// Calcule les forces de plateau (field strength) par classe, pour l'indice v2.
// Spec : docs/superpowers/specs/2026-09-08-force-plateau-shrinkage-design.md
//
// Helper partagé par build-index.js (FR+UCI → field-strength-fr.json) et
// build-uec.js (UEC → field-strength-uec.json). Les deux scripts restent
// indépendants (pas de dépendance d'ordre) : chaque fichier couvre sa source.
//
// Unités : scores RAW (pré-coef — la force vient des identités, pas des coefs ;
// le coef niveau s'applique côté client APRÈS ajustement). Sortie par classe :
// [fs, n] (fs = moyenne inclusive, n = classés notés) ; l'exclusion de soi-même
// se fait côté client (formule exacte, sans surcoût de stockage).
//
// Usage :
//   const { computeFieldFiles } = require('./build-field.js');
//   computeFieldFiles(['pilots-index.json', 'uci-index.json'],
//     { outFile: 'field-strength-fr.json', k: 0.3, passes: 2, label: 'FR+UCI' });
//
// CLI (sans crawl, depuis des index existants) :
//   node build-field.js pilots-index.json uci-index.json field-strength-fr.json
//   node build-field.js uec-index.json field-strength-uec.json
//
// Le scoring reproduit la formule v1 sur données SLIM (clés courtes) — parité
// avec le client vérifiée par tests/field-strength.test.js.

const { createHash } = require('crypto');
const fs = require('fs');

const PERF_FIELD_K = 0.3;   // (dupliqué côté client : BmxCommon.PERF_FIELD_K — testé égal)
const FIELD_PASSES = 2;

const norm = s => (s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

function zScore(rank, total) {
  if (!total || total < 2 || typeof rank !== 'number') return null;
  const mu = (total + 1) / 2;
  const sigma = Math.sqrt((total * total - 1) / 12);
  if (!sigma) return null;
  return (mu - rank) / sigma;
}
const perfClamp = v => Math.max(5, Math.min(1000, v));
function perfScoreRang(rank, total) {
  const z = zScore(rank, total);
  if (z == null) return null;
  if (z <= 0) return perfClamp(500 + 500 * z / Math.sqrt(3));
  return perfClamp(500 + 500 * Math.pow(Math.min(1, z / Math.sqrt(3)), 2.5));
}
function isFinalPhase(n) {
  n = (n || '').toLowerCase();
  if (!/final/.test(n)) return false;
  if (/semi|demi|quarter|quart|\d+\/|\d+.?[èe]me|\d+°|eighth|repech|petit|last.chance/.test(n)) return false;
  return true;
}
const isMotoPhase = n => /^moto/i.test(n || '');
function perfHasKnockout(details) {
  for (const d of details || []) {
    if (/semi|demi|quart|quarter|1\/8|1\/16|huitieme|seizieme/.test((d.n || '').toLowerCase())) return true;
  }
  return false;
}
function perfConstance(details, rank) {
  let validMotos = 0, top4 = 0;
  for (const d of details || []) {
    if (!isMotoPhase(d.n)) continue;
    if (typeof d.r === 'number' && d.r < 100000) { validMotos++; if (d.r <= 4) top4++; }
  }
  const pctTop4 = validMotos ? top4 / validMotos : 0.5;
  let finaleOk = false;
  for (const d of details || []) {
    if (isFinalPhase(d.n) && typeof d.r === 'number' && d.r < 100000) { finaleOk = true; break; }
  }
  if (!finaleOk && typeof rank === 'number' && rank < 100000 && !perfHasKnockout(details)) finaleOk = true;
  return 0.5 * pctTop4 + 0.5 * (finaleOk ? 1 : 0.4);
}
const perfCoefConstance = c => 0.95 + 0.1 * c;
function perfDeepestPhase(details) {
  const order = { final: 3, semi: 2, quarter: 1, moto: 0 };
  let depth = 'moto';
  for (const d of details || []) {
    const n = d.n || '';
    const t = isFinalPhase(n) ? 'final'
      : /semi|demi/i.test(n) ? 'semi'
      : /quart|quarter|1\/4/i.test(n) ? 'quarter'
      : 'moto';
    if (order[t] > order[depth]) depth = t;
  }
  return depth;
}
const PERF_DNF_SCORES = { final: 700, semi: 550, quarter: 400, moto: 250 };
function bestTimeSlim(slimD) {
  let b = null;
  for (const d of slimD || []) {
    if (d == null || d.r == null || Number(d.r) >= 100000) continue;
    const v = parseFloat(d.tm);
    if (isFinite(v) && v > 0 && (b == null || v < b)) b = v;
  }
  return b;
}
function chronoScoreSlim(allBests, pilotBest) {
  if (pilotBest == null || !allBests || allBests.length < 3) return null;
  const logs = allBests.map(Math.log);
  const mu = logs.reduce((a, b) => a + b, 0) / logs.length;
  const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / logs.length) || 1;
  if (!sd) return null;
  return perfClamp(500 + 500 * (mu - Math.log(pilotBest)) / sd / Math.sqrt(3));
}

// Clé de classe = même convention que findClassCompetitors côté client.
const classKey = (accountCode, eventId, code) => `${accountCode}/${eventId}/${code || ''}`;

// Score RAW v1 d'un engagement (données slim, SANS coef, SANS clamp final) →
// { raw, valid }. Le client applique coef + clamp APRÈS ajustement plateau.
function scoreRaw(rank, total, slimD, bests) {
  if (typeof rank !== 'number' || rank >= 100000) {
    return { raw: PERF_DNF_SCORES[perfDeepestPhase(slimD || [])], valid: false };
  }
  const sr = perfScoreRang(rank, total) ?? 250;
  const cc = perfCoefConstance(perfConstance(slimD || [], rank));
  let chrono = null;
  if (bests && bests.length >= 3) chrono = chronoScoreSlim(bests, bestTimeSlim(slimD));
  return { raw: chrono == null ? sr * cc : (sr * cc + 0.3 * chrono) / 1.3, valid: true };
}
function yearOf(d) { return (d || '').slice(0, 4); }

// Année d'un classement de série = dernier événement connu (règle client perfSeriesScore).
function seriesYear(sm) {
  let maxDate = '';
  for (const e of sm.rankEvents || []) {
    const d = e.eventDate || e.eventEndDate || '';
    if (d > maxDate) maxDate = d;
  }
  return yearOf(maxDate);
}

function computeFieldFiles(inFiles, { outFile, metaFile, k = PERF_FIELD_K, label = '' }) {
  const tag = label ? `[${label}] ` : '';
  const indexes = inFiles.map(f => ({ file: f, index: JSON.parse(fs.readFileSync(f, 'utf8')) }));
  // Bests chrono par classe (mémoïsé) — reproduit findClassCompetitors.
  const bestsCache = new Map();
  const getBests = (idx, accountCode, eventId, code, className) => {
    const key = classKey(accountCode, eventId, code || className);
    if (bestsCache.has(key)) return bestsCache.get(key);
    const out = [];
    for (const ev of idx.events || []) {
      if (ev.account.accountCode !== accountCode || ev.event.eventId !== eventId) continue;
      for (const cl of ev.classes || []) {
        if (!((code && cl.perpetualClassCode === code) || (!code && cl.className === className))) continue;
        for (const c of cl.competitors || []) {
          const bt = bestTimeSlim(c.d);
          if (bt != null) out.push(bt);
        }
      }
    }
    bestsCache.set(key, out);
    return out;
  };

  // Collecte des engagements (événements + séries), scores RAW v1.
  const engs = [];
  for (const { index } of indexes) {
    for (const ev of index.events || []) {
      const year = yearOf(ev.event.eventDate);
      if (!/^\d{4}$/.test(year)) continue;
      for (const cls of ev.classes || []) {
        const bests = getBests(index, ev.account.accountCode, ev.event.eventId, cls.perpetualClassCode, cls.className);
        const total = cls.total || (cls.competitors || []).length;
        for (const c of cls.competitors || []) {
          const key = norm((c.fn || '') + ' ' + (c.ln || ''));
          if (!key) continue;
          const { raw, valid } = scoreRaw(c.rank, total, c.d, bests);
          engs.push({
            key, year, raw, valid,
            clsKey: classKey(ev.account.accountCode, ev.event.eventId, cls.perpetualClassCode || cls.className),
          });
        }
      }
    }
    for (const sr of index.series || []) {
      const year = seriesYear(sr);
      if (!/^\d{4}$/.test(year)) continue;
      for (const cls of sr.classes || []) {
        const S = cls.total || (cls.competitors || []).length;
        for (const c of cls.competitors || []) {
          const key = norm((c.fn || '') + ' ' + (c.ln || ''));
          if (!key) continue;
          const s = (typeof c.sr === 'number' && c.sr < 100000)
            ? (perfScoreRang(c.sr, S) ?? 250)
            : 250;
          engs.push({
            key, year, raw: s, valid: true,
            clsKey: `${sr.account.accountCode}/series:${(sr.series && sr.series.seriesId) || ''}/${cls.perpetualClassCode || cls.className || ''}`,
          });
        }
      }
    }
  }

  // Ratings annuels (moyenne des RAW clampés, comme l'affichage pré-coef).
  const ratings = valKey => {
    const m = new Map();
    for (const e of engs) {
      if (!m.has(e.year)) m.set(e.year, new Map());
      const ym = m.get(e.year);
      if (!ym.has(e.key)) ym.set(e.key, { sum: 0, n: 0 });
      const o = ym.get(e.key); o.sum += e[valKey]; o.n++;
    }
    for (const [, ym] of m) for (const [, o] of ym) o.mean = o.sum / o.n;
    return m; // year -> key -> {sum,n,mean}
  };
  for (const e of engs) e.base = perfClamp(e.raw);
  // Une passe : fs INCLUSIVES via ratings, recentrage medFs. Retourne aussi la conv.
  const fieldPass = (R, K, outKey, prevKey) => {
    const byYear = new Map();
    const years = [...new Set(engs.map(e => e.year))];
    for (const Y of years) {
      const arr = engs.filter(x => x.year === Y && x.valid);
      const byCls = new Map();
      for (const e of arr) {
        if (!byCls.has(e.clsKey)) byCls.set(e.clsKey, []);
        byCls.get(e.clsKey).push(e);
      }
      const rY = R.get(Y) || new Map();
      const fsOf = new Map(), allFs = [];
      for (const [, g] of byCls) {
        let sum = 0, n = 0;
        for (const x of g) { const r = rY.get(x.key); if (r != null) { sum += r.mean; n++; } }
        if (!n) continue;
        const f = sum / n;
        for (const x of g) { fsOf.set(x, { fs: f, n }); }
        allFs.push(f);
      }
      allFs.sort((a, b) => a - b);
      const medFs = allFs.length ? allFs[Math.floor(allFs.length / 2)] : 500;
      let sum = 0, conv = 0;
      for (const e of engs.filter(x => x.year === Y)) {
        e[outKey] = e.valid ? perfClamp(e.base + K * ((fsOf.get(e)?.fs ?? medFs) - medFs)) : e.base;
        if (e.valid) {
          sum += e[outKey] - e.base;
          if (prevKey) conv += Math.abs(e[outKey] - e[prevKey]);
        }
      }
      byYear.set(Y, { fsOf, medFs: Math.round(medFs), meanAdj: sum / (arr.length || 1), conv: prevKey ? conv / (arr.length || 1) : 0 });
    }
    return byYear;
  };

  let R = ratings('base');
  const p1 = fieldPass(R, k, 'adj1', null);
  R = ratings('adj1');
  const p2 = fieldPass(R, k, 'adj2', 'adj1');

  // Sortie : [fs, n] par classe + medFs par année.
  const classes = {};
  for (const [, info] of p2) for (const [e, f] of info.fsOf) classes[e.clsKey] = [Math.round(f.fs), f.n];
  const medFs = {};
  for (const [Y, info] of p2) medFs[Y] = info.medFs;
  const generated = new Date().toISOString();
  const payload = { v: 1, generated, medFs, classes };
  const json = JSON.stringify(payload);
  fs.writeFileSync(outFile, json);
  const sha256 = createHash('sha256').update(json, 'utf8').digest('hex');
  const mf = metaFile || outFile.replace(/\.json$/, '.meta.json');
  fs.writeFileSync(mf, JSON.stringify({
    generated,
    index: { sha256, sizeBytes: Buffer.byteLength(json, 'utf8') },
  }, null, 2) + '\n');

  let convMax = 0;
  for (const [, info] of p2) convMax = Math.max(convMax, info.conv);
  console.log(`${tag}${engs.length} engagements, ${Object.keys(classes).length} classes, medFs ${JSON.stringify(medFs)}`);
  console.log(`${tag}convergence passe1→passe2 : |Δ| max ${convMax.toFixed(2)} ${convMax < 5 ? '✓' : '✗'}`);
  console.log(`${tag}→ ${outFile} (${(json.length / 1024).toFixed(0)} Ko) + ${mf}`);
  return { classes, medFs, generated };
}

if (require.main === module) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (args.length < 2) {
    console.error('Usage : node build-field.js <index.json...> <out.json>');
    process.exit(1);
  }
  computeFieldFiles(args.slice(0, -1), { outFile: args[args.length - 1], label: 'CLI' });
}

module.exports = { computeFieldFiles, classKey, PERF_FIELD_K, FIELD_PASSES, scoreRaw };
