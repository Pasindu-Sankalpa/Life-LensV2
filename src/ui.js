import { $, clamp, fmtK, h, reduceMotion, wait } from './dom.js';
import { P, S } from './state.js';
import { compute, hasPartner, partnerPremium, partnerProfile, policyName, premium, rangeTxt, riskClass, simulate } from './engine.js';
import { photoButton, renderDrawer, renderSuggest } from './ai.js';
import { scheduleSave } from './hero.js';

/* ======================================================================
   Conversation primitives
   ====================================================================== */
const stream = $('#stream'), convo = $('#convo');
const MARK_SVG = '<svg viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="13" fill="none" stroke="var(--brand)" stroke-width="2"/><circle cx="15" cy="15" r="7.5" fill="none" stroke="var(--brand)" stroke-width="2" opacity=".55"/><circle cx="15" cy="15" r="2.6" fill="var(--brand)"/></svg>';
const md = s => String(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
function scrollDown(force) {
  const nearBottom = convo.scrollHeight - convo.scrollTop - convo.clientHeight < 600;
  if (force || nearBottom) requestAnimationFrame(() => convo.scrollTo({ top: convo.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' }));
}
function markEl() { const d = h('div', { class: 'mark', html: MARK_SVG }); return d; }
function renderParts(body, arr) {
  for (const part of arr) {
    if (part == null) continue;
    if (typeof part === 'string') body.append(h('p', { class: 't', html: md(part) }));
    else if (part.html != null) body.append(h('p', { class: 't', html: part.html }));
    else if (part.note) body.append(h('div', { class: 'guardnote' }, part.note));
    else {
      if (part.q) body.append(h('p', { class: 'q', html: md(part.q) }));
      if (part.sub) body.append(h('p', { class: 't sub', html: md(part.sub) }));
    }
  }
}
const logParts = arr => arr.filter(x => x != null).map(x => typeof x === 'string' ? x : { q: x.q, sub: x.sub, html: x.html, note: x.note });
function sayNow(parts, askId) {
  const arr = Array.isArray(parts) ? parts : [parts];
  const body = h('div', { class: 'body' });
  const wrap = h('div', { class: 'msg ll' }, markEl(), body);
  renderParts(body, arr); stream.append(wrap);
  S.log.push({ t: 'll', parts: logParts(arr), askId: askId || null });
  return wrap;
}
async function say(parts, opts = {}) {
  const tok = S.runId;
  const arr = Array.isArray(parts) ? parts : [parts];
  const body = h('div', { class: 'body' });
  const wrap = h('div', { class: 'msg ll' }, markEl(), body);
  const textLen = arr.map(x => typeof x === 'string' ? x : (x.q || '') + (x.sub || '')).join('').length;
  if (!opts.instant && !reduceMotion()) {
    body.append(h('div', { class: 'typing', role: 'status', 'aria-label': 'LincolnLens is writing' }, h('i'), h('i'), h('i')));
    stream.append(wrap); scrollDown(true);
    await wait(opts.delay ?? clamp(260 + textLen * 3.2, 380, 950));
    if (tok !== S.runId) { wrap.remove(); throw new Error('stale'); }
    body.innerHTML = '';
  } else stream.append(wrap);
  renderParts(body, arr);
  if (!opts.noLog) { S.log.push({ t: 'll', parts: logParts(arr), askId: opts.askId || null }); scheduleSave(); }
  scrollDown(true);
  return wrap;
}
function meBubble(content, node, logText) {
  const bubble = h('div', { class: 'bubble' });
  if (typeof content === 'string') bubble.textContent = content; else bubble.append(content);
  const row = h('div', { class: 'msg me' },
    node && node.editable !== false ? h('button', { class: 'edit', type: 'button', onclick: () => editNode(node, row) }, 'Change') : null,
    bubble);
  stream.append(row); scrollDown(true);
  row._entry = { t: 'me', text: typeof content === 'string' ? content : (logText || 'Shared a photo'), nodeId: node ? node.id : null };
  S.log.push(row._entry); scheduleSave();
  return row;
}
function stageBreak(st) {
  const label = STAGES.find(s => s[0] === st)[1];
  const el = h('div', { class: 'stage-break', id: 'stage-' + st }, h('span', null, label));
  stream.append(el);
  S.log.push({ t: 'stage', st });
}
/* rich cards are rebuilt from the plan, so a saved conversation can be reopened */
const CARDS = {};
function appendCard(kind) {
  const card = CARDS[kind]();
  card.dataset.kind = kind;
  stream.append(card);
  if (card._init) card._init();
  S.log.push({ t: 'card', kind });
  scrollDown(true); scheduleSave();
  return card;
}
function stale(tok) { return tok !== S.runId; }

/* ======================================================================
   Stages
   ====================================================================== */
const STAGES = [['you', 'You'], ['needs', 'Your needs'], ['protection', 'Protection'], ['family', 'Family'], ['explore', 'Explore']];
function renderStages() {
  const ol = $('#stages'); ol.innerHTML = '';
  const p = P();
  for (const [k, label] of STAGES) {
    if (k === 'family' && p.household && !hasPartner(p)) continue;
    const li = h('li', { class: (S.reached.has(k) ? 'reached ' : '') + (S.stage === k ? 'current' : '') },
      h('button', { type: 'button', disabled: !S.reached.has(k) || !S.started, 'aria-current': S.stage === k ? 'step' : null,
        onclick: () => { const t = document.getElementById('stage-' + k); if (t) t.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); else convo.scrollTo({ top: 0, behavior: 'smooth' }); } }, label));
    ol.append(li);
  }
}
function setStage(st) {
  if (S.stage === st) return;
  const order = STAGES.map(s => s[0]);
  if (order.indexOf(st) < order.indexOf(S.stage)) return; // questions added later never move the conversation backwards
  S.stage = st; S.reached.add(st);
  stageBreak(st); renderStages();
}

/* ======================================================================
   Answer widgets
   ====================================================================== */
function optButton(o, onClick, pressed) {
  return h('button', { class: 'opt', type: 'button', 'aria-pressed': pressed == null ? null : String(!!pressed), onclick: onClick },
    o.icon ? h('span', { class: 'ic', 'aria-hidden': 'true' }, o.icon) : null,
    h('span', null, o.label, o.small ? h('small', null, o.small) : null));
}
function choiceWidget(cfg, done) {
  const wrap = h('div', { class: 'opts' + (cfg.cards ? ' cards' : '') });
  for (const o of cfg.options) {
    wrap.append(optButton(o, () => {
      if (o.then) { wrap.replaceWith(o.then(done)); return; }
      done(o.v, o);
    }));
  }
  return wrap;
}
function multiWidget(cfg, done) {
  const sel = new Set(cfg.initial || []);
  const box = h('div');
  const wrap = h('div', { class: 'opts' + (cfg.cards ? ' cards' : '') });
  const go = h('button', { class: 'btn', type: 'button', disabled: !sel.size, onclick: () => done([...sel]) }, cfg.confirm || 'Continue');
  const btns = [];
  for (const o of cfg.options) {
    const b = optButton(o, () => {
      if (sel.has(o.v)) sel.delete(o.v);
      else {
        if (o.exclusive) sel.clear(); else for (const x of cfg.options) if (x.exclusive) sel.delete(x.v);
        sel.add(o.v);
      }
      btns.forEach(([bb, oo]) => bb.setAttribute('aria-pressed', String(sel.has(oo.v))));
      go.disabled = !sel.size;
    }, sel.has(o.v));
    btns.push([b, o]); wrap.append(b);
  }
  box.append(wrap, h('div', { class: 'actions' }, go));
  return box;
}
function amountWidget(cfg, done) {
  const money = cfg.money !== false;
  const maxTyped = cfg.hardMax || (money ? cfg.max * 4 : cfg.max);
  let val = cfg.initial ?? cfg.min;
  const show = v => money ? Math.round(v).toLocaleString('en-US') : String(Math.round(v));
  const useBtn = h('button', { class: 'btn', type: 'button' }, cfg.confirm || 'Use this amount');
  const err = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const input = h('input', { type: 'text', inputmode: money ? 'decimal' : 'numeric', autocomplete: 'off', spellcheck: 'false',
    'aria-label': cfg.aria || 'Amount', placeholder: money ? '0' : String(cfg.min), value: show(val), maxlength: 14 });
  const range = h('input', { type: 'range', class: 'range', min: cfg.min, max: cfg.max, step: cfg.step, value: val, 'aria-label': (cfg.aria || 'Amount') + ' slider' });
  const fit = () => { input.style.width = Math.max(3, (input.value || input.placeholder).length + 1.2) + 'ch'; };
  const setErr = msg => {
    err.hidden = !msg; err.textContent = msg || '';
    input.setAttribute('aria-invalid', String(!!msg)); useBtn.disabled = !!msg;
  };
  function parse(raw) {
    const s = raw.trim().replace(/^\$/, '').replace(/\s+/g, '');
    if (!s) return { error: money ? 'Enter an amount, or pick one below.' : 'Enter a number.' };
    if (/[a-jl-z]/i.test(s.replace(/[km]$/i, '')) || (!money && /[^\d]/.test(s)))
      return { error: money ? 'Numbers only, please. For example 250,000 or 250k.' : 'Numbers only, please.' };
    const ok = money ? /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?[km]?$/i.test(s) : /^\d+$/.test(s);
    if (!ok) return { error: money ? 'That doesn’t look like an amount. Try 250,000 or 250k.' : 'Use a whole number.' };
    let v = parseFloat(s.replace(/,/g, '').replace(/[km]$/i, ''));
    if (/k$/i.test(s)) v *= 1000; else if (/m$/i.test(s)) v *= 1e6;
    if (!money && (v < cfg.min || v > maxTyped)) return { error: `Enter a number from ${cfg.min} to ${maxTyped}.` };
    if (money && v > maxTyped) return { error: `That’s more than ${fmtK(maxTyped)}. Check the amount.` };
    return { v };
  }
  range.addEventListener('input', () => { val = Number(range.value); input.value = show(val); setErr(null); fit(); });
  input.addEventListener('input', () => {
    fit();
    const r = parse(input.value);
    if (r.error) { setErr(r.error); return; }
    setErr(null); val = r.v; range.value = clamp(val, cfg.min, cfg.max);
  });
  input.addEventListener('blur', () => { const r = parse(input.value); if (!r.error) { input.value = show(r.v); fit(); } });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); if (!useBtn.disabled) done(val); } });
  useBtn.addEventListener('click', () => { if (!useBtn.disabled) done(val); });
  fit();
  const big = h('label', { class: 'big' }, money ? h('span', null, '$') : null, input, cfg.unit ? h('span', { class: 'unit' }, cfg.unit) : null);
  const ends = h('div', { class: 'range-ends' }, h('span', null, money ? fmtK(cfg.min) : cfg.min), h('span', null, (money ? fmtK(cfg.max) : cfg.max) + (cfg.plusEnd ? '+' : '')));
  const chips = cfg.presets ? h('div', { class: 'chips' }, cfg.presets.map(pr => h('button', { class: 'chip', type: 'button', onclick: () => done(pr.v) }, pr.label))) : null;
  const actions = h('div', { class: 'actions' }, useBtn, cfg.photo && S.ai.images ? photoButton(cfg.photo, done) : null);
  return h('div', null, h('div', { class: 'amount' }, big, err, range, ends, chips), actions);
}
function kidsWidget(cfg, done) {
  let ages = (cfg.initial && cfg.initial.length) ? [...cfg.initial] : [];
  const box = h('div');
  const countRow = h('div', { class: 'opts' });
  const kidsRow = h('div', { class: 'kids-row' });
  const go = h('button', { class: 'btn', type: 'button', onclick: () => done(ages.slice()) }, 'Continue');
  const draw = () => {
    kidsRow.innerHTML = '';
    ages.forEach((a, i) => {
      const sel = h('select', { 'aria-label': `Age of child ${i + 1}` });
      for (let n = 0; n <= 25; n++) sel.append(h('option', { value: n, selected: n === a ? true : null }, n === 0 ? 'Under 1' : String(n)));
      sel.addEventListener('change', () => { ages[i] = Number(sel.value); });
      kidsRow.append(h('label', { class: 'kid' }, `Child ${i + 1}`, sel));
    });
    go.disabled = !ages.length;
    countRow.querySelectorAll('.opt').forEach((b, i) => b.setAttribute('aria-pressed', String(i + 1 === ages.length)));
  };
  [1, 2, 3, 4].forEach(n => countRow.append(optButton({ label: n === 4 ? '4 or more' : String(n) }, () => {
    const def = [7, 4, 2, 1];
    while (ages.length < n) ages.push(def[ages.length] ?? 1);
    ages.length = n; draw();
  }, false)));
  box.append(h('p', { class: 'note', style: { marginTop: 0 } }, 'How many?'), countRow, kidsRow, h('div', { class: 'actions' }, go));
  draw();
  return box;
}
function bandWidget(cfg, done) {
  const opts = cfg.bands.map(b => ({ ...b }));
  opts.push({ label: 'Enter my amount', then: d => amountWidget({ min: 0, max: 400000, step: 1000, initial: cfg.initial || 75000, aria: 'Annual income', plusEnd: true, hardMax: 5e6 }, d) });
  return choiceWidget({ options: opts }, done);
}
function hwWidget(cfg, done) {
  const ft = h('select', { 'aria-label': 'Height, feet' }, [4, 5, 6, 7].map(n => h('option', { value: n, selected: n === 5 ? true : null }, `${n} ft`)));
  const inch = h('select', { 'aria-label': 'Height, inches' }, Array.from({ length: 12 }, (_, i) => h('option', { value: i, selected: i === 7 ? true : null }, `${i} in`)));
  const wt = h('input', { type: 'text', inputmode: 'numeric', placeholder: '160', maxlength: 3, autocomplete: 'off', 'aria-label': 'Weight in pounds' });
  const err = h('p', { class: 'field-error', role: 'alert', hidden: true });
  const go = h('button', { class: 'btn', type: 'button', disabled: true }, 'Continue');
  const check = () => {
    const s = wt.value.trim(); let msg = null;
    if (s && !/^\d+$/.test(s)) msg = 'Numbers only, please.';
    else if (s && (+s < 70 || +s > 600)) msg = 'Enter a weight from 70 to 600 lb.';
    err.hidden = !msg; err.textContent = msg || ''; wt.setAttribute('aria-invalid', String(!!msg)); go.disabled = !!msg || !s;
  };
  wt.addEventListener('input', check);
  wt.addEventListener('keydown', e => { if (e.key === 'Enter' && !go.disabled) { e.preventDefault(); go.click(); } });
  go.addEventListener('click', () => done({ ft: +ft.value, inch: +inch.value, lb: +wt.value }));
  return h('div', null,
    h('div', { class: 'amount hw' }, h('div', { class: 'hw-row' }, h('div', { class: 'hw-f' }, h('span', { class: 'lbl' }, 'Height'), ft, inch), h('label', { class: 'hw-f' }, h('span', { class: 'lbl' }, 'Weight'), wt, h('span', { class: 'unit' }, 'lb'))), err),
    h('div', { class: 'actions' }, go, h('button', { class: 'btn quiet', type: 'button', onclick: () => done('na') }, 'Prefer not to say')));
}
function buildWidget(node, done) {
  const w = typeof node.widget === 'function' ? node.widget(P()) : node.widget;
  switch (w.type) {
    case 'choice': return choiceWidget(w, done);
    case 'multi': return multiWidget(w, done);
    case 'amount': return amountWidget(w, done);
    case 'kids': return kidsWidget(w, done);
    case 'band': return bandWidget(w, done);
    case 'hw': return hwWidget(w, done);
  }
}
const SKIP = '__answered_in_chat__';
function askNode(node) {
  return new Promise(async resolve => {
    const tok = S.runId;
    let qEl;
    try { qEl = await say(node.ask(P()), { askId: node.id }); } catch { return; }
    if (stale(tok)) return;
    let settled = false;
    const wEl = h('div', { class: 'widget' });
    const finish = v => {
      if (settled) return; settled = true;
      wEl.remove(); S.active = null; renderSuggest();
      resolve(v);
    };
    wEl.append(buildWidget(node, v => finish(v)));
    stream.append(wEl); scrollDown(true);
    // `skip` lets a typed message answer this question instead of the buttons
    S.active = { qEl, wEl, node, skip: () => finish(SKIP), choose: v => finish({ __typed: true, v }) };
    renderSuggest();
  });
}

