/* ============================================================
   cwi-chat.js — CwI Chat
   Caption-with-Intention 風の「言い方」を、文字の太さ・色・動き・間、
   アバターの表情と視線、部屋の照明で表現する。
   台本モード（WoZ）と Live モード（OpenAI にルールを渡して生成）を切り替えられる。
   ============================================================ */
(() => {
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ---------- 1. 表現モデル ---------- */
// pace: 1文字あたりの表示間隔の倍率 / jitter: ためらいのゆらぎ（0-1）
const TAGS = {
  sure:    { label: '断言・確信',        pace: 1.0 },
  maybe:   { label: '推測・自信なし',    pace: 1.35, jitter: 0.6 },
  warm:    { label: '共感・寄り添い',    pace: 1.15 },
  glad:    { label: '喜び・ワクワク',    pace: 0.8 },
  care:    { label: '注意・警告',        pace: 1.2 },
  sorry:   { label: '謝罪',              pace: 1.4 },
  joke:    { label: '冗談・軽さ',        pace: 0.9 },
  think:   { label: '考え中・独り言',    pace: 1.5, jitter: 0.35 },
  em:      { label: '強調',              pace: 1.15 },
  dot:     { label: '傍点',              pace: 1.1 },
  big:     { label: '大きな声',          pace: 1.2 },
  small:   { label: '小さな声',          pace: 0.9 },
  slow:    { label: 'ゆっくり',          pace: 1.8 },
  fast:    { label: 'はやく',            pace: 0.55 },
  drawl:   { label: '溜め',              pace: 1.9 },
  formal:  { label: '明朝・改まって',    pace: 1.2 },
  tremble: { label: '震え',              pace: 1.2 },
  fade:    { label: '尻すぼみ',          pace: 1.3 },
  rise:    { label: '語尾上げ',          pace: 1.1 },
  fall:    { label: '語尾下げ',          pace: 1.25 },
  strike:  { label: '言い直し',          pace: 1.0 },
};
// 単独で置くタグ（パレット用）
const SELF_TAGS = [
  ['pause', '{pause:600}'], ['br', '{br}'], ['cue', '{cue:少し考えて}'], ['pre', '{pre:think}'],
  ['ref', '{ref:相手の言葉}'], ['scene', '{scene:serious}'], ['honne', '{honne:大丈夫です|たぶん}'], ['retype', '{retype:誤|正}'],
];
const STANCE_ORDER = ['care', 'sorry', 'glad', 'warm', 'joke', 'think', 'maybe', 'sure', 'em'];
const PUNCT_PAUSE = {
  '、': 230, '，': 230, ',': 200, '。': 520, '．': 520, '.': 420, '！': 560, '!': 520, '？': 600, '?': 560,
  '…': 340, '」': 160, '』': 160, '）': 160, ')': 140, ' ': 60, '　': 120, ':': 200, '：': 240,
};
const CLOSE_PUNCT = '、。，．！？!?…」』）)］]〕｝}・ーぁぃぅぇぉゃゅょっゎァィゥェォャュョッヮ゛゜';
const OPEN_PUNCT = '「『（(［[〔｛{“‘';
const LATIN = /[A-Za-z0-9_'’\-]/;
const PRE_KINDS = ['quick', 'think', 'deep', 'hesitate'];
const PRE_LABEL = { quick: '', think: '考えています', deep: 'じっくり考えています', hesitate: 'うーん…', plain: '' };
const PRE_TONE = { quick: 'glad', think: 'think', deep: 'sure', hesitate: 'maybe', plain: 'neutral' };
const SCENES = ['serious', 'warm', 'bright'];

/* ---------- 2. マークアップの解析（ストリーミング対応） ---------- */
class StreamParser {
  constructor() { this.stack = []; this.buf = ''; }
  push(text) {
    const s = this.buf + text;
    const atoms = [];
    let i = 0;
    while (i < s.length) {
      const open = s.indexOf('{', i);
      if (open === -1) { this._chars(s.slice(i), atoms); i = s.length; break; }
      this._chars(s.slice(i, open), atoms);
      const close = s.indexOf('}', open + 1);
      if (close === -1) {
        const tail = s.slice(open + 1);
        if (tail.length > 60 || /[\n{]/.test(tail)) { this._chars('{', atoms); i = open + 1; continue; }
        i = open; // 保留（'{' より前の文字はもう出したので、ここから先だけ残す）
        break;
      }
      this._tag(s.slice(open + 1, close).trim(), s.slice(open, close + 1), atoms);
      i = close + 1;
    }
    this.buf = s.slice(i);
    return atoms;
  }
  end() { const atoms = []; this._chars(this.buf, atoms); this.buf = ''; return atoms; }
  _chars(t, atoms) { for (const ch of t) atoms.push({ type: 'char', ch, tags: this.stack.slice() }); }
  _tag(body, literal, atoms) {
    let m;
    const tags = () => this.stack.slice();
    if (body.startsWith('/')) { this.stack.pop(); return; }
    if (body === 'br') { atoms.push({ type: 'br' }); return; }
    if ((m = body.match(/^pause\s*[:=]\s*(\d+)$/))) { atoms.push({ type: 'pause', ms: +m[1] }); return; }
    if ((m = body.match(/^cue\s*[:=]\s*(.*)$/))) { atoms.push({ type: 'cue', text: m[1].trim(), tags: tags() }); return; }
    if ((m = body.match(/^pre\s*[:=]\s*(\w+)$/))) { atoms.push({ type: 'pre', kind: m[1] }); return; }
    if ((m = body.match(/^ref\s*[:=]\s*(.+)$/))) { atoms.push({ type: 'ref', text: m[1].trim() }); return; }
    if ((m = body.match(/^scene\s*[:=]\s*(\w+)$/))) { atoms.push({ type: 'scene', kind: m[1] }); return; }
    if ((m = body.match(/^(?:honne|ruby)\s*[:=]\s*([^|]+)\|(.+)$/))) { atoms.push({ type: 'honne', base: m[1].trim(), rt: m[2].trim(), tags: tags() }); return; }
    if ((m = body.match(/^retype\s*[:=]\s*([^|]+)\|(.+)$/))) { atoms.push({ type: 'retype', wrong: m[1].trim(), right: m[2].trim(), tags: tags() }); return; }
    if (TAGS[body]) { this.stack.push(body); return; }
    this._chars(literal, atoms); // 不明なタグはそのまま文字として出す
  }
}

// 禁則処理と英単語のまとまりを作る（1ユニット = 1つの inline-block）
class Clusterer {
  constructor() { this.hold = null; }
  push(atoms) {
    const out = [];
    for (const a of atoms) {
      if (a.type !== 'char') { this._flush(out); out.push(a); continue; }
      if (this.hold && this._canAbsorb(this.hold, a)) { this.hold.chars.push(a.ch); this.hold.text += a.ch; continue; }
      this._flush(out);
      this.hold = { type: 'unit', chars: [a.ch], text: a.ch, tags: a.tags, key: a.tags.join() };
    }
    return out;
  }
  end() { const out = []; this._flush(out); return out; }
  _flush(out) { if (this.hold) { out.push(this.hold); this.hold = null; } }
  _canAbsorb(u, a) {
    if (a.tags.join() !== u.key) return false;
    if (CLOSE_PUNCT.includes(a.ch)) return true;
    if (u.chars.length === 1 && OPEN_PUNCT.includes(u.chars[0])) return true;
    if (LATIN.test(a.ch) && u.chars.every(c => LATIN.test(c))) return true;
    return false;
  }
}
function charUnits(text, tags) {
  const c = new Clusterer();
  const atoms = Array.from(text, ch => ({ type: 'char', ch, tags }));
  return c.push(atoms).concat(c.end());
}
function parseMarkup(src) { const p = new StreamParser(); return p.push(src).concat(p.end()); }
function stripMarkup(src) {
  return parseMarkup(src).map(a => {
    if (a.type === 'char') return a.ch;
    if (a.type === 'br') return '\n';
    if (a.type === 'cue') return `（${a.text}）`;
    if (a.type === 'honne') return a.base;
    if (a.type === 'retype') return a.right;
    return '';
  }).join('');
}
function toneOf(tags) { return STANCE_ORDER.find(t => tags.includes(t)) || 'neutral'; }
function parsePre(pre) {
  if (!pre) return null;
  if (typeof pre === 'object') return { kind: pre.kind || 'think', ms: +pre.ms || 0 };
  const [kind, ms] = String(pre).split(/\s+/);
  return { kind: kind || 'think', ms: +ms || 1200 };
}

/* ---------- 3. DOM 構築とタイミング表（逐次） ---------- */
class TextBuilder {
  constructor(textEl, { expressive, basePace, amp }) {
    this.textEl = textEl; this.expressive = expressive; this.basePace = basePace; this.amp = amp;
    this.pendingPause = 0; this.run = null; this.runKey = null; this.runCount = 0; this.lastStep = null;
  }
  push(units) {
    const steps = [];
    const ex = this.expressive;
    for (const u of units) {
      if (u.type === 'br') { this._flushRun(); this.textEl.appendChild(document.createElement('br')); continue; }
      if (u.type === 'pause') { if (ex) this.pendingPause += u.ms * this.amp; continue; }
      if (u.type === 'pre') continue;
      if (u.type === 'ref') { if (ex) steps.push({ ref: u.text, delay: 0 }); continue; }
      if (u.type === 'scene') { if (ex) steps.push({ scene: u.kind, delay: 0 }); continue; }
      if (u.type === 'cue') {
        if (!ex) continue;
        this._flushRun();
        const el = document.createElement('span');
        el.className = 'cue pending';
        el.textContent = `（${u.text}）`;
        this.textEl.appendChild(el);
        const step = { el, delay: this.pendingPause + 300, tone: 'think' };
        steps.push(step); this.lastStep = step;
        this.pendingPause = 550 * this.amp;
        continue;
      }
      if (u.type === 'honne') {
        if (!ex) { steps.push(...this.push(charUnits(u.base, []))); continue; }
        this._flushRun();
        const el = document.createElement('ruby');
        el.className = 'honne pending';
        el.textContent = u.base;
        const rt = document.createElement('rt');
        rt.textContent = u.rt;
        el.appendChild(rt);
        this.textEl.appendChild(el);
        const step = { el, delay: this.pendingPause + this.basePace * Math.min(u.base.length, 8) * 1.1, tone: toneOf(u.tags),
          after: () => setTimeout(() => el.classList.add('show-rt'), 650) };
        steps.push(step); this.lastStep = step;
        this.pendingPause = 500 * this.amp;
        continue;
      }
      if (u.type === 'retype') {
        if (!ex) { steps.push(...this.push(charUnits(u.right, []))); continue; }
        const wrong = this.push(charUnits(u.wrong, u.tags));
        steps.push(...wrong);
        this._flushRun();
        wrong.filter(s => s.el).map(s => s.el).reverse().forEach((el, i) => steps.push({ remove: el, delay: i === 0 ? 480 : 80 }));
        this.pendingPause = 320;
        steps.push(...this.push(charUnits(u.right, u.tags)));
        continue;
      }
      // 通常の文字ユニット
      const tags = ex ? u.tags : [];
      const key = tags.join(' ');
      if (!this.run || key !== this.runKey) {
        this._flushRun();
        this.run = document.createElement('span');
        this.run.className = 'run' + tags.map(t => ' t-' + t).join('');
        this.runKey = key; this.runCount = 0;
        this.textEl.appendChild(this.run);
      }
      const ch = document.createElement('span');
      ch.className = 'ch pending';
      ch.textContent = u.text;
      ch.style.setProperty('--i', this.runCount++);
      this.run.style.setProperty('--n', this.runCount);
      this.run.appendChild(ch);

      let pace = this.basePace, jitter = 0;
      if (ex) {
        for (const t of tags) { pace *= 1 + (TAGS[t].pace - 1) * this.amp; jitter = Math.max(jitter, (TAGS[t].jitter || 0) * this.amp); }
        if (jitter) {
          pace *= 1 + (Math.random() * 2 - 1) * jitter;
          if (Math.random() < 0.07 * this.amp) pace += 200 + Math.random() * 350; // ときどき詰まる
        }
      }
      const n = u.chars.length;
      if (n > 1) pace *= Math.min(0.55 + 0.45 * n, 3.2);
      const step = { el: ch, delay: this.pendingPause + pace, tone: toneOf(tags), tags, text: u.text };
      this.pendingPause = ex ? Math.max(...u.chars.map(c => PUNCT_PAUSE[c] || 0)) * (0.4 + 0.6 * this.amp) : 0;
      steps.push(step); this.lastStep = step;
    }
    return steps;
  }
  end() { this._flushRun(); }
  _flushRun() {
    if (this.run && this.run.classList.contains('t-strike') && this.lastStep && this.lastStep.el) {
      const r = this.run, st = this.lastStep;
      const fire = () => setTimeout(() => r.classList.add('struck'), 260);
      if (st.el.classList.contains('on')) fire(); else st.after = fire;
    }
    this.run = null; this.runKey = null; this.runCount = 0;
  }
}

/* ---------- 4. 再生制御 ---------- */
const ctl = {
  pending: new Set(),
  sleep(ms) {
    return new Promise(res => {
      const entry = { res };
      entry.t = setTimeout(() => { this.pending.delete(entry); res(); }, ms);
      this.pending.add(entry);
    });
  },
  idle(register) {
    return new Promise(res => {
      const entry = { res };
      this.pending.add(entry);
      register(() => { this.pending.delete(entry); res(); });
    });
  },
  wakeAll() { for (const e of this.pending) { if (e.t) clearTimeout(e.t); e.res(); } this.pending.clear(); },
};

const state = {
  session: 0, scenario: null, nextIndex: 0,
  expressive: true, basePace: 55, amp: 1, auto: true, showSrc: false,
  showTyping: true, sendTyping: true,
  live: false, apiKey: '', model: 'gpt-5.6-luna', modelCustom: false, systemPrompt: DEFAULT_SYSTEM_PROMPT,
  proxy: false, needsToken: false, token: '', history: [], liveAbort: null, log: [], sceneMsg: null,
};
let chain = Promise.resolve();
function enqueue(job) {
  const s = state.session;
  chain = chain.then(() => (s === state.session ? job() : undefined)).catch(err => console.error(err));
  return chain;
}

// source: マークアップ文字列 か、文字列チャンクの async iterable
async function revealInto(msgEl, source, { instant = false, container = null } = {}) {
  const session = state.session;
  const expressive = state.expressive;
  const isMessage = msgEl.classList.contains('msg');
  const textEl = document.createElement('div');
  textEl.className = 'text';
  const old = $('.text', msgEl);
  if (old) old.replaceWith(textEl); else (container || msgEl).appendChild(textEl);
  const avatar = $('.avatar', msgEl);

  const parser = new StreamParser(), clusterer = new Clusterer();
  const builder = new TextBuilder(textEl, { expressive, basePace: expressive ? state.basePace : 24, amp: state.amp });
  const queue = [];
  let done = false, waiter = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };
  const feed = (chunk) => { queue.push(...builder.push(clusterer.push(parser.push(chunk)))); wake(); };
  const finish = () => {
    queue.push(...builder.push(clusterer.push(parser.end())));
    queue.push(...builder.push(clusterer.end()));
    builder.end(); done = true; wake();
  };
  if (typeof source === 'string') { feed(source); finish(); }
  else (async () => {
    try { for await (const c of source) { if (session !== state.session) break; feed(c); } }
    catch (err) { console.error(err); }
    finally { finish(); }
  })();

  let skip = instant, lastUnit = null;
  const onClick = () => { skip = true; ctl.wakeAll(); };
  msgEl.classList.add('revealing');
  msgEl.classList.toggle('instant', instant);
  msgEl.addEventListener('click', onClick);
  if (avatar) avatar.dataset.gaze = 'talk';
  try {
    for (;;) {
      if (!queue.length) {
        if (done) break;
        await ctl.idle(r => { waiter = r; });
        if (session !== state.session) return;
        continue;
      }
      const s = queue.shift();
      if (!skip && s.delay > 0) await ctl.sleep(s.delay);
      if (session !== state.session) return;
      if (s.remove) {
        const run = s.remove.parentElement;
        s.remove.remove();
        if (run && run.classList.contains('run') && !run.childElementCount) run.remove();
        continue;
      }
      if (s.ref) { if (isMessage && !skip) { highlightRef(s.ref); glance(avatar, 'user', 1000); } continue; }
      if (s.scene) { if (isMessage) setScene(s.scene, msgEl); continue; }
      if (skip) msgEl.classList.add('instant');
      s.el.classList.remove('pending');
      s.el.classList.add('on');
      if (avatar) avatar.dataset.tone = s.tone;
      if (s.after) s.after();
      if (s.tags) lastUnit = s;
      if (!skip) scrollToBottom();
    }
  } finally {
    msgEl.classList.remove('revealing');
    msgEl.removeEventListener('click', onClick);
    if (avatar) { avatar.dataset.tone = 'neutral'; avatar.dataset.gaze = 'talk'; }
    if (isMessage && session === state.session) {
      const asked = lastUnit && (/[？?]$/.test(lastUnit.text) || lastUnit.tags.includes('rise'));
      if (asked && !instant) signalYourTurn(avatar);
      if (state.sceneMsg === msgEl) setTimeout(() => clearScene(msgEl), 2600);
    }
    scrollToBottom();
  }
}

/* ---------- 5. アバター（まるい顔）と視線 ---------- */
const FACE_SVG = '<svg viewBox="0 0 32 32" aria-hidden="true">'
  + '<path class="ahoge" d="M16.5 2.2 Q16.6 -1.6 19.6 -2.4"/>'
  + '<circle class="face" cx="16" cy="16" r="14.5"/><circle class="shade" cx="16" cy="16" r="14.5"/>'
  + '<g class="features">'
  + '<g class="cheeks"><circle cx="8.6" cy="18.6" r="2.3"/><circle cx="23.4" cy="18.6" r="2.3"/></g>'
  + '<path class="brow l" d="M9.8 10.2 Q11.6 9.3 13.6 10"/><path class="brow r" d="M18.4 10 Q20.4 9.3 22.2 10.2"/>'
  + '<g class="eyes">'
  + '<g class="blink l"><g class="eyeT l"><g class="persp l"><ellipse class="eye l" cx="11.6" cy="14.2" rx="1.75" ry="2.35"/><circle class="shine" cx="12.25" cy="13.2" r=".6"/></g></g></g>'
  + '<g class="blink r"><g class="eyeT r"><g class="persp r"><ellipse class="eye r" cx="20.4" cy="14.2" rx="1.75" ry="2.35"/><circle class="shine" cx="21.05" cy="13.2" r=".6"/></g></g></g>'
  + '</g>'
  + '<path class="mouth" d="M12.5 20.5 Q16 22.6 19.5 20.5"/>'
  + '</g></svg>';
// 顔の陰影（球っぽさ）用のグラデーション。ページに1つだけ置く
const FACE_DEFS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'
  + '<radialGradient id="cwi-shade" cx="38%" cy="30%" r="78%">'
  + '<stop offset="0" stop-color="#fff" stop-opacity=".5"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".16"/>'
  + '</radialGradient></defs></svg>';
function createAvatar(extra = '') {
  const d = document.createElement('div');
  d.className = ('avatar ' + extra).trim();
  d.dataset.tone = 'neutral'; d.dataset.gaze = 'talk';
  d.innerHTML = FACE_SVG;
  return d;
}
function activeAvatar() {
  return $('.msg.revealing .avatar') || $('.msg.indicator .avatar')
    || (!emptyEl.hidden ? $('#hero-avatar') : null) || $$('.msg.ai .avatar').at(-1) || $('#hero-avatar');
}
let gazeTimer = null;
function setGaze(g, ms) {
  const a = activeAvatar(); if (!a) return;
  a.dataset.gaze = g;
  if (gazeTimer) clearTimeout(gazeTimer);
  if (ms) gazeTimer = setTimeout(() => { if (a.dataset.gaze === g) a.dataset.gaze = 'talk'; }, ms);
}
function glance(avatar, g, ms) {
  if (!avatar) return;
  const prev = avatar.dataset.gaze || 'talk';
  avatar.dataset.gaze = g;
  setTimeout(() => { if (avatar.dataset.gaze === g) avatar.dataset.gaze = prev; }, ms);
}
// 誰も話していないとき、ヒーローの顔がときどきよそ見をする
setInterval(() => {
  const h = $('#hero-avatar');
  if (!h || emptyEl.hidden || typing.active || h.dataset.gaze !== 'talk') return;
  if (Math.random() < 0.5) glance(h, ['user', 'away', 'down', 'front', 'front'][Math.floor(Math.random() * 5)], 700 + Math.random() * 700);
}, 3200);

/* ---------- 6. 相手の言葉への照応・部屋の照明・ターン交替 ---------- */
function highlightRef(text) {
  const b = $$('.msg.user .bubble').at(-1);
  if (!b || !text) return;
  const t = b.textContent;
  const i = t.indexOf(text);
  if (i < 0) return;
  b.innerHTML = escapeHtml(t.slice(0, i)) + '<mark class="ref">' + escapeHtml(text) + '</mark>' + escapeHtml(t.slice(i + text.length));
  setTimeout(() => { if (b.textContent === t) b.textContent = t; }, 4500);
}
let spotTimer = null;
function updateSpot() {
  const m = state.sceneMsg; if (!m) return;
  const t = $('.text', m) || m;
  const r = t.getBoundingClientRect();
  const last = $$('.ch.on, ruby.honne.on, .cue.on', t).at(-1);
  const lr = last ? last.getBoundingClientRect() : r;
  const x = r.left + Math.min(r.width, 520) / 2;
  const y = lr.top + lr.height / 2;
  document.body.style.setProperty('--spot-x', Math.round(x) + 'px');
  document.body.style.setProperty('--spot-y', Math.round(y) + 'px');
}
function setScene(kind, msgEl) {
  if (!SCENES.includes(kind)) return;
  $$('.msg.lit').forEach(m => m.classList.remove('lit'));
  msgEl.classList.add('lit');
  state.sceneMsg = msgEl;
  updateSpot();
  document.body.dataset.scene = kind;
  if (spotTimer) clearInterval(spotTimer);
  spotTimer = setInterval(updateSpot, 120);
}
function clearScene(msgEl) {
  if (msgEl && state.sceneMsg !== msgEl) return;
  delete document.body.dataset.scene;
  if (spotTimer) { clearInterval(spotTimer); spotTimer = null; }
  const lit = $$('.msg.lit');
  state.sceneMsg = null;
  setTimeout(() => lit.forEach(m => m.classList.remove('lit')), 2200); // 光が戻りきってから重ね順を戻す
}
let turnTimer = null;
function signalYourTurn(avatar) {
  const box = $('.inputbox');
  box.classList.remove('your-turn');
  void box.offsetWidth; // アニメーションを再始動
  box.classList.add('your-turn');
  const ph = inputEl.placeholder;
  inputEl.placeholder = 'どうぞ';
  if (avatar) { avatar.dataset.ask = '1'; avatar.dataset.gaze = 'front'; }
  if (turnTimer) clearTimeout(turnTimer);
  turnTimer = setTimeout(() => { box.classList.remove('your-turn'); if (inputEl.placeholder === 'どうぞ') inputEl.placeholder = ph; if (avatar) { delete avatar.dataset.ask; if (avatar.dataset.gaze === 'front') avatar.dataset.gaze = 'talk'; } }, 4200);
}

/* ---------- 7. チャット UI ---------- */
const threadEl = $('#thread'), messagesEl = $('#messages'), emptyEl = $('#empty');
threadEl.addEventListener('scroll', () => { if (state.sceneMsg) updateSpot(); }, { passive: true });
const inputEl = $('#input'), formEl = $('#form'), chipsEl = $('#chips');

function scrollToBottom(force) {
  const near = threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 240;
  if (force || near) threadEl.scrollTop = threadEl.scrollHeight;
}
function hideEmpty() { emptyEl.hidden = true; }

function addUserMessage(text, kind, caption) {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'msg user';
  const body = document.createElement('div');
  body.className = 'body';
  const b = document.createElement('div');
  b.className = 'bubble' + (kind ? ' ' + kind : '');
  b.textContent = text;
  body.appendChild(b);
  if (caption) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = caption; body.appendChild(m); }
  el.appendChild(body);
  messagesEl.appendChild(el);
  scrollToBottom(true);
}

function createAiMessage(raw) {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.appendChild(createAvatar());
  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = '<div class="text"></div><pre class="src"></pre><div class="actions"><button class="ghost tiny act-replay" title="もう一度再生">↺ 再生</button></div>';
  el.appendChild(body);
  setAiRaw(el, raw);
  $('.act-replay', el).addEventListener('click', (e) => {
    e.stopPropagation();
    enqueue(() => revealInto(el, el._raw || ''));
  });
  messagesEl.appendChild(el);
  return el;
}
function setAiRaw(el, raw) { el._raw = raw; $('.src', el).textContent = raw; }

function showIndicator(kind) {
  const el = document.createElement('div');
  el.className = 'msg ai indicator';
  el.appendChild(createAvatar());
  const body = document.createElement('div');
  body.className = 'body';
  body.innerHTML = '<div class="dots"><i></i><i></i><i></i></div><span class="ind-label"></span>';
  el.appendChild(body);
  setIndicatorKind(el, kind);
  hideEmpty();
  messagesEl.appendChild(el);
  scrollToBottom(true);
  return el;
}
function setIndicatorKind(el, kind) {
  if (!PRE_KINDS.includes(kind) && kind !== 'plain') kind = 'think';
  $('.dots', el).className = `dots k-${kind}`;
  $('.ind-label', el).textContent = PRE_LABEL[kind] || '';
  const av = $('.avatar', el);
  av.dataset.tone = PRE_TONE[kind] || 'neutral';
  av.dataset.gaze = (kind === 'quick' || kind === 'plain') ? 'talk' : 'away';
  document.body.classList.toggle('deep-think', kind === 'deep');
}
function removeIndicator(el) { el.remove(); document.body.classList.remove('deep-think'); }

async function playAiMessage(reply) {
  const session = state.session;
  const pre = parsePre(reply.pre);
  if (pre && pre.ms > 0) {
    const ind = showIndicator(state.expressive ? pre.kind : 'plain');
    await ctl.sleep(state.expressive ? pre.ms : Math.min(pre.ms, 800));
    removeIndicator(ind);
    if (session !== state.session) return;
  }
  const el = createAiMessage(reply.text);
  await revealInto(el, reply.text);
}

/* ---------- 8. 打鍵のリズム（ユーザー側の非言語情報） ---------- */
const typing = { active: false, t0: 0, last: 0, deletes: 0, pauses: 0, maxGap: 0, len: 0 };
function trackTyping() {
  const now = performance.now();
  const len = inputEl.value.length;
  if (!typing.active) { Object.assign(typing, { active: true, t0: now, last: now, deletes: 0, pauses: 0, maxGap: 0 }); }
  else {
    const gap = now - typing.last;
    if (gap > 1500) typing.pauses++;
    typing.maxGap = Math.max(typing.maxGap, gap);
    typing.last = now;
  }
  if (len < typing.len) typing.deletes++;
  typing.len = len;
  if (len === 0) typing.active = false;
}
function takeTyping(text) {
  const d = typing.active && text.length ? { duration: performance.now() - typing.t0, deletes: typing.deletes, pauses: typing.pauses, maxGap: typing.maxGap, chars: text.length } : null;
  typing.active = false; typing.len = 0;
  return d;
}
function classifyTyping(d) {
  if (!d) return null;
  const perChar = d.duration / Math.max(d.chars, 1);
  if (d.deletes >= 3 || d.maxGap >= 3000 || perChar > 700) return 'hesitant';
  if (d.duration < 3500 && d.deletes <= 1) return 'quick';
  return 'deliberate';
}
const TYPING_LABEL = { hesitant: '迷いながら', quick: 'すぐに', deliberate: '考えながら' };
function describeTyping(d, kind) {
  const parts = [`約${Math.max(1, Math.round(d.duration / 1000))}秒`];
  if (d.deletes) parts.push(`消し${d.deletes}回`);
  if (d.pauses) parts.push(`長い間${d.pauses}回`);
  return `${TYPING_LABEL[kind]}（${parts.join('・')}）`;
}

/* ---------- 9. Live モード（OpenAI） ---------- */
async function* openaiStream(messages, signal) {
  const url = state.proxy ? '/api/chat' : 'https://api.openai.com/v1/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (!state.proxy) headers.Authorization = `Bearer ${state.apiKey}`;
  else if (state.token) headers['x-cwi-token'] = state.token;
  const res = await fetch(url, { method: 'POST', signal, headers, body: JSON.stringify({ model: state.model, messages, stream: true }) });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch (_) { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const j = JSON.parse(data);
        const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (t) yield t;
      } catch (_) { /* 不完全な行は無視 */ }
    }
  }
}
const escapeMarkup = (s) => String(s).replace(/\{/g, '｛').replace(/\}/g, '｝');

