// Worker unico: serve o site (index.html), a API do painel (/api/data)
// e a sincronizacao com a Reserva Ink (/api/reserva-ink/sync + agendamento diario)

function checkAccess(url, env) {
  if (!env.ACCESS_KEY) return true; // sem ACCESS_KEY configurada, libera (nao recomendado)
  const access = url.searchParams.get('access');
  return access === env.ACCESS_KEY;
}

/* ---------------- API do painel (le/escreve no KV) ---------------- */

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

/* ---------------- integracao com a Reserva Ink ---------------- */

const RESERVA_INK_BASE = 'https://api.reserva.ink';
// So a VivaShop tem token/integracao com a Reserva Ink por enquanto. Adicionar
// 'petnip' aqui (e um RESERVA_INK_TOKEN_PETNIP separado, se for o caso) quando
// a Petnip tambem passar a usar a Reserva Ink.
const RESERVA_INK_LOJAS = ['vivashop'];

// busca todas as paginas de um endpoint que declara total_pages (orders, withdraws)
async function fetchAllPages(url, token, arrayField, maxPages = 50) {
  let page = 1;
  let totalPages = 1;
  let items = [];
  while (page <= totalPages && page <= maxPages) {
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '100');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Reserva Ink API ${res.status} em ${url.pathname}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    items = items.concat(data[arrayField] || []);
    totalPages = data.total_pages || 1;
    page++;
  }
  return items;
}

// prepayments nao declara total_pages/total_count - para quando a pagina vem vazia,
// incompleta, ou quando ja passou do mes procurado (assumindo ordem do mais recente pro mais antigo)
async function fetchPrepaymentsForMonth(token, monthStart, monthEnd, maxPages = 30) {
  let page = 1;
  let matched = [];
  while (page <= maxPages) {
    const url = new URL(`${RESERVA_INK_BASE}/v1/stores/prepayments`);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', '100');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Reserva Ink API ${res.status} em prepayments: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    const list = data.prepayments || [];
    if (list.length === 0) break; // fim da listagem

    let sawOlder = false;
    for (const p of list) {
      const dRaw = p.date || p.created_at;
      if (!dRaw) continue;
      const dt = new Date(dRaw);
      if (dt >= monthStart && dt <= monthEnd) matched.push(p);
      else if (dt < monthStart) sawOlder = true;
    }

    if (sawOlder) break;
    if (list.length < 100) break; // ultima pagina (veio incompleta)
    page++;
  }
  return matched;
}

function monthBounds(monthKey) {
  const [yStr, mStr] = monthKey.split('-');
  const y = parseInt(yStr, 10), m = parseInt(mStr, 10);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    beginDateStr: `${y}-${String(m).padStart(2, '0')}-01`,
    endDateStr: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    monthStart: new Date(Date.UTC(y, m - 1, 1)),
    monthEnd: new Date(Date.UTC(y, m - 1, lastDay, 23, 59, 59))
  };
}

