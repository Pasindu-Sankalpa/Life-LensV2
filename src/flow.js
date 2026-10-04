import { clamp, fmt, fmtK, h, pct, plural, reduceMotion, roundTo, roundUp } from './dom.js';
import { P, S, SOURCES } from './state.js';
import { CLS, LADDER, TERM20, TERMF, WHOLE, cap, cashValueAt, classRange, compute, gapAt, hasDependents, hasKids, hasPartner, healthShared, householdText, interp, kidName, kidsOf, money0, partnerPremium, partnerProfile, policyName, premium, premiumFor, rangeTxt, remainingSavings, riskClass, simulate, termEndCheck, termPlan, wealthProfile, youngestAge } from './engine.js';
import { CARDS, SKIP, amountWidget, appendCard, askNode, editNode, live, md, meBubble, optButton, refresh, renderStages, say, scrollDown, setStage, stale, stream, toast } from './ui.js';
import { buildInsights, photoFlow, renderInsights, writeBrief } from './ai.js';
import { scheduleSave } from './hero.js';

/* ======================================================================
   Conversation script
   Each node: stage, when, known, ask, widget, apply, label, ack, quick
   ====================================================================== */
const INCOME_BANDS = [
  { v: 35000, label: 'Under $40K' }, { v: 57500, label: '$40–75K' }, { v: 100000, label: '$75–125K' },
  { v: 185000, label: '$125–250K' }, { v: 350000, label: '$250K+' }];
const kidsHousehold = p => p.household === 'children' || p.household === 'partner_children';
const PRIO_WORDS = { home: 'your home', income: 'your income', kids: 'your children’s future', debts: 'against leftover debts', time: 'time for your family to adjust' };
function listJoin(a) { a = a.filter(Boolean); if (a.length <= 1) return a.join(''); return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1]; }
function recommendYears(p) {
  if (hasKids(p)) {
    const toGrown = 18 - youngestAge(p);
    if (toGrown > 12) return 10;
    if (toGrown >= 5) return 'grown';
    return hasPartner(p) ? 10 : 5; // older kids, but a partner still relies on the income
  }
  return hasPartner(p) ? 10 : 5;
}
const yearsLabel = v => v === 'grown' ? 'until your kids are grown' : `${v} years`;
function incomeMath(p) {
  const c = compute(p); const it = c.items.find(i => i.key === 'income'); if (!it) return null;
  return `${fmt(it.annual)} a year (${pct(S.A.replace)} of your income, since your own costs would go away) for ${it.years} ${plural(it.years, 'year', 'years')}. Because the money can grow a little while it’s used, that’s about **${fmtK(it.amount)}** today.`;
}

function recommendedPolicy(p, C) {
  const ll = p.lifelong || [];
  if (ll.includes('dependent') || (ll.includes('legacy') && wealthProfile(p).tier)) return { type: 'whole' };
  const T = termPlan(p, C).T;
  return { type: 'term', years: T <= 10 ? 10 : T <= 20 ? 20 : 30 };
}
function policyAck(p) {
  const C = S.coverage, pol = p.policy;
  const lead = p._recPicked ? `I’d start with **${policyName(pol)}**${pol.type === 'whole' ? ', since you want coverage that lasts your whole life' : ', since it matches when your family relies on you most'}. ` : '';
  if (pol.type === 'whole') return lead + `Whole life for **${fmtK(C)}** is roughly **${rangeTxt(premium(p, C, 'whole'))}** a month, and it builds cash value as you go.`;
  const chk = termEndCheck(p, pol.years);
  return lead + `A ${pol.years}-year term for **${fmtK(C)}** is roughly **${rangeTxt(premium(p, C, 'term', pol.years))}** a month.` +
    (chk.short ? ` One thing to know: when it ends, your family would still need about **${fmtK(chk.gEnd)}**. A longer term or a ladder would close that gap.` : ' By the time it ends, most of what your family relies on you for is covered.');
}
/* one set of health questions, used for you and for your partner */
function healthNodes(pre, stage, when, H, who) {
  const you = who === 'you';
  const q = (y, t) => you ? y : t;
  return [
    { id: pre + 'Nic', stage, when, ask: () => ({ q: q('In the last 12 months, have you used any tobacco or nicotine?', 'In the last 12 months, has your partner used any tobacco or nicotine?'), sub: 'Cigarettes, vaping, cigars, chewing tobacco or nicotine gum.' }),
      widget: { type: 'choice', options: [{ v: 'no', label: 'No' }, { v: 'yes', label: 'Yes' }, { v: 'na', label: 'Prefer not to say' }] },
      apply: (p, v) => { H(p).nicotine = v; }, label: v => ({ no: 'No', yes: 'Yes', na: 'Prefer not to say' })[v] },
    { id: pre + 'HW', stage, when, ask: () => ({ q: q('What’s your height and weight?', 'What’s your partner’s height and weight?'), sub: 'Insurers use this to check a healthy weight range.' }),
      widget: { type: 'hw' },
      apply: (p, v) => { H(p).hw = v; }, label: v => v === 'na' ? 'Prefer not to say' : `${v.ft}′${v.inch}″, ${v.lb} lb` },
    { id: pre + 'BP', stage, when, ask: () => ({ q: q('Are you treated for high blood pressure or cholesterol?', 'Is your partner treated for high blood pressure or cholesterol?') }),
      widget: { type: 'choice', options: [{ v: 'no', label: 'No' }, { v: 'controlled', label: 'Yes, and it’s well controlled' }, { v: 'uncontrolled', label: 'Yes, not well controlled yet' }, { v: 'unsure', label: 'Not sure' }] },
      apply: (p, v) => { H(p).bp = v; }, label: v => ({ no: 'No', controlled: 'Yes, well controlled', uncontrolled: 'Yes, not well controlled yet', unsure: 'Not sure' })[v] },
    { id: pre + 'Cond', stage, when, ask: () => ({ q: q('Have you ever been diagnosed with any of these?', 'Has your partner ever been diagnosed with any of these?'), sub: 'Pick all that apply.' }),
      widget: { type: 'multi', options: [{ v: 'diabetes', label: 'Diabetes' }, { v: 'heart', label: 'Heart disease or stroke' }, { v: 'cancer', label: 'Cancer' }, { v: 'none', label: 'None of these', exclusive: true }, { v: 'na', label: 'Prefer not to say', exclusive: true }] },
      apply: (p, v) => { H(p).cond = v; }, label: v => v.includes('none') ? 'None of these' : v.includes('na') ? 'Prefer not to say' : listJoin(v.map(x => ({ diabetes: 'Diabetes', heart: 'Heart disease or stroke', cancer: 'Cancer' })[x])) },
    { id: pre + 'Fam', stage, when, ask: () => ({ q: q('Did a parent or sibling have heart disease or cancer before age 60?', 'Did one of their parents or siblings have heart disease or cancer before age 60?') }),
      widget: { type: 'choice', options: [{ v: 'no', label: 'No' }, { v: 'yes', label: 'Yes' }, { v: 'unsure', label: 'Not sure' }] },
      apply: (p, v) => { H(p).fam = v; }, label: v => ({ no: 'No', yes: 'Yes', unsure: 'Not sure' })[v] },
    { id: pre + 'Life', stage, when, ask: () => ({ q: q('Any of these in the last few years?', 'Any of these for your partner in the last few years?') }),
      widget: { type: 'multi', options: [{ v: 'dui', label: 'A DUI or major driving violation' }, { v: 'hobby', label: 'Skydiving, scuba, climbing or private flying' }, { v: 'none', label: 'None of these', exclusive: true }] },
      apply: (p, v) => { H(p).life = v; }, label: v => v.includes('none') ? 'None of these' : listJoin(v.map(x => ({ dui: 'A driving violation', hobby: 'A higher-risk hobby' })[x])),
      ack: () => 'Thanks, that’s everything.' }
  ];
}

