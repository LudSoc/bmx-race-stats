// Construit le mini-index de recherche du hub : tous les pilotes + clubs.
// Usage : node tools/build-hub-search.cjs [--top=1500]
// Entrées : ../pilots-index.json (80 Mo, R2/release) + clubs.json (canonique).
//   clubs.json est cherché dans bmx-race-tools/ (monorepo) puis dans l'ancien
//   ../club_stats/ — ce dernier chemin ne fonctionne plus depuis la fusion.
// Sortie : ../hub-search.json (~750 Ko en full), copié dans bmx-race-tools/stats/
//   par le cron (committé) puis par le workflow de sync du monorepo.
//
// RGPD : ce fichier liste TOUS les pilotes (nom + club + nb d'engagements) ; il
// doit donc être regénéré à chaque index ET filtré par la liste d'exclusion,
// sinon un pilote having demandé à être effacé y resterait (cf. build-exclusions.js).
const fs = require('fs');
const path = require('path');

const { normKey, normKeyAlias, loadExclusions, hmacHex } = require('../build-exclusions.js');

const topArg = process.argv.find(a => a.startsWith('--top='));
const TOP = topArg ? Math.max(100, parseInt(topArg.split('=')[1], 10) || 1500) : Infinity;
const DIR = __dirname;
const idx = JSON.parse(fs.readFileSync(path.join(DIR, '..', 'pilots-index.json'), 'utf8'));

// clubs.json : monorepo en priorité (existe aussi dans le site publié).
const CLUB_CANDIDATES = [
  path.join(DIR, '..', '..', 'bmx-race-tools', 'clubs.json'),
  path.join(DIR, '..', '..', 'club_stats', 'clubs.json'),
];
const clubPath = CLUB_CANDIDATES.find(p => fs.existsSync(p));
if (!clubPath) {
  console.error(`clubs.json introuvable — cherché dans :\n  ${CLUB_CANDIDATES.join('\n  ')}`);
  process.exit(1);
}
const clubs = JSON.parse(fs.readFileSync(clubPath, 'utf8'));

// Exclusions RGPD : un pilote exclu des index doit disparaître d'ici aussi.
// On filtre au niveau du nom (pas de compte/date ici : le hub est un agrégat
// global, on applique donc uniquement les règles sans `account`). La liste peut
// être en clair (tests) ou hmacée (production) : les deux formes sont gérées.
const exclusions = loadExclusions();
const excludedKeys = new Set();  // clés en clair
const excludedHmacs = new Set(); // empreintes
for (const map of [exclusions.byKey, exclusions.byHmac]) {
  for (const rules of map.values()) {
    for (const r of rules) {
      if (r.account) continue; // règle restreinte à une orga : pas d'effet ici
      if (r.hmac) excludedHmacs.add(r.hmac);
      else if (r.key) { excludedKeys.add(r.key); excludedKeys.add(r.alias); }
    }
  }
}
const isExcludedName = (fn, ln) => {
  if (excludedKeys.has(normKey(fn, ln)) || excludedKeys.has(normKeyAlias(fn, ln))) return true;
  if (excludedHmacs.size && exclusions.secret) return excludedHmacs.has(hmacHex(fn, ln, exclusions.secret));
  return false;
};

const freq = new Map(); // normKey -> { n, c, e }
const norm = s => (s || '').toString().toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]+/g, ' ').trim().replace(/\s+/g, ' ');
let total = 0;
let excludedHits = 0;
for (const ev of (idx.events || [])) {
  for (const cls of (ev.classes || [])) {
    for (const c of (cls.competitors || [])) {
      if (isExcludedName(c.fn, c.ln)) { excludedHits++; continue; }
      const name = `${c.fn || ''} ${c.ln || ''}`.trim();
      if (!name) continue;
      total++;
      const key = norm(name);
      const e = freq.get(key);
      if (e) { e.e++; if (c.gn && (!e.c || c.gn === e.c)) e.c = c.gn; }
      else freq.set(key, { n: name, c: c.gn || '', e: 1 });
    }
  }
}
// Club dominant par pilote (dernier vu le plus fréquent) : simple passe majoritaire.
const clubVotes = new Map();
for (const ev of (idx.events || [])) {
  for (const cls of (ev.classes || [])) {
    for (const c of (cls.competitors || [])) {
      if (isExcludedName(c.fn, c.ln)) continue;
      const name = `${c.fn || ''} ${c.ln || ''}`.trim();
      if (!name || !c.gn) continue;
      const key = norm(name);
      if (!freq.has(key)) continue;
      let v = clubVotes.get(key);
      if (!v) { v = new Map(); clubVotes.set(key, v); }
      v.set(c.gn, (v.get(c.gn) || 0) + 1);
    }
  }
}
for (const [key, e] of freq) {
  const v = clubVotes.get(key);
  if (v) e.c = [...v.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

const nExcluded = new Set([...excludedKeys, ...excludedHmacs]).size;
const pilots = [...freq.values()].sort((a, b) => b.e - a.e).slice(0, TOP);
const cov = pilots.reduce((s, p) => s + p.e, 0);
const out = {
  _meta: {
    generated: new Date().toISOString().slice(0, 10),
    source: 'pilots-index.json (' + (Number.isFinite(TOP) ? 'top ' + TOP : 'tous') + ' par engagements) + clubs.json',
    pilots: pilots.length,
    coverage: Math.round(1000 * cov / total) / 10,
    ...(nExcluded ? { excludedPilots: nExcluded } : {}),
  },
  pilots,
  clubs: clubs.mapping || {},
};
const outPath = path.join(DIR, '..', 'hub-search.json');
fs.writeFileSync(outPath, JSON.stringify(out) + '\n');
console.log(`clubs.json : ${path.relative(path.join(DIR, '..', '..'), clubPath)}`);
console.log(`pilotes: ${pilots.length}, couverture: ${out._meta.coverage}% engagements, taille: ${(fs.statSync(outPath).size / 1024).toFixed(0)} Ko`);
if (nExcluded) {
  console.log(`Exclusions RGPD : ${nExcluded} pilote(s) — ${excludedHits} engagement(s) filtré(s)`);
}
