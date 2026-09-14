#!/usr/bin/env node
// Génère uci-worldcup-index.json (manches de Coupe du monde UCI BMX Racing)
// depuis l'API publique uci.org, complément des index Sqorz (build-index.js) et UEC.
// Spec : docs/superpowers/specs/2026-09-14-uci-worldcup-design.md
//
// Usage : node build-uciworldcup.js [--limit N] [--match SUBSTR] [--no-cache]
//   --limit N      ne crawler que les N premières manches (build de test)
//   --match SUBSTR ne crawler que les manches dont l'URL/nom contient SUBSTR
//   --no-cache     ignorer le cache de contenu .cache/uciworldcup
//
// Chaîne de découverte : sitemap.xml → pages race-hub (ResultsAccordion embarqué :
// eventCodes par classe) → GET /api/calendar/results/{eventCode} (sans auth).
//
// Format de sortie aligné sur uec-index.json / uci-index.json :
//   uci-worldcup-index.json          index complet (clés courtes slim)
//   uci-worldcup-index.events.ndjson 1 événement par ligne (streaming mobile)
//   uci-worldcup-index.meta.json     sha256 + tailles + date de génération
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const SITEMAP = 'https://www.uci.org/sitemap.xml';
const API = 'https://www.uci.org/api';
const ORG = { accountCode: 'uciworldcup', accountName: 'UCI BMX Racing World Cup' };
const DELAY_MS = 150;   // identique à build-uec.js (aucun rate-limit observé)
const RETRIES = 3;
const CACHE_DIR = path.join('.cache', 'uciworldcup');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// Manches 2023+ (aligné UEC). Ancien template sans accordion : ignorées avec avertissement.
const MIN_YEAR = 2023;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');

// --- CLI ---
const args = process.argv.slice(2);
let optLimit = 0, optMatch = '', optNoCache = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit') optLimit = parseInt(args[++i], 10) || 0;
  else if (args[i] === '--match') optMatch = args[++i] || '';
  else if (args[i] === '--no-cache') optNoCache = true;
}

// --- HTTP + cache de contenu (miroir build-uec.js) : un fichier par URL, clé = sha256(url) ---
function cachePath(url) {
  return path.join(CACHE_DIR, sha256(url) + '.txt');
}
async function fetchCached(url, { binary = false } = {}) {
  if (!optNoCache) {
    try {
      const raw = fs.readFileSync(cachePath(url), binary ? null : 'utf8');
      return binary ? raw : raw.toString();
    } catch { /* pas en cache */ }
  }
  let lastErr = null;
  for (let k = 0; k < RETRIES; k++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: binary ? '*/*' : 'application/json, text/html' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cachePath(url), buf);
      await sleep(DELAY_MS);
      return binary ? buf : buf.toString('utf8');
    } catch (e) { lastErr = e; await sleep(DELAY_MS * (k + 1)); }
  }
  throw lastErr;
}

// --- Découverte : URLs race-hub Coupe du monde BMX Racing depuis le sitemap ---
function isWorldCupRaceHub(url) {
  const u = (url || '').toLowerCase();
  if (!u.includes('/race-hub/')) return false;
  if (u.includes('freestyle')) return false;
  return u.includes('bmx-racing-world-cup') || u.includes('bmx-sx-world-cup') || u.includes('bmx-world-cup');
}
async function listRaceHubs() {
  const xml = await fetchCached(SITEMAP);
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  return [...new Set(urls.filter(isWorldCupRaceHub))].sort();
}

