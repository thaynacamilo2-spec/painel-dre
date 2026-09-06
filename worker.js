// Worker unico: serve o site (index.html) e cuida da API /api/data (le/escreve no KV)

function checkAccess(url, env) {
  if (!env.ACCESS_KEY) return true; // sem ACCESS_KEY configurada, libera (nao recomendado)
  const access = url.searchParams.get('access');
  return access === env.ACCESS_KEY;
}

async function handleApiData(request, env) {
  const url = new URL(request.url);

  if (!checkAccess(url, env)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const key = url.searchParams.get('key');
  if (!key) {
    return new Response(JSON.stringify({ error: 'Faltou o parametro key' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'GET') {
    const value = await env.DRE_KV.get(key);
    return new Response(JSON.stringify({ value }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Corpo invalido' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    await env.DRE_KV.put(key, body.value);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  return new Response('Method not allowed', { status: 405 });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/data') {
      return handleApiData(request, env);
    }

    // qualquer outra rota: serve os arquivos estaticos do site (index.html etc)
    return env.ASSETS.fetch(request);
  }
};
