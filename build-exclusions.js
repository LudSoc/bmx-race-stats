// Liste d'exclusion des pilotes — RGPD : droit d'opposition (art. 21) et
// correction d'attributions erronées. Les concurrents listés sont retirés des
// index publiés (pilots-index.json, uci-index.json, uec-index.json,
// uci-worldcup-index.json) AU MOMENT de leur génération : ils ne réapparaissent
// donc plus jamais, y compris après les régénérations hebdomadaires.
//
// Branché dans : build-index.js (événements + séries), build-uec.js,
// build-uciworldcup.js. Les outils en aval (hub-search.json, perf-rankings.json,
// field-strength-*.json) lisent les index générés : ils sont donc filtrés aussi.
//
// ⚠️ CONFIDENTIALITÉ — ce fichier est dans un dépôt PUBLIC. Ne jamais y inscrire
// un nom en clair : ce serait republier l'identité de la personne qui a demandé à
// être effacée. Utiliser le champ `hmac` (voir ci-dessous).
//
// Format de excluded-pilots.json :
// {
//   "version": 2,
//   "excluded": [
//     { "hmac": "9f2c…64 hex",
//       "reason": "opposition art. 21 — demande du 2026-10-05" },
//     { "hmac": "1a7b…", "account": "ffc", "from": "2026-01-01",
//       "reason": "attribution erronée (homonyme) — ne retirer que la FFC depuis le 01/01/2026" }
//   ]
// }
//
// `hmac` — OBLIGATOIRE en production. HMAC-SHA256 du nom normalisé, calculé avec
//   le secret EXCLUDE_HMAC_KEY (variable d'environnement / Actions Secret, JAMAIS
//   dans le dépôt). Sans secret, un nom public peut être testé par force brute :
//   il suffit de hasher les 17 000 noms de pilots-index.json. Avec le secret, le
//   hachage est irréversible. Le nom est d'abord normalisé ET ses tokens triés
//   (normKeyAlias), donc l'ordre des mots n'a pas d'importance.
//   Pour obtenir la valeur à inscrire :
//     EXCLUDE_HMAC_KEY=… node -e "console.log(require('./build-exclusions.js').hmacKey('Prénom','NOM'))"
// `account` (facultatif) : ne retirer que les résultats de cette organisation
//   (code de compte : `ffc`, `ffcbmxne`, `uec`, `uciworldcup`…). À utiliser pour
//   lever une homonymie plutôt que d'exclure tout l'homonyme.
// `from` (facultatif) : ne retirer que les résultats à partir de cette date incluse
//   (`YYYY-MM-DD`). Pour une série (classement général), la date retenue est celle
//   de sa manche la plus récente. Sans `from` : tous les résultats sont retirés.
// `reason` (facultatif) : traçabilité de la demande. ⚠️ NE JAMAIS Y METTRE LE NOM,
//   ni le club, ni le numéro de plaque : ce champ est en clair dans le dépôt.
//
// `key` / `firstName` + `lastName` — format en clair, ACCEPTÉ pour les tests et le
//   tout premier calcul, mais fortement discouraged : ces entrées sont
//   identifiantes. Un avertissement est émis à chaque chargement. Si le dépôt
//   contient des entrées en clair alors que le secret est configuré, une erreur est
//   levée : les builders doivent forcer l'usage du HMAC.
//
// ⚠️ Si le fichier contient des règles `hmac` mais que le secret est absent, on
// lève une erreur AU LIEU DE LES IGNORER : une opposition non appliquée
// republierait les résultats d'une personne qui a demandé leur effacement.
//
// Bonnes pratiques : garder les entrées tant que la personne est concernée (sinon
// le pilote réapparaît au prochain cron) — c'est ce qui rend l'effacement
// réellement opposable.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Erreur de CONFIGURATION des exclusions (secret absent, vector faux, nom en
// clair). Critique : la distinguer des erreurs de crawl permet aux builders de
// la relancer au lieu de « sauter » l'événement — sinon un secret manquant
// produirait un index VIDE publié comme valide, ce qui est pire que l'échec.
class ExclusionConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExclusionConfigError';
    this.fatal = true; // à relancer, jamais à avaler
  }
}

