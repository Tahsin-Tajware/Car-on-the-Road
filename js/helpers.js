const UI = id => document.getElementById(id);

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const TAU = Math.PI * 2;

/* deterministic pseudo random so the world looks identical on every run */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

function step(pct, label) {
  UI('fill').style.width = pct + '%';
  UI('loadTxt').textContent = label;
}

export { TAU, UI, clamp, lerp, nextFrame, rng, smoothstep, step };