async function playLiveReply(content) {
  const session = state.session;
  if (!state.proxy && !state.apiKey) {
    const el = createAiMessage('');
    const raw = '{sorry}API キーがまだ入っていません。{/}{pause:400}{br}{small}node local/server.mjs で開くか、Wizard パネル（Ctrl+.）の「Live（OpenAI）」にキーを入れてください。{/}';
    setAiRaw(el, raw);
    await revealInto(el, raw);
    return;
  }
  if (state.proxy && state.needsToken && !state.token) {
    const el = createAiMessage('');
    const raw = '{sorry}アクセス用パスワードが必要です。{/}{pause:400}{br}{small}Wizard パネル（Ctrl+.）の「Live（OpenAI）」に入れてください。{/}';
    setAiRaw(el, raw);
    await revealInto(el, raw);
    return;
  }
  state.history.push({ role: 'user', content });
  const messages = [{ role: 'system', content: state.systemPrompt }, ...state.history.slice(-24)];
  const ind = showIndicator('think');
  const ac = new AbortController();
  state.liveAbort = ac;
  const t0 = performance.now();
  setLiveStatus('接続中…');
  try {
    const it = openaiStream(messages, ac.signal)[Symbol.asyncIterator]();
    let head = '', r = await it.next();
    while (!r.done) {
      head += r.value;
      if (!head.trimStart().startsWith('{') || head.includes('}') || head.length > 24) break;
      r = await it.next();
    }
    if (session !== state.session) return;
    const m = head.match(/^\s*\{pre\s*[:=]\s*(\w+)\}/);
    if (m) {
      head = head.slice(m[0].length);
      if (state.expressive) { setIndicatorKind(ind, m[1]); await ctl.sleep(m[1] === 'quick' ? 250 : 900); }
      if (session !== state.session) return;
    }
    removeIndicator(ind);
    setLiveStatus(`最初の応答まで ${Math.round(performance.now() - t0)} ms（${state.model}）`);
    const el = createAiMessage('');
    let raw = m ? m[0] : '';
    const chunks = (async function* () {
      if (head) { raw += head; setAiRaw(el, raw); yield head; }
      if (r.done) return;
      for (;;) {
        const n = await it.next();
        if (n.done) return;
        raw += n.value; setAiRaw(el, raw);
        yield n.value;
      }
    })();
    await revealInto(el, chunks);
    if (session === state.session) state.history.push({ role: 'assistant', content: raw });
  } catch (err) {
    removeIndicator(ind);
    if (session !== state.session || err.name === 'AbortError') return;
    setLiveStatus(`エラー: ${err.message}`);
    const el = createAiMessage('');
    const raw = `{sorry}接続できませんでした。{/}{pause:400}{br}{small}${escapeMarkup(err.message)}{/}`;
    setAiRaw(el, raw);
    await revealInto(el, raw);
  } finally {
    if (state.liveAbort === ac) state.liveAbort = null;
  }
}
function setLiveStatus(t) { const el = $('#wz-live-status'); if (el) el.textContent = t; }

