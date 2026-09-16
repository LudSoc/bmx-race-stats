const CACHE_NAME = 'bmx-v5';
// Cache applicatif des index piloté par meta.json (chantier 2) : on le conserve
// lors des purges d'activation (il vit sur le même domaine ludsoc.github.io).
const INDEX_CACHE_NAME = 'bmx-index-v1';
// Chemins RELATIFS : l'app vit sur un sous-chemin (ex. /bmx-race-stats/) — pas à la racine
const ASSETS = ['./', './index.html'];
// Index de données volumineux régénérés chaque semaine : on ne les met JAMAIS en cache
// (ils passent directement par le navigateur, comme avant)
const NO_CACHE = ['pilots-index.json', 'uci-index.json', 'uec-index.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== INDEX_CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Ne gérer que les fichiers locaux de l'app (même origine)
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;
  // Les index de données ne passent pas par le cache
  if (NO_CACHE.some(n => url.pathname.endsWith(n))) return;

  // `cache: 'no-cache'` force la revalidation avec le serveur à CHAQUE requête :
  // GitHub Pages renvoie `Cache-Control: max-age=600`, qui sinon laisse le navigateur
  // resservir l'ancienne version jusqu'à 10 min sans la re-télécharger.
  const freshFetch = fetch(e.request, { cache: 'no-cache' })
    .then(response => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
      return response;
    })
    .catch(() => caches.match(e.request))
    // Jamais de réponse `undefined` : respondWith(undefined) → TypeError.
    .then(r => r || new Response('', { status: 404, statusText: 'Not Found' }));

  // Navigations : réseau d'abord, sinon shell en cache (l'app s'ouvre hors-ligne)
  if (e.request.mode === 'navigate') {
    e.respondWith(
      freshFetch.then(r =>
        r.ok ? r : caches.match(new URL('./', self.location).href)
      ).then(r => r || new Response('', { status: 503, statusText: 'Service Unavailable' }))
    );
    return;
  }

  // Autres GET (assets statiques) : réseau d'abord, cache en secours
  e.respondWith(freshFetch);
});
