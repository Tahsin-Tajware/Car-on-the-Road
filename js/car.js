import * as THREE from 'three';
import { TAU, smoothstep } from './helpers.js';
import { TEX, canvas2d, makeTex } from './textures.js';
import { makeGlassMaterial, makePaintMaterial } from './shaders.js';
import { scene } from './renderer.js';
import { setHeadlights } from './lighting.js';
import { toast } from './main.js';



/* --- two more textures, needed only by the wheels --- */
function texRim() {
  const S = 512, [c, g] = canvas2d(S), R = S / 2;
  g.fillStyle = '#1a1c20'; g.beginPath(); g.arc(R, R, R, 0, TAU); g.fill();

  /* outer chrome lip */
  const lip = g.createRadialGradient(R, R, R * 0.80, R, R, R);
  lip.addColorStop(0, '#7d838c'); lip.addColorStop(0.55, '#c4cad3'); lip.addColorStop(1, '#5f646b');
  g.fillStyle = lip; g.beginPath(); g.arc(R, R, R * 0.99, 0, TAU); g.arc(R, R, R * 0.80, 0, TAU, true); g.fill();

  /* five spokes */
  g.save(); g.translate(R, R);
  for (let i = 0; i < 5; i++) {
    g.rotate(TAU / 5);
    const grd = g.createLinearGradient(0, 0, 0, -R * 0.82);
    grd.addColorStop(0, '#646a73'); grd.addColorStop(0.5, '#aeb4bd'); grd.addColorStop(1, '#71777f');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(-R * 0.20, -R * 0.14);
    g.quadraticCurveTo(-R * 0.22, -R * 0.52, -R * 0.28, -R * 0.80);
    g.lineTo(R * 0.28, -R * 0.80);
    g.quadraticCurveTo(R * 0.22, -R * 0.52, R * 0.20, -R * 0.14);
    g.closePath(); g.fill();
  }
  g.restore();

  /* hub and brake caliper glimpsed behind the spokes */
  g.fillStyle = '#23262b'; g.beginPath(); g.arc(R, R, R * 0.20, 0, TAU); g.fill();
  g.fillStyle = '#9aa1aa'; g.beginPath(); g.arc(R, R, R * 0.11, 0, TAU); g.fill();
  g.fillStyle = '#c0392b';
  g.beginPath(); g.arc(R, R, R * 0.55, -0.5, 0.5); g.lineWidth = R * 0.13; g.strokeStyle = '#c0392b'; g.stroke();
  return makeTex(c, 1, 1);
}

function texSidewall() {
  const S = 256, [c, g] = canvas2d(S), R = S / 2;
  g.fillStyle = '#101115'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < 9; i++) {
    g.strokeStyle = `rgba(255,255,255,${0.02 + (i % 2) * 0.035})`;
    g.lineWidth = 2;
    g.beginPath(); g.arc(R, R, R * (0.52 + i * 0.05), 0, TAU); g.stroke();
  }
  g.save(); g.translate(R, R);
  g.fillStyle = 'rgba(190,196,206,.45)';
  g.font = 'bold 15px ui-sans-serif, sans-serif';
  g.textAlign = 'center';
  for (let i = 0; i < 6; i++) {
    g.save(); g.rotate(i * TAU / 6); g.fillText('225/40 ZR18', 0, -R * 0.74); g.restore();
  }
  g.restore();
  return makeTex(c, 1, 1);
}

// shape helpers

/* run a closed Catmull-Rom through the points so the silhouette is smooth */
function smoothShape(pts, divisions, tension) {
  const curve = new THREE.CatmullRomCurve3(
    pts.map(p => new THREE.Vector3(p[0], p[1], 0)), true, 'catmullrom',
    tension === undefined ? 0.32 : tension);
  const arr = curve.getPoints(divisions || 130);
  const s = new THREE.Shape();
  s.moveTo(arr[0].x, arr[0].y);
  for (let i = 1; i < arr.length; i++) s.lineTo(arr[i].x, arr[i].y);
  s.closePath();
  return s;
}

function extrudeShape(shape, depth, bevel, curveSeg) {
  const b = Math.min(bevel, depth * 0.28);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - b * 2, bevelEnabled: true, bevelThickness: b,
    bevelSize: b, bevelOffset: 0, bevelSegments: 3, curveSegments: curveSeg || 6
  });
  g.translate(0, 0, -(depth - b * 2) / 2 - b);
  g.computeVertexNormals();
  return g;
}

function roundedRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  r = Math.min(r, w / 2 - 0.001, h / 2 - 0.001);
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}
function roundedBox(w, h, d, r) {
  return extrudeShape(roundedRect(w, h, r), d, Math.min(r, d * 0.24), 5);
}

