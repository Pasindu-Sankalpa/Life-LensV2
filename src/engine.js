import { annuityDue, clamp, fmt, pct, plural, roundTo, roundUp, sum } from './dom.js';
import { P, S } from './state.js';

/* ======================================================================
   Household helpers
   ====================================================================== */
const kidsOf = p => (p.kids || []).filter(a => a <= 22);
const hasKids = p => kidsOf(p).length > 0;
const hasPartner = p => p.household === 'partner' || p.household === 'partner_children';
const youngestAge = p => hasKids(p) ? Math.min(...kidsOf(p)) : null;
const hasDependents = p => p.household && p.household !== 'just_me';
function kidName(p, i) {
  const ks = kidsOf(p); if (ks.length === 1) return 'your child';
  const sorted = ks.map((a, j) => [a, j]).sort((x, y) => y[0] - x[0]);
  const rank = sorted.findIndex(s => s[1] === i);
  if (rank === 0) return 'your oldest';
  if (rank === ks.length - 1) return 'your youngest';
  if (ks.length === 3) return 'your middle child';
  return `your ${ks[i]}-year-old`;
}
function resolvedIncomeYears(p) {
  if (!p.income || !hasDependents(p)) return 0;
  if (p.incomeYearsChoice === 'grown') return hasKids(p) ? Math.max(1, 18 - youngestAge(p)) : 10;
  return p.incomeYears || 0;
}
function householdText(p) {
  const k = kidsOf(p).length;
  const kidsTxt = k ? `${k} ${plural(k, 'child', 'children')}${k ? ` (${kidsOf(p).join(' and ')})` : ''}` : '';
  switch (p.household) {
    case 'just_me': return 'Just you';
    case 'partner': return 'You and your partner';
    case 'children': return `You and ${kidsTxt || 'your children'}`;
    case 'partner_children': return `Partner and ${kidsTxt || 'children'}`;
    case 'other': return 'Someone else depends on you';
    default: return '';
  }
}

/* ======================================================================
   Calculation engine (deterministic, no AI)
   ====================================================================== */