/* ---------- 10. 会話の進行 ---------- */
function respondNext() {
  const sc = state.scenario;
  if (!sc) return;
  let reply;
  if (state.nextIndex < sc.replies.length) { reply = sc.replies[state.nextIndex]; state.nextIndex++; }
  else reply = sc.fallback;
  renderChips(); renderScript(); broadcastState();
  if (reply) enqueue(() => playAiMessage(reply));
}

function onUserSend(text) {
  text = text.trim();
  if (!text) return;
  const d = takeTyping(text);
  const kind = classifyTyping(d);
  const caption = d ? describeTyping(d, kind) : '';
  addUserMessage(text, kind, caption);
  setGaze('user', 900); // 相手の言葉を読む
  state.log.push(caption ? `${text}　${caption}` : text);
  renderLog();
  post({ type: 'user', text: caption ? `${text}　${caption}` : text });
  if (state.live) {
    const content = (state.sendTyping && d) ? `${text}\n[入力の様子: ${describeTyping(d, kind)}]` : text;
    enqueue(() => playLiveReply(content));
    renderChips();
    return;
  }
  if (state.auto) respondNext();
  else broadcastState();
}

function resetChat() {
  state.session++;
  ctl.wakeAll();
  if (state.liveAbort) { state.liveAbort.abort(); state.liveAbort = null; }
  messagesEl.innerHTML = '';
  clearScene();
  document.body.classList.remove('deep-think');
  state.nextIndex = 0;
  state.history = [];
  state.log = [];
  renderLog();
}

