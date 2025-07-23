import type { APIRoute } from 'astro';
export const prerender = false

/** Yahoo Finance v8 chart (1 year, 1d) – proxy */
export const GET: APIRoute = async ({ params }) => {
  const sym = params.symbol?.toUpperCase();
  console.log('start', sym);
  if (!sym) return new Response('no symbol', { status: 400 });

  const now      = Math.floor(Date.now() / 1000);         // epoch sec
  const oneYear  = now - 60 * 60 * 24 * 365;
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${sym
    }?period1=${oneYear}&period2=${now}&interval=1d`;

  const yRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!yRes.ok) return new Response('yahoo fail', { status: 502 });

  const raw  = await yRes.json();
  const res  = raw.chart?.result?.[0];
  if (!res) return new Response('no data', { status: 404 });

  const ts   = res.timestamp;
  const cls  = res.indicators.quote[0].close;

  const data = ts.map((t: number, i: number) => ({
    date : new Date(t * 1000).toISOString().slice(0, 10), // YYYY-MM-DD
    close: cls[i],
  })).filter(d => d.close != null);                       // rimuove null

  console.log('end', sym);
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  });
};
