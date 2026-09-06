// Cloudflare Pages Function - roda em /api/data
// Le e escreve dados no KV (banco de dados na nuvem gratuito da Cloudflare)
// Espera um KV namespace vinculado com o nome DRE_KV (configurado no painel da Cloudflare)
// Opcionalmente, uma variavel de ambiente ACCESS_KEY protege o acesso

function checkAccess(url, env) {
  if (!env.ACCESS_KEY) return true; // se nao configurou chave, libera (nao recomendado)
  const access = url.searchParams.get('access');
  return access === env.ACCESS_KEY;
}

export async function onRequestGet(context) {
  const { request, env } = context;
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

  const value = await env.DRE_KV.get(key);
  return new Response(JSON.stringify({ value }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

export async function onRequestPut(context) {
  const { request, env } = context;
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
