// Time trial : ni « 1er » factice à l'affichage, ni victoire en stats.
// Les runs sont en solo (result=1 pour tous) — seuls le chrono et le rang final comptent.
// Cas réel : Lukas CHAUDUN, 2e de la Super Final du CDF Time Trial 2026 (31.992 derrière
// Terry VENTURINI 31.970), affiché « Super Final 1er » + 1 victoire en finale.
// Usage : node --test tests/timetrial.test.js
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
const commonSrc = fs.readFileSync(path.join(__dirname, '..', 'common.js'), 'utf8');
const SC = new Function('window', commonSrc + '\nreturn window.BmxCommon;')({});
// computeStats est longue : extraction bornée (finit juste avant SQORZ_WEB_BASE).
const csStart = html.indexOf('function computeStats(matches) {');
const csEnd = html.indexOf('\n  const SQORZ_SITE', csStart);
if (csStart < 0 || csEnd < 0) throw new Error('computeStats introuvable');
const computeSrc = html.slice(csStart, csEnd);
const H = new Function(
  'escape', 'ordFr', 'isFinalPhase', 'isMotoPhase', 'isTimeTrialPhase', 'num',
  [
    block('function specialResultLabel(r) {'),
    block('function fmtResult(n) {'),
    block('function percentile(rank, total){'),
    block('function isSemiPhase(d) {'),
    block('function isKnockoutPhase(d) {'),
    block('function frPhaseName(raw) {'),
    block('function phaseTag(d, ctx) {'),
    computeSrc,
  ].join('\n') + '\nreturn { specialResultLabel, fmtResult, phaseTag, computeStats };'
)(SC.escape, n => n + 'e', SC.isFinalPhase, SC.isMotoPhase, SC.isTimeTrialPhase, SC.num);

const SF = { phaseName: 'Super Final', phaseCode: 'TTF', phaseBlockCode: 'TTF', raceName: 'SF23', result: 1, time: '31.992' };

test('phaseTag : Super Final TT → chrono affiché, pas de 1er factice', () => {
  const tag = H.phaseTag(SF, null);
  assert.ok(tag.includes('⏱ 31.992'), 'chrono visible : ' + tag);
  assert.ok(!tag.includes('pos-1'), 'pas de dorure 1er');
  assert.ok(tag.includes('is-tt'), 'classe dédiée');
});

test('phaseTag : TT sans chrono mais DNF → mention, pas de victoire', () => {
  const tag = H.phaseTag({ phaseName: 'Super Final', phaseCode: 'TTF', result: 100000 }, null);
  assert.ok(tag.includes('DNF') && tag.includes('dnx'), 'abandon lisible : ' + tag);
  assert.ok(!tag.includes('pos-1'), 'pas de victoire');
});

test('phaseTag : vraie finale gagnée inchangée', () => {
  const tag = H.phaseTag({ phaseName: 'Finale', result: 1 }, null);
  assert.ok(tag.includes('pos-1') && tag.includes('is-final'), 'dorure conservée : ' + tag);
});

function ttMatch(rank) {
  return {
    event: { eventId: 'e1', eventDate: '2026-07-03', eventName: 'CDF T. TRIAL' },
    account: { accountCode: 'a', accountName: 'A' },
    cls: { className: 'U19 HOMME', perpetualClassCode: 'JHR' },
    totalParticipants: 14,
    competitor: {
      firstName: 'Lukas', lastName: 'CHAUDUN', rank,
      competitorRankDetails: [
        { phaseName: 'Time Trial', phaseCode: 'TT', result: 1, time: '32.199' },
        { phaseName: 'Super Final', phaseCode: 'TTF', result: 1, time: '31.992' },
      ],
    },
  };
}

test('computeStats : Super Final TT 2e → pas de victoire en finale', () => {
  const s = H.computeStats([ttMatch(2)]);
  assert.equal(s.finalWins, 0, 'pas de victoire factice');
  assert.equal(s.finalPodiums, 0, 'pas de podium de phase factice');
  assert.equal(s.wins, 0, '2e du final ≠ victoire');
  assert.equal(s.podiums, 1, 'podium via rang final conservé');
  assert.equal(s.finalsReached, 1, 'top 8 via rang final');
});

test('computeStats : vraie finale gagnée toujours comptée', () => {
  const m = ttMatch(1);
  m.competitor.rank = 1;
  m.competitor.competitorRankDetails = [
    { phaseName: 'Manche 1', result: 2 },
    { phaseName: 'Finale', result: 1 },
  ];
  const s = H.computeStats([m]);
  assert.equal(s.finalWins, 1, 'victoire en peloton conservée');
  assert.equal(s.wins, 1);
});
