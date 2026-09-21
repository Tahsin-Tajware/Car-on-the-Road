import * as THREE from 'three';
import { TAU, clamp, lerp, rng, smoothstep } from './helpers.js';
import { TEX } from './textures.js';
import { attachRoadShader, attachTerrainShader, makeGrassMaterial, makeSkyMaterial } from './shaders.js';
import { scene } from './renderer.js';



const ROAD_HALF = 4.6;            // half the width of the sealed surface, metres
const SHOULDER = 2.8;
const DASH_PITCH_TARGET = 9.0;    // metres from the start of one dash to the next

function loopRadius(a) {
  return 116 + 9.5 * Math.sin(a * 3) + 6 * Math.cos(a * 2) + 3.5 * Math.sin(a * 5 + 1.1);
}
function loopHeight(a) {
  return 2.7 * Math.sin(a * 2 + 0.4) + 1.5 * Math.cos(a * 3 - 0.8);
}



function pathPoint(a, out) {
  const r = loopRadius(a);
  return (out || new THREE.Vector3()).set(Math.cos(a) * r, loopHeight(a), Math.sin(a) * r);
}
const _pA = new THREE.Vector3(), _pB = new THREE.Vector3();
function pathTangent(a, out) {
  const e = 0.0016;
  pathPoint(a + e, _pA); pathPoint(a - e, _pB);
  return (out || new THREE.Vector3()).subVectors(_pA, _pB).normalize();
}
/* how sharply the road is turning here, used to steer and to lean the car */
function pathCurvature(a) {
  const e = 0.02;
  const t1 = pathTangent(a - e, new THREE.Vector3());
  const t2 = pathTangent(a + e, new THREE.Vector3());
  const cross = t1.x * t2.z - t1.z * t2.x;
  return cross / (2 * e);
}

/* arc length table so the car can travel at a steady speed even though the curve is not... */
const ARC_N = 3000;
const arcTable = new Float32Array(ARC_N + 1);
let LOOP_LENGTH = 0;

function buildArcTable() {
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  pathPoint(0, p);
  arcTable[0] = 0;
  for (let i = 1; i <= ARC_N; i++) {
    pathPoint(i / ARC_N * TAU, q);
    arcTable[i] = arcTable[i - 1] + p.distanceTo(q);
    p.copy(q);
  }
  LOOP_LENGTH = arcTable[ARC_N];
}
function arcAt(a) {
  const t = ((a % TAU) + TAU) % TAU / TAU * ARC_N;
  const i = Math.floor(t);
  return lerp(arcTable[i], arcTable[Math.min(i + 1, ARC_N)], t - i);
}
function angleAtArc(s) {
  s = ((s % LOOP_LENGTH) + LOOP_LENGTH) % LOOP_LENGTH;
  let lo = 0, hi = ARC_N;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; (arcTable[m] <= s) ? lo = m : hi = m; }
  const seg = arcTable[hi] - arcTable[lo] || 1;
  return (lo + (s - arcTable[lo]) / seg) / ARC_N * TAU;
}

/* ---------------------------------------------------------------------------
   One builder for every swept surface. `inner` and `outer` are distances left
   and right of the centre line, `rise` lifts the far edge to make a vertical
   panel such as the guard rail.
   --------------------------------------------------------------------------- */