/* editing a past answer */
function editNode(node, row) {
  const wrapEl = h('div', { class: 'modal-wrap', role: 'dialog', 'aria-modal': 'true' });
  const close = () => wrapEl.remove();
  const scrim = h('div', { class: 'scrim', onclick: close });
  const q = node.ask(P());
  const qq = Array.isArray(q) ? q[0] : q;
  const modal = h('div', { class: 'modal' },
    h('div', { class: 'msg ll' }, markEl(), h('div', null, h('p', { class: 'q', html: md(typeof qq === 'string' ? qq : qq.q) }))),
    h('div', { class: 'widget' }, buildWidget(node, (v) => {
      node.apply(P(), v, true);
      if (row) { const b = row.querySelector('.bubble'); const t = node.label(v, P()); if (b) b.textContent = t; if (row._entry) row._entry.text = t; }
      close(); refresh();
      toast(`Updated. Your plan has been recalculated.`);
    })),
    h('div', { class: 'actions' }, h('button', { class: 'btn quiet small', type: 'button', onclick: close }, 'Cancel')));
  wrapEl.append(scrim, modal);
  document.body.append(wrapEl);
  const first = modal.querySelector('button, input'); if (first) first.focus();
  wrapEl.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
}
function toast(text) {
  const t = h('div', { role: 'status', style: { position: 'fixed', left: '50%', bottom: 'calc(96px + env(safe-area-inset-bottom,0px))', transform: 'translateX(-50%)', background: 'var(--ink)', color: 'var(--bg)', padding: '10px 16px', borderRadius: '12px', fontSize: '.92rem', zIndex: 30 } }, text);
  document.body.append(t); setTimeout(() => t.remove(), 2400);
}

