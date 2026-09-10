// Tests de l'indice v2 côté build (build-field.js) + parité avec le client.
// Usage : node --test tests/field-strength.test.js
// (ne requiert pas les index sauf les tests de parité, ignorés sinon)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const BF = require(path.join(root, 'build-field.js'));
const BF_SRC = fs.readFileSync(path.join(root, 'build-field.js'), 'utf8');
const SC = new Function('window', fs.readFileSync(path.join(root, 'common.js'), 'utf8') + '\nreturn window.SqorzCommon;')({});
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function block(src, start, indent = '  ') {
  const i = src.indexOf(start);
  if (i < 0) throw new Error('marqueur introuvable : ' + start);
  const j = src.indexOf('\n' + indent + '}\n', i);
  if (j < 0) throw new Error('fin de bloc introuvable pour : ' + start);
  return src.slice(i, j + ('\n' + indent + '}\n').length);
}
function stmt(src, start) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error('marqueur introuvable : ' + start);
  return src.slice(i, src.indexOf(';', i) + 1);
}

// --- le build ne connaît aucun coef (unités raw, coefs côté client uniquement) ---
test('build sans coefs : K partagé, pas de NATIONAL/COEFS', () => {
  assert.equal(BF.PERF_FIELD_K, SC.PERF_FIELD_K);
  assert.ok(!/coefFor|NATIONAL_ACCOUNTS|COEFS/.test(BF_SRC), 'aucune logique de coef côté build');
  for (const f of ['build-index.js', 'build-uec.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(src.includes('computeFieldFiles'), `${f} appelle computeFieldFiles`);
    assert.ok(!/coefFor/.test(src), `${f} sans coefFor`);
  }
});

// --- fixture de bout en bout (unités raw, entrées [fs, n]) ---
function fixtureIndex() {
  const det = (places) => places.map(([n, r]) => ({ n, r }));
  const comp = (fn, rank, details) => ({ fn, ln: 'T', gn: 'Club', rank, d: details });
  const good = det([['Moto 1', 1], ['Moto 2', 1], ['Finale', 1]]);
  return {
    generated: '2026-01-01T00:00:00.000Z',
    events: [
      { account: { accountCode: 'ffc', accountName: 'FFC' },
        event: { eventId: 'e1', eventName: 'CDF', eventDate: '2026-05-10' },
        classes: [{ className: 'U19', perpetualClassCode: 'U19', total: 4, competitors: [
          comp('A', 1, good), comp('B', 2, good.map(d => ({ ...d, r: 2 }))),
          comp('C', 3, det([['Moto 1', 3], ['Moto 2', 3]])),
          comp('D', 4, det([['Moto 1', 4]])),
          { fn: 'E', ln: 'T', gn: 'Club', rank: 101000, d: det([['Moto 1', 101000]]) },
        ] }] },
      { account: { accountCode: 'ffc', accountName: 'FFC' },
        event: { eventId: 'e2', eventName: 'CDF2', eventDate: '2025-06-08' },
        classes: [{ className: 'U19', perpetualClassCode: 'U19', total: 2, competitors: [
          comp('F', 1, good), comp('G', 2, good.map(d => ({ ...d, r: 2 }))),
        ] }] },
    ],
    series: [],
  };
}

test('computeFieldFiles : fichiers, meta, [fs, n], DNF exclu du plateau', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-test-'));
  const inFile = path.join(dir, 'idx.json');
  fs.writeFileSync(inFile, JSON.stringify(fixtureIndex()));
  const outFile = path.join(dir, 'field.json');
  BF.computeFieldFiles([inFile], { outFile, label: 'TEST' });
  assert.ok(fs.existsSync(outFile), 'fichier écrit');
  const meta = JSON.parse(fs.readFileSync(outFile.replace(/\.json$/, '.meta.json'), 'utf8'));
  assert.equal(meta.index.sha256, crypto.createHash('sha256').update(fs.readFileSync(outFile, 'utf8')).digest('hex'), 'sha meta OK');
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(payload.v, 1);
  assert.deepEqual(Object.keys(payload.medFs).sort(), ['2025', '2026']);
  // e1 : R(A..D) ≈ 802/543/389/118 → fs inclusive ≈ 463 (E/DNF exclu : sinon 421), n = 4.
  assert.deepEqual(payload.classes['ffc/e1/U19'], [463, 4]);
  assert.equal(payload.medFs['2026'], 463, 'une seule classe → sa fs');
  // e2 (2025) : R(F)≈658, R(G)≈222 → fs = 440, n = 2.
  assert.deepEqual(payload.classes['ffc/e2/U19'], [440, 2]);
  const dnf = BF.scoreRaw(101000, 5, [{ n: 'Moto 1', r: 101000 }], []);
  assert.deepEqual(dnf, { raw: 250, valid: false });
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- harnais app (fonctions extraites de index.html) ---
const appHarness = [
  'const { PERF_DNF_SCORES, perfScoreRang, perfCoefConstance, perfConstance, perfDeepestPhase, perfBestTime, perfChronoScore, PERF_CHRONO_W, applyFieldScore } = __SC;',
  stmt(html, 'const perfYearOf ='),
  stmt(html, 'const fieldKeyOfEvent ='),
  block(html, 'function perfEngagement(m) {'),
].join('\n') + '\nreturn { perfEngagement, applyFieldScore, fieldKeyOfEvent };';
const APP = new Function('__SC', 'findClassCompetitors', appHarness)(SC, () => globalThis.__finderResult);

function expandedMatch(ev, cls, c) {
  const ci = cls.competitors.indexOf(c);
  const clsCopy = JSON.parse(JSON.stringify(cls));
  const xcls = SC.expandIndex({ events: [{ account: ev.account, event: ev.event, classes: [clsCopy] }] }).events[0].classes[0];
  globalThis.__finderResult = xcls.competitors; // stub findClassCompetitors (même données)
  return {
    account: ev.account, event: ev.event,
    cls: { className: cls.className, perpetualClassCode: cls.perpetualClassCode },
    competitor: xcls.competitors[ci],
    totalParticipants: cls.total || cls.competitors.length,
  };
}
function firstSamples() {
  const out = [];
  const pilots = JSON.parse(fs.readFileSync(path.join(root, 'pilots-index.json'), 'utf8'));
  const uec = JSON.parse(fs.readFileSync(path.join(root, 'uec-index.json'), 'utf8'));
  outer1:
  for (const ev of pilots.events) {
    for (const cls of ev.classes) {
      const timed = (cls.competitors || []).filter(c => (c.d || []).some(d => typeof d.tm === 'string'));
      if (timed.length >= 3 && cls.total >= 10) { out.push({ ev, cls, c: timed[0] }); break outer1; }
    }
  }
  outer2:
  for (const ev of uec.events) {
    for (const cls of ev.classes) {
      const timed = (cls.competitors || []).filter(c => (c.d || []).some(d => typeof d.tm === 'string'));
      if (timed.length >= 3) { out.push({ ev, cls, c: timed[0] }); break outer2; }
    }
  }
  outer3:
  for (const ev of pilots.events) {
    for (const cls of ev.classes) {
      const dnf = (cls.competitors || []).find(c => typeof c.rank === 'number' && c.rank >= 100000);
      if (dnf) { out.push({ ev, cls, c: dnf }); break outer3; }
    }
  }
  return out;
}

test('parité build/app : même raw sur échantillons réels (FR chrono, UEC, DNF)', () => {
  let samples;
  try { samples = firstSamples(); } catch (e) { console.log('  (index absents — test ignoré)'); return; }
  for (const s of samples) {
    const m = expandedMatch(s.ev, s.cls, s.c);
    const app = APP.perfEngagement(m);
    const bests = [];
    for (const cp of s.cls.competitors) {
      const bt = SC.perfBestTime((cp.d || []).map(d => ({ phaseName: d.n, result: d.r, time: d.tm, hillTime: d.ht, corner2Time: d.ct })));
      if (bt != null) bests.push(bt);
    }
    const b = BF.scoreRaw(s.c.rank, s.cls.total || s.cls.competitors.length, s.c.d, bests);
    assert.ok(Math.abs(b.raw - app.raw) < 1e-9, `raw ${s.c.fn} ${s.c.ln} rank=${s.c.rank} : build=${b.raw} app=${app.raw}`);
    assert.equal(b.valid, app.nDnf === 0, 'flag DNF cohérent');
  }
});

test('ajustement force-plateau via ctx', () => {
  // Ajustement : exclusion exacte de soi-même depuis la moyenne inclusive.
  const ctx = { classes: { 'ffc/evx/U19': [600, 10] }, medFs: { 2026: 430 } };
  // fs_excl = (600·10 − 800)/9 = 577.78 → 800 + 0.3·147.78… non : (577.78−430)=147.78 → +44.33
  assert.ok(Math.abs(APP.applyFieldScore(800, 1.0, 'ffc/evx/U19', '2026', ctx, false) - 844.33) < 0.05);
  assert.equal(APP.applyFieldScore(800, 1.0, 'ffc/evx/ZZZ', '2026', ctx, false), 800, 'clé absente → inchangé');
  assert.equal(APP.applyFieldScore(800, 1.0, 'ffc/evx/U19', '2026', null, false), 800, 'sans ctx → inchangé');
  assert.equal(APP.applyFieldScore(250, 1.0, 'ffc/evx/U19', '2026', ctx, true), 250, 'DNF jamais ajusté');
  assert.equal(APP.applyFieldScore(800, 1.0, 'ffc/evx/U19', '2026', { classes: { 'ffc/evx/U19': [600, 1] }, medFs: { 2026: 430 } }, false), 800, 'classe à 1 → inchangé');
});

// --- loadFieldStrength ---
test('loadFieldStrength : ok / version inconnue / pannes → null', async () => {
  const good = { v: 1, generated: 'x', medFs: { 2026: 430 }, classes: { 'a/b/c': [500, 9] } };
  const mkFetch = (meta, file) => async (url) => {
    url = String(url);
    if (url.endsWith('.meta.json')) {
      if (!meta) return new Response('nf', { status: 404 });
      return new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } });
    }
    if (!file) throw new Error('Failed to fetch');
    return new Response(typeof file === 'string' ? file : JSON.stringify(file), { headers: { 'Content-Type': 'application/json' } });
  };
  const base = { metaUrl: 'https://x/f.meta.json', url: 'https://x/f.json', cacheKey: 'k', tag: '[test]' };
  global.fetch = mkFetch({ index: { sha256: 's' } }, good);
  assert.deepEqual(await SC.loadFieldStrength(base), { classes: good.classes, medFs: good.medFs });
  global.fetch = mkFetch({ index: { sha256: 's' } }, { ...good, v: 2 });
  assert.equal(await SC.loadFieldStrength(base), null, 'v=2 ignorée');
  global.fetch = mkFetch(null, good);
  assert.deepEqual(await SC.loadFieldStrength(base), { classes: good.classes, medFs: good.medFs }, 'meta absente → fichier quand même');
  global.fetch = async () => { throw new Error('Failed to fetch'); };
  assert.equal(await SC.loadFieldStrength(base), null, 'panne → null');
  delete global.fetch;
});

