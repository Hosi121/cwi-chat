// Vercel Edge Function: OpenAI への中継（キーはサーバーの環境変数）
//   OPENAI_API_KEY   必須
//   OPENAI_MODEL     任意（既定 gpt-4.1-mini）
//   OPENAI_BASE_URL  任意
//   APP_PASSWORD     任意。設定すると x-cwi-token ヘッダが一致した要求だけ通す
export const config = { runtime: 'edge' };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: { message: 'method not allowed' } }, 405);
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ error: { message: 'OPENAI_API_KEY が設定されていません' } }, 500);
  const pass = process.env.APP_PASSWORD;
  if (pass && req.headers.get('x-cwi-token') !== pass) return json({ error: { message: 'アクセス用パスワードが違います' } }, 401);

  let body;
  try { body = await req.json(); } catch (_) { return json({ error: { message: 'invalid JSON' } }, 400); }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return json({ error: { message: 'messages がありません' } }, 400);
  const payload = { model: body.model || process.env.OPENAI_MODEL || 'gpt-4.1-mini', messages: body.messages.slice(-40), stream: true };
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');

  let up;
  try {
    up = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: req.signal,
    });
  } catch (e) {
    return json({ error: { message: `OpenAI に接続できません: ${e.message}` } }, 502);
  }
  if (!up.ok) return new Response(await up.text(), { status: up.status, headers: { 'Content-Type': up.headers.get('content-type') || 'application/json' } });
  return new Response(up.body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } });
}