/* ======================================================================
   Plan panel
   ====================================================================== */
const seenRows = new Map(); const openRows = new Set();
function planRow(key, label, amount, why, opts = {}) {
  const k = key; const prev = seenRows.get(k);
  const isNew = prev == null || Math.abs(prev - amount) > 1;
  seenRows.set(k, amount);
  const row = h('div', { class: 'prow' + (opts.neg ? ' neg' : '') + (opts.off ? ' off' : '') + (openRows.has(k) ? ' open' : '') + (isNew && S.started && !S.restoring ? ' flash' : '') });
  const btn = h('button', { type: 'button', 'aria-expanded': String(openRows.has(k)) },
    h('span', { class: 'lab' }, h('span', null, label), why ? h('span', { class: 'why' }, 'Why?') : null),
    h('span', { class: 'amt' }, (opts.neg ? '−' : '') + fmtK(amount)));
  btn.addEventListener('click', () => { if (!why) return; openRows.has(k) ? openRows.delete(k) : openRows.add(k); row.classList.toggle('open'); btn.setAttribute('aria-expanded', String(row.classList.contains('open'))); });
  row.append(btn);
  if (why) row.append(h('div', { class: 'explain' }, why));
  return row;
}
function renderPlan() {
  const p = P(), c = compute(p), el = $('#plan');
  el.innerHTML = '';
  el.append(h('h2', null, 'Your plan so far'));
  if (!c.items.length && !c.res.length) {
    el.append(h('p', { class: 'intro' }, 'Every answer adds a piece here, so you can watch your plan take shape.'),
      h('div', { class: 'empty-plan' }, 'Nothing yet.', h('div', { class: 'ghostrow', style: { width: '80%' } }), h('div', { class: 'ghostrow', style: { width: '60%' } }), h('div', { class: 'ghostrow', style: { width: '70%' } })));
    $('#sheetNum').textContent = '—';
    return;
  }
  el.append(h('p', { class: 'intro' }, 'Tap any line to see how it was worked out.'));
  if (c.items.length) {
    const g = h('div', { class: 'pgroup' }, h('div', { class: 'pgroup-h' }, 'What your family would need'));
    for (const it of c.items) g.append(planRow('i-' + it.key, it.label, it.amount, it.why));
    g.append(h('div', { class: 'psum' }, h('span', null, 'Total'), h('span', null, fmtK(c.need))));
    el.append(g);
  }
  if (c.res.length) {
    const g = h('div', { class: 'pgroup' }, h('div', { class: 'pgroup-h' }, 'What you already have'));
    for (const r of c.res) {
      g.append(planRow('r-' + r.key, r.label, r.amount, r.work ? 'Coverage through an employer usually ends if you leave the job, retire, or are laid off. You can choose whether to count it.' : r.key === 'savings' ? 'Money your family could use right away, which lowers what insurance needs to provide.' : 'A policy you own stays with you.', { neg: true, off: !r.counted }));
      if (r.work) {
        const cb = h('input', { type: 'checkbox', checked: S.A.countWork ? true : null, id: 'countWork' });
        cb.addEventListener('change', () => { S.A.countWork = cb.checked; refresh(); });
        g.append(h('label', { class: 'switch', for: 'countWork' }, cb, 'Count work coverage'));
      }
    }
    el.append(g);
  }
  if (c.items.length) {
    const progress = c.need ? Math.min(1, c.have / c.need) : 0;
    const t = h('div', { class: 'target' },
      h('div', { class: 'lbl' }, S.stage === 'you' || S.stage === 'needs' ? 'Still to cover, so far' : 'Still to cover'),
      h('div', { class: 'num' }, fmtK(c.gap)),
      c.gap > 0 && c.tiers.balanced ? h('div', { class: 'ptext' }, `A round number to aim for: ${fmtK(c.tiers.balanced)}`) : h('div', { class: 'ptext' }, 'What you have already covers what you’ve described.'),
      h('div', { class: 'progress', 'aria-hidden': 'true' }, h('i', { style: { width: (progress * 100).toFixed(1) + '%' } })),
      h('div', { class: 'ptext' }, c.have ? `You’re already ${Math.round(progress * 100)}% of the way there.` : 'Savings and coverage you already have will count here.'));
    el.append(t);
    if (S.coverage > 0 && (S.stage === 'protection' || S.stage === 'family' || S.stage === 'explore')) {
      const s = simulate(p, S.coverage);
      const allOk = s.goals.every(g => g.pct >= 0.995);
      el.append(h('div', { class: 'chosen' }, 'Coverage you’re exploring: ', h('b', null, fmtK(S.coverage)), h('div', { class: 'ptext', style: { color: 'var(--ink-2)', fontSize: '.88rem' } }, allOk ? 'Covers every goal in your plan.' : 'Covers part of your plan. See the details in the conversation.')));
    }
    if (p.policy && S.coverage > 0) {
      const q = premium(p, S.coverage, p.policy.type, p.policy.years), rc = riskClass(p.health);
      el.append(h('div', { class: 'policy-box' }, h('div', { class: 'pgroup-h' }, 'Your policy'),
        h('div', { class: 'row' }, h('span', null, `${policyName(p.policy)}, ${fmtK(S.coverage)}`), h('b', null, `${rangeTxt(q)}/mo`)),
        p.cvDeposit ? h('div', { class: 'row' }, h('span', null, 'Added to cash value'), h('b', null, fmtK(p.cvDeposit))) : null,
        h('div', { class: 'ptext' }, rc.known ? `Estimated price class: ${rc.cls.name}` : 'Price assumes average health. Share health details for a sharper estimate.')));
    }
    $('#sheetNum').textContent = fmtK(c.gap);
  }
  if (hasPartner(p) && p.partner.depends && p.partner.depends !== 'no' && S.reached.has('family') && p.partner.coverage != null) {
    const pc = compute(partnerProfile(p));
    const box = h('div', { class: 'partner-box' }, h('div', { class: 'pgroup-h' }, 'Your partner’s side'));
    for (const it of pc.items) box.append(planRow('p-' + it.key, it.label, it.amount, it.why));
    for (const r of pc.res) box.append(planRow('pr-' + r.key, r.label, r.amount, null, { neg: true }));
    box.append(h('div', { class: 'psum' }, h('span', null, 'Still to cover'), h('span', null, fmtK(pc.gap))));
    if (p.partner.cover && pc.tiers.balanced) {
      const pol = p.policy || { type: 'term', years: 20 }, q = partnerPremium(p, pc.tiers.balanced, pol.type, pol.years), rc = riskClass(p.partner.health);
      box.append(h('div', { class: 'row' }, h('span', null, `${policyName(pol)}, ${fmtK(pc.tiers.balanced)}`), h('b', null, `${rangeTxt(q)}/mo`)),
        h('div', { class: 'ptext' }, rc.known ? `Estimated price class: ${rc.cls.name}` : 'Price assumes average health.'));
    }
    el.append(box);
  }
}
function refresh() {
  if (S.tierPick && S.coverage != null) S.coverage = compute(P()).tiers[S.tierPick];
  renderPlan();
  for (const fn of [...S.live]) { try { if (fn() === false) S.live.delete(fn); } catch (e) { console.error(e); S.live.delete(fn); } }
  renderDrawer(true);
  renderSuggest();
  scheduleSave();
}
function live(el, fn) { const f = () => { if (!el.isConnected) return false; fn(); }; S.live.add(f); fn(); return el; }


export { CARDS, MARK_SVG, SKIP, STAGES, amountWidget, appendCard, askNode, bandWidget, buildWidget, choiceWidget, convo, editNode, hwWidget, kidsWidget, live, logParts, markEl, md, meBubble, multiWidget, openRows, optButton, planRow, refresh, renderParts, renderPlan, renderStages, say, sayNow, scrollDown, seenRows, setStage, stageBreak, stale, stream, toast };