// --- contrat de chargement : les cfgs de l'app correspondent aux params du socle ---
// (régression : `urls:` au lieu de `sources:` rendait tout chargement impossible,
// masqué tant que le cache correspondait aux metas — message « Hors ligne » généralisé
// dès la rotation des metas).
test('contrat loadIndexCached : indexCfg/fieldCfg fournissent les bonnes clés', () => {
  const H = new Function('location', 'R2_BASE', 'RELEASE_BASE', 'INDEX_CACHE_URLS', 'FIELD_CACHE_URLS', 'setStatus', 'setProgress', [
    stmt(html, 'const IS_LOCAL ='),
    block(html, 'function indexCfg('),
    block(html, 'function fieldCfg('),
  ].join('\n') + '\nreturn { indexCfg, fieldCfg };')(
    { hostname: 'ludsoc.github.io' },
    'https://R2/',
    'https://REL/',
    { pilots: 'ck-p', uci: 'ck-u', uec: 'ck-e' },
    { fr: 'ck-f', uec: 'ck-fe' },
    () => {}, () => {},
  );
  const pilots = H.indexCfg('pilots', 'index France', 83_000_000);
  assert.ok(Array.isArray(pilots.sources) && pilots.sources.length === 3, 'sources[3]');
  assert.ok(!('urls' in pilots), 'pas de clé urls parasite');
  assert.ok(pilots.sources[0].startsWith('https://R2/'), 'R2 en premier hors local');
  assert.equal(typeof pilots.metaUrl, 'string');
  assert.equal(typeof pilots.onStatus, 'function');
  assert.equal(typeof pilots.onProgress, 'function');
  const uci = H.indexCfg('uci', 'index UCI', 8_000_000);
  assert.ok(uci.sources[0].includes('uci-index.json'), 'fichier UCI');
  const f = H.fieldCfg('fr', 'field-strength-fr');
  assert.deepEqual(Object.keys(f).sort(), ['cacheKey', 'metaUrl', 'tag', 'url'], 'clés loadFieldStrength');
  assert.ok(f.url.startsWith('https://R2/'), 'données R2 hors local');
});

