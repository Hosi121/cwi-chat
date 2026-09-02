// Vercel Edge Function: 中継が使えるか、パスワードが要るかを返す
export const config = { runtime: 'edge' };
export default function handler() {
  return new Response(JSON.stringify({
    ok: !!process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
    needsToken: !!process.env.APP_PASSWORD,
  }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' } });
}
