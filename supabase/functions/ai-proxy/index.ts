// Sends food-logging requests to Anthropic. Your Anthropic key lives here as a secret,
// never in the app. Only signed-in people can use it, with a daily limit each.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const DAILY_BUDGET = 80; // cost points per person per day (resets at midnight UTC)
// cost points per request: haiku 1, sonnet 3, +5 if it uses web search, +2 if it carries images or PDFs
const costOf = (body: any, hasTools: boolean) => {
  let c = body.model === 'claude-haiku-5-5' ? 1 : 3;
  if (hasTools) c += 5;
  try {
    if (JSON.stringify(body.messages).match(/"type":"(image|document)"/)) c += 2;
  } catch { /* ignore */ }
  return c;
};
const ALLOWED_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];
const MAX_BODY_BYTES = 6_000_000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: { message: 'POST only' } }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: { message: 'Sign in first' } }, 401);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: auth, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !auth?.user) return json({ error: { message: 'Sign in first' } }, 401);

  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return json({ error: { message: 'Request too large' } }, 413);
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: { message: 'Bad request' } }, 400);
  }
  // Food database search done here, server to server, because phones can be blocked from reaching it directly.
  if (typeof body?.off_query === 'string') {
    const q = encodeURIComponent(body.off_query.slice(0, 100));
    const F = 'code,product_name,brands,nutriments,serving_size,serving_quantity,unique_scans_n';
    const get = async (url: string) => {
      const r = await fetch(url, { headers: { 'User-Agent': 'MacroChat/1.0 (personal app)', Accept: 'application/json' }, signal: AbortSignal.timeout(9000) });
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    };
    const ok = (p: Promise<any>) =>
      p.then((x) => {
        if (!Array.isArray(x) || !x.length) throw new Error('empty');
        return x;
      });
    try {
      const products = await Promise.any([
        ok(get(`https://search.openfoodfacts.org/search?q=${q}&page_size=20&fields=${F}`).then((d) => d.hits || d.products)),
        ok(get(`https://world.openfoodfacts.org/cgi/search.pl?search_terms=${q}&search_simple=1&action=process&json=1&page_size=20&fields=${F}`).then((d) => d.products))
      ]);
      return json({ products });
    } catch {
      return json({ products: [] });
    }
  }

  if (!ALLOWED_MODELS.includes(body?.model) || !Array.isArray(body?.messages)) return json({ error: { message: 'Bad request' } }, 400);

  // The only tool the app may use is Anthropic's server-side web search, capped at 2 searches a request.
  const tools = Array.isArray(body.tools)
    ? body.tools
        .filter((t: any) => t && t.type === 'web_search_20250305' && t.name === 'web_search')
        .map((t: any) => ({ type: 'web_search_20250305', name: 'web_search', max_uses: Math.min(Number(t.max_uses) || 2, 2) }))
    : [];

  // charge the request by its cost (the counter only counts by one, so bump it once per point)
  const cost = costOf(body, tools.length > 0);
  let count = 0;
  for (let i = 0; i < cost; i++) {
    const { data, error: usageErr } = await admin.rpc('bump_ai_usage', { p_user: auth.user.id });
    if (usageErr) return json({ error: { message: 'Usage check failed' } }, 500);
    count = Number(data);
    if (count > DAILY_BUDGET) return json({ error: { message: 'Daily AI limit reached. It resets at midnight UTC (3 AM Kuwait time).' } }, 429);
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: body.model,
      max_tokens: Math.min(Number(body.max_tokens) || 1000, body.model === 'claude-haiku-5-5' ? 2000 : 1200),
      system: typeof body.system === 'string' ? body.system.slice(0, 12000) : undefined,
      messages: body.messages,
      ...(tools.length ? { tools } : {})
    })
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
});
