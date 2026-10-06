#!/usr/bin/env node
// Génère uec-index.json (compétitions UEC — Coupe d'Europe, Championnats d'Europe)
// depuis JSTiming (results.jstiming.com), complément des index Sqorz (build-index.js).
// Spec : docs/superpowers/specs/2026-09-03-uec-jstiming-design.md
//
// Usage : node build-uec.js [--limit N] [--match SUBSTR] [--no-cache]
//   --limit N      ne crawler que les N premiers événements (build de test, D10)
//   --match SUBSTR ne crawler que les événements dont le nom contient SUBSTR
//   --no-cache     ignorer le cache de contenu .cache/uec
//
// Format de sortie aligné sur pilots-index.json / uci-index.json :
//   uec-index.json          index complet (clés courtes slim, cf. slimUecCompetitor)
//   uec-index.events.ndjson 1 événement par ligne (streaming mobile)
//   uec-index.meta.json     sha256 + tailles + date de génération

const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE = 'https://results.jstiming.com';
const ORG_NAME = 'UEC';
const DELAY_MS = 150;   // identique à build-index.js (aucun rate-limit observé, spec §2.1)
const RETRIES = 3;
const CACHE_DIR = path.join('.cache', 'uec');
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// Exclusions RGPD (opposition art. 21 / erreurs d'attribution) — cf. build-exclusions.js
const { lazyExclusions, isExcluded } = require('./build-exclusions.js');
const exclusions = lazyExclusions();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = s => createHash('sha256').update(s, 'utf8').digest('hex');
const norm = s => (s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// --- CLI ---
const args = process.argv.slice(2);
const optLimit = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1], 10) : null; })();
const optMatch = (() => { const i = args.indexOf('--match'); return i >= 0 ? args[i + 1] : null; })();
const optNoCache = args.includes('--no-cache');

// =====================================================================
// HTTP + cache de contenu (D9) : un fichier par URL, clé = sha256(url).
// Si le serveur renvoie un ETag on fait une requête conditionnelle (304 =
// page non re-téléchargée) ; sinon on compare le sha256 du corps : page
// identique → on ne réécrit pas le cache. Le workflow hebdo refait un
// crawl complet mais ne re-traite que ce qui a changé.
// =====================================================================
async function fetchPage(url) {
  const cacheFile = path.join(CACHE_DIR, sha256(url) + '.json');
  let cached = null;
  if (!optNoCache) {
    try { cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); }
    catch { /* pas de cache */ }
  }
  const headers = { 'User-Agent': UA, 'Accept': 'text/html, application/xhtml+xml' };
  if (cached && cached.etag) headers['If-None-Match'] = cached.etag;

  let res = null, lastErr = null;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      res = await fetch(url, { headers, redirect: 'follow' });
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < RETRIES) await sleep(1000 * attempt);
    }
  }
  if (!res) throw new Error(`réseau indisponible (${lastErr && lastErr.message}) — ${url}`);

  if (res.status === 304 && cached) return cached.body;
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);

  const body = await res.text();
  const sha = sha256(body);
  if (!cached || cached.sha256 !== sha) {
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify({ etag: res.headers.get('etag'), sha256: sha, body }));
    } catch (e) { console.warn(`  cache write failed: ${e.message}`); }
  }
  return body;
}

// --- Payload Inertia (attribut data-payload, HTML-unescape + JSON.parse) ---
function parsePayload(html) {
  const m = html.match(/data-payload="([^"]*)"/);
  if (!m) throw new Error('data-payload introuvable');
  const json = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // en dernier : &amp;quot; doit donner "&quot;", pas '"'
  const payload = JSON.parse(json);
  return (payload.view && payload.view.properties) || payload.properties || payload;
}

// --- Dates JSTiming : DD-MM-YYYY → YYYY-MM-DD (⚠️ pas ISO, spec §2.3) ---
function jdToIso(d) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec((d || '').trim());
  if (!m) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// --- Noms : JSTiming donne "Prénom NOM" (nom de famille en capitales) ---
// On découpe sur la suite de jetons tout-capitales en fin de chaîne, pour
// gérer les noms composés (« Tom VAN DER BERG », « Leon KLEMETSEN-TJENSVOLL »).
const CAPS_RE = /^[\p{Lu}][\p{Lu}\p{M}'’\-]*$/u;
function parseName(full) {
  const tokens = (full || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { firstName: '', lastName: '' };
  let i = tokens.length;
  while (i > 0 && CAPS_RE.test(tokens[i - 1])) i--;
  if (i === tokens.length) { // aucune capitale typographique → dernier jeton = nom
    return { firstName: tokens.slice(0, -1).join(' '), lastName: tokens[tokens.length - 1] };
  }
  if (i === 0) { // tout en capitales → dernier jeton = nom
    return { firstName: tokens.slice(0, -1).join(' '), lastName: tokens[tokens.length - 1] };
  }
  return { firstName: tokens.slice(0, i).join(' '), lastName: tokens.slice(i).join(' ') };
}

// --- Nom de phase (mapping slug → libellé exploitable par les détecteurs
// de l'app : /^moto/i pour les manches, /semi|demi|quart|quarter|1\/4/ pour
// les phases knock-out, /final/ sans exclusion pour la finale) ---
function phaseNameFor(round, heatName) {
  if (/small|b.?final|petite/i.test(heatName || '')) return 'Petite finale';
  const slug = (round.slug || '').toLowerCase();
  let m;
  if ((m = /^moto-?(\d+)/.exec(slug))) return `Moto ${m[1]}`;      // moto-1round-1, moto-2lcq, moto-3
  if ((m = /^round-?(\d+)/.exec(slug))) return `Moto ${m[1]}`;     // anciens événements : round-1 = 1ʳᵉ manche
  if (/lcq/.test(slug)) return 'LCQ';
  if (/^116-finals/.test(slug)) return '1/16 Finals';
  if (/^18-finals/.test(slug)) return '1/8 Finals';
  if (/^14-finals/.test(slug)) return 'Quarter Finals';            // profondeur « quart » détectée par l'app
  if (/^12-finals/.test(slug)) return 'Semi Finals';               // profondeur « demi » détectée par l'app
  if (/^finals?$/.test(slug)) return 'Finale';
  return round.name || slug;
}

// --- Colonnes chrono d'un heat : on suit les libellés *_cname (robuste aux
// changements de clés c11/c12/c14) : Start → hillTime (ht), Split 1 →
// corner2Time (ct), Finish → time (tm) — mapping D6 de la spec. ---
function chronoColsFor(heat) {
  const cols = heat.additional_columns;
  if (!cols || typeof cols !== 'object' || Array.isArray(cols)) return null;
  const out = {};
  for (const [key, label] of Object.entries(cols)) {
    if (!key.endsWith('_cname')) continue;
    const l = String(label || '').toLowerCase();
    const base = key.slice(0, -'_cname'.length);
    if (/start/.test(l)) out.ht = base;
    else if (/split/.test(l)) out.ct = base;
    else if (/finish/.test(l)) out.tm = base;
  }
  return (out.ht || out.ct || out.tm) ? out : null;
}

// Temps valable : chaîne décimale > 0 (ex. " 41.892" → "41.892")
function cleanTime(v) {
  const s = String(v ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return parseFloat(s) > 0 ? s : null;
}
const parseIntRank = v => {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isInteger(n) && n >= 1 && n < 100000 ? n : null;
};

// Nom de classe : classOptions d'abord, sinon nettoyage du nom du heat
// (« Race 34 Girls 15/16 » → « Girls 15/16 », « Boys 11: 19 entries » → « Boys 11 »)
function classNameFor(code, heatName, classOptions) {
  const opt = classOptions.get(code);
  if (opt) return opt;
  return (heatName || code)
    .replace(/^Race\s+\d+\s+/i, '')
    .replace(/:\s*\d+\s+entries?\s*$/i, '')
    .trim() || code;
}

// =====================================================================
// Crawl
// =====================================================================
async function findOrganizerUuid() {
  const props = parsePayload(await fetchPage(BASE + '/'));
  const organizers = props.organizers || [];
  const org = organizers.find(o => (o.name || '').trim().toUpperCase() === ORG_NAME);
  if (!org) throw new Error(`organisateur « ${ORG_NAME} » introuvable sur la page d'accueil (trouvés : ${organizers.map(o => o.name).join(', ')})`);
  return org.uuid;
}

async function listPastEvents(orgUuid) {
  const events = [];
  for (let page = 1; ; page++) {
    const props = parsePayload(await fetchPage(`${BASE}/${orgUuid}?page=${page}`));
    const past = props.pastEvents || {};
    const data = past.data || [];
    process.stdout.write(`  page ${page}/${past.last_page || '?'} — ${data.length} événement(s)\n`);
    for (const card of data) {
      if (card.button_text_view && card.button_text_view !== 'Results') continue; // D5 : courses seulement
      if (!card.uuid) continue;
      events.push(card);
    }
    if (!data.length || (past.last_page && page >= past.last_page)) break;
    await sleep(DELAY_MS);
  }
  return events;
}

// Construit l'entrée d'index d'un événement (ou null si rien d'exploitable).
async function buildEvent(card, stats) {
  const evUuid = card.uuid;
  const classOptions = new Map(); // class_code → nom lisible
  const classes = new Map();      // class_code → { name, total, competitors: Map<key, comp> }

  const classOf = code => {
    if (!classes.has(code)) classes.set(code, { name: null, total: 0, competitors: new Map() });
    return classes.get(code);
  };
  const compKeyOf = r => {
    const jid = String(r.id ?? '').trim();
    return jid || 'n:' + norm(r.name || '');
  };

  // --- 1. Round overall : classements finaux + classOptions ---
  let overallProps = null;
  try {
    overallProps = parsePayload(await fetchPage(`${BASE}/event/${evUuid}/overall`));
  } catch (e) {
    console.log(`  skip (overall indisponible : ${e.message})`);
    return null;
  }
  await sleep(DELAY_MS);
  for (const co of overallProps.classOptions || []) {
    if (co.class_code) classOptions.set(co.class_code, String(co.name || '').trim());
  }
  const evMeta = overallProps.event || {};
  const rounds = (card.rounds && card.rounds.length ? card.rounds : evMeta.rounds) || [];
  const raceRounds = rounds.filter(r => (r.slug || '') !== 'overall' && r.slug);

  const registerOverallRider = (heat, rider) => {
    const rank = parseIntRank(rider.rank);
    if (rank == null) return; // classe sans résultats (ex. « 6&7 (only national) », rank vide)
    const cls = classOf(heat.class_code);
    const key = compKeyOf(rider);
    let comp = cls.competitors.get(key);
    if (!comp) {
      const { firstName, lastName } = parseName(rider.name);
      comp = { fn: firstName, ln: lastName, gn: '', jid: String(rider.id ?? '').trim(), plate: '', rank: null, d: [] };
      cls.competitors.set(key, comp);
    }
    comp.rank = rank;
    if (!comp.plate && String(rider.plate ?? '').trim()) comp.plate = String(rider.plate).trim();
    if (!comp.gn && String(rider.ioc_code ?? '').trim()) comp.gn = String(rider.ioc_code).trim().toUpperCase();
    cls.total++;
  };
  for (const heat of overallProps.heats || []) {
    if (!heat.class_code) continue;
    for (const rider of heat.riders || []) registerOverallRider(heat, rider);
  }

  // --- 2. Rounds de course : phases (position dans la course + chronos) ---
  let timedPhases = 0;
  for (const round of raceRounds) {
    let props;
    try {
      props = parsePayload(await fetchPage(`${BASE}/event/${evUuid}/${round.slug}`));
    } catch (e) {
      console.log(`  round ${round.slug} indisponible : ${e.message}`);
      continue;
    }
    await sleep(DELAY_MS);
    for (const co of props.classOptions || []) {
      if (co.class_code && !classOptions.has(co.class_code)) classOptions.set(co.class_code, String(co.name || '').trim());
    }
    for (const heat of props.heats || []) {
      if (!heat.class_code) continue;
      const cols = chronoColsFor(heat);
      const phaseName = phaseNameFor(round, heat.name);
      for (const rider of heat.riders || []) {
        const r = parseIntRank(rider.rank);
        if (r == null) continue;
        const cls = classOf(heat.class_code);
        const key = compKeyOf(rider);
        let comp = cls.competitors.get(key);
        if (!comp) {
          const { firstName, lastName } = parseName(rider.name);
          // présent en course mais absent de l'overall → rank null (DNS/DNF général,
          // tranché en implémentation : les phases sont conservées, l'indice de perf
          // appliquera la pénalité graduée par la phase la plus profonde atteinte)
          comp = { fn: firstName, ln: lastName, gn: '', jid: String(rider.id ?? '').trim(), plate: '', rank: null, d: [] };
          cls.competitors.set(key, comp);
        }
        if (!comp.plate && String(rider.plate ?? '').trim()) comp.plate = String(rider.plate).trim();
        if (!comp.gn && String(rider.ioc_code ?? '').trim()) comp.gn = String(rider.ioc_code).trim().toUpperCase();
        const phase = { n: phaseName, r };
        if (cols) {
          const tm = cleanTime((rider.additional_columns || {})[cols.tm]);
          const ct = cleanTime((rider.additional_columns || {})[cols.ct]);
          const ht = cleanTime((rider.additional_columns || {})[cols.ht]);
          if (tm != null) { phase.tm = tm; timedPhases++; }
          if (ct != null) phase.ct = ct;
          if (ht != null) phase.ht = ht;
        }
        comp.d.push(phase);
      }
    }
  }

  // --- 3. Assemblage des classes (slim) ---
  const outClasses = [];
  const eventDate = jdToIso(card.start_date || evMeta.start_date);
  const eventEndDate = jdToIso(card.end_date || evMeta.end_date) || eventDate;

  // Filtre RGPD : un pilote exclu ne doit pas réapparaître via une classe
  // récupérée par un round de course alors qu'il est absent du round overall.
  for (const cls of classes.values()) {
    for (const [k, comp] of [...cls.competitors]) {
      if (isExcluded(exclusions, { firstName: comp.fn, lastName: comp.ln, account: 'uec', date: eventDate })) {
        cls.competitors.delete(k);
        if (stats) stats.excluded++;
      }
    }
  }

  for (const [code, cls] of classes) {
    if (!cls.competitors.size) continue;
    const competitors = [...cls.competitors.values()]
      .sort((a, b) => (a.rank ?? 99999) - (b.rank ?? 99999))
      .map(comp => {
        const slim = { fn: comp.fn, ln: comp.ln, gn: comp.gn };
        if (comp.jid) slim.jid = comp.jid;
        if (comp.rank != null) slim.rank = comp.rank;
        if (comp.plate) slim.plate = comp.plate;
        if (comp.d.length) slim.d = comp.d;
        return slim;
      });
    outClasses.push({
      className: classNameFor(code, cls.name, classOptions),
      perpetualClassCode: code,
      total: competitors.length,
      competitors,
    });
  }
  outClasses.sort((a, b) => a.perpetualClassCode.localeCompare(b.perpetualClassCode, 'fr', { sensitivity: 'base' }));
  if (!outClasses.length) {
    console.log('  skip (aucune classe avec résultats)');
    return null;
  }

  return {
    account: { accountCode: 'uec', accountName: 'UEC' },
    event: {
      eventId: evUuid,
      eventName: card.name || evMeta.name || '',
      eventDate,
      eventEndDate,
    },
    classes: outClasses,
    _stats: { timedPhases, noOverallRank: outClasses.reduce((n, c) => n + c.competitors.filter(x => x.rank == null).length, 0) },
  };
}

// =====================================================================
// Sorties (alignées sur build-index.js)
// =====================================================================
function writeOutputs(index, indexEvents) {
  const json = JSON.stringify(index);
  fs.writeFileSync('uec-index.json', json);

  const eventsNdjson = indexEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync('uec-index.events.ndjson', eventsNdjson);

  fs.writeFileSync('uec-index.meta.json', JSON.stringify({
    generated: index.generated,
    index: { sha256: sha256(json), sizeBytes: Buffer.byteLength(json, 'utf8') },
    events: { sha256: sha256(eventsNdjson), sizeBytes: Buffer.byteLength(eventsNdjson, 'utf8') },
  }, null, 2) + '\n');
  return json.length;
}

async function main() {
  console.log(`=== Index UEC depuis JSTiming (${BASE}) ===`);
  if (optLimit) console.log(`Mode test : --limit ${optLimit}`);
  if (optMatch) console.log(`Filtre nom : --match "${optMatch}"`);

  const orgUuid = await findOrganizerUuid();
  console.log(`Organisateur ${ORG_NAME} : ${orgUuid}`);
  await sleep(DELAY_MS);

  console.log('=== Étape 1 : liste des événements passés ===');
  let cards = await listPastEvents(orgUuid);
  if (optMatch) cards = cards.filter(c => (c.name || '').toLowerCase().includes(optMatch.toLowerCase()));
  cards.sort((a, b) => jdToIso(b.start_date).localeCompare(jdToIso(a.start_date)));
  if (optLimit) cards = cards.slice(0, optLimit);
  console.log(`${cards.length} événement(s) « Results » à indexer\n`);

  console.log('=== Étape 2 : crawl des événements ===');
  const indexEvents = [];
  const perEventSizes = [];
  let skipped = 0;
  let excluded = 0;
  const exStats = { excluded: 0 };
  for (let i = 0; i < cards.length; i++) {
    const card = cards[i];
    process.stdout.write(`[${i + 1}/${cards.length}] ${card.name} (${card.start_date}) … `);
    let ev = null;
    try {
      exStats.excluded = 0;
      ev = await buildEvent(card, exStats);
      excluded += exStats.excluded;
    } catch (e) {
      // Erreur de configuration des exclusions (secret absent/faux) : on RELANCE.
      // Sinon l'événement serait compté « ignoré » et l'index sortirait vide sans
      // bruit — un secret manquant deviendrait une republication de données.
      if (e.fatal) throw e;
      console.log(`ERREUR événement: ${e.message}`);
      skipped++;
      continue;
    }
    if (!ev) { skipped++; continue; }
    const size = Buffer.byteLength(JSON.stringify(ev), 'utf8');
    perEventSizes.push(size);
    const st = ev._stats;
    delete ev._stats;
    indexEvents.push(ev);
    console.log(`${ev.classes.length} classes, ${ev.classes.reduce((n, c) => n + c.competitors.length, 0)} pilotes, ${st.timedPhases} phases chrono${st.noOverallRank ? `, ${st.noOverallRank} sans rank overall` : ''}, slim ${size} o`);
  }

  indexEvents.sort((a, b) => (b.event.eventDate || '').localeCompare(a.event.eventDate || ''));
  const index = {
    generated: new Date().toISOString(),
    orgs: [{ accountCode: 'uec', accountName: 'UEC — Union Européenne de Cyclisme' }],
    events: indexEvents,
    series: [], // D4 : JSTiming n'expose aucune série/classement général multi-manches
  };

  const totalBytes = writeOutputs(index, indexEvents);
  let totalCompetitors = 0, totalClasses = 0, totalTimed = 0;
  for (const ev of indexEvents) for (const cls of ev.classes) {
    totalClasses++; totalCompetitors += cls.competitors.length;
  }

  console.log('');
  console.log('=== Terminé (uec-index.json) ===');
  console.log(`${indexEvents.length} événements indexés${skipped ? `, ${skipped} ignorés` : ''}, ${totalClasses} classes, ${totalCompetitors} entrées pilotes`);
  console.log(`Taille : ${(totalBytes / 1024 / 1024).toFixed(2)} Mo (non compressé)`);
  if (excluded) console.log(`Exclusions RGPD : ${excluded} entrée(s) pilote retirée(s)`);
  if (perEventSizes.length) {
    const avg = perEventSizes.reduce((a, b) => a + b, 0) / perEventSizes.length;
    console.log(`Taille moyenne par événement : ${(avg / 1024).toFixed(0)} Ko`);
    if (optLimit || optMatch) console.log(`Extrapolation 130 événements : ≈ ${(avg * 130 / 1024 / 1024).toFixed(1)} Mo`);
  }
  // Forces de plateau (indice v2) — run complet seulement (pas en --limit/--match).
  if (!optLimit && !optMatch) {
    const { computeFieldFiles } = require('./build-field.js');
    computeFieldFiles(['uec-index.json'], { outFile: 'field-strength-uec.json', label: 'UEC' });
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

// Helpers exportés pour les tests unitaires (node --test tests/)
module.exports = { parsePayload, jdToIso, parseName, phaseNameFor, chronoColsFor, cleanTime, parseIntRank, classNameFor, norm };