const DEFAULT_FILE = path.join(__dirname, 'excluded-pilots.json');
const SECRET_ENV = 'EXCLUDE_HMAC_KEY';
const HMAC_RE = /^[0-9a-f]{64}$/;
// Sonde publique du champ "vector" : hachee avec le secret pour vérifier qu'il
// s'agit bien du bon. Constante arbitraire, ne correspond à aucun nom.
const VECTOR_PROBE = 'exclusions-vector-probe';

// Minuscules, NFD sans diacritiques, ponctuation → espace, espaces compactés.
// Équivalent à norm() de common.js / build-index.js (même classe de diacritiques).
const clean = s => (s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// Clé « prénom nom » — identique à norm() côté app.
const normKey = (firstName, lastName) => clean(`${firstName || ''} ${lastName || ''}`);

// Alias trié : rend la correspondance INSENSIBLE à l'ordre des tokens, pour que
// « Dupont Jean » (usage français) et « Jean Dupont » (format de la source) visent
// la même personne. Sans cela, une règle mal écrite échouerait SILENCIEUSEMENT.
const normKeyAlias = (firstName, lastName) => clean(`${firstName || ''} ${lastName || ''}`)
  .split(' ').filter(Boolean).sort().join(' ');

// keyOf(prénom, nom) : clé en clair — pour un calcul ponctuel, PAS pour le dépôt.
//   node -e "console.log(require('./build-exclusions.js').keyOf('Candy','PLANÇON'))"
const keyOf = (firstName, lastName) => normKey(firstName, lastName);

// Secret de hachage : variable d'environnement EXCLUDE_HMAC_KEY. Absent → null.
// `explicit` : une chaîne force le secret, `null` force l'absence (utile pour les
// tests du mode « liste en clair »), `undefined` → variable d'environnement.
function resolveSecret(explicit) {
  if (explicit === null) return null;
  if (typeof explicit === 'string') return explicit.trim() ? explicit.trim() : null;
  const env = process.env[SECRET_ENV];
  return typeof env === 'string' && env.trim() ? env.trim() : null;
}

// HMAC-SHA256(secret, normKeyAlias(prénom, nom)) → 64 hex. L'alias trié rend le
// hachage insensible à l'ordre des tokens, comme normKeyAlias côté correspondance.
function hmacHex(firstName, lastName, secret) {
  const key = normKeyAlias(firstName, lastName);
  if (!key) return '';
  return crypto.createHmac('sha256', String(secret))
    .update(key, 'utf8')
    .digest('hex');
}

// hmacKey(prénom, nom) : valeur `hmac` à inscrire dans excluded-pilots.json.
//   EXCLUDE_HMAC_KEY=… node -e "console.log(require('./build-exclusions.js').hmacKey('Candy','PLANÇON'))"
function hmacKey(firstName, lastName, secret = resolveSecret()) {
  if (!secret) {
    throw new ExclusionConfigError(
      `${SECRET_ENV} absent : impossible de calculer un hmac. ` +
      `Définissez la variable (Actions Secret) puis relancez.`
    );
  }
  const h = hmacHex(firstName, lastName, secret);
  if (!h) throw new Error('nom vide : hmac non calculable');
  return h;
}

function loadExclusions(file = DEFAULT_FILE, opts = {}) {
  const secret = resolveSecret(opts.secret);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { file, rules: [], byKey: new Map(), byHmac: new Map(), invalid: 0, hmac: 0, clear: 0, secret };
    }
    throw e;
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} : JSON invalide — ${e.message}`);
  }
  const list = Array.isArray(doc.excluded) ? doc.excluded : [];

  // VECTOR — auto-test du secret. Sans lui, un secret ERRONÉ (typo, ancien
  // secret roté, secret du mauvais dépôt) ne serait détecté par rien : le build
  // se terminerait sans erreur en republiant les résultats d'une personne qui a
  // demandé son effacement. Le vecteur est hmacé sur une constante publique, il
  // ne ré-identifie personne. Régénérer après une rotation :
  //   EXCLUDE_HMAC_KEY=… node -e "const{hmacHex,VECTOR_PROBE}=require('./build-exclusions.js');console.log(hmacHex(VECTOR_PROBE,VECTOR_PROBE,process.env.EXCLUDE_HMAC_KEY))"
  if (secret && doc.vector !== undefined) {
    if (!HMAC_RE.test(String(doc.vector || ''))) {
      throw new Error(`${file} : champ "vector" invalide (64 hex attendus).`);
    }
    if (String(doc.vector) !== hmacHex(VECTOR_PROBE, VECTOR_PROBE, secret)) {
      throw new ExclusionConfigError(
        `${file} : ${SECRET_ENV} ne correspond PAS à ce fichier d'exclusions. ` +
        `REFUS de construire : avec un mauvais secret, les oppositions ` +
        `ne s'appliqueraient pas et les résultats seraient republiés. ` +
        `Vérifiez le secret, ou régénérez le "vector".`
      );
    }
  }

  const byKey = new Map();   // règles en clair (tests / tout premier calcul)
  const byHmac = new Map();  // règles hmacées (production)
  let invalid = 0, hmacCount = 0, clearCount = 0;
  const seen = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') { invalid++; continue; }
    const hmac = typeof r.hmac === 'string' ? r.hmac.trim().toLowerCase() : '';
    const hasPlain = typeof r.key === 'string' || typeof r.firstName === 'string' || typeof r.lastName === 'string';
    // Source de la clé : `hmac` (secret) OU `key`/`firstName`+`lastName` (en clair).
    if (hmac && !HMAC_RE.test(hmac)) {
      throw new ExclusionConfigError(
        `${file} : champ "hmac" invalide (64 caractères hexadécimaux attendus) : ${JSON.stringify(r.hmac).slice(0, 80)}`
      );
    }
    if (hmac && hasPlain) {
      throw new ExclusionConfigError(
        `${file} : une entrée porte à la fois "hmac" et un nom en clair — ` +
        `ce dernier ré-identifierait la personne dans un dépôt public. Retirez-le.`
      );
    }
    if (hmac && !secret) {
      throw new ExclusionConfigError(
        `${file} : ${hmacCount + 1} règle(s) "hmac" mais ${SECRET_ENV} est absente. ` +
        `REFUS de continuer : sans le secret, ces oppositions ne peuvent pas être appliquées, ` +
        `et les résultats seraient republiés. Configurez le secret, ou retirez les règles "hmac".`
      );
    }
    const explicit = typeof r.firstName === 'string' || typeof r.lastName === 'string';
    const key = explicit
      ? normKey(r.firstName || '', r.lastName || '')
      : (typeof r.key === 'string' ? normKey(r.key) : '');
    if (!hmac && !key) { invalid++; continue; }
    const rule = {
      key,                       // '' pour une règle hmacée (jamais publiée)
      alias: explicit ? normKeyAlias(r.firstName || '', r.lastName || '') : normKeyAlias(r.key || ''),
      hmac: hmac || null,
      account: String(r.account || '').trim().toLowerCase() || null,
      from: /^\d{4}-\d{2}-\d{2}$/.test(String(r.from || '')) ? r.from : null,
      reason: String(r.reason || '').trim(),
      // Étiquette de log : lisible en clair, tronquée pour un hmac (une empreinte
      // complète dans un log CI n'apporte rien et Faciliterait un dictionnaire).
      written: hmac
        ? `hmac:${hmac.slice(0, 12)}`
        : (explicit ? `${r.firstName || ''} ${r.lastName || ''}`.trim() : r.key),
      confidential: !!hmac,
    };
    // Indexée sous les DEUX formes (prénom nom + alias trié) → les graphies
    // « Candy PLANÇON » et « CANDY PLANCON » retombent dans la même règle.
    const keys = hmac ? [] : [...new Set([key, rule.alias])];
    for (const k of keys) {
      if (!byKey.has(k)) byKey.set(k, []);
      if (!byKey.get(k).includes(rule)) byKey.get(k).push(rule);
    }
    if (hmac) {
      if (!byHmac.has(hmac)) byHmac.set(hmac, []);
      if (!byHmac.get(hmac).includes(rule)) byHmac.get(hmac).push(rule);
      hmacCount++;
    } else {
      clearCount++;
      seen.push(rule.written);
    }
  }
  if (clearCount && secret) {
    throw new ExclusionConfigError(
      `${file} : ${clearCount} entrée(s) en clair (${seen.join(', ')}) alors que ` +
      `${SECRET_ENV} est configurée. Un dépôt public ne doit pas contenir de nom ` +
      `exclu : convertissez-les en "hmac" (voir build-exclusions.js).`
    );
  }
  if (clearCount) {
    console.warn(
      `  ⚠ exclusions RGPD : ${clearCount} entrée(s) en clair dans ${path.basename(file)} ` +
      `(${seen.join(', ')}) — identifiantes dans un dépôt public. ` +
      `Passez en "hmac" avec ${SECRET_ENV}.`
    );
  }
  return { file, rules: list.length - invalid, byKey, byHmac, invalid, hmac: hmacCount, clear: clearCount, secret };
}

