// 朕知道了 · 四帝判官 —— 判决卡后端
// 模型只答判断题（choice / score / noul），类型校验、分流、限流都在这里用代码做。
'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');

const PORT = Number(process.env.PORT || 3100);
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const API_URL = process.env.DEEPSEEK_URL || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const MOCK = process.env.MOCK === '1';
const PER_IP_DAILY = Number(process.env.PER_IP_DAILY || 10);
const DAILY_CAP = Number(process.env.DAILY_CAP || 300);
const MAX_INPUT = 800;

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompt/wrapper.xml'), 'utf8')
  .replace('{{RULEBOOK}}', fs.readFileSync(path.join(__dirname, 'prompt/rulebook.md'), 'utf8'));

// ---------- 题目定义（类型安全：选项之外的值一律不收） ----------
const Q = {
  局型: { type: 'choice', options: ['财政追投止损', '追责收权清理', '长期对抗联盟', '舆论面子借刀', '多方博弈表态', '名分立场选择'] },
  边界: { type: 'choice', options: ['无', '需专业资质', '急性危机', '违法动作'] },
  主裁: { type: 'choice', options: ['雍正', '康熙', '乾隆', '嘉靖'], full: true },
  参数: { type: 'choice', options: ['无', '亲密关系', '强弱不对等'] },
  不可逆: { type: 'noul' },
  度: { type: 'score' }, 势: { type: 'score' }, 时: { type: 'score' }, 术: { type: 'score' },
  动手: { type: 'noul' },
  死法卡: { type: 'choice', options: ['未命中', '忠奸卡', '面子通胀卡', '弃刀后遗症卡', '彻底解决卡', '明君卡', '代理幻觉卡', '时间通胀卡', '单点依赖卡', '身份错位卡', '冷度自噬卡'] },
};
// 把握分档：两端都有代价——线低了，没把握的判断会被当成定论；线高了，每次都在反问。
const STEADY = 0.75, USABLE = 0.5;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (x, d) => (typeof x === 'number' && isFinite(x) ? x : (typeof x === 'string' && isFinite(+x) ? +x : d));
const str = (x, max) => (typeof x === 'string' && x.trim() ? (x.trim().length > max ? x.trim().slice(0, max) + '…' : x.trim()) : null);

function matchOption(v, options) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (options.includes(t)) return t;
  return options.find(o => t.includes(o)) || null;
}

function normalize(raw) {
  const errors = [];
  const src = (raw && raw.judgments) || {};
  const out = {};
  for (const [id, def] of Object.entries(Q)) {
    const r = src[id];
    if (!r || typeof r !== 'object') { errors.push(`缺少 ${id}`); continue; }
    const confidence = clamp(num(r.confidence, 0.5), 0, 1);
    if (def.type === 'choice') {
      const choice = matchOption(r.choice, def.options);
      if (!choice) { errors.push(`${id} 的选项不在范围内：${r.choice}`); continue; }
      let probs = {};
      for (const [k, v] of Object.entries(r.probabilities || {})) {
        const kk = matchOption(k, def.options);
        if (kk) probs[kk] = clamp(num(v, 0), 0, 1);
      }
      if (def.full) for (const o of def.options) if (!(o in probs)) probs[o] = 0.1;
      if (!Object.keys(probs).length) probs[choice] = confidence;
      const s = Object.values(probs).reduce((a, b) => a + b, 0) || 1;
      for (const k in probs) probs[k] = +(probs[k] / s).toFixed(3);
      out[id] = { type: 'choice', choice, probabilities: probs, confidence };
    } else if (def.type === 'score') {
      const score = num(r.score, NaN);
      if (!isFinite(score)) { errors.push(`${id} 缺分数`); continue; }
      out[id] = { type: 'score', score: Math.round(clamp(score, 0, 100)), confidence };
    } else {
      const p = num(r.noul, NaN);
      if (!isFinite(p)) { errors.push(`${id} 缺把握值`); continue; }
      out[id] = { type: 'noul', noul: +clamp(p, 0, 1).toFixed(3), confidence };
    }
  }
  const v = (raw && raw.verdict) || {};
  const arr = (a, n, max) => (Array.isArray(a) ? a.map(x => str(x, max)).filter(Boolean).slice(0, n) : []);
  const facts = Array.isArray(v['事实清单'])
    ? v['事实清单'].map(x => (typeof x === 'string' ? x : x && (x.item || x['内容'] || x.text)
      ? `${x.tag || x['标注'] || ''}${x.tag || x['标注'] ? '｜' : ''}${x.item || x['内容'] || x.text}` : null))
      .map(x => str(x, 60)).filter(Boolean).slice(0, 6)
    : [];
  const verdict = {
    令: str(v['令'], 60), 假设: arr(v['假设'], 3, 40), 验: arr(v['验'], 3, 50),
    价: str(v['价'], 24), 锚: str(v['锚'], 40), 事实清单: facts, need: str(v.need, 50),
  };
  return { judgments: out, verdict, errors };
}

