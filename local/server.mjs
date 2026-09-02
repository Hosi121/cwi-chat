/* ============================================================
   server.mjs — 静的配信 + OpenAI 中継（依存なし / Node 18+）
     node local/server.mjs      -> http://localhost:8787/
   リポジトリ直下の .env から OPENAI_API_KEY を読み、ブラウザにはキーを渡しません。
     OPENAI_API_KEY=sk-...      標準の書き方
     sk-...                     キーだけ 1 行で書いてある場合もそのまま使えます
     OPENAI_MODEL=gpt-5.6-luna  省略可（既定モデル）
     OPENAI_BASE_URL=...        省略可（互換 API を使う場合）
     PORT=8787                  省略可
     APP_PASSWORD=...           省略可。設定すると Live 利用時にパスワード（x-cwi-token）を求める
   ============================================================ */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // リポジトリ直下

function loadEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      else if (/^sk-[A-Za-z0-9_\-]+$/.test(line)) out.OPENAI_API_KEY = line; // 変数名なしでキーだけの行
    }
  } catch (_) { /* .env がなければ環境変数だけを使う */ }
  return out;
}
const env = { ...loadEnv(), ...process.env };
const API_KEY = env.OPENAI_API_KEY || '';
const DEFAULT_MODEL = env.OPENAI_MODEL || 'gpt-5.6-luna';
const BASE = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const PORT = +env.PORT || 8787;
const APP_PASSWORD = env.APP_PASSWORD || '';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function serveStatic(pathname, res) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.normalize(path.join(ROOT, rel));
  const base = path.basename(abs);
  if (!abs.startsWith(ROOT + path.sep) || base.startsWith('.') || abs.startsWith(path.join(ROOT, 'local') + path.sep)) { json(res, 404, { error: 'not found' }); return; }
  fs.readFile(abs, (err, data) => {
    if (err) { json(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function proxyChat(req, res) {
  if (!API_KEY) { json(res, 500, { error: { message: '.env に OPENAI_API_KEY がありません' } }); return; }
  if (APP_PASSWORD && req.headers['x-cwi-token'] !== APP_PASSWORD) { json(res, 401, { error: { message: 'アクセス用パスワードが違います' } }); return; }
  let body = '';
  for await (const c of req) body += c;
  let payload;
  try { payload = JSON.parse(body || '{}'); } catch (_) { json(res, 400, { error: { message: 'invalid JSON' } }); return; }
  if (!Array.isArray(payload.messages) || !payload.messages.length) { json(res, 400, { error: { message: 'messages がありません' } }); return; }
  payload = { model: payload.model || DEFAULT_MODEL, messages: payload.messages.slice(-40), stream: true };

  const ac = new AbortController();
  res.on('close', () => ac.abort()); // ブラウザ側が中断したら上流も止める
  let up;
  try {
    up = await fetch(`${BASE}/chat/completions`, {
      method: 'POST', signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    if (e.name !== 'AbortError') json(res, 502, { error: { message: `OpenAI に接続できません: ${e.message}` } });
    return;
  }
  if (!up.ok) {
    const t = await up.text();
    res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json' });
    res.end(t);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  try { for await (const chunk of up.body) res.write(chunk); } catch (_) { /* 中断 */ } finally { res.end(); }
}

async function listModels(req, res) {
  if (!API_KEY) { json(res, 500, { error: { message: '.env に OPENAI_API_KEY がありません' } }); return; }
  if (APP_PASSWORD && req.headers['x-cwi-token'] !== APP_PASSWORD) { json(res, 401, { error: { message: 'アクセス用パスワードが違います' } }); return; }
  let up;
  try { up = await fetch(`${BASE}/models`, { headers: { Authorization: `Bearer ${API_KEY}` } }); }
  catch (e) { json(res, 502, { error: { message: `OpenAI に接続できません: ${e.message}` } }); return; }
  if (!up.ok) { json(res, up.status, { error: { message: `HTTP ${up.status}` } }); return; }
  const j = await up.json();
  json(res, 200, { default: DEFAULT_MODEL, models: (j.data || []).map(m => m.id) });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/api/health') { json(res, 200, { ok: !!API_KEY, model: DEFAULT_MODEL, needsToken: !!APP_PASSWORD }); return; }
  if (url.pathname === '/api/models') { listModels(req, res).catch(e => { try { json(res, 500, { error: { message: e.message } }); } catch (_) { /* sent */ } }); return; }
  if (url.pathname === '/api/chat' && req.method === 'POST') { proxyChat(req, res).catch(e => { try { json(res, 500, { error: { message: e.message } }); } catch (_) { /* already sent */ } }); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: 'method not allowed' }); return; }
  serveStatic(url.pathname, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`CwI Chat  http://localhost:${PORT}/`);
  console.log(API_KEY ? `OpenAI key: loaded from .env (model: ${DEFAULT_MODEL})` : 'OpenAI key: NOT FOUND — .env に OPENAI_API_KEY=sk-... を書いてください');
});
