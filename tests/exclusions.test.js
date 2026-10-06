// Tests du mécanisme d'exclusion RGPD (build-exclusions.js).
// Couvre la normalisation des clés (accents / casse / ponctuation), les
// 3 discriminants (account, from, liste vide) et le mode HMAC utilisé en
// production (dépôt public : aucun nom en clair).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpList(doc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-'));
  const file = path.join(dir, 'excluded-pilots.json');
  fs.writeFileSync(file, JSON.stringify(doc), 'utf8');
  return file;
}

const {
  normKey, normKeyAlias, loadExclusions, isExcluded, filterCompetitors,
  hmacHex, hmacKey, VECTOR_PROBE, SECRET_ENV,
} = require('../build-exclusions.js');

// --- mode HMAC (production) ---------------------------------------------------
const SECRET = 'secret-de-test-canalon';
const H = (fn, ln) => hmacKey(fn, ln, SECRET);

// Mode « liste en clair » : on force l'absence de secret (secret: null) pour que
// ces tests restent valides même quand EXCLUDE_HMAC_KEY est défini dans l'environnement.
const loadClear = file => loadExclusions(file, { secret: null });

function tmpHmacList(rules, extra = {}) {
  return tmpList({ version: 2, ...extra, excluded: rules });
}

test('l’ordre des tokens est indifférent (« Dupont Jean » = « Jean Dupont »)', () => {
  assert.equal(normKeyAlias('Jean', 'Dupont'), normKeyAlias('Dupont', 'Jean'));
  const file = tmpList({ excluded: [{ key: 'Dupont Jean', reason: 'opposition' }] });
  const ex = loadClear(file);
  assert.ok(isExcluded(ex, { firstName: 'Jean', lastName: 'DUPONT' }), 'écrit nom-prénom, stocké prénom-nom');
  assert.ok(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont' }));
});

test('firstName/lastName explicites : pas d’inversion possible', () => {
  const file = tmpList({ excluded: [{ firstName: 'Jean', lastName: 'Dupont' }] });
  const ex = loadClear(file);
  assert.ok(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont' }));
  assert.ok(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', account: 'ffc', date: '2026-01-01' }));
  assert.equal(isExcluded(ex, { firstName: 'Dupont', lastName: 'Jean', account: 'x' }) !== null, true,
    'l’alias trié couvre aussi l’écriture inversée');
});

test('homonymie sans discriminant : prudence — même clé de tokens = même exclusion', () => {
  const file = tmpList({ excluded: [{ firstName: 'Jean', lastName: 'Dupont' }] });
  const ex = loadClear(file);
  // Un autre « Jean Dupont » dans une autre orga est également retiré : c'est
  // pourquoi le champ `account` existe (cf. test dédié).
  assert.ok(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', account: 'autre-club' }));
});

test('normKey : insensible à la casse, aux accents et à la ponctuation', () => {
  assert.equal(normKey('Candy', 'PLANÇON'), 'candy plancon');
  assert.equal(normKey('CANDY', 'PLANCON'), 'candy plancon');
  assert.equal(normKey(' Candy  ', 'Plancon.'), 'candy plancon');
  // Deux graphies de la même personne → une seule clé
  assert.equal(normKey('Candy', 'PLANÇON'), normKey('CANDY', 'PLANCON'));
});

test('normKey : composed vs décomposé (NFD) donnent la même clé', () => {
  const compose = 'Café';       // U+00E9
  const decompose = 'Café';   // e + U+0301
  assert.equal(normKey('Café', 'Durand'), normKey('Café', 'Durand'));
});

test('loadExclusions : fichier absent → liste vide', () => {
  const ex = loadExclusions(path.join(os.tmpdir(), 'fichier-inexistant-excl.json'));
  assert.equal(ex.rules, 0);
  assert.equal(isExcluded(ex, { firstName: 'Candy', lastName: 'PLANÇON' }), null);
});

test('loadExclusions : JSON invalide → erreur explicite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'excl-'));
  const file = path.join(dir, 'excluded-pilots.json');
  fs.writeFileSync(file, '{ pas du json', 'utf8');
  assert.throws(() => loadExclusions(file), /JSON invalide/);
});

test('loadExclusions : entrée sans key → comptée invalide, pas de crash', () => {
  const file = tmpList({ version: 1, excluded: [{ reason: 'oubli' }, { key: 'candy plancon' }] });
  const ex = loadClear(file);
  assert.equal(ex.invalid, 1);
  assert.equal(ex.rules, 1);
});

test('exclusion simple : toute la carrière du pilote est retirée', () => {
  const file = tmpList({ excluded: [{ key: 'candy plancon', reason: 'opposition' }] });
  const ex = loadClear(file);
  const r = isExcluded(ex, { firstName: 'Candy', lastName: 'PLANÇON', account: 'ffc', date: '2026-09-20' });
  assert.ok(r, 'doit être exclu (orthographe avec cédille)');
  assert.equal(r.reason, 'opposition');
  assert.ok(isExcluded(ex, { firstName: 'CANDY', lastName: 'Plancon', account: 'ffcbmxne', date: '2023-05-09' }));
});

test('homonymie : account restreint à une seule organisation', () => {
  const file = tmpList({ excluded: [{ key: 'dupont jean', account: 'ffc', reason: 'attribution erronée' }] });
  const ex = loadClear(file);
  assert.ok(isExcluded(ex, { firstName: 'Jean', lastName: 'DUPONT', account: 'ffc', date: '2026-05-01' }));
  assert.equal(isExcluded(ex, { firstName: 'Jean', lastName: 'DUPONT', account: 'clublocal', date: '2026-05-01' }), null,
    'un autre compte doit être conservé');
});

test('from : seules les occurrences à partir de la date (incluse) sont retirées', () => {
  const file = tmpList({ excluded: [{ key: 'dupont jean', from: '2026-01-01' }] });
  const ex = loadClear(file);
  assert.equal(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', date: '2025-12-31' }), null,
    'antérieur à `from` : conservé');
  assert.ok(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', date: '2026-01-01' }), 'datepile incluse');
  assert.ok(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', date: '2026-08-15' }));
});

test('from + account combinés : les deux conditions doivent être vraies', () => {
  const file = tmpList({ excluded: [{ key: 'dupont jean', account: 'ffc', from: '2026-01-01' }] });
  const ex = loadClear(file);
  assert.ok(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', account: 'ffc', date: '2026-06-01' }));
  assert.equal(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', account: 'ffc', date: '2025-06-01' }), null);
  assert.equal(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', account: 'autre', date: '2026-06-01' }), null);
});

test('règle `from` invalide ou `account` vide : la règle reste applicable', () => {
  const file = tmpList({ excluded: [{ key: 'dupont jean', from: 'hier', account: '' }] });
  const ex = loadClear(file);
  const r = isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', date: '2023-01-01' });
  assert.ok(r, 'date illisible → on ne restreint pas la règle');
});

test('filterCompetitors : format API (firstName/lastName)', () => {
  const file = tmpList({ excluded: [{ key: 'candy plancon' }] });
  const ex = loadClear(file);
  const list = [
    { firstName: 'Candy', lastName: 'PLANÇON', rank: 1 },
    { firstName: 'Luna', lastName: 'JABELIN CARLIER', rank: 2 },
    { firstName: 'Marie', lastName: 'EYDOUX', rank: 3 },
    { firstName: 'Candy', lastName: 'PLANCON', rank: 4 }, // autre année
  ];
  const f = filterCompetitors(list, ex, { account: 'ffc', date: '2026-09-20' });
  assert.equal(f.kept.length, 2);
  assert.equal(f.dropped, 2);
  assert.deepEqual(f.kept.map(c => c.rank), [2, 3]);
  assert.equal(f.droppedKeys.get('candy plancon'), 2, 'les 2 graphies remontent dans la même clé');
});

test('filterCompetitors : format slim (fn/ln), comme dans les index', () => {
  const file = tmpList({ excluded: [{ key: 'candy plancon' }] });
  const ex = loadClear(file);
  const f = filterCompetitors([
    { fn: 'Candy', ln: 'PLANÇON', rank: 1 },
    { fn: 'Marie', ln: 'EYDOUX', rank: 2 },
  ], ex, { account: 'uec', date: '2026-08-01' });
  assert.equal(f.kept.length, 1);
  assert.equal(f.kept[0].fn, 'Marie');
});

test('filterCompetitors : liste vide et entrée nulle', () => {
  const ex = loadClear(tmpList({ excluded: [{ key: 'x y' }] }));
  assert.equal(filterCompetitors([], ex).kept.length, 0);
  assert.equal(filterCompetitors(null, ex).kept.length, 0);
});

test('liste d’exclusion livrée : structure conforme et AUCUN nom en clair', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'excluded-pilots.json'), 'utf8'));
  assert.ok(Array.isArray(doc.excluded));
  assert.equal(doc.version, 2, 'le format v2 (hmac) est attendu');
  assert.match(String(doc.vector || ''), /^[0-9a-f]{64}$/, 'vector d’auto-test du secret présent');
  for (const r of doc.excluded) {
    assert.ok(r.hmac, 'toute entrée doit porter un hmac');
    assert.match(r.hmac, /^[0-9a-f]{64}$/);
    assert.equal(r.key, undefined, 'aucun champ "key" en clair');
    assert.equal(r.firstName, undefined, 'aucun champ "firstName" en clair');
    assert.equal(r.lastName, undefined, 'aucun champ "lastName" en clair');
    // Le motif ne doit rien laisser deviner de l'identité.
    assert.doesNotMatch(String(r.reason || ''), /\b(candy|plancon)\b/i,
      'le motif ne doit pas contenir le nom');
  }
});

test('liste d’exclusion livrée : chargeable, et refus explicite sans secret si elle contient des hmac', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'excluded-pilots.json'), 'utf8'));
  const nHmac = doc.excluded.filter(r => r && r.hmac).length;
  const secret = process.env[SECRET_ENV];
  if (nHmac && !secret) {
    // Contrat attendu : on refuse de charger plutôt que d'ignorer les règles.
    assert.throws(() => loadExclusions(), new RegExp(SECRET_ENV));
    return;
  }
  const ex = loadExclusions(); // le fichier réel du dépôt
  assert.equal(ex.invalid, 0, `entrées invalides dans excluded-pilots.json : ${ex.invalid}`);
  assert.ok(ex.byKey instanceof Map);
  assert.ok(ex.byHmac instanceof Map);
  assert.equal(typeof ex.rules, 'number');
});

