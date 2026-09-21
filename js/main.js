import * as THREE from 'three';
import { TAU, UI, clamp, lerp, nextFrame, rng, smoothstep, step } from './helpers.js';
import { TEX, texAsphalt, texBark, texBlob, texConcrete, texDirt, texGlass, texGlow, texGrass, texGravel, texGrille, texLeaf, texMetal, texPaint, texPlate, texRock, texSignBend, texSignLimit, texTuft, texTyre } from './textures.js';
import { FOV, camera, initRenderer, orthoCam, perspCam, renderer, scene, syncOrthoFrustum, usingPerspective } from './renderer.js';
import { buildEnvironment, dayAuto, dayFactor, dayPhase, initLights, lampAngle, lampAuto, lampOn, setDayPhase, updateShaderLights, updateSky } from './lighting.js';
import { buildArcTable, buildGrassTufts, buildGuardRail, buildMarkerPosts, buildObstacleGrid, buildRoad, buildScenery, buildSigns, buildSky, buildStreetLamps, buildTerrain, grassMat, skyMat, skyMesh } from './world.js';
import { buildCar, car, texRim, texSidewall } from './car.js';
import { MAX_SPEED, WHEEL_R, angleLerp, drive, updateCar, updateLighting, updateOrbitLamp } from './driving.js';
import { CAM_MODES, INTRO_END, INTRO_KEYS, camMode, dayTween, dragging, initInteraction, intro, keys, orbit, setCamModeValue, setDayTween, setIntro } from './interaction.js';



let toastTimer = null;
function toast(html) {
  const t = UI('toast');
  t.innerHTML = html;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2100);
}

const TEAM = [
  { name: 'A.S.M. Tahsin Tajware', id: '20220104006' },
  { name: 'Sonod Sadman', id: '20220104025' }
];

const REQUIREMENTS = [
  ['Custom shaders',
    'S3 &mdash; makeSkyMaterial, makePaintMaterial, makeGlassMaterial, makeGrassMaterial, attachRoadShader, attachTerrainShader',
    'Four complete GLSL programs plus two that extend the standard material. The car paint works out Blinn&ndash;Phong by hand; the lane markings are solved from the surface coordinates, so press <b>W</b> then zoom right in and they stay sharp.'],
  ['Lighting',
    'S5 &mdash; initLights, updateSky, updateLighting',
    'Ambient, hemisphere, a directional sun with a 2048&sup2; shadow map, the point lamp that circles the road, two head light spots, and five point lights lent to the nearest street lamps. Press <b>G</b> to see where they all sit.'],
  ['Perspective projection',
    'S4 &mdash; initRenderer, syncOrthoFrustum',
    'THREE.PerspectiveCamera at a 55&deg; field of view. Press <b>P</b> to swap in an orthographic camera on the same transform, and <b>[</b> <b>]</b> to change the field of view.'],
  ['Texture for each object',
    'S2 &mdash; the TEX library',
    'Twenty two textures, every one painted onto a canvas at load time from layered value noise and 2D drawing. Nothing is downloaded, so the file runs with the network switched off.'],
  ['Animation',
    'S9 &mdash; driveAuto, driveManual, updateCar, updateOrbitLamp',
    'The autopilot places the car by arc length, so its speed is honest however sharply the road bends. Driving by hand runs a bicycle model instead: yaw rate = speed &divide; wheelbase &times; tan(steering angle), which is why it stops turning when it stops moving. Wheel spin is speed &divide; radius in both.'],
  ['Mouse and keyboard',
    'S11 &mdash; initInteraction, onKey, pickPart',
    'Held keys are tracked separately from one-shot commands. The arrow keys drive the car: <b>&larr; &rarr;</b> steer, <b>&uarr;</b> throttle, <b>&darr;</b> brake and then reverse, space for the handbrake, <b>M</b> to hand it back to the autopilot. Drag to swing the camera, wheel or pinch to zoom, click any panel to have it named by a ray cast.'],

  ['Task 10 &mdash; keyboard moves the camera around the car',
    'S11 onKey, S12 updateCamera',
    '<b>Q</b> and <b>E</b> walk the camera round the car, <b>,</b> and <b>.</b> raise and lower it, <b>&minus;</b> and <b>=</b> move it out and in. They are read as held keys, so the sweep is smooth and the same speed whatever the frame rate. <b>1</b>&ndash;<b>4</b> pick orbit, chase, driver and overhead; <b>A</b> lets the camera circle on its own.'],

  ['Task 10 &mdash; mouse rotates the light around the road',
    'S11 pointermove, S9 updateOrbitLamp',
    'Hold <b>shift</b> and drag, or drag with the <b>right button</b>, and the lamp orbiting the loop follows the mouse: horizontal travel walks its angle around the road. That switches the lamp off its own timer, and <b>J</b> hands it back. <b>O</b> re-centres the orbit on the car, <b>L</b> turns it off, <b>K</b> lets it cast shadows.'],

  ['Task 10 &mdash; the car wheels rotate',
    'S9 &mdash; updateCar',
    'Wheel spin is speed &divide; radius integrated every frame, so the tread turns once for every 2&pi;r metres travelled and runs backwards in reverse. The two front wheels sit on their own pivots and take the steering angle on top of that.']
];