// Chargement PARESSEUX — à utiliser dans les builders.
// Un `loadExclusions()` au chargement du module ferait échouer le simple
// `require('./build-uec.js')` des tests unitaires de parsing dès qu'une règle
// hmac est présente : le secret n'est nécessaire qu'au moment où l'on filtre
// réellement des concurrents, pas au moment d'importer le module. Le Proxy
// charge au premier accès et mémorise ; si le chargement échoue, l'erreur est
// renvoyée telle quelle au build (fail-loud inchangé : rien n'est publié).
function lazyExclusions(file = DEFAULT_FILE) {
  let cache = null;
  const load = () => (cache ||= loadExclusions(file));
  return new Proxy({}, {
    get(_, prop) { return load()[prop]; },
    has(_, prop) { return prop in load(); },
    ownKeys() { return Reflect.ownKeys(load()); },
    getOwnPropertyDescriptor(_, prop) {
      const d = Reflect.getOwnPropertyDescriptor(load(), prop);
      return d && { ...d, configurable: true };
    },
  });
}

// match : { firstName?, lastName?, fn?, ln?, account?, date? }
// Renvoie la règle qui exclut, ou null.
function isExcluded(ex, match) {
  const m = match || {};
  const fn = m.firstName != null ? m.firstName : (m.fn != null ? m.fn : '');
  const ln = m.lastName != null ? m.lastName : (m.ln != null ? m.ln : '');
  let rules = ex.byKey.get(normKey(fn, ln)) || ex.byKey.get(normKeyAlias(fn, ln));
  if (!rules && ex.byHmac && ex.byHmac.size && ex.secret) {
    // Règles hmacées : on hache le nom CANDIDAT avec le secret et on compare.
    const h = hmacHex(fn, ln, ex.secret);
    if (h) rules = ex.byHmac.get(h);
  }
  if (!rules) return null;
  const account = String(m.account || '').trim().toLowerCase();
  const date = String(m.date || '').slice(0, 10);
  for (const rule of rules) {
    if (rule.account && rule.account !== account) continue;
    if (rule.from && !(date && date >= rule.from)) continue;
    return rule;
  }
  return null;
}