function compute(p, A = S.A) {
  const r = A.rate, items = [], kids = kidsOf(p);
  if (p.cushion) items.push({ key: 'cushion', label: 'Immediate costs', amount: p.cushion, lump: true,
    why: `A cushion for the first months: final expenses, time away from work, travel and anything unexpected. Set aside as-is.` });
  if (p.debts) items.push({ key: 'debts', label: 'Other debts', amount: p.debts, lump: true,
    why: `Car loans, student loans and cards, about ${fmt(p.debts)}. Clearing them means no extra monthly payments to juggle.` });
  if (p.housing === 'own_mortgage' && p.mortgage && p.mortgagePlan && p.mortgagePlan !== 'none') {
    const share = p.mortgagePlan === 'full' ? 1 : 0.5, amt = p.mortgage * share;
    items.push({ key: 'home', label: share === 1 ? 'Pay off the home' : 'Help with the home', amount: amt, lump: true,
      why: share === 1 ? `Your ${fmt(p.mortgage)} mortgage, paid off so the monthly payment disappears.` : `Half of your ${fmt(p.mortgage)} mortgage. It shrinks the monthly payment without covering all of it.` });
  }
  const yrs = resolvedIncomeYears(p);
  if (p.income && yrs) {
    const annual = p.income * A.replace, pv = annual * annuityDue(yrs, r);
    items.push({ key: 'income', label: `Income for ${yrs} ${plural(yrs, 'year', 'years')}`, amount: pv, annual, years: yrs, recurring: true, raw: annual * yrs,
      why: `${fmt(annual)} a year, which is ${pct(A.replace)} of your income (your own personal costs would go away). Over ${yrs} ${plural(yrs, 'year', 'years')} that's ${fmt(annual * yrs)}. The money can be invested carefully while it's used (we assume ${pct(r, 1)} a year above inflation), so about ${fmt(pv)} today covers it.` });
  }
  if (p.educationPerKid && kids.length) {
    const per = kids.map((age, i) => { const t = Math.max(0, 18 - age); return { i, age, t, v: p.educationPerKid / Math.pow(1 + r, t) }; });
    const pv = sum(per, x => x.v);
    items.push({ key: 'education', label: 'Education', amount: pv, per, nominal: p.educationPerKid * kids.length,
      why: `${fmt(p.educationPerKid)} for each child, ready when they turn 18. ` + per.map(x => x.t > 0 ? `For ${kidName(p, x.i)}, that’s ${x.t} ${plural(x.t, 'year', 'years')} away, so about ${fmt(x.v)} set aside today grows into it.` : `For ${kidName(p, x.i)}, it’s needed now.`).join(' ') });
  }
  if (p.childcareAnnual && kids.length) {
    const cy = Math.max(0, 13 - youngestAge(p));
    if (cy > 0) { const pv = p.childcareAnnual * annuityDue(cy, r);
      items.push({ key: 'childcare', label: `Childcare for ${cy} ${plural(cy, 'year', 'years')}`, amount: pv, annual: p.childcareAnnual, years: cy, recurring: true,
        why: `${fmt(p.childcareAnnual)} a year until your youngest turns 13 (${cy} ${plural(cy, 'year', 'years')}), adjusted the same way as income.` }); }
  }
  for (const x of (p.extras || [])) {
    if (!x.annual || !x.years) continue;
    const pv = x.annual * annuityDue(x.years, r);
    items.push({ key: x.key, label: x.label, amount: pv, annual: x.annual, years: x.years, recurring: true, why: x.why });
  }
  const need = sum(items, i => i.amount);
  const res = [];
  if (p.savings) {
    const decided = p.savingsUse != null;
    const use = decided ? Math.min(p.savingsUse, p.savings) : p.savings;
    const kept = Math.max(0, p.savings - (decided ? use : 0) - (p.cvDeposit || 0));
    if (!decided) res.push({ key: 'savings', label: 'Savings (deciding how much to use)', amount: p.savings, counted: false,
      why: `You have about ${fmt(p.savings)} in savings. Nothing is counted until you choose how much should go toward this plan.` });
    else if (use > 0) res.push({ key: 'savings', label: 'Savings set aside for this plan', amount: use, counted: true,
      why: `You chose to put ${fmt(use)} of your ${fmt(p.savings)} in savings toward your family’s needs.${p.cvDeposit ? ` ${fmt(p.cvDeposit)} goes into your policy’s cash value.` : ''}${kept ? ` ${fmt(kept)} stays as your emergency fund.` : ''}` });
    else res.push({ key: 'savings', label: 'Savings kept as an emergency fund', amount: p.savings, counted: false,
      why: `You chose to keep your ${fmt(p.savings)} in savings separate, so none of it lowers the insurance you need.` });
  }
  if (p.coverage) {
    const work = p.coverageSource === 'work';
    res.push({ key: 'coverage', label: work ? 'Life insurance through work' : p.coverageSource === 'both' ? 'Life insurance you have now' : 'Your own life insurance', amount: p.coverage, work, counted: !(work && !A.countWork) });
  }
  const have = sum(res.filter(x => x.counted), x => x.amount);
  const gap = Math.max(0, need - have);
  // tiers
  const essNeed = sum(items.filter(i => i.lump), i => i.amount) + (p.income && yrs ? p.income * A.replace * annuityDue(Math.min(yrs, 5), r) : 0);
  let balanced = gap > 0 ? roundUp(gap, 50000) : 0;
  let essential = Math.max(0, roundTo(Math.max(0, essNeed - have), 50000));
  if (essential >= balanced) essential = Math.max(0, Math.floor(balanced * 0.65 / 50000) * 50000);
  let more = balanced ? Math.max(balanced + 100000, roundUp(balanced * 1.25, 50000)) : 0;
  return { items, need, res, have, gap, yrs, tiers: { essential, balanced, more } };
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* year-by-year money flow for a chosen coverage amount */
const PRIO = { cushion: 0, debts: 1, home: 2, childcare: 3, care: 4, household: 4, income: 5, education: 6 };
function obligations(p, c) {
  const list = [];
  for (const it of c.items) {
    if (it.lump) list.push({ t: 0, key: it.key, amount: it.amount, label: it.label });
    else if (it.recurring) for (let t = 0; t < it.years; t++) list.push({ t, key: it.key, amount: it.annual, label: it.label });
    else if (it.key === 'education') for (const k of it.per) list.push({ t: k.t, key: 'education', amount: p.educationPerKid, kid: k.i, label: 'Education' });
  }
  return list;
}
function simulate(p, coverage, A = S.A) {
  const c = compute(p, A), obs = obligations(p, c), r = A.rate;
  const T = obs.length ? Math.max(...obs.map(o => o.t)) + 1 : 1;
  let bal = coverage + c.have; const start = bal;
  const years = [], tot = {};
  let runOut = null;
  for (let t = 0; t < T; t++) {
    const due = obs.filter(o => o.t === t).sort((a, b) => (PRIO[a.key] ?? 5) - (PRIO[b.key] ?? 5));
    const paid = [], balStart = bal;
    for (const o of due) {
      const pay = Math.min(bal, o.amount); bal -= pay; if (bal < 1) bal = 0;
      paid.push({ ...o, paid: pay });
      const k = tot[o.key] || (tot[o.key] = { due: 0, paid: 0 }); k.due += o.amount; k.paid += pay;
      if (pay < o.amount - 50 && runOut == null) runOut = t;
    }
    years.push({ t, balStart, paid, balAfter: bal });
    bal *= (1 + r);
  }
  const goals = c.items.map(it => { const k = tot[it.key] || { due: 0, paid: 0 }; return { key: it.key, label: it.label, due: k.due, paid: k.paid, pct: k.due ? Math.min(1, k.paid / k.due) : 1, item: it }; });
  const incomeFull = years.filter(y => y.paid.some(o => o.key === 'income' && o.paid >= o.amount - 50)).length;
  const leftover = years.length ? years[years.length - 1].balAfter : start;
  return { c, years, goals, tot, runOut, incomeFull, leftover, start, T };
}

/* how the need shrinks over time (for term vs whole) */
function needAt(p, t, A = S.A) {
  const r = A.rate; let n = 0; const y = youngestAge(p);
  if (p.cushion) n += p.cushion;
  if (p.debts) n += p.debts * Math.max(0, 1 - t / 5);
  if (p.housing === 'own_mortgage' && p.mortgage && p.mortgagePlan && p.mortgagePlan !== 'none')
    n += p.mortgage * (p.mortgagePlan === 'full' ? 1 : .5) * Math.max(0, 1 - t / 25);
  const N = resolvedIncomeYears(p);
  if (p.income && N) {
    let rem;
    if (p.incomeYearsChoice === 'grown') rem = Math.max(0, N - t);
    else if (hasKids(p)) rem = Math.min(N, Math.max(0, (22 - y) - t));
    else if (hasPartner(p)) rem = Math.min(N, Math.max(0, (65 - (p.age || 40)) - t));
    else rem = Math.min(N, Math.max(0, 15 - t));
    if (rem > 0) n += p.income * A.replace * annuityDue(Math.ceil(rem), r);
  }
  if (p.educationPerKid) for (const age of kidsOf(p)) { const tk = Math.max(0, 18 - age); if (t <= tk) n += p.educationPerKid / Math.pow(1 + r, tk - t); }
  if (p.childcareAnnual && hasKids(p)) { const rem = Math.max(0, (13 - y) - t); if (rem > 0) n += p.childcareAnnual * annuityDue(rem, r); }
  for (const x of (p.extras || [])) { const rem = Math.max(0, x.years - t); if (rem > 0) n += x.annual * annuityDue(rem, r); }
  return n;
}
function gapAt(p, t, A = S.A) { return Math.max(0, needAt(p, t, A) - compute(p, A).have); }

function termPlan(p, C, A = S.A) {
  const g0 = gapAt(p, 0, A); let T = 30;
  for (const o of [10, 15, 20, 25, 30]) { if (gapAt(p, o, A) <= Math.max(25000, 0.15 * g0)) { T = o; break; } }
  if ((p.age || 35) + T > 80) T = Math.max(10, Math.floor((80 - (p.age || 35)) / 5) * 5);
  let ladder = null;
  if (T >= 20 && C >= 250000) {
    const T2 = T >= 30 ? 15 : 10;
    let base = roundTo(gapAt(p, T2, A), 50000);
    base = clamp(base, 50000, C - 50000);
    ladder = { long: { amount: base, years: T }, short: { amount: C - base, years: T2 } };
  }
  return { T, ladder };
}

/* illustrative pricing — not a quote */
const TERM20 = [[18, .42], [30, .48], [35, .56], [40, .78], [45, 1.25], [50, 2.0], [55, 3.3], [60, 5.6], [65, 9.5], [70, 16], [80, 30]];
const WHOLE = [[18, 7.5], [30, 10], [35, 11.5], [40, 13.5], [45, 16.5], [50, 20], [55, 25], [60, 31], [65, 40], [70, 52], [80, 75]];
const TERMF = { 10: .7, 15: .85, 20: 1, 25: 1.28, 30: 1.55 };
function interp(tbl, x) { if (x <= tbl[0][0]) return tbl[0][1]; for (let i = 1; i < tbl.length; i++) { if (x <= tbl[i][0]) { const [x0, y0] = tbl[i - 1], [x1, y1] = tbl[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); } } return tbl[tbl.length - 1][1]; }
/* ---------- estimated price class (illustrative underwriting) ---------- */
const CLASSES = [
  { key: 'pp', name: 'Preferred Plus', term: 0.80, whole: 0.88 },
  { key: 'pref', name: 'Preferred', term: 1.00, whole: 1.00 },
  { key: 'sp', name: 'Standard Plus', term: 1.22, whole: 1.12 },
  { key: 'std', name: 'Standard', term: 1.50, whole: 1.28 },
  { key: 'table', name: 'Rated', term: 2.40, whole: 1.90 },
  { key: 'ptob', name: 'Preferred Tobacco', term: 2.60, whole: 1.55 },
  { key: 'stob', name: 'Standard Tobacco', term: 3.30, whole: 1.85 }
];
const CLS = Object.fromEntries(CLASSES.map(c => [c.key, c]));
const LADDER = ['pp', 'pref', 'sp', 'std', 'table'];
const bmiOf = hw => hw && hw !== 'na' && hw.lb ? 703 * hw.lb / Math.pow(hw.ft * 12 + hw.inch, 2) : null;
const healthShared = H => !!H && ['nicotine', 'hw', 'bp', 'cond', 'fam', 'life'].some(k => H[k] != null);
function riskClass(H) {
  if (!healthShared(H)) return { known: false };
  let r = 0; const good = [], held = [], improve = [];
  const cap = (n, why, tip) => { if (n > r) r = n; held.push(why); if (tip) improve.push(tip); };
  const bmi = bmiOf(H.hw);
  if (bmi != null) {
    if (bmi < 18.5) cap(2, 'Weight is below the range insurers prefer');
    else if (bmi <= 27.5) good.push('Height and weight in the healthiest range');
    else if (bmi <= 30) cap(1, 'Weight a little above the top tier’s range', 'A modest change in weight can move you up a class.');
    else if (bmi <= 33) cap(2, 'Weight above the preferred range', 'Losing some weight before applying could lower your price.');
    else if (bmi <= 38) cap(3, 'Weight well above the preferred range', 'Losing some weight before applying could lower your price.');
    else cap(4, 'Weight well above most insurers’ standard range', 'Talk with a professional; some insurers are more flexible on weight.');
  }
  if (H.bp === 'no') good.push('No blood pressure or cholesterol treatment');
  else if (H.bp === 'controlled') cap(1, 'Treated blood pressure or cholesterol, well controlled');
  else if (H.bp === 'uncontrolled') cap(3, 'Blood pressure or cholesterol not yet under control', 'Getting readings under control usually improves your class.');
  else if (H.bp === 'unsure') cap(2, 'Unsure about blood pressure or cholesterol', 'A checkup before applying can clear this up.');
  const cond = H.cond || [];
  if (cond.includes('heart')) cap(4, 'History of heart disease or stroke');
  if (cond.includes('cancer')) cap(4, 'History of cancer (the class depends a lot on type and timing)');
  if (cond.includes('diabetes')) cap(3, 'Diabetes', 'Well-managed blood sugar can mean a better offer.');
  if (cond.includes('na')) cap(2, 'Some health history not shared');
  if (cond.includes('none')) good.push('No major conditions');
  if (H.fam === 'yes') cap(1, 'A parent or sibling with heart disease or cancer before 60');
  else if (H.fam === 'no') good.push('No early family history of heart disease or cancer');
  const life = H.life || [];
  if (life.includes('dui')) cap(3, 'A recent DUI or major driving violation');
  if (life.includes('hobby')) cap(2, 'A higher-risk hobby, which can also add a flat extra charge');
  if (life.includes('none')) good.push('No risky driving or hobbies');
  let key = LADDER[r];
  if (H.nicotine === 'yes') { key = r <= 1 ? 'ptob' : 'stob'; held.unshift('Tobacco or nicotine in the last 12 months'); improve.unshift('After 12 months without nicotine, most insurers will move you to non-tobacco rates.'); }
  else if (H.nicotine === 'no') good.unshift('No tobacco or nicotine');
  return { known: true, key, cls: CLS[key], rung: LADDER.indexOf(key), good, held, improve, unsureTobacco: H.nicotine === 'na' || H.nicotine == null };
}
function classRange(H, kind) {
  const rc = riskClass(H);
  if (!rc.known) return [CLS.pref[kind] * 0.92, CLS.std[kind] * 1.05];
  const f = rc.cls[kind];
  let lo = f * 0.93, hi = f * 1.08;
  if (rc.unsureTobacco && !['ptob', 'stob'].includes(rc.key)) hi = Math.max(hi, CLS.stob[kind]);
  return [lo, hi];
}
function premiumFor(age, H, amount, kind, years = 20) {
  age = age || 35;
  const rate = kind === 'term' ? interp(TERM20, age) * (TERMF[years] || 1) : interp(WHOLE, age);
  const [lo, hi] = classRange(H, kind);
  const mid = amount / 1000 * rate / 12;
  return { lo: mid * lo, hi: mid * hi, mid: mid * (lo + hi) / 2, rate };
}
function premium(p, amount, kind, years = 20) { return premiumFor(p.age, p.health, amount, kind, years); }
function partnerPremium(p, amount, kind, years = 20) { return premiumFor(p.partner.age || p.age, p.partner.health, amount, kind, years); }

/* ---------- the policy the person chose ---------- */
const policyName = pol => !pol ? '' : pol.type === 'whole' ? 'Whole life' : `${pol.years}-year term`;
function remainingSavings(p) { return Math.max(0, (p.savings || 0) - (p.savingsUse || 0)); }
/* whole life cash value, illustrative: early premiums mostly pay costs, later ones build value */
function cashValueAt(p, C, years, deposit = p.cvDeposit || 0, rate = 0.03) {
  const annual = premium(p, C, 'whole').mid * 12;
  let cv = deposit * 0.92, paid = deposit;
  for (let t = 1; t <= years; t++) {
    const share = t === 1 ? 0 : t === 2 ? 0.3 : t <= 5 ? 0.6 : 0.85;
    cv = (cv + annual * share) * (1 + rate); paid += annual;
  }
  return { cv, paid };
}
function termEndCheck(p, years) {
  const g0 = gapAt(p, 0), gEnd = gapAt(p, years);
  return { gEnd, short: gEnd > Math.max(50000, 0.15 * g0) };
}

/* ---------- quiet signals that someone may want more than basic coverage ---------- */
function wealthProfile(p) {
  let score = 0; const why = [];
  const inc = p.income || 0, assets = Math.max(p.assets || 0, p.savings || 0);
  if (inc >= 500000) { score += 3; why.push('income'); } else if (inc >= 250000) { score += 2; why.push('income'); } else if (inc >= 150000) score += 1;
  if (assets >= 1e6) { score += 3; why.push('assets'); } else if (assets >= 500000) { score += 2; why.push('assets'); }
  if ((p.mortgage || 0) >= 1e6) { score += 1; why.push('home'); }
  if (p.housing === 'own_outright' && inc >= 150000) score += 1;
  if (p.partner && (p.partner.income || 0) >= 200000) score += 1;
  if (p.businessOwner) { score += 2; why.push('business'); }
  if (p.lifelong && p.lifelong.includes('legacy')) score += 1;
  return { score, why, tier: score >= 5 ? 'high' : score >= 3 ? 'affluent' : null };
}

const money0 = n => '$' + (n >= 100 ? Math.round(n / 5) * 5 : Math.round(n)).toLocaleString('en-US');
const rangeTxt = ({ lo, hi }) => `${money0(lo)}–${money0(hi)}`;

/* partner scenario as its own profile */
function partnerProfile(p) {
  const q = p.partner || {};
  const extras = [];
  const y = youngestAge(p);
  if (q.contrib && q.contrib.includes('household')) extras.push({ key: 'household', label: 'Help running the household', annual: 8000, years: hasKids(p) ? Math.max(3, 18 - y) : 5, why: 'Paid help with cleaning, errands and meals, about $8,000 a year, until your youngest is 18.' });
  if (q.contrib && q.contrib.includes('care')) extras.push({ key: 'care', label: 'Care for a family member', annual: 12000, years: 5, why: 'Paid care for the family member your partner looks after, about $12,000 a year for 5 years.' });
  return {
    ...p,
    income: q.income || 0,
    mortgagePlan: q.homePlan || 'none',
    childcareAnnual: q.childcareNeeded ? (q.childcareAnnual || p.childcareAnnual || 15000) : 0,
    coverage: q.coverage || 0, coverageSource: 'own',
    extras
  };
}

/* allowed dollar figures for the number guard */
function allowedFigures() {
  const p = P(), c = compute(p), out = [c.need, c.have, c.gap, c.tiers.essential, c.tiers.balanced, c.tiers.more];
  for (const i of c.items) { out.push(i.amount); if (i.annual) out.push(i.annual, i.annual / 12, i.annual * i.years); if (i.nominal) out.push(i.nominal); }
  for (const r of c.res) out.push(r.amount);
  if (p.income) out.push(p.income); if (p.mortgage) out.push(p.mortgage); if (p.educationPerKid) out.push(p.educationPerKid);
  const C = S.coverage || c.tiers.balanced;
  if (C) {
    out.push(C); const s = simulate(p, C); out.push(s.leftover, s.start);
    const tp = termPlan(p, C); const t1 = premium(p, C, 'term', tp.T), w1 = premium(p, C, 'whole');
    out.push(t1.lo, t1.hi, w1.lo, w1.hi);
    for (const y of [10, 20, 30]) { const q = premium(p, C, 'term', y); out.push(q.lo, q.hi); }
    if (p.policy && p.policy.type === 'whole') for (const y of [10, 20, 30]) { const cv = cashValueAt(p, C, y); out.push(cv.cv, cv.paid); }
    if (p.cvDeposit) out.push(p.cvDeposit);
    if (tp.ladder) out.push(tp.ladder.long.amount, tp.ladder.short.amount);
  }
  if (hasPartner(p) && p.partner && p.partner.depends && p.partner.depends !== 'no') {
    const pc = compute(partnerProfile(p)); out.push(pc.need, pc.have, pc.gap, pc.tiers.balanced);
    if (p.partner.income) out.push(p.partner.income);
    if (p.partner.cover && pc.tiers.balanced) { const pol = p.policy || { type: 'term', years: 20 }; const q = partnerPremium(p, pc.tiers.balanced, pol.type, pol.years); out.push(q.lo, q.hi); }
  }
  if (p.savings) out.push(p.savings, remainingSavings(p));
  if (p.savingsUse) out.push(p.savingsUse);
  return out.filter(x => x > 0);
}
function guard(text, allowed = allowedFigures()) {
  const re = /\$\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s*(k|m|million|thousand)\b)?/gi;
  const checks = []; let m;
  while ((m = re.exec(text))) {
    let v = parseFloat(m[1].replace(/,/g, ''));
    const u = (m[2] || '').toLowerCase();
    if (u === 'k' || u === 'thousand') v *= 1000; else if (u === 'm' || u === 'million') v *= 1e6;
    const ok = allowed.some(a => Math.abs(a - v) <= Math.max(600, a * 0.02));
    checks.push({ raw: m[0], value: v, ok, index: m.index });
  }
  return { ok: checks.every(c => c.ok), checks };
}


export { CLASSES, CLS, LADDER, PRIO, TERM20, TERMF, WHOLE, allowedFigures, bmiOf, cap, cashValueAt, classRange, compute, gapAt, guard, hasDependents, hasKids, hasPartner, healthShared, householdText, interp, kidName, kidsOf, money0, needAt, obligations, partnerPremium, partnerProfile, policyName, premium, premiumFor, rangeTxt, remainingSavings, resolvedIncomeYears, riskClass, simulate, termEndCheck, termPlan, wealthProfile, youngestAge };