const NODES = [
  /* ---------------- YOU ---------------- */
  { id: 'household', stage: 'you',
    known: p => !!p.household,
    ask: () => ({ q: 'First, who are we protecting?', sub: 'Is anyone financially dependent on you today?' }),
    widget: { type: 'choice', options: [
      { v: 'just_me', label: 'Just me' }, { v: 'partner', label: 'My partner' }, { v: 'children', label: 'My children' },
      { v: 'partner_children', label: 'My partner and children' }, { v: 'other', label: 'Someone else' }] },
    apply: (p, v) => { p.household = v; if (!kidsHousehold(p)) p.kids = []; renderStages(); },
    label: v => ({ just_me: 'Just me', partner: 'My partner', children: 'My children', partner_children: 'My partner and children', other: 'Someone else' })[v],
    ack: (p, v) => ({
      partner_children: 'Got it. So we’re not just thinking about you, we’re making sure your whole household could keep going financially.',
      partner: 'Got it. We’ll make sure your partner could keep going financially.',
      children: 'Got it. Your children come first in this plan.',
      just_me: 'Got it. With no one relying on your income, your plan will mostly be about covering costs and debts, so it may be smaller than you’d expect.',
      other: 'Got it. We’ll plan around the person who relies on you.' })[v] },

  { id: 'kids', stage: 'you',
    when: p => kidsHousehold(p),
    known: p => kidsOf(p).length > 0,
    ask: () => ({ q: 'How old are your children?' }),
    widget: p => ({ type: 'kids', initial: p.kids }),
    apply: (p, v) => { p.kids = v; },
    label: v => v.length === 1 ? `One child, ${v[0] === 0 ? 'under 1' : v[0]}` : `${v.length} children: ${listJoin(v.map(a => a === 0 ? 'under 1' : String(a)))}`,
    ack: p => { const y = youngestAge(p); return kidsOf(p).length === 1 ? `Thanks. That tells me your plan needs to reach about ${Math.max(1, 18 - y)} years out.` : `Thanks. Your youngest is ${y === 0 ? 'under 1' : y}, so your plan needs to reach about ${18 - y} years out.`; } },

  { id: 'age', stage: 'you',
    known: p => !!p.age,
    ask: () => ({ q: 'About how old are you?' }),
    widget: { type: 'amount', money: false, min: 18, max: 80, hardMax: 90, step: 1, initial: 35, unit: 'years old', aria: 'Your age', confirm: 'That’s me', plusEnd: true },
    apply: (p, v) => { p.age = clamp(Math.round(v), 18, 90); },
    label: v => `${Math.round(v)}` },

  { id: 'income', stage: 'you',
    when: p => hasDependents(p),
    known: p => !!p.income,
    ask: () => ({ q: 'And roughly what do you earn in a year?', sub: 'A ballpark is completely fine.' }),
    widget: { type: 'band', bands: INCOME_BANDS },
    apply: (p, v) => { p.income = v; },
    label: v => INCOME_BANDS.find(b => b.v === v)?.label || `About ${fmtK(v)} a year`,
    ack: () => 'Thanks. That’s the paycheck we’ll want to protect.' },

  { id: 'priorities', stage: 'you',
    known: p => p.priorities && p.priorities.length > 0,
    ask: p => hasDependents(p)
      ? { q: 'What would worry you most if your income suddenly stopped?', sub: 'Pick as many as you like.' }
      : { q: 'What would you want taken care of?', sub: 'Pick as many as you like.' },
    widget: p => ({ type: 'multi', cards: true, options: [
      { v: 'home', icon: '🏠', label: 'Keeping the home' },
      hasDependents(p) ? { v: 'income', icon: '💵', label: 'Replacing my income' } : null,
      hasKids(p) || kidsHousehold(p) ? { v: 'kids', icon: '🎓', label: 'My kids’ future' } : null,
      { v: 'debts', icon: '💳', label: 'Leaving debts behind' },
      hasDependents(p) ? { v: 'time', icon: '❤️', label: 'Giving my family time to adjust' } : null,
      { v: 'unsure', icon: '🤷', label: 'Not sure, help me decide', exclusive: true }].filter(Boolean) }),
    apply: (p, v) => { p.priorities = v; },
    label: v => v.includes('unsure') ? 'Not sure yet' : cap(listJoin(v.map(x => ({ home: 'the home', income: 'income', kids: 'the kids’ future', debts: 'debts', time: 'time to adjust' })[x]))),
    quick: p => [p.housing === 'own_mortgage' ? 'home' : null, hasDependents(p) ? 'income' : null, hasKids(p) ? 'kids' : null].filter(Boolean),
    ack: (p, v) => v.includes('unsure')
      ? 'No problem. Most families start with the home, income and any children’s future. We’ll look at each, and you decide as we go.'
      : `That helps. You’re mainly trying to protect ${listJoin(v.map(x => PRIO_WORDS[x]))}. Let’s see what those actually cost.` },

  /* ---------------- NEEDS ---------------- */
  { id: 'housing', stage: 'needs',
    known: p => !!p.housing,
    ask: () => ({ q: 'Let’s start with the home. Do you rent or own?' }),
    widget: { type: 'choice', options: [
      { v: 'own_mortgage', label: 'Own, with a mortgage' }, { v: 'own_outright', label: 'Own it outright' },
      { v: 'rent', label: 'Rent' }, { v: 'other', label: 'Something else' }] },
    apply: (p, v) => { p.housing = v === 'other' ? 'rent' : v; },
    label: v => ({ own_mortgage: 'Own, with a mortgage', own_outright: 'Own it outright', rent: 'Rent', other: 'Something else' })[v],
    ack: (p, v) => v === 'own_outright' ? 'Nice. With no mortgage, there’s nothing to pay off there.' : (v === 'rent' || v === 'other') ? 'Got it. Rent becomes part of the everyday costs that income support covers.' : null },

  { id: 'mortgagePlan', stage: 'needs',
    when: p => p.housing === 'own_mortgage',
    known: p => !!p.mortgagePlan,
    ask: () => ({ q: 'If something happened to you, would you want your family to be able to pay off the mortgage?' }),
    widget: { type: 'choice', options: [{ v: 'full', label: 'Yes, completely' }, { v: 'part', label: 'Help with part of it' }, { v: 'none', label: 'No, leave it out' }] },
    apply: (p, v) => { p.mortgagePlan = v; },
    label: v => ({ full: 'Yes, completely', part: 'Help with part of it', none: 'No, leave it out' })[v],
    quick: () => 'full',
    ack: (p, v) => v === 'none' ? 'Okay. We’ll leave it out. Income support can still help with the monthly payment.' : null },

  { id: 'mortgage', stage: 'needs',
    when: p => p.housing === 'own_mortgage' && p.mortgagePlan !== 'none',
    known: p => !!p.mortgage,
    ask: () => ({ q: 'About how much is left on it?' }),
    widget: { type: 'amount', min: 0, max: 1500000, step: 5000, initial: 250000, plusEnd: true, aria: 'Mortgage balance', presets: [{ v: 150000, label: '$150K' }, { v: 250000, label: '$250K' }, { v: 400000, label: '$400K' }, { v: 600000, label: '$600K' }], photo: 'mortgage' },
    apply: (p, v) => { p.mortgage = Math.round(v); },
    label: v => `About ${fmtK(v)}`,
    ack: p => p.mortgagePlan === 'part' ? `Okay. We’ll reserve **${fmtK(p.mortgage / 2)}**, half the balance, to make the home easier to keep.` : `Okay. We’ll reserve **${fmtK(p.mortgage)}** for keeping the home.` },

  { id: 'incomeYears', stage: 'needs',
    when: p => hasDependents(p) && !!p.income,
    known: p => !!p.incomeYearsChoice,
    ask: p => ({ q: p.housing === 'own_mortgage' ? 'Now imagine your family still had the house, but your paycheck stopped. How long would you want to give them financial breathing room?' : 'Now imagine your paycheck stopped. How long would you want to give your family financial breathing room?' }),
    widget: p => ({ type: 'choice', options: [
      { v: 3, label: '3 years' }, { v: 5, label: '5 years' }, { v: 10, label: '10 years' },
      hasKids(p) ? { v: 'grown', label: 'Until my kids are grown' } : null,
      { v: 'help', label: 'Help me choose' }].filter(Boolean) }),
    apply: (p, v) => { if (v === 'help') { v = recommendYears(p); p._helped = true; } else p._helped = false; p.incomeYearsChoice = v; p.incomeYears = v === 'grown' ? null : v; },
    label: v => v === 'help' ? 'Help me choose' : v === 'grown' ? 'Until my kids are grown' : `${v} years`,
    quick: p => recommendYears(p),
    ack: p => [p._helped ? `Most people aren’t sure. Based on what you’ve told me, let’s start with **${yearsLabel(p.incomeYearsChoice)}**. You can change it anytime.` : null, incomeMath(p)].filter(Boolean) },

  { id: 'debts', stage: 'needs',
    known: p => p.debts != null,
    ask: () => ({ q: 'Besides the home, are there other debts your family would need to handle?', sub: 'Car loans, student loans, credit cards.' }),
    widget: { type: 'amount', min: 0, max: 150000, step: 1000, initial: 15000, plusEnd: true, aria: 'Other debts', presets: [{ v: 0, label: 'None' }, { v: 5000, label: '$5K' }, { v: 15000, label: '$15K' }, { v: 30000, label: '$30K' }, { v: 50000, label: '$50K' }] },
    apply: (p, v) => { p.debts = Math.round(v); },
    label: v => v ? `About ${fmtK(v)}` : 'None',
    quick: () => 0,
    ack: (p, v) => v ? `Noted. **${fmtK(v)}** to clear them, so there are no extra payments to juggle.` : 'Good, nothing extra there.' },

  { id: 'kidGoals', stage: 'needs',
    when: p => hasKids(p),
    known: p => p.kidGoals != null,
    ask: () => ({ q: 'You mentioned your children. Should we set aside anything specifically for them?' }),
    widget: { type: 'multi', options: [
      { v: 'education', icon: '🎓', label: 'Education' }, { v: 'childcare', icon: '🧸', label: 'Childcare' },
      { v: 'none', label: 'Nothing extra', exclusive: true }] },
    apply: (p, v) => { p.kidGoals = v; if (!v.includes('education')) p.educationPerKid = 0; if (!v.includes('childcare')) p.childcareAnnual = 0; },
    label: v => v.includes('none') ? 'Nothing extra' : listJoin(v.map(x => x === 'education' ? 'Education' : 'Childcare')),
    quick: () => ['education'] },

  { id: 'education', stage: 'needs',
    when: p => p.kidGoals && p.kidGoals.includes('education'),
    known: p => !!p.educationPerKid,
    ask: () => ({ q: 'How much would you like to set aside for each child’s education?' }),
    widget: { type: 'choice', options: [
      { v: 25000, label: 'A little help', small: '$25K each' }, { v: 50000, label: 'Meaningful support', small: '$50K each' },
      { v: 100000, label: 'Major support', small: '$100K each' },
      { label: 'Choose an amount', then: d => amountWidget({ min: 0, max: 250000, step: 5000, initial: 60000, aria: 'Education per child' }, d) }] },
    apply: (p, v) => { p.educationPerKid = Math.round(v); },
    label: v => `${fmtK(v)} each`,
    quick: () => 50000,
    ack: p => `We’ll plan **${fmtK(p.educationPerKid)}** for each child, ready when they turn 18.` },

  { id: 'childcare', stage: 'needs',
    when: p => p.kidGoals && p.kidGoals.includes('childcare'),
    known: p => !!p.childcareAnnual,
    ask: () => ({ q: 'About what does childcare cost each year, or what would it?', sub: 'We’ll plan it until your youngest turns 13.' }),
    widget: { type: 'amount', min: 0, max: 50000, step: 500, initial: 15000, plusEnd: true, aria: 'Childcare per year', unit: 'a year', presets: [{ v: 8000, label: '$8K' }, { v: 15000, label: '$15K' }, { v: 25000, label: '$25K' }] },
    apply: (p, v) => { p.childcareAnnual = Math.round(v); },
    label: v => `${fmtK(v)} a year` },

  { id: 'cushion', stage: 'needs',
    known: p => p.cushion != null,
    ask: () => ({ q: 'Would you like a cushion for immediate costs?', sub: 'Final expenses, time away from work, travel, the unexpected. Most people choose about $25K.' }),
    widget: { type: 'choice', options: [
      { v: 25000, label: 'Yes, $25K', small: 'Most common' }, { v: 15000, label: '$15K' }, { v: 50000, label: '$50K' },
      { label: 'Choose an amount', then: d => amountWidget({ min: 0, max: 100000, step: 1000, initial: 25000, aria: 'Cushion' }, d) },
      { v: 0, label: 'Skip it' }] },
    apply: (p, v) => { p.cushion = Math.round(v); },
    label: v => v ? fmtK(v) : 'Skip it',
    quick: () => 25000 },

  { id: 'savings', stage: 'needs',
    known: p => p.savings != null,
    ask: () => ({ q: 'Do you have savings or investments your family could use?', sub: 'Leave out retirement accounts you’d rather not touch.' }),
    widget: { type: 'amount', min: 0, max: 2000000, step: 5000, initial: 25000, plusEnd: true, aria: 'Savings', presets: [{ v: 0, label: 'Not really' }, { v: 10000, label: '$10K' }, { v: 25000, label: '$25K' }, { v: 50000, label: '$50K' }, { v: 100000, label: '$100K' }, { v: 250000, label: '$250K' }, { v: 1000000, label: '$1M' }] },
    apply: (p, v) => { p.savings = Math.round(v); if (!p.savings) p.savingsUse = 0; else if (p.savingsUse != null) p.savingsUse = Math.min(p.savingsUse, p.savings); },
    label: v => v ? `About ${fmtK(v)}` : 'Not really',
    quick: () => 0,
    ack: (p, v) => v ? null : 'No problem. Insurance can do the heavy lifting.' },

  { id: 'savingsUse', stage: 'needs',
    when: p => (p.savings || 0) > 0,
    known: p => p.savingsUse != null,
    ask: p => ({ q: `How much of your ${fmtK(p.savings)} should go toward this plan?`, sub: 'Whatever you set aside here means less insurance to buy. Many people keep part of it as an emergency fund.' }),
    widget: p => ({ type: 'choice', options: [
      { v: p.savings, label: 'All of it', small: fmtK(p.savings) },
      { v: roundTo(p.savings / 2, 1000), label: 'About half', small: fmtK(roundTo(p.savings / 2, 1000)) },
      { v: 0, label: 'None of it', small: 'Keep it as an emergency fund' },
      { label: 'Choose an amount', then: d => amountWidget({ min: 0, max: p.savings, hardMax: p.savings, step: 1000, initial: roundTo(p.savings / 2, 1000), aria: 'Savings toward this plan' }, d) }] }),
    apply: (p, v) => { p.savingsUse = clamp(Math.round(v), 0, p.savings || 0); if (p.cvDeposit) p.cvDeposit = Math.min(p.cvDeposit, remainingSavings(p)); },
    label: (v, p) => !v ? 'None of it' : v >= (p.savings || 0) ? `All of it, ${fmtK(v)}` : fmtK(v),
    ack: (p, v) => v ? `Got it. **${fmtK(v)}** goes toward your family’s needs${p.savings - v > 0 ? `, and **${fmtK(p.savings - v)}** stays as your safety net` : ''}.` : 'Got it. Your savings stay as a safety net, and insurance covers the plan.' },

  { id: 'coverageHave', stage: 'needs',
    known: p => p.coverageSource != null,
    ask: () => ({ q: 'Do you already have life insurance, through work or on your own?' }),
    widget: () => ({ type: 'choice', options: [
      { v: 'work', label: 'Yes, through work' }, { v: 'own', label: 'Yes, my own policy' }, { v: 'both', label: 'Both' },
      { v: 'no', label: 'No' }, { v: 'unsure', label: 'Not sure' },
      S.ai.images ? { v: 'photo', icon: '📷', label: 'Read it from my benefits page' } : null].filter(Boolean) }),
    apply: (p, v) => { if (v === 'photo') return; p.coverageSource = v; if (v === 'no' || v === 'unsure') p.coverage = 0; },
    label: v => ({ work: 'Yes, through work', own: 'Yes, my own policy', both: 'Both', no: 'No', unsure: 'Not sure', photo: 'I’ll show you my benefits page' })[v],
    ack: (p, v) => v === 'unsure' ? 'That’s common. Many employers include some basic coverage. If you find it in your benefits portal later, add it from your plan.' : null },

  { id: 'coverageAmt', stage: 'needs',
    when: p => ['work', 'own', 'both'].includes(p.coverageSource),
    known: p => p.coverage != null,
    ask: () => ({ q: 'About how much coverage is it?' }),
    widget: { type: 'amount', min: 0, max: 2000000, step: 10000, initial: 100000, plusEnd: true, aria: 'Existing coverage', presets: [{ v: 50000, label: '$50K' }, { v: 100000, label: '$100K' }, { v: 250000, label: '$250K' }, { v: 500000, label: '$500K' }], photo: 'benefits' },
    apply: (p, v) => { p.coverage = Math.round(v); },
    label: v => `About ${fmtK(v)}`,
    ack: p => p.coverageSource === 'work' ? 'Counted. One thing worth knowing: coverage through work usually ends if you leave the job. You can switch it on or off in your plan to see both versions.' : `Counted. That’s **${fmtK(p.coverage)}** already working for your family.` },

  { id: 'assumptions', type: 'moment', stage: 'needs', when: () => S.quick && S.assumed.length > 0, render: renderAssumptions },
  { id: 'reveal', type: 'moment', stage: 'protection', render: renderReveal },
  { id: 'sandbox', type: 'moment', stage: 'protection', when: p => compute(p).tiers.balanced > 0, render: renderSandbox },
  { id: 'timeline', type: 'moment', stage: 'protection', when: p => compute(p).tiers.balanced > 0, render: renderTimeline },

  { id: 'feel', stage: 'protection',
    when: p => compute(p).tiers.balanced > 0,
    ask: () => ({ q: 'Which feels closer to what you want?' }),
    widget: p => { const t = compute(p).tiers; return { type: 'choice', options: [
      { v: 'essential', label: 'Cover the essentials', small: fmtK(t.essential) },
      { v: 'balanced', label: 'Balance protection and cost', small: fmtK(t.balanced) },
      { v: 'more', label: 'Give my family more cushion', small: fmtK(t.more) }] }; },
    apply: (p, v) => { S.tierPick = v; S.coverage = compute(p).tiers[v]; refresh(); },
    label: v => ({ essential: 'Cover the essentials', balanced: 'Balance protection and cost', more: 'Give my family more cushion' })[v],
    quick: () => 'balanced',
    ack: p => reactionText(p, S.coverage) },

  { id: 'healthGate', stage: 'protection',
    when: () => S.coverage > 0,
    ask: () => ({ q: 'Would you like to share some health information for a more personalized plan?', sub: 'Insurers price coverage by health class. A few questions let me estimate yours, which can lower or raise the cost. Nothing here is saved, and it never changes what your family needs.' }),
    widget: { type: 'choice', options: [{ v: 'yes', label: 'Yes, personalize it' }, { v: 'skip', label: 'Not now' }] },
    apply: (p, v) => { p._health = v === 'yes'; },
    label: v => v === 'yes' ? 'Yes, personalize it' : 'Not now',
    quick: () => 'skip',
    ack: (p, v) => v === 'skip' ? 'No problem. I’ll use a wider price range, and you can add health details anytime.' : 'Thanks. Six quick questions, and several let you choose not to say.' },
  ...healthNodes('h', 'protection', p => p._health, p => p.health, 'you'),
  { id: 'risk', type: 'moment', stage: 'protection', when: p => p._health && healthShared(p.health), render: renderRisk },

  { id: 'lifelong', stage: 'protection',
    when: () => S.coverage > 0,
    ask: () => ({ q: 'One more before we compare policy types. Is there anything you’d want covered for your whole life, no matter when?' }),
    widget: { type: 'multi', options: [
      { v: 'legacy', label: 'Leave something for family whenever it happens' },
      { v: 'dependent', label: 'Someone will need my support for life' },
      { v: 'final', label: 'Cover final costs whenever they happen' },
      { v: 'none', label: 'None of these', exclusive: true }] },
    apply: (p, v) => { p.lifelong = v; },
    label: v => v.includes('none') ? 'None of these' : listJoin(v.map(x => ({ legacy: 'Leave something behind', dependent: 'A lifelong dependent', final: 'Final costs' })[x])),
    quick: () => ['none'] },

  { id: 'tvw', type: 'moment', stage: 'protection', when: () => S.coverage > 0, render: renderTvw },
  { id: 'policyType', stage: 'protection',
    when: () => S.coverage > 0,
    known: p => !!p.policy,
    ask: () => [{ q: 'Which kind of policy would you like to plan around?' },
      { sub: '**Term life:** you pay a relatively low premium for a set period, such as 10, 20 or 30 years. If you pass away during the term, your beneficiaries receive the death benefit. There’s generally no cash value.' },
      { sub: '**Whole life:** permanent coverage. Part of what you pay supports the insurance and its costs, and another part builds cash value over time.' }],
    widget: p => { const C = S.coverage, rec = recommendedPolicy(p, C); const t = y => rangeTxt(premium(p, C, 'term', y)) + '/mo';
      return { type: 'choice', options: [
        { v: 'term10', label: '10-year term', small: t(10) }, { v: 'term20', label: '20-year term', small: t(20) }, { v: 'term30', label: '30-year term', small: t(30) },
        { v: 'whole', label: 'Whole life', small: rangeTxt(premium(p, C, 'whole')) + '/mo' },
        { v: 'rec', label: 'Recommend one for me', small: policyName(rec) }] }; },
    apply: (p, v) => { const pol = v === 'rec' ? recommendedPolicy(p, S.coverage) : v === 'whole' ? { type: 'whole' } : { type: 'term', years: +v.slice(4) }; p.policy = pol; p._recPicked = v === 'rec'; if (pol.type !== 'whole') p.cvDeposit = null; },
    label: v => ({ term10: '10-year term', term20: '20-year term', term30: '30-year term', whole: 'Whole life', rec: 'Recommend one for me' })[v],
    quick: p => 'rec',
    ack: p => policyAck(p) },
  { id: 'cvDeposit', stage: 'protection',
    when: p => p.policy && p.policy.type === 'whole' && remainingSavings(p) > 0,
    known: p => p.cvDeposit != null,
    ask: p => ({ q: 'Would you like to add some of your savings to the cash value?', sub: `You have about ${fmtK(remainingSavings(p))} in savings not set aside for the plan. A one-time deposit (often called paid-up additions) grows the cash value faster and can also raise the death benefit.` }),
    widget: p => { const rem = remainingSavings(p), q = roundTo(rem / 4, 1000), hf = roundTo(rem / 2, 1000);
      return { type: 'choice', options: [{ v: 0, label: 'No, keep it' }, q ? { v: q, label: fmtK(q), small: 'A quarter' } : null, hf && hf !== q ? { v: hf, label: fmtK(hf), small: 'Half' } : null,
        { label: 'Choose an amount', then: d => amountWidget({ min: 0, max: rem, hardMax: rem, step: 1000, initial: q || rem, aria: 'Deposit into cash value' }, d) }].filter(Boolean) }; },
    apply: (p, v) => { p.cvDeposit = clamp(Math.round(v), 0, remainingSavings(p)); },
    label: v => v ? `Add ${fmtK(v)}` : 'No, keep it',
    quick: () => 0,
    ack: p => p.cvDeposit ? `Done. Your **${fmtK(p.cvDeposit)}** goes into the cash value from day one.` : 'Okay. Your savings stay as they are.' },
  { id: 'policyCard', type: 'moment', stage: 'protection', when: p => !!p.policy && S.coverage > 0, render: renderPolicy },
  { id: 'wealth', type: 'moment', stage: 'protection', when: p => !!wealthProfile(p).tier, render: renderWealth },
  { id: 'insights', type: 'moment', stage: 'protection', when: p => S.coverage > 0, render: renderInsights },

  /* ---------------- FAMILY ---------------- */
  { id: 'pIntro', stage: 'family',
    when: p => hasPartner(p),
    ask: () => [{ q: 'We’ve looked at your family if something happens to you. There’s another side to the picture.' }, { q: 'Does your household also depend on your partner, through their income, childcare or support?' }],
    widget: { type: 'choice', options: [{ v: 'yes', label: 'Yes' }, { v: 'little', label: 'A little' }, { v: 'no', label: 'No' }] },
    apply: (p, v) => { p.partner.depends = v; },
    label: v => ({ yes: 'Yes', little: 'A little', no: 'No' })[v],
    quick: () => 'no',
    ack: (p, v) => v === 'no' ? 'Okay, we’ll leave their side out for now.' : 'Let’s see what losing their contribution would mean. This part is shorter because I already know your household.' },
  { id: 'pIncome', stage: 'family',
    when: p => hasPartner(p) && p.partner.depends && p.partner.depends !== 'no',
    known: p => p.partner.income != null,
    ask: () => ({ q: 'Does your partner earn an income?', sub: 'Roughly how much a year?' }),
    widget: { type: 'band', bands: [{ v: 0, label: 'No' }, ...INCOME_BANDS] },
    apply: (p, v) => { p.partner.income = v; },
    label: v => v === 0 ? 'No' : (INCOME_BANDS.find(b => b.v === v)?.label || `About ${fmtK(v)} a year`) },
  { id: 'pContrib', stage: 'family',
    when: p => hasPartner(p) && p.partner.depends && p.partner.depends !== 'no',
    ask: () => ({ q: 'Besides income, what does your partner provide that would cost money to replace?' }),
    widget: p => ({ type: 'multi', cards: true, options: [
      hasKids(p) ? { v: 'childcare', icon: '👶', label: 'Childcare' } : null,
      { v: 'care', icon: '❤️', label: 'Caring for a family member' },
      { v: 'household', icon: '🏠', label: 'Running the household' },
      { v: 'none', label: 'None of these', exclusive: true }].filter(Boolean) }),
    apply: (p, v) => { p.partner.contrib = v; },
    label: v => v.includes('none') ? 'None of these' : listJoin(v.map(x => ({ childcare: 'Childcare', care: 'Family caregiving', household: 'Running the household' })[x])) },
  { id: 'pChildcare', stage: 'family',
    when: p => hasPartner(p) && p.partner.contrib && p.partner.contrib.includes('childcare'),
    ask: () => ({ q: 'If they weren’t there, would you need to pay for childcare?' }),
    widget: { type: 'choice', options: [{ v: 'yes', label: 'Definitely' }, { v: 'probably', label: 'Probably' }, { v: 'no', label: 'No' }] },
    apply: (p, v) => { p.partner.childcareNeeded = v !== 'no'; },
    label: v => ({ yes: 'Definitely', probably: 'Probably', no: 'No' })[v],
    ack: (p, v) => v === 'no' ? null : 'That’s one of the biggest costs most calculators miss. Let’s count it.' },
  { id: 'pChildcareCost', stage: 'family',
    when: p => hasPartner(p) && p.partner.childcareNeeded && !p.childcareAnnual,
    ask: () => ({ q: 'About what would that childcare cost each year?', sub: 'We’ll plan it until your youngest turns 13.' }),
    widget: { type: 'amount', min: 0, max: 50000, step: 500, initial: 15000, unit: 'a year', aria: 'Childcare per year', presets: [{ v: 8000, label: '$8K' }, { v: 15000, label: '$15K' }, { v: 25000, label: '$25K' }] },
    apply: (p, v) => { p.partner.childcareAnnual = Math.round(v); },
    label: v => `${fmtK(v)} a year` },
  { id: 'pHome', stage: 'family',
    when: p => hasPartner(p) && p.partner.depends && p.partner.depends !== 'no' && p.housing === 'own_mortgage',
    ask: () => ({ q: 'If your partner weren’t here, should their plan also be able to pay off the home?' }),
    widget: { type: 'choice', options: [{ v: 'full', label: 'Yes' }, { v: 'part', label: 'Help with part of it' }, { v: 'none', label: 'No, my income covers it' }] },
    apply: (p, v) => { p.partner.homePlan = v; },
    label: v => ({ full: 'Yes', part: 'Help with part of it', none: 'No, my income covers it' })[v] },
  { id: 'pCovHave', stage: 'family',
    when: p => hasPartner(p) && p.partner.depends && p.partner.depends !== 'no',
    ask: () => ({ q: 'Does your partner already have life insurance?' }),
    widget: { type: 'choice', options: [{ v: 'yes', label: 'Yes' }, { v: 'no', label: 'No' }, { v: 'unsure', label: 'Not sure' }] },
    apply: (p, v) => { p.partner._has = v; if (v !== 'yes') p.partner.coverage = 0; },
    label: v => ({ yes: 'Yes', no: 'No', unsure: 'Not sure' })[v] },
  { id: 'pCovAmt', stage: 'family',
    when: p => hasPartner(p) && p.partner._has === 'yes',
    ask: () => ({ q: 'About how much?' }),
    widget: { type: 'amount', min: 0, max: 1500000, step: 10000, initial: 50000, aria: 'Partner coverage', presets: [{ v: 25000, label: '$25K' }, { v: 50000, label: '$50K' }, { v: 100000, label: '$100K' }, { v: 250000, label: '$250K' }] },
    apply: (p, v) => { p.partner.coverage = Math.round(v); },
    label: v => `About ${fmtK(v)}` },
  { id: 'familyMap', type: 'moment', stage: 'family', when: p => hasPartner(p) && p.partner.depends && p.partner.depends !== 'no', render: renderFamily },
  { id: 'pCoverOpt', stage: 'family',
    when: p => hasPartner(p) && p.partner.depends && p.partner.depends !== 'no' && compute(partnerProfile(p)).tiers.balanced > 0,
    ask: p => ({ q: 'Would you like to include coverage for your partner in this plan?', sub: `Their side would need about ${fmtK(compute(partnerProfile(p)).tiers.balanced)}.` }),
    widget: { type: 'choice', options: [{ v: 'yes', label: 'Yes, cover them too' }, { v: 'no', label: 'Not now' }] },
    apply: (p, v) => { p.partner.cover = v === 'yes'; },
    label: v => v === 'yes' ? 'Yes, cover them too' : 'Not now',
    quick: () => 'no' },
  { id: 'pAge', stage: 'family',
    when: p => p.partner.cover,
    known: p => !!p.partner.age,
    ask: () => ({ q: 'About how old is your partner?' }),
    widget: p => ({ type: 'amount', money: false, min: 18, max: 80, hardMax: 90, step: 1, initial: p.age || 35, unit: 'years old', aria: 'Partner’s age', confirm: 'Continue', plusEnd: true }),
    apply: (p, v) => { p.partner.age = clamp(Math.round(v), 18, 90); },
    label: v => `${Math.round(v)}` },
  { id: 'pHealthGate', stage: 'family',
    when: p => p.partner.cover,
    ask: () => ({ q: 'Would you like to share some of your partner’s health information for a more personalized estimate?', sub: 'Same idea as before: it only changes the price estimate, and nothing is saved.' }),
    widget: { type: 'choice', options: [{ v: 'yes', label: 'Yes, personalize it' }, { v: 'skip', label: 'Not now' }] },
    apply: (p, v) => { p.partner._health = v === 'yes'; },
    label: v => v === 'yes' ? 'Yes, personalize it' : 'Not now' },
  ...healthNodes('ph', 'family', p => p.partner.cover && p.partner._health, p => p.partner.health, 'partner'),
  { id: 'partnerPolicy', type: 'moment', stage: 'family', when: p => p.partner.cover, render: renderPartnerPolicy },

  /* ---------------- EXPLORE ---------------- */
  { id: 'explore', type: 'moment', stage: 'explore', render: renderExplore }
];
const NODE = Object.fromEntries(NODES.map(n => [n.id, n]));