test('HMAC : insensible à la casse, aux accents, à la ponctuation et à l’ordre des tokens', () => {
  assert.equal(H('Candy', 'PLANÇON'), H('CANDY', 'Plancon'));
  assert.equal(H('Candy', 'PLANÇON'), H('PLANÇON', 'Candy'), 'ordre des tokens indifférent');
  assert.equal(H('Candy', 'PLANÇON'), H(' Candy ', 'Plancon.'), 'espaces et ponctuation');
  assert.notEqual(H('Candy', 'PLANÇON'), H('Marie', 'EYDOUX'));
  assert.match(H('Candy', 'PLANÇON'), /^[0-9a-f]{64}$/);
});

test('HMAC dépend du secret : un autre secret ne donne pas la même empreinte', () => {
  assert.notEqual(hmacKey('Candy', 'PLANÇON', SECRET), hmacKey('Candy', 'PLANÇON', 'autre-secret'));
});

test('HMAC : le dépôt peut être ré-analysé par force brute sans le secret', () => {
  // Le point de tout le dispositif : un simple sha256 du nom serait réversible
  // (les 17 000 noms sont publics dans pilots-index.json). Avec le HMAC, un
  // attaquant sans le secret ne peut pas retrouver le nom à partir de l'empreinte.
  const hmac = H('Candy', 'PLANÇON');
  const sha = require('crypto').createHash('sha256').update('candy plancon').digest('hex');
  // On rejoue l'attaque par dictionnaire sur un attaquant SANS le secret :
  // il ne peut calculer que des sha256, jamais le HMAC → aucun nom ne correspond.
  const dictionnaire = ['candy plancon', 'candy plançon', 'marie eydoux', 'luna jabelin carlier'];
  const trouve = dictionnaire.filter(n =>
    require('crypto').createHash('sha256').update(n).digest('hex') === sha);
  assert.equal(trouve.length, 1, 'le sha256 seul est réversible par dictionnaire');
  assert.ok(!dictionnaire.some(n => hmacHex(n, '', 'secret-de-lattaquant') === hmac),
    'le HMAC résiste à la même attaque');
});