function makeStrip(o) {
  const from = o.from === undefined ? 0 : o.from;
  const to = o.to === undefined ? TAU : o.to;
  const closed = (to - from) >= TAU - 1e-6;
  const samples = o.samples || 780;
  const cols = o.cols || 2;
  const crown = o.crown || 0;
  const vPitch = o.vPitch || 1;
  const rise = o.rise || 0;

  const pos = [], uv = [], idx = [];
  const p = new THREE.Vector3(), tan = new THREE.Vector3(), side = new THREE.Vector3();

  for (let i = 0; i <= samples; i++) {
    const t01 = i / samples;
    const a = from + (to - from) * t01;
    pathPoint(a, p); pathTangent(a, tan);
    side.set(-tan.z, 0, tan.x).normalize();
    /* arcAt wraps back to zero after exactly one turn, which would fold the last row of dashes... */
    const s = closed ? (t01 >= 1 ? LOOP_LENGTH : arcAt(a)) : (arcAt(a) - arcAt(from));

    for (let j = 0; j < cols; j++) {
      const u = j / (cols - 1);
      const off = lerp(o.inner, o.outer, u);
      const cy = crown * (1 - Math.pow((u - 0.5) * 2, 2));
      pos.push(p.x + side.x * off, p.y + (o.y || 0) + cy + rise * u, p.z + side.z * off);
      uv.push(u, s / vPitch);
    }
  }
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a0 = i * cols + j, b0 = (i + 1) * cols + j;
      idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();

  /* Whether a triangle ends up facing the sky depends on which way `inner` and
     `outer` run, so measure the result and reverse the winding if the surface
     came out upside down. Without this the road is culled and disappears. */
  const n = g.attributes.normal;
  let meanY = 0;
  for (let i = 0; i < n.count; i++) meanY += n.getY(i);
  if (meanY < 0) {
    for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  return g;
}

let roadMesh, roadMat;

function buildRoad() {
  /* snap the dash pitch so the broken line joins up cleanly where the loop closes instead of... */
  const dashes = Math.round(LOOP_LENGTH / DASH_PITCH_TARGET);
  const vPitch = LOOP_LENGTH / dashes;

  /* --- sealed surface --- The surface coordinates are left at one unit across the width and one... */
  roadMat = attachRoadShader(new THREE.MeshStandardMaterial({
    map: TEX.asphalt, roughness: 0.94, metalness: 0.02
  }));

  roadMesh = new THREE.Mesh(makeStrip({
    inner: -ROAD_HALF, outer: ROAD_HALF, cols: 7, crown: 0.05,
    vPitch: vPitch, samples: 1100, y: 0.02
  }), roadMat);
  roadMesh.receiveShadow = true;
  roadMesh.name = 'Road surface';
  scene.add(roadMesh);

  /* --- gravel shoulders, tiled about every three metres --- */
  const gravel = TEX.gravel.clone();
  gravel.wrapS = gravel.wrapT = THREE.RepeatWrapping;
  gravel.colorSpace = THREE.SRGBColorSpace;
  gravel.needsUpdate = true;
  const shoulderMat = new THREE.MeshStandardMaterial({ map: gravel, roughness: 1.0, metalness: 0 });

  for (const s of [-1, 1]) {
    const m = new THREE.Mesh(makeStrip({
      inner: s * ROAD_HALF, outer: s * (ROAD_HALF + SHOULDER),
      cols: 3, y: -0.02, vPitch: SHOULDER, samples: 700
    }), shoulderMat);
    m.receiveShadow = true;
    m.name = 'Gravel shoulder';
    scene.add(m);
  }
}

// S7  TERRAIN, SCENERY AND OBSTACLES

/* Obstacle field */
const OBSTACLES = [];
const OB_CELL = 14;
const obGrid = new Map();

function addObstacle(x, z, r, name) { OBSTACLES.push({ x: x, z: z, r: r, name: name }); }

function buildObstacleGrid() {
  obGrid.clear();
  for (const o of OBSTACLES) {
    const x0 = Math.floor((o.x - o.r) / OB_CELL), x1 = Math.floor((o.x + o.r) / OB_CELL);
    const z0 = Math.floor((o.z - o.r) / OB_CELL), z1 = Math.floor((o.z + o.r) / OB_CELL);
    for (let i = x0; i <= x1; i++) {
      for (let j = z0; j <= z1; j++) {
        const k = i + ',' + j;
        let cell = obGrid.get(k);
        if (!cell) { cell = []; obGrid.set(k, cell); }
        cell.push(o);
      }
    }
  }
}

function nearbyObstacles(x, z, out) {
  out.length = 0;
  const i0 = Math.floor(x / OB_CELL), j0 = Math.floor(z / OB_CELL);
  for (let i = i0 - 1; i <= i0 + 1; i++) {
    for (let j = j0 - 1; j <= j0 + 1; j++) {
      const cell = obGrid.get(i + ',' + j);
      if (!cell) continue;
      for (const o of cell) if (out.indexOf(o) < 0) out.push(o);
    }
  }
  return out;
}

let terrain;

/* Ridged relief */
function groundNoise(x, z) {
  const ridgeA = Math.abs(Math.sin(x * 0.0068) * Math.cos(z * 0.0059));
  const ridgeB = Math.abs(Math.sin(x * 0.0039 - z * 0.0051 + 1.2));
  return ridgeA * 46 + ridgeB * 30
    + Math.sin(x * 0.020 + 1.7) * Math.cos(z * 0.018 - 0.6) * 6.5
    + Math.sin((x + z) * 0.0059) * 8.0 - 34;
}

/* The one place the shape of the ground is defined */
function terrainY(x, z) {
  const r = Math.hypot(x, z);
  let a = Math.atan2(z, x); if (a < 0) a += TAU;
  const roadY = loopHeight(a);
  const sd = r - loopRadius(a);              // negative inside the loop
  const d = Math.abs(sd);

  /* the road is a shelf cut into the slope: */
  const cut = clamp(-sd, -170, 170) * 0.20;
  const away = smoothstep(9, 74, d);

  let y = lerp(roadY - 0.30, roadY + groundNoise(x, z) + cut, away);
  y += smoothstep(190, 400, r) * (88 + 46 * Math.sin(a * 3.1) + 30 * Math.cos(a * 5.3));
  return y;
}

function buildTerrain() {
  const SIZE = 900, SEG = 220;
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const blend = new Float32Array(pos.count);
  const c = new THREE.Color();
  const cGrass = new THREE.Color(0x7e8f5b);
  const cDry = new THREE.Color(0x9c9468);
  const cRock = new THREE.Color(0x6f6a63);
  const cSnow = new THREE.Color(0xeef2f6);

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const r = Math.hypot(x, z);
    let a = Math.atan2(z, x); if (a < 0) a += TAU;

    const roadY = loopHeight(a);
    const d = Math.abs(r - loopRadius(a));                // distance out from the road
    const y = terrainY(x, z);
    pos.setY(i, y);

    /* soil creeps in over the last few metres before the gravel */
    blend[i] = smoothstep(11.5, 7.6, d);

    /* height above the road decides what the ground is made of */
    const alt = y - roadY;
    c.copy(cGrass).lerp(cDry, smoothstep(-4, 22, alt) * 0.7)
      .lerp(cRock, smoothstep(26, 62, alt))
      .lerp(cSnow, smoothstep(78, 118, alt));
    const shade = 0.86 + 0.14 * Math.sin(x * 0.05) * Math.cos(z * 0.045);
    colors[i * 3] = c.r * shade;
    colors[i * 3 + 1] = c.g * shade;
    colors[i * 3 + 2] = c.b * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aBlend', new THREE.BufferAttribute(blend, 1));
  geo.computeVertexNormals();

  const grass = TEX.grass.clone();
  grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
  grass.repeat.set(150, 150);
  grass.colorSpace = THREE.SRGBColorSpace;
  grass.needsUpdate = true;

  const mat = attachTerrainShader(new THREE.MeshStandardMaterial({
    map: grass, vertexColors: true, roughness: 0.98, metalness: 0
  }), TEX.dirt);

  terrain = new THREE.Mesh(geo, mat);
  terrain.receiveShadow = true;
  terrain.name = 'Terrain';
  scene.add(terrain);
}

/* props sit on exactly the same surface the mesh was built from */
function groundHeight(x, z) { return terrainY(x, z); }

/* Sky dome... */
let skyMat, skyMesh;
function buildSky() {
  skyMat = makeSkyMaterial();
  skyMesh = new THREE.Mesh(new THREE.SphereGeometry(1100, 40, 24), skyMat);
  skyMesh.name = 'Sky';
  scene.add(skyMesh);
}

/* Instanced grass... */
let grassMat, grassMesh;
function buildGrassTufts() {
  /* two quads crossed at right angles read as a clump from every direction */
  const quad = new THREE.PlaneGeometry(1.15, 1.0);
  quad.translate(0, 0.5, 0);
  const quadB = quad.clone(); quadB.rotateY(Math.PI / 2);
  const geo = mergeGeometries([quad, quadB]);

  grassMat = makeGrassMaterial(TEX.tuft);
  const N = 6000;
  grassMesh = new THREE.InstancedMesh(geo, grassMat, N);
  grassMesh.name = 'Verge grass';
  grassMesh.frustumCulled = false;

  const dummy = new THREE.Object3D();
  const rand = rng(4242);
  for (let i = 0; i < N; i++) {
    const a = rand() * TAU;
    const s = rand() > 0.5 ? 1 : -1;
    const off = ROAD_HALF + SHOULDER + 0.1 + Math.pow(rand(), 1.7) * 22;
    const p = pathPoint(a), t = pathTangent(a);
    const sx = -t.z, sz = t.x;
    const x = p.x + sx * off * s, z = p.z + sz * off * s;
    dummy.position.set(x, groundHeight(x, z) - 0.05, z);
    dummy.rotation.y = rand() * TAU;
    const sc = 0.34 + rand() * 0.48;
    dummy.scale.set(sc, sc * (0.75 + rand() * 0.7), sc);
    dummy.updateMatrix();
    grassMesh.setMatrixAt(i, dummy.matrix);
  }
  scene.add(grassMesh);
}

/* small local merge helper so no add-on module is needed */
function mergeGeometries(list) {
  let vCount = 0, iCount = 0;
  for (const g of list) { vCount += g.attributes.position.count; iCount += g.index ? g.index.count : 0; }
  const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3), uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv, ix = g.index;
    pos.set(p.array, vo * 3);
    if (n) nor.set(n.array, vo * 3);
    if (u) uv.set(u.array, vo * 2);
    for (let k = 0; k < ix.count; k++) idx[io + k] = ix.array[k] + vo;
    vo += p.count; io += ix.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/* Trees and rocks,... */
function buildScenery() {
  const rand = rng(777);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();

  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.31, 6.4, 8, 1);
  trunkGeo.translate(0, 3.2, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ map: TEX.bark, roughness: 0.95, metalness: 0 });

  /* two stacked cones read as a conifer, which is what belongs on a pass */
  const leafGeo = mergeGeometries([
    (() => { const g = new THREE.ConeGeometry(2.5, 5.2, 8); g.translate(0, 0.4, 0); return g; })(),
    (() => { const g = new THREE.ConeGeometry(1.75, 4.2, 8); g.translate(0, 3.0, 0); return g; })()
  ]);
  const leafMat = new THREE.MeshStandardMaterial({ map: TEX.leaf, roughness: 0.92, metalness: 0, flatShading: true });

  const N = 420;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, N);
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, N);
  trunks.castShadow = leaves.castShadow = true;
  leaves.receiveShadow = true;
  trunks.name = 'Tree trunks'; leaves.name = 'Tree canopies';

  let placed = 0, guard = 0;
  while (placed < N && guard++ < N * 30) {
    const a = rand() * TAU;
    const s = rand() > 0.5 ? 1 : -1;
    const off = ROAD_HALF + SHOULDER + 5 + Math.pow(rand(), 0.7) * 140;
    const p = pathPoint(a), t = pathTangent(a);
    const x = p.x + (-t.z) * off * s, z = p.z + t.x * off * s;
    if (Math.hypot(x, z) > 430) continue;
    const y = groundHeight(x, z);
    /* nothing grows above the tree line, which is what makes the bare rock and the snow above it... */
    if (y - loopHeight(a) > 34 + rand() * 10) continue;

    const sc = 0.72 + rand() * 0.66;
    dummy.position.set(x, y - 0.2, z);
    dummy.rotation.set(0, rand() * TAU, 0);
    dummy.scale.set(sc, sc * (0.85 + rand() * 0.5), sc);
    dummy.updateMatrix();
    trunks.setMatrixAt(placed, dummy.matrix);

    dummy.position.y = y + 5.4 * sc;
    dummy.rotation.set(rand() * 0.5, rand() * TAU, rand() * 0.5);
    dummy.scale.set(sc * (1 + rand() * 0.35), sc * (0.82 + rand() * 0.3), sc * (1 + rand() * 0.35));
    dummy.updateMatrix();
    leaves.setMatrixAt(placed, dummy.matrix);

    /* every canopy gets its own tint, which is what stops a wood of identical instances reading as... */
    tint.setHSL(0.26 + rand() * 0.10, 0.30 + rand() * 0.24, 0.15 + rand() * 0.13);
    if (rand() > 0.90) tint.setHSL(0.11 + rand() * 0.04, 0.42, 0.26);   // a few larches turning
    leaves.setColorAt(placed, tint);

    addObstacle(x, z, 0.55 * sc, 'Tree');
    placed++;
  }
  trunks.count = leaves.count = placed;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  scene.add(trunks, leaves);

  /* rocks */
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ map: TEX.rock, roughness: 0.95, metalness: 0.02, flatShading: true });
  const R = 130;
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, R);
  rocks.castShadow = rocks.receiveShadow = true;
  rocks.name = 'Rocks';
  for (let i = 0; i < R; i++) {
    const a = rand() * TAU;
    const s = rand() > 0.5 ? 1 : -1;
    const off = ROAD_HALF + SHOULDER + 1.5 + Math.pow(rand(), 0.8) * 90;
    const p = pathPoint(a), t = pathTangent(a);
    const x = p.x + (-t.z) * off * s, z = p.z + t.x * off * s;
    const sc = 0.4 + rand() * 1.9;
    dummy.position.set(x, groundHeight(x, z) + sc * 0.25, z);
    dummy.rotation.set(rand() * TAU, rand() * TAU, rand() * TAU);
    dummy.scale.set(sc, sc * (0.6 + rand() * 0.5), sc * (0.8 + rand() * 0.4));
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
    tint.setHSL(0.07 + rand() * 0.06, 0.05 + rand() * 0.12, 0.34 + rand() * 0.26);
    rocks.setColorAt(i, tint);
    if (sc > 0.7) addObstacle(x, z, sc * 0.85, 'Rock');
  }
  if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
  scene.add(rocks);
}

