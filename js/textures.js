import * as THREE from 'three';
import { TAU, clamp, lerp, rng } from './helpers.js';


const TEX = {};

function canvas2d(size, h) {
  const c = document.createElement('canvas');
  c.width = size; c.height = h || size;
  return [c, c.getContext('2d')];
}

/* value noise on a lattice, smoothed and layered into fractal noise */
function noiseField(size, octaves, seed, persistence, base) {
  const out = new Float32Array(size * size);
  const rand = rng(seed);
  let amp = 1, total = 0;
  const pers = persistence === undefined ? 0.5 : persistence;
 
  const b = base || 0;

  for (let o = 0; o < octaves; o++) {
    const cells = 2 << (o + b);           // lattice resolution for this octave
    const lat = new Float32Array((cells + 1) * (cells + 1));
    for (let i = 0; i < lat.length; i++) lat[i] = rand();

    for (let i = 0; i <= cells; i++) {
      lat[i * (cells + 1) + cells] = lat[i * (cells + 1)];
      lat[cells * (cells + 1) + i] = lat[i];
    }

    const scale = size / cells;
    for (let y = 0; y < size; y++) {
      const fy = y / scale, y0 = Math.floor(fy), ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < size; x++) {
        const fx = x / scale, x0 = Math.floor(fx), tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const i00 = y0 * (cells + 1) + x0;
        const a = lerp(lat[i00], lat[i00 + 1], sx);
        const b = lerp(lat[i00 + cells + 1], lat[i00 + cells + 2], sx);
        out[y * size + x] += lerp(a, b, sy) * amp;
      }
    }
    total += amp;
    amp *= pers;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/* wrap a canvas as a colour texture */
function makeTex(c, rx, ry, srgb) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx || 1, ry || rx || 1);
  t.anisotropy = 8;
  if (srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/* --- asphalt: dark bitumen with light aggregate stones and worn patches --- */
function texAsphalt() {
  const S = 512, [c, g] = canvas2d(S);
  const grain = noiseField(S, 5, 21, 0.55, 3);
  const patch = noiseField(S, 3, 77, 0.6, 2);
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const n = grain[i], p = patch[i];
    let v = 44 + n * 40 + (p - 0.5) * 12;
    if (n > 0.74) v += (n - 0.74) * 300;       // exposed aggregate stones
    const j = i * 4;
    img.data[j] = clamp(v * 1.02, 0, 255);
    img.data[j + 1] = clamp(v, 0, 255);
    img.data[j + 2] = clamp(v * 0.99, 0, 255);
    img.data[j + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  /* hairline cracks */
  const rand = rng(9);
  g.strokeStyle = 'rgba(18,18,20,.55)';
  for (let k = 0; k < 26; k++) {
    g.lineWidth = 0.6 + rand() * 1.1;
    g.beginPath();
    let x = rand() * S, y = rand() * S;
    g.moveTo(x, y);
    for (let s = 0; s < 9; s++) { x += (rand() - 0.5) * 60; y += (rand() - 0.5) * 60; g.lineTo(x, y); }
    g.stroke();
  }
  return makeTex(c, 1, 1);
}

/* --- gravel shoulder --- */
function texGravel() {
  const S = 256, [c, g] = canvas2d(S);
  const n = noiseField(S, 5, 133, 0.55, 2);
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 74 + n[i] * 92, j = i * 4;
    img.data[j] = clamp(v * 1.08, 0, 255);
    img.data[j + 1] = clamp(v * 1.0, 0, 255);
    img.data[j + 2] = clamp(v * 0.86, 0, 255);
    img.data[j + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const rand = rng(4);
  for (let k = 0; k < 900; k++) {
    const x = rand() * S, y = rand() * S, r = 0.7 + rand() * 1.9;
    g.fillStyle = `rgba(${150 + rand() * 60 | 0},${142 + rand() * 55 | 0},${122 + rand() * 50 | 0},.7)`;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  return makeTex(c, 1, 1);
}

/* --- grass --- */
function texGrass() {
  const S = 256, [c, g] = canvas2d(S);
  const n = noiseField(S, 5, 55, 0.55, 2);
  const m = noiseField(S, 2, 91, 0.5, 1);
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = n[i], t = m[i], j = i * 4;
    img.data[j] = clamp(64 + v * 58 + t * 30, 0, 255);
    img.data[j + 1] = clamp(82 + v * 62 + t * 30, 0, 255);
    img.data[j + 2] = clamp(46 + v * 34, 0, 255);
    img.data[j + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const rand = rng(12);
  for (let k = 0; k < 1400; k++) {                 // individual blades
    const x = rand() * S, y = rand() * S, len = 3 + rand() * 7;
    g.strokeStyle = `rgba(${72 + rand() * 42 | 0},${104 + rand() * 52 | 0},${50 + rand() * 34 | 0},.45)`;
    g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rand() - 0.5) * 3, y - len); g.stroke();
  }
  /* wildflowers: tiny, but they stop a large field of one green reading as felt */
  const petals = ['#f2e9c4', '#e8d24a', '#d8e0ea', '#c8a2cc', '#e6a2a2'];
  for (let k = 0; k < 190; k++) {
    g.fillStyle = petals[(rand() * petals.length) | 0];
    g.globalAlpha = 0.55 + rand() * 0.4;
    const x = rand() * S, y = rand() * S, r = 0.9 + rand() * 1.5;
    g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
  }
  g.globalAlpha = 1;
  return makeTex(c, 1, 1);
}

/* --- soil at the road edge --- */
function texDirt() {
  const S = 256, [c, g] = canvas2d(S);
  const n = noiseField(S, 5, 200, 0.55, 2);
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = n[i], j = i * 4;
    img.data[j] = clamp(84 + v * 62, 0, 255);
    img.data[j + 1] = clamp(66 + v * 50, 0, 255);
    img.data[j + 2] = clamp(48 + v * 34, 0, 255);
    img.data[j + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return makeTex(c, 1, 1);
}

/* --- car paint: clear base with a fine metallic flake --- */
function texPaint(hex) {
  const S = 256, [c, g] = canvas2d(S);
  g.fillStyle = hex; g.fillRect(0, 0, S, S);
  const rand = rng(31);
  for (let k = 0; k < 5200; k++) {                 // metallic flake
    const x = rand() * S, y = rand() * S;
    g.fillStyle = rand() > 0.5 ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.10)';
    g.fillRect(x, y, 1, 1);
  }
  return makeTex(c, 1, 1);
}

/* --- tyre rubber with a tread block pattern --- */
function texTyre() {
  const S = 256, [c, g] = canvas2d(S);
  g.fillStyle = '#15161a'; g.fillRect(0, 0, S, S);
  const n = noiseField(S, 4, 66, 0.5);
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const v = n[i] * 22, j = i * 4;
    img.data[j] += v; img.data[j + 1] += v; img.data[j + 2] += v * 1.1;
  }
  g.putImageData(img, 0, 0);
  /* chunky all terrain lugs: big shoulder blocks and a broken centre rib */
  g.fillStyle = '#0a0b0d';
  g.fillRect(0, S * 0.26, S, 7); g.fillRect(0, S * 0.68, S, 7);
  g.fillStyle = '#2c2f36';
  for (let i = 0; i < 10; i++) {
    const x = i * (S / 10);
    g.save(); g.translate(x, 0); g.transform(1, 0, -0.22, 1, 0, 0);
    g.fillRect(3, -S * 0.02, S / 10 - 8, S * 0.27);      // shoulder lugs
    g.fillRect(3, S * 0.75, S / 10 - 8, S * 0.27);
    g.restore();
  }
  g.fillStyle = '#33363d';
  for (let i = 0; i < 7; i++) {                          // staggered centre blocks
    const x = i * (S / 7);
    g.fillRect(x + 4, S * 0.33, S / 7 - 12, S * 0.13);
    g.fillRect(x + S / 14, S * 0.52, S / 7 - 12, S * 0.13);
  }
  /* sidewall lettering band */
  g.fillStyle = '#3a3d45';
  g.font = 'bold 11px ui-sans-serif, sans-serif';
  for (let i = 0; i < 8; i++) g.fillText('225/40 R18', i * (S / 8) + 3, S * 0.53);
  return makeTex(c, 1, 1);
}

/* --- brushed  for wheel rims, poles and rails --- The streaks run down the canvas, which... */
function texMetal(base, streaks) {
  const S = 256, [c, g] = canvas2d(S);
  g.fillStyle = base; g.fillRect(0, 0, S, S);
  const rand = rng(77);
  for (let k = 0; k < streaks; k++) {
    const x = rand() * S;
    g.strokeStyle = `rgba(255,255,255,${0.02 + rand() * 0.07})`;
    g.lineWidth = 0.6 + rand() * 1.6;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + (rand() - 0.5) * 5, S); g.stroke();
  }
  const n = noiseField(S, 4, 303, 0.5);
  const img = g.getImageData(0, 0, S, S);
  for (let i = 0; i < S * S; i++) {
    const v = (n[i] - 0.5) * 16, j = i * 4;
    img.data[j] += v; img.data[j + 1] += v; img.data[j + 2] += v;
  }
  g.putImageData(img, 0, 0);
  return makeTex(c, 1, 1);
}

/* --- tinted glass, slightly darker toward the top --- */
function texGlass() {
  const S = 128, [c, g] = canvas2d(S);
  const grd = g.createLinearGradient(0, 0, 0, S);
  grd.addColorStop(0, '#070a0e'); grd.addColorStop(0.55, '#0d131b'); grd.addColorStop(1, '#141c27');
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  return makeTex(c, 1, 1);
}

/* --- bark --- */
function texBark() {
  const S = 256, [c, g] = canvas2d(S);
  const n = noiseField(S, 5, 404, 0.6);
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const x = i % S;
    const ridge = Math.abs(Math.sin(x * 0.19 + n[i] * 7.5));
    const v = 42 + ridge * 40 + n[i] * 34;
    const j = i * 4;
    img.data[j] = clamp(v * 1.16, 0, 255);
    img.data[j + 1] = clamp(v * 0.94, 0, 255);
    img.data[j + 2] = clamp(v * 0.70, 0, 255);
    img.data[j + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return makeTex(c, 2, 2);
}

/* --- foliage --- */
function texLeaf() {
  const S = 256, [c, g] = canvas2d(S);
  g.fillStyle = '#25491d'; g.fillRect(0, 0, S, S);
  const rand = rng(808);
  for (let k = 0; k < 2600; k++) {
    const x = rand() * S, y = rand() * S, r = 2 + rand() * 6;
    const t = rand();
    g.fillStyle = `rgba(${34 + t * 62 | 0},${76 + t * 88 | 0},${24 + t * 40 | 0},.72)`;
    g.beginPath(); g.ellipse(x, y, r, r * 0.6, rand() * TAU, 0, TAU); g.fill();
  }
  return makeTex(c, 1, 1);
}

/* --- rock --- */
function texRock() {
  const S = 256, [c, g] = canvas2d(S);
  const n = noiseField(S, 5, 606, 0.55);
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 76 + n[i] * 74, j = i * 4;
    img.data[j] = clamp(v * 1.0, 0, 255);
    img.data[j + 1] = clamp(v * 0.98, 0, 255);
    img.data[j + 2] = clamp(v * 0.93, 0, 255);
    img.data[j + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return makeTex(c, 1, 1);
}

/* --- a radial falloff used by every additive glow sprite --- */
function texGlow() {
  const S = 128, [c, g] = canvas2d(S);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.22, 'rgba(255,238,205,.62)');
  grd.addColorStop(0.55, 'rgba(255,220,170,.16)');
  grd.addColorStop(1, 'rgba(255,210,150,0)');
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  return makeTex(c, 1, 1);
}

/* --- soft blob used for the car's contact shadow --- */
function texBlob() {
  const S = 128, [c, g] = canvas2d(S);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(0,0,0,.62)');
  grd.addColorStop(0.5, 'rgba(0,0,0,.28)');
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, S, S);
  return makeTex(c, 1, 1);
}

/* --- number plate, stamped with whatever the student typed on the title card --- */
function texPlate(text) {
  const [c, g] = canvas2d(512, 128);
  g.fillStyle = '#e8e6df'; g.fillRect(0, 0, 512, 128);
  g.fillStyle = '#1d3f8a'; g.fillRect(0, 0, 52, 128);
  g.fillStyle = '#f0c419'; g.font = 'bold 20px ui-sans-serif, sans-serif';
  g.textAlign = 'center'; g.fillText('CG', 26, 44); g.fillText('4204', 26, 92);
  g.fillStyle = '#14161a';
  g.font = 'bold 62px ui-monospace, monospace';
  g.fillText(String(text).slice(0, 12).toUpperCase(), 290, 90);
  g.strokeStyle = '#2a2c31'; g.lineWidth = 6; g.strokeRect(3, 3, 506, 122);
  return makeTex(c, 1, 1);
}

/* --- radiator grille --- */
function texGrille() {
  const S = 128, [c, g] = canvas2d(S);
  g.fillStyle = '#0c0d10'; g.fillRect(0, 0, S, S);
  g.strokeStyle = '#2b2e36'; g.lineWidth = 3;
  for (let y = 6; y < S; y += 12) { g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke(); }
  g.strokeStyle = '#191b20'; g.lineWidth = 2;
  for (let x = 6; x < S; x += 10) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, S); g.stroke(); }
  return makeTex(c, 1, 1);
}

