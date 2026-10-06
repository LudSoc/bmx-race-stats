// Réduit pilots-lrp-2026.json aux SEULS champs consommés par le site, ET
// applique la liste d'exclusion RGPD.
//
// Pourquoi réduire : le fichier importé de la FFC (LRP — Liste des Riders
// Potentiels) contient 12 champs par pilote, dont le numéro de licence (nip),
// l'âge, le sexe, le club, le comité et la zone. Or aucun code ne les lit : côté
// site (`stats/index.html`, `loadLrpLevels`) comme côté test
// (`ranking/tests/ranking.test.js`), seuls quatre champs sont utilisés —
//
//   prenom, nom      → clé de correspondance (norm(prénom nom))
//   level            → badge « National »
//   categorieFra     → badge « Élite » (test /ELITE/)
//
// Les 8 autres champs étaient donc publiés sans usage, dont le NIP qui est une
// donnée administrative identifiante. Les mentions légales du site indiquent
// « aucun numéro de licence n'est exploité » : cette réduction rend le fichier
// conforme à ce qui est annoncé. Elle ne change aucun affichage — l'app dégrade
// proprement si le fichier est absent (lrpLevels = null).
//
// Pourquoi filtrer : la LRP est le SEUL fichier publié qui n'était pas couvert
// par la liste d'exclusion. Les index, le hub-search et les perf-rankings
// lisent tous des index filtrés ; ce fichier est importé à la main et n'aurait
// donc jamais contenu une opposition. Une personne ayant demandé à être effacée
// (art. 17) ou son retrait (art. 21) serait restée visible.
//
// ⚠️ Comme la source est copiée manuellement et NON par le cron, le filtre ne
// s'applique qu'au moment où ce script est rejoué. Après toute inscription dans
// excluded-pilots.json : `node tools/reduce-lrp.cjs`, puis copiers le résultat
// dans bmx-race-tools/stats/pilots-lrp-2026.json. Cf. le pas « Vérifier la
// liste d'exclusion » de .github/workflows/build-index.yml, qui échoue si une
// opposition n'a pas été propagée.
//
// Usage :
//   node tools/reduce-lrp.cjs                  # lit pilots-lrp-2026.json, l'écrit sur place
//   node tools/reduce-lrp.cjs --in=src.json --out=dst.json
//
// À REJOUER à chaque réimport de la LRP : la source complète n'est pas versionnée
// (liste-ref.txt n'est pas dans le dépôt), le fichier réduit est donc jetable et
// doit toujours être reconstruit à partir d'un export FFC complet.
//   Licence : la LRP est une publication de la Fédération Française de Cyclisme ;
//   sa rediffusion est à vérifier auprès de la FFC avant tout usage public.

const fs = require('fs');
const path = require('path');

const { loadExclusions, isExcluded } = require('../build-exclusions.js');

const DIR = path.join(__dirname, '..');
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const inPath = path.resolve(arg('in', path.join(DIR, 'pilots-lrp-2026.json')));
const outPath = path.resolve(arg('out', inPath));

// Les quatre champs consommés par loadLrpLevels() / pilotStatus().
const KEEP = ['prenom', 'nom', 'categorieFra', 'level'];

if (!fs.existsSync(inPath)) {
  console.error(`Introuvable : ${inPath}`);
  process.exit(1);
}

// Taille de la source AVANT réduction (inPath, pas outPath : la sortie peut être
// un fichier neuf quand --out pointe ailleurs).
const beforeBytes = fs.statSync(inPath).size;
const doc = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const src = Array.isArray(doc.pilots) ? doc.pilots : [];
const dropped = [...new Set(src.flatMap(p => Object.keys(p || {})))].filter(k => !KEEP.includes(k));

