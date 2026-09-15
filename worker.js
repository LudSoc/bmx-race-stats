const SQORZ_BASE = 'https://our.sqorz.com';
const TTL_STATIC = 7 * 24 * 3600;   // 7 jours
const TTL_DYNAMIC = 4 * 3600;       // 4h pour les autres routes

function corsPreflightResp() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

async function proxyWithKv(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const key = 'bmx:' + path;

  const cached = await env.SQORZ_CACHE.get(key, 'text');
  if (cached !== null) {
    return new Response(cached, {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'HIT' },
    });
  }

  const upstream = await fetch(SQORZ_BASE + path);
  if (!upstream.ok) {
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { 'Access-Control-Allow-Origin': '*' },
    });
  }
  const text = await upstream.text();

  const isStatic = path.startsWith('/json/region/') || path.startsWith('/json/org/');
  const ttl = isStatic ? TTL_STATIC : TTL_DYNAMIC;
  try { await env.SQORZ_CACHE.put(key, text, { expirationTtl: ttl }); } catch {}

  return new Response(text, {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'X-Cache': 'MISS' },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return corsPreflightResp();
    const url = new URL(request.url);
    if (url.pathname.startsWith('/json/')) return proxyWithKv(request, env);
    return new Response('Not found', { status: 404 });
  },
};
