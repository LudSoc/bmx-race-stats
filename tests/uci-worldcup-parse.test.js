// Tests unitaires des helpers de build-uciworldcup.js (spec UCI World Cup §7).
// Usage : node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const {
  isWorldCupRaceHub, parseRaceHub, classForLabel, slimRider, eventMeta,
} = require('../build-uciworldcup.js');

test('isWorldCupRaceHub : Coupe du monde BMX Racing uniquement', () => {
  assert.equal(isWorldCupRaceHub('https://www.uci.org/race-hub/2026-uci-bmx-racing-world-cup-round-5/1GY1HT3eUP3zffWTCOODIB'), true);
  assert.equal(isWorldCupRaceHub('https://www.uci.org/race-hub/uci-bmx-racing-world-cup-2023-round-1/7gqh8a3sYIOOvddILskT3E'), true);
  assert.equal(isWorldCupRaceHub('https://www.uci.org/race-hub/uci-bmx-sx-world-cup-round-6/39hclk36VB5yho6d2UQaIr'), true);
  assert.equal(isWorldCupRaceHub('https://www.uci.org/race-hub/2026-uci-bmx-racing-world-championships/44hdJ2DSUmVTNqqfcAk91s'), false, 'championnats exclus (v1)');
  assert.equal(isWorldCupRaceHub('https://www.uci.org/race-hub/2022-uci-urban-cycling-world-championships-bmx-freestyle/5nRUrv2KbOnem3dxm2VHWU'), false, 'freestyle exclu');
  assert.equal(isWorldCupRaceHub('https://www.uci.org/race-hub/2021-2022-uci-cyclo-cross-world-cup-namur-bel/774THxXZedmNLKuHiw2sCH'), false, 'cyclo-cross exclu');
  assert.equal(isWorldCupRaceHub('https://www.uci.org/calendar/all/2jnxYAuvjgttyHi6YQ94EJ'), false);
  assert.equal(isWorldCupRaceHub(''), false);
});

test('parseRaceHub : métadonnées + items ResultsAccordion (double encodage)', () => {
  const props = {
    accordion: [
      { label: 'Men Elite - Final Result', results: [{ title: 'General Classification', eventCode: 'D2EV1', raceType: 'A' }] },
      { label: 'Women Under 23 - Final Result', results: [{ title: 'General Classification', eventCode: 'D2EV2', raceType: 'A' }] },
    ],
  };
  const inner = '<div data-component="ResultsAccordion" data-props="' +
    JSON.stringify(props) + '"></div>';
  const sub = { label: 'Results', slug: 'results', content: inner };
  const page = '{"raceTitle":"Sarrians","raceStartDate":"2026-06-06T00:00:00.0000000","subTabs":[' +
    JSON.stringify(sub) + ']}';
  const parsed = parseRaceHub(page, 'https://www.uci.org/race-hub/x/');
  assert.equal(parsed.raceTitle, 'Sarrians');
  assert.equal(parsed.dateIso, '2026-06-06');
  assert.deepEqual(parsed.items, [
    { title: 'General Classification', eventCode: 'D2EV1', raceType: 'A', label: 'Men Elite - Final Result' },
    { title: 'General Classification', eventCode: 'D2EV2', raceType: 'A', label: 'Women Under 23 - Final Result' },
  ]);
});

test('parseRaceHub : extrait réel Sakarya 2023 (vrai encodage page)', () => {
  const page = fs.readFileSync(path.join(__dirname, 'fixtures', 'uci-racehub-2023r1.html'), 'utf8');
  const parsed = parseRaceHub(page, 'https://www.uci.org/race-hub/uci-bmx-racing-world-cup-2023-round-1/xxx');
  assert.equal(parsed.raceTitle, 'Sakarya');
  assert.equal(parsed.dateIso, '2023-06-03');
  assert.deepEqual(parsed.items.map(i => i.eventCode), ['D2EV295790', 'D2EV295791', 'D2EV295794', 'D2EV295795']);
  assert.deepEqual(parsed.items.map(i => i.label), [
    'Men Elite - Final Result', 'Women Elite - Final Result',
    'Men Under 23 - Final Result', 'Women Under 23 - Final Result']);
});