async function syncReservaInk(env, loja, monthKey) {
  if (!RESERVA_INK_LOJAS.includes(loja)) throw new Error(`Loja "${loja}" ainda nao tem integracao com a Reserva Ink`);
  const token = env.RESERVA_INK_TOKEN;
  if (!token) throw new Error('RESERVA_INK_TOKEN nao configurado nas variaveis do projeto');

  const { beginDateStr, endDateStr, monthStart, monthEnd } = monthBounds(monthKey);

  // 1. pedidos pagos do mes -> vendas realizadas, itens vendidos, faturamento, lucro bruto
  // O filtro payment_status=paid na propria chamada a API (igual sempre foi)
  // ja garante que so pedidos efetivamente pagos voltam - o que sozinho ja
  // exclui cancelado/expirado/aguardando pagamento (pendente)/reembolsado/
  // nao autorizado, sem precisar buscar pagina nenhuma a mais (mesmo volume
  // de dados de sempre, sem risco de estourar limite de sub-requisicao). A
  // unica excecao e pedido de troca (is_exchange), que pode voltar marcado
  // como "paid" mesmo nao sendo uma venda de verdade - por isso o filtro
  // extra abaixo, que so reaproveita os pedidos ja buscados (nenhuma
  // requisicao a mais).
  const ordersUrl = new URL(`${RESERVA_INK_BASE}/v1/stores/orders`);
  ordersUrl.searchParams.set('begin_date', beginDateStr);
  ordersUrl.searchParams.set('end_date', endDateStr);
  ordersUrl.searchParams.set('payment_status', 'paid');
  const pedidosPagos = await fetchAllPages(ordersUrl, token, 'orders');
  const orders = pedidosPagos.filter(o => !o.is_exchange);

  let itensVendidos = 0, faturamento = 0, lucroBruto = 0;
  for (const o of orders) {
    faturamento += parseFloat(o.total_value) || 0;
    lucroBruto += parseFloat(o.kickback_value) || 0;
    for (const it of (o.items || [])) itensVendidos += Number(it.quantity) || 0;
  }
  const vendasRealizadas = orders.length;

  // 2. antecipacoes (adiantamentos) do mes -> juros de antecipacao
  // Importante: o campo zoop_fee que a Reserva Ink devolve aqui e a parte da
  // Zoop no CUSTO DE ANTECIPAR recebiveis (junto com partner_fee, a parte da
  // Reserva Ink) - nao e a taxa de processamento por venda. Os dois juntos
  // (partner_fee + zoop_fee) formam o "juros" que a antecipacao custou no mes,
  // por isso viram um numero separado (jurosAntecipacao), sem tocar em taxaZoop.
  const prepayments = await fetchPrepaymentsForMonth(token, monthStart, monthEnd);
  let jurosAntecipacao = 0;
  for (const p of prepayments) jurosAntecipacao += (Number(p.partner_fee) || 0) + (Number(p.zoop_fee) || 0);

  // 3. saques do mes -> entradas de caixa (repasse)
  const withdrawsUrl = new URL(`${RESERVA_INK_BASE}/v1/stores/withdraws`);
  withdrawsUrl.searchParams.set('start_date', beginDateStr);
  withdrawsUrl.searchParams.set('end_date', endDateStr);
  const withdraws = await fetchAllPages(withdrawsUrl, token, 'withdraws');

  // 4. grava no DRE (monthlyManual do mes)
  const dreRaw = await env.DRE_KV.get(`dre_data_${loja}`);
  const dre = dreRaw ? JSON.parse(dreRaw) : { categories: [], expenses: [], monthlyManual: {} };
  if (!dre.monthlyManual) dre.monthlyManual = {};
  if (!dre.monthlyManual[monthKey]) dre.monthlyManual[monthKey] = {};
  Object.assign(dre.monthlyManual[monthKey], {
    vendasRealizadas,
    itensVendidos,
    faturamento: Number(faturamento.toFixed(2)),
    lucroBruto: Number(lucroBruto.toFixed(2)),
    jurosAntecipacao: Number(jurosAntecipacao.toFixed(2))
    // taxaZoop nao e mais preenchido automaticamente: o zoop_fee das
    // antecipacoes nao e a taxa de venda, e sobrescrever taxaZoop com ele
    // apagava o valor real que era controlado manualmente. Taxa Zoop
    // continua 100% manual (aba Despesas ou o campo no Painel do mes).
  });
  await env.DRE_KV.put(`dre_data_${loja}`, JSON.stringify(dre));

  // 5. grava no Caixa (entradas de repasse, sem duplicar em sincronizacoes repetidas)
  const caixaRaw = await env.DRE_KV.get(`caixa_data_${loja}`);
  const caixa = caixaRaw ? JSON.parse(caixaRaw) : {
    entradas: [], retiradas: [],
    saldoBanco: { valor: 0, atualizadoEm: null },
    abertura: { data: null, saldoInicial: 0 },
    entradaTipos: ['Repasse Reserva Ink']
  };
  if (!caixa.entradaTipos) caixa.entradaTipos = [];
  if (!caixa.entradaTipos.includes('Repasse Reserva Ink')) caixa.entradaTipos.push('Repasse Reserva Ink');

  const existingIds = new Set(caixa.entradas.filter(e => e.origemId).map(e => e.origemId));
  let novasEntradas = 0;
  for (const w of withdraws) {
    const origemId = `reserva-ink-withdraw-${w.id}`;
    if (existingIds.has(origemId)) continue;
    caixa.entradas.push({
      id: `sync-${w.id}-${Date.now()}`,
      categoria: 'Repasse Reserva Ink',
      data: (w.created_at || '').slice(0, 10),
      valor: Number(w.amount) || 0,
      descricao: 'Importado automaticamente da Reserva Ink',
      origemId
    });
    novasEntradas++;
  }
  await env.DRE_KV.put(`caixa_data_${loja}`, JSON.stringify(caixa));

  return {
    vendasRealizadas, itensVendidos,
    faturamento: Number(faturamento.toFixed(2)),
    lucroBruto: Number(lucroBruto.toFixed(2)),
    jurosAntecipacao: Number(jurosAntecipacao.toFixed(2)),
    novasEntradasCaixa: novasEntradas,
    pedidosEncontrados: orders.length,
    antecipacoesEncontradas: prepayments.length,
    saquesEncontrados: withdraws.length
  };
}

