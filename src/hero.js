import { $, fmtK, h, reduceMotion, wait } from './dom.js';
import { P, S, emptyHealth, freshProfile } from './state.js';
import { compute, householdText } from './engine.js';
import { CARDS, appendCard, convo, markStale, meBubble, openRows, refresh, renderPlan, renderStages, say, sayNow, seenRows, stageBreak, stream, toast } from './ui.js';
import { NODE, appendAssumeChips, clone, registerCards, run } from './flow.js';
import { askQuestion, closeDrawer, drawerOpen, initAI, openDrawer, photoFlow, startFromText } from './ai.js';

/* ======================================================================
   Hero and start
   ====================================================================== */
const EXAMPLE = 'I’m 34, married with two kids (6 and 3). I make about $85k, we still owe around $240k on the house, and we have maybe $60k in savings.';
const EXAMPLE2 = 'I’m 52, married with two kids (17 and 20). I run my own manufacturing company and make about $600k a year. Our house is paid off, and we have around $3M invested.';
function renderHero() {
  stream.innerHTML = '';
  const ta = h('textarea', { id: 'intakeText', 'aria-label': 'Tell LincolnLens about your situation', placeholder: 'e.g. I’m 38, married, one kid (4), earn $95k' });
  const go = h('button', { class: 'btn', type: 'button', disabled: true, onclick: () => startFromText(ta.value) }, 'Start with this');
  ta.addEventListener('input', () => { go.disabled = ta.value.trim().length < 6; });
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !go.disabled) go.click(); });
  const photo = h('button', { class: 'linkish', type: 'button', id: 'heroPhoto', hidden: !S.ai.images, onclick: async () => { S.started = true; hideHero(); renderStages(); const r = await photoFlow('benefits'); if (r && r.lifeInsurance) S.done.add('coverageHave'); await say('Thanks. Now a few questions about the rest of your life.'); run(); } }, 'Start from a photo of your benefits page');
  const hero = h('div', { class: 'hero', id: 'hero' },
    h('h1', null, 'Tell me a little about your situation.'),
    h('p', null, 'A sentence or two is enough, or go one question at a time. Ballparks are fine, and you can change anything later.'),
    h('div', { class: 'intake' }, ta, h('div', { class: 'intake-row' }, h('button', { class: 'btn quiet', type: 'button', onclick: () => { S.started = true; hideHero(); renderStages(); say('Great. One question at a time, then.').then(run).catch(() => {}); } }, 'One question at a time'), h('span', { class: 'spacer' }), go)),
    h('div', { class: 'hero-alt' },
      ...[[EXAMPLE, 'Try a young family'], [EXAMPLE2, 'Try a business owner']].map(([ex, label]) => h('button', { class: 'linkish', type: 'button', onclick: async () => { ta.focus(); ta.value = ''; for (const ch of ex) { ta.value += ch; if (!reduceMotion()) await wait(8); } go.disabled = false; await wait(250); go.click(); } }, label)),
      photo),
    h('p', { class: 'trust' }, 'Your plans are saved only in this browser, and health answers are never saved. LincolnLens gives an educational estimate, not a quote or financial advice.'));
  stream.append(hero);
}
function hideHero() { const el = $('#hero'); if (el) el.remove(); document.body.classList.remove('pre'); }
function resetState() {
  S.runId++;
  S.p = freshProfile(); S.A = { replace: 0.75, rate: 0.03, countWork: true };
  S.done = new Set(); S.stage = 'you'; S.reached = new Set(['you']); S.quick = false; S.assumed = [];
  S.coverage = null; S.tierPick = null; S.qa = []; S.live = new Set(); S.active = null; S.started = false;
  S.log = []; S.compare = []; S.planId = null; S.created = null; S.pending = null;
  seenRows.clear(); openRows.clear();
  document.querySelectorAll('.modal-wrap').forEach(m => m.remove());
  stream.innerHTML = '';
}
function newPlan() {
  flushSave();
  resetState();
  document.body.classList.add('pre');
  renderHero(); renderStages(); refresh(); renderPlanList(); convo.scrollTo({ top: 0 });
}

/* ======================================================================
   Saved plans: like chat history, kept only in this browser
   ====================================================================== */
