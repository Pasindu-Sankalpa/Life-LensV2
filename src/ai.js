import { $, esc, fmt, fmtK, h, pct, plural, reduceMotion, roundTo, wait } from './dom.js';
import { P, S, SOURCES } from './state.js';
import { allowedFigures, cap, cashValueAt, compute, guard, hasKids, hasPartner, healthShared, householdText, partnerProfile, policyName, premium, rangeTxt, remainingSavings, riskClass, simulate, wealthProfile } from './engine.js';
import { logParts, markEl, meBubble, optButton, refresh, renderParts, renderStages, say, scrollDown, stale, stream } from './ui.js';
import { ALL_EVENTS, clone, eventLabel, kidsHousehold, listJoin, personalizeHealth, reactionText, run, tradeoffs } from './flow.js';
import { flushSave, hideHero, scheduleSave, startBlank } from './hero.js';

/* ======================================================================
   AI layer: Claude reads and explains; the engine calculates
   ====================================================================== */
function logAI(entry) { S.ai.log.unshift({ time: new Date(), ...entry }); renderDrawer(true); }
const aiName = () => S.ai.name || 'Claude';

/* ----------------------------------------------------------------------
   LOCAL MODEL SETTINGS
   Used only when the page is NOT running inside claude.ai.
   Works with any OpenAI-compatible server: Ollama, LM Studio, llama.cpp.
     Ollama:     http://localhost:11434/v1
     LM Studio:  http://localhost:1234/v1
     llama.cpp:  http://localhost:8080/v1
   Set enabled to false to skip the local model entirely.
   ---------------------------------------------------------------------- */
const LOCAL_LLM = {
  enabled: true,
  baseUrl: 'http://localhost:11434/v1',
  model: 'qwen2.5:7b',          // text model: reading descriptions, answering questions
  visionModel: 'qwen2.5vl:7b',  // photo reading; set to null to hide photo features
  apiKey: '',                   // only if your server requires one
  timeoutMs: 90000
};

function blobToDataURL(blob) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(blob); });
}
function toMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  const out = [];
  input.forEach((t, i) => {
    // a conversation's first turn holds the standing instructions: send it as the system prompt
    const role = i === 0 && input.length > 1 ? 'system' : t.role;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += '\n\n' + t.content; else out.push({ role, content: t.content });
  });
  return out;
}
async function localChat(input, opts = {}) {
  const messages = toMessages(input);
  let model = LOCAL_LLM.model;
  if (opts.images) {
    if (!LOCAL_LLM.visionModel) throw { code: 'images_unavailable', message: 'No vision model set' };
    model = LOCAL_LLM.visionModel;
    const blobs = opts.images instanceof Blob ? [opts.images] : Array.from(opts.images);
    const last = messages[messages.length - 1];
    last.content = [{ type: 'text', text: last.content }];
    for (const b of blobs) last.content.push({ type: 'image_url', image_url: { url: await blobToDataURL(b) } });
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LOCAL_LLM.timeoutMs);
  if (opts.signal) opts.signal.addEventListener('abort', () => ctl.abort());
  let res;
  try {
    res = await fetch(LOCAL_LLM.baseUrl + '/chat/completions', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...(LOCAL_LLM.apiKey ? { Authorization: 'Bearer ' + LOCAL_LLM.apiKey } : {}) },
      body: JSON.stringify({ model, messages, temperature: 0.2, stream: false })
    });
  } catch (e) { throw { code: ctl.signal.aborted ? 'cancelled' : 'upstream_error', message: String(e) }; }
  finally { clearTimeout(timer); }
  if (!res.ok) throw { code: 'upstream_error', message: 'HTTP ' + res.status };
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  // reasoning models (Qwen3, DeepSeek-R1) put their thinking in <think> tags: drop it
  const text = String(choice && choice.message && choice.message.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!text) throw { code: 'empty_completion', message: 'The model returned no text' };
  return { text, truncated: choice.finish_reason === 'length' };
}
function parseJSONLoose(text) {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch {} }
  throw { code: 'invalid_json', message: 'Could not read JSON from the model', text };
}
// same shape as claude.ai's sample capability, so the rest of the app doesn't change
const localSample = Object.assign((input, opts) => localChat(input, opts), {
  json: async (input, opts) => parseJSONLoose((await localChat(input, opts)).text),
  limits: async () => (LOCAL_LLM.visionModel ? { images: { maxCount: 1 } } : {})
});
async function connectLocal() {
  if (!LOCAL_LLM.enabled) return false;
  try {
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(LOCAL_LLM.baseUrl + '/models', { signal: ctl.signal, headers: LOCAL_LLM.apiKey ? { Authorization: 'Bearer ' + LOCAL_LLM.apiKey } : {} });
    if (!r.ok) return false;
    const ids = ((await r.json()).data || []).map(m => m.id);
    // if the configured model isn't installed, fall back to whatever the server has loaded
    if (ids.length && !ids.includes(LOCAL_LLM.model)) LOCAL_LLM.model = ids.find(id => !/embed/i.test(id)) || ids[0];
    if (LOCAL_LLM.visionModel && ids.length && !ids.includes(LOCAL_LLM.visionModel)) LOCAL_LLM.visionModel = null;
    S.ai.sample = localSample;
    S.ai.images = !!LOCAL_LLM.visionModel;
    S.ai.name = `Local model (${LOCAL_LLM.model})`; S.ai.tag = 'Local AI';
    logAI({ task: 'Connected to a local model', via: 'claude', detail: `${LOCAL_LLM.model} at ${LOCAL_LLM.baseUrl}${S.ai.images ? `, photos with ${LOCAL_LLM.visionModel}` : ', no vision model, so photo reading is off'}.` });
    return true;
  } catch { return false; }
}
async function initAI() {
  let ok = false;
  try {
    if (window.claude && typeof window.claude.use === 'function') {
      const s = await window.claude.use('sample');
      if (s) {
        S.ai.sample = s; S.ai.name = 'Claude'; S.ai.tag = 'Claude';
        try { const lim = await s.limits(); S.ai.images = !!(lim && lim.images); } catch { S.ai.images = false; }
        ok = true;
      }
    }
  } catch { /* fall through to the local model */ }
  if (!ok) ok = await connectLocal();
  if (!ok) return;
  S.ai.ready = true;
  const photo = document.getElementById('heroPhoto'); if (photo && S.ai.images) photo.hidden = false;
  renderDrawer(true);
}