test('HMAC : exclusion effective, insensibilité aux graphies conservée', () => {
  const ex = loadExclusions(tmpHmacList([{ hmac: H('Candy', 'PLANÇON'), reason: 'opposition' }]), { secret: SECRET });
  assert.equal(ex.hmac, 1);
  assert.equal(ex.clear, 0);
  assert.equal(ex.rules, 1);
  assert.ok(isExcluded(ex, { firstName: 'Candy', lastName: 'PLANÇON', account: 'ffc', date: '2026-09-20' }));
  assert.ok(isExcluded(ex, { firstName: 'CANDY', lastName: 'Plancon' }), 'autre graphie');
  assert.ok(isExcluded(ex, { fn: 'Candy', ln: 'PLANÇON' }), 'format slim');
  assert.equal(isExcluded(ex, { firstName: 'Marie', lastName: 'EYDOUX' }), null, 'autre pilote');
});

test('HMAC : discriminants account / from conservés', () => {
  const ex = loadExclusions(
    tmpHmacList([{ hmac: H('Jean', 'Dupont'), account: 'ffc' }, { hmac: H('Paul', 'Durand'), from: '2026-01-01' }]),
    { secret: SECRET });
  assert.ok(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', account: 'ffc', date: '2026-05-01' }));
  assert.equal(isExcluded(ex, { firstName: 'Jean', lastName: 'Dupont', account: 'clublocal' }), null);
  assert.equal(isExcluded(ex, { firstName: 'Paul', lastName: 'Durand', date: '2025-12-31' }), null);
  assert.ok(isExcluded(ex, { firstName: 'Paul', lastName: 'Durand', date: '2026-01-01' }));
});

test('HMAC : rules hmac + secret absent → refus explicite (jamais d&apos;exclusion silencieuse)', () => {
  assert.throws(
    () => loadExclusions(tmpHmacList([{ hmac: H('Candy', 'PLANÇON') }]), { secret: '' }),
    new RegExp(SECRET_ENV),
  );
});

test('HMAC : vector absent ou faux → refus (le secret correspond-il au fichier ?)', () => {
  const file = tmpHmacList([{ hmac: H('Candy', 'PLANÇON') }], { vector: hmacHex(VECTOR_PROBE, VECTOR_PROBE, 'autre-secret') });
  assert.throws(() => loadExclusions(file, { secret: SECRET }), /ne correspond PAS/);
  // vector correct → ça passe
  const ok = tmpHmacList([{ hmac: H('Candy', 'PLANÇON') }], { vector: hmacHex(VECTOR_PROBE, VECTOR_PROBE, SECRET) });
  assert.equal(loadExclusions(ok, { secret: SECRET }).rules, 1);
});

test('HMAC : nom en clair dans le dépôt alors qu&apos;un secret est configuré → refus', () => {
  assert.throws(
    () => loadExclusions(tmpList({ excluded: [{ firstName: 'Jean', lastName: 'Dupont' }] }), { secret: SECRET }),
    /en clair/,
  );
});

test('HMAC : hmac + nom dans la même entrée → refus (fuite par le nom)', () => {
  assert.throws(
    () => loadExclusions(tmpList({ excluded: [{ hmac: H('Candy', 'PLANÇON'), key: 'candy plancon' }] }), { secret: SECRET }),
    /à la fois/,
  );
});

test('HMAC : format invalide → erreur explicite', () => {
  assert.throws(() => loadExclusions(tmpHmacList([{ hmac: 'trop-court' }]), { secret: SECRET }), /"hmac" invalide/);
});

test('HMAC : le log n&apos;expose pas l&apos;empreinte complète', () => {
  const ex = loadExclusions(tmpHmacList([{ hmac: H('Candy', 'PLANÇON') }]), { secret: SECRET });
  const f = filterCompetitors([{ firstName: 'Candy', lastName: 'PLANÇON' }], ex, {});
  assert.equal(f.dropped, 1);
  const tag = [...f.droppedKeys.keys()][0];
  assert.match(tag, /^hmac:[0-9a-f]{12}$/, `étiquette inattendue : ${tag}`);
  assert.ok(!tag.includes(H('Candy', 'PLANÇON')), 'pas d’empreinte complète dans le log');
});
// --- LRP : réduction + filtre RGPD (tools/reduce-lrp.cjs) ---------------------
// La LRP était le SEUL fichier publié que la liste d'exclusion ne traversait pas
// (import manuel, hors cron) : une opposition art. 17 y serait restée visible.
// Le script ne doit donc réduire ET retirer, dans le bon ordre.

const { execFileSync } = require('node:child_process');

const REDUCE = path.join(__dirname, '..', 'tools', 'reduce-lrp.cjs');

// Source FFC simulée : 12 champs, dont le NIP qui doit disparaître.
const LRP_SOURCE = {
  _meta: { version: 1, total: 2, source: 'liste-ref.txt' },
  pilots: [
    {
      nip: 'T123456', prenom: 'Christelle', nom: 'BOIVIN', age: 17, sex: 'F',
      club: 'BMX CLUB', comite: 'NA', zone: 'X', trancheKey: 'x', catInter: 'y',
      categorieFra: 'CRUISER FEMME 17/29', level: 'national',
    },
    {
      nip: 'T999999', prenom: 'Alice', nom: 'DURAND', age: 22, sex: 'F',
      club: 'VELO', comite: 'NO', zone: 'Y', trancheKey: 'x', catInter: 'y',
      categorieFra: 'ELITE FEMME', level: 'regional',
    },
  ],
};

function runReduce(excludedDoc) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lrp-'));
  const src = path.join(dir, 'src.json');
  const out = path.join(dir, 'out.json');
  const list = tmpList(excludedDoc);
  fs.writeFileSync(src, JSON.stringify(LRP_SOURCE), 'utf8');
  const res = execFileSync(process.execPath,
    [REDUCE, `--in=${src}`, `--out=${out}`, `--exclusions=${list}`],
    { env: { ...process.env, EXCLUDE_HMAC_KEY: SECRET }, encoding: 'utf8' });
  return { doc: JSON.parse(fs.readFileSync(out, 'utf8')), log: res };
}