function buildInfoTable() {
  UI('reqRows').innerHTML = REQUIREMENTS
    .map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('');
}
function toggleInfo() {
  UI('info').classList.toggle('on');          // the scene keeps running behind it
}

let fpsAcc = 0, fpsCount = 0, fpsShown = 60, hudTimer = 0, fpsLast = 0;

function updateHUD(dt) {
  /* measured against the real clock, not the delta the physics uses, which is clamped so a long... */
  const now = performance.now();
  if (fpsLast) fpsAcc += (now - fpsLast) / 1000;
  fpsLast = now;
  fpsCount++;
  hudTimer += dt;
  if (hudTimer < 0.14) return;
  hudTimer = 0;
  if (fpsAcc > 0.05) { fpsShown = Math.max(1, Math.round(fpsCount / fpsAcc)); fpsAcc = 0; fpsCount = 0; }

  const kmh = Math.round(Math.abs(drive.speed) * 3.6);
  UI('dSpeed').textContent = kmh;
  UI('dMeter').style.width = (Math.abs(drive.speed) / MAX_SPEED * 100) + '%';

  UI('tDrive').textContent = drive.auto
    ? (drive.running ? 'Autopilot' : 'Autopilot · held')
    : (drive.speed < -0.1 ? 'Manual · reverse' : 'Manual');

  UI('tCam').textContent = CAM_MODES[camMode] + (orbit.auto && camMode === 0 ? ' · auto' : '');
  UI('tProj').textContent = usingPerspective
    ? `Perspective ${Math.round(perspCam.fov)}°` : 'Orthographic';
  UI('tRpm').textContent = Math.round(Math.abs(drive.speed) / (TAU * WHEEL_R) * 60) + ' rpm';
  UI('tLamp').textContent = Math.round(lampAngle * 180 / Math.PI) + '°'
    + (lampOn ? (lampAuto ? '' : ' · on the mouse') : ' · off');

  /* the arc peaks a quarter of the way through the cycle, so shift the clock to put that moment... */
  const hour = ((((dayPhase + 0.25) % 1) + 1) % 1) * 24;
  const hh = String(Math.floor(hour)).padStart(2, '0');
  const mm = String(Math.floor(hour % 1 * 60)).padStart(2, '0');
  UI('tSun').textContent = `${hh}:${mm}`;
  UI('tFps').textContent = fpsShown + ' fps';
}

/* --- camera rig --- */

/* radians per second the held camera keys move the orbit through */
const KEY_SWING = 1.25;
const KEY_LIFT = 0.85;

const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3();
const _fwd = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
let camReady = false;
let cabinGlass = null;      // hidden from the driver seat, see updateCamera