/* --------------------------------------------------------------------------- Street lamps,... */
const streetLamps = [];

function buildStreetLamps() {
  const poleMat = new THREE.MeshStandardMaterial({ map: TEX.metalDark, roughness: 0.55, metalness: 0.75 });
  const baseMat = new THREE.MeshStandardMaterial({ map: TEX.concrete, roughness: 0.95, metalness: 0 });
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x2a2c30, emissive: 0xffc477, emissiveIntensity: 0, roughness: 0.3, metalness: 0.1
  });

  const poleGeo = new THREE.CylinderGeometry(0.11, 0.17, 7.4, 10);
  poleGeo.translate(0, 3.7, 0);
  const armGeo = new THREE.BoxGeometry(2.1, 0.16, 0.16);
  const headGeo = new THREE.BoxGeometry(1.15, 0.24, 0.5);
  const lensGeo = new THREE.BoxGeometry(0.95, 0.09, 0.38);
  const baseGeo = new THREE.CylinderGeometry(0.34, 0.42, 0.5, 10);

  const COUNT = 18;
  for (let i = 0; i < COUNT; i++) {
    const s = arcAt(0) + LOOP_LENGTH * (i / COUNT);
    const a = angleAtArc(s);
    const p = pathPoint(a), t = pathTangent(a);
    const sx = -t.z, sz = t.x;
    const side = i % 2 ? 1 : -1;
    const off = (ROAD_HALF + SHOULDER + 0.9) * side;

    const g = new THREE.Group();
    g.position.set(p.x + sx * off, groundHeight(p.x + sx * off, p.z + sz * off) - 0.1, p.z + sz * off);
    g.rotation.y = Math.atan2(-sz * side, -sx * side);

    const base = new THREE.Mesh(baseGeo, baseMat); base.position.y = 0.25;
    const pole = new THREE.Mesh(poleGeo, poleMat);
    const arm = new THREE.Mesh(armGeo, poleMat); arm.position.set(1.0, 7.3, 0);
    const head = new THREE.Mesh(headGeo, poleMat); head.position.set(1.95, 7.18, 0);
    const lens = new THREE.Mesh(lensGeo, lensMat); lens.position.set(1.95, 7.02, 0);
    pole.castShadow = arm.castShadow = head.castShadow = true;
    base.receiveShadow = true;
    g.add(base, pole, arm, head, lens);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.glow, color: 0xffc98c, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0
    }));
    glow.position.set(1.95, 6.95, 0);
    glow.scale.set(7, 7, 1);
    g.add(glow);

    g.name = 'Street lamp';
    g.userData = { lens: lens, glow: glow, world: new THREE.Vector3() };
    g.updateMatrixWorld(true);
    g.userData.world.set(1.95, 6.95, 0).applyMatrix4(g.matrixWorld);

    addObstacle(g.position.x, g.position.z, 0.45, 'Street lamp');
    scene.add(g);
    streetLamps.push(g);
  }
}