/* ======================================================================
   Runner
   ====================================================================== */
async function run() {
  const tok = S.runId;
  S.running = true;
  try { await runLoop(tok); } finally { if (tok === S.runId) S.running = false; }
}
async function runLoop(tok) {
  while (true) {
    if (stale(tok)) return;
    const p = P();
    const node = NODES.find(n => !S.done.has(n.id) && (!n.when || n.when(p)));
    if (!node) break;
    S.done.add(node.id);
    if (node.type === 'moment') {
      setStage(node.stage);
      try { await node.render(); } catch (e) { if (e && e.message === 'stale') return; console.error(e); }
      refresh();
      continue;
    }
    if (node.known && node.known(p)) continue;
    if (S.quick && node.quick) {
      const v = node.quick(p); node.apply(p, v);
      if (node.id !== 'healthGate' && node.id !== 'lifelong' && node.id !== 'pIntro' && node.id !== 'feel') S.assumed.push(node.id);
      refresh(); continue;
    }
    setStage(node.stage);
    let v = await askNode(node);
    if (stale(tok)) return;
    if (v === SKIP) { refresh(); continue; } // answered by a typed message
    let typed = false;
    if (v && typeof v === 'object' && v.__typed) { typed = true; v = v.v; } // typed in the chat box
    if (v === 'photo' && node.id === 'coverageHave') {
      meBubble(node.label(v), null);
      const got = await photoFlow('benefits');
      if (stale(tok)) return;
      if (!got) { S.done.delete(node.id); continue; }
      refresh(); continue;
    }
    if (!typed) meBubble(node.label(v, p), node);
    node.apply(p, v);
    refresh();
    const ack = node.ack && node.ack(p, v);
    if (ack) { try { await say(ack); } catch { return; } }
  }
}

/* ======================================================================
   Moments: rich cards in the conversation
   ====================================================================== */
const GOAL_WORDS = { parentcare: 'support for a parent', cushion: 'immediate costs', debts: 'other debts', home: 'the home', education: 'education', childcare: 'childcare', household: 'household help', care: 'family care' };
function goalPhrase(g, s) {
  if (g.key === 'income') {
    const yrs = g.item.years;
    if (g.pct >= 0.995) return `${yrs} years of income`;
    return s.incomeFull ? `income (about ${s.incomeFull} of ${yrs} years)` : 'income';
  }
  return GOAL_WORDS[g.key] || g.label.toLowerCase();
}
function reactionText(p, C) {
  const s = simulate(p, C);
  const full = s.goals.filter(g => g.pct >= 0.995), part = s.goals.filter(g => g.pct < 0.995 && g.pct > 0.005), none = s.goals.filter(g => g.pct <= 0.005);
  if (!part.length && !none.length) return `**${fmtK(C)}** covers everything you told me matters${s.leftover >= 5000 ? `, with about **${fmtK(s.leftover)}** of extra breathing room` : ''}.`;
  let t = `**${fmtK(C)}** `;
  t += full.length ? `protects ${listJoin(full.map(g => goalPhrase(g, s)))}` : 'makes a start';
  if (part.length) t += `${full.length ? ', and goes partway on' : ' on'} ${listJoin(part.map(g => goalPhrase(g, s)))}`;
  t += '.';
  if (none.length) t += ` ${cap(listJoin(none.map(g => goalPhrase(g, s))))} ${none.length > 1 ? 'aren’t' : 'isn’t'} covered at this amount.`;
  return t;
}

/* ---------- assumptions (quick mode) ---------- */
function assumeWords(p) {
  return {
    mortgagePlan: p.mortgagePlan === 'part' ? 'paying off half the home' : p.mortgagePlan === 'none' ? 'leaving the mortgage out' : 'paying off the home', incomeYears: p.incomeYearsChoice === 'grown' ? 'income support until your kids are grown' : `income support for ${p.incomeYearsChoice} years`,
    debts: p.debts ? `${fmtK(p.debts)} in other debts` : 'no other debts', education: `${fmtK(p.educationPerKid || 50000)} per child for education`,
    cushion: `a ${fmtK(p.cushion || 25000)} cushion`, savings: 'no savings to draw on'
  };
}
async function renderAssumptions() {
  const words = assumeWords(P());
  const list = S.assumed.map(id => words[id]).filter(Boolean);
  await say([`To keep this quick, I assumed ${listJoin(list)}.`, { sub: 'Tap any of these to change it.' }]);
  appendAssumeChips(S.assumed.slice());
}
function appendAssumeChips(ids) {
  const chips = h('div', { class: 'chips', style: { margin: '0 0 24px 40px' } });
  stream.append(chips); S.log.push({ t: 'assume', ids }); scrollDown(true);
  live(chips, () => {
    const words = assumeWords(P());
    chips.innerHTML = '';
    for (const id of ids) if (words[id]) chips.append(h('button', { class: 'chip', type: 'button', onclick: () => editNode(NODE[id], null) }, cap(words[id])));
  });
}

/* ---------- the reveal ---------- */
async function renderReveal() {
  const p = P(), c = compute(p);
  if (S.coverage == null) { S.coverage = c.tiers.balanced; S.tierPick = 'balanced'; }
  if (!c.items.length) { await say('There isn’t much for insurance to cover based on what you’ve told me. You can add details anytime from your plan.'); return; }
  await say(c.gap > 0 ? 'Here’s what your life adds up to.' : 'Here’s where you stand.');
  appendCard('reveal');
}
function buildReveal() {
  const card = h('div', { class: 'card' });
  card._init = () => live(card, () => {
    const c = compute(P());
    const progress = c.need ? Math.min(1, c.have / c.need) : 0;
    const R = 24, L = 2 * Math.PI * R;
    const ring = `<svg class="ring" viewBox="0 0 54 54" aria-hidden="true"><circle cx="27" cy="27" r="${R}" fill="none" stroke="var(--surface)" stroke-width="6"/><circle cx="27" cy="27" r="${R}" fill="none" stroke="var(--ok)" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(L * progress).toFixed(1)} ${L.toFixed(1)}" transform="rotate(-90 27 27)"/></svg>`;
    card.innerHTML = '';
    card.append(
      h('h3', null, c.gap > 0 ? 'Your coverage target' : 'You may already be covered'),
      h('div', { class: 'reveal-num' }, fmtK(c.gap > 0 ? c.tiers.balanced : 0)),
      h('div', { class: 'reveal-sub' }, c.gap > 0
        ? `Your family’s needs add up to ${fmtK(c.need)}. ${c.have ? `What you already have covers ${fmtK(c.have)}, leaving about ${fmtK(c.gap)}, which rounds to ${fmtK(c.tiers.balanced)}.` : `Rounded up, that’s ${fmtK(c.tiers.balanced)}.`}`
        : `Your savings and current coverage (${fmtK(c.have)}) already meet the ${fmtK(c.need)} you described.`),
      c.have ? h('div', { class: 'already', html: ring + `<div><strong>You’re already ${Math.round(progress * 100)}% of the way there.</strong><div style="color:var(--ink-2);font-size:.93rem">${listJoin(c.res.filter(r => r.counted).map(r => `${fmtK(r.amount)} ${r.key === 'savings' ? 'in savings' : r.work ? 'through work' : 'in coverage'}`))} already count toward it.</div></div>` }) : null);
  });
  return card;
}