function updateCamera(dt) {
  const c = car.position;
  _fwd.set(Math.cos(-car.rotation.y), 0, Math.sin(-car.rotation.y)).normalize();

  let targetPos, lookAt;

  /* the zoom is damped rather than snapped, which is what makes the wheel feel smooth instead of... */
  orbit.dist += (orbit.distGoal - orbit.dist) * Math.min(1, dt * 2.0);

  if (!running) {
    /* while the title card is up, sit further back and aim a little low so the car and the road it... */
    orbit.theta += dt * 0.085;
    const d = 23, ph = 1.16;
    targetPos = new THREE.Vector3(
      c.x + Math.cos(orbit.theta) * Math.sin(ph) * d,
      c.y + Math.cos(ph) * d + 5.2,
      c.z + Math.sin(orbit.theta) * Math.sin(ph) * d
    );
    lookAt = new THREE.Vector3(c.x, c.y - 2.6, c.z);

  } else if (intro) {
    /* the opening sweep: */
    intro.t += dt;
    const p = clamp(intro.t / intro.dur, 0, 1);
    let k0 = INTRO_KEYS[0], k1 = INTRO_KEYS[1];
    for (let i = 0; i < INTRO_KEYS.length - 1; i++) {
      if (p >= INTRO_KEYS[i].t && p <= INTRO_KEYS[i + 1].t) { k0 = INTRO_KEYS[i]; k1 = INTRO_KEYS[i + 1]; }
    }
    const f = smoothstep(k0.t, k1.t, p);
    const dTheta = lerp(k0.dTheta, k1.dTheta, f);
    const phi = lerp(k0.phi, k1.phi, f);
    const dist = lerp(k0.dist, k1.dist, f);
    const lift = lerp(k0.lift, k1.lift, f);

    orbit.theta = -car.rotation.y + dTheta;
    orbit.phi = phi; orbit.dist = orbit.distGoal = dist;

    const sp = Math.sin(phi), cp = Math.cos(phi);
    targetPos = new THREE.Vector3(
      c.x + Math.cos(orbit.theta) * sp * dist,
      c.y + cp * dist + lift,
      c.z + Math.sin(orbit.theta) * sp * dist
    );
    lookAt = new THREE.Vector3(c.x + _fwd.x * 1.6, c.y + 0.95, c.z + _fwd.z * 1.6);
    if (p >= 1) { setIntro(null); onIntroDone(); }

  } else if (camMode === 0) {
    /* the requirement: the camera moves around the car.
       Q and E walk it round, the comma and the full stop raise and lower it.
       They are read as held keys rather than as key presses so the movement is
       smooth and frame rate independent, the same way the throttle is read. */
    const kSwing = (keys['q'] ? 1 : 0) - (keys['e'] ? 1 : 0);
    const kLift = (keys[','] ? 1 : 0) - (keys['.'] ? 1 : 0);
    if (kSwing || kLift) {
      orbit.follow = false; orbit.auto = false;
      orbit.theta += kSwing * dt * KEY_SWING;
      orbit.phi = clamp(orbit.phi - kLift * dt * KEY_LIFT, 0.16, 1.52);
    }

    if (orbit.auto) orbit.theta += dt * orbit.autoSpeed;
    else if (orbit.follow) orbit.theta = angleLerp(orbit.theta, -car.rotation.y + Math.PI, Math.min(1, dt * 1.8));
    const sp = Math.sin(orbit.phi), cp = Math.cos(orbit.phi);
    targetPos = new THREE.Vector3(
      c.x + Math.cos(orbit.theta) * sp * orbit.dist,
      c.y + cp * orbit.dist + 1.6,
      c.z + Math.sin(orbit.theta) * sp * orbit.dist
    );
    /* look a little up the road rather than straight at the roof, which is what puts the car low... */
    lookAt = orbit.follow
      ? new THREE.Vector3(c.x + _fwd.x * 3.0, c.y + 1.15, c.z + _fwd.z * 3.0)
      : new THREE.Vector3(c.x, c.y + 0.85, c.z);

  } else if (camMode === 1) {
    targetPos = new THREE.Vector3(
      c.x - _fwd.x * 8.2, c.y + 3.0, c.z - _fwd.z * 8.2);
    lookAt = new THREE.Vector3(c.x + _fwd.x * 8, c.y + 1.0, c.z + _fwd.z * 8);

  } else if (camMode === 2) {
    /* eye height, not floor height: the seat base sits at 1.46 so anything
       lower looks out from under it and fills the frame with front tyre */
    const side = new THREE.Vector3(-_fwd.z, 0, _fwd.x);
    targetPos = new THREE.Vector3(
      c.x + _fwd.x * 0.08 + side.x * 0.42, c.y + 1.64, c.z + _fwd.z * 0.08 + side.z * 0.42);
    /* aim level down the road rather than at the bonnet */
    lookAt = new THREE.Vector3(c.x + _fwd.x * 26, c.y + 1.60, c.z + _fwd.z * 26);

  } else {
    targetPos = new THREE.Vector3(c.x - _fwd.x * 2, c.y + 26, c.z - _fwd.z * 2);
    lookAt = new THREE.Vector3(c.x, c.y, c.z);
  }

  /* the orbit camera answers the mouse straight away, the others are damped */
  const k = (running && camMode === 0) ? (dragging ? 1 : Math.min(1, dt * 9)) : Math.min(1, dt * 4.5);
  if (!camReady) { camPos.copy(targetPos); camLook.copy(lookAt); camReady = true; }
  camPos.lerp(targetPos, k);
  camLook.lerp(lookAt, Math.min(1, dt * 7));

  /* the hard top glass is nearly opaque, so looking out through it from the
     driver seat would black out the view */
  if (!cabinGlass) cabinGlass = car.getObjectByName('Windows');
  if (cabinGlass) cabinGlass.visible = (camMode !== 2);

  /* a touch of extra lens as the speed climbs, which is most of what selling a sense of speed... */
  const wantFov = FOV + ((camMode === 1 || camMode === 2)
    ? clamp(Math.abs(drive.speed) - 8, 0, 24) * 0.42 : 0);
  perspCam.fov += (wantFov - perspCam.fov) * Math.min(1, dt * 2.5);
  perspCam.updateProjectionMatrix();

  /* both cameras ride the same transform, so P swaps only the projection */
  perspCam.position.copy(camPos); perspCam.up.copy(_up); perspCam.lookAt(camLook);
  orthoCam.position.copy(camPos); orthoCam.up.copy(_up); orthoCam.lookAt(camLook);
  syncOrthoFrustum(Math.max(camPos.distanceTo(camLook), 2));
}

