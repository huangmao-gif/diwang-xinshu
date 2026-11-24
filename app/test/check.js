// 校验与分流的回归检查：node test/check.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { normalize, route } = require('../server.js');
const load = f => JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
const run = raw => { const n = normalize(raw); return n.errors.length ? n : { ...n, ...route(n.judgments, n.verdict) }; };
let ok = 0;
const t = (name, fn) => { fn(); ok++; console.log('通过 ·', name); };

t('样例走判决卡，动', () => { const r = run(load('demo.json')); assert.equal(r.mode, 'verdict'); assert.equal(r.act, '动'); });
t('担保局走事实清单，推测超过 2 条不出判决', () => { const r = run(load('mock_facts.json')); assert.equal(r.mode, 'facts'); assert.match(r.note, /不出判决/); });
t('急性危机走热线卡', () => assert.equal(run(load('mock_crisis.json')).mode, 'crisis'));
t('急性危机把握 0.3 即转热线，不等它成为第一选项', () => {
  const d = load('demo.json'); d.judgments['边界'] = { type: 'choice', choice: '无', probabilities: { 无: 0.65, 急性危机: 0.35 }, confidence: 0.6 };
  assert.equal(run(d).mode, 'crisis');
});
t('违法手段不判', () => { const d = load('demo.json'); d.judgments['边界'].choice = '违法动作'; assert.equal(run(d).mode, 'decline'); });
t('主裁把握低于 0.5 改为补问', () => { const d = load('demo.json'); d.judgments['主裁'].confidence = 0.4; d.verdict.need = '他平时手头紧吗？'; const r = run(d); assert.equal(r.mode, 'ask'); assert.equal(r.need, '他平时手头紧吗？'); });
t('选项之外的值被拒收（类型安全）', () => { const d = load('demo.json'); d.judgments['主裁'].choice = '朱元璋'; assert.ok(normalize(d).errors.length); });
t('字符串数字、越界分数会被纠正', () => {
  const d = load('demo.json'); d.judgments['度'].score = '130'; d.judgments['动手'].noul = '0.9';
  const n = normalize(d); assert.equal(n.judgments['度'].score, 100); assert.equal(n.judgments['动手'].noul, 0.9);
});
t('主裁话语权缺项会补齐并归一', () => {
  const d = load('demo.json'); d.judgments['主裁'].probabilities = { 雍正: 0.6 };
  const p = normalize(d).judgments['主裁'].probabilities; assert.equal(Object.keys(p).length, 4);
  assert.ok(Math.abs(Object.values(p).reduce((a, b) => a + b, 0) - 1) < 0.01);
});
t('缺一道题即判不合格，触发重试', () => { const d = load('demo.json'); delete d.judgments['术']; assert.ok(normalize(d).errors.some(e => e.includes('术'))); });
t('超长的令被截断', () => { const d = load('demo.json'); d.verdict['令'] = '甲'.repeat(90); assert.ok(normalize(d).verdict['令'].length <= 61); });
console.log(`\n${ok} 项全部通过`);