const STORE_KEY = 'lincolnlens.plans.v1';
const HEALTH_NODES = new Set(['Nic', 'HW', 'BP', 'Cond', 'Fam', 'Life'].flatMap(x => ['h' + x, 'ph' + x]));
let PLANS = [];
let saveT = 0;
function readStore() { try { const raw = localStorage.getItem(STORE_KEY); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; } catch { return []; } }
function writeStore() { try { localStorage.setItem(STORE_KEY, JSON.stringify(PLANS)); } catch { /* storage unavailable: plans last for this visit only */ } }
function planTitle() {
  const p = P(), hh = householdText(p);
  if (hh) return hh + (p.age ? `, ${p.age}` : '');
  const first = S.log.find(e => e.t === 'me');
  return first ? first.text.slice(0, 48) : 'New plan';
}
function planMeta(updated) {
  const c = compute(P());
  const d = new Date(updated).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const amt = S.coverage > 0 ? `${fmtK(S.coverage)} coverage` : c.items.length ? `${fmtK(c.gap)} to cover` : 'Just started';
  return `${amt}, ${d}`;
}
function snapshot() {
  const p = clone(S.p);
  p.health = emptyHealth(); if (p.partner) p.partner.health = emptyHealth(); // health answers are never saved
  const log = S.log.map(e => (e.t === 'me' && e.nodeId && HEALTH_NODES.has(e.nodeId)) ? { ...e, text: 'Answered (not saved)' } : e);
  return {
    id: S.planId, created: S.created, title: planTitle(),
    p, A: { ...S.A }, done: [...S.done], stage: S.stage, reached: [...S.reached], quick: S.quick, assumed: S.assumed,
    coverage: S.coverage, tierPick: S.tierPick, qa: S.qa.slice(-12), compare: S.compare, log,
    activeId: S.active && S.active.node ? S.active.node.id : null
  };
}
function scheduleSave() { if (S.restoring) return; clearTimeout(saveT); saveT = setTimeout(saveCurrent, 350); }
function flushSave() { clearTimeout(saveT); saveCurrent(); }
function saveCurrent() {
  if (S.restoring || !S.started || !S.log.some(e => e.t === 'me')) return;
  if (!S.planId) { S.planId = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); S.created = Date.now(); }
  const rec = snapshot();
  const sig = JSON.stringify(rec);
  const i = PLANS.findIndex(x => x.id === rec.id);
  if (i >= 0 && PLANS[i].sig === sig) return; // opening or scrolling a plan doesn't move it up the list
  rec.sig = sig; rec.updated = Date.now(); rec.meta = planMeta(rec.updated);
  if (i >= 0) PLANS[i] = rec; else PLANS.unshift(rec);
  PLANS.sort((a, b) => b.updated - a.updated);
  if (PLANS.length > 30) PLANS.length = 30;
  writeStore(); renderPlanList();
}
function openPlan(id) {
  const rec = PLANS.find(x => x.id === id); if (!rec) return;
  closeNav();
  document.body.classList.remove('on-landing');
  if (rec.id === S.planId && S.started) return;
  flushSave();
  resetState();
  S.restoring = true;
  S.planId = rec.id; S.created = rec.created;
  S.p = { ...freshProfile(), ...clone(rec.p) }; S.p.health = emptyHealth(); S.p.partner = { ...freshProfile().partner, ...(S.p.partner || {}), health: emptyHealth() };
  S.A = { replace: 0.75, rate: 0.03, countWork: true, ...(rec.A || {}) };
  S.done = new Set(rec.done || []); S.stage = rec.stage || 'you'; S.reached = new Set(rec.reached || ['you']);
  S.quick = !!rec.quick; S.assumed = rec.assumed || []; S.coverage = rec.coverage ?? null; S.tierPick = rec.tierPick ?? null;
  S.qa = rec.qa || []; S.compare = rec.compare || []; S.started = true;
  document.body.classList.remove('pre');
  const log = rec.log || [];
  // a question that was waiting for an answer is asked again at the end
  let skip = -1;
  if (rec.activeId) { S.done.delete(rec.activeId); for (let i = log.length - 1; i >= 0; i--) if (log[i].t === 'll' && log[i].askId === rec.activeId) { skip = i; break; } }
  log.forEach((e, i) => {
    if (i === skip) return;
    try {
      if (e.t === 'll') sayNow(e.parts, e.askId);
      else if (e.t === 'me') { const row = meBubble(e.text, e.nodeId ? NODE[e.nodeId] : null); if (e.stale) markStale(row, 'Changed later'); }
      else if (e.t === 'stage') stageBreak(e.st);
      else if (e.t === 'card' && CARDS[e.kind]) appendCard(e.kind);
      else if (e.t === 'assume') appendAssumeChips(e.ids || []);
    } catch (err) { console.error(err); }
  });
  S.restoring = false;
  renderStages(); refresh(); renderPlanList();
  requestAnimationFrame(() => convo.scrollTo({ top: convo.scrollHeight }));
  run();
}
function startBlank() {
  resetState();
  document.body.classList.add('pre');
  document.body.classList.remove('on-landing');
  renderHero(); renderStages(); refresh(); renderPlanList(); convo.scrollTo({ top: 0 });
}
function deletePlan(id) {
  PLANS = PLANS.filter(x => x.id !== id); writeStore();
  if (id === S.planId) startBlank(); else renderPlanList();
  toast('Plan deleted.');
}
function renderPlanList() {
  const ul = $('#planList'); if (!ul) return;
  ul.innerHTML = '';
  if (!PLANS.length) ul.append(h('li', { class: 'plan-empty' }, 'Plans you build will appear here.'));
  for (const r of PLANS) {
    const cur = r.id === S.planId;
    const li = h('li', { class: 'plan-item' + (cur ? ' current' : '') });
    const open = h('button', { class: 'open', type: 'button', 'aria-current': cur ? 'true' : null, onclick: () => openPlan(r.id) },
      h('span', { class: 't' }, r.title), h('span', { class: 'm' }, r.meta));
    const del = h('button', { class: 'del', type: 'button', 'aria-label': `Delete ${r.title}` }, '×');
    del.addEventListener('click', () => {
      if (del.dataset.armed) { deletePlan(r.id); return; }
      del.dataset.armed = '1'; del.textContent = 'Delete?'; del.classList.add('armed');
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = '×'; del.classList.remove('armed'); } }, 3000);
    });
    li.append(open, del); ul.append(li);
  }
  const cont = $('#continuePlan'); if (cont) cont.hidden = !PLANS.length;
}