/* --- road signs --- */
function texSignLimit(n) {
  const S = 256, [c, g] = canvas2d(S);
  g.fillStyle = '#f2efe8'; g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, TAU); g.fill();
  g.strokeStyle = '#c0392b'; g.lineWidth = 26;
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 20, 0, TAU); g.stroke();
  g.fillStyle = '#16181c'; g.font = 'bold 108px ui-sans-serif, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), S / 2, S / 2 + 6);
  return makeTex(c, 1, 1);
}
function texSignBend() {
  const S = 256, [c, g] = canvas2d(S);
  g.fillStyle = '#f2c200';
  g.save(); g.translate(S / 2, S / 2); g.rotate(Math.PI / 4);
  g.fillRect(-78, -78, 156, 156);
  g.strokeStyle = '#16181c'; g.lineWidth = 9; g.strokeRect(-78, -78, 156, 156);
  g.restore();
  g.strokeStyle = '#16181c'; g.lineWidth = 15; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(96, 168); g.quadraticCurveTo(96, 104, 150, 104);
  g.quadraticCurveTo(160, 104, 160, 84); g.stroke();
  return makeTex(c, 1, 1);
}

/* --- concrete for the lamp bases and barriers --- */
function texConcrete() {
  const S = 256, [c, g] = canvas2d(S);
  const n = noiseField(S, 5, 909, 0.5);
  const img = g.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 118 + n[i] * 48, j = i * 4;
    img.data[j] = clamp(v, 0, 255);
    img.data[j + 1] = clamp(v * 0.99, 0, 255);
    img.data[j + 2] = clamp(v * 0.95, 0, 255);
    img.data[j + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return makeTex(c, 1, 1);
}

/* --- a single grass tuft, alpha cut out --- */
function texTuft() {
  const S = 128, [c, g] = canvas2d(S);
  g.clearRect(0, 0, S, S);
  const rand = rng(1212);
  for (let k = 0; k < 26; k++) {
    const x = 10 + rand() * (S - 20);
    const h = 40 + rand() * 74;
    const lean = (rand() - 0.5) * 26;
    const t = rand();
    g.strokeStyle = `rgba(${40 + t * 42 | 0},${74 + t * 58 | 0},${26 + t * 30 | 0},1)`;
    g.lineWidth = 2 + rand() * 2.4;
    g.lineCap = 'round';
    g.beginPath(); g.moveTo(x, S);
    g.quadraticCurveTo(x + lean * 0.4, S - h * 0.55, x + lean, S - h);
    g.stroke();
  }
  const t = makeTex(c, 1, 1);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export { TEX, canvas2d, makeTex, texAsphalt, texBark, texBlob, texConcrete, texDirt, texGlass, texGlow, texGrass, texGravel, texGrille, texLeaf, texMetal, texPaint, texPlate, texRock, texSignBend, texSignLimit, texTuft, texTyre };









/*

├── canvas2d()
│     └── Canvas
│
├── noiseField()
│     └── natural/random variation
│
├── makeTex()
│     └── Canvas → Three.js Texture
│
├── texAsphalt()
│     └── Road
├── texGravel()
│     └── Shoulder
├── texGrass()
│     └── Field
├── texDirt()
│     └── Soil
├── texPaint()
│     └── Car
├── texTyre()
│     └── Tire
├── texMetal()
│     └── Rim/Rail/Pole
├── texGlass()
│     └── Window
├── texBark()
│     └── Tree trunk
├── texLeaf()
│     └── Tree leaves
├── texRock()
│     └── Rock
├── texGlow()
│     └── Light
├── texBlob()
│     └── Shadow
├── texPlate()
│     └── Number plate
├── texGrille()
│     └── Car grille
├── texSignLimit()
│     └── Speed sign
├── texSignBend()
│     └── Bend sign
├── texConcrete()
│     └── Barrier/lamp base
└── texTuft()
      └── Grass sprite 
      
      */