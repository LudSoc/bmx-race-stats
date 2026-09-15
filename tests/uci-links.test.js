// Liens événements CDM : uci.org, jamais Sqorz (pas de pages Sqorz pour la Coupe du monde).
// Usage : node --test tests/uci-links.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function block(start, indent = '  ') {
  const i = html.indexOf(start);
  if (i < 0) throw new Error('marqueur introuvable : ' + start);
  const j = html.indexOf('\n' + indent + '}\n', i);
  if (j < 0) throw new Error('fin de bloc introuvable pour : ' + start);
  return html.slice(i, j + ('\n' + indent + '}\n').length);
}
function stmt(start) {
  const i = html.indexOf(start);
  if (i < 0) throw new Error('marqueur introuvable : ' + start);
  return html.slice(i, html.indexOf(';', i) + 1);
}
const commonSrc = fs.readFileSync(path.join(__dirname, '..', 'common.js'), 'utf8');
const SC = new Function('window', commonSrc + '\nreturn window.BmxCommon;')({});
const H = new Function(
  'window', 'escape',
  [
    stmt('const SQORZ_SITE ='),
    block('function eventUrl(accountCode, eventId, event) {'),
    block('function classUrl(accountCode, eventId, perpetualClassCode, event) {'),
    block('function slimMatch(m) {'),
  ].join('\n') + '\nreturn { eventUrl, classUrl, slimMatch };'
)({ location: { protocol: 'https:' } }, SC.escape);

const HUB = 'https://www.uci.org/race-hub/2026-uci-bmx-racing-world-cup-round-5/1GY1HT3eUP3zffWTCOODIB';

test('eventUrl : CDM → race-hub uci.org, FR inchangé', () => {
  assert.equal(
    H.eventUrl('uciworldcup', 'wc2026r5', { eventId: 'wc2026r5', url: HUB }),
    HUB, 'manche CDM → uci.org');
  assert.equal(H.eventUrl('uciworldcup', 'wc2026r5', {}), null, 'CDM sans URL → aucun lien (jamais Sqorz)');
  assert.equal(
    H.eventUrl('ffc', '68e7c29f1b59e47481564903', {}),
    'https://our.sqorz.com/org/ffc/event/68e7c29f1b59e47481564903',
    'FR → Sqorz');
  assert.equal(H.eventUrl('', '', {}), null);
});

test('classUrl : CDM → race-hub uci.org, FR inchangé', () => {
  assert.equal(
    H.classUrl('uciworldcup', 'wc2026r5', 'ME', { url: HUB }),
    HUB, 'catégorie CDM → manche uci.org');
  assert.equal(H.classUrl('uciworldcup', 'wc2026r5', 'ME', {}), null, 'sans URL → rien');
  assert.equal(
    H.classUrl('ffc', 'evt1', 'U17GR', {}),
    'https://our.sqorz.com/org/ffc/event/evt1/class/U17GR',
    'FR → Sqorz');
});

test('slimMatch : url race-hub conservée (CDM), absente sinon', () => {
  const m = ev => ({
    account: { accountCode: 'uciworldcup', accountName: 'UCI BMX Racing World Cup' },
    event: ev, cls: { className: 'Men Elite', perpetualClassCode: 'ME' },
    competitor: { firstName: 'A', lastName: 'B' }, totalParticipants: 10,
  });
  assert.equal(
    H.slimMatch(m({ eventId: 'wc2026r5', eventName: 'CDM', eventDate: '2026-10-03', url: 'https://www.uci.org/race-hub/x/y' })).event.url,
    'https://www.uci.org/race-hub/x/y', 'url transmise au cache');
  assert.ok(!('url' in H.slimMatch(m({ eventId: 'e', eventName: 'E', eventDate: '2026-01-01' })).event),
    'pas de champ vide en cache');
});