/* ======================================================================
   Landing page and navigation
   ====================================================================== */
function showLanding() { flushSave(); closeNav(); renderPlanList(); document.body.classList.add('on-landing'); $('#landing').scrollTop = 0; }
function buildMyPlan() {
  if (S.started) { flushSave(); startBlank(); }
  else document.body.classList.remove('on-landing');
  setTimeout(() => { const t = $('#intakeText'); if (t) t.focus(); }, 60);
}
function openNav() { $('#sideNav').classList.add('open'); $('#navScrim').hidden = false; $('#navToggle').setAttribute('aria-expanded', 'true'); }
function closeNav() { $('#sideNav').classList.remove('open'); $('#navScrim').hidden = true; $('#navToggle').setAttribute('aria-expanded', 'false'); }

/* wiring — Enter and the Ask button send directly, so a blocked form submit cannot swallow the message */
function sendAsk() {
  const i = $('#ask');
  if (!i) return;
  const v = i.value;
  i.value = '';
  askQuestion(v);
}
$('#ask').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  e.preventDefault();
  sendAsk();
});
$('#askBtn').addEventListener('click', sendAsk);
$('#openWork').addEventListener('click', openDrawer);
$('#drawerWrap').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeDrawer(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (drawerOpen) closeDrawer(); closeNav(); } });
$('#newPlan').addEventListener('click', () => { flushSave(); startBlank(); closeNav(); });
$('#newPlanTop').addEventListener('click', () => { flushSave(); startBlank(); });
$('#brandHome').addEventListener('click', showLanding);
$('#buildPlan').addEventListener('click', buildMyPlan);
$('#continuePlan').addEventListener('click', () => { if (PLANS[0]) openPlan(PLANS[0].id); });
$('#navToggle').addEventListener('click', () => { $('#sideNav').classList.contains('open') ? closeNav() : openNav(); });
$('#navScrim').addEventListener('click', closeNav);
$('#sheetBar').addEventListener('click', () => { const pnl = $('#panel'); const up = pnl.classList.toggle('up'); $('#sheetBar').setAttribute('aria-expanded', String(up)); });
window.addEventListener('pagehide', flushSave);
let resizeT = 0;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(refresh, 160); });

export function boot() {
  registerCards();
  PLANS = readStore();
  renderHero();
  renderStages();
  renderPlan();
  renderPlanList();
  initAI();
}

export { EXAMPLE, EXAMPLE2, HEALTH_NODES, PLANS, STORE_KEY, buildMyPlan, closeNav, deletePlan, flushSave, hideHero, newPlan, openNav, openPlan, planMeta, planTitle, readStore, renderHero, renderPlanList, resetState, resizeT, saveCurrent, saveT, scheduleSave, showLanding, snapshot, startBlank, writeStore };