/* drifting motes: dust in the sunlight, embers once it is dark */
let motes;
function buildMotes() {
  const N = 500, pos = new Float32Array(N * 3);
  const rand = rng(31337);
  for (let i = 0; i < N; i++) {
    pos[i * 3] = (rand() - 0.5) * 70;
    pos[i * 3 + 1] = rand() * 14;
    pos[i * 3 + 2] = (rand() - 0.5) * 70;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  motes = new THREE.Points(g, new THREE.PointsMaterial({
    map: TEX.glow, size: 0.34, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xffe0b0, opacity: 0.5, sizeAttenuation: true
  }));
  motes.frustumCulled = false;
  scene.add(motes);
}
function updateMotes(t) {
  motes.position.set(car.position.x, car.position.y, car.position.z);
  motes.rotation.y = t * 0.012;
  motes.material.color.setHex(dayFactor > 0.5 ? 0xffe0b0 : 0xffb060);
  motes.material.opacity = 0.22 + 0.3 * (1 - Math.abs(dayFactor - 0.5) * 2);
}

let clock, elapsed = 0, running = false;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  elapsed += dt;

  if (dayTween) {
    dayTween.t += dt;
    const p = clamp(dayTween.t / dayTween.dur, 0, 1);
    setDayPhase(lerp(dayTween.from, dayTween.to, p * p * (3 - 2 * p)));
    if (p >= 1) setDayTween(null);
  } else if (dayAuto) {
    setDayPhase(dayPhase + dt * 0.014);
  }

  updateSky();
  updateCar(dt);
  updateOrbitLamp(dt);
  updateLighting(dt);
  updateCamera(dt);
  updateMotes(elapsed);

  skyMat.uniforms.uTime.value = elapsed;
  grassMat.uniforms.uTime.value = elapsed;
  skyMesh.position.set(camera.position.x, 0, camera.position.z);
  updateShaderLights();

  renderer.render(scene, camera);
  if (running) updateHUD(dt);
}