function route(j, v) {
  const tag = c => (c >= STEADY ? '稳' : c >= USABLE ? '一般' : '低');
  for (const k in j) j[k].tag = tag(j[k].confidence);
  const b = j['边界'];
  if (b.choice === '急性危机' || (b.probabilities['急性危机'] || 0) >= 0.3) return { mode: 'crisis' };
  if (b.choice === '需专业资质') return { mode: 'decline', reason: '需要医生、律师或税务师。四台机器没有这些领域的判断函数，判了必错。' };
  if (b.choice === '违法动作') return { mode: 'decline', reason: '这个局要的手段本身违法。判出来的令，执行成本是法律责任，账永远不平。' };
  if (j['不可逆'].noul >= 0.5) {
    const facts = v['事实清单'].length ? v['事实清单'] : ['推测｜对方的真实底线', '推测｜动手后对方的反应', '判断｜你能承受的最坏结果'];
    const guesses = facts.filter(f => f.startsWith('推测')).length;
    return { mode: 'facts', facts, note: guesses > 2 ? '推测超过 2 条，不出判决。把推测项补成事实再来。' : '不可逆动作，先把清单里的推测核成事实。' };
  }
  if (Math.min(j['局型'].confidence, j['主裁'].confidence) < USABLE || !v['令']) {
    return { mode: 'ask', need: v.need || '对手是谁、你要什么、能付的上限是多少？' };
  }
  return { mode: 'verdict', act: j['动手'].noul >= 0.5 ? '动' : '等' };
}

// ---------- 模型调用 ----------
async function callModel(messages) {
  if (MOCK) {
    const user = messages[messages.length - 1].content;
    const file = /担保|辞职|退学|摊牌/.test(user) ? 'mock_facts.json' : /不想活|自杀|轻生/.test(user) ? 'mock_crisis.json' : 'demo.json';
    return fs.readFileSync(path.join(__dirname, 'test', file), 'utf8');
  }
  if (!API_KEY) throw new Error('服务器没配 DEEPSEEK_API_KEY');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, messages, temperature: 0.3, max_tokens: 1500, response_format: { type: 'json_object' } }),
    });
    if (!res.ok) throw new Error(`模型接口返回 ${res.status}`);
    const data = await res.json();
    return data.choices[0].message.content;
  } finally { clearTimeout(timer); }
}

function parseJSON(s) {
  try { return JSON.parse(s); } catch (_) {}
  const m = String(s).match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) {}
  return null;
}

async function judge(text) {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `今天是 ${today}（北京时间）。\n用户的局：\n${text}` },
  ];
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await callModel(messages);
    const parsed = parseJSON(content);
    const n = parsed ? normalize(parsed) : { errors: ['输出不是 JSON'] };
    if (!n.errors.length) return { ...n, ...route(n.judgments, n.verdict) };
    messages.push({ role: 'assistant', content: String(content).slice(0, 4000) },
      { role: 'user', content: `上次输出不合格：${n.errors.join('；')}。按 output_format 重新输出完整 JSON。` });
  }
  throw new Error('模型两次都没给出合格的判决');
}

// ---------- 限流（内存计数，按北京时间每天清零） ----------
let day = '', perIp = new Map(), total = 0;
function allow(ip) {
  const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  if (d !== day) { day = d; perIp = new Map(); total = 0; }
  const n = perIp.get(ip) || 0;
  if (n >= PER_IP_DAILY) return '今天的次数用完了，明天再来。';
  if (total >= DAILY_CAP) return '今天全站额度用完了，明天再来。下面是样例卡。';
  perIp.set(ip, n + 1); total++;
  return null;
}

// ---------- 路由 ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/demo', (req, res) => {
  const n = normalize(JSON.parse(fs.readFileSync(path.join(__dirname, 'test/demo.json'), 'utf8')));
  res.json({ ...n, ...route(n.judgments, n.verdict), demo: true });
});

app.post('/api/judge', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (text.length < 8) return res.status(400).json({ error: '把局说清楚一点：对手是谁、你要什么、能付多少。' });
  if (text.length > MAX_INPUT) return res.status(400).json({ error: `控制在 ${MAX_INPUT} 字以内。` });
  const limited = allow(req.ip);
  if (limited) return res.status(429).json({ error: limited });
  const t0 = Date.now();
  try {
    const out = await judge(text);
    console.log(JSON.stringify({ t: new Date().toISOString(), mode: out.mode, ms: Date.now() - t0 }));
    res.json(out);
  } catch (e) {
    console.error(JSON.stringify({ t: new Date().toISOString(), err: e.message, ms: Date.now() - t0 }));
    res.status(502).json({ error: '四帝退朝了，稍后再试。' });
  }
});

if (require.main === module) app.listen(PORT, () => console.log(`朕知道了 · 监听 ${PORT}${MOCK ? '（模拟模式）' : ''}`));
module.exports = { normalize, route, Q };