/* pull the width in as a function of position, which is what turns a slab into something that... */
function taper(geo, fn) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const k = fn(p.getX(i), p.getY(i), p.getZ(i));
    p.setZ(i, p.getZ(i) * k);
  }
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/* --------------------------------------------------------------------------- */

let car, chassis, carBody, wheels = [], frontPivots = [], headlightGlow = [];
let paintMat, glassMat, headLens, tailMats = [], reverseMats = [];
let contactShadow;

const PAINT_COLOURS = [0xb2262c, 0xa31d24, 0xd2232a, 0x631015, 0x1b1d21, 0xe8e6e1];
let paintIndex = 0;

function buildCar() {
  car = new THREE.Group();
  car.name = 'Car';
  scene.add(car);

  /* car yaw and position, chassis tilted by the ground, carBody leans and dives */
  chassis = new THREE.Group();
  car.add(chassis);
  carBody = new THREE.Group();
  chassis.add(carBody);

  paintMat = makePaintMaterial(TEX.paint, PAINT_COLOURS[paintIndex], 0.80, 0.22);
  glassMat = makeGlassMaterial(TEX.glass);

  const darkMat = new THREE.MeshStandardMaterial({ color: 0x0e1013, roughness: 0.85, metalness: 0.1 });
  const chromeMat = new THREE.MeshStandardMaterial({ map: TEX.metalLight, roughness: 0.22, metalness: 0.95 });
  const grilleMat = new THREE.MeshStandardMaterial({ map: TEX.grille, roughness: 0.7, metalness: 0.4 });
  const silverMat = new THREE.MeshStandardMaterial({ map: TEX.metalLight, roughness: 0.44, metalness: 0.72 });
  const cladMat = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.95, metalness: 0.05 });

  const add = (mesh, name) => {
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = name;
    mesh.userData.part = name;
    carBody.add(mesh);
    return mesh;
  };

  /* ---- body tub: slab sided, flat bonnet, upright front and rear ---- */
  const tubProfile = [
    [1.93, 0.62], [1.95, 1.30], [1.62, 1.41], [0.60, 1.41],
    [-1.52, 1.41], [-1.92, 1.33], [-1.94, 0.62],
    [-1.40, 0.52], [0.00, 0.50], [1.40, 0.52]
  ];
  const tubGeo = taper(
    extrudeShape(smoothShape(tubProfile, 150, 0.06), 1.84, 0.07, 5),
    (x, y) => 1 - 0.06 * smoothstep(1.55, 1.98, Math.abs(x))
  );
  add(new THREE.Mesh(tubGeo, paintMat), 'Body tub');

  /* bonnet panel with a raised centre section */
  const hood = add(new THREE.Mesh(roundedBox(1.30, 0.06, 1.30, 0.03), paintMat), 'Bonnet');
  hood.position.set(1.24, 1.44, 0);
  for (const z of [0.44, -0.44]) {
    const rib = add(new THREE.Mesh(roundedBox(1.20, 0.05, 0.09, 0.02), paintMat), 'Bonnet');
    rib.position.set(1.24, 1.46, z);
  }
  /* the fenders stand proud of the bonnet, which is the shape of the front end */
  for (const z of [0.76, -0.76]) {
    const fender = add(new THREE.Mesh(roundedBox(1.44, 0.13, 0.34, 0.06), paintMat), 'Front fender');
    fender.position.set(1.20, 1.44, z);
  }

  /* ---- hard top: glass box with the frame laid over it ---- */
  const cabin = new THREE.Mesh(roundedBox(2.22, 0.52, 1.66, 0.04), glassMat);
  cabin.position.set(-0.50, 1.67, 0);
  cabin.name = 'Windows'; cabin.userData.part = 'Windows';
  cabin.renderOrder = 2;
  carBody.add(cabin);

  /* the roof is a separate black panel, as it is on the real hard top */
  const roof = add(new THREE.Mesh(roundedBox(2.40, 0.07, 1.80, 0.04), cladMat), 'Hard top roof');
  roof.position.set(-0.54, 1.955, 0);
  /* the frame the glass sits in: a rail under the roof on each side */
  for (const z of [0.855, -0.855]) {
    const rail = add(new THREE.Mesh(roundedBox(2.26, 0.08, 0.09, 0.03), cladMat), 'Roof rail');
    rail.position.set(-0.52, 1.90, z);
  }

  /* pillars: upright, which is what makes it read as an off roader */
  const pillar = (x, y, h, ang, z, w) => {
    const m = add(new THREE.Mesh(roundedBox(w || 0.10, h, 0.10, 0.03), paintMat), 'Pillar');
    m.position.set(x, y, z); m.rotation.z = ang;
    return m;
  };
  for (const z of [0.845, -0.845]) {
    pillar(0.60, 1.66, 0.58, -0.13, z, 0.11);   // A pillar, raked back slightly
    pillar(-0.34, 1.67, 0.56, 0.0, z, 0.09);    // B pillar
    pillar(-1.58, 1.67, 0.56, 0.06, z, 0.10);   // C pillar
  }
  /* window surrounds */
  for (const z of [0.86, -0.86]) {
    const belt = add(new THREE.Mesh(roundedBox(2.28, 0.07, 0.07, 0.02), paintMat), 'Window trim');
    belt.position.set(-0.50, 1.42, z);
  }

  /* windscreen frame and wipers */
  const wsTop = add(new THREE.Mesh(roundedBox(0.10, 0.09, 1.72, 0.03), paintMat), 'Windscreen frame');
  wsTop.position.set(0.66, 1.92, 0);
  for (const z of [0.36, -0.36]) {
    const wiper = add(new THREE.Mesh(new THREE.BoxGeometry(0.50, 0.02, 0.03), darkMat), 'Wiper');
    wiper.position.set(0.72, 1.44, z); wiper.rotation.z = 0.30;
  }

  /* ---- doors ---- */
  for (const z of [0.925, -0.925]) {
    const gap = add(new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.80, 0.02), darkMat), 'Door shut line');
    gap.position.set(0.56, 0.98, z);
    const gap2 = add(new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.80, 0.02), darkMat), 'Door shut line');
    gap2.position.set(-0.36, 0.98, z);
    const handle = add(new THREE.Mesh(roundedBox(0.20, 0.06, 0.05, 0.02), cladMat), 'Door handle');
    handle.position.set(-0.02, 1.18, z);
    const step = add(new THREE.Mesh(roundedBox(1.66, 0.10, 0.14, 0.04), cladMat), 'Side step');
    step.position.set(0.05, 0.50, z * 1.02);
  }

  /* ---- black wheel arch flares ---- */
  for (const x of [1.225, -1.225]) {
    for (const z of [0.88, -0.88]) {
      const arch = new THREE.Mesh(
        new THREE.TorusGeometry(0.575, 0.085, 10, 26, Math.PI * 1.02), cladMat);
      arch.rotation.z = -0.04;
      arch.position.set(x, 0.42, z * 1.07);
      arch.castShadow = true;
      arch.name = 'Wheel arch'; arch.userData.part = 'Wheel arch';
      carBody.add(arch);
    }
  }

  /* ---- front: round lamps either side of the slatted grille ---- */
  const grillePanel = add(new THREE.Mesh(roundedBox(0.09, 0.54, 1.70, 0.04), darkMat), 'Grille');
  grillePanel.position.set(1.94, 1.12, 0);
  for (let i = 0; i < 6; i++) {
    const slat = add(new THREE.Mesh(roundedBox(0.07, 0.46, 0.085, 0.02), grilleMat), 'Grille slat');
    slat.position.set(1.985, 1.12, -0.315 + i * 0.126);
  }

  headLens = new THREE.MeshStandardMaterial({
    color: 0xe6ecf5, emissive: 0xfff0cf, emissiveIntensity: 0.05,
    roughness: 0.10, metalness: 0.1
  });
  const lampGeo = new THREE.CylinderGeometry(0.185, 0.185, 0.09, 24);
  lampGeo.rotateZ(Math.PI / 2);
  const ringGeo = new THREE.TorusGeometry(0.195, 0.032, 8, 24);
  ringGeo.rotateY(Math.PI / 2);

  for (const z of [0.63, -0.63]) {
    const lens = add(new THREE.Mesh(lampGeo, headLens), 'Headlight');
    lens.position.set(1.975, 1.13, z);
    const ring = add(new THREE.Mesh(ringGeo, chromeMat), 'Headlight surround');
    ring.position.set(1.985, 1.13, z);

    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TEX.glow, color: 0xfff2d0, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0
    }));
    glow.position.set(2.04, 1.13, z);
    glow.scale.set(2.0, 2.0, 1);
    carBody.add(glow);
    headlightGlow.push(glow);
  }

  /* amber indicators in the front bumper */
  for (const z of [0.80, -0.80]) {
    const ind = add(new THREE.Mesh(roundedBox(0.06, 0.09, 0.16, 0.02),
      new THREE.MeshStandardMaterial({ color: 0x7a4a10, emissive: 0xff8c1a, emissiveIntensity: 0.5 })), 'Indicator');
    ind.position.set(1.95, 1.32, z * 1.05);
  }

  /* ---- bumpers with skid plates ---- */
  const fb = add(new THREE.Mesh(roundedBox(0.26, 0.30, 1.90, 0.07), cladMat), 'Front bumper');
  fb.position.set(2.00, 0.74, 0);
  const fs = add(new THREE.Mesh(roundedBox(0.22, 0.10, 1.10, 0.03), silverMat), 'Skid plate');
  fs.position.set(2.03, 0.58, 0);
  const rb = add(new THREE.Mesh(roundedBox(0.24, 0.28, 1.86, 0.07), cladMat), 'Rear bumper');
  rb.position.set(-2.00, 0.74, 0);
  const rs = add(new THREE.Mesh(roundedBox(0.20, 0.09, 1.00, 0.03), silverMat), 'Skid plate');
  rs.position.set(-2.03, 0.60, 0);
  for (const z of [0.66, -0.66]) {
    const hook = add(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.14, 8), silverMat), 'Tow hook');
    hook.position.set(2.06, 0.80, z); hook.rotation.z = Math.PI / 2;
  }

  /* ---- tail lights: dark until the brakes come on ---- */
  for (const z of [0.74, -0.74]) {
    const m = new THREE.MeshStandardMaterial({
      color: 0x4a1210, emissive: 0xff2412, emissiveIntensity: 0.04, roughness: 0.35
    });
    tailMats.push(m);
    const t = add(new THREE.Mesh(roundedBox(0.07, 0.34, 0.17, 0.03), m), 'Tail light');
    t.position.set(-1.96, 1.10, z);

    const rm = new THREE.MeshStandardMaterial({
      color: 0x5a5f66, emissive: 0xf2f6ff, emissiveIntensity: 0, roughness: 0.3
    });
    reverseMats.push(rm);
    const rl = add(new THREE.Mesh(roundedBox(0.06, 0.11, 0.15, 0.02), rm), 'Reversing light');
    rl.position.set(-1.95, 0.88, z);
  }

  /* ---- tailgate mounted spare wheel ---- */
  const spare = new THREE.Group();
  spare.position.set(-2.14, 1.18, 0.06);
  spare.rotation.y = Math.PI / 2;
  carBody.add(spare);

  /* ---- mirrors ---- */
  for (const z of [1.00, -1.00]) {
    const stalk = add(new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.030, 0.16, 6), cladMat), 'Mirror');
    stalk.position.set(0.62, 1.48, z); stalk.rotation.x = z > 0 ? -0.8 : 0.8;
    const shell = add(new THREE.Mesh(roundedBox(0.13, 0.20, 0.10, 0.04), cladMat), 'Mirror');
    shell.position.set(0.60, 1.56, z * 1.08);
    const face = add(new THREE.Mesh(new THREE.PlaneGeometry(0.10, 0.16),
      new THREE.MeshStandardMaterial({ color: 0x8fa6bd, roughness: 0.08, metalness: 1 })), 'Mirror');
    face.position.set(0.53, 1.56, z * 1.13);
    face.rotation.y = z > 0 ? -Math.PI / 2 - 0.25 : Math.PI / 2 + 0.25;
  }

  /* ---- exhaust ---- */
  const pipe = add(new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.054, 0.18, 12), chromeMat), 'Exhaust');
  pipe.position.set(-1.98, 0.56, 0.62); pipe.rotation.z = Math.PI / 2;

  /* ---- number plates ---- */
  const plateMat = new THREE.MeshStandardMaterial({ map: TEX.plate, roughness: 0.55, metalness: 0.05 });
  const pf = add(new THREE.Mesh(new THREE.PlaneGeometry(0.50, 0.13), plateMat), 'Number plate');
  pf.position.set(2.135, 0.74, 0); pf.rotation.y = Math.PI / 2;
  const pr = add(new THREE.Mesh(new THREE.PlaneGeometry(0.50, 0.13), plateMat), 'Number plate');
  pr.position.set(-2.135, 0.74, 0.42); pr.rotation.y = -Math.PI / 2;

  /* ---- a hint of an interior ---- */
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x24262c, roughness: 0.92 });
  for (const z of [0.42, -0.42]) {
    const cushion = new THREE.Mesh(roundedBox(0.48, 0.10, 0.44, 0.05), seatMat);
    cushion.position.set(0.02, 1.46, z);
    const back = new THREE.Mesh(roundedBox(0.12, 0.54, 0.44, 0.05), seatMat);
    back.position.set(-0.26, 1.74, z); back.rotation.z = 0.12;
    carBody.add(cushion, back);
  }
  const dash = new THREE.Mesh(roundedBox(0.26, 0.20, 1.50, 0.05), seatMat);
  dash.position.set(0.46, 1.52, 0);
  const steer = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.022, 8, 20), seatMat);
  steer.position.set(0.28, 1.60, 0.42); steer.rotation.y = Math.PI / 2; steer.rotation.x = 0.55;
  carBody.add(dash, steer);

  /* ---- wheels: tall chunky all terrain, the same at both axles ---- */
  const treadTex = TEX.tyre.clone();
  treadTex.wrapS = treadTex.wrapT = THREE.RepeatWrapping;
  treadTex.repeat.set(5, 1);
  treadTex.colorSpace = THREE.SRGBColorSpace;
  treadTex.needsUpdate = true;

  const treadMat = new THREE.MeshStandardMaterial({ map: treadTex, roughness: 0.97, metalness: 0 });
  const sideMat = new THREE.MeshStandardMaterial({ map: TEX.sidewall, roughness: 0.94, metalness: 0 });
  const rimMat = new THREE.MeshStandardMaterial({ map: TEX.rim, roughness: 0.38, metalness: 0.78 });

  const RW = 0.40, WW = 0.30;
  const treadGeo = new THREE.CylinderGeometry(RW, RW, WW, 30, 1, true);
  treadGeo.rotateX(Math.PI / 2);                 // spin axis now runs left to right
  const sideGeo = new THREE.RingGeometry(0.215, RW, 30);
  const rimGeo = new THREE.CircleGeometry(0.255, 28);

  const makeWheel = (parent) => {
    const w = new THREE.Group();
    const tread = new THREE.Mesh(treadGeo, treadMat);
    tread.castShadow = true; tread.name = 'Tyre'; tread.userData.part = 'Tyre';
    w.add(tread);
    for (const s of [1, -1]) {
      const sw = new THREE.Mesh(sideGeo, sideMat);
      sw.position.z = s * WW / 2 * 0.999;
      sw.rotation.y = s > 0 ? 0 : Math.PI;
      sw.name = 'Tyre sidewall'; sw.userData.part = 'Tyre';
      w.add(sw);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.position.z = s * (WW / 2 - 0.012);
      rim.rotation.y = s > 0 ? 0 : Math.PI;
      rim.castShadow = true;
      rim.name = 'Alloy wheel'; rim.userData.part = 'Alloy wheel';
      w.add(rim);
    }
    parent.add(w);
    return w;
  };

  for (const [ax, isFront] of [[1.225, true], [-1.225, false]]) {
    for (const z of [0.86, -0.86]) {
      const pivot = new THREE.Group();               // steering happens here
      pivot.position.set(ax, RW, z);
      chassis.add(pivot);
      wheels.push(makeWheel(pivot));                 // and rolling happens here
      if (isFront) frontPivots.push(pivot);
    }
  }
  makeWheel(spare);                                  // the one bolted to the tailgate

  /* ---- head light spot lights, parented so they aim wherever the car does -- */
  const headL = new THREE.SpotLight(0xfff0d2, 0, 78, 0.40, 0.55, 1.3);
  const headR = new THREE.SpotLight(0xfff0d2, 0, 78, 0.40, 0.55, 1.3);
  headL.position.set(2.02, 1.13, 0.63);
  headR.position.set(2.02, 1.13, -0.63);
  headL.target.position.set(30, -2.4, 3.2);
  headR.target.position.set(30, -2.4, -3.2);
  headL.castShadow = true;
  headL.shadow.mapSize.set(1024, 1024);
  headL.shadow.camera.near = 0.6;
  headL.shadow.camera.far = 78;
  headL.shadow.bias = -0.0016;
  chassis.add(headL, headL.target, headR, headR.target);
  setHeadlights(headL, headR);

  /* ---- soft contact shadow so the car never looks like it is floating ---- */
  contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(5.8, 3.2),
    new THREE.MeshBasicMaterial({
      map: TEX.blob, transparent: true, opacity: 0.85,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3
    })
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.renderOrder = 1;
  scene.add(contactShadow);
}

function cyclePaint() {
  paintIndex = (paintIndex + 1) % PAINT_COLOURS.length;
  paintMat.uniforms.uTint.value.setHex(PAINT_COLOURS[paintIndex]);
  const names = ['tango red', 'deep metallic red', 'bright red', 'dark crimson', 'napoli black', 'rocky beige'];
  toast(`Paint <b>${names[paintIndex]}</b>`);
}

export { buildCar, car, carBody, chassis, contactShadow, cyclePaint, frontPivots, headLens, headlightGlow, reverseMats, tailMats, texRim, texSidewall, wheels };