function buildMarkerPosts() {
  const geo = new THREE.BoxGeometry(0.11, 1.05, 0.13);
  geo.translate(0, 0.52, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.8, metalness: 0 });
  const N = 150;
  const posts = new THREE.InstancedMesh(geo, mat, N * 2);
  posts.castShadow = true;
  posts.name = 'Marker posts';

  const refGeo = new THREE.BoxGeometry(0.09, 0.16, 0.02);
  const refMat = new THREE.MeshStandardMaterial({
    color: 0x8b1f16, emissive: 0xff3a22, emissiveIntensity: 0.5, roughness: 0.4
  });
  const refs = new THREE.InstancedMesh(refGeo, refMat, N * 2);
  refs.name = 'Reflectors';

  const dummy = new THREE.Object3D();
  let k = 0;
  for (let i = 0; i < N; i++) {
    const a = angleAtArc(LOOP_LENGTH * (i / N));
    const p = pathPoint(a), t = pathTangent(a);
    for (const s of [-1, 1]) {
      const off = (ROAD_HALF + SHOULDER - 0.5) * s;
      const x = p.x + (-t.z) * off, z = p.z + t.x * off;
      const y = p.y - 0.05;
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, Math.atan2(t.x, t.z), 0);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      posts.setMatrixAt(k, dummy.matrix);
      dummy.position.y = y + 0.82;
      dummy.updateMatrix();
      refs.setMatrixAt(k, dummy.matrix);
      k++;
    }
  }
  scene.add(posts, refs);
}

