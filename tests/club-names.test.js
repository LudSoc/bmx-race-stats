// Tests des noms complets de clubs (clubs.json + helpers dans index.html).
// Format : « BMX BESANCON (BESANC) », repli code seul si inconnu.
// Usage : node --test tests/club-names.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function block(start, indent = '  ') {
  const i = src.indexOf(start);
  if (i < 0) throw new Error('marqueur introuvable : ' + start);
  const j = src.indexOf('\n' + indent + '}\n', i);
  if (j < 0) throw new Error('fin de bloc introuvable pour : ' + start);
  return src.slice(i, j + ('\n' + indent + '}\n').length);
}
const harness = [
  block('const normClubCode = s =>'),
  'for (const [k, v] of Object.entries(__SEED)) clubFullNames.set(k, v);',
  block('function clubDisplayName(raw) {'),
].join('\n') + '\nreturn { normClubCode, clubDisplayName };';
const H = seed => new Function('__SEED', harness)(seed);

test('connu → « Nom (CODE) »', () => {
  const h = H({ besanc: 'BMX BESANCON' });
  assert.equal(h.clubDisplayName('BESANC'), 'BMX BESANCON (BESANC)');
});

test('inconnu → code seul', () => {
  const h = H({});
  assert.equal(h.clubDisplayName('EABORD'), 'EABORD');
  assert.equal(h.clubDisplayName('SUI'), 'SUI');
});

test('clé compatible club_stats (tiret conservé)', () => {
  const h = H({ 'joue-t': 'JOUE LES TOURS BMX' });
  assert.equal(h.normClubCode('JOUE-T'), 'joue-t');
  assert.equal(h.clubDisplayName('JOUE-T'), 'JOUE LES TOURS BMX (JOUE-T)');
});

test('lien fiche club : clé sans espace (pas de norm() qui mange le tiret)', () => {
  assert.ok(!src.includes('?club=${encodeURIComponent(norm(club))}'), 'ancien lien norm() supprimé');
  assert.ok(src.includes('encodeURIComponent(normClubCode(club))'), 'lien en normClubCode');
});

test('clubs.json : copie conforme au canonique club_stats', () => {
  const local = fs.readFileSync(path.join(__dirname, '..', 'clubs.json'), 'utf8');
  const ref = fs.readFileSync(path.join(__dirname, '..', '..', 'club_stats', 'clubs.json'), 'utf8');
  assert.equal(local, ref, 'copie exacte (via tools/sync-clubs.sh)');
  const { _meta, mapping } = JSON.parse(local);
  assert.ok(_meta && mapping && Object.keys(mapping).length >= 200);
  assert.equal(mapping.USCBMX.name, 'US CAGNES BMX');
});

test('pied de page : toutes les sources citées (Sqorz, JSTiming, UCI)', () => {
  assert.ok(src.includes('>Sqorz</a> (France, Mondiaux)'), 'Sqorz France');
  assert.ok(src.includes('>JSTiming</a> (Europe UEC)'), 'JSTiming Europe UEC');
  assert.ok(src.includes('>UCI</a> (Coupe du monde)'), 'UCI Coupe du monde');
});
