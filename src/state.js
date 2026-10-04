/* ======================================================================
   State
   ====================================================================== */
const emptyHealth = () => ({ nicotine: null, hw: null, bp: null, cond: null, fam: null, life: null });
function freshProfile() {
  return {
    age: null, household: null, kids: [], income: null, priorities: [],
    housing: null, mortgage: null, mortgagePlan: null,
    debts: null, incomeYearsChoice: null, incomeYears: null,
    kidGoals: null, educationPerKid: null, childcareAnnual: null,
    cushion: null, savings: null, savingsUse: null, coverage: null, coverageSource: null,
    lifelong: null, policy: null, cvDeposit: null, assets: null, businessOwner: null,
    health: emptyHealth(),
    partner: { depends: null, income: null, contrib: null, childcareNeeded: null, childcareAnnual: null, homePlan: null, coverage: null, age: null, cover: null, health: emptyHealth() },
    extras: []
  };
}
const S = {
  p: freshProfile(),
  A: { replace: 0.75, rate: 0.03, countWork: true },
  done: new Set(),
  stage: 'you', reached: new Set(['you']),
  quick: false, assumed: [],
  coverage: null, tierPick: null,
  ai: { sample: null, images: false, log: [], ready: false },
  qa: [], live: new Set(), active: null, started: false, runId: 0,
  log: [], planId: null, created: null, compare: [], restoring: false, running: false, pending: null
};
/* public, reputable pages linked from explanations (check these before a demo) */
const SOURCES = {
  naic: { label: 'NAIC consumer guide to life insurance', url: 'https://content.naic.org/consumer/life-insurance.htm' },
  iii: { label: 'Insurance Information Institute: life insurance basics', url: 'https://www.iii.org/insurance-basics/life-insurance' },
  ssaSurvivors: { label: 'Social Security: survivors benefits', url: 'https://www.ssa.gov/benefits/survivors/' },
  ssaDisability: { label: 'Social Security: disability benefits', url: 'https://www.ssa.gov/benefits/disability/' }
};
const P = () => S.p;


export { P, S, SOURCES, emptyHealth, freshProfile };