/* ---------- the sandbox ---------- */
async function renderSandbox() {
  if (S.coverage == null) S.coverage = compute(P()).tiers.balanced;
  await say('But there’s no single magic number. Drag to see what different amounts would actually do.');
  appendCard('sandbox');
}
function buildSandbox() {
  const c = compute(P());
  const max = Math.max(500000, roundUp(c.tiers.more * 1.15, 50000));
  const valEl = h('div', { class: 'v' });
  const range = h('input', { type: 'range', class: 'range', min: 0, max, step: 10000, value: S.coverage, 'aria-label': 'Coverage amount' });
  const tierBtns = ['essential', 'balanced', 'more'].map(k => { const b = h('button', { class: 'opt', type: 'button', 'aria-pressed': 'false', onclick: () => { S.coverage = compute(P()).tiers[k]; S.tierPick = k; refresh(); } }); b.dataset.k = k; return b; });
  const goalsEl = h('div'), reaction = h('p', { class: 'reaction' }), endMax = h('span', null, fmtK(max));
  let raf = 0;
  range.addEventListener('input', () => { S.coverage = Number(range.value); S.tierPick = null; cancelAnimationFrame(raf); raf = requestAnimationFrame(refresh); });
  const card = h('div', { class: 'card' },
    h('h3', null, 'Try different amounts'),
    h('p', { class: 'lede' }, 'Each bar fills as your coverage reaches it, in the order your family would need the money.'),
    h('div', { class: 'cov-readout' }, valEl, h('div', { class: 'tiers' }, tierBtns)),
    range, h('div', { class: 'range-ends' }, h('span', null, '$0'), endMax),
    goalsEl, reaction);
  card._init = () => live(card, () => {
    const p = P(), c = compute(p), C = S.coverage ?? c.tiers.balanced;
    const mx = Math.max(500000, roundUp(c.tiers.more * 1.15, 50000), C); range.max = mx; endMax.textContent = fmtK(mx);
    const s = simulate(p, C);
    valEl.textContent = fmtK(C);
    if (document.activeElement !== range) range.value = C;
    tierBtns.forEach(b => { const k = b.dataset.k; b.innerHTML = ''; b.append(({ essential: 'Essentials ', balanced: 'Balanced ', more: 'More cushion ' })[k], h('small', { style: { display: 'inline', marginLeft: '4px' } }, fmtK(c.tiers[k]))); b.setAttribute('aria-pressed', String(C === c.tiers[k])); });
    goalsEl.innerHTML = '';
    for (const g of s.goals) {
      const pctTxt = g.pct >= 0.995 ? 'Covered' : g.key === 'income' && s.incomeFull ? `${s.incomeFull} of ${g.item.years} years` : g.pct <= 0.005 ? 'Not yet' : `${Math.round(g.pct * 100)}%`;
      goalsEl.append(h('div', { class: 'goal' },
        h('span', { class: 'name' }, g.label), h('span', { class: 'stat' + (g.pct >= 0.995 ? ' ok' : '') }, pctTxt),
        h('div', { class: 'bar', role: 'img', 'aria-label': `${g.label}: ${pctTxt}` }, h('i', { class: g.pct < 0.995 ? 'part' : '', style: { width: (g.pct * 100).toFixed(1) + '%' } }))));
    }
    reaction.innerHTML = md(reactionText(p, C));
  });
  return card;
}