test('parseRaceHub : doublons dédupliqués, page sans accordion', () => {  const props = {
    accordion: [{ label: 'Men Elite - Final Result', results: [
      { title: 'General Classification', eventCode: 'D2EV1', raceType: 'A' },
      { title: 'General Classification', eventCode: 'D2EV1', raceType: 'A' },
    ] }],
  };
  const inner = '<div data-component="ResultsAccordion" data-props="' +
    JSON.stringify(props) + '"></div>';
  const page = '"label":"Results","slug":"results","content":' + JSON.stringify(inner);
  assert.equal(parseRaceHub(page, 'u').items.length, 1, 'doublon eventCode');
  assert.deepEqual(parseRaceHub('<html>sans rien</html>', 'u'), { url: 'u', raceTitle: '', dateIso: '', items: [] });
});

test('classForLabel : 4 classes stables + variantes', () => {
  assert.deepEqual(classForLabel('Men Elite - Final Result'), { code: 'ME', name: 'Men Elite' });
  assert.deepEqual(classForLabel('Women Elite - Final Result'), { code: 'WE', name: 'Women Elite' });
  assert.deepEqual(classForLabel('Men Under 23 - Final Result'), { code: 'MU23', name: 'Men U23' });
  assert.deepEqual(classForLabel('Women Under 23 - Final Result'), { code: 'WU23', name: 'Women U23' });
  assert.deepEqual(classForLabel('Men Junior - Final Result'), { code: 'MJ', name: 'Men Junior' });
  assert.equal(classForLabel('Truc inconnu'), null);
  assert.equal(classForLabel(''), null);
});

test('slimRider : mapping API → slim, rangs invalides ignorés', () => {
  assert.deepEqual(
    slimRider({ rank: '3', firstname: 'Mathis', lastname: 'RAGOT RICHARD', age: 28, nationality: 'FRA' }),
    { fn: 'Mathis', ln: 'RAGOT RICHARD', rank: 3, gn: 'FRA', d: [], age: 28 });
  assert.equal(slimRider({ rank: 'DNF', firstname: 'A', lastname: 'B' }), null, 'rang non numérique');
  assert.equal(slimRider({ rank: '', firstname: 'A', lastname: 'B' }), null);
  assert.equal(slimRider({ rank: '5', firstname: '', lastname: '' }), null, 'sans nom');
  assert.deepEqual(
    slimRider({ rank: '7', firstname: 'Jo', lastname: 'X', nationality: '' }),
    { fn: 'Jo', ln: 'X', rank: 7, gn: '', d: [] }, 'sans âge ni pays');
});

test('eventMeta : eventId stable + nom FR + url race-hub', () => {
  assert.deepEqual(
    eventMeta('https://www.uci.org/race-hub/2026-uci-bmx-racing-world-cup-round-5-xyz/ABC', 'Mentougou', '2026-10-03T00:00:00.0000000'),
    { eventId: 'wc2026r5', name: 'Coupe du monde #5 – Mentougou 2026', date: '2026-10-03', url: 'https://www.uci.org/race-hub/2026-uci-bmx-racing-world-cup-round-5-xyz/ABC' });
  assert.deepEqual(
    eventMeta('https://www.uci.org/race-hub/uci-bmx-sx-world-cup-round-6/ABC', '', '2024-05-01T00:00:00.0000000'),
    { eventId: 'wc2024r6', name: 'Coupe du monde #6 2024', date: '2024-05-01', url: 'https://www.uci.org/race-hub/uci-bmx-sx-world-cup-round-6/ABC' });
  assert.equal(eventMeta('https://x/', '', '').eventId, '', 'sans round ni date');
});