/* ---------- local reader (fallback when Claude isn't available) ---------- */
const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, a: 1, an: 1 };
function parseMoney(numStr, unit, ctxBig) {
  let v = parseFloat(String(numStr).replace(/,/g, ''));
  if (isNaN(v)) return null;
  unit = (unit || '').toLowerCase();
  if (unit.startsWith('k') || unit.startsWith('thousand') || unit === 'grand') v *= 1000;
  else if (unit.startsWith('m')) v *= 1e6;
  else if (ctxBig && v < 5000) v *= 1000;
  return Math.round(v);
}
function localParse(text) {
  const t = ' ' + text.toLowerCase().replace(/[’']/g, "'") + ' ';
  const out = {};
  const NUM = '\\$?\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k\\b|thousand|grand|m\\b|million)?';
  let m;
  if ((m = t.match(/\b(?:i'?m|i am|age|aged)\s+(\d{2})\b/)) || (m = t.match(/\b(\d{2})\s*(?:years? old|yo\b|y\/o)/))) out.age = Number(m[1]);
  const partner = /\b(married|wife|husband|partner|spouse|fianc)/.test(t);
  let kidCount = null;
  if ((m = t.match(/\b(\d|one|two|three|four|five|a|an)\s+(?:little\s+)?(kids?|children|child|sons?|daughters?|boys?|girls?|toddlers?|babies|baby)\b/))) kidCount = WORDNUM[m[1]] ?? Number(m[1]);
  let ages = null;
  if ((m = t.match(/(?:kids?|children|child|sons?|daughters?|ages?|aged)[^.()]{0,12}\(?\s*((?:\d{1,2}\s*(?:,|and|&|\/)?\s*){1,5})\)?/))) { const a = m[1].match(/\d{1,2}/g); if (a) ages = a.map(Number).filter(x => x <= 25); }
  if (ages && ages.length) out.kids = ages; else if (kidCount) out.kids = Array.from({ length: kidCount }, () => null);
  const kids = out.kids && out.kids.length;
  if (partner || kids) out.household = partner && kids ? 'partner_children' : partner ? 'partner' : 'children';
  if (/\b(single|just me|no kids|no children|on my own)\b/.test(t) && !partner && !kids) out.household = 'just_me';
  if ((m = t.match(new RegExp('(?:make|earn|salary|income|paid|bring in)[^\\d$.]{0,22}' + NUM)))) out.income = parseMoney(m[1], m[2], true);
  if (/\brent(ing)?\b/.test(t)) out.housing = 'rent';
  if ((m = t.match(new RegExp('(?:owe|mortgage|left on (?:the|our|my) (?:house|home))[^\\d$.]{0,30}' + NUM)))) { out.mortgage = parseMoney(m[1], m[2], true); out.housing = 'own_mortgage'; }
  else if (/paid off (?:the|our|my) (?:house|home)|own (?:it|our home|the house) outright/.test(t)) out.housing = 'own_outright';
  if ((m = t.match(new RegExp('(?:savings|saved|in the bank|emergency fund)[^\\d$.]{0,20}' + NUM))) || (m = t.match(new RegExp(NUM + '\\s*(?:in savings|saved|in the bank)')))) out.savings = parseMoney(m[1], m[2], true);
  if ((m = t.match(new RegExp(NUM + '\\s*(?:of |in )?(?:life insurance|coverage|life policy|policy)'))) || (m = t.match(new RegExp('(?:life insurance|coverage|policy)[^\\d$.]{0,30}' + NUM)))) {
    out.coverage = parseMoney(m[1], m[2], true);
    out.coverageSource = /(through|from|at|via) (work|my job|my employer)|employer|work policy|group/.test(t) ? 'work' : 'own';
  }
  if ((m = t.match(new RegExp('(?:car loan|student loan|credit card|other debt|debts?)[^\\d$.]{0,20}' + NUM)))) out.debts = parseMoney(m[1], m[2], true);
  if ((m = t.match(new RegExp('(?:wife|husband|partner|spouse)[^.]{0,25}(?:makes|earns|brings in)[^\\d$.]{0,10}' + NUM)))) out.partnerIncome = parseMoney(m[1], m[2], true);
  if (/\b(own|run|started|founded) (a|my|our) (own )?([a-z-]+ )?(business|company|firm|practice|agency|restaurant|shop|clinic)|\bbusiness owner|\bfounder\b|\bself-employed\b/.test(t)) out.businessOwner = true;
  if ((m = t.match(new RegExp('(?:invested|investments?|portfolio|net worth|brokerage)[^\\d$.]{0,24}' + NUM))) || (m = t.match(new RegExp(NUM + '\\s*(?:invested|in investments|in stocks|in the market|portfolio)')))) out.investments = parseMoney(m[1], m[2], true);
  if (/(house|home) is paid off|paid off (the|our|my) (house|home)|own (it|our home|the house|our house) outright|no mortgage/.test(t) && !out.mortgage) out.housing = 'own_outright';
  return out;
}
function sanitizeIntake(o) {
  const out = {}; if (!o || typeof o !== 'object') return out;
  const num = (v, lo, hi) => { if (v == null || v === '' || typeof v === 'boolean') return null; const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : null; };
  const a = num(o.age, 16, 95); if (a != null) out.age = a;
  if (['just_me', 'partner', 'children', 'partner_children', 'other'].includes(o.household)) out.household = o.household;
  if (Array.isArray(o.kids)) { const k = o.kids.map(x => x == null ? null : num(x, 0, 30)).slice(0, 8); if (k.length) out.kids = k; }
  for (const [key, hi] of [['income', 5e6], ['mortgage', 1e7], ['debts', 5e6], ['savings', 5e7], ['coverage', 5e7], ['partnerIncome', 5e6]]) { const v = num(o[key], 0, hi); if (v != null) out[key] = v; }
  if (['own_mortgage', 'own_outright', 'rent'].includes(o.housing)) out.housing = o.housing;
  if (['work', 'own', 'both'].includes(o.coverageSource)) out.coverageSource = o.coverageSource;
  if (o.businessOwner === true) out.businessOwner = true;
  { const v = num(o.investments, 0, 1e10); if (v != null) out.investments = v; }
  if (Array.isArray(o.priorities)) out.priorities = o.priorities.filter(x => ['home', 'income', 'kids', 'debts', 'time'].includes(x));
  if (out.mortgage && !out.housing) out.housing = 'own_mortgage';
  if (out.coverage && !out.coverageSource) out.coverageSource = 'own';
  if (out.kids && out.kids.length && !out.household) out.household = 'children';
  return out;
}
const INTAKE_PROMPT = text => `You extract facts for a life insurance needs calculator. Read the person's message and reply with ONLY a JSON object with exactly these keys. Use null for anything not clearly stated; never guess or fill in typical values.
{"age": number|null, "household": "just_me"|"partner"|"children"|"partner_children"|"other"|null, "kids": array of ages as numbers (use null for a child whose age isn't given) or null, "income": yearly dollars or null, "housing": "own_mortgage"|"own_outright"|"rent"|null, "mortgage": remaining balance in dollars or null, "debts": non-mortgage debt in dollars or null, "savings": dollars or null, "coverage": existing life insurance death benefit in dollars or null, "coverageSource": "work"|"own"|"both"|null, "partnerIncome": dollars or null, "businessOwner": true if they say they own or run a business, else null, "investments": dollars in investments or brokerage accounts (not the home) or null, "priorities": array using only "home","income","kids","debts","time" for things they explicitly say they worry about, or null}
Read "85k" as 85000 and "owe 240 on the house" as 240000. Married or a partner plus children means "partner_children".

Message:
"""${text.slice(0, 3000)}"""`;
async function readIntake(text) {
  const local = sanitizeIntake(localParse(text));
  if (!S.ai.sample) { logAI({ task: 'Read your description', via: 'local', detail: 'No AI model is connected, so the built-in reader picked out the details.' }); return local; }
  try {
    const raw = await S.ai.sample.json(INTAKE_PROMPT(text), { modelTier: 'quick' });
    const ai = sanitizeIntake(raw);
    for (const k of Object.keys(local)) if (ai[k] == null) ai[k] = local[k];
    logAI({ task: 'Read your description', via: 'claude', detail: `${aiName()} turned your words into ${Object.keys(ai).length} structured details. No math was done by the AI.`, data: ai });
    return ai;
  } catch (e) {
    logAI({ task: 'Read your description', via: 'local', detail: `${aiName()} couldn’t answer (${e && e.code || 'error'}), so the built-in reader was used.` });
    return local;
  }
}
function intakeChips(f) {
  const chips = [];
  if (f.age) chips.push(['age', `Age ${f.age}`]);
  if (f.household) { const k = (f.kids || []).filter(x => x != null); const n = (f.kids || []).length; chips.push(['household', { just_me: 'Just you', partner: 'You and a partner', children: 'Children', partner_children: 'Partner and children', other: 'Someone depends on you' }[f.household] + (n ? ` (${n} ${plural(n, 'child', 'children')}${k.length ? ': ' + listJoin(k.map(String)) : ''})` : '')]); }
  if (f.income) chips.push(['income', `Earns about ${fmtK(f.income)}`]);
  if (f.housing === 'rent') chips.push(['housing', 'Rents']);
  if (f.housing === 'own_outright') chips.push(['housing', 'Owns the home outright']);
  if (f.mortgage) chips.push(['mortgage', `${fmtK(f.mortgage)} left on the mortgage`]);
  if (f.debts) chips.push(['debts', `${fmtK(f.debts)} in other debts`]);
  if (f.savings != null && f.savings > 0) chips.push(['savings', `${fmtK(f.savings)} in savings`]);
  if (f.coverage) chips.push(['coverage', `${fmtK(f.coverage)} of life insurance${f.coverageSource === 'work' ? ' through work' : ''}`]);
  if (f.partnerIncome) chips.push(['partnerIncome', `Partner earns about ${fmtK(f.partnerIncome)}`]);
  if (f.investments) chips.push(['investments', `About ${fmtK(f.investments)} invested`]);
  if (f.businessOwner) chips.push(['businessOwner', 'Owns a business']);
  return chips;
}
function applyIntake(f) {
  const p = P();
  if (f.age) p.age = f.age;
  if (f.household) p.household = f.household;
  if (f.kids) { const k = f.kids.filter(x => x != null); if (k.length === f.kids.length) p.kids = k; }
  if (f.income) p.income = f.income;
  if (f.housing) p.housing = f.housing;
  if (f.mortgage) { p.mortgage = f.mortgage; p.housing = 'own_mortgage'; }
  if (f.debts != null) p.debts = f.debts;
  if (f.savings != null) p.savings = f.savings;
  if (f.coverage) { p.coverage = f.coverage; p.coverageSource = f.coverageSource || 'own'; }
  if (f.partnerIncome != null) p.partner.income = f.partnerIncome;
  if (f.businessOwner) p.businessOwner = true;
  if (f.investments) { p.assets = f.investments; if (p.savings == null) p.savings = f.investments; }
  if (f.priorities && f.priorities.length) p.priorities = f.priorities;
  renderStages(); refresh();
}
async function startFromText(text) {
  if (looksLikeQuestion(text) && !Object.keys(sanitizeIntake(localParse(text))).length) {
    await askQuestion(text);
    try { await say('Whenever you’re ready, let’s build your plan together. You can keep asking me anything along the way.'); } catch { return; }
    return run();
  }
  S.started = true; hideHero(); renderStages();
  meBubble(text, null);
  const tok = S.runId;
  const wait1 = say({ q: 'Let me read that…' }, { delay: 300 });
  const found = await readIntake(text);
  await wait1.catch(() => {});
  if (stale(tok)) return;
  const chips = intakeChips(found);
  if (!chips.length) { await say('I couldn’t pick out the details from that, so let’s go one question at a time.'); return run(); }
  await say(['Here’s what I caught.', { sub: 'Remove anything I got wrong. I’ll ask about the rest.' }]);
  const keep = new Set(chips.map(c => c[0]));
  let typedPick = false;
  const box = h('div', { class: 'widget' });
  const chipsEl = h('div', { class: 'chips' }, chips.map(([k, label]) => { const c = h('span', { class: 'chip' }, label, h('button', { type: 'button', 'aria-label': `Remove ${label}`, onclick: () => { keep.delete(k); c.remove(); } }, '×')); return c; }));
  const choice = await new Promise(resolve => {
    S.pending = { el: box, onText: t => {
      const s = t.toLowerCase();
      const pick = /walk|through|step|full|slow/.test(s) ? 'full' : /quick|fast|yes|right|correct|good|looks|ok|okay|yep|sure/.test(s) ? 'quick' : null;
      if (!pick || looksLikeQuestion(t)) return false;
      typedPick = true; resolve(pick); return true;
    } };
    box.append(h('div', { class: 'found' }, chipsEl),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => resolve('quick') }, 'Looks right, keep it quick'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => resolve('full') }, 'Looks right, walk me through it')));
    stream.append(box); scrollDown(true);
  });
  S.pending = null;
  if (stale(tok)) return;
  box.remove();
  const f = {}; for (const k of keep) { if (k === 'household') { f.household = found.household; f.kids = found.kids; } else if (k === 'housing') f.housing = found.housing; else if (k === 'coverage') { f.coverage = found.coverage; f.coverageSource = found.coverageSource; } else f[k] = found[k]; }
  if (!typedPick) meBubble(choice === 'quick' ? 'Looks right, keep it quick' : 'Looks right, walk me through it', null);
  applyIntake(f);
  S.quick = choice === 'quick';
  await say(S.quick ? 'Great. I’ll ask only what I still need and fill in common assumptions you can change later.' : 'Great. That saves us a few questions.');
  run();
}

/* ---------- photo of a benefits page or statement ---------- */
function drawSampleDoc() {
  const cv = document.getElementById('docCanvas'), g = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#1d3a5f'; g.fillRect(0, 0, W, 110);
  g.fillStyle = '#ffffff'; g.font = 'bold 34px Arial'; g.fillText('Northwind Logistics', 48, 64);
  g.font = '18px Arial'; g.fillText('Human Resources  |  Benefits Center', 48, 92);
  g.fillStyle = '#111'; g.font = 'bold 30px Arial'; g.fillText('2026 Benefits Confirmation Statement', 48, 170);
  g.font = '19px Arial'; g.fillStyle = '#333';
  g.fillText('Employee: Maya Rivera        Employee ID: 104882', 48, 212);
  g.fillText('Coverage period: January 1, 2026 – December 31, 2026', 48, 242);
  const rows = [
    ['Benefit', 'Election', 'Coverage', 'Your cost / pay period'],
    ['Medical', 'Blue PPO', 'Employee + Family', '$212.40'],
    ['Dental', 'Core Dental', 'Employee + Family', '$18.75'],
    ['Vision', 'Basic Vision', 'Employee + Family', '$6.10'],
    ['Basic Life Insurance', 'Company paid', '$100,000', '$0.00'],
    ['Supplemental Life', 'Not elected', '—', '—'],
    ['Basic AD&D', 'Company paid', '$100,000', '$0.00'],
    ['Short-Term Disability', 'Company paid', '60% of salary', '$0.00'],
    ['401(k) Plan', 'Enrolled', '6% contribution', '—']
  ];
  let y = 300; const cols = [48, 330, 560, 760];
  rows.forEach((r, i) => {
    if (i === 0) { g.fillStyle = '#eef2f7'; g.fillRect(40, y - 30, W - 80, 44); g.fillStyle = '#1d3a5f'; g.font = 'bold 18px Arial'; }
    else { g.fillStyle = i % 2 ? '#ffffff' : '#fafbfc'; g.fillRect(40, y - 30, W - 80, 44); g.fillStyle = '#222'; g.font = '18px Arial'; }
    r.forEach((c, j) => g.fillText(c, cols[j], y));
    g.strokeStyle = '#e1e5ea'; g.beginPath(); g.moveTo(40, y + 14); g.lineTo(W - 40, y + 14); g.stroke();
    y += 52;
  });
  g.fillStyle = '#555'; g.font = '16px Arial';
  const notes = ['Basic Life Insurance pays your beneficiaries for death from any cause.', 'AD&D pays only for accidental death or dismemberment.', 'Coverage ends on your last day of employment unless converted or ported.', 'Questions? benefits@northwind.example  |  1-800-555-0142'];
  notes.forEach((n, i) => g.fillText(n, 48, y + 30 + i * 30));
  return new Promise(res => cv.toBlob(b => res(b), 'image/png'));
}
function photoButton(purpose, done) {
  return h('button', { class: 'btn quiet photo-btn', type: 'button', onclick: async () => {
    const res = await photoFlow(purpose);
    if (res && done) { const v = purpose === 'mortgage' ? res.mortgageBalance : res.lifeInsurance; if (v) done(v); }
  } }, '📷 Read it from a photo');
}
function pickImage() {
  return new Promise(resolve => {
    const inp = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', style: { display: 'none' } });
    inp.addEventListener('change', () => { resolve(inp.files && inp.files[0] || null); inp.remove(); });
    document.body.append(inp); inp.click();
  });
}
const PHOTO_PROMPT = `This image is a document someone shared with a life insurance needs tool. It may be an employee benefits statement, a life insurance policy page, or a mortgage statement. Reply with ONLY a JSON object:
{"documentType": "benefits"|"policy"|"mortgage"|"other", "lifeInsurance": total LIFE insurance death benefit in dollars that pays for death from any cause, or null. Do NOT include AD&D or accidental death coverage, and do not include supplemental coverage marked as not elected, "source": "work"|"own"|null, "mortgageBalance": current principal balance in dollars or null, "excluded": one short plain sentence naming anything you deliberately did not count and why, or null, "portability": one short plain sentence if the document says coverage ends when employment ends, or null}`;
async function photoFlow(purpose) {
  const tok = S.runId;
  const choice = await new Promise(resolve => {
    const done = v => { box.remove(); S.pending = null; resolve(v); };
    const box = h('div', { class: 'widget' }, h('div', { class: 'opts' },
      optButton({ icon: '📁', label: 'Choose a photo' }, () => done('pick')),
      optButton({ icon: '📄', label: 'Use a sample benefits page' }, () => done('sample')),
      optButton({ label: 'Never mind' }, () => done(null))));
    S.pending = { el: box, onText: t => { const s = t.toLowerCase(); const v = /sample|example|demo/.test(s) ? 'sample' : /never ?mind|cancel|skip|^no\b/.test(s) ? null : /choose|upload|my own|mine|pick/.test(s) ? 'pick' : undefined; if (v === undefined || looksLikeQuestion(t)) return false; meBubble(t, null); done(v); return true; } };
    stream.append(box); scrollDown(true);
  });
  if (!choice) return null;
  const blob = choice === 'sample' ? await drawSampleDoc() : await pickImage();
  if (!blob || stale(tok)) return null;
  const url = URL.createObjectURL(blob);
  meBubble(h('img', { class: 'thumb', src: url, alt: 'Your document' }), null, '📷 Shared a document photo');
  const pending = say({ q: 'Reading your document…' }, { delay: 300 });
  let out = null;
  try {
    out = await S.ai.sample.json(PHOTO_PROMPT, { images: blob, modelTier: 'quick' });
    logAI({ task: 'Read a document photo', via: 'claude', detail: `${aiName()} read the image and returned the coverage and balances it found. The photo is not stored.`, data: out });
  } catch (e) {
    logAI({ task: 'Read a document photo', via: 'local', detail: `${aiName()} couldn’t read the image (${e && e.code || 'error'}).` });
  }
  await pending.catch(() => {});
  if (stale(tok)) return null;
  if (!out || (!out.lifeInsurance && !out.mortgageBalance)) { await say('I couldn’t find a clear coverage amount or balance in that image. Could you enter it instead?'); return null; }
  const p = P(); const msgs = [];
  const life = Number(out.lifeInsurance), bal = Number(out.mortgageBalance);
  if (life > 0) { p.coverage = Math.round(life); p.coverageSource = out.source === 'own' ? 'own' : 'work'; msgs.push(`I found **${fmt(life)}** of life insurance${p.coverageSource === 'work' ? ' through your employer' : ''}.`); }
  if (bal > 0) { p.mortgage = Math.round(bal); p.housing = 'own_mortgage'; if (!p.mortgagePlan) p.mortgagePlan = 'full'; msgs.push(`Your mortgage balance is about **${fmtK(bal)}**.`); }
  if (out.excluded) msgs.push(esc(String(out.excluded)).slice(0, 240));
  if (life > 0 && p.coverageSource === 'work') msgs.push(out.portability ? esc(String(out.portability)).slice(0, 240) + ' I’ll show your plan both with and without it.' : 'Coverage through work usually ends if you leave the job, so I’ll show your plan both with and without it.');
  refresh();
  const g = guard(msgs.join(' ')); logAI({ task: 'Checked figures in that message', via: 'guard', pass: g.ok, detail: `${g.checks.length} figure(s) matched against your plan.` });
  await say(msgs);
  return { lifeInsurance: life > 0 ? life : null, mortgageBalance: bal > 0 ? bal : null };
}

/* ---------- asking LincolnLens anything ---------- */
function contextForAI() {
  const p = P(), c = compute(p), L = [];
  L.push(`Household: ${householdText(p) || 'not given yet'}${p.age ? `; age ${p.age}` : ''}${p.income ? `; yearly income ${fmt(p.income)}` : ''}.`);
  if (c.items.length) L.push('Needs in the plan: ' + c.items.map(i => `${i.label} ${fmt(i.amount)}${i.annual ? ` (${fmt(i.annual)} a year, ${fmt(i.annual / 12)} a month)` : ''}`).join('; ') + `. Total need ${fmt(c.need)}.`);
  if (c.res.length) L.push('Already in place: ' + c.res.map(r => `${r.label} ${fmt(r.amount)}${r.counted ? '' : ' (not counted)'}`).join('; ') + '.');
  L.push(`Still to cover: ${fmt(c.gap)}. Round target: ${fmt(c.tiers.balanced)}. Essentials: ${fmt(c.tiers.essential)}. More cushion: ${fmt(c.tiers.more)}.`);
  const C = S.coverage;
  if (C) {
    const s = simulate(p, C), R = tradeoffs(p, C);
    L.push(`Coverage the person is exploring: ${fmt(C)}. ${reactionText(p, C).replace(/\*\*/g, '')}`);
    L.push(`Suggested term length ${R.tp.T} years. Illustrative monthly cost: term ${rangeTxt(R.term)}, whole life ${rangeTxt(R.whole)}.${R.tp.ladder ? ` Ladder option: ${fmt(R.tp.ladder.long.amount)} for ${R.tp.ladder.long.years} years plus ${fmt(R.tp.ladder.short.amount)} for ${R.tp.ladder.short.years} years.` : ''}`);
    if (s.leftover > 1000) L.push(`Left over at the end: ${fmt(s.leftover)}.`);
  }
  if (hasPartner(p) && p.partner.depends && p.partner.depends !== 'no') { const pc = compute(partnerProfile(p)); L.push(`Partner side: need ${fmt(pc.need)}, still to cover ${fmt(pc.gap)}.`); }
  if (p.savings) L.push(`Savings: ${fmt(p.savings)} total; ${p.savingsUse != null ? `${fmt(p.savingsUse)} set aside toward the plan` : 'not yet decided how much to use'}${p.cvDeposit ? `; ${fmt(p.cvDeposit)} deposited into whole life cash value` : ''}.`);
  const rc = riskClass(p.health); L.push(rc.known ? `Estimated price class: ${rc.cls.name} (an estimate, final class set by the insurer).` : 'Health details not shared; prices assume average health.');
  if (p.policy && C) {
    const q = premium(p, C, p.policy.type, p.policy.years);
    L.push(`Chosen policy: ${policyName(p.policy)} for ${fmt(C)}, about ${rangeTxt(q)} a month.${p.policy.type === 'whole' ? ` Illustrative cash value after 20 years: ${fmt(cashValueAt(p, C, 20).cv)}.` : ''}`);
  }
  if (wealthProfile(p).tier) L.push('Permanent options shown to this person: guaranteed universal life, indexed universal life, survivorship life, long-term care benefits, and trust ownership. Speak about them in general terms and suggest a licensed professional and tax advisor.');
  L.push(`Term life: relatively low premium for a set period (10, 20 or 30 years); pays the death benefit if the person passes away during the term; generally no cash value. Whole life: permanent; part of the premium supports the insurance and costs, part builds cash value.`);
  L.push(`Assumptions: income support replaces ${pct(S.A.replace)} of income; money grows ${pct(S.A.rate, 1)} a year above inflation; work coverage ${S.A.countWork ? 'is' : 'is not'} counted.`);
  return L.join('\n');
}
const QA_RULES = (ctx, current, opts) => `You are LincolnLens, a warm, knowledgeable assistant inside a life insurance planning app. The person can ask you anything at any point: about their plan, life insurance, money, health, how the app works, or something else entirely.
Reply with ONLY one JSON object and nothing else: {"reply": "...", "action": null}

"reply": 1 to 4 short sentences of plain text. No markdown, no lists.
- About their plan: use only dollar figures that appear in PLAN FIGURES, written the same way. Never calculate new dollar amounts.
- General questions (insurance, money, health, the app, or anything else): answer helpfully and briefly. For amounts that aren't in PLAN FIGURES, use words or percentages instead of dollar figures.
- If they need a professional (legal, tax, medical, or buying a specific policy), say so briefly and name the right kind of professional.
- If you can't help with something, say so in one sentence and point them to what you can do here.
- Tone: warm and steady, never alarming. Say "if you weren't here" rather than "death" or "die".

"action": when they tell you a fact about themselves, ask to change something, or ask to see or try something, return ONE of these. Otherwise null.
{"type":"update","field":F,"value":V}  F is one of: age, income, mortgage, debts, savings, savingsUse, existingCoverage, cushion, educationPerKid, childcareAnnual, incomeYears, kids, partnerIncome, partnerAge. V is dollars or years as a number ("85k" means 85000), "grown" for incomeYears, or an array of ages for kids. Only use values they actually stated.
{"type":"policy","value":"term10"|"term20"|"term30"|"whole"}
{"type":"coverage","value":number}   a coverage amount they want to try
{"type":"show","value":"plan"|"timeline"|"amounts"|"policy"|"price"|"options"|"family"|"scenarios"|"numbers"}
{"type":"scenario","value":"baby"|"home"|"raise"|"jobs"|"payoff"|"save"|"partner"|"joblost"|"illness"|"market"|"expense"|"inflation"|"carer","amount":optional number of months, dollars or percent}
{"type":"health"}    they want to share health details for a sharper price
{"type":"newPlan"}   they want to start a new plan
{"type":"answer","value":V}   use this when their message answers the question the app is asking right now (see below)
${current ? `\nThe app is currently asking them: "${current}".${opts ? ` ${opts}` : ''} If their message answers it, return the "answer" action. If they ask something else instead, just answer; the question stays open.\n` : ''}
If they mention suicide or self-harm, or seem to be in crisis, respond with care first, tell them they can call or text 988 (in the US) any time, and don't discuss how policies handle suicide.
Example: {"reply":"Done. Your plan now uses your new income.","action":{"type":"update","field":"income","value":95000}}

PLAN FIGURES AND FACTS
${ctx}`;

/* ---------- what the assistant is allowed to change ---------- */
const UPDATES = {
  age: { min: 18, max: 90, set: (p, v) => { p.age = v; }, say: v => `your age to ${v}` },
  income: { min: 0, max: 5e6, money: true, set: (p, v) => { p.income = v; }, say: v => `your income to ${fmtK(v)}` },
  mortgage: { min: 0, max: 1e7, money: true, set: (p, v) => { p.mortgage = v; if (v > 0) { p.housing = 'own_mortgage'; if (!p.mortgagePlan || p.mortgagePlan === 'none') p.mortgagePlan = 'full'; } else p.mortgagePlan = 'none'; }, say: v => `your mortgage to ${fmtK(v)}` },
  debts: { min: 0, max: 5e6, money: true, set: (p, v) => { p.debts = v; }, say: v => `your other debts to ${fmtK(v)}` },
  savings: { min: 0, max: 5e7, money: true, set: (p, v) => { p.savings = v; if (p.savingsUse != null) p.savingsUse = Math.min(p.savingsUse, v); if (p.cvDeposit) p.cvDeposit = Math.min(p.cvDeposit, remainingSavings(p)); }, say: v => `your savings to ${fmtK(v)}` },
  savingsUse: { min: 0, max: 5e7, money: true, set: (p, v) => { p.savingsUse = Math.min(v, p.savings || 0); }, say: v => `the savings set aside for this plan to ${fmtK(v)}` },
  existingCoverage: { min: 0, max: 5e7, money: true, set: (p, v) => { p.coverage = v; if (!p.coverageSource || ['no', 'unsure'].includes(p.coverageSource)) p.coverageSource = v ? 'own' : 'no'; }, say: v => `the life insurance you already have to ${fmtK(v)}` },
  cushion: { min: 0, max: 500000, money: true, set: (p, v) => { p.cushion = v; }, say: v => `your cushion to ${fmtK(v)}` },
  educationPerKid: { min: 0, max: 500000, money: true, set: (p, v) => { p.educationPerKid = v; p.kidGoals = [...new Set([...(p.kidGoals || []).filter(x => x !== 'none'), 'education'])]; }, say: v => `education to ${fmtK(v)} per child` },
  childcareAnnual: { min: 0, max: 100000, money: true, set: (p, v) => { p.childcareAnnual = v; p.kidGoals = [...new Set([...(p.kidGoals || []).filter(x => x !== 'none'), 'childcare'])]; }, say: v => `childcare to ${fmtK(v)} a year` },
  incomeYears: { min: 1, max: 40, set: (p, v) => { p.incomeYearsChoice = v; p.incomeYears = v === 'grown' ? null : v; }, say: v => v === 'grown' ? 'income support to last until your kids are grown' : `income support to ${v} years` },
  kids: { set: (p, v) => { p.kids = v; if (v.length && !kidsHousehold(p)) p.household = hasPartner(p) ? 'partner_children' : 'children'; }, say: v => `your children’s ages to ${listJoin(v.map(String))}` },
  partnerIncome: { min: 0, max: 5e6, money: true, set: (p, v) => { p.partner.income = v; }, say: v => `your partner’s income to ${fmtK(v)}` },
  partnerAge: { min: 18, max: 90, set: (p, v) => { p.partner.age = v; }, say: v => `your partner’s age to ${v}` }
};
const SHOW_CARDS = { timeline: 'timeline', amounts: 'sandbox', policy: 'policy', price: 'risk', options: 'wealth', family: 'family', scenarios: 'explore' };
const SHOW_NAMES = { timeline: 'your year-by-year timeline', amounts: 'the coverage slider', policy: 'your policy', price: 'your price class', options: 'the premium options', family: 'your household’s two plans', scenarios: 'the scenarios', plan: 'your plan', numbers: '“Behind the numbers”' };
/* validate and carry out one action; returns what to tell the person and what to do after the reply shows */
function applyAction(act) {
  if (!act || typeof act !== 'object') return null;
  const p = P(), type = act.type;
  if (type === 'update') {
    const spec = UPDATES[act.field]; if (!spec) return null;
    let v = act.value;
    if (act.field === 'kids') {
      if (!Array.isArray(v)) return null;
      v = v.map(Number).filter(x => Number.isFinite(x) && x >= 0 && x <= 25).map(Math.round).slice(0, 8);
      if (!v.length) return null;
    } else if (act.field === 'incomeYears' && v === 'grown') {
      if (!hasKids(p)) return null;
    } else {
      v = typeof v === 'string' ? parseMoney(v.replace(/[^\d.,kKmM]/g, '').replace(/([kKmM])$/, ''), (String(v).match(/([kKmM])$/) || [])[1] || '', false) : Number(v);
      if (!Number.isFinite(v) || v < spec.min || v > spec.max) return { note: `I couldn’t use that ${act.field === 'age' ? 'age' : 'amount'}, so nothing changed.` };
      v = Math.round(v);
    }
    const prev = clone(p), prevCov = S.coverage, prevTier = S.tierPick;
    spec.set(p, v);
    return { note: `Updated ${spec.say(v)}. Your plan has been recalculated.`, undo: () => { S.p = prev; S.coverage = prevCov; S.tierPick = prevTier; }, values: [v], answered: true };
  }
  if (type === 'policy') {
    const map = { term10: { type: 'term', years: 10 }, term20: { type: 'term', years: 20 }, term30: { type: 'term', years: 30 }, whole: { type: 'whole' } };
    const pol = map[act.value]; if (!pol) return null;
    if (!(S.coverage > 0)) return { note: 'Once your coverage amount is set, I can switch the policy type.' };
    const prev = clone(p);
    p.policy = pol; if (pol.type !== 'whole') p.cvDeposit = null;
    return { note: `Switched your policy to ${policyName(pol).toLowerCase()}.`, undo: () => { S.p = prev; }, after: () => showCard('policy'), answered: true };
  }
  if (type === 'coverage') {
    const v = Number(act.value); if (!Number.isFinite(v) || v < 10000 || v > 5e7) return null;
    const prevCov = S.coverage, prevTier = S.tierPick;
    S.coverage = roundTo(v, 10000); S.tierPick = null;
    return { note: `Now exploring ${fmtK(S.coverage)} of coverage.`, undo: () => { S.coverage = prevCov; S.tierPick = prevTier; }, values: [S.coverage], after: () => showCard('timeline') || showCard('sandbox') };
  }
  if (type === 'show') {
    const t = act.value; if (!SHOW_NAMES[t]) return null;
    if (t === 'numbers') return { note: `Opening ${SHOW_NAMES[t]}.`, after: openDrawer };
    if (t === 'plan') return { note: 'Your plan is in the panel.', after: () => { if (matchMedia('(max-width: 960px)').matches) { $('#panel').classList.add('up'); $('#sheetBar').setAttribute('aria-expanded', 'true'); } else pulse($('#panel')); } };
    if (!stream.querySelector(`.card[data-kind="${SHOW_CARDS[t]}"]`)) return { note: `${cap(SHOW_NAMES[t])} will appear once we get there in the conversation.` };
    return { note: `Here’s ${SHOW_NAMES[t]}.`, after: () => showCard(SHOW_CARDS[t]) };
  }
  if (type === 'scenario') {
    const ev = ALL_EVENTS.find(x => x.k === act.value); if (!ev) return null;
    const card = stream.querySelector('.card[data-kind="explore"]');
    if (!card) return { note: 'What-if scenarios open up once your plan is ready, and we’re getting close.' };
    if (ev.when && !ev.when(p)) return { note: 'That scenario doesn’t apply to your plan yet.' };
    return { note: `Opening the “${eventLabel(ev.k, p)}” scenario.`, after: () => card.dispatchEvent(new CustomEvent('ll-scenario', { detail: { k: ev.k, amount: act.amount != null ? Number(act.amount) : null } })) };
  }
  if (type === 'health') {
    if (healthShared(p.health)) return { note: 'You’ve already shared health details. Your price class is in the plan.' };
    return { note: 'Starting a few health questions.', after: () => personalizeHealth('you', true) };
  }
  if (type === 'newPlan') return { note: 'Starting a fresh plan. This one stays saved in your list.', after: () => setTimeout(() => { flushSave(); startBlank(); }, 900) };
  return null;
}
function showCard(kind) {
  const el = stream.querySelector(`.card[data-kind="${kind}"]`); if (!el) return false;
  el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }); pulse(el); return true;
}
function pulse(el) { if (!el) return; el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); setTimeout(() => el.classList.remove('pulse'), 1600); }

