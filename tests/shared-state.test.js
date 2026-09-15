// Tests de l'état partagé inter-outils côté bmx-race-stats (convention bmx.*).
// Usage : node --test tests/shared-state.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('helpers partagés importés du socle', () => {
  assert.ok(src.includes('isFav, toggleFav, pushRecent') || src.includes('getFavs, isFav, toggleFav, pushRecent'),
    'destructure BmxCommon');
});

test('fiche pilote : bouton ☆ avec état initial isFav', () => {
  assert.ok(src.includes('data-fav-pilot'), 'bouton présent');
  assert.ok(src.includes("isFav('pilots', norm(fullName))"), 'état initial');
  assert.ok(src.includes("toggleFav('pilots', btn.dataset.favPilot"), 'bascule au clic');
});

test('fiche pilote vue → récents partagés', () => {
  assert.ok(src.includes("pushRecent('pilots', norm(fullName), fullName)"), 'pushRecent au rendu');
});

test('dégradation gracieuse si le CDN common.js est en retard (helpers absents)', () => {
  assert.ok(src.includes("typeof pushRecent === 'function'"), 'pushRecent gardé');
  assert.ok(src.includes('const favNow = typeof isFav'), 'isFav gardé via favNow');
  assert.ok(src.includes("typeof toggleFav !== 'function'"), 'toggleFav gardé au clic');
});

test('pied de page : Sqorz et JSTiming (données UEC utilisées ici)', () => {
  assert.ok(src.includes('>Sqorz</a> et <a href="https://www.jstiming.nl"'), 'double attribution');
});

test('aide indice : tous les coefficients cités (anti-dérive doc/code)', () => {
  for (const coef of ['2,5', '0,97', '1,05', '0,3', '0,93', '1,0', '250', '400', '550', '700', 'preuves']) {
    assert.ok(src.includes(coef), `coef cité : ${coef}`);
  }
  assert.ok(!src.includes('resserrée selon la preuve'), 'formulation obscure bannie');
});