test('contrat loadIndexCached : fichiers locaux en premier en dev local', () => {
  const H = new Function('location', 'R2_BASE', 'RELEASE_BASE', 'INDEX_CACHE_URLS', 'FIELD_CACHE_URLS', 'setStatus', 'setProgress', [
    stmt(html, 'const IS_LOCAL ='),
    block(html, 'function indexCfg('),
    block(html, 'function fieldCfg('),
  ].join('\n') + '\nreturn { indexCfg, fieldCfg };')(
    { hostname: 'localhost' },
    'https://R2/',
    'https://REL/',
    { pilots: 'ck-p', uci: 'ck-u', uec: 'ck-e' },
    { fr: 'ck-f', uec: 'ck-fe' },
    () => {}, () => {},
  );
  assert.equal(H.indexCfg('pilots', 'x', 1).sources[0], './pilots-index.json');
  assert.equal(H.fieldCfg('fr', 'field-strength-fr').url, './field-strength-fr.json');
});

// --- shrinkage pondéré par la preuve ---
test('perfShrinkMean : resserre vers 500 selon le poids (pas le compteur)', () => {
  assert.ok(Math.abs(SC.perfShrinkMean(577, 4) - 551.33) < 0.01, 'poids 4 : comme avant');
  assert.equal(SC.perfShrinkMean(500, 99), 500);
  // Exemple de l'aide : 4 courses (40, 30, DNF, série 25) → w = 8,17 → 562.
  const w = 40 / 12 + 30 / 12 + 0.25 + 25 / 12;
  assert.ok(Math.abs(SC.perfShrinkMean(577, w) - 562) < 1, `exemple aide : ${SC.perfShrinkMean(577, w)}`);
});

test('perfWeight : taille du plateau / 12, DNF = 0,25', () => {
  assert.equal(SC.PERF_SHRINK_DIV, 12);
  assert.ok(Math.abs(SC.perfWeight(40, false) - 40 / 12) < 1e-9);
  assert.ok(Math.abs(SC.perfWeight(78, false) + SC.perfWeight(57, false) - 11.25) < 1e-9, 'Gaillard UEC : 11,25 unités');
  assert.equal(SC.perfWeight(30, true), 0.25, 'DNF');
  assert.equal(SC.perfWeight(0, false), 0, 'champ vide');
  assert.equal(SC.perfWeight(undefined, false), 0);
});