function buildGuardRail() {
  const railTex = TEX.metalLight.clone();
  railTex.wrapS = railTex.wrapT = THREE.RepeatWrapping;
  railTex.repeat.set(1, 40);
  railTex.colorSpace = THREE.SRGBColorSpace;
  railTex.needsUpdate = true;
  const mat = new THREE.MeshStandardMaterial({
    map: railTex, roughness: 0.42, metalness: 0.85, side: THREE.DoubleSide
  });

  /* two stretches of rail on the outside of the tighter bends */
  for (const seg of [[0.15, 1.55], [3.35, 4.75]]) {
    const geo = makeStrip({
      from: seg[0], to: seg[1], samples: 200, cols: 2,
      inner: ROAD_HALF + SHOULDER + 0.15, outer: ROAD_HALF + SHOULDER + 0.15,
      y: 0.42, rise: 0.42, vPitch: 4
    });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.name = 'Guard rail';
    scene.add(m);

    /* posts under the rail */
    const postGeo = new THREE.BoxGeometry(0.1, 1.0, 0.18);
    postGeo.translate(0, 0.5, 0);
    const n = 34;
    const posts = new THREE.InstancedMesh(postGeo, mat, n);
    posts.castShadow = true;
    const dummy = new THREE.Object3D();
    for (let i = 0; i < n; i++) {
      const a = lerp(seg[0], seg[1], i / (n - 1));
      const p = pathPoint(a), t = pathTangent(a);
      const off = ROAD_HALF + SHOULDER + 0.15;
      const x = p.x + (-t.z) * off, z = p.z + t.x * off;
      dummy.position.set(x, groundHeight(x, z) - 0.1, z);
      dummy.rotation.set(0, Math.atan2(t.x, t.z), 0);
      dummy.updateMatrix();
      posts.setMatrixAt(i, dummy.matrix);
    }
    scene.add(posts);

    /* the rail is continuous, so fill the gaps between posts with overlapping circles rather than... */
    const steps = Math.ceil((seg[1] - seg[0]) * 118 / 2.0);
    for (let i = 0; i <= steps; i++) {
      const a = lerp(seg[0], seg[1], i / steps);
      const p = pathPoint(a), t = pathTangent(a);
      const off = ROAD_HALF + SHOULDER + 0.15;
      addObstacle(p.x + (-t.z) * off, p.z + t.x * off, 0.75, 'Guard rail');
    }
  }
}