// Filtre une liste de concurrents (format API firstName/lastName OU slim fn/ln).
// ctx : { account, date } — renvoie { kept, dropped, droppedKeys }.
function filterCompetitors(list, ex, ctx = {}) {
  const kept = [];
  const droppedKeys = new Map();
  for (const c of list || []) {
    const rule = isExcluded(ex, {
      firstName: c.firstName != null ? c.firstName : c.fn,
      lastName: c.lastName != null ? c.lastName : c.ln,
      account: ctx.account,
      date: ctx.date,
    });
    if (rule) {
      // Clé = nom en clair si la règle l'est, sinon l'empreinte tronquée : le log
      // reste lisible sans réexposer une identité (règle hmacée).
      const tag = rule.written || `hmac:${String(rule.hmac || '').slice(0, 12)}`;
      droppedKeys.set(tag, (droppedKeys.get(tag) || 0) + 1);
      continue;
    }
    kept.push(c);
  }
  return { kept, dropped: (list || []).length - kept.length, droppedKeys };
}

// Trace lisible des exclusions appliquées (une ligne par règle touchée).
function logExclusions(label, applied) {
  const n = [...applied.entries()].reduce((a, [, v]) => a + v, 0);
  if (!n) return;
  console.log(`  exclusions RGPD (${label}) : ${n} entrée(s) retirée(s) pour ${applied.size} pilote(s) exclu(s)`);
}

module.exports = {
  DEFAULT_FILE, SECRET_ENV, VECTOR_PROBE, ExclusionConfigError,
  clean, normKey, normKeyAlias, keyOf,
  resolveSecret, hmacHex, hmacKey,
  loadExclusions, lazyExclusions, isExcluded, filterCompetitors, logExclusions,
};