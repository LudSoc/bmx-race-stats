// Tests du socle partagé (common.js) : utils, score de rang, constance, dates, expansion, chargeur.
// Usage : node --test tests/common.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'common.js'), 'utf8');
const SC = new Function('window', src + '\nreturn window.BmxCommon;')({});

// --- utils ---
test('norm : casse/accents/espaces', () => {
  assert.equal(SC.norm('  Jean-DUPONT  Éléonore '), 'jean dupont eleonore');
  assert.equal(SC.norm(null), '');
});

test('escape : XSS neutralisé', () => {
  assert.equal(SC.escape('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(SC.escape(null), '');
});

test('zScore : médiane ≈ 0, bornes, cas dégradés', () => {
  assert.equal(SC.zScore(2, 3) !== null, true);
  assert.equal(SC.zScore(1, 1), null);
  assert.equal(SC.zScore('x', 10), null);
  const z = SC.zScore(1, 75);
  assert.ok(Math.abs(z - 1.709) < 0.01, `z(1/75)=${z}`);
});

// --- score de rang (courbe convexe §7.4) ---
test('perfScoreRang : repères (vainqueur, médiane, dernier)', () => {
  assert.equal(SC.perfScoreRang(38, 75), 500); // médiane exacte
  assert.ok(SC.perfScoreRang(1, 75) >= 980, '1er grand champ ≈ 980-1000');
  assert.ok(SC.perfScoreRang(75, 75) <= 10, 'dernier ≈ 5');
});

test('perfScoreRang : cas Merlin Guigo (11e/65 + 4e/58)', () => {
  const s11 = SC.perfScoreRang(11, 65);
  const s4 = SC.perfScoreRang(4, 58);
  assert.ok(s11 < 750 && s11 > 650, `11/65=${s11}`);
  assert.ok(s4 < 920 && s4 > 820, `4/58=${s4}`);
  assert.ok(s4 - s11 > 100, 'le podium se détache nettement');
});

// --- constance ---
test('perfConstance : éliminé en demie sans bonus finale', () => {
  const semiOut = [
    { phaseName: 'Moto 1', result: 4 }, { phaseName: 'Moto 2', result: 1 },
    { phaseName: 'Semi Finals', result: 6 },
  ];
  assert.equal(SC.perfConstance(semiOut, 11), 0.7);
});

test('perfConstance : proxy finale conservé sans phases KO (Mondiaux)', () => {
  const noKo = [{ phaseName: 'Moto 1', result: 2 }, { phaseName: 'Moto 2', result: 3 }];
  assert.equal(SC.perfConstance(noKo, 11), 1);
  assert.equal(SC.perfCoefConstance(1), 1.05);
  assert.equal(SC.perfCoefConstance(0.2), 0.97);
});

test('coefs de niveau', () => {
  assert.deepEqual(SC.PERF_LEVEL_COEFS, { regional: 0.93, national: 1.0, uec: 1.05, uci: 1.05 });
});

// --- dates par source ---
test('formatDataDates : une date / plusieurs / aucune', () => {
  assert.equal(SC.formatDataDates([{ tag: 'FR', iso: '2026-09-07T08:18:20.000Z' }]), '07/09/2026');
  assert.equal(
    SC.formatDataDates([{ tag: 'FR', iso: '2026-09-07T08:18:20.000Z' }, { tag: 'UEC', iso: '2026-09-07T08:18:20.000Z' }]),
    '07/09/2026');
  assert.equal(
    SC.formatDataDates([{ tag: 'FR', iso: '2026-09-07T08:18:20.000Z' }, { tag: 'UEC', iso: '2026-09-08T09:38:00.000Z' }, { tag: 'UCI', iso: null }]),
    'FR 07/09/2026 · UEC 08/09/2026');
  assert.equal(SC.formatDataDates([]), null);
  assert.equal(SC.formatDataDates([{ tag: 'FR', iso: 'pas-une-date' }]), null);
});

// --- expansion ---
test('expandIndex : superset + mode slim', () => {
  const slim = { events: [{ event: {}, account: {}, classes: [{ competitors: [{ fn: 'A', ln: 'B', gn: 'FRA', jid: ' 123 ', d: [{ n: 'Finale', r: 4, tm: '35.1' }] }] }] }], series: [{ classes: [{ competitors: [{ fn: 'A', ln: 'B', sr: 2, sp: 40, ev: [{ er: 1 }] }] }] }] };
  const full = SC.expandIndex(JSON.parse(JSON.stringify(slim)));
  const c = full.events[0].classes[0].competitors[0];
  assert.equal(c.firstName, 'A');
  assert.equal(c.riderId, ' 123 ');
  assert.equal(c.competitorRankDetails[0].time, '35.1');
  assert.equal(full.series[0].classes[0].competitors[0].seriesRank, 2);
  const light = SC.expandIndex(JSON.parse(JSON.stringify(slim)), { details: false, series: false });
  assert.equal(light.events[0].classes[0].competitors[0].competitorRankDetails, undefined);
  assert.equal(light.events[0].classes[0].competitors[0].firstName, 'A');
});

// --- chargeur (fetch stubbé, pas de Cache API sous node) ---
test('loadIndexCached : meta + réseau + expansion', async () => {
  const payload = JSON.stringify({ generated: '2026-09-08T00:00:00.000Z', events: [{ event: { eventId: 'e1' }, account: {}, classes: [{ competitors: [{ fn: 'A', ln: 'B' }] }] }], series: [] });
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).endsWith('.meta.json')) {
      return new Response(JSON.stringify({ index: { sha256: 'abc', sizeBytes: 1 } }), { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
  };
  const status = [];
  const idx = await SC.loadIndexCached({
    metaUrl: 'https://x/uec-index.meta.json', cacheKey: 'k', sources: ['https://x/uec-index.json'],
    tag: '[test]', label: 'Index UEC', onStatus: (t) => status.push(t), onProgress: () => {},
  });
  delete global.fetch;
  assert.equal(idx.events.length, 1);
  assert.equal(idx.events[0].classes[0].competitors[0].firstName, 'A');
  assert.ok(seen.some(u => u.endsWith('.meta.json')) && seen.some(u => u.endsWith('.json') && !u.endsWith('.meta.json')));
});

test('loadIndexCached : échec réseau → throw (l’appelant dégrade)', async () => {
  global.fetch = async () => { throw new Error('Failed to fetch'); };
  await assert.rejects(() => SC.loadIndexCached({
    metaUrl: 'https://x/m.meta.json', cacheKey: 'k', sources: ['https://x/f.json'],
    tag: '[test]', label: 'X', onStatus: () => {}, onProgress: () => {},
  }), /Failed to fetch/);
  delete global.fetch;
});

// --- helpers d'UI (renderDataDates, setTextStatus, setBarProgress) ---
function fakeEl() {
  return {
    textContent: '', hidden: true, style: {},
    _cls: new Set(),
    classList: {
      toggle: function (k, v) { v ? this._s.add(k) : this._s.delete(k); },
      _s: null,
    },
  };
}
function withDoc(ids, fn) {
  const els = {};
  for (const id of ids) { els[id] = fakeEl(); els[id].classList._s = els[id]._cls; }
  const prev = global.document;
  global.document = { getElementById: id => els[id] || null };
  try { return fn(els); } finally { global.document = prev; }
}

test('renderDataDates : écrit + révèle, null si rien', () => {
  withDoc(['dataDateWrap', 'dataDate'], els => {
    assert.equal(SC.renderDataDates([{ tag: 'FR', iso: '2026-09-07' }]), '07/09/2026');
    assert.equal(els.dataDate.textContent, '07/09/2026');
    assert.equal(els.dataDateWrap.hidden, false);
    assert.equal(SC.renderDataDates([{ tag: 'FR', iso: null }]), null);
    assert.equal(SC.renderDataDates([{ tag: 'FR', iso: '2026-09-07' }]), '07/09/2026'); // idempotent
  });
});

test('renderDataDates : deux sources → libellés', () => {
  withDoc(['dataDateWrap', 'dataDate'], els => {
    assert.equal(
      SC.renderDataDates([{ tag: 'FR', iso: '2026-09-07' }, { tag: 'UEC', iso: '2026-09-08' }]),
      'FR 07/09/2026 · UEC 08/09/2026');
  });
});

test('setTextStatus : texte + classe error préservant le reste', () => {
  withDoc(['s'], els => {
    els.s._cls.add('status');
    SC.setTextStatus(els.s, 'Chargement…');
    assert.equal(els.s.textContent, 'Chargement…');
    assert.ok(!els.s._cls.has('error') && els.s._cls.has('status'));
    SC.setTextStatus(els.s, 'Échec', true);
    assert.ok(els.s._cls.has('error') && els.s._cls.has('status'));
    SC.setTextStatus(null, 'x'); // no-op
  });
});

test('setBarProgress : % plafonné à 99, masqué si !total', () => {
  withDoc(['progressWrap', 'progressBar'], els => {
    SC.setBarProgress(1, 2);
    assert.equal(els.progressWrap.hidden, false);
    assert.equal(els.progressBar.style.width, '50%');
    SC.setBarProgress(999, 1000);
    assert.equal(els.progressBar.style.width, '99%');
    SC.setBarProgress(0, 0);
    assert.equal(els.progressWrap.hidden, true);
  });
});

// --- état partagé (favoris / récents) ---
function withLS(fn) {
  const store = {};
  const prev = global.localStorage;
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  try { return fn(store); } finally { global.localStorage = prev; }
}

test('favoris : toggle/isFav/getFavs, types isolés', () => {
  withLS(() => {
    assert.equal(SC.isFav('pilots', 'jean dupont'), false);
    assert.equal(SC.toggleFav('pilots', 'jean dupont', 'Jean Dupont'), true);
    assert.equal(SC.isFav('pilots', 'jean dupont'), true);
    assert.deepEqual(SC.getFavs('pilots').map(f => f.key), ['jean dupont']);
    assert.equal(SC.toggleFav('pilots', 'jean dupont'), false);
    assert.deepEqual(SC.getFavs('pilots'), []);
    assert.equal(SC.toggleFav('nope', 'x'), false);
    assert.deepEqual(SC.getFavs('nope'), []);
    SC.toggleFav('clubs', 'besanc', 'BMX BESANCON (BESANC)');
    assert.equal(SC.isFav('clubs', 'besanc'), true);
    assert.equal(SC.isFav('pilots', 'besanc'), false);
  });
});

test('favoris : JSON corrompu → [] sans throw', () => {
  withLS(store => {
    store['bmx.favs.pilots'] = 'pas du json{{{';
    assert.deepEqual(SC.getFavs('pilots'), []);
    assert.equal(SC.isFav('pilots', 'x'), false);
  });
});

test('migration : clés héritées « sqorz.* » recopiées puis purgées (renommage bmx-race)', () => {
  const store = {
    'sqorz.favs.pilots': JSON.stringify([{ key: 'lea martin', name: 'Léa Martin', at: 1 }]),
    'sqorz.favs.clubs': JSON.stringify([{ key: 'besanc', name: 'BMX BESANCON (BESANC)', at: 2 }]),
    'sqorz.recent': JSON.stringify([{ t: 'clubs', k: 'besanc', n: 'BMX BESANCON (BESANC)', at: 3 }]),
  };
  const prev = global.localStorage;
  global.localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  try {
    const M = new Function('window', src + '\nreturn window.BmxCommon;')({});
    assert.deepEqual(M.getFavs('pilots').map(f => f.key), ['lea martin'], 'favoris pilotes migrés');
    assert.deepEqual(M.getFavs('clubs').map(f => f.key), ['besanc'], 'favoris clubs migrés');
    assert.equal(M.getRecent(10)[0].k, 'besanc', 'récents migrés');
    assert.equal('sqorz.favs.pilots' in store, false, 'clé héritée pilotes purgée');
    assert.equal('sqorz.recent' in store, false, 'clé héritée récents purgée');
  } finally {
    global.localStorage = prev;
  }
});

test('récents : dédupliqués, plus récent d’abord, plafonnés', () => {
  withLS(() => {
    SC.pushRecent('pilots', 'a', 'A');
    SC.pushRecent('clubs', 'b', 'B');
    SC.pushRecent('pilots', 'a', 'A');
    assert.deepEqual(SC.getRecent(10).map(r => r.k), ['a', 'b']);
    for (let i = 0; i < 25; i++) SC.pushRecent('pilots', 'p' + i, 'P' + i);
    assert.equal(SC.getRecent(99).length, 20);
    SC.pushRecent('inconnu', 'x'); // type invalide ignoré
    assert.ok(!SC.getRecent(99).some(r => r.k === 'x'));
  });
});


// --- contre-la-montre (runs en solo : result=1 partout, seul le chrono + le rang final comptent) ---
test('isTimeTrialPhase : TT/TTF + noms, jamais les courses en peloton', () => {
  assert.equal(SC.isTimeTrialPhase({ phaseCode: 'TT', phaseName: 'Time Trial', result: 1 }), true);
  assert.equal(SC.isTimeTrialPhase({ phaseCode: 'TTF', phaseName: 'Super Final', result: 1 }), true);
  assert.equal(SC.isTimeTrialPhase({ phaseName: 'Super Final' }), true, 'sans code');
  assert.equal(SC.isTimeTrialPhase({ pc: 'TTF', n: 'Super Final', r: 1 }), true, 'forme slim');
  assert.equal(SC.isTimeTrialPhase({ phaseName: 'Finale', result: 1 }), false, 'vraie finale');
  assert.equal(SC.isTimeTrialPhase({ phaseName: '1/2 Finale' }), false);
  assert.equal(SC.isTimeTrialPhase({ phaseName: 'Manche 1', result: 1 }), false);
  assert.equal(SC.isTimeTrialPhase({ phaseName: 'SUPER FINALE REGIONALE' }), false, 'pas de faux positif large');
  assert.equal(SC.isTimeTrialPhase(null), false);
});