// --- Page race-hub : métadonnées + items ResultsAccordion {label, title, eventCode, raceType} ---
function htmlUnescape(s) {
  return (s || '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
function parseRaceHub(html, url) {
  html = htmlUnescape(html); // props JSON en entités &quot; dans le source
  const get = re => { const m = html.match(re); return m ? m[1] : ''; };
  const raceTitle = get(/"raceTitle":"([^"]*)"/);
  const dateIso = get(/"raceStartDate":"(\d{4}-\d{2}-\d{2})/);
  const items = [];
  const seen = new Set();
  const subRe = /"label":"Results","slug":"results","content":"((?:[^"\\]|\\.)*)"/g;
  let sub;
  while ((sub = subRe.exec(html)) !== null) {
    let content;
    try { content = JSON.parse('"' + sub[1] + '"'); } catch { continue; }
    const accRe = /data-component="ResultsAccordion" data-props="(\{.*?\})"(?=>)/gs;
    let acc;
    while ((acc = accRe.exec(content)) !== null) {
      let props;
      try { props = JSON.parse(htmlUnescape(acc[1])); } catch { continue; }
      for (const group of props.accordion || []) {
        for (const r of group.results || []) {
          if (!r || !r.eventCode) continue;
          if (seen.has(r.eventCode)) continue;
          seen.add(r.eventCode);
          items.push({ title: r.title || '', eventCode: r.eventCode, raceType: r.raceType || 'A', label: group.label || '' });
        }
      }
    }
  }
  return { url, raceTitle, dateIso, items };
}

// --- Mapping libellé → classe stable (codes ME/WE/MU23/WU23) ---
function classForLabel(label) {
  const n = (label || '').toLowerCase();
  const women = n.includes('women');
  if (n.includes('under 23') || /\bu23\b/.test(n)) {
    return women ? { code: 'WU23', name: 'Women U23' } : { code: 'MU23', name: 'Men U23' };
  }
  if (n.includes('junior')) {
    return women ? { code: 'WJ', name: 'Women Junior' } : { code: 'MJ', name: 'Men Junior' };
  }
  if (n.includes('elite') || n.includes('men') || n.includes('women')) {
    return women ? { code: 'WE', name: 'Women Elite' } : { code: 'ME', name: 'Men Elite' };
  }
  return null;
}

// --- API résultats → compétiteurs slim ---
function slimRider(v) {
  const rank = parseInt(v.rank, 10);
  if (!Number.isFinite(rank)) return null;
  const fn = (v.firstname || '').trim();
  const ln = (v.lastname || '').trim();
  if (!fn && !ln) return null;
  const out = { fn, ln, rank, gn: (v.nationality || '').trim(), d: [] };
  const age = parseInt(v.age, 10);
  if (Number.isFinite(age)) out.age = age;
  return out;
}
async function fetchResults(item) {
  const q = `/calendar/results/${item.eventCode}?discipline=BMX&raceType=${encodeURIComponent(item.raceType || 'A')}&raceName=${encodeURIComponent(item.title)}`;
  const raw = await fetchCached(API + q);
  const data = JSON.parse(raw);
  return (data.results || [])
    .filter(r => r && r.headerType === 'rider' && r.values)
    .map(r => slimRider(r.values))
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank);
}

// --- Nom d'événement : année + manche + lieu depuis l'URL + la page ---
function eventMeta(url, raceTitle, dateIso) {
  const year = (dateIso || '').slice(0, 4);
  const mRound = (url || '').match(/round-(\d+)/i);
  const round = mRound ? parseInt(mRound[1], 10) : 0;
  const venue = (raceTitle || '').trim();
  const name = round && venue ? `Coupe du monde #${round} – ${venue} ${year}`
    : round ? `Coupe du monde #${round} ${year}`
    : venue ? `Coupe du monde – ${venue} ${year}` : `Coupe du monde ${year}`;
  return { eventId: year && round ? `wc${year}r${round}` : '', name, date: (dateIso || '').slice(0, 10), url: url || '' };
}