test('LRP : réduction aux 4 champs consommés (le NIP ne doit pas sortir)', () => {
  const { doc } = runReduce({ excluded: [], vector: hmacHex(VECTOR_PROBE, VECTOR_PROBE, SECRET) });
  assert.deepEqual(Object.keys(doc.pilots[0]).sort(), ['categorieFra', 'level', 'nom', 'prenom']);
  // Aucune VALEUR de NIP nulle part (les noms de champs supprimés sont, eux,
  // listés dans _meta._droppedFields — c'est de la documentation, pas une donnée).
  assert.ok(!/T123456/.test(JSON.stringify(doc)), 'aucune valeur de NIP');
  const pilotKeys = new Set(doc.pilots.flatMap(p => Object.keys(p)));
  for (const k of ['nip', 'age', 'sex', 'club', 'comite', 'zone', 'trancheKey', 'catInter']) {
    assert.ok(!pilotKeys.has(k), `le champ ${k} ne doit pas survivre dans un pilote`);
  }
  assert.deepEqual(doc._meta._droppedFields.sort(),
    ['age', 'catInter', 'club', 'comite', 'nip', 'sex', 'trancheKey', 'zone']);
});

test('LRP : le volume et les niveaux sont préservés', () => {
  const { doc } = runReduce({ excluded: [], vector: hmacHex(VECTOR_PROBE, VECTOR_PROBE, SECRET) });
  assert.equal(doc.pilots.length, 2);
  assert.equal(doc._meta.national, 1);
  assert.equal(doc._meta.regional, 1);
});

