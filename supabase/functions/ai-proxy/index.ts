// Sends food-logging requests to Anthropic. Your Anthropic key lives here as a secret,
// never in the app. Only signed-in people can use it, with a daily limit each.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const DAILY_LIMIT = 60; // AI requests per person per day
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
  if (!ALLOWED_MODELS.includes(body?.model) || !Array.isArray(body?.messages)) return json({ error: { message: 'Bad request' } }, 400);

  const { data: count, error: usageErr } = await admin.rpc('bump_ai_usage', { p_user: auth.user.id });
  if (usageErr) return json({ error: { message: 'Usage check failed' } }, 500);
  if (Number(count) > DAILY_LIMIT) return json({ error: { message: `Daily AI limit of ${DAILY_LIMIT} reached. It resets at midnight UTC.` } }, 429);

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': Deno.env.get('ANTHROPIC_API_KEY')!,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: body.model,
      max_tokens: Math.min(Number(body.max_tokens) || 1500, 2000),
      system: typeof body.system === 'string' ? body.system.slice(0, 12000) : undefined,
      messages: body.messages
    })
  });
  return new Response(await upstream.text(), {
    status: upstream.status,
    headers: { ...cors, 'Content-Type': 'application/json' }
  });
});
