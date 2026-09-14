/* Sqorz Hub — socle partagé (common.js).
 *
 * Fonctions pures et chargeur d'index communs aux outils (sqorz-stats, sqorz-club,
 * sqorz-head2head, sqorz-category). Hébergé par sqorz-stats, chargé en premier par
 * chaque app via :
 *   <script src="https://ludsoc.github.io/sqorz-stats/common.js"></script>
 * (sqorz-stats lui-même utilise <script src="./common.js"></script>).
 *
 * 100 % SANS DOM : aucune référence à document/window/localStorage ici (sauf
 * `window.SqorzCommon` en toute fin pour l'exposition). L'affichage passe par les
 * callbacks onStatus/onProgress du chargeur. Testé par `node --test tests/common.test.js`.
 */
(function () {
  'use strict';

  // ===== Utils =====
  const norm = s => (s || '')
    .toString()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

  const escape = s => String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // --- Messages d'erreur humanisés (wording neutre : les sources sont R2/GitHub) ---
  function humanError(e) {
    if (!e) return 'Erreur inconnue.';
    if (e.name === 'AbortError') return 'Recherche annulée.';
    const msg = e.message || String(e);
    if (/HTTP 5\d\d/.test(msg)) return 'Le serveur de données est momentanément indisponible. Réessaie dans quelques instants.';
    if (/HTTP 4\d\d/.test(msg)) return 'Le serveur de données refuse la requête. Réessaie plus tard.';
    if (/network|fetch failed|Failed to fetch|NetworkError/i.test(msg)) return 'Pas de réseau. Vérifie ta connexion.';
    if (/JSON parse/i.test(msg)) return 'Réponse du serveur illisible. Réessaie.';
    if (/proxys|tous les proxys/i.test(msg)) return 'Les proxys publics ne répondent pas. Réessaie dans quelques minutes.';
    return msg;
  }

  // Z-score du rang sous l'hypothèse uniforme : positif = mieux que la médiane du plateau, borné par ±√3.
  function zScore(rank, total) {
    if (!total || total < 2 || typeof rank !== 'number') return null;
    const mu = (total + 1) / 2;
    const sigma = Math.sqrt((total * total - 1) / 12);
    if (!sigma) return null;
    return (mu - rank) / sigma;
  }

  // ===== Phases =====
  function isFinalPhase(d) {
    const n = (d.phaseName || '').toLowerCase();
    if (!/final/.test(n)) return false;
    if (/semi|demi|quarter|quart|\d+\/|\d+.?[èe]me|\d+°|eighth|repech|petit|last.chance/.test(n)) return false;
    return true;
  }
  function isMotoPhase(d) {
    return /^moto/i.test(d.phaseName || '');
  }
  function isSemiPhase(d) {
    return /semi/i.test(d.phaseName || '');
  }
  // Contre-la-montre : runs en solo, `result` vaut 1 pour tout le monde (1er de son
  // run) et ne dit rien du classement — seuls le chrono et le rang final comptent.
  // Phases Sqorz : "Time Trial" (TT) et "Super Final" (TTF). Accepte les formes
  // expansées (phaseName/phaseCode) et slim (n/pc).
  function isTimeTrialPhase(d) {
    if (!d) return false;
    const code = ((d.phaseCode || d.pc) || '').toUpperCase();
    if (code === 'TT' || code === 'TTF') return true;
    const n = ((d.phaseName || d.n) || '').toLowerCase().trim();
    return /\btime.trial\b/.test(n) || n === 'super final';
  }
  // Temps non valable : phase absente, sans résultat, ou DNF/DNS/DSQ (result ≥ 100 000).
  const isNotTimedPhase = d => d == null || d.result == null || Number(d.result) >= 100000;
  const num = s => { const n = parseFloat(s); return isFinite(n) && n > 0 ? n : null; }; // temps > 0 requis

  // Phases à élimination directe présentes dans les détails (demies/quarts/8es/16es) :
  // un pilote classé qui en a sans phase finale a été éliminé avant la finale
  // (pas de bonus « finale atteinte » — spec indice-perf §7.4).
  function perfHasKnockout(details) {
    for (const d of details || []) {
      const n = (d.phaseName || '').toLowerCase();
      if (/semi|demi|quart|quarter|1\/8|1\/16|huitieme|seizieme/.test(n)) return true;
    }
    return false;
  }

  // ===== Expansion de l'index (clés courtes → champs complets) =====
  // opts.details : true (défaut) = tout ; false = noms seuls (mode économe en
  // mémoire) ; 'chrono' = noms + PHASES CHRONOMÉTRÉES seules, en champs minimaux
  // (phaseName/result/time/hillTime/corner2Time — pour les duels chronos H2H :
  // seules les épreuves transpondeur pèsent, le reste ne coûte presque rien).
  function expandIndex(idx, opts) {
    const detailsOpt = !opts || opts.details === undefined ? true : opts.details;
    const withSeries = !opts || opts.series !== false;
    for (const ev of (idx.events || [])) {
      for (const cls of (ev.classes || [])) {
        for (const c of (cls.competitors || [])) {
          c.firstName = c.fn; c.lastName = c.ln; c.groupName = c.gn;
          if (c.age === undefined) c.age = null;
          if (detailsOpt === false) continue;
          let ds = (c.d || []);
          if (detailsOpt === 'chrono') ds = ds.filter(d => d.tm != null || d.ht != null || d.ct != null);
          // ID pilote JSTiming (index UEC uniquement) : identité intra-UEC stable (spec UEC §4.3)
          if (c.jid != null) c.riderId = c.jid;
          c.competitorRankDetails = ds.map(d => ({
            phaseName: d.n, result: d.r,
            ...(d.rp  != null ? { racePosition:  d.rp  } : {}),
            ...(d.pc         ? { phaseCode:      d.pc  } : {}),
            ...(d.pbc        ? { phaseBlockCode: d.pbc } : {}),
            ...(d.rn  != null ? { raceName:       d.rn  } : {}),
            // Champs chrono transpondeur (spec chronos-transpondeur) : tm=time, ht=hillTime, ct=corner2Time
            ...(d.tm != null ? { time:         d.tm } : {}),
            ...(d.ht != null ? { hillTime:     d.ht } : {}),
            ...(d.ct != null ? { corner2Time:  d.ct } : {}),
          }));
        }
      }
    }
    if (withSeries) {
      for (const sr of (idx.series || [])) {
        for (const cls of (sr.classes || [])) {
          for (const c of (cls.competitors || [])) {
            c.firstName = c.fn; c.lastName = c.ln; c.groupName = c.gn;
            c.seriesRank = c.sr; c.seriesPoints = c.sp;
            c.seriesRankCompetitorEvents = (c.ev || []).map(e => e == null ? null : ({
              ...(e.er != null ? { eventRank:   e.er } : {}),
              ...(e.ep != null ? { eventPoints: e.ep } : {}),
              ...(e.t         ? { tallied: true }      : {}),
            }));
          }
        }
      }
    }
    return idx;
  }

  // ===== Chargeur d'index avec cache client piloté par meta.json (sha256) =====
  // meta (sha256 attendu) → copie Cache API → sources réseau → copie périmée en dernier recours.
  // Affichage via callbacks (pas de DOM ici) : onStatus(text, isError), onProgress(done, total).
  // quiet = true : aucun status/progression (chargement d'arrière-plan) ; les erreurs
  // restent visibles en console et remontent à l'appelant (qui dégrade gracieusement).
  const INDEX_CACHE_NAME = 'sqorz-index-v1';

  async function openIndexCache(tag) {
    if (typeof caches === 'undefined') return null;
    try { return await caches.open(INDEX_CACHE_NAME); }
    catch (e) { console.warn(tag + ' cache indisponible :', e && e.message); return null; }
  }

  async function streamBytes(res, { label, estimatedSize, quiet, onStatus, onProgress }) {
    const compressed = !!res.headers.get('Content-Encoding');
    const rawTotal = parseInt(res.headers.get('Content-Length') || '0', 10);
    const total = quiet ? 0 : (compressed ? (estimatedSize || rawTotal || 0) : (rawTotal || 0));
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (!quiet) {
        const mb = (received / 1048576).toFixed(0);
        if (total) {
          onProgress(received, total);
          onStatus(`Chargement ${label}… ${mb} / ${(total / 1048576).toFixed(0)} Mo`);
        } else {
          onStatus(`Chargement ${label}… ${mb} Mo`);
        }
      }
    }
    if (!quiet) onProgress(0, 0);
    const allBytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { allBytes.set(chunk, offset); offset += chunk.length; }
    return allBytes;
  }

  async function loadIndexCached({
    metaUrl, cacheKey, sources, tag = '[sqorz]', label = 'Index', estimatedSize = 0,
    quiet = false, expandOpts = null, onStatus = null, onProgress = null,
  }) {
    const status = onStatus || (() => {});
    const progress = onProgress || (() => {});
    const log = m => console.warn(tag + ' ' + m);
    let wantSha = null;
    try {
      const metaRes = await fetch(metaUrl);
      if (metaRes.ok) {
        const meta = await metaRes.json();
        wantSha = (meta && meta.index && meta.index.sha256) || null;
      }
    } catch (e) { log('meta indisponible (' + metaUrl + ') : ' + (e && e.message)); }

    const cache = await openIndexCache(tag);
    let hit = null;
    if (cache) {
      try {
        const res = await cache.match(cacheKey);
        if (res) {
          const sha = res.headers.get('x-index-sha');
          if ((wantSha && sha === wantSha) || !wantSha) hit = res;
        }
      } catch (e) { log('lecture du cache : ' + (e && e.message)); }
    }
    const expand = bytes => expandIndex(JSON.parse(new TextDecoder().decode(bytes)), expandOpts || undefined);

    if (hit) {
      if (!quiet) status(`${label} déjà à jour — lecture du cache…`);
      return expand(new Uint8Array(await hit.arrayBuffer()));
    }

    try {
      let res = null, lastErr = null;
      for (const url of sources) {
        try {
          const r = await fetch(url);
          if (r.ok) { res = r; break; }
          lastErr = new Error(`HTTP ${r.status}`);
        } catch (e) { lastErr = e; log('source indisponible : ' + url + ' — ' + (e && e.message)); }
      }
      if (!res) throw lastErr || new Error('Index indisponible.');
      const bytes = await streamBytes(res, { label, estimatedSize, quiet, onStatus: status, onProgress: progress });
      if (cache && wantSha) {
        try {
          await cache.put(cacheKey, new Response(bytes, {
            headers: { 'Content-Type': 'application/json', 'X-Index-Sha': wantSha },
          }));
        } catch (e) { log('écriture du cache : ' + (e && e.message)); }
      }
      return expand(bytes);
    } catch (err) {
      // Dernier recours : copie périmée en cache (hors-ligne)
      if (cache) {
        try {
          const stale = await cache.match(cacheKey);
          if (stale) {
            if (!quiet) status('Hors-ligne — dernière copie connue.', true);
            return expand(new Uint8Array(await stale.arrayBuffer()));
          }
        } catch (e) { /* dernier recours indisponible */ }
      }
      throw err;
    }
  }

  // ===== Forces de plateau (spec force-plateau §3-§4.1) =====
  // Chargement optionnel de field-strength-{fr,uec}.json (R2 + cache, jamais
  // bloquant) : retourne { classes, medFs } ou null (fallback silencieux v1).
  // Le format est validé (v === 1) pour ignorer les futures versions inconnues.
  async function loadFieldStrength({ metaUrl, url, cacheKey, tag = '[sqorz:fs]' }) {
    const fail = m => { console.warn(tag + ' ' + m); return null; };
    let wantSha = null;
    try {
      const metaRes = await fetch(metaUrl);
      if (metaRes.ok) {
        const meta = await metaRes.json();
        wantSha = (meta && meta.index && meta.index.sha256) || null;
      }
    } catch (e) { return fail('meta indisponible (' + metaUrl + ') : ' + (e && e.message)); }
    const cache = await openIndexCache(tag);
    const readJson = async res => {
      try { return await res.json(); }
      catch (e) { return null; }
    };
    const valid = j => j && j.v === 1 && j.classes && typeof j.classes === 'object' && j.medFs && typeof j.medFs === 'object'
      ? { classes: j.classes, medFs: j.medFs } : null;
    if (cache) {
      try {
        const res = await cache.match(cacheKey);
        if (res) {
          const sha = res.headers.get('x-index-sha');
          if ((wantSha && sha === wantSha) || !wantSha) {
            const hit = valid(await readJson(res));
            if (hit) return hit;
          }
        }
      } catch (e) { /* lecture du cache : on continue vers le réseau */ }
    }
    try {
      const res = await fetch(url);
      if (!res.ok) return fail('HTTP ' + res.status + ' — ' + url);
      const got = valid(await readJson(res));
      if (!got) return fail('format inattendu — ' + url);
      if (cache && wantSha) {
        try {
          await cache.put(cacheKey, new Response(JSON.stringify({ v: 1, classes: got.classes, medFs: got.medFs }), {
            headers: { 'Content-Type': 'application/json', 'X-Index-Sha': wantSha },
          }));
        } catch (e) { /* écriture du cache : non bloquant */ }
      }
      return got;
    } catch (err) {
      if (cache) {
        try {
          const stale = await cache.match(cacheKey);
          if (stale) {
            const old = valid(await readJson(stale));
            if (old) return old;
          }
        } catch (e) { /* dernier recours indisponible */ }
      }
      return fail(err && err.message);
    }
  }

  // Poids de preuve d'un engagement pour le shrinkage (spec force-plateau §4.2) :
  // taille du plateau / médiane (un finaliste mondial pèse ~10 courses
  // régionales), DNF/DNS/DSQ = 0,25 (présent mais non informatif).
  function perfWeight(total, isDnf) {
    if (isDnf) return 0.25;
    return (total || 0) / PERF_SHRINK_DIV;
  }

  // Shrinkage d'une moyenne annuelle vers 500 selon la PREUVE apportée
  // (spec force-plateau §4.2) : mean' = (w·mean + m·500) / (w + m),
  // où w = somme des poids des engagements (pas leur compteur).
  function perfShrinkMean(mean, w, m = PERF_SHRINK_M) {
    return (w * mean + m * 500) / (w + m);
  }

  // Ajustement force du plateau à partir d'une entrée [fs, n] (spec force-plateau
  // §4.1) : exclusion exacte de soi-même depuis la moyenne inclusive.
  // Sans ctx / clé inconnue / classe à 1 noté → 0 (formule v1 inchangée).
  // ownBase = score pré-coef clampé (même unité que les ratings du build).
  function fieldAdjust(ctx, key, ownBase, year, k = PERF_FIELD_K) {
    if (!ctx) return 0;
    const med = ctx.medFs && ctx.medFs[year];
    const entry = ctx.classes && ctx.classes[key];
    if (med == null || entry == null || !Array.isArray(entry)) return 0;
    const fs = entry[1] > 1 ? (entry[0] * entry[1] - ownBase) / (entry[1] - 1) : med;
    return k * (fs - med);
  }

  // Score final d'un engagement (spec force-plateau §4.1) : double clamp
  // identique au build (base coéfée clampée, puis ajustement clampé).
  // Jamais ajusté sur les DNF (isDnf) ni sans ctx / fs manquante (v1).
  function applyFieldScore(raw, coef, fsKey, year, ctx, isDnf) {
    const base = perfClamp(raw * coef);
    if (isDnf || !ctx) return base;
    return perfClamp(base + fieldAdjust(ctx, fsKey, perfClamp(raw), year));
  }

  // ===== Indice de performance (spec indice-perf-design, §4 + §7.4) =====
  // Échelle 0–1000. Seuls les helpers purs vivent ici ; perfEngagement/perfLevel
  // restent côté apps (ils dépendent de findClassCompetitors, spécifique à chaque index).
  const PERF_LEVEL_COEFS = { regional: 0.93, national: 1.0, uec: 1.05, uci: 1.05 }; // §4.5 (léger, réduit §7.4)
  const PERF_RANG_EXP = 2.5;   // exposant convexe du score de rang pour z > 0 (§7.4)
  const PERF_CHRONO_W = 0.3;   // poids du composant chrono dans le blend (§4.3)
  const PERF_FIELD_K = 0.3;    // poids de l'ajustement force du plateau (spec force-plateau §4.1)
  const PERF_SHRINK_M = 2;     // force du shrinkage des moyennes annuelles vers 500 (spec force-plateau §4.2)
  // Diviseur du poids de preuve : taille médiane d'une classe, mesurée sur
  // 3035 classes 2026 (médiane 12, p10 = 2, p90 = 54). Une course typique ≈ 1.
  const PERF_SHRINK_DIV = 12;
  const PERF_DNF_SCORES = { final: 700, semi: 550, quarter: 400, moto: 250 }; // §4.4
  const perfClamp = v => Math.max(5, Math.min(1000, v));
  // Score de rang : 500 + 500·(z/√3)^2,5 pour z > 0 (convexe — le podium se détache
  // du fond de top-20), linéaire sous la médiane. 1ᵉʳ grand champ ≈ 980-1000. (§4.1)
  function perfScoreRang(rank, total) {
    const z = zScore(rank, total);
    if (z == null) return null;
    if (z <= 0) return perfClamp(500 + 500 * z / Math.sqrt(3));
    return perfClamp(500 + 500 * Math.pow(Math.min(1, z / Math.sqrt(3)), PERF_RANG_EXP));
  }
  // Meilleur temps valable du pilote (phases DNF/DNS/DSQ et temps ≤ 0 exclus)
  function perfBestTime(details) {
    let b = null;
    for (const d of details || []) {
      if (isNotTimedPhase(d)) continue;
      const v = num(d.time);
      if (v != null && (b == null || v < b)) b = v;
    }
    return b;
  }
  // Composant chrono : z-score sur log(temps) des pilotes chronométrés de la classe,
  // centré sur 500, strict (peut baisser le score), < 3 chronométrés → null (§4.3)
  function perfChronoScore(allBests, pilotBest) {
    if (pilotBest == null || !allBests || allBests.length < 3) return null;
    const logs = allBests.map(Math.log);
    const mu = logs.reduce((a, b) => a + b, 0) / logs.length;
    const sd = Math.sqrt(logs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / logs.length) || 1;
    if (!sd) return null;
    return perfClamp(500 + 500 * (mu - Math.log(pilotBest)) / sd / Math.sqrt(3));
  }
  // Constance : ½·(% manches top 4) + ½·(finale atteinte) ; « finale atteinte » =
  // phase finale valide OU rang final classé SANS phases KO publiées (§4.2 + §7.4)
  function perfConstance(details, rank) {
    let validMotos = 0, top4 = 0;
    for (const d of details || []) {
      if (!isMotoPhase(d)) continue;
      if (typeof d.result === 'number' && d.result < 100000) { validMotos++; if (d.result <= 4) top4++; }
    }
    const pctTop4 = validMotos ? top4 / validMotos : 0.5;
    let finaleOk = false;
    for (const d of details || []) {
      if (isFinalPhase(d) && typeof d.result === 'number' && d.result < 100000) { finaleOk = true; break; }
    }
    if (!finaleOk && typeof rank === 'number' && rank < 100000 && !perfHasKnockout(details)) finaleOk = true;
    return 0.5 * pctTop4 + 0.5 * (finaleOk ? 1 : 0.4);
  }
  const perfCoefConstance = c => 0.95 + 0.1 * c; // ∈ [0.97, 1.05] (§7.4)
  // Phase la plus profonde ATTEINTE par un non-classé → pénalité DNF graduée (§4.4)
  function perfDeepestPhase(details) {
    const order = { final: 3, semi: 2, quarter: 1, moto: 0 };
    let depth = 'moto';
    for (const d of details || []) {
      const n = d.phaseName || '';
      const t = isFinalPhase(d) ? 'final'
        : /semi|demi/i.test(n) ? 'semi'
        : /quart|quarter|1\/4/i.test(n) ? 'quarter'
        : 'moto';
      if (order[t] > order[depth]) depth = t;
    }
    return depth;
  }

  // ===== Fraîcheur des données =====
  function fmtDateFr(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d.toLocaleDateString('fr-FR');
  }
  // parts: [{ tag: 'FR', iso }, ...] — ignore les dates absentes/invalides.
  // Une seule date distincte → « 07/09/2026 », sinon « FR 07/09/2026 · UEC 08/09/2026 ».
  // Retourne null si aucune date valable (l'app garde alors son pied de page masqué).
  function formatDataDates(parts) {
    const items = (parts || [])
      .map(p => ({ tag: p.tag, text: fmtDateFr(p.iso) }))
      .filter(p => p.text);
    if (!items.length) return null;
    if (new Set(items.map(p => p.text)).size === 1) return items[0].text;
    return items.map(p => `${p.tag} ${p.text}`).join(' · ');
  }

  // ===== Petits helpers d'UI partagés (statut, progression, fraîcheur) =====
  // renderDataDates(sources) : écrit le texte de formatDataDates(sources) dans
  // #dataDate et révèle #dataDateWrap. Retourne le texte, ou null si rien à afficher.
  function renderDataDates(sources) {
    const wrap = document.getElementById('dataDateWrap');
    const el = document.getElementById('dataDate');
    const text = formatDataDates(sources);
    if (!wrap || !el || !text) return null;
    el.textContent = text;
    wrap.hidden = false;
    return text;
  }
  // setTextStatus(el, msg, isError) : texte + classe 'error' (préserve les autres classes).
  function setTextStatus(el, msg, isError = false) {
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('error', !!isError);
  }
  // setBarProgress(done, total) : barre #progressBar dans #progressWrap (ids surchargeables).
  function setBarProgress(done, total, wrapId = 'progressWrap', barId = 'progressBar') {
    const wrap = document.getElementById(wrapId);
    const bar = document.getElementById(barId);
    if (!wrap || !bar) return;
    if (!total) { wrap.hidden = true; return; }
    wrap.hidden = false;
    bar.style.width = Math.min(99, Math.round(100 * done / total)) + '%';
  }

  // ===== État partagé inter-outils (même origine → localStorage commun) =====
  // Convention d'écosystème (cf. pilier « état partagé ») :
  //   sqorz.favs.pilots : [{ key, name }] — key = norm('Prénom NOM')
  //   sqorz.favs.clubs  : [{ key, name }] — key = code normalisé compatible club_stats ('joue-t')
  //   sqorz.recent      : [{ t, k, n, at }] — t ∈ { pilots, clubs }, 20 derniers, tous outils confondus.
  // Les favoris n'ont pas d'UI ici : chaque app lit/écrit la même langue (le hub les affichera).
  const FAV_KEYS = { pilots: 'sqorz.favs.pilots', clubs: 'sqorz.favs.clubs' };
  const SHARED_RECENT_KEY = 'sqorz.recent';
  const SHARED_RECENT_MAX = 20;
  const hasLS = () => typeof localStorage !== 'undefined';
  function readJsonArray(key) {
    if (!hasLS()) return [];
    try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; }
    catch { return []; }
  }
  function writeJson(key, val) {
    if (!hasLS()) return;
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }
  function getFavs(type) {
    if (!FAV_KEYS[type]) return [];
    return readJsonArray(FAV_KEYS[type]).filter(e => e && e.key);
  }
  function isFav(type, key) {
    return !!key && getFavs(type).some(e => e.key === key);
  }
  // Bascule un favori ; retourne le nouvel état (true = désormais favori).
  function toggleFav(type, key, name) {
    if (!FAV_KEYS[type] || !key) return false;
    const fav = !isFav(type, key);
    let list = getFavs(type).filter(e => e.key !== key);
    if (fav) list.unshift({ key, name: name || key, at: Date.now() });
    writeJson(FAV_KEYS[type], list.slice(0, 200));
    return fav;
  }
  function pushRecent(type, key, name) {
    if (!key || (type !== 'pilots' && type !== 'clubs')) return;
    const list = readJsonArray(SHARED_RECENT_KEY)
      .filter(e => e && !(e.t === type && e.k === key));
    list.unshift({ t: type, k: key, n: name || key, at: Date.now() });
    writeJson(SHARED_RECENT_KEY, list.slice(0, SHARED_RECENT_MAX));
  }
  function getRecent(n = 10) {
    return readJsonArray(SHARED_RECENT_KEY).slice(0, n);
  }

  window.SqorzCommon = {
    norm, escape, humanError, zScore,
    isFinalPhase, isMotoPhase, isSemiPhase, isTimeTrialPhase, isNotTimedPhase, num, perfHasKnockout,
    expandIndex, INDEX_CACHE_NAME, openIndexCache, loadIndexCached,
    PERF_LEVEL_COEFS, PERF_RANG_EXP, PERF_CHRONO_W, PERF_FIELD_K, PERF_SHRINK_M, PERF_SHRINK_DIV, PERF_DNF_SCORES,
    loadFieldStrength, perfShrinkMean, perfWeight, fieldAdjust, applyFieldScore,
    perfClamp, perfScoreRang, perfBestTime, perfChronoScore,
    perfConstance, perfCoefConstance, perfDeepestPhase,
    fmtDateFr, formatDataDates,
    renderDataDates, setTextStatus, setBarProgress,
    getFavs, isFav, toggleFav, pushRecent, getRecent,
  };
})();