// --- Exclusions RGPD ---------------------------------------------------------
// La LRP ne porte ni compte ni date par ligne : une opposition « account » ou
// « from » n'y est pas applicable et ne retire donc rien ici. Ce qui s'applique,
// c'est une opposition globale (une règle sans `account` ni `from`) — exactement
// ce que produit une demande d'effacement « retirez-moi partout ».
// `--exclusions=` n'existe que pour les tests ; en production c'est
// excluded-pilots.json à la racine du dépôt.
const exclPath = path.resolve(arg('exclusions', path.join(DIR, 'excluded-pilots.json')));
const exclusions = loadExclusions(exclPath);
const kept = [];
const removed = [];
for (const p of src) {
  if (isExcluded(exclusions, { firstName: p.prenom, lastName: p.nom })) {
    removed.push(`${p.prenom || ''} ${p.nom || ''}`.trim());
    continue;
  }
  const out = {};
  for (const k of KEEP) if (p[k] !== undefined) out[k] = p[k];
  kept.push(out);
}

const pilots = kept;
const keptLevels = { national: 0, regional: 0 };
for (const p of pilots) if (p.level === 'national' || p.level === 'regional') keptLevels[p.level]++;


// Sur un fichier déjà réduit, les champs supprimés ne sont plus présents à
// recompler : on préserve la liste documentaire historique (_droppedFields) au
// lieu de la vider à chaque re-run (elle décrit ce que le fichier source complet
// contenait, pas ce que le fichier courant laisse déjà passer).
const knownDropped = (doc._meta && Array.isArray(doc._meta._droppedFields)) ? doc._meta._droppedFields : dropped;

const out = {
  _meta: {
    ...(doc._meta || {}),
    title: 'Pilotes LRP 2026 → catégories canoniques (réduit)',
    version: (doc._meta && doc._meta.version ? doc._meta.version : 1) + 1,
    reducedAt: new Date().toISOString().slice(0, 10),
    total: pilots.length,
    national: keptLevels.national,
    regional: keptLevels.regional,
    _doc: 'Réduit par tools/reduce-lrp.cjs : seuls prenom, nom, categorieFra et level sont '
      + 'consommés par le site. Les autres champs de l’export FFC (dont le numéro de licence, '
      + 'l’âge, le sexe et le club) ont été retirés : ils n’étaient pas utilisés. '
      + 'La liste d’exclusion RGPD (art. 17 / 21) est également appliquée. '
      + 'Repartir d’un export FFC complet pour régénérer (ce fichier est dérivé).',
    _keptFields: KEEP,
    _droppedFields: knownDropped,
    ...(removed.length ? { _excludedPilots: removed.length } : {}),
  },
  pilots,
};

// Idempotence : le fichier étant déjà réduit ET conforme à excluded-pilots.json,
// on NE réécrit PAS (ni version ni reducedAt). Sans ça, le pas « Vérifier la LRP »
// du workflow (git diff --quiet après re-run) échouerait à chaque exécution.
const isIdentical = (() => {
  if (path.resolve(inPath) !== path.resolve(outPath) || !fs.existsSync(outPath)) return false;
  try {
    const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const pm = prev._meta || {};
    const om = out._meta;
    return JSON.stringify(prev.pilots || []) === JSON.stringify(out.pilots)
      && pm.total === om.total && pm.national === om.national && pm.regional === om.regional
      && pm._excludedPilots === om._excludedPilots
      && JSON.stringify(pm._droppedFields || null) === JSON.stringify(om._droppedFields || null);
  } catch { return false; }
})();

if (isIdentical) {
  console.log(`${path.relative(process.cwd(), inPath)}`);
  console.log('  inchangé : fichier déjà réduit et conforme à la liste d’exclusion');
  process.exit(0);
}

fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

const before = beforeBytes;
const after = fs.statSync(outPath).size;
console.log(`${path.relative(process.cwd(), outPath)}`);
console.log(`  entrées   : ${pilots.length} (national ${keptLevels.national}, regional ${keptLevels.regional})`);
console.log(`  champs    : conservés ${KEEP.join(', ')}`);
console.log(`  supprimés : ${dropped.join(', ') || 'aucun'}`);
if (removed.length) {
  console.log(`  exclusions RGPD appliquées : ${removed.length} pilote(s) retiré(s) — ${removed.join(', ')}`);
}
console.log(`  taille    : ${(before / 1024).toFixed(0)} Ko → ${(after / 1024).toFixed(0)} Ko`);