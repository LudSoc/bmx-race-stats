#!/usr/bin/env node
// Génère pilots-index.json (région FR) et uci-index.json (région UCI, Mondiaux BMX) depuis l'API Sqorz (source de données).
// Exécuté par GitHub Actions chaque semaine ; les fichiers sont commités dans le repo.
// Usage : node build-index.js [regionCode...] — par défaut FR + UCI (ex: node build-index.js UCI)

const SQORZ_BASE = 'https://our.sqorz.com';
const DELAY_MS = 150;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

const norm = s => (s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();


// Clés courtes : fn=firstName, ln=lastName, gn=groupName, d=competitorRankDetails
// Dans chaque detail : n=phaseName, r=result, rp=racePosition, pc=phaseCode, pbc=phaseBlockCode, rn=raceName
// + champs chrono transpondeur (épreuves chronométrées) : tm=time, ht=hillTime, ct=corner2Time
//   (spec chronos-transpondeur : conservés pour la sous-ligne « ⏱ Chronos » de la timeline)
// NB : pour un compétiteur NON classé (rank absent ou ≥ 100 000 = DNF/DNS/DSQ), on garde les
// phases MÊME sans résultat : elles indiquent jusqu'où il est allé (ex. « Final » présente =
// qualifié jusqu'en finale) — l'indice de performance en déduit la phase la plus profonde atteinte
// pour graduer la pénalité (spec indice-perf §4.4).
function slimCompetitor(c) {
  const out = {
    fn: c.firstName, ln: c.lastName,
    rank: c.rank, plate: c.plate, age: c.age, gn: c.groupName,
  };
  const classed = typeof c.rank === 'number' && c.rank < 100000;
  const details = (c.competitorRankDetails || [])
    .filter(d => d.phaseName && (classed ? d.result != null : true))
    .map(d => {
      const p = { n: d.phaseName, r: d.result };
      if (d.racePosition  != null) p.rp  = d.racePosition;
      if (d.phaseCode)             p.pc  = d.phaseCode;
      if (d.phaseBlockCode)        p.pbc = d.phaseBlockCode;
      if (d.raceName != null)      p.rn  = d.raceName;
      if (typeof d.time === 'string')         p.tm = d.time;
      if (typeof d.hillTime === 'string')     p.ht = d.hillTime;
      if (typeof d.corner2Time === 'string')  p.ct = d.corner2Time;
      return p;
    });
  if (details.length) out.d = details;
  return out;
}

// Clés courtes : fn=firstName, ln=lastName, gn=groupName, sr=seriesRank, sp=seriesPoints, ev=seriesRankCompetitorEvents
function slimSeriesCompetitor(c) {
  const ev = (c.seriesRankCompetitorEvents || []).map(e => {
    if (!e) return null;
    const o = {};
    if (e.eventRank   != null) o.er = e.eventRank;
    if (e.eventPoints != null) o.ep = e.eventPoints;
    if (e.tallied)             o.t  = true;
    return o;
  });
  return {
    fn: c.firstName, ln: c.lastName,
    sr: c.seriesRank, sp: c.seriesPoints, gn: c.groupName,
    ev,
  };
}

async function buildRegion(regionCode, outFile) {
  console.log(`=== Étape 1 : région ${regionCode} ===`);
  const region = await fetchJson(`${SQORZ_BASE}/json/region/${regionCode}`);
  const accounts = (region.accounts || []);
  console.log(`${accounts.length} organisations trouvées`);

  const indexEvents = [];
  const indexSeries = [];
  const seriesByKey = new Map();

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    process.stdout.write(`[${i + 1}/${accounts.length}] ${acc.accountCode} … `);

    let orgData;
    try {
      orgData = await fetchJson(`${SQORZ_BASE}/json/org/${encodeURIComponent(acc.accountCode)}`);
      await sleep(DELAY_MS);
    } catch (e) {
      console.log(`ERREUR org: ${e.message}`);
      continue;
    }

    const account = {
      accountCode: acc.accountCode,
      accountName: acc.accountName || orgData.accountName || acc.accountCode,
    };

    const events = (orgData.events || []).filter(e => e.publish !== false);
    const seriesList = (orgData.series || []).filter(s => s.publish !== false && s.seriesId);
    console.log(`${events.length} events, ${seriesList.length} séries`);

    // Événements
    for (const ev of events) {
      let detail;
      try {
        detail = await fetchJson(`${SQORZ_BASE}/json/event/${encodeURIComponent(ev.eventId)}`);
        await sleep(DELAY_MS);
      } catch (e) {
        process.stdout.write(`  skip event ${ev.eventId}: ${e.message}\n`);
        continue;
      }

      const classes = (detail.classRanks || [])
        .filter(cls => (cls.competitorRankSummaries || []).length > 0)
        .map(cls => {
          const summaries = cls.competitorRankSummaries || [];
          return {
            className: cls.className || '',
            perpetualClassCode: cls.perpetualClassCode || null,
            total: summaries.length,
            competitors: summaries.map(slimCompetitor),
          };
        });

      if (classes.length === 0) continue;

      indexEvents.push({
        account,
        event: {
          eventId: ev.eventId,
          eventName: ev.eventName || ev.eventShortName || '',
          eventDate: ev.eventDate || '',
          eventEndDate: ev.eventEndDate || '',
        },
        classes,
      });
    }

    // Séries (dédupliquées par nom normalisé)
    for (const sr of seriesList) {
      let detail;
      try {
        detail = await fetchJson(`${SQORZ_BASE}/json/series/${encodeURIComponent(sr.seriesId)}`);
        await sleep(DELAY_MS);
      } catch (e) {
        process.stdout.write(`  skip series ${sr.seriesId}: ${e.message}\n`);
        continue;
      }

      const rankEvents = (detail.seriesRankEvents || [])
        .filter(e => e.eventName || e.eventShortName || e.eventDate)
        .map(e => ({
          eventId: e.eventId,
          eventName: e.eventName || e.eventShortName || '',
          eventDate: e.eventDate || '',
          eventEndDate: e.eventEndDate || '',
        }));

      const key = norm(sr.seriesName || '') || sr.seriesId;
      if (!seriesByKey.has(key)) {
        seriesByKey.set(key, { account, coOrgs: [], series: sr, detail, rankEvents });
      } else {
        const ex = seriesByKey.get(key);
        if (rankEvents.length > ex.rankEvents.length) {
          ex.coOrgs.unshift(ex.account);
          ex.account = account; ex.series = sr; ex.detail = detail; ex.rankEvents = rankEvents;
        } else {
          ex.coOrgs.push(account);
        }
      }
    }
  }

  for (const { account, coOrgs, series, detail, rankEvents } of seriesByKey.values()) {
    const classes = (detail.seriesRankClasses || [])
      .filter(cls => (cls.seriesRankCompetitors || []).length > 0)
      .map(cls => {
        const competitors = cls.seriesRankCompetitors || [];
        return {
          className: cls.className || '',
          perpetualClassCode: cls.perpetualClassCode || null,
          total: competitors.length,
          competitors: competitors.map(slimSeriesCompetitor),
        };
      });

    if (classes.length === 0) continue;

    indexSeries.push({
      account,
      coOrgs: coOrgs.map(a => ({ accountCode: a.accountCode, accountName: a.accountName })),
      series: { seriesId: series.seriesId, seriesName: series.seriesName || '' },
      rankEvents,
      classes,
    });
  }

  const orgs = accounts.map(a => ({ accountCode: a.accountCode, accountName: a.accountName }));

  const index = {
    generated: new Date().toISOString(),
    orgs,
    events: indexEvents,
    series: indexSeries,
  };

  const json = JSON.stringify(index);
  const { writeFileSync } = await import('fs');
  writeFileSync(outFile, json);

  // Variante NDJSON (un événement par ligne) pour les clients mobiles :
  // streaming ligne à ligne, sans tout charger en mémoire.
  const eventsNdjson = indexEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
  const ndjsonFile = outFile.replace(/\.json$/, '.events.ndjson');
  writeFileSync(ndjsonFile, eventsNdjson);

  // Fichier compagnon léger pour les clients (ex. app Android) :
  // permet de vérifier la fraîcheur (generated) et l'intégrité (sha256)
  // sans télécharger l'index complet.
  const { createHash } = await import('crypto');
  const sha256 = createHash('sha256').update(json, 'utf8').digest('hex');
  const eventsSha = createHash('sha256').update(eventsNdjson, 'utf8').digest('hex');
  const metaFile = outFile.replace(/\.json$/, '.meta.json');
  writeFileSync(metaFile, JSON.stringify({
    generated: index.generated,
    index: {
      sha256,
      sizeBytes: Buffer.byteLength(json, 'utf8'),
    },
    events: {
      sha256: eventsSha,
      sizeBytes: Buffer.byteLength(eventsNdjson, 'utf8'),
    },
  }, null, 2) + '\n');

  const sizeMb = (json.length / 1024 / 1024).toFixed(1);
  let totalCompetitors = 0;
  for (const ev of indexEvents) for (const cls of ev.classes) totalCompetitors += cls.competitors.length;
  let totalSeriesCompetitors = 0;
  for (const sr of indexSeries) for (const cls of sr.classes) totalSeriesCompetitors += cls.competitors.length;

  console.log('');
  console.log(`=== Terminé (${outFile}) ===`);
  console.log(`${indexEvents.length} événements, ${totalCompetitors} entrées pilotes`);
  console.log(`${indexSeries.length} séries, ${totalSeriesCompetitors} entrées championnats`);
  console.log(`Taille : ${sizeMb} Mo (non compressé)`);
}

async function main() {
  const requested = process.argv.slice(2).filter(a => !a.startsWith('-'));
  const regions = requested.length ? requested : ['FR', 'UCI'];
  const built = [];
  for (const regionCode of regions) {
    const outFile = regionCode.toUpperCase() === 'FR' ? 'pilots-index.json' : regionCode.toLowerCase() + '-index.json';
    await buildRegion(regionCode, outFile);
    built.push(outFile);
  }
  // Forces de plateau (indice v2) sur les index générés — spec force-plateau.
  // Exécuté après les régions pour lire les fichiers frais.
  const { computeFieldFiles } = require('./build-field.js');
  computeFieldFiles(built, { outFile: 'field-strength-fr.json', label: 'FR+UCI' });
}

main().catch(e => { console.error(e); process.exit(1); });
