// Vercel Edge Function: 利用できるモデル一覧（絞り込みはクライアント側で行う）
export const config = { runtime: 'edge' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' } });

export default async function handler(req) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return json({ error: { message: 'OPENAI_API_KEY が設定されていません' } }, 500);
  const pass = process.env.APP_PASSWORD;
  if (pass && req.headers.get('x-cwi-token') !== pass) return json({ error: { message: 'アクセス用パスワードが違います' } }, 401);
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  let up;
  try { up = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } }); }
  catch (e) { return json({ error: { message: `OpenAI に接続できません: ${e.message}` } }, 502); }
  if (!up.ok) return json({ error: { message: `HTTP ${up.status}` } }, up.status);
  const j = await up.json();
  return json({ default: process.env.OPENAI_MODEL || 'gpt-5.6-luna', models: (j.data || []).map(m => m.id) });
}