// BOOT

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}

async function buildTextures() {
  step(14, 'mixing asphalt'); await nextFrame();
  TEX.asphalt = texAsphalt();
  TEX.gravel = texGravel();

  step(26, 'growing grass'); await nextFrame();
  TEX.grass = texGrass();
  TEX.dirt = texDirt();
  TEX.tuft = texTuft();

  step(38, 'spraying the paint'); await nextFrame();
  TEX.paint = texPaint('#f2f2f2');
  TEX.glass = texGlass();
  TEX.grille = texGrille();

  step(50, 'fitting the tyres'); await nextFrame();
  TEX.tyre = texTyre();
  TEX.rim = texRim();
  TEX.sidewall = texSidewall();

  step(60, 'rolling the steel'); await nextFrame();
  TEX.metalDark = texMetal('#3a3f47', 220);
  TEX.metalLight = texMetal('#9aa2ad', 260);
  TEX.concrete = texConcrete();

  step(70, 'planting trees'); await nextFrame();
  TEX.bark = texBark();
  TEX.leaf = texLeaf();
  TEX.rock = texRock();

  step(78, 'printing the signs'); await nextFrame();
  TEX.signLimit = texSignLimit(60);
  TEX.signBend = texSignBend();
  TEX.glow = texGlow();
  TEX.blob = texBlob();
  TEX.plate = texPlate('CG 4204');
}

async function boot() {
  if (!hasWebGL()) { UI('fatal').classList.remove('hidden'); return; }

  buildInfoTable();

  step(6, 'starting the renderer'); await nextFrame();
  initRenderer();

  await buildTextures();

  step(84, 'surveying the road'); await nextFrame();
  buildArcTable();
  buildSky();
  buildEnvironment();
  initLights();
  buildTerrain();

  step(90, 'laying the asphalt'); await nextFrame();
  buildRoad();
  buildGrassTufts();

  step(94, 'dressing the verge'); await nextFrame();
  buildScenery();
  buildStreetLamps();
  buildMarkerPosts();
  buildGuardRail();
  buildSigns();
  buildMotes();
  buildObstacleGrid();        // every solid prop is now registered, bucket them

  step(98, 'assembling the car'); await nextFrame();
  buildCar();
  initInteraction();

  step(100, 'ready');
  UI('enterTxt').textContent = 'Enter the scene';
  UI('enter').disabled = false;
  UI('enter').focus();

  clock = new THREE.Clock();
  updateSky();
  frame();
}

/* re-stamp the number plate with whatever was typed, then hand over control */
function enterScene() {
  const t = texPlate(TEAM[0].id);
  car.traverse(o => {
    if (o.isMesh && o.userData.part === 'Number plate') {
      o.material.map = t; o.material.needsUpdate = true;
    }
  });

  UI('start').classList.add('away');
  UI('hud').classList.add('on');
  running = true;
  setCamModeValue(0);
  camReady = false;
  setIntro({ t: 0, dur: 4.6 });

  /* the car rolls to a stop through the sweep, so the scene is alive on the way in but the... */
  drive.auto = true;
  drive.running = false;
}

/* called once the opening sweep finishes */
function onIntroDone() {
  drive.auto = false;
  drive.speed = 0;
  drive.steer = 0;
  drive.yaw = car.rotation.y;
  orbit.follow = true;
  orbit.auto = false;
  orbit.phi = INTRO_END.phi;
  orbit.dist = orbit.distGoal = INTRO_END.dist;
  orbit.theta = -car.rotation.y + Math.PI;
  toast('Engine running &mdash; <b>&uarr;</b> to pull away, <b>&larr; &rarr;</b> to steer, <b>M</b> for autopilot');
}

UI('enter').addEventListener('click', enterScene);
UI('infoClose').addEventListener('click', toggleInfo);
UI('info').addEventListener('click', e => { if (e.target === UI('info')) toggleInfo(); });

boot();

export { elapsed, toast, toggleInfo };