async function handleReservaInkSync(request, env) {
  const url = new URL(request.url);
  if (!checkAccess(url, env)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const loja = url.searchParams.get('loja') || 'vivashop';
  const now = new Date();
  const monthKey = url.searchParams.get('month') || `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  try {
    const result = await syncReservaInk(env, loja, monthKey);
    return new Response(JSON.stringify({ ok: true, loja, monthKey, ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// busca os pedidos crus (qualquer status) num intervalo de datas, pras abas de
// Vendas agregarem no front-end (aggregateVendas/pedidoContaComoVenda ja
// aplicam o filtro de reembolso/expirado/nao-autorizado/troca do lado do
// cliente, entao aqui devolvemos tudo sem pre-filtrar por payment_status).
async function fetchOrdersForRange(token, beginDateStr, endDateStr) {
  const url = new URL(`${RESERVA_INK_BASE}/v1/stores/orders`);
  url.searchParams.set('begin_date', beginDateStr);
  url.searchParams.set('end_date', endDateStr);
  return fetchAllPages(url, token, 'orders');
}

async function handleReservaInkOrders(request, env) {
  const url = new URL(request.url);
  if (!checkAccess(url, env)) {
    return new Response('Unauthorized', { status: 401 });
  }
  const loja = url.searchParams.get('loja') || 'vivashop';
  const begin = url.searchParams.get('begin');
  const end = url.searchParams.get('end');
  if (!begin || !end) {
    return new Response(JSON.stringify({ ok: false, error: 'Faltou begin e/ou end (formato YYYY-MM-DD)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!RESERVA_INK_LOJAS.includes(loja)) {
    return new Response(JSON.stringify({ ok: false, error: `Loja "${loja}" ainda nao tem integracao com a Reserva Ink` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const token = env.RESERVA_INK_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ ok: false, error: 'RESERVA_INK_TOKEN nao configurado nas variaveis do projeto' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  try {
    const orders = await fetchOrdersForRange(token, begin, end);
    return new Response(JSON.stringify({ ok: true, orders }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/* ---------------- worker ---------------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/data') {
      return handleApiData(request, env);
    }
    if (url.pathname === '/api/reserva-ink/sync') {
      return handleReservaInkSync(request, env);
    }
    if (url.pathname === '/api/reserva-ink/orders') {
      return handleReservaInkOrders(request, env);
    }

    // qualquer outra rota: serve os arquivos estaticos do site (index.html etc)
    return env.ASSETS.fetch(request);
  },

  // roda sozinho todo dia (horario definido no wrangler.jsonc), sincronizando o mes atual
  async scheduled(event, env, ctx) {
    const now = new Date();
    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const lojas = ['vivashop']; // adicionar 'petnip' aqui se ela tambem usar Reserva Ink
    for (const loja of lojas) {
      try {
        await syncReservaInk(env, loja, monthKey);
      } catch (e) {
        console.error(`Erro no sync agendado (${loja}):`, e.message);
      }
    }
  }
};