/* ---------- the signature moment: what your plan would do ---------- */
const ICON = { parentcare: '🧓', cushion: '🛟', debts: '💳', home: '🏠', income: '💵', education: '🎓', childcare: '🧸', household: '🧺', care: '❤️', done: '✓', grown: '🌱', extra: '✨' };
function timelineEvents(p, s) {
  const ev = []; // {t, key, icon, text, state:'ok'|'part'|'none'}
  const income = s.c.items.find(i => i.key === 'income');
  for (const y of s.years) {
    for (const o of y.paid) {
      const st = o.paid >= o.amount - 50 ? 'ok' : o.paid > 50 ? 'part' : 'none';
      if (o.key === 'cushion') ev.push({ t: y.t, key: o.key, text: st === 'ok' ? 'Immediate costs are handled, so nothing has to be rushed.' : 'Part of the immediate costs are handled.', state: st });
      if (o.key === 'debts') ev.push({ t: y.t, key: o.key, text: st === 'ok' ? 'Other debts are cleared. No extra payments to juggle.' : `${fmtK(o.paid)} goes toward other debts.`, state: st });
      if (o.key === 'home') ev.push({ t: y.t, key: o.key, text: st === 'ok' ? (p.mortgagePlan === 'part' ? 'Half the mortgage is paid down, so the monthly payment shrinks.' : 'The home is paid off. Your family stays put.') : st === 'part' ? `${fmtK(o.paid)} goes toward the home.` : 'The home isn’t covered at this amount.', state: st });
      if (o.key === 'education') { const nm = cap(kidName(p, o.kid)); ev.push({ t: y.t, key: o.key, text: st === 'ok' ? `${nm} turns 18 with ${fmtK(o.amount)} ready for school.` : st === 'part' ? `${nm} turns 18 with ${fmtK(o.paid)} ready for school.` : `${nm} turns 18. School money isn’t covered at this amount.`, state: st }); }
      if (o.key === 'income' && y.t === 0) ev.push({ t: 0, key: 'income', text: st === 'ok' ? `${fmt(o.amount / 12)} starts arriving every month.` : `${fmt(o.paid / 12)} a month to start.`, state: st });
      if ((o.key === 'childcare' || o.key === 'household' || o.key === 'care' || o.key === 'parentcare') && y.t === 0) ev.push({ t: 0, key: o.key, text: st === 'ok' ? `${o.label} is paid for, ${fmt(o.amount)} a year.` : `${o.label} is partly paid for.`, state: st });
    }
  }
  if (income) {
    const endT = income.years;
    if (s.incomeFull >= income.years) ev.push({ t: Math.min(endT, s.T - 1), key: 'done', text: `Income support completes after ${income.years} years, as planned.`, state: 'ok', after: endT >= s.T });
    else ev.push({ t: Math.max(0, s.incomeFull), key: 'income', text: s.incomeFull ? `Income support covers ${s.incomeFull} of the ${income.years} years you wanted.` : 'Income support isn’t covered at this amount.', state: s.incomeFull ? 'part' : 'none' });
  }
  const cc = s.c.items.find(i => i.key === 'childcare');
  if (cc && cc.years > 1) { const g = s.tot.childcare; ev.push({ t: cc.years - 1, key: 'childcare', text: 'The last year of paid childcare.', state: g && g.paid >= g.due - 50 ? 'ok' : 'part' }); }
  if (hasKids(p)) { const tg = 18 - youngestAge(p); if (tg > 0 && tg < s.T + 6) ev.push({ t: Math.min(tg, s.T - 1), key: 'grown', text: kidsOf(p).length > 1 ? 'Your youngest turns 18. The kids are grown.' : 'Your child turns 18.', state: 'ok', soft: true }); }
  if (s.leftover > 5000) ev.push({ t: s.T - 1, key: 'extra', text: `About ${fmtK(s.leftover)} is left over as extra cushion.`, state: 'ok', soft: true });
  return ev;
}
async function renderTimeline() {
  await say('Here’s the part most calculators skip: what that money would actually do for your family, year by year.');
  appendCard('timeline');
}
function buildTimeline() {
  let W = 680; const H = 282, padL = 22, padR = 22, top = 22, riverH = 118, baseY = top + riverH + 30;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'tl-svg'); svg.setAttribute('role', 'img');
  const yearEl = h('div', { class: 'tl-year', 'aria-live': 'polite' });
  const scrub = h('input', { type: 'range', min: 0, max: 1, step: 1, value: 0, 'aria-label': 'Year in your plan' });
  const playBtn = h('button', { class: 'play', type: 'button', 'aria-label': 'Play through the years', html: '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11l9-5.5z" fill="currentColor"/></svg>' });
  const title = h('h3'), lede = h('p', { class: 'lede', style: { marginBottom: '6px' } });
  let year = 0, playing = null;
  const card = h('div', { class: 'card tl-card' },
    h('div', { class: 'tl-head' }, title, lede),
    h('div', { class: 'legend' }, h('span', null, h('i', { style: { background: 'var(--river-soft)', border: '1px solid var(--river)' } }), 'Money set aside, still growing'), h('span', null, h('i', { style: { background: 'var(--ok-tint)', border: '1px solid var(--ok)' } }), 'Covered'), h('span', null, h('i', { style: { background: 'var(--open-tint)', border: '1px dashed var(--open)' } }), 'Not covered at this amount')),
    h('div', { class: 'tl-scene' }, svg),
    h('div', { class: 'tl-controls' }, playBtn, scrub),
    yearEl);
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
  function draw() {
    const p = P(), c = compute(p), C = S.coverage ?? c.tiers.balanced, s = simulate(p, C);
    const T = Math.max(s.T, 10), ev = timelineEvents(p, s);
    const host = svg.parentElement; W = clamp(Math.round((host && host.clientWidth) || 680), 300, 720);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    scrub.max = T - 1; if (year > T - 1) year = T - 1; scrub.value = year;
    title.textContent = `What your ${fmtK(C)} would do`;
    const startTxt = c.have ? ` It starts with ${fmtK(s.start)}: your ${fmtK(C)} plus the ${fmtK(c.have)} you already have.` : '';
    lede.textContent = (s.runOut == null ? 'If you weren’t here, this is how the money would carry your family.' : s.runOut === 0 ? 'At this amount, some goals aren’t covered from the start.' : `This amount fully carries your family through Year ${s.runOut}, then some goals go uncovered.`) + startTxt + ' Drag through the years, or press play.';
    svg.innerHTML = '';
    const x = t => padL + (W - padL - padR) * (t / (T - 1 || 1));
    const maxBal = Math.max(1, ...s.years.map(y => y.balStart));
    const yv = v => top + riverH - (v / maxBal) * riverH;
    // river area: balance at the start of each year, stepping down at payouts
    // balance at the start of each year, ending with what's left after the last year
    const bal = t => { const yr = s.years[t]; return yr ? yr.balStart : (s.years.length ? s.years[s.years.length - 1].balAfter : 0); };
    let d = `M ${x(0)} ${top + riverH} L ${x(0)} ${yv(bal(0))}`;
    for (let t = 1; t < T; t++) d += ` L ${x(t)} ${yv(bal(t))}`;
    d += ` L ${x(T - 1)} ${top + riverH} Z`;
    svg.append(el('path', { d, fill: 'var(--river-soft)', stroke: 'var(--river)', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    const clipId = 'lived' + Math.random().toString(36).slice(2, 7);
    const defs = el('defs', {}); const cp = el('clipPath', { id: clipId }); cp.append(el('rect', { x: 0, y: 0, width: Math.max(0, x(year)), height: H })); defs.append(cp); svg.append(defs);
    svg.append(el('path', { d, fill: 'var(--river)', opacity: .28, 'clip-path': `url(#${clipId})` }));
    // labels for the money
    svg.append(el('text', { x: x(0) + 10, y: yv(bal(0)) + 16, 'font-size': 13, 'font-weight': 600, fill: 'var(--ink)', 'font-family': 'var(--sans)' }, `${fmtK(s.start)} to start`));
    // axis
    svg.append(el('line', { x1: x(0), x2: x(T - 1), y1: baseY, y2: baseY, stroke: 'var(--line)', 'stroke-width': 2, 'stroke-linecap': 'round' }));
    for (let t = 0; t < T; t++) {
      const major = t === 0 || t === T - 1 || ((t + 1) % 5 === 0 && T - 1 - t >= 3);
      svg.append(el('line', { x1: x(t), x2: x(t), y1: baseY - (major ? 5 : 3), y2: baseY + (major ? 5 : 3), stroke: 'var(--ink-3)', 'stroke-width': 1 }));
      if (major) svg.append(el('text', { x: x(t), y: H - 6, 'text-anchor': t === 0 ? 'start' : t === T - 1 ? 'end' : 'middle', 'font-size': 11, fill: 'var(--ink-3)', 'font-family': 'var(--sans)' }, `Year ${t + 1}`));
    }
    // event markers, stacked per year
    const byT = {};
    for (const e of ev) (byT[e.t] = byT[e.t] || []).push(e);
    for (const [t, list] of Object.entries(byT)) {
      list.slice(0, 4).forEach((e, i) => {
        const cx = x(Number(t));
        const passed = Number(t) <= year;
        const g = el('g', { opacity: passed ? 1 : 0.45, transform: `translate(${cx} ${baseY + i * 25})` });
        const fill = e.state === 'ok' ? (passed ? 'var(--ok-tint)' : 'var(--surface)') : 'var(--open-tint)';
        const stroke = e.state === 'ok' ? 'var(--ok)' : 'var(--open)';
        g.append(el('circle', { r: 11, fill, stroke, 'stroke-width': 1.5, 'stroke-dasharray': e.state === 'ok' ? '0' : '3 2' }));
        g.append(el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': e.key === 'done' ? 12 : 11, fill: 'var(--ok)', 'font-weight': 700 }, ICON[e.key] || '•'));
        svg.append(g);
      });
    }
    // current year marker
    svg.append(el('line', { x1: x(year), x2: x(year), y1: top - 8, y2: baseY + 14, stroke: 'var(--brand)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }));
    const yr = s.years[year];
    svg.append(el('circle', { cx: x(year), cy: yv(bal(year)), r: 5, fill: 'var(--brand)' }));
    svg.setAttribute('aria-label', `Money set aside starts at ${fmtK(s.start)} and is paid out over ${T} years.`);
    // year detail
    const items = [];
    for (const e of ev.filter(e => e.t === year)) items.push(h('li', { class: e.state === 'ok' ? (e.soft ? 'soft' : '') : 'amber' }, `${ICON[e.key] ? ICON[e.key] + ' ' : ''}${e.text}`));
    if (yr) {
      const inc = yr.paid.find(o => o.key === 'income');
      if (inc && year > 0) items.push(h('li', { class: inc.paid >= inc.amount - 50 ? '' : 'amber' }, inc.paid >= inc.amount - 50 ? `💵 ${fmt(inc.amount / 12)} arrives every month.` : inc.paid > 50 ? `💵 ${fmt(inc.paid / 12)} a month this year, less than planned.` : '💵 Income support has been used up by now.'));
      const cc = yr.paid.find(o => o.key === 'childcare');
      if (cc && year > 0 && !ev.some(e => e.t === year && e.key === 'childcare')) items.push(h('li', { class: 'soft' }, `🧸 Childcare is still paid for.`));
      if (yr.balAfter > 1000 && year < T - 1) items.push(h('li', { class: 'soft' }, `${fmtK(yr.balAfter)} is still set aside, growing slowly.`));
    }
    if (!items.length) items.push(h('li', { class: 'soft' }, 'A quieter year. The plan keeps doing its job in the background.'));
    const kidsNow = hasKids(p) ? kidsOf(p).map(a => a + year) : null;
    yearEl.innerHTML = '';
    yearEl.append(h('div', { class: 'yr' }, `Year ${year + 1}`, kidsNow ? h('small', null, kidsNow.length === 1 ? `Your child is ${kidsNow[0]}` : `Kids are ${listJoin(kidsNow.map(String))}`) : null), h('ul', null, items));
  }
  scrub.addEventListener('input', () => { year = Number(scrub.value); stopPlay(); draw(); });
  function stopPlay() { if (playing) { clearInterval(playing); playing = null; playBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11l9-5.5z" fill="currentColor"/></svg>'; playBtn.setAttribute('aria-label', 'Play through the years'); } }
  playBtn.addEventListener('click', () => {
    if (playing) { stopPlay(); return; }
    if (year >= Number(scrub.max)) year = 0;
    playBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="3" y="2" width="3" height="10" fill="currentColor"/><rect x="8" y="2" width="3" height="10" fill="currentColor"/></svg>';
    playBtn.setAttribute('aria-label', 'Pause');
    draw();
    playing = setInterval(() => { if (!card.isConnected) return stopPlay(); if (year >= Number(scrub.max)) return stopPlay(); year++; draw(); }, reduceMotion() ? 1600 : 900);
  });
  card._init = () => live(card, draw);
  return card;
}

/* ---------- term vs whole ---------- */
function tradeoffs(p, C) {
  const out = [], tp = termPlan(p, C), T = tp.T, y = youngestAge(p);
  const term = premium(p, C, 'term', T), whole = premium(p, C, 'whole');
  const wr = classRange(p.health, 'whole');
  const wholeAtBudget = roundTo((term.lo + term.hi) / 2 * 12 / (interp(WHOLE, p.age || 35) * ((wr[0] + wr[1]) / 2)) * 1000, 5000);
  const ll = p.lifelong || [];
  if (hasKids(p)) out.push({ lean: 'term', title: `Your biggest needs have an end date`, body: `Your youngest is ${y === 0 ? 'under 1' : y}. The home, income support and school costs mostly wind down over the next ${T} years, and a ${T}-year term lines up with that window.` });
  else if (hasDependents(p)) out.push({ lean: 'term', title: 'Your need shrinks over time', body: `As the mortgage gets paid down and your savings grow, your family relies less on insurance. A ${T}-year term covers the years that matter most.` });
  out.push({ lean: 'term', title: 'Term costs much less for the same protection', body: `Roughly ${rangeTxt(term)} a month for a ${T}-year, ${fmtK(C)} term policy, versus roughly ${rangeTxt(whole)} a month for whole life. The term budget would buy only about ${fmtK(Math.max(5000, wholeAtBudget))} of whole life.` });
  if (tp.ladder) { const a = premium(p, tp.ladder.long.amount, 'term', tp.ladder.long.years), b = premium(p, tp.ladder.short.amount, 'term', tp.ladder.short.years);
    out.push({ lean: 'term', title: 'You could match coverage to a shrinking need', body: `Instead of one policy, a “ladder”: ${fmtK(tp.ladder.long.amount)} for ${tp.ladder.long.years} years plus ${fmtK(tp.ladder.short.amount)} for ${tp.ladder.short.years} years. That’s roughly ${money0(a.lo + b.lo)}–${money0(a.hi + b.hi)} a month, because the larger amount only lasts while you need it most.` }); }
  if (ll.includes('legacy')) out.push({ lean: 'whole', title: 'You want to leave something no matter when', body: 'Term ends; whole life doesn’t. Many people pair a term policy for the big, temporary needs with a smaller whole life policy for the lasting part.' });
  if (ll.includes('dependent')) out.push({ lean: 'whole', title: 'Someone may need your support for life', body: 'For a lifelong dependent, permanent coverage means the money is there whenever it’s needed. It’s worth asking a professional about pairing it with a special needs trust.' });
  if (ll.includes('final')) out.push({ lean: 'whole', title: 'Final costs come whenever they come', body: `A small whole life policy, around ${fmtK(p.cushion || 25000)}, is a common way to cover final costs at any age.` });
  out.push({ lean: 'either', title: 'Whole life also builds cash value', body: 'Part of each whole life payment builds a cash value you can borrow against. It grows slowly and steadily, and it tends to suit people who are already saving through a 401(k) or IRA.' });
  if (p.coverage && p.coverageSource === 'work') out.push({ lean: 'either', title: 'Your work coverage might not follow you', body: `The ${fmtK(p.coverage)} through your employer usually ends if you change jobs. A policy you own stays with you either way.` });
  out.push({ lean: 'either', title: 'You can keep the door open', body: 'Many term policies can be converted to permanent coverage later without new health questions, so choosing term now doesn’t rule out whole life later.' });
  const verdict = (ll.includes('legacy') || ll.includes('dependent'))
    ? `For you, a mix may fit best: term for the big, temporary needs, plus a smaller permanent policy for what should last your whole life.`
    : `For your situation, a ${T}-year term likely fits best right now. Whole life becomes worth a look if you want coverage that lasts your whole life.`;
  return { out, verdict, tp, term, whole, wholeAtBudget };
}
async function renderTvw() {
  await say('Here’s how term and whole life line up against what your family would actually need over time.');
  appendCard('tvw');
}
function sourcesEl(keys, lead = 'Learn more from public sources: ') {
  const parts = [];
  keys.forEach((k, i) => { if (i) parts.push(i === keys.length - 1 ? ' and ' : ', '); parts.push(h('a', { href: SOURCES[k].url, target: '_blank', rel: 'noopener noreferrer' }, SOURCES[k].label)); });
  return h('p', { class: 'sources' }, lead, ...parts, '.');
}
function buildTvw() {
  const sel = { v: 'term' };
  const chartEl = h('div', { class: 'tvw-chart scroll-x' });
  const toggles = h('div', { class: 'tvw-toggle' });
  const verdictEl = h('div', { class: 'verdict' });
  const tradesEl = h('div');
  const costEl = h('div', { class: 'scroll-x' });
  const card = h('div', { class: 'card' },
    h('h3', null, 'Term or whole life, for your situation'),
    h('p', { class: 'lede' }, 'The shaded area is what your family would need if you weren’t here, year by year. It shrinks as the mortgage gets paid down and the kids grow up.'),
    toggles, chartEl, verdictEl, tradesEl,
    h('h3', { style: { fontSize: '1.2rem', marginTop: '18px' } }, 'Rough monthly cost'),
    costEl,
    h('p', { class: 'fine' }, 'Illustrative ranges for education only, not a quote. Real prices depend on underwriting, the insurer and policy details.'),
    sourcesEl(['naic', 'iii']));
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text != null) e.textContent = text; return e; };
  function draw() {
    const p = P(), C = S.coverage || compute(p).tiers.balanced; if (!C) return;
    const R = tradeoffs(p, C), tp = R.tp;
    const age = p.age || 35, span = clamp(Math.min(45, 90 - age), 20, 45);
    const W = clamp(Math.round(chartEl.clientWidth || 640), 300, 680), H = 260, L = 52, Rr = 16, Tp = 16, B = 34;
    const tickStep = W < 480 ? 10 : 5;
    const maxY = Math.max(C, gapAt(p, 0)) * 1.12;
    const x = t => L + (W - L - Rr) * t / span, y = v => Tp + (H - Tp - B) * (1 - v / maxY);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img', 'aria-label': `Needs over ${span} years compared with term, ladder and whole life coverage` });
    // grid
    for (let i = 0; i <= 4; i++) { const v = maxY * i / 4; svg.append(el('line', { x1: L, x2: W - Rr, y1: y(v), y2: y(v), stroke: 'var(--line)', 'stroke-width': 1 })); svg.append(el('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--ink-3)' }, fmtK(v))); }
    for (let t = 0; t <= span - 3; t += tickStep) svg.append(el('text', { x: x(t), y: H - 12, 'text-anchor': t === 0 ? 'start' : 'middle', 'font-size': 11, fill: 'var(--ink-3)' }, t === 0 ? 'Today' : `Age ${age + t}`));
    // need area
    const gaps = []; for (let t = 0; t <= span; t++) gaps.push(gapAt(p, t));
    let d = `M ${x(0)} ${y(0)}`; gaps.forEach((g, t) => { d += ` L ${x(t)} ${y(g)}`; }); d += ` L ${x(span)} ${y(0)} Z`;
    svg.append(el('path', { d, fill: 'var(--brand-tint)', stroke: 'var(--brand-soft)', 'stroke-width': 1.5 }));
    // options
    const lines = {
      term: { color: 'var(--ok)', pts: [[0, C], [tp.T, C], [tp.T, 0], [span, 0]], label: `${tp.T}-year term` },
      ladder: tp.ladder ? { color: 'var(--river)', pts: [[0, C], [tp.ladder.short.years, C], [tp.ladder.short.years, tp.ladder.long.amount], [tp.ladder.long.years, tp.ladder.long.amount], [tp.ladder.long.years, 0], [span, 0]], label: 'Term ladder' } : null,
      whole: { color: 'var(--brand)', pts: [[0, C], [span, C]], label: 'Whole life' }
    };
    for (const [k, o] of Object.entries(lines)) {
      if (!o) continue;
      const on = sel.v === k;
      svg.append(el('path', { d: 'M ' + o.pts.map(([t, v]) => `${x(t)} ${y(v)}`).join(' L '), fill: 'none', stroke: o.color, 'stroke-width': on ? 3.5 : 1.5, opacity: on ? 1 : .35, 'stroke-dasharray': k === 'whole' ? '7 5' : '0', 'stroke-linejoin': 'round' }));
    }
    const o = lines[sel.v]; if (o) { const lp = o.pts[1]; svg.append(el('text', { x: Math.min(x(lp[0]) - 6, W - Rr - 4), y: y(lp[1]) - 8, 'text-anchor': 'end', 'font-size': 12.5, 'font-weight': 600, fill: o.color }, o.label)); }
    svg.append(el('text', { x: x(0) + 8, y: y(gaps[0] * 0.35), 'font-size': 12, fill: 'var(--brand)', 'font-weight': 600 }, 'What your family'));
    svg.append(el('text', { x: x(0) + 8, y: y(gaps[0] * 0.35) + 15, 'font-size': 12, fill: 'var(--brand)', 'font-weight': 600 }, 'would need'));
    chartEl.innerHTML = ''; chartEl.append(svg);
    // toggles
    toggles.innerHTML = '';
    [['term', `${tp.T}-year term`], tp.ladder ? ['ladder', 'Term ladder'] : null, ['whole', 'Whole life']].filter(Boolean).forEach(([k, label]) =>
      toggles.append(optButton({ label }, () => { sel.v = k; draw(); }, sel.v === k)));
    verdictEl.innerHTML = md(R.verdict);
    tradesEl.innerHTML = '';
    for (const t of R.out) tradesEl.append(h('div', { class: 'trade' }, h('span', { class: 'lean ' + t.lean }, t.lean === 'term' ? 'Favors term' : t.lean === 'whole' ? 'Favors whole' : 'Either way'), h('div', null, h('b', null, t.title), h('p', null, t.body))));
    // costs
    const rows = [[`${tp.T}-year term, ${fmtK(C)}`, rangeTxt(R.term), 'Ends after ' + tp.T + ' years']];
    if (tp.ladder) { const a = premium(p, tp.ladder.long.amount, 'term', tp.ladder.long.years), b = premium(p, tp.ladder.short.amount, 'term', tp.ladder.short.years); rows.push([`Ladder: ${fmtK(tp.ladder.long.amount)} for ${tp.ladder.long.years} yrs + ${fmtK(tp.ladder.short.amount)} for ${tp.ladder.short.years} yrs`, `${money0(a.lo + b.lo)}–${money0(a.hi + b.hi)}`, 'Steps down as needs shrink']); }
    rows.push([`Whole life, ${fmtK(C)}`, rangeTxt(R.whole), 'Lifelong, builds cash value']);
    const w2 = premium(p, 50000, 'whole'); rows.push([`Term ${fmtK(C)} plus whole life ${fmtK(50000)}`, `${money0(R.term.lo + w2.lo)}–${money0(R.term.hi + w2.hi)}`, 'A mix of both']);
    costEl.innerHTML = '';
    const rc = riskClass(p.health); const health = rc.known ? `Based on your estimated price class, ${rc.cls.name}.` : 'Assumes average health, so the range is wide.';
    costEl.append(h('table', { class: 'costs' }, h('thead', null, h('tr', null, h('th', null, 'Option'), h('th', null, 'What it does'), h('th', { style: { textAlign: 'right' } }, 'Per month'))),
      h('tbody', null, rows.map(r => h('tr', null, h('td', null, r[0]), h('td', { style: { color: 'var(--ink-2)' } }, r[2]), h('td', { class: 'n' }, r[1]))))),
      h('p', { class: 'fine' }, health));
  }
  card._init = () => live(card, draw);
  return card;
}

/* ---------- estimated price class ---------- */
function premiumAtClass(age, key, amount, kind, years = 20) {
  const rate = kind === 'term' ? interp(TERM20, age || 35) * (TERMF[years] || 1) : interp(WHOLE, age || 35);
  return amount / 1000 * rate / 12 * CLS[key][kind];
}
function classBlock(H, age, C, pol) {
  const rc = riskClass(H); if (!rc.known) return null;
  const kind = pol.type, yrs = pol.years || 20;
  const q = premiumFor(age, H, C, kind, yrs), std = premiumAtClass(age, 'std', C, kind, yrs);
  const tob = rc.key === 'ptob' || rc.key === 'stob';
  const ladder = h('div', { class: 'ladder', role: 'img', 'aria-label': `Estimated class: ${rc.cls.name}` },
    LADDER.map((k, i) => h('div', { class: 'rung' + ((tob ? (rc.key === 'ptob' ? 1 : 3) : rc.rung) === i ? ' on' : '') }, h('i'), h('span', null, CLS[k].name))));
  const diff = std - q.mid;
  const list = (title, arr, cls) => arr.length ? h('div', { class: 'why-list ' + cls }, h('b', null, title), h('ul', null, arr.map(x => h('li', null, x)))) : null;
  return h('div', null,
    h('div', { class: 'class-name' }, rc.cls.name, tob ? h('span', { class: 'pill' }, 'Tobacco rates') : null),
    ladder,
    h('p', { class: 'reaction', html: md(`For **${fmtK(C)}** of ${policyName(pol).toLowerCase()} coverage, that’s roughly **${rangeTxt(q)}** a month. ` + (Math.abs(diff) < 2 ? 'That’s about the same as the Standard class.' : diff > 0 ? `At Standard it would be about ${money0(std)}, so your health could save roughly **${money0(diff)} a month**.` : `At Standard it would be about ${money0(std)}, so expect to pay roughly ${money0(-diff)} more a month for now.`)) }),
    h('div', { class: 'why-grid' }, list('What helps', rc.good, 'good'), list('What holds it back', rc.held, 'held')),
    rc.improve.length ? list('Ways to improve it', rc.improve, 'tips') : null,
    h('p', { class: 'fine' }, 'Insurers set the final class after an application, often with a short exam. These answers stay on this page and are never saved.'));
}
async function renderRisk() {
  await say('Here’s what your health means for the price.');
  appendCard('risk');
}
function buildRisk() {
  const card = h('div', { class: 'card' });
  card._init = () => live(card, () => {
    const p = P(), C = S.coverage || compute(p).tiers.balanced;
    card.hidden = !healthShared(p.health) || !C; if (card.hidden) return;
    const pol = p.policy || { type: 'term', years: termPlan(p, C).T >= 30 ? 30 : termPlan(p, C).T > 10 ? 20 : 10 };
    card.innerHTML = '';
    card.append(h('h3', null, 'Your estimated price class'),
      h('p', { class: 'lede' }, 'Insurers sort applicants into classes. A better class means a lower price for the same coverage.'),
      classBlock(p.health, p.age, C, pol) || h('p', null, 'No health details shared yet.'));
  });
  return card;
}
function personalizeHealth(who, silent) {
  const p = P();
  const ids = who === 'you' ? ['hNic', 'hHW', 'hBP', 'hCond', 'hFam', 'hLife', 'risk'] : ['phNic', 'phHW', 'phBP', 'phCond', 'phFam', 'phLife'];
  if (who === 'you') { p._health = true; S.done.add('healthGate'); } else { p.partner._health = true; S.done.add('pHealthGate'); }
  ids.forEach(id => S.done.delete(id));
  if (!silent) meBubble(who === 'you' ? 'Personalize with my health details' : 'Personalize my partner’s estimate', null);
  if (!S.running) run(); else toast('I’ll ask a few health questions next.');
}

/* ---------- the policy you chose ---------- */
async function renderPolicy() {
  await say('Here’s your policy, put together.');
  appendCard('policy');
}
function buildPolicy() {
  const card = h('div', { class: 'card policy-card' });
  card._init = () => live(card, () => {
    const p = P(), C = S.coverage, pol = p.policy; card.hidden = !pol || !C; if (card.hidden) return;
    const whole = pol.type === 'whole';
    const q = premium(p, C, pol.type, pol.years), rc = riskClass(p.health);
    card.innerHTML = '';
    const facts = h('div', { class: 'facts' },
      h('div', null, h('span', null, 'Policy'), h('b', null, policyName(pol))),
      h('div', null, h('span', null, 'Death benefit'), h('b', null, fmtK(C))),
      h('div', null, h('span', null, 'Estimated cost'), h('b', null, `${rangeTxt(q)}/mo`)),
      h('div', null, h('span', null, 'Price class'), h('b', null, rc.known ? rc.cls.name : 'Average health assumed')));
    const def = whole
      ? 'Whole life is permanent insurance. Part of what you pay supports the insurance and its costs, and another part builds cash value over time that you can borrow against.'
      : `With term life, you pay a relatively low premium for ${pol.years} years. If you pass away during the term, your beneficiaries receive the death benefit. There’s generally no cash value.`;
    const parts = [h('h3', null, 'Your policy'), facts, h('p', { class: 'lede', style: { marginTop: '16px' } }, def)];
    if (!whole) {
      const chk = termEndCheck(p, pol.years);
      parts.push(h('div', { class: 'stress' + (chk.short ? ' short' : '') }, chk.short
        ? `When this term ends, your family would still need about ${fmtK(chk.gEnd)}. A longer term, or a ladder of two policies, would close that gap.`
        : `When this term ends, most of what your family relies on you for will already be taken care of.`));
      parts.push(h('p', { class: 'helps' }, 'Many term policies can be converted to permanent coverage later without new health questions.'));
    } else {
      const age = p.age || 35, rows = [];
      for (const y of [10, 20, 30]) if (age + y <= 95) rows.push([`Year ${y}`, `age ${age + y}`, cashValueAt(p, C, y)]);
      if (65 - age > 0 && ![10, 20, 30].includes(65 - age)) rows.push([`At 65`, `year ${65 - age}`, cashValueAt(p, C, 65 - age)]);
      rows.sort((a, b) => a[2].paid - b[2].paid);
      parts.push(h('h3', { style: { fontSize: '1.1rem', marginTop: '18px' } }, 'How the cash value could grow'),
        h('div', { class: 'scroll-x' }, h('table', { class: 'costs' },
          h('thead', null, h('tr', null, h('th', null, 'When'), h('th', { style: { textAlign: 'right' } }, 'You’d have paid'), h('th', { style: { textAlign: 'right' } }, 'Cash value'))),
          h('tbody', null, rows.map(([a, b, v]) => h('tr', null, h('td', null, a, h('span', { style: { color: 'var(--ink-3)' } }, `, ${b}`)), h('td', { class: 'n' }, fmtK(v.paid)), h('td', { class: 'n' }, fmtK(v.cv))))))),
        h('p', { class: 'fine' }, `Illustrative only, assuming about 3% yearly growth${p.cvDeposit ? ` and your ${fmtK(p.cvDeposit)} deposit` : ''}. Early payments mostly cover costs, so cash value starts slowly. Real values depend on the policy and aren’t guaranteed beyond the contract’s minimums.`));
    }
    if (p.savings) {
      const kept = Math.max(0, p.savings - (p.savingsUse || 0) - (p.cvDeposit || 0));
      parts.push(h('p', { class: 'helps' }, `Your ${fmtK(p.savings)} in savings: ${listJoin([p.savingsUse ? `${fmtK(p.savingsUse)} toward the plan` : null, p.cvDeposit ? `${fmtK(p.cvDeposit)} into cash value` : null, kept ? `${fmtK(kept)} kept as your safety net` : null].filter(Boolean))}.`));
    }
    parts.push(h('div', { class: 'actions', style: { marginTop: '14px' } },
      !rc.known ? h('button', { class: 'btn', type: 'button', onclick: () => personalizeHealth('you') }, 'Personalize with health details') : null,
      h('button', { class: 'btn quiet', type: 'button', onclick: () => editNode(NODE.policyType, null) }, 'Change policy')));
    card.append(...parts);
  });
  return card;
}

/* ---------- options for people with more to protect ---------- */
async function renderWealth() {
  await say('Based on what you’ve shared, a few options beyond a basic policy may be worth a look.');
  appendCard('wealth');
}
function buildWealth() {
  const state = { layer: null };
  const card = h('div', { class: 'card wealth-card' });
  card._init = () => live(card, () => {
    const p = P(), w = wealthProfile(p), age = p.age || 45;
    card.hidden = !w.tier; if (card.hidden) return;
    if (state.layer == null) state.layer = w.tier === 'high' ? 2000000 : 1000000;
    const reasons = { income: 'a higher income', assets: 'significant savings and investments', home: 'a high-value home', business: 'a business to protect' };
    const why = listJoin(w.why.map(x => reasons[x]).filter(Boolean)) || 'what you’ve shared';
    const L = state.layer, wr = interp(WHOLE, age);
    const mo = f => money0(L / 1000 * wr * f / 12);
    const couple = hasPartner(p), partnerAge = p.partner.age || age, jointAge = Math.round((age + partnerAge) / 2);
    const opts = [
      { t: 'Guaranteed universal life', d: 'Lifelong coverage, usually for less than whole life, with little cash value.', b: 'Keeps money in place for your heirs or estate costs at the lowest permanent price.', price: `about ${mo(0.55)}/mo` },
      { t: 'Indexed universal life', d: 'Cash value linked to a market index, with a floor so it doesn’t lose value when the index falls. Premiums are flexible.', b: 'Tax-deferred growth potential, with access to cash value through policy loans.', price: `about ${mo(0.7)}/mo` },
      couple ? { t: 'Survivorship life', d: 'One policy covering both of you that pays after the second person passes.', b: 'Often used to pay estate taxes, and costs less per dollar than two separate policies.', price: `about ${money0(L / 1000 * interp(WHOLE, jointAge) * 0.45 / 12)}/mo` } : null,
      { t: 'Life insurance with long-term care benefits', d: 'Lets you use part of the death benefit to pay for long-term care.', b: 'One policy covers two risks. If care is never needed, your family receives the benefit.', price: 'varies' },
      p.businessOwner ? { t: 'Coverage for your business', d: 'Key person coverage, and funding for a buy-sell agreement with your partners.', b: 'Keeps the business steady and gives co-owners cash to buy your share at a fair price.', price: 'varies' } : null,
      { t: 'Owning the policy through a trust', d: 'An irrevocable life insurance trust, set up with an attorney, can keep the death benefit outside your taxable estate.', b: 'More of what you leave can go to your family instead of estate taxes.', price: 'legal fees' }
    ].filter(Boolean);
    const slider = h('input', { type: 'range', class: 'range', min: 250000, max: 10000000, step: 250000, value: L, 'aria-label': 'Lasting coverage to leave behind' });
    slider.addEventListener('input', () => { state.layer = Number(slider.value); refresh(); });
    card.innerHTML = '';
    card.append(
      h('h3', null, 'Options worth knowing about'),
      h('p', { class: 'lede' }, compute(p).gap > 0
        ? `With ${why}, coverage can do more than replace income. It can help pass on wealth, protect a business, or pay for care later.`
        : `Your savings already cover your family’s day-to-day needs. With ${why}, life insurance is usually less about replacing income and more about what you pass on, protecting a business, or paying for care later.`),
      h('div', { class: 'row', style: { fontWeight: 600 } }, h('span', null, 'Lasting coverage to leave behind'), h('span', null, fmtK(L))),
      slider,
      h('div', { class: 'opt-grid' }, opts.map(o => h('div', { class: 'opt-card' }, h('b', null, o.t), h('p', null, o.d), h('p', { class: 'benefit' }, o.b), h('span', { class: 'price' }, o.price)))),
      h('div', { class: 'why-list good' }, h('b', null, 'What permanent coverage can do'), h('ul', null,
        h('li', null, 'The death benefit is generally paid to beneficiaries free of income tax.'),
        h('li', null, 'Cash value grows tax-deferred, and you can usually borrow against it.'),
        h('li', null, 'It gives your family cash to settle estate costs without selling a home, investments or a business.'))),
      h('p', { class: 'fine' }, 'Prices are rough illustrations for a healthy person at your age. Tax rules depend on your situation, so plan these with a licensed professional and a tax advisor.'),
      sourcesEl(['naic', 'iii']));
    if (document.activeElement !== slider) slider.value = L;
  });
  return card;
}

/* ---------- your partner's coverage ---------- */
async function renderPartnerPolicy() {
  await say('Here’s what covering your partner could look like.');
  appendCard('partnerPolicy');
}
function buildPartnerPolicy() {
  const card = h('div', { class: 'card' });
  card._init = () => live(card, () => {
    const p = P(), pc = compute(partnerProfile(p)), C = pc.tiers.balanced;
    card.hidden = !hasPartner(p) || !p.partner.cover || !C; if (card.hidden) return;
    const pol = p.policy || { type: 'term', years: 20 }, H = p.partner.health, rc = riskClass(H);
    const q = partnerPremium(p, C, pol.type, pol.years);
    card.innerHTML = '';
    card.append(h('h3', null, 'Your partner’s coverage'),
      h('div', { class: 'facts' },
        h('div', null, h('span', null, 'Policy'), h('b', null, policyName(pol))),
        h('div', null, h('span', null, 'Death benefit'), h('b', null, fmtK(C))),
        h('div', null, h('span', null, 'Estimated cost'), h('b', null, `${rangeTxt(q)}/mo`)),
        h('div', null, h('span', null, 'Price class'), h('b', null, rc.known ? rc.cls.name : 'Average health assumed'))),
      rc.known ? h('div', { style: { marginTop: '16px' } }, classBlock(H, p.partner.age || p.age, C, pol)) : h('div', { class: 'actions', style: { marginTop: '14px' } }, h('button', { class: 'btn', type: 'button', onclick: () => personalizeHealth('partner') }, 'Personalize with their health details')),
      p.policy && S.coverage ? h('p', { class: 'helps' }, `Together with your ${policyName(p.policy).toLowerCase()}, your household would pay roughly ${money0(premium(p, S.coverage, p.policy.type, p.policy.years).lo + q.lo)}–${money0(premium(p, S.coverage, p.policy.type, p.policy.years).hi + q.hi)} a month.`) : null);
  });
  return card;
}

/* ---------- family: two sides of the household ---------- */
function sideStatus(p, C) {
  const s = simulate(p, C);
  return s.goals.map(g => ({ label: g.label, st: g.pct >= 0.995 ? 'ok' : 'part', txt: g.pct >= 0.995 ? 'Protected' : g.pct > 0.005 ? 'Partly' : 'Not yet' }));
}
async function renderFamily() {
  await say('Here’s your household from both sides.');
  appendCard('family');
}
function buildFamily() {
  const body = h('div');
  const sentence = h('p', { class: 'reaction' });
  const card = h('div', { class: 'card' }, h('h3', null, 'Your household has two plans'), h('p', { class: 'lede' }, 'Each side shows what would be needed if that person weren’t here, and what a sensible amount of coverage would protect.'), body, sentence);
  card._init = () => live(card, () => {
    const p = P();
    card.hidden = !(hasPartner(p) && p.partner.depends && p.partner.depends !== 'no'); if (card.hidden) return;
    const you = compute(p), pp = partnerProfile(p), them = compute(pp);
    const Cy = S.coverage ?? you.tiers.balanced, Cp = them.tiers.balanced;
    const side = (title, c, C, prof) => h('div', { class: 'side' }, h('h4', null, title),
      h('div', { class: 'row' }, h('span', null, 'Would need'), h('b', null, fmtK(c.need))),
      h('div', { class: 'row' }, h('span', null, 'Already have'), h('b', null, '−' + fmtK(c.have))),
      h('div', { class: 'row total' }, h('span', null, 'Still to cover'), h('span', null, fmtK(c.gap))),
      h('div', { class: 'row' }, h('span', null, 'Suggested coverage'), h('b', null, fmtK(C))),
      h('ul', { class: 'status' }, sideStatus(prof, C).map(x => h('li', null, h('span', null, x.label), h('span', { class: 's ' + x.st }, x.txt)))));
    body.innerHTML = '';
    body.append(h('div', { class: 'duo' }, side('If something happened to you', you, Cy, p), side('If something happened to your partner', them, Cp, pp)));
    const topYou = [...you.items].sort((a, b) => b.amount - a.amount)[0], topThem = [...them.items].sort((a, b) => b.amount - a.amount)[0];
    const what = it => it ? ({ income: 'income', home: 'the home', education: 'education', childcare: 'childcare', cushion: 'immediate costs', debts: 'debts', household: 'household help', care: 'family care' })[it.key] || it.label.toLowerCase() : 'costs';
    const bigger = you.gap >= them.gap ? 'your side' : 'your partner’s side';
    const ccThem = them.items.find(i => i.key === 'childcare');
    sentence.innerHTML = md(`Your household is more exposed on **${bigger}**. The largest piece on your side is **${what(topYou)}**, and on your partner’s side it’s **${what(topThem)}**.${ccThem && p.partner.childcareNeeded ? ` Replacing the childcare your partner provides adds **${fmtK(ccThem.amount)}** on their side.` : ''} Many families only insure the main earner, so this second plan is often the one that’s missing.`);
  });
  return card;
}

/* ---------- explore: planned and sudden changes ---------- */
function clone(o) { return JSON.parse(JSON.stringify(o)); }
const monthlySpend = p => (p.income || 60000) * S.A.replace / 12;
/* a sudden cost uses the safety-net savings first, then savings set aside for the plan, then becomes debt */
function drawSavings(q, amount) {
  const sav = q.savings || 0, use = q.savingsUse || 0, dep = q.cvDeposit || 0;
  const free = Math.max(0, sav - use - dep);
  const fromFree = Math.min(free, amount), fromUse = Math.min(use, amount - fromFree);
  q.savings = Math.round(sav - fromFree - fromUse);
  if (q.savingsUse != null) q.savingsUse = Math.round(use - fromUse);
  const rest = Math.round(amount - fromFree - fromUse);
  if (rest > 0) q.debts = (q.debts || 0) + rest;
}
const LIFE_EVENTS = [
  { k: 'baby', icon: '👶', label: 'We have a baby' },
  { k: 'home', icon: '🏠', label: p => p.housing === 'own_mortgage' ? 'We move to a bigger home' : 'We buy a home' },
  { k: 'raise', icon: '💰', label: 'I get a raise', when: p => !!p.income },
  { k: 'jobs', icon: '💼', label: 'I change jobs' },
  { k: 'payoff', icon: '💳', label: 'We pay off debt', when: p => p.mortgage || p.debts },
  { k: 'save', icon: '💵', label: 'We build more savings' },
  { k: 'partner', icon: '❤️', label: 'My partner stops working', when: p => hasPartner(p) && p.partner.depends && p.partner.depends !== 'no' }
];
const SUDDEN_EVENTS = [
  { k: 'joblost', icon: '📉', label: 'I suddenly lose my job', when: p => !!p.income },
  { k: 'illness', icon: '🩺', label: 'A serious illness or injury', when: p => !!p.income },
  { k: 'market', icon: '📊', label: 'Our investments drop', when: p => p.savings > 0 },
  { k: 'expense', icon: '🧾', label: 'A big unexpected bill' },
  { k: 'inflation', icon: '🔥', label: 'Prices keep rising fast' },
  { k: 'carer', icon: '🧓', label: 'A parent needs our support' }
];
const ALL_EVENTS = [...LIFE_EVENTS, ...SUDDEN_EVENTS];
const eventLabel = (k, p) => { const e = ALL_EVENTS.find(x => x.k === k); return typeof e.label === 'function' ? e.label(p) : e.label; };
function scenarioDefaults(k, p) {
  return ({
    baby: { childcare: true, education: true, longer: true },
    home: { amount: roundTo(Math.max(300000, (p.mortgage || 0) * 1.5), 10000) },
    raise: { amount: roundTo((p.income || 75000) * 1.15, 5000) },
    jobs: { newJob: 'none' }, payoff: { what: p.mortgage ? 'home' : 'debts' },
    save: { amount: roundTo((p.savings || 0) + 50000, 5000) }, partner: {},
    joblost: { months: 6, newJob: 'none' }, illness: { months: 6, bills: 10000, disability: false },
    market: { drop: 0.3 }, expense: { amount: 25000 }, inflation: { rate: 0.005 }, carer: { annual: 12000, years: 8 }
  })[k];
}
function scenarioDetail(k, prm) {
  return ({
    home: `${fmtK(prm.amount)} mortgage`, raise: `${fmtK(prm.amount)} a year`, save: `${fmtK(prm.amount)} saved`,
    joblost: `${prm.months} months`, illness: `${prm.months} months off work`, market: `down ${Math.round(prm.drop * 100)}%`,
    expense: fmtK(prm.amount), inflation: `${pct(prm.rate, 1)} growth`, carer: `${fmtK(prm.annual)} a year`
  })[k] || '';
}
/* returns the changed household and assumptions; never touches the real plan */
function applyEvent(k, prm, p, A = S.A) {
  const q = clone(p); let A2 = { ...A };
  switch (k) {
    case 'baby':
      q.kids = [...kidsOf(q), 0];
      if (q.household === 'just_me' || !q.household) q.household = 'children';
      if (q.household === 'partner') q.household = 'partner_children';
      if (prm.childcare) { q.childcareAnnual = q.childcareAnnual || 15000; q.kidGoals = [...new Set([...(q.kidGoals || []).filter(x => x !== 'none'), 'childcare'])]; }
      if (prm.education) { q.educationPerKid = q.educationPerKid || 50000; q.kidGoals = [...new Set([...(q.kidGoals || []).filter(x => x !== 'none'), 'education'])]; }
      if (prm.longer && q.income) { q.incomeYearsChoice = 'grown'; q.incomeYears = null; }
      break;
    case 'home': q.housing = 'own_mortgage'; q.mortgage = prm.amount; q.mortgagePlan = p.mortgagePlan && p.mortgagePlan !== 'none' ? p.mortgagePlan : 'full'; break;
    case 'raise': q.income = prm.amount; break;
    case 'jobs': if (q.coverageSource === 'work') q.coverage = prm.newJob === 'same' ? p.coverage : 0; break;
    case 'payoff': if (prm.what !== 'debts') { q.mortgage = 0; q.mortgagePlan = 'none'; } if (prm.what !== 'home') q.debts = 0; break;
    case 'save': { const add = prm.amount - (p.savings || 0); q.savings = prm.amount; q.savingsUse = Math.max(0, (p.savingsUse || 0) + add); break; }
    case 'partner': q.partner.income = 0; if (hasKids(q)) { q.partner.contrib = [...new Set([...(q.partner.contrib || []).filter(x => x !== 'none'), 'childcare'])]; q.partner.childcareNeeded = true; q.partner.childcareAnnual = q.partner.childcareAnnual || q.childcareAnnual || 15000; } break;
    case 'joblost':
      if (q.coverageSource === 'work' && prm.newJob !== 'same') q.coverage = 0;
      drawSavings(q, prm.months * monthlySpend(p));
      break;
    case 'illness':
      drawSavings(q, prm.months * monthlySpend(p) * (prm.disability ? 0.4 : 1) + prm.bills);
      break;
    case 'market': q.savings = Math.round((q.savings || 0) * (1 - prm.drop)); if (q.savingsUse != null) q.savingsUse = Math.round(q.savingsUse * (1 - prm.drop)); break;
    case 'expense': drawSavings(q, prm.amount); break;
    case 'inflation': A2 = { ...A, rate: prm.rate }; break;
    case 'carer':
      q.extras = [...(q.extras || []), { key: 'parentcare', label: 'Support for a parent', annual: prm.annual, years: prm.years, why: `About ${fmt(prm.annual)} a year for ${prm.years} years to help a parent with care and living costs.` }];
      break;
  }
  return { q, A2 };
}
const LEADS = {
  baby: 'A child usually adds two big things to protect: care costs and future support.',
  home: 'A bigger mortgage means more to pay off if you want your family to keep the home.',
  raise: 'More income means a bigger paycheck to replace.',
  payoff: 'Paying off debt shrinks what insurance needs to cover.',
  save: 'Every dollar your family could use is a dollar insurance doesn’t need to provide.',
  partner: 'If your partner stops working, their income no longer needs replacing, but the care they provide is worth more.',
  joblost: 'We assume savings cover your share of household costs while you look for work, and anything beyond that becomes debt.',
  illness: 'While you recover, savings cover your share of household costs plus medical bills. Anything beyond that becomes debt.',
  market: 'If investments fall, your family has less to draw on, so insurance has to do more.',
  expense: 'A large bill comes out of savings first. Whatever savings can’t cover becomes debt.',
  inflation: 'When prices rise faster than money grows, the money set aside stretches less far.',
  carer: 'Supporting a parent adds a new, ongoing cost your family would need to keep covering.'
};
const HELPS = {
  joblost: 'What helps: an emergency fund of three to six months, and a policy you own rather than one tied to your job.',
  illness: 'What helps: life insurance only pays if you aren’t here. Disability insurance replaces part of your income if you can’t work, and many employers offer it.',
  market: 'What helps: keeping your family’s safety money in steady savings, and building in a little extra coverage.',
  expense: 'What helps: an emergency fund keeps one bill from turning into debt.',
  inflation: 'What helps: a little more coverage, or a quick review of your plan every few years.',
  carer: 'What helps: revisiting your plan whenever someone new starts relying on you.'
};
function chosenCoverage() { const p = P(); return S.coverage > 0 ? S.coverage : compute(p).tiers.balanced; }
function stressTest(q, A2) {
  const C = chosenCoverage(); if (!C) return null;
  const s = simulate(q, C, A2), g = compute(q, A2).gap, short = Math.max(0, g - C);
  if (s.runOut == null || short < 1000) return { ok: true, C, short: 0, text: `Your ${fmtK(C)} would still cover everything${s.leftover > 5000 ? `, with about ${fmtK(s.leftover)} to spare` : ''}.` };
  return { ok: false, C, short, text: `Your ${fmtK(C)} would fall about ${fmtK(short)} short.${s.runOut > 0 ? ` It would still fully carry your family through Year ${s.runOut}.` : ''}` };
}

async function renderExplore() {
  await say(['Your plan works for your life today.', { q: 'What happens when life changes, or something sudden happens?' }]);
  appendCard('explore');
  await say('You can also just type to me below. Ask anything, tell me what’s changed and I’ll update your plan, or ask for a what-if like “what if I lose my job?”');
}
function buildExplore() {
  const state = { tab: 'life', k: null, prm: {} };
  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Kinds of change' });
  const grid = h('div', { class: 'events' });
  const body = h('div');
  const compareEl = h('div');
  const footer = h('div', { class: 'actions', style: { marginTop: '18px' } });
  const card = h('div', { class: 'card' },
    h('h3', null, 'Try a scenario'),
    h('p', { class: 'lede' }, 'Your plan updates instantly, and nothing changes unless you keep it. Add scenarios to compare them side by side.'),
    tabsEl, grid, body, compareEl, footer);

  const drawTabs = () => {
    tabsEl.innerHTML = '';
    for (const [k, label] of [['life', 'Life changes'], ['sudden', 'Sudden changes']]) {
      tabsEl.append(h('button', { type: 'button', role: 'tab', 'aria-selected': String(state.tab === k), onclick: () => { state.tab = k; state.k = null; drawAll(); } }, label));
    }
  };
  const drawGrid = () => {
    const p = P(); grid.innerHTML = '';
    const list = state.tab === 'life' ? LIFE_EVENTS : SUDDEN_EVENTS;
    for (const e of list) {
      if (e.when && !e.when(p)) continue;
      grid.append(optButton({ icon: e.icon, label: eventLabel(e.k, p) }, () => { state.k = e.k; state.prm = scenarioDefaults(e.k, P()); drawGrid(); drawBody(); }, state.k === e.k));
    }
  };
  const toggle = (label, key) => optButton({ label }, () => { state.prm[key] = !state.prm[key]; drawBody(); }, !!state.prm[key]);
  const choice = (opts, key) => h('div', { class: 'toggles' }, opts.map(([v, l]) => optButton({ label: l }, () => { state.prm[key] = v; drawBody(); }, state.prm[key] === v)));
  const slider = (label, key, min, max, step, show = fmtK) => {
    const v = h('b', null, show(state.prm[key]));
    const r = h('input', { type: 'range', class: 'range', min, max, step, value: state.prm[key], 'aria-label': label });
    r.addEventListener('input', () => { state.prm[key] = Number(r.value); v.textContent = show(state.prm[key]); drawNums(); });
    return h('div', null, h('div', { class: 'row' }, h('span', null, label), v), r);
  };
  const numsEl = h('div'), breakEl = h('div'), stressEl = h('div');
  function drawNums() {
    if (!state.k) return;
    const p = P(), { q, A2 } = applyEvent(state.k, state.prm, p);
    const partnerSide = state.k === 'partner';
    const A0 = partnerSide ? compute(partnerProfile(p)) : compute(p), A1 = partnerSide ? compute(partnerProfile(q), A2) : compute(q, A2);
    const delta = A1.gap - A0.gap;
    numsEl.innerHTML = '';
    numsEl.append(h('div', { class: 'ex-nums' },
      h('div', null, h('div', { class: 'lbl' }, partnerSide ? 'Partner today' : 'Still to cover today'), h('div', { class: 'n' }, fmtK(A0.gap))),
      h('div', { 'aria-hidden': 'true', style: { color: 'var(--ink-3)', fontSize: '1.4rem' } }, '→'),
      h('div', null, h('div', { class: 'lbl' }, 'With this change'), h('div', { class: 'n' }, fmtK(A1.gap))),
      h('span', { class: 'delta ' + (delta > 500 ? 'up' : delta < -500 ? 'down' : '') }, (delta > 0 ? '+' : delta < 0 ? '−' : '') + fmtK(Math.abs(delta)))));
    const keys = new Set([...A0.items.map(i => i.key), ...A1.items.map(i => i.key)]);
    const lines = [];
    for (const key of keys) { const a = A0.items.find(i => i.key === key), b = A1.items.find(i => i.key === key); const d = (b ? b.amount : 0) - (a ? a.amount : 0); if (Math.abs(d) > 500) lines.push([(b || a).label.replace(/ for \d+ years?/, ''), d]); }
    if (!partnerSide) {
      const sv = x => { const r = compute(x, A2).res.find(r => r.key === 'savings'); return r && r.counted ? r.amount : 0; };
      const sav0 = sv(p), sav1 = sv(q);
      if (Math.abs(sav1 - sav0) > 500) lines.push([sav1 < sav0 ? 'Less savings to draw on' : 'More savings to draw on', sav0 - sav1]);
      const cov0 = compute(p).res.find(r => r.key === 'coverage'), cov1 = compute(q, A2).res.find(r => r.key === 'coverage');
      const c0 = cov0 && cov0.counted ? cov0.amount : 0, c1 = cov1 && cov1.counted ? cov1.amount : 0;
      if (Math.abs(c1 - c0) > 500) lines.push([c1 < c0 ? 'Work coverage ends' : 'More coverage', c0 - c1]);
    }
    breakEl.innerHTML = '';
    if (lines.length) breakEl.append(h('div', null, lines.map(([l, d]) => h('div', { class: 'row' }, h('span', null, l), h('b', { style: { color: d > 0 ? 'var(--open)' : 'var(--ok)' } }, (d > 0 ? '+' : '−') + fmtK(Math.abs(d)))))));
    else breakEl.append(h('p', { class: 'note' }, 'No change to your plan.'));
    stressEl.innerHTML = '';
    if (!partnerSide) { const st = stressTest(q, A2); if (st) stressEl.append(h('div', { class: 'stress' + (st.ok ? '' : ' short') }, st.text)); }
  }
  function drawBody() {
    body.innerHTML = ''; if (!state.k) return;
    const p = P(), k = state.k, parts = [];
    const lead = k === 'jobs' ? (p.coverageSource === 'work' ? `Coverage through work usually stays behind when you leave. Your ${fmtK(p.coverage)} would likely end.` : 'Your coverage is your own, so it moves with you.') : LEADS[k];
    parts.push(h('p', { class: 'reaction', style: { borderTop: 0, paddingTop: 0, marginTop: 0 }, html: md(lead) }));
    if (k === 'baby') parts.push(h('div', { class: 'toggles' }, toggle('Childcare', 'childcare'), toggle('Education', 'education'), p.income ? toggle('Income until they’re grown', 'longer') : null));
    if (k === 'home') parts.push(slider('New mortgage', 'amount', 50000, 1200000, 10000));
    if (k === 'raise') parts.push(slider('New yearly income', 'amount', Math.max(20000, roundTo(p.income * 0.8, 5000)), roundTo(p.income * 2, 5000), 5000));
    if (k === 'save') parts.push(slider('Savings your family could use', 'amount', 0, 500000, 5000));
    if (k === 'payoff') parts.push(choice([p.mortgage ? ['home', 'The mortgage'] : null, p.debts ? ['debts', 'Other debts'] : null, p.mortgage && p.debts ? ['both', 'Both'] : null].filter(Boolean), 'what'));
    if ((k === 'jobs' || k === 'joblost') && p.coverageSource === 'work') parts.push(choice([['none', 'New job has no coverage'], ['same', 'New job offers the same']], 'newJob'));
    if (k === 'joblost') parts.push(slider('Months without work', 'months', 1, 12, 1, v => `${v} ${plural(v, 'month', 'months')}`));
    if (k === 'illness') parts.push(slider('Months unable to work', 'months', 1, 24, 1, v => `${v} ${plural(v, 'month', 'months')}`), slider('Medical bills', 'bills', 0, 100000, 5000), h('div', { class: 'toggles' }, toggle('Disability coverage through work', 'disability')));
    if (k === 'market') parts.push(slider('Drop in investments', 'drop', 0.1, 0.6, 0.05, v => pct(v)));
    if (k === 'expense') parts.push(slider('Unexpected bill', 'amount', 5000, 150000, 5000));
    if (k === 'inflation') parts.push(slider('Yearly growth above inflation', 'rate', 0, 0.03, 0.005, v => pct(v, 1)));
    if (k === 'carer') parts.push(slider('Support each year', 'annual', 3000, 40000, 1000), slider('For how many years', 'years', 2, 15, 1, v => `${v} years`));
    parts.push(numsEl, breakEl, stressEl);
    if (HELPS[k]) parts.push(h('p', { class: 'helps' }, HELPS[k]));
    if (k === 'illness') parts.push(sourcesEl(['ssaDisability']));
    const isLife = LIFE_EVENTS.some(e => e.k === k);
    parts.push(h('div', { class: 'actions', style: { marginTop: '14px' } },
      isLife ? h('button', { class: 'btn', type: 'button', onclick: () => {
        const { q } = applyEvent(k, state.prm, P());
        S.p = q; state.k = null; drawAll(); refresh(); toast('Kept. Your plan has been updated.');
      } }, 'Keep this in my plan') : null,
      h('button', { class: 'btn ' + (isLife ? 'secondary' : ''), type: 'button', onclick: () => {
        S.compare.push({ id: Date.now().toString(36), k, prm: { ...state.prm } });
        state.k = null; drawAll(); scheduleSave(); toast('Added to your comparison.');
      } }, 'Add to comparison'),
      h('button', { class: 'btn quiet', type: 'button', onclick: () => { state.k = null; drawGrid(); drawBody(); } }, 'Back to today')));
    body.append(h('div', { class: 'ex-body' }, parts));
    drawNums();
  }
  function drawCompare() {
    compareEl.innerHTML = '';
    if (!S.compare.length) return;
    const p = P(), C = chosenCoverage();
    const base = compute(p), baseSt = stressTest(p, S.A);
    const rows = [['Today', base.gap, baseSt, null]];
    for (const sc of S.compare) {
      if (!ALL_EVENTS.some(e => e.k === sc.k)) continue;
      const { q, A2 } = applyEvent(sc.k, sc.prm, p);
      const partnerSide = sc.k === 'partner';
      const g = partnerSide ? compute(partnerProfile(q), A2).gap : compute(q, A2).gap;
      const label = eventLabel(sc.k, p) + (scenarioDetail(sc.k, sc.prm) ? ` (${scenarioDetail(sc.k, sc.prm)})` : '') + (partnerSide ? ', partner’s side' : '');
      rows.push([label, g, partnerSide ? null : stressTest(q, A2), sc.id]);
    }
    compareEl.append(h('div', { class: 'ex-body' },
      h('h3', { style: { fontSize: '1.15rem' } }, 'Compare scenarios'),
      h('div', { class: 'scroll-x' }, h('table', { class: 'costs' },
        h('thead', null, h('tr', null, h('th', null, 'Scenario'), h('th', { style: { textAlign: 'right' } }, 'Still to cover'), h('th', { style: { textAlign: 'right' } }, C ? `With your ${fmtK(C)}` : 'Your coverage'), h('th', null, h('span', { class: 'sr' }, 'Remove')))),
        h('tbody', null, rows.map(([label, g, st, id]) => h('tr', null,
          h('td', null, label), h('td', { class: 'n' }, fmtK(g)),
          h('td', { class: 'n', style: { color: !st ? 'var(--ink-3)' : st.ok ? 'var(--ok)' : 'var(--open)' } }, !st ? '—' : st.ok ? 'Covered' : `Short ${fmtK(st.short)}`),
          h('td', null, id ? h('button', { class: 'ghost', type: 'button', style: { padding: '3px 10px' }, 'aria-label': `Remove ${label}`, onclick: () => { S.compare = S.compare.filter(x => x.id !== id); drawCompare(); scheduleSave(); } }, '×') : null))))))));
  }
  function drawFooter() {
    footer.innerHTML = '';
    const done = S.log.some(e => e.t === 'card' && e.kind === 'handoff');
    if (!done) footer.append(h('button', { class: 'btn', type: 'button', onclick: () => { renderHandoff().then(drawFooter).catch(() => {}); } }, 'Put my plan together'));
  }
  function drawAll() { drawTabs(); drawGrid(); drawBody(); drawCompare(); drawFooter(); }
  // opened from a typed message, e.g. "what if I lose my job for 3 months?"
  card.addEventListener('ll-scenario', e => {
    const { k, amount } = e.detail; const ev = ALL_EVENTS.find(x => x.k === k);
    if (!ev || (ev.when && !ev.when(P()))) return;
    state.tab = SUDDEN_EVENTS.some(x => x.k === k) ? 'sudden' : 'life'; state.k = k; state.prm = scenarioDefaults(k, P());
    if (amount != null && isFinite(amount)) {
      if (k === 'joblost' || k === 'illness') state.prm.months = clamp(Math.round(amount), 1, 24);
      else if (k === 'market') state.prm.drop = clamp(amount > 1 ? amount / 100 : amount, 0.1, 0.6);
      else if (k === 'carer') state.prm.annual = clamp(Math.round(amount), 3000, 40000);
      else if (['home', 'raise', 'save', 'expense'].includes(k) && amount >= 1000) state.prm.amount = Math.round(amount);
    }
    drawAll(); card.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  });
  card._init = () => { drawAll(); live(card, () => { drawGrid(); drawNums(); drawCompare(); drawFooter(); }); };
  return card;
}

/* ---------- handoff summary ---------- */
function summaryText() {
  const p = P(), c = compute(p), C = S.coverage ?? c.tiers.balanced;
  const L = [];
  L.push('LINCOLNLENS PLAN SUMMARY (educational estimate)');
  L.push('');
  L.push(`Household: ${householdText(p)}${p.age ? `, age ${p.age}` : ''}${p.income ? `, income about ${fmtK(p.income)}` : ''}`);
  if (p.priorities && p.priorities.length && !p.priorities.includes('unsure')) L.push(`Matters most: ${listJoin(p.priorities.map(x => PRIO_WORDS[x]))}`);
  L.push('');
  L.push('What the family would need:');
  for (const it of c.items) L.push(`  ${it.label}: ${fmtK(it.amount)}`);
  L.push(`  Total: ${fmtK(c.need)}`);
  if (c.res.length) { L.push('Already in place:'); for (const r of c.res) L.push(`  ${r.label}: ${fmtK(r.amount)}${r.counted ? '' : ' (not counted)'}`); }
  L.push(`Still to cover: ${fmtK(c.gap)}`);
  if (C) {
    L.push(`Coverage explored: ${fmtK(C)}`);
    const R = tradeoffs(p, C); L.push(`Direction: ${R.verdict}`);
    L.push(`Illustrative cost: ${R.tp.T}-year term ${rangeTxt(R.term)}/mo; whole life ${rangeTxt(R.whole)}/mo`);
  }
  if (p.policy && C) {
    const q = premium(p, C, p.policy.type, p.policy.years), rc = riskClass(p.health);
    L.push(`Chosen policy: ${policyName(p.policy)}, ${fmtK(C)}, about ${rangeTxt(q)}/mo (${rc.known ? `estimated class ${rc.cls.name}` : 'average health assumed'})`);
    if (p.policy.type === 'whole') { const cv = cashValueAt(p, C, 20); L.push(`  Illustrative cash value after 20 years: ${fmtK(cv.cv)}${p.cvDeposit ? ` (includes ${fmtK(p.cvDeposit)} deposit)` : ''}`); }
  }
  if (p.savings) L.push(`Savings: ${fmtK(p.savings)} total, ${fmtK(p.savingsUse || 0)} toward the plan${p.cvDeposit ? `, ${fmtK(p.cvDeposit)} into cash value` : ''}`);
  if (hasPartner(p) && p.partner.depends && p.partner.depends !== 'no') {
    const pc = compute(partnerProfile(p)); L.push(`Partner side: needs ${fmtK(pc.need)}, still to cover ${fmtK(pc.gap)}`);
    if (p.partner.cover && pc.tiers.balanced) { const pol = p.policy || { type: 'term', years: 20 }, q = partnerPremium(p, pc.tiers.balanced, pol.type, pol.years), rc = riskClass(p.partner.health); L.push(`  Partner policy: ${policyName(pol)}, ${fmtK(pc.tiers.balanced)}, about ${rangeTxt(q)}/mo (${rc.known ? `estimated class ${rc.cls.name}` : 'average health assumed'})`); }
  }
  if (wealthProfile(p).tier) L.push('Worth discussing: permanent options such as guaranteed or indexed universal life, survivorship coverage, long-term care benefits, and owning coverage through a trust.');
  if (S.compare.length) {
    L.push(''); L.push('Scenarios checked:');
    for (const sc of S.compare) {
      const { q, A2 } = applyEvent(sc.k, sc.prm, p); const partnerSide = sc.k === 'partner';
      const st = partnerSide ? null : stressTest(q, A2);
      const g = partnerSide ? compute(partnerProfile(q), A2).gap : compute(q, A2).gap;
      L.push(`  ${eventLabel(sc.k, p)}${scenarioDetail(sc.k, sc.prm) ? ` (${scenarioDetail(sc.k, sc.prm)})` : ''}: still to cover ${fmtK(g)}${st ? (st.ok ? ', covered' : `, short ${fmtK(st.short)}`) : ''}`);
    }
  }
  const qs = S.qa.filter(x => x.role === 'user').map(x => x.content).slice(-4);
  if (qs.length) { L.push(''); L.push('Questions asked:'); qs.forEach(q => L.push(`  “${q}”`)); }
  L.push('');
  L.push('Assumptions: income support at ' + pct(S.A.replace) + ' of income; ' + pct(S.A.rate, 1) + ' yearly growth above inflation. Not a quote or advice.');
  return L.join('\n');
}
async function downloadText(filename, text) {
  try {
    if (window.claude && typeof window.claude.use === 'function') {
      const dl = await window.claude.use('downloads');
      if (dl) { await dl.save({ filename, data: text }); return 'saved'; }
    }
  } catch (e) { if (e && e.code === 'declined') return 'declined'; }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = h('a', { href: url, download: filename, style: { display: 'none' } });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'saved';
}
async function renderHandoff() {
  meBubble('Put my plan together', null);
  await say('Here’s a summary you can bring to a licensed professional, so the conversation starts where you left off.');
  appendCard('handoff');
  await say('You can keep exploring, change any answer, or ask me anything below.');
}
function buildHandoff() {
  const pre = h('pre');
  const briefEl = h('div', { class: 'brief' });
  const briefBtn = h('button', { class: 'btn secondary', type: 'button', onclick: () => writeBrief(briefEl, briefBtn) }, 'Write an advisor brief');
  const fullText = () => (briefEl.dataset.text ? 'ADVISOR BRIEF\n' + briefEl.dataset.text + '\n\n' : '') + pre.textContent;
  const copyBtn = h('button', { class: 'btn', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(fullText()); copyBtn.textContent = 'Copied'; } catch { const r = document.createRange(); r.selectNodeContents(pre); const s = getSelection(); s.removeAllRanges(); s.addRange(r); copyBtn.textContent = 'Selected, press Ctrl+C'; } setTimeout(() => copyBtn.textContent = 'Copy summary', 2200); } }, 'Copy summary');
  const dlBtn = h('button', { class: 'btn secondary', type: 'button', onclick: async () => { const r = await downloadText('lincolnlens-plan.txt', fullText()); if (r === 'saved') toast('Plan summary ready.'); } }, 'Download');
  const card = h('div', { class: 'card handoff' }, h('h3', null, 'Your plan, ready to share'),
    h('p', { class: 'lede' }, 'A licensed professional can turn this into real quotes and check the details that matter for your situation.'),
    briefEl, pre, h('div', { class: 'actions' }, briefBtn, copyBtn, dlBtn, h('button', { class: 'btn quiet', type: 'button', onclick: () => { document.getElementById('ask').focus(); } }, 'Ask a question first')));
  card._init = () => live(card, () => { pre.textContent = summaryText(); });
  return card;
}

function registerCards() {
  Object.assign(CARDS, { reveal: buildReveal, sandbox: buildSandbox, timeline: buildTimeline, tvw: buildTvw, family: buildFamily, explore: buildExplore, handoff: buildHandoff, risk: buildRisk, policy: buildPolicy, wealth: buildWealth, partnerPolicy: buildPartnerPolicy, insights: buildInsights });
}


export { ALL_EVENTS, GOAL_WORDS, HELPS, ICON, INCOME_BANDS, LEADS, LIFE_EVENTS, NODE, NODES, PRIO_WORDS, SUDDEN_EVENTS, appendAssumeChips, applyEvent, registerCards, assumeWords, buildExplore, buildFamily, buildHandoff, buildPartnerPolicy, buildPolicy, buildReveal, buildRisk, buildSandbox, buildTimeline, buildTvw, buildWealth, chosenCoverage, classBlock, clone, downloadText, drawSavings, eventLabel, goalPhrase, healthNodes, incomeMath, kidsHousehold, listJoin, monthlySpend, personalizeHealth, policyAck, premiumAtClass, reactionText, recommendYears, recommendedPolicy, renderAssumptions, renderExplore, renderFamily, renderHandoff, renderPartnerPolicy, renderPolicy, renderReveal, renderRisk, renderSandbox, renderTimeline, renderTvw, renderWealth, run, runLoop, scenarioDefaults, scenarioDetail, sideStatus, sourcesEl, stressTest, summaryText, timelineEvents, tradeoffs, yearsLabel };