function writeOutputs(index, indexEvents) {
  const json = JSON.stringify(index);
  fs.writeFileSync('uci-worldcup-index.json', json);
  const eventsNdjson = indexEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync('uci-worldcup-index.events.ndjson', eventsNdjson);
  fs.writeFileSync('uci-worldcup-index.meta.json', JSON.stringify({
    generated: index.generated,
    index: { sha256: sha256(json), sizeBytes: Buffer.byteLength(json, 'utf8') },
    events: { sha256: sha256(eventsNdjson), sizeBytes: Buffer.byteLength(eventsNdjson, 'utf8') },
  }, null, 2) + '\n');
  return json.length;
}

async function main() {
  console.log('=== Index Coupe du monde UCI BMX Racing (uci.org) ===');
  if (optLimit) console.log(`Mode test : --limit ${optLimit}`);
  if (optMatch) console.log(`Filtre : --match "${optMatch}"`);

  console.log('=== Étape 1 : manches via sitemap ===');
  let urls = await listRaceHubs();
  if (optMatch) urls = urls.filter(u => u.toLowerCase().includes(optMatch.toLowerCase()));
  if (optLimit) urls = urls.slice(0, optLimit);
  console.log(`${urls.length} page(s) race-hub\n`);

  console.log('=== Étape 2 : crawl des manches ===');
  const indexEvents = [];
  const seenEventIds = new Set();
  let skipped = 0;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    process.stdout.write(`[${i + 1}/${urls.length}] ${url.split('/race-hub/')[1].slice(0, 60)} … `);
    try {
      const page = await fetchCached(url);
      const parsed = parseRaceHub(page, url);
      const meta = eventMeta(url, parsed.raceTitle, parsed.dateIso);
      if (!meta.date || Number(meta.date.slice(0, 4)) < MIN_YEAR) { console.log('hors périmètre (année)'); skipped++; continue; }
      if (!parsed.items.length) { console.log('sans accordion (ancien template)'); skipped++; continue; }
      if (meta.eventId && seenEventIds.has(meta.eventId)) { console.log('doublon eventId'); skipped++; continue; }
      if (meta.eventId) seenEventIds.add(meta.eventId);
      const classes = [];
      for (const it of parsed.items) {
        const cls = classForLabel(it.label || it.title);
        if (!cls) { console.log(`\n  classe inconnue ignorée : ${it.label || it.title}`); continue; }
        let riders = [];
        try {
          riders = await fetchResults(it);
        } catch (e) { console.log(`\n  API en échec (${it.eventCode}) : ${e.message}`); continue; }
        if (!riders.length) continue;
        classes.push({
          className: cls.name, perpetualClassCode: cls.code, total: riders.length, competitors: riders,
        });
      }
      if (!classes.length) { console.log('aucune classe'); skipped++; continue; }
      indexEvents.push({
        account: { ...ORG },         event: { eventId: meta.eventId, eventName: meta.name, eventDate: meta.date, url: meta.url },
        classes, series: [],
      });
      console.log(`${classes.length} classes, ${classes.reduce((a, c) => a + c.competitors.length, 0)} pilotes`);
    } catch (e) {
      console.log(`ERREUR: ${e.message}`);
      skipped++;
    }
  }
  indexEvents.sort((a, b) => b.event.eventDate.localeCompare(a.event.eventDate));

  const index = {
    generated: new Date().toISOString().slice(0, 10),
    orgs: [{ ...ORG }],
    events: indexEvents,
    series: [],
  };
  const totalBytes = writeOutputs(index, indexEvents);
  let totalCompetitors = 0;
  for (const ev of indexEvents) for (const cls of ev.classes) totalCompetitors += cls.competitors.length;
  console.log('');
  console.log('=== Terminé (uci-worldcup-index.json) ===');
  console.log(`${indexEvents.length} manches indexées${skipped ? `, ${skipped} ignorées` : ''}, ${totalCompetitors} entrées pilotes`);
  console.log(`Taille : ${(totalBytes / 1024).toFixed(0)} Ko (non compressé)`);
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

// Helpers exportés pour les tests unitaires (node --test tests/)
module.exports = { isWorldCupRaceHub, parseRaceHub, classForLabel, slimRider, eventMeta, sha256 };