function buildSigns() {
  const poleMat = new THREE.MeshStandardMaterial({ map: TEX.metalLight, roughness: 0.5, metalness: 0.8 });
  const poleGeo = new THREE.CylinderGeometry(0.055, 0.07, 2.9, 8);
  poleGeo.translate(0, 1.45, 0);

  const specs = [
    { a: 0.55, tex: TEX.signLimit, r: 0.52, round: true },
    { a: 2.30, tex: TEX.signBend, r: 0.58, round: false },
    { a: 3.90, tex: TEX.signLimit, r: 0.52, round: true },
    { a: 5.35, tex: TEX.signBend, r: 0.58, round: false }
  ];

  for (const sp of specs) {
    const p = pathPoint(sp.a), t = pathTangent(sp.a);
    const off = ROAD_HALF + SHOULDER + 0.6;
    const x = p.x + (-t.z) * off, z = p.z + t.x * off;

    const g = new THREE.Group();
    g.position.set(x, groundHeight(x, z) - 0.1, z);
    g.rotation.y = Math.atan2(-t.x, -t.z);

    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.castShadow = true;
    const face = new THREE.Mesh(
      sp.round ? new THREE.CircleGeometry(sp.r, 32) : new THREE.PlaneGeometry(sp.r * 2, sp.r * 2),
      new THREE.MeshStandardMaterial({ map: sp.tex, roughness: 0.62, metalness: 0.05, side: THREE.DoubleSide })
    );
    face.position.set(0, 2.6, 0.05);
    face.castShadow = true;
    g.add(pole, face);
    g.name = 'Road sign';
    addObstacle(x, z, 0.35, 'Road sign');
    scene.add(g);
  }
}

export { LOOP_LENGTH, ROAD_HALF, SHOULDER, angleAtArc, arcAt, buildArcTable, buildGrassTufts, buildGuardRail, buildMarkerPosts, buildObstacleGrid, buildRoad, buildScenery, buildSigns, buildSky, buildStreetLamps, buildTerrain, grassMat, groundHeight, loopHeight, loopRadius, nearbyObstacles, pathCurvature, pathPoint, pathTangent, roadMesh, skyMat, skyMesh, streetLamps, terrain };