function loadScenario(id) {
  const sc = SCENARIOS.find(s => s.id === id) || null;
  resetChat();
  state.scenario = sc;
  if (sc) state.live = false;
  emptyEl.hidden = !!sc;
  renderSidebar(); renderChips(); renderScript(); syncControls(); broadcastState();
  if (sc && sc.opening) enqueue(() => playAiMessage(sc.opening));
  document.body.classList.remove('sidebar-open');
  inputEl.focus();
}

function setLive(on) {
  if (on === state.live) return;
  resetChat();
  state.live = on;
  if (on) state.scenario = null;
  emptyEl.hidden = false;
  renderSidebar(); renderChips(); renderScript(); syncControls(); broadcastState();
  saveLocal();
}

/* ---------- 11. 描画: サイドバー / チップ / Wizard ---------- */
function renderSidebar() {
  const list = $('#scenario-list');
  list.innerHTML = '';
  for (const sc of SCENARIOS) {
    const b = document.createElement('button');
    b.className = state.scenario && state.scenario.id === sc.id ? 'active' : '';
    b.innerHTML = `<span class="ico">${sc.icon}</span><span><span class="t">${sc.title}</span><span class="d">${sc.desc}</span></span>`;
    b.addEventListener('click', () => act('scenario', { id: sc.id }));
    list.appendChild(b);
  }
  const cards = $('#scenario-cards');
  cards.innerHTML = '';
  for (const sc of SCENARIOS) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="ico">${sc.icon}</span><span class="t">${sc.title}</span><span class="d">${sc.desc}</span>`;
    b.addEventListener('click', () => act('scenario', { id: sc.id }));
    cards.appendChild(b);
  }
  const sel = $('#wz-scenario');
  sel.innerHTML = '<option value="">（未選択）</option>' + SCENARIOS.map(sc => `<option value="${sc.id}">${sc.icon} ${sc.title}</option>`).join('');
  sel.value = state.scenario ? state.scenario.id : '';
}

function renderChips() {
  chipsEl.innerHTML = '';
  const addChip = (text) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', () => { inputEl.value = text; autosize(); inputEl.focus(); });
    chipsEl.appendChild(b);
  };
  const addLabel = (t) => { const s = document.createElement('span'); s.className = 'lbl'; s.textContent = t; chipsEl.appendChild(s); };
  if (state.live) {
    if (state.history.length) return;
    addLabel('たとえば:');
    for (const sc of SCENARIOS.slice(1)) if (sc.replies[0] && sc.replies[0].prompt) addChip(sc.replies[0].prompt);
    return;
  }
  const sc = state.scenario;
  if (!sc) return;
  const next = sc.replies[state.nextIndex];
  if (!next || !next.prompt) return;
  addLabel('台本の想定発話:');
  addChip(next.prompt);
}

function renderScript() {
  const ol = $('#wz-script');
  ol.innerHTML = '';
  const sc = state.scenario;
  $('#wz-scenario').value = sc ? sc.id : '';
  if (!sc) { ol.innerHTML = `<li class="muted" style="font-size:12.5px">${state.live ? 'Live モード中（台本は使いません）' : 'シナリオを選んでください'}</li>`; return; }
  const rows = sc.replies.map((r, i) => ({ r, i }));
  if (sc.fallback) rows.push({ r: sc.fallback, i: -1 });
  for (const { r, i } of rows) {
    const li = document.createElement('li');
    const isNext = i === state.nextIndex || (i === -1 && state.nextIndex >= sc.replies.length);
    li.className = (isNext ? 'next ' : '') + (i !== -1 && i < state.nextIndex ? 'done' : '');
    li.innerHTML = `<div class="wz-idx">${i === -1 ? 'FB' : i + 1}</div>`
      + `<div class="wz-txt">${r.prompt ? `<div class="wz-prompt">👤 ${escapeHtml(r.prompt)}</div>` : ''}`
      + `<div class="wz-prev">${escapeHtml(stripMarkup(r.text))}</div></div>`
      + '<button class="ghost tiny">送信</button>';
    $('button', li).addEventListener('click', () => act('playIndex', { i }));
    ol.appendChild(li);
  }
}

function renderLog() {
  const ul = $('#wz-log');
  ul.innerHTML = state.log.map(t => `<li>${escapeHtml(t)}</li>`).join('');
  ul.scrollTop = ul.scrollHeight;
}

function syncControls() {
  $('#toggle-cwi').checked = state.expressive;
  $('#wz-cwi').checked = state.expressive;
  $('#wz-auto').checked = state.auto;
  $('#wz-src').checked = state.showSrc;
  $('#wz-pace').value = state.basePace;
  $('#wz-pace-out').value = state.basePace;
  $('#wz-amp').value = Math.round(state.amp * 100);
  $('#wz-amp-out').value = Math.round(state.amp * 100);
  $('#wz-show-typing').checked = state.showTyping;
  $('#wz-send-typing').checked = state.sendTyping;
  $('#toggle-live').checked = state.live;
  $('#wz-live').checked = state.live;
  $('#wz-key').value = state.apiKey;
  $('#wz-model').value = state.model;
  if ($('#wz-prompt').value !== state.systemPrompt) $('#wz-prompt').value = state.systemPrompt;
  document.documentElement.style.setProperty('--amp', state.amp);
  const badge = $('#mode-badge');
  badge.textContent = state.expressive ? '表現 ON' : '表現 OFF';
  badge.classList.toggle('on', state.expressive);
  const live = $('#live-badge');
  live.textContent = state.live ? `Live · ${state.model}` : 'WoZ 台本';
  live.classList.toggle('live', state.live);
  document.body.classList.toggle('show-src', state.showSrc);
  document.body.classList.toggle('show-typing', state.showTyping);
  document.body.classList.toggle('live', state.live);
  document.body.classList.toggle('proxy', state.proxy);
  document.body.classList.toggle('needs-token', state.proxy && state.needsToken);
  $('#wz-token').value = state.token;
  $('#wz-key-note').textContent = state.proxy ? 'キー: サーバーの .env から読み込み済み（ブラウザには渡しません）' : 'キー: ブラウザから直接接続（localStorage に保存）';
  $('#scenario-name').textContent = state.live ? 'Live（OpenAI）' : state.scenario ? `${state.scenario.icon} ${state.scenario.title}` : 'シナリオ未選択';
  $('#empty-lead').textContent = state.live
    ? `Live モード：${state.model} が装飾ルールを読んで、台本なしで答えます。`
    : 'シナリオを選ぶと、台本どおりに返事が来ます。';
  $('#scenario-cards').hidden = state.live;
  $('#hint').textContent = state.live
    ? 'Live モード：OpenAI API に接続しています。返答のマークアップはモデルが生成しています。'
    : 'WoZ モード：AI は推論していません。返答はあらかじめ用意された台本です。';
  inputEl.placeholder = state.live ? 'メッセージを入力' : 'メッセージを入力（返事は台本から出ます）';
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/* ---------- 12. 設定の保存 ---------- */
function saveLocal() {
  try {
    localStorage.setItem('cwi.settings', JSON.stringify({
      apiKey: state.apiKey, token: state.token, model: state.modelCustom ? state.model : undefined, systemPrompt: state.systemPrompt,
      live: state.live, basePace: state.basePace, amp: state.amp, expressive: state.expressive,
      showTyping: state.showTyping, sendTyping: state.sendTyping,
    }));
  } catch (_) { /* 保存できない環境では無視 */ }
}
function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem('cwi.settings') || '{}');
    if (typeof s.apiKey === 'string') state.apiKey = s.apiKey;
    if (typeof s.token === 'string') state.token = s.token;
    if (s.model) { state.model = s.model; state.modelCustom = true; }
    if (typeof s.systemPrompt === 'string' && s.systemPrompt.trim()) state.systemPrompt = s.systemPrompt;
    if (typeof s.basePace === 'number') state.basePace = s.basePace;
    if (typeof s.amp === 'number') state.amp = Math.min(1, Math.max(0, s.amp));
    for (const k of ['expressive', 'live', 'showTyping', 'sendTyping']) if (typeof s[k] === 'boolean') state[k] = s[k];
  } catch (_) { /* ignore */ }
}

/* ---------- 13. Wizard の操作（ローカル or 別ウィンドウ） ---------- */
const role = new URLSearchParams(location.search).has('wizard') ? 'wizard' : 'participant';
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('cwi-woz') : null;
function post(msg) { if (bc) bc.postMessage(msg); }

const actions = {
  scenario({ id }) { loadScenario(id); },
  next() { respondNext(); },
  playIndex({ i }) {
    const sc = state.scenario; if (!sc) return;
    if (i === -1) { enqueue(() => playAiMessage(sc.fallback)); return; }
    state.nextIndex = i + 1;
    renderChips(); renderScript(); broadcastState();
    enqueue(() => playAiMessage(sc.replies[i]));
  },
  play({ reply }) { enqueue(() => playAiMessage(reply)); },
  reset() {
    resetChat();
    emptyEl.hidden = !!state.scenario && !state.live;
    renderChips(); renderScript(); broadcastState();
    if (!state.live && state.scenario && state.scenario.opening) enqueue(() => playAiMessage(state.scenario.opening));
  },
  settings({ patch }) { Object.assign(state, patch); syncControls(); broadcastState(); saveLocal(); },
  live({ on }) { setLive(!!on); },
};
function act(name, payload = {}) {
  if (role === 'wizard') post({ type: 'cmd', cmd: name, payload });
  else actions[name](payload);
}
function broadcastState() {
  if (role !== 'participant') return;
  post({ type: 'state', scenarioId: state.scenario ? state.scenario.id : null, nextIndex: state.nextIndex,
    expressive: state.expressive, basePace: state.basePace, amp: state.amp, auto: state.auto, showSrc: state.showSrc,
    showTyping: state.showTyping, sendTyping: state.sendTyping, live: state.live, model: state.model, log: state.log });
}
if (bc) {
  bc.onmessage = (ev) => {
    const m = ev.data || {};
    if (role === 'participant') {
      if (m.type === 'cmd' && actions[m.cmd]) actions[m.cmd](m.payload || {});
      if (m.type === 'hello') broadcastState();
    } else {
      if (m.type === 'state') {
        state.scenario = SCENARIOS.find(s => s.id === m.scenarioId) || null;
        for (const k of ['nextIndex', 'expressive', 'basePace', 'amp', 'auto', 'showSrc', 'showTyping', 'sendTyping', 'live']) if (k in m) state[k] = m[k];
        state.model = m.model || state.model;
        state.log = m.log || [];
        syncControls(); renderScript(); renderLog();
        $('#wz-status').textContent = '参加者ウィンドウ: 接続中';
      }
      if (m.type === 'user') { state.log.push(m.text); renderLog(); }
    }
  };
}

/* ---------- 14. 凡例 ---------- */
function renderLegend() {
  const box = $('#legend-rows');
  box.innerHTML = '';
  for (const [name, label, sample] of LEGEND) {
    const row = document.createElement('div');
    if (name === '#') { row.className = 'legend-row group'; row.textContent = label; box.appendChild(row); continue; }
    row.className = 'legend-row';
    row.innerHTML = `<div class="lg-name">${escapeHtml(label)}<code>{${escapeHtml(name)}}</code></div><div class="sample"></div>`;
    const holder = $('.sample', row);
    const play = (instant) => {
      const prev = state.expressive; state.expressive = true;
      revealInto(holder, sample, { instant });
      state.expressive = prev;
    };
    play(true);
    row.addEventListener('click', () => play(false));
    box.appendChild(row);
  }
}

/* ---------- 15. イベント配線 ---------- */
function autosize() { inputEl.style.height = 'auto'; inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + 'px'; }
let typingIdle = null;
inputEl.addEventListener('input', () => {
  autosize();
  trackTyping();
  setGaze('input');
  const a = activeAvatar(); if (a) { delete a.dataset.ask; }
  if (typingIdle) clearTimeout(typingIdle);
  typingIdle = setTimeout(() => setGaze('talk'), 1400);
});
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); formEl.requestSubmit(); }
});
formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = inputEl.value;
  inputEl.value = ''; autosize();
  if (!state.live && !state.scenario) loadScenario(SCENARIOS[0].id);
  onUserSend(text);
});
$('#btn-new').addEventListener('click', () => (state.live ? act('reset') : act('scenario', { id: null })));
$('#btn-menu').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
$('#toggle-cwi').addEventListener('change', (e) => act('settings', { patch: { expressive: e.target.checked } }));
$('#toggle-live').addEventListener('change', (e) => act('live', { on: e.target.checked }));
$('#mode-badge').addEventListener('click', () => act('settings', { patch: { expressive: !state.expressive } }));
$('#live-badge').addEventListener('click', () => act('live', { on: !state.live }));
$('#btn-legend').addEventListener('click', openLegend);
$('#wz-legend').addEventListener('click', openLegend);
$('#legend-close').addEventListener('click', () => { $('#legend').hidden = true; });
$('#legend').addEventListener('click', (e) => { if (e.target === $('#legend')) $('#legend').hidden = true; });
function openLegend() { renderLegend(); $('#legend').hidden = false; }

const toggleWizard = (open) => document.body.classList.toggle('wizard-open', open);
$('#btn-wizard').addEventListener('click', () => toggleWizard());
$('#wz-close').addEventListener('click', () => toggleWizard(false));
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === '.') { e.preventDefault(); toggleWizard(); }
  if (e.key === 'Escape') { $('#legend').hidden = true; }
});

$('#wz-auto').addEventListener('change', (e) => act('settings', { patch: { auto: e.target.checked } }));
$('#wz-cwi').addEventListener('change', (e) => act('settings', { patch: { expressive: e.target.checked } }));
$('#wz-src').addEventListener('change', (e) => act('settings', { patch: { showSrc: e.target.checked } }));
$('#wz-pace').addEventListener('input', (e) => { $('#wz-pace-out').value = e.target.value; });
$('#wz-pace').addEventListener('change', (e) => act('settings', { patch: { basePace: +e.target.value } }));
$('#wz-amp').addEventListener('input', (e) => { $('#wz-amp-out').value = e.target.value; document.documentElement.style.setProperty('--amp', +e.target.value / 100); });
$('#wz-amp').addEventListener('change', (e) => act('settings', { patch: { amp: +e.target.value / 100 } }));
$('#wz-show-typing').addEventListener('change', (e) => act('settings', { patch: { showTyping: e.target.checked } }));
$('#wz-send-typing').addEventListener('change', (e) => act('settings', { patch: { sendTyping: e.target.checked } }));
$('#wz-scenario').addEventListener('change', (e) => act('scenario', { id: e.target.value || null }));
$('#wz-next').addEventListener('click', () => act('next'));
$('#wz-reset').addEventListener('click', () => act('reset'));
$('#wz-popout').addEventListener('click', () => {
  const u = new URL(location.href); u.searchParams.set('wizard', '1');
  window.open(u.toString(), 'cwi-wizard', 'width=760,height=900');
});

// Live 設定（参加者ウィンドウのローカル設定。キーは送信しない）
$('#wz-live').addEventListener('change', (e) => act('live', { on: e.target.checked }));
$('#wz-key').addEventListener('change', (e) => { state.apiKey = e.target.value.trim(); saveLocal(); setLiveStatus(state.apiKey ? 'キーを保存しました（このブラウザのみ）' : 'キーを消去しました'); });
$('#wz-model').addEventListener('change', (e) => { state.model = e.target.value.trim() || 'gpt-5.6-luna'; state.modelCustom = true; syncControls(); saveLocal(); });
$('#wz-prompt').addEventListener('change', (e) => { state.systemPrompt = e.target.value; saveLocal(); });
$('#wz-prompt-reset').addEventListener('click', () => { state.systemPrompt = DEFAULT_SYSTEM_PROMPT; $('#wz-prompt').value = DEFAULT_SYSTEM_PROMPT; saveLocal(); });
$('#wz-token').addEventListener('change', (e) => { state.token = e.target.value.trim(); saveLocal(); setLiveStatus(state.token ? 'パスワードを保存しました（このブラウザのみ）' : 'パスワードを消去しました'); });
$('#wz-key-clear').addEventListener('click', () => { state.apiKey = ''; $('#wz-key').value = ''; saveLocal(); setLiveStatus('キーを消去しました'); });

// 自由作文
const composeEl = $('#wz-compose');
const palette = $('#wz-palette');
const PALETTE = [...Object.keys(TAGS).map(t => [t, `{${t}}`, '{/}']), ...SELF_TAGS.map(([n, s]) => [n, s, ''])];
for (const [name, open, close] of PALETTE) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = name; b.title = TAGS[name] ? TAGS[name].label : name;
  b.addEventListener('click', () => {
    const s = composeEl.selectionStart, e = composeEl.selectionEnd, v = composeEl.value;
    composeEl.value = v.slice(0, s) + open + v.slice(s, e) + close + v.slice(e);
    composeEl.focus();
    composeEl.selectionStart = s + open.length; composeEl.selectionEnd = e + open.length;
  });
  palette.appendChild(b);
}
const composeReply = () => {
  const kind = $('#wz-pre').value, ms = +$('#wz-pre-ms').value || 0;
  return { pre: kind ? { kind, ms } : null, text: composeEl.value };
};
$('#wz-preview').addEventListener('click', () => {
  const area = $('#wz-preview-area');
  area.innerHTML = '';
  const prev = state.expressive; state.expressive = true;
  revealInto(area, composeEl.value);
  state.expressive = prev;
});
$('#wz-send').addEventListener('click', () => {
  if (!composeEl.value.trim()) return;
  act('play', { reply: composeReply() });
});

/* ---------- 16. 起動 ---------- */
document.body.classList.toggle('role-wizard', role === 'wizard');
document.body.insertAdjacentHTML('afterbegin', FACE_DEFS);
{ const hero = createAvatar('hero'); hero.id = 'hero-avatar'; $('#hero-avatar').replaceWith(hero); }
loadLocal();
renderSidebar(); renderChips(); renderScript(); renderLog(); syncControls();
if (location.protocol.startsWith('http')) {
  fetch('/api/health').then(r => r.ok ? r.json() : null).then(j => {
    if (j && j.ok) { state.proxy = true; state.needsToken = !!j.needsToken; if (!state.modelCustom && j.model) state.model = j.model; syncControls(); }
  }).catch(() => {});
}
if (role === 'wizard') {
  $('#wz-status').textContent = '参加者ウィンドウを探しています…';
  post({ type: 'hello' });
  setTimeout(() => { if (!/接続中/.test($('#wz-status').textContent)) $('#wz-status').textContent = '参加者ウィンドウ: 未検出（同じブラウザでチャット画面を開いてください）'; }, 1500);
} else if (state.live) {
  emptyEl.hidden = false;
  inputEl.focus();
} else {
  loadScenario(SCENARIOS[0].id);
}

// デバッグ・拡張用に公開
window.CwI = { StreamParser, Clusterer, parseMarkup, stripMarkup, revealInto, state, loadScenario, playAiMessage, playLiveReply, setLive, createAvatar };
})();