test('LRP : une opposition globale retire le pilote de la liste', () => {
  const { doc, log } = runReduce({
    excluded: [{ hmac: hmacHex('Christelle', 'BOIVIN', SECRET), reason: 'opposition art. 17' }],
    vector: hmacHex(VECTOR_PROBE, VECTOR_PROBE, SECRET),
  });
  assert.deepEqual(doc.pilots.map(p => p.nom), ['DURAND']);
  assert.equal(doc._meta._excludedPilots, 1);
  assert.match(log, /exclusions RGPD appliquées : 1/);
  assert.ok(!/BOIVIN/.test(JSON.stringify(doc.pilots)), 'le pilote opposant ne doit plus être listé');
});

test('LRP : une opposition limitée à un compte ne retire rien (la LRP n’a pas de compte)', () => {
  const { doc } = runReduce({
    excluded: [{ hmac: hmacHex('Christelle', 'BOIVIN', SECRET), account: 'ffc', reason: 'erreur attribution' }],
    vector: hmacHex(VECTOR_PROBE, VECTOR_PROBE, SECRET),
  });
  assert.equal(doc.pilots.length, 2, 'une opposition par compte ne doit pas vider la LRP');
  assert.ok(!('_excludedPilots' in doc._meta), 'aucun retrait ne doit être journalisé');
});

test('LRP : sans opposition, le log reste muet sur les exclusions', () => {
  const { doc, log } = runReduce({ excluded: [], vector: hmacHex(VECTOR_PROBE, VECTOR_PROBE, SECRET) });
  assert.ok(!/exclusions RGPD appliquées/.test(log));
  assert.ok(!('_excludedPilots' in doc._meta));
});
