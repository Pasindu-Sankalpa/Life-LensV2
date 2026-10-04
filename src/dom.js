/* ======================================================================
   Utilities
   ====================================================================== */
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return el;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => '$' + Math.round(n).toLocaleString('en-US');
function fmtK(n) {
  n = Math.round(n); const a = Math.abs(n);
  if (a >= 1e6) { const v = n / 1e6; return '$' + (Math.round(v * 100) / 100).toString() + 'M'; }
  if (a >= 1000) return '$' + Math.round(n / 1000) + 'K';
  return '$' + n;
}
const pct = (x, d = 0) => (x * 100).toFixed(d) + '%';
const sum = (arr, f = x => x) => arr.reduce((s, x) => s + f(x), 0);
const roundUp = (n, step) => Math.ceil(n / step) * step;
const roundTo = (n, step) => Math.round(n / step) * step;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const wait = ms => new Promise(r => setTimeout(r, ms));
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function annuityDue(n, r) { if (n <= 0) return 0; if (r === 0) return n; return (1 - Math.pow(1 + r, -n)) / r * (1 + r); }
const plural = (n, one, many) => n === 1 ? one : many;


export { $, annuityDue, clamp, esc, fmt, fmtK, h, pct, plural, reduceMotion, roundTo, roundUp, sum, wait };