/* why each question matters, for "why are you asking?" without a model */
const WHY = {
  household: 'Who depends on you decides what your plan needs to protect.',
  kids: 'Your kids’ ages tell me how long your family may rely on your income and when school costs arrive.',
  age: 'Your age shapes how long your plan needs to last and what coverage costs.',
  income: 'Your income is the paycheck your family would need replaced, usually the biggest piece of the plan.',
  priorities: 'It tells me which goals to build your plan around.',
  housing: 'The home is often the largest single cost, so it can make up a big part of the plan.',
  mortgagePlan: 'Paying off the mortgage removes the biggest monthly bill, but it isn’t the only option.',
  mortgage: 'The balance tells me how much it would take to keep the home.',
  incomeYears: 'This sets how long your plan replaces your paycheck.',
  debts: 'Debts your family would still owe add to what they’d need.',
  kidGoals: 'These are costs your family would still face for the kids.', education: 'This is the school money you’d like ready for each child.', childcare: 'Childcare is a cost that would continue for years.',
  cushion: 'Costs come up in the first months, and a cushion keeps your family from scrambling.',
  savings: 'Money you already have can lower what insurance needs to provide.', savingsUse: 'Only the savings you choose to put toward the plan lower what you need; the rest stays your safety net.',
  coverageHave: 'Coverage you already have counts toward your target.', coverageAmt: 'Coverage you already have counts toward your target.',
  feel: 'There’s no single right amount; this sets the level you want to explore.',
  healthGate: 'Health doesn’t change what your family needs, only the price. Insurers price by health class.',
  policyType: 'Term and whole life cost very different amounts and work differently, so this shapes your estimate.',
  cvDeposit: 'A deposit into cash value grows it faster and can raise the death benefit.',
  lifelong: 'If something should last your whole life, permanent coverage may fit better than term.'
};
/* understands the most common requests without any AI model */
function localIntent(q) {
  const t = ' ' + q.toLowerCase().replace(/[’']/g, "'") + ' ';
  const NUMR = '\\$?\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k\\b|thousand|grand|m\\b|million)?';
  const p = P(); let m;
  if (/\b(why (do|are|did) you (ask|need|want)|why does (this|that) matter|why is this (needed|important))/.test(t)) {
    const id = S.active && S.active.node.id; const base = id && id.replace(/^ph?(?=[A-Z])/, '');
    return { reply: (id && (WHY[id] || (/^ph?[A-Z]/.test(id) ? WHY.healthGate : null) || (id.startsWith('p') ? 'Your partner’s side shows what your household would need if they weren’t here.' : null))) || 'Each answer adds a piece to your plan, and you can change any of them later.' };
  }
  if (/\b(start over|new plan|start (a )?(new|fresh)|from scratch)\b/.test(t)) return { action: { type: 'newPlan' } };
  if (/\b(add|share|enter|personali[sz]e|use)\b[^.]*\bhealth\b|\bhealth (details|info)/.test(t) && !/\bwhat|why|how\b/.test(t)) return { action: { type: 'health' } };
  if (/\b(what if|what happens|suppose|scenario|simulate|stress test)\b/.test(t)) {
    const SC = [[/lose (my )?job|laid off|fired|unemploy/, 'joblost'], [/\b(sick|ill\b|illness|injur|cancer|disab|hospital|can't work)/, 'illness'], [/\b(baby|pregnan|another (kid|child))/, 'baby'], [/\b(market|stocks?|crash|investments? (drop|fall))/, 'market'], [/\binflation|prices (go|keep|rising|rise)/, 'inflation'], [/\b(parent|mom|dad|mother|father)\b/, 'carer'], [/\b(bill|unexpected expense|emergency)/, 'expense'], [/\b(bigger|new) (home|house)|\bmove\b|buy a (home|house)/, 'home'], [/\bpay off\b/, 'payoff'], [/\b(change|switch|new) jobs?\b/, 'jobs'], [/\bpartner (stops|quits)|stay.at.home/, 'partner'], [/\braise\b|\bpromot/, 'raise'], [/save more|more savings/, 'save']];
    for (const [re, k] of SC) if (re.test(t)) {
      const mm = t.match(/(\d+)\s*months?/) || t.match(new RegExp(NUMR)) ; let amount = null;
      if (mm) amount = /months?/.test(mm[0]) ? Number(mm[1]) : parseMoney(mm[1], mm[2], ['home', 'raise', 'save', 'expense'].includes(k));
      return { action: { type: 'scenario', value: k, amount } };
    }
  }
  if ((m = t.match(/\b(10|20|30|ten|twenty|thirty)[- ]year/)) && /\b(switch|change|try|go with|want|use|make it|pick|prefer|choose)\b/.test(t)) return { action: { type: 'policy', value: 'term' + ({ ten: 10, twenty: 20, thirty: 30 }[m[1]] || m[1]) } };
  if (/\b(switch|change|try|go with|want|use|make it|pick|prefer|choose)\b[^.]*\bwhole life\b/.test(t)) return { action: { type: 'policy', value: 'whole' } };
  if ((m = t.match(new RegExp('(?:coverage|cover|insure|insurance)[^\\d$]{0,18}' + NUMR))) && /\b(try|see|show|what about|change|set|make it|go with|bump|raise|lower|explore)\b/.test(t) && !/\b(have|got|already|through work|at work)\b/.test(t)) return { action: { type: 'coverage', value: parseMoney(m[1], m[2], true) } };
  if ((m = t.match(new RegExp('(?:raise|income|salary|make|making|earn|earning|paid|pay is)[^\\d$.]{0,25}' + NUMR)))) return { action: { type: 'update', field: 'income', value: parseMoney(m[1], m[2], true) } };
  if ((m = t.match(new RegExp('(?:mortgage|owe on the (?:house|home)|left on the (?:house|home))[^\\d$.]{0,25}' + NUMR)))) return { action: { type: 'update', field: 'mortgage', value: parseMoney(m[1], m[2], true) } };
  if ((m = t.match(new RegExp('(?:life insurance|policy|coverage)[^\\d$.]{0,25}' + NUMR))) && /\b(have|got|already|through work|at work|existing)\b/.test(t)) return { action: { type: 'update', field: 'existingCoverage', value: parseMoney(m[1], m[2], true) } };
  if ((m = t.match(new RegExp('(?:savings|saved|in the bank)[^\\d$.]{0,25}' + NUMR))) || (m = t.match(new RegExp(NUMR + '\\s*(?:in savings|saved)')))) return { action: { type: 'update', field: 'savings', value: parseMoney(m[1], m[2], true) } };
  if ((m = t.match(new RegExp('(?:debts?|loans?|credit cards?)[^\\d$.]{0,25}' + NUMR)))) return { action: { type: 'update', field: 'debts', value: parseMoney(m[1], m[2], true) } };
  if ((m = t.match(/\b(?:i'?m|i am|my age is|age is|turned|turning)\s+(\d{2})\b/))) return { action: { type: 'update', field: 'age', value: Number(m[1]) } };
  if (/\b(show|open|see|take me|go to|where('s| is)|view|pull up)\b/.test(t)) {
    const SH = [[/timeline|year by year|year-by-year/, 'timeline'], [/slider|different amounts|amounts/, 'amounts'], [/price class|health class|risk class/, 'price'], [/my policy|policy/, 'policy'], [/options|universal|estate|survivorship/, 'options'], [/family|partner/, 'family'], [/scenarios?|what.ifs?|compare/, 'scenarios'], [/numbers|math|calculation|behind|formula/, 'numbers'], [/plan|summary|panel/, 'plan']];
    for (const [re, k] of SH) if (re.test(t)) return { action: { type: 'show', value: k } };
  }
  // a bare number while a money or age question is waiting
  if (S.active && (m = t.match(new RegExp('^\\s*' + NUMR + '\\s*$')))) {
    const id = S.active.node.id, map = { age: 'age', income: 'income', mortgage: 'mortgage', debts: 'debts', savings: 'savings', savingsUse: 'savingsUse', coverageAmt: 'existingCoverage', cushion: 'cushion', childcare: 'childcareAnnual', pAge: 'partnerAge' };
    if (map[id]) return { action: { type: 'update', field: map[id], value: map[id].endsWith('ge') ? Number(m[1]) : parseMoney(m[1], m[2], true) } };
  }
  return null;
}
/* ---------- answering the current question in words ---------- */
const looksLikeQuestion = t => /\?\s*$/.test(t) || /^\s*(what|why|how|when|where|who|which|should|can|could|is|are|does|do|will|would|tell me|explain)\b/i.test(t);
const STOP = new Set(['the', 'a', 'an', 'it', 'of', 'to', 'my', 'me', 'i', 'and', 'or', 'with', 'for', 'our', 'your', 'is', 'are', 'be', 'this', 'that', 'them', 'they', 'these', 'at', 'in', 'on', 'im', 'we', 'us', 'so', 'just', 'please', 'think', 'guess', 'probably', 'maybe', 'like', 'would', 'about']);
const GENERIC = new Set(['keeping', 'replacing', 'giving', 'leaving', 'time', 'family', 'help', 'decide', 'sure', 'yes', 'these', 'support', 'running', 'caring', 'member', 'major', 'any', 'one', 'all', 'apply']);
const SYN = { children: 'child', kid: 'child', son: 'child', daughter: 'child', spouse: 'partner', wife: 'partner', husband: 'partner', married: 'partner', house: 'home', renting: 'rent', owning: 'own', smoke: 'yes', smoker: 'yes' };
const toks = s => String(s).toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter(w => w && (w.length > 2 || /^\d+$/.test(w) || w === 'no') && !STOP.has(w)).map(w => w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w).map(w => SYN[w] || w);
function nodeOptions(node) {
  const w = typeof node.widget === 'function' ? node.widget(P()) : node.widget;
  if (!w) return null;
  if (w.type === 'choice' || w.type === 'multi') return { kind: w.type, options: w.options.filter(o => o.v !== undefined).map(o => ({ value: o.v, label: o.label + (o.small ? ` (${o.small})` : ''), exclusive: !!o.exclusive })), custom: w.options.some(o => o.then) };
  if (w.type === 'band') return { kind: 'money', options: w.bands.map(b => ({ value: b.v, label: b.label })) };
  if (w.type === 'amount') return { kind: w.money === false ? 'number' : 'money', min: w.min, max: w.hardMax || (w.money === false ? w.max : w.max * 4) };
  if (w.type === 'kids') return { kind: 'ages' };
  if (w.type === 'hw') return { kind: 'hw' };
  return null;
}
function optionsForPrompt(node) {
  const o = nodeOptions(node); if (!o) return '';
  if (o.kind === 'choice') return `Its choices are ${JSON.stringify(o.options.map(x => ({ value: x.value, label: x.label })))}; for "answer", value must be one of these values${o.custom ? ' (or a dollar amount as a number)' : ''}.`;
  if (o.kind === 'multi') return `Its choices are ${JSON.stringify(o.options.map(x => ({ value: x.value, label: x.label })))}; for "answer", value is an array of these values.`;
  if (o.kind === 'money') return 'For "answer", value is a dollar amount as a number.';
  if (o.kind === 'number') return 'For "answer", value is a number.';
  if (o.kind === 'ages') return 'For "answer", value is an array of the children’s ages.';
  if (o.kind === 'hw') return 'For "answer", value is {"ft":5,"inch":7,"lb":160}, or "na" if they’d rather not say.';
  return '';
}
function validateAnswer(node, v) {
  const o = nodeOptions(node); if (!o) return { ok: false };
  const num = x => typeof x === 'number' ? x : typeof x === 'string' && /^\$?[\d,.]+[km]?$/i.test(x.trim()) ? parseMoney(x.replace(/[$km]/gi, ''), (x.match(/[km]$/i) || [''])[0], false) : NaN;
  if (o.kind === 'choice') {
    const hit = o.options.find(x => String(x.value) === String(v));
    if (hit) return { ok: true, v: hit.value };
    const n = num(v); if (o.custom && Number.isFinite(n) && n >= 0 && n < 1e8) return { ok: true, v: Math.round(n) };
    return { ok: false };
  }
  if (o.kind === 'multi') {
    const arr = (Array.isArray(v) ? v : [v]).map(String), vals = o.options.filter(x => arr.includes(String(x.value)));
    if (!vals.length) return { ok: false };
    const ex = vals.find(x => x.exclusive);
    return { ok: true, v: ex ? [ex.value] : vals.map(x => x.value) };
  }
  if (o.kind === 'money' || o.kind === 'number') { const n = num(v); return Number.isFinite(n) && n >= (o.min || 0) && n <= (o.max || 1e9) ? { ok: true, v: Math.round(n) } : { ok: false }; }
  if (o.kind === 'ages') { const arr = (Array.isArray(v) ? v : []).map(Number).filter(x => Number.isFinite(x) && x >= 0 && x <= 25).map(Math.round).slice(0, 8); return arr.length ? { ok: true, v: arr } : { ok: false }; }
  if (o.kind === 'hw') {
    if (v === 'na') return { ok: true, v: 'na' };
    if (v && v.ft >= 4 && v.ft <= 7 && v.inch >= 0 && v.inch <= 11 && v.lb >= 70 && v.lb <= 600) return { ok: true, v: { ft: Math.round(v.ft), inch: Math.round(v.inch), lb: Math.round(v.lb) } };
    return { ok: false };
  }
  return { ok: false };
}
/* without a model: match typed words to the current question's choices */
function localChoose(node, text) {
  const o = nodeOptions(node); if (!o) return null;
  const t = text.toLowerCase().replace(/[’']/g, "'");
  const NUMR = '\\$?\\s?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(k\\b|thousand|grand|m\\b|million)?';
  if (o.kind === 'hw') {
    if (/prefer not|rather not|skip/.test(t)) return 'na';
    const hm = t.match(/(\d)\s*(?:'|ft|feet|foot)\s*(\d{1,2})?/), wm = t.match(/(\d{2,3})\s*(?:lb|lbs|pounds)/) || t.match(/(?:weigh\w*|,)\s*(\d{2,3})\b/);
    return hm && wm ? { ft: +hm[1], inch: +(hm[2] || 0), lb: +wm[1] } : null;
  }
  if (o.kind === 'ages') { const a = (t.match(/\b\d{1,2}\b/g) || []).map(Number).filter(x => x <= 25); return a.length ? a : null; }
  if (o.kind === 'money' || o.kind === 'number') {
    if (o.kind === 'money' && (o.min || 0) === 0 && /^\s*(none|nothing|zero|no|nope|not really|n\/a)\b/.test(t)) return 0;
    const m = t.match(new RegExp(NUMR)); if (!m) return null;
    return o.kind === 'number' ? Number(m[1]) : typedMoney(m);
  }
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const said = norm(t);
  if (o.options && said) {
    const exact = o.options.find(x => norm(x.label) === said);
    if (exact) return o.kind === 'multi' ? [exact.value] : exact.value;
  }
  const words = new Set(toks(t));
  const has = w => words.has(w);
  if (o.kind === 'multi') {
    if (/\b(none|nothing|neither|no one)\b/.test(t)) { const ex = o.options.find(x => x.exclusive && /none|nothing/i.test(x.label)); if (ex) return [ex.value]; }
    if (/not sure|help me decide|don'?t know/.test(t)) { const ex = o.options.find(x => x.exclusive && /sure/i.test(x.label)); if (ex) return [ex.value]; }
    const hits = o.options.filter(x => !x.exclusive && toks(x.label).filter(w => !GENERIC.has(w)).some(has));
    return hits.length ? hits.map(x => x.value) : null;
  }
  // single choice: yes/no shortcuts, then best word overlap
  const short = t.trim().split(/\s+/).length <= 3;
  if (short && /^\s*(yes|yeah|yep|sure|ok|okay|definitely|of course)\b/.test(t)) { const ys = o.options.filter(x => /^(yes|definitely)/i.test(x.label)); if (ys.length === 1) return ys[0].value; }
  if (short && /^\s*(no|nope|nah)\b/.test(t) && !/^\s*no\s+(idea|clue)/.test(t)) { const ns = o.options.filter(x => /^(no\b|not now)/i.test(x.label)); if (ns.length === 1) return ns[0].value; }
  if (/not sure|don'?t know|no idea|unsure/.test(t)) { const u = o.options.find(x => /not sure|unsure/i.test(x.label)); if (u) return u.value; }
  const scored = o.options.map(x => { const ow = toks(x.label); const m = ow.filter(has).length; return { x, s: m ? m + m / ow.length : 0 }; }).sort((a, b) => b.s - a.s);
  if (scored[0] && scored[0].s >= 1 && (!scored[1] || scored[0].s - scored[1].s > 0.2)) return scored[0].x.value;
  if (o.custom) { const m = t.match(new RegExp(NUMR)); if (m) return typedMoney(m); }
  return null;
}
/* "85k" and "$85,000" are taken as written; a bare "240" is read as thousands */
function typedMoney(m) {
  const raw = m[0], v = parseMoney(m[1], m[2], false);
  if (m[2] || /\$|,/.test(raw) || v >= 1000) return v;
  return v * 1000;
}
/* a fixed, careful reply if someone may be in distress; never left to a model */
const CRISIS = /\b(kill(ing)? (myself|me)|suicid|end (my life|it all)|take my (own )?life|want to die|don'?t want to (live|be here)|self.?harm|hurt(ing)? myself|better off without me)/i;
const CRISIS_REPLY = 'I’m really sorry you’re dealing with this. You don’t have to go through it alone. In the US, you can call or text 988 any time to reach the Suicide & Crisis Lifeline. If you’re in immediate danger, please call 911. I’m here if you want to keep talking, and your plan will be here whenever you want to come back to it.';

function renderSuggest() {
  const el = document.getElementById('suggest'); if (!el) return;
  el.innerHTML = '';
  if (!S.started) return;
  const p = P(), ready = !!stream.querySelector('.card[data-kind="explore"]');
  const items = ready ? [
    'What if I lose my job?',
    p.policy ? (p.policy.type === 'whole' ? 'Switch to a 20-year term' : 'Switch to whole life') : null,
    p.income ? `I got a raise to ${fmtK(roundTo(p.income * 1.1, 5000))}` : null,
    'Show me the timeline'
  ] : S.active ? ['Why do you ask this?', 'What’s term vs whole life?'] : [];
  for (const t of items.filter(Boolean)) el.append(h('button', { class: 'chip', type: 'button', onclick: () => askQuestion(t) }, t));
}

function localAnswer(q) {
  const p = P(), c = compute(p), C = S.coverage || c.tiers.balanced, t = q.toLowerCase();
  const R = C ? tradeoffs(p, C) : null;
  if (/ad&d|ad and d|accident/.test(t)) return 'AD&D, accidental death and dismemberment, only pays if the cause is an accident. That’s why it isn’t counted as life insurance in your plan, even when it’s listed next to it on a benefits page.';
  if (/work|employer|job|group/.test(t)) return p.coverage && p.coverageSource === 'work' ? `Your ${fmtK(p.coverage)} through work counts today, but it usually ends if you leave the job, retire or are laid off. You can turn it off in your plan to see the number without it.` : 'Coverage through work usually ends when the job does, so it’s worth knowing how much depends on it. If you have some, add it in your plan and you can switch it on or off.';
  if (/ladder/.test(t)) return R && R.tp.ladder ? `A ladder splits coverage into policies that end at different times: here, ${fmtK(R.tp.ladder.long.amount)} for ${R.tp.ladder.long.years} years plus ${fmtK(R.tp.ladder.short.amount)} for ${R.tp.ladder.short.years} years. Your coverage steps down as your needs shrink, which usually costs less than one big policy.` : 'A ladder splits coverage into a few term policies that end at different times, so coverage steps down as your needs shrink. It usually costs less than one large policy.';
  if (/(term|whole).*(vs|or|versus|difference|better)|(difference|better).*(term|whole)/.test(t)) return R ? `Term covers a set number of years and costs much less: roughly ${rangeTxt(R.term)} a month here. Whole life lasts your whole life and builds cash value, but costs much more, roughly ${rangeTxt(R.whole)} a month. ${R.verdict}` : 'Term covers a set number of years and costs much less. Whole life lasts your whole life and builds cash value, but costs much more for the same amount.';
  if (/class|preferred|standard|health|smok|nicotine|weight|bmi/.test(t)) { const rc = riskClass(p.health); return rc.known ? `Your estimated price class is ${rc.cls.name}. Insurers group applicants by health so people with similar risk pay similar prices. The final class comes after an application, often with a short exam.` : 'Insurers group applicants into price classes, like Preferred or Standard, based on things like nicotine use, weight, blood pressure and family history. Share a few health details and I can estimate yours.'; }
  if (/universal|iul|gul|survivorship|second.to.die|trust|ilit|estate/.test(t)) return 'Universal life is permanent coverage with more flexibility than whole life. Guaranteed universal life focuses on a lasting death benefit at a lower cost, indexed universal life links cash value growth to a market index with a floor, and survivorship life covers two people and pays after the second. People often use them for estate planning, ideally with a licensed professional and a tax advisor.';
  if (/whole|cash value|permanent|invest/.test(t)) return 'Whole life lasts your whole life and builds a cash value that grows slowly and steadily. It costs much more than term for the same protection, so it tends to make sense when you want coverage that never ends or have already used other ways to save.';
  if (/term/.test(t)) return R ? `Term life covers you for a set number of years, ${R.tp.T} here, which lines up with when your family relies on you most. If you’re still here when it ends, it simply stops, which is why it costs much less.` : 'Term life covers you for a set number of years and costs much less than whole life.';
  if (/cost|price|premium|afford|per month|monthly|expensive/.test(t)) return R ? `As a rough illustration, ${fmtK(C)} of ${R.tp.T}-year term might be ${rangeTxt(R.term)} a month. Real prices depend on your health and the insurer, so treat this as a ballpark.` : 'Once we’ve worked out your coverage target, I can show a rough monthly range.';
  if (/why|how.*(number|calculat|get|come)|where.*(number|come)|explain/.test(t)) return c.items.length ? `Your plan adds up ${listJoin(c.items.map(i => `${i.label.toLowerCase()} (${fmtK(i.amount)})`))}, for ${fmtK(c.need)} in total.${c.have ? ` What you already have covers ${fmtK(c.have)}, leaving ${fmtK(c.gap)}.` : ''} Tap any line in your plan to see how it was worked out.` : 'Your number is built from what your family would need, minus what you already have. Answer a few questions and I’ll show each piece.';
  if (/saving|401|ira|retire/.test(t)) return p.savings ? `Your ${fmtK(p.savings)} in savings lowers what insurance needs to cover, dollar for dollar. Retirement accounts are left out unless you include them, since many families would rather not touch them.` : 'Savings your family could use lower what insurance needs to cover, dollar for dollar. Retirement accounts are usually left out.';
  if (/partner|spouse|wife|husband|stay.?at.?home/.test(t)) return 'A partner who earns less, or provides childcare and runs the household, still needs a plan. Replacing that care can be one of the biggest costs a family faces, and it’s the one most often missed.';
  if (/reduc|lower|smaller|less/.test(t)) return 'The biggest levers are how many years of income support you want, whether to pay off the whole mortgage, and how much savings your family could use. Try changing those, or explore life changes, to watch the number move.';
  return 'I’m best with your plan and life insurance. I can explain any number, update an answer (“I got a raise to 95k”), show any part of your plan (“show me the timeline”), or run a what-if (“what if I lose my job?”). For anything else, connect an AI model and I can answer more broadly.';
}
async function askQuestion(q) {
  q = q.trim(); if (!q) return;
  if (!S.started) { S.started = true; hideHero(); renderStages(); }
  const tok = S.runId;
  meBubble(q, null);
  S.qa.push({ role: 'user', content: q });
  const wrap = h('div', { class: 'msg ll' }, markEl(), h('div', { class: 'body' }, h('div', { class: 'typing', role: 'status', 'aria-label': 'LincolnLens is writing' }, h('i'), h('i'), h('i'))));
  stream.append(wrap); scrollDown(true);
  if (CRISIS.test(q)) {
    const body = wrap.querySelector('.body'); body.innerHTML = '';
    renderParts(body, [CRISIS_REPLY]); S.log.push({ t: 'll', parts: [CRISIS_REPLY] }); S.qa.push({ role: 'assistant', content: CRISIS_REPLY });
    logAI({ task: 'Responded with support resources', via: 'local', detail: 'A message suggested distress, so LincolnLens gave a fixed, caring reply instead of a model answer.' });
    scheduleSave(); scrollDown(true); return;
  }
  if (S.pending && S.pending.onText && S.pending.onText(q)) { wrap.remove(); return; }
  const currentQ = S.active ? (() => { const a = S.active.node.ask(P()); const x = Array.isArray(a) ? (a.filter(y => y && y.q).pop() || a[0]) : a; return String(typeof x === 'string' ? x : (x.q || '')).replace(/\*\*/g, ''); })() : '';
  let reply = null, action = null, via = 'local';
  // a clear command is handled instantly, even with a model connected
  const quick = localIntent(q);
  const typedAnswer = S.active && !looksLikeQuestion(q) ? localChoose(S.active.node, q) : null;
  if (quick && quick.action && quick.action.type !== 'update' && quick.action.type !== 'coverage') { action = quick.action; reply = quick.reply || ''; }
  else if (S.ai.sample) {
    try {
      const turns = [{ role: 'user', content: QA_RULES(contextForAI(), currentQ, S.active ? optionsForPrompt(S.active.node) : '') }, ...S.qa.slice(-8)];
      const out = await S.ai.sample.json(turns, { modelTier: 'quick', cache: false });
      reply = String((out && out.reply) || '').trim(); action = out && out.action && typeof out.action === 'object' ? out.action : null; via = 'claude';
    } catch (e) {
      if (e && e.code === 'invalid_json' && e.text) { reply = String(e.text).trim(); via = 'claude'; }
      else logAI({ task: 'Answer a question', via: 'local', detail: `${aiName()} couldn’t answer (${e && e.code || 'error'}), so a built-in answer was used.` });
    }
  } else if (!S.ai.log.some(l => l.task === 'Answer a question')) {
    logAI({ task: 'Answer a question', via: 'local', detail: 'No AI model is connected, so LincolnLens used its built-in answers.' });
  }
  if (reply == null || (!reply && !action)) {
    if (typedAnswer != null) { action = { type: 'answer', value: typedAnswer }; reply = ''; }
    else if (quick) { action = quick.action || null; reply = quick.reply || ''; } else reply = localAnswer(q);
  }
  // small models sometimes skip the action; if the built-in reader clearly understood it, use that
  else if (!action && typedAnswer != null) action = { type: 'answer', value: typedAnswer };
  else if (!action && quick && quick.action) action = quick.action;
  if (stale(tok)) return;
  // carry out the action first, so the reply can be checked against the updated plan
  let res, answerNode = null, answerVal;
  if (action && action.type === 'answer') {
    const chk = S.active ? validateAnswer(S.active.node, action.value) : { ok: false };
    if (chk.ok) { answerNode = S.active.node; answerVal = chk.v; res = { note: `Got it: ${answerNode.label(answerVal, P())}.` }; }
    else res = S.active ? { note: 'I couldn’t match that to this question, so pick an option below or try other words.' } : null;
  } else res = applyAction(action);
  if (res && res.undo || (res && action && action.type === 'update')) refresh();
  const extra = res && res.values ? res.values.filter(v => typeof v === 'number') : [];
  if (!reply) reply = res ? '' : 'Okay.';
  const g = guard(reply, [...allowedFigures(), ...extra]);
  let html = '';
  if (g.ok) html = esc(reply);
  else { let last = 0; for (const ch of g.checks) { html += esc(reply.slice(last, ch.index)); html += ch.ok ? esc(ch.raw) : '<span class="redact" title="Removed: this figure didn’t match your plan">a figure I removed</span>'; last = ch.index + ch.raw.length; } html += esc(reply.slice(last)); }
  const body = wrap.querySelector('.body'); body.innerHTML = '';
  const note = g.checks.length ? (g.ok ? `✓ ${g.checks.length} ${plural(g.checks.length, 'figure', 'figures')} checked against your plan` : `${g.checks.filter(c => !c.ok).length} figure didn’t match your plan, so I removed it`) : null;
  const parts = [reply ? { html } : null, res && res.note ? { note: res.note } : null, note ? { note } : null];
  renderParts(body, parts);
  if (res && res.undo) {
    const undo = h('button', { class: 'linkish small-link', type: 'button', onclick: () => { res.undo(); refresh(); undo.textContent = 'Undone'; undo.disabled = true; } }, 'Undo');
    body.append(undo);
  }
  S.log.push({ t: 'll', parts: logParts(parts) });
  S.qa.push({ role: 'assistant', content: reply || (res && res.note) || 'Okay.' });
  scheduleSave();
  logAI({ task: 'Answer a question', via, detail: `“${q.slice(0, 80)}”${action ? ` → action: ${action.type}${action.field ? ' ' + action.field : ''}${action.value != null && typeof action.value !== 'object' ? ' ' + action.value : ''}` : ''}`, pass: g.ok, checks: g.checks.length });
  scrollDown(true);
  if (res && res.after) setTimeout(res.after, 350);
  // a typed answer to the waiting question moves the conversation on
  if (answerNode && S.active && S.active.node === answerNode) { S.active.choose(answerVal); return; }
  if (S.active && res && res.answered && S.active.node.known && S.active.node.known(P())) { S.active.skip(); return; }
  if (S.active && S.active.node.id === 'policyType' && res && action && action.type === 'policy') { S.active.skip(); return; }
  if (S.active && S.active.wEl && S.active.wEl.isConnected) { await wait(250); stream.append(S.active.qEl, S.active.wEl); if (!(res && res.after)) scrollDown(true); }
  else if (S.pending && S.pending.el && S.pending.el.isConnected) { await wait(250); stream.append(S.pending.el); scrollDown(true); }
}

/* ======================================================================
   Behind the numbers drawer
   ====================================================================== */
let drawerOpen = false;
function renderDrawer(soft) {
  if (!drawerOpen) return;
  const body = $('#drawerBody');
  const active = document.activeElement;
  if (soft && active && body.contains(active) && active.type === 'range') { const t = $('#assumeText'); if (t) t.textContent = assumeText(); return; }
  body.innerHTML = '';
  const p = P(), c = compute(p);
  // Status
  body.append(h('h3', null, 'AI status'), h('p', null, S.ai.sample ? `${aiName()} is connected${S.ai.images ? ' and can read photos' : ''}. It reads what you type and explains, but never calculates.` : 'No AI model is connected. LincolnLens is using its built-in reader and answers, and every number still comes from the same calculation.'));
  // Calculation
  body.append(h('h3', null, 'How the number is built'));
  if (!c.items.length) body.append(h('p', null, 'Nothing yet. Answer a question and each piece appears here with its formula.'));
  else {
    const tb = h('table', { class: 'kv' });
    for (const it of c.items) tb.append(h('tr', null, h('td', null, h('b', null, it.label), h('div', { style: { color: 'var(--ink-2)', fontWeight: 400 } }, it.why)), h('td', null, fmt(it.amount))));
    tb.append(h('tr', null, h('td', null, 'Total need'), h('td', null, fmt(c.need))));
    for (const r of c.res) tb.append(h('tr', null, h('td', null, r.label + (r.counted ? '' : ' (not counted)')), h('td', null, '−' + fmt(r.counted ? r.amount : 0))));
    tb.append(h('tr', null, h('td', null, 'Still to cover'), h('td', null, fmt(c.gap))));
    tb.append(h('tr', null, h('td', null, 'Tiers: essentials, balanced, more cushion'), h('td', null, `${fmtK(c.tiers.essential)} / ${fmtK(c.tiers.balanced)} / ${fmtK(c.tiers.more)}`)));
    body.append(h('div', { class: 'scroll-x' }, tb));
  }
  // Assumptions
  const rep = h('input', { type: 'range', min: 50, max: 100, step: 5, value: Math.round(S.A.replace * 100), 'aria-label': 'Share of income to replace' });
  const rate = h('input', { type: 'range', min: 0, max: 5, step: 0.5, value: S.A.rate * 100, 'aria-label': 'Growth above inflation' });
  rep.addEventListener('input', () => { S.A.replace = Number(rep.value) / 100; refresh(); });
  rate.addEventListener('input', () => { S.A.rate = Number(rate.value) / 100; refresh(); });
  const work = h('input', { type: 'checkbox', checked: S.A.countWork ? true : null });
  work.addEventListener('change', () => { S.A.countWork = work.checked; refresh(); });
  body.append(h('h3', null, 'Assumptions you can change'),
    h('div', { class: 'assume' },
      h('label', null, 'Share of income to replace', h('span', { id: 'repV' }, pct(S.A.replace))), rep,
      h('label', null, 'Yearly growth above inflation', h('span', { id: 'rateV' }, pct(S.A.rate, 1))), rate,
      h('label', { style: { justifyContent: 'flex-start', gap: '8px' } }, work, 'Count coverage through work')),
    h('p', { id: 'assumeText' }, assumeText()));
  rep.addEventListener('input', () => { $('#repV').textContent = pct(S.A.replace); });
  rate.addEventListener('input', () => { $('#rateV').textContent = pct(S.A.rate, 1); });
  // Guard test
  const out = h('div');
  body.append(h('h3', null, 'The number guard'),
    h('p', null, 'Before any AI message is shown, every dollar figure in it is compared with the figures in your plan. Anything that doesn’t match is removed.'),
    h('button', { class: 'btn small secondary', type: 'button', onclick: () => {
      const allowed = allowedFigures(); let wrong = roundTo((c.need || 500000) * 0.91 + 13000, 1000);
      while (allowed.some(a => Math.abs(a - wrong) <= Math.max(600, a * 0.02))) wrong += 17000;
      const it = c.items[0];
      const sentence = it ? `Your plan needs ${fmt(wrong)} in total, including ${fmt(it.amount)} for ${it.label.toLowerCase()}.` : `Your plan needs ${fmt(wrong)} in total.`;
      const g = guard(sentence, allowed);
      S.guardTest = { sentence, checks: g.checks };
      logAI({ task: 'Number guard test', via: 'guard', pass: g.ok, detail: `Planted ${fmt(wrong)}; ${g.ok ? 'missed' : 'caught'}.` });
      renderDrawer();
    } }, 'Test it with a wrong number'), out);
  if (S.guardTest) out.append(h('p', null, h('b', null, 'Test sentence: '), S.guardTest.sentence), ...S.guardTest.checks.map(ch => h('div', { class: 'logline' }, h('span', { class: 'tag ' + (ch.ok ? 'pass' : 'fail') }, ch.ok ? 'Matches plan' : 'Caught'), `${ch.raw} ${ch.ok ? 'appears in your plan.' : 'isn’t in your plan, so it would be removed.'}`)));
  // Log
  body.append(h('h3', null, 'AI activity'));
  if (!S.ai.log.length) body.append(h('p', null, 'Nothing yet.'));
  for (const l of S.ai.log.slice(0, 20)) {
    body.append(h('div', { class: 'logline' },
      h('span', { class: 'tag ' + (l.via === 'claude' ? 'claude' : l.via === 'guard' ? (l.pass ? 'pass' : 'fail') : 'local') }, l.via === 'claude' ? (S.ai.tag || 'Claude') : l.via === 'guard' ? 'Guard' : 'Built-in'),
      l.pass != null && l.via !== 'guard' ? h('span', { class: 'tag ' + (l.pass ? 'pass' : 'fail') }, l.pass ? 'Figures verified' : 'Figure removed') : null,
      h('b', null, l.task), ' ', l.detail || '',
      l.data ? h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '.78rem', background: 'var(--surface-2)', padding: '8px', borderRadius: '8px', margin: '6px 0 0' } }, JSON.stringify(l.data, null, 1)) : null));
  }
  // Profile
  body.append(h('h3', null, 'What LincolnLens knows'));
  const kv = h('table', { class: 'kv' });
  const rows = [['Household', householdText(p)], ['Age', p.age], ['Income', p.income && fmt(p.income)], ['Home', p.housing && ({ own_mortgage: 'Own, mortgage', own_outright: 'Own outright', rent: 'Rent' })[p.housing]], ['Mortgage', p.mortgage && fmt(p.mortgage)], ['Other debts', p.debts != null ? fmt(p.debts) : null], ['Savings', p.savings != null ? `${fmt(p.savings)}${p.savingsUse != null ? `, ${fmt(p.savingsUse)} toward the plan` : ''}` : null], ['Policy', p.policy ? policyName(p.policy) : null], ['Life insurance', p.coverage != null ? `${fmt(p.coverage)}${p.coverageSource === 'work' ? ' (work)' : ''}` : null], ['Health details', healthShared(p.health) ? `Shared, kept on this page only (estimated ${riskClass(p.health).cls.name})` : 'Not shared']];
  for (const [k, v] of rows) if (v) kv.append(h('tr', null, h('td', null, k), h('td', null, String(v))));
  body.append(kv, h('p', null, 'Plans are saved only in this browser. Health answers are never saved. Delete a plan from the list to remove it.'));
  body.append(h('h3', null, 'Method and sources'),
    h('p', null, 'LincolnLens uses a standard needs-based approach, sometimes called DIME: debts, income, mortgage and education, minus what you already have. Future costs are turned into today’s dollars using the growth rate above.'),
    h('ul', { style: { paddingLeft: '18px', margin: '6px 0' } }, Object.values(SOURCES).map(s => h('li', { style: { fontSize: '.9rem', margin: '4px 0' } }, h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', style: { color: 'var(--brand)' } }, s.label)))));
}
function assumeText() { return `Income support replaces ${pct(S.A.replace)} of income, and money set aside grows ${pct(S.A.rate, 1)} a year above inflation. Lower growth means a bigger number.`; }
function openDrawer() { drawerOpen = true; $('#drawerWrap').classList.add('open'); $('#drawerWrap').setAttribute('aria-hidden', 'false'); renderDrawer(); $('#drawerWrap .close').focus(); }
function closeDrawer() { drawerOpen = false; $('#drawerWrap').classList.remove('open'); $('#drawerWrap').setAttribute('aria-hidden', 'true'); $('#openWork').focus(); }


export { CRISIS, CRISIS_REPLY, GENERIC, INTAKE_PROMPT, LOCAL_LLM, PHOTO_PROMPT, QA_RULES, SHOW_CARDS, SHOW_NAMES, STOP, SYN, UPDATES, WHY, WORDNUM, aiName, applyAction, applyIntake, askQuestion, assumeText, blobToDataURL, closeDrawer, connectLocal, contextForAI, drawSampleDoc, drawerOpen, initAI, intakeChips, localAnswer, localChat, localChoose, localIntent, localParse, localSample, logAI, looksLikeQuestion, nodeOptions, openDrawer, optionsForPrompt, parseJSONLoose, parseMoney, photoButton, photoFlow, pickImage, pulse, readIntake, renderDrawer, renderSuggest, sanitizeIntake, showCard, startFromText, toMessages, toks, typedMoney, validateAnswer };
