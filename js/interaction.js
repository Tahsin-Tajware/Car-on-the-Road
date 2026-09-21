import * as THREE from 'three';
import { TAU, UI, clamp } from './helpers.js';
import { FOV, camera, onResize, renderer, scene, setFOV, setProjection, usingPerspective } from './renderer.js';
import { dayAuto, dayPhase, lamp, lampAngle, lampAuto, lampOn, lampShadows, lampTarget, setDayAuto, setLampAngle, setLampAuto, setLampOn, setLampShadows, setLampTarget, sun } from './lighting.js';
import { arcAt, roadMesh, skyMesh, terrain } from './world.js';
import { car, chassis, contactShadow, cyclePaint } from './car.js';
import { MAX_SPEED, MIN_SPEED, drive, headlightsOn, setHeadlightsManual } from './driving.js';
import { toast, toggleInfo } from './main.js';



const orbit = {
  theta: 2.2,          // angle around the car
  phi: 1.12,           // angle down from straight up
  dist: 27,            // the title card opens wide, then eases in on entry
  distGoal: 27,
  auto: false,
  autoSpeed: 0.16,
  follow: true         // hold the camera behind the car until the mouse says otherwise
};

/* the opening move: a scripted sweep that settles into the standard framing */
let intro = null;
const INTRO_KEYS = [
  { t: 0.00, dTheta: 2.20, phi: 1.46, dist: 6.4, lift: 0.30 },
  { t: 0.42, dTheta: 4.05, phi: 1.26, dist: 9.2, lift: 1.10 },
  { t: 1.00, dTheta: Math.PI, phi: 1.03, dist: 14.5, lift: 2.10 }
];
const INTRO_END = INTRO_KEYS[INTRO_KEYS.length - 1];

const CAM_MODES = ['Orbit', 'Chase', 'Driver', 'Overhead'];
let camMode = 0;

let dragging = false, dragMoved = 0;
let lampDrag = false;            // true while the drag is steering the light
const pointers = new Map();
let pinchStart = 0, pinchDist = 0;

/* how far the light swings per pixel of mouse travel */
const LAMP_DRAG_RATE = 0.006;

function initInteraction() {
  const el = renderer.domElement;
  el.style.touchAction = 'none';

  el.addEventListener('pointerdown', e => {
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragging = true; dragMoved = 0;
      /* shift, or the right button, means the drag belongs to the light rather
         than to the camera, so the camera is left exactly where it was */
      lampDrag = e.shiftKey || e.button === 2;
      if (lampDrag) {
        setLampAuto(false);
        if (!lampOn) setLampOn(true);          // otherwise the drag does nothing visible
        toast('Light <b>on the mouse</b> &mdash; drag to rotate it around the road, <b>J</b> to let it circle on its own');
      } else {
        orbit.auto = false; orbit.follow = false; intro = null;
      }
    }
    if (pointers.size === 2) {
      const p = [...pointers.values()];
      pinchStart = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      pinchDist = orbit.distGoal;
    }
  });

  el.addEventListener('pointermove', e => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    prev.x = e.clientX; prev.y = e.clientY;

    if (pointers.size === 2) {
      const p = [...pointers.values()];
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (pinchStart > 0) orbit.distGoal = clamp(pinchDist * (pinchStart / Math.max(d, 1)), 4.5, 90);
      return;
    }
    if (!dragging) return;
    dragMoved += Math.abs(dx) + Math.abs(dy);

    /* the mouse interaction the brief asks for: the light rotates around the
       road. Horizontal travel walks the orbit angle, vertical travel is left
       to the lamp's own height curve. */
    if (lampDrag) {
      setLampAngle(((lampAngle - dx * LAMP_DRAG_RATE) % TAU + TAU) % TAU);
      return;
    }

    orbit.theta -= dx * 0.0055;
    orbit.phi = clamp(orbit.phi - dy * 0.0045, 0.16, 1.52);
  });

  const release = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = 0;
    if (pointers.size === 0) {
      if (dragging && !lampDrag && dragMoved < 6) pickPart(e);
      dragging = false;
      lampDrag = false;
    }
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);

  /* a right button drag is a lamp drag, so the browser menu has to stay shut */
  el.addEventListener('contextmenu', e => e.preventDefault());

  el.addEventListener('wheel', e => {
    e.preventDefault();
    orbit.distGoal = clamp(orbit.distGoal * (1 + Math.sign(e.deltaY) * 0.09), 4.5, 90);
  }, { passive: false });

  /* onKey handles the one-shot commands */
  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement) return;
    keys[e.key.toLowerCase()] = true;
  });
  window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

  window.addEventListener('keydown', onKey);
  window.addEventListener('resize', onResize);

  /* on-screen buttons for phones, which have no keyboard */
  if (matchMedia('(pointer: coarse)').matches) {
    UI('touch').classList.remove('hidden');
    const hold = (id, key) => {
      const b = UI(id);
      const down = e => { e.preventDefault(); takeTheWheel(); keys[key] = true; };
      const up = e => { e.preventDefault(); keys[key] = false; };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', up);
      b.addEventListener('pointercancel', up);
    };
    hold('tbLeft', 'arrowleft');
    hold('tbRight', 'arrowright');
    hold('tbGas', 'arrowup');
    hold('tbBrake', 'arrowdown');
    UI('tbCam').onclick = () => setCamMode((camMode + 1) % CAM_MODES.length);
    UI('tbNight').onclick = () => toggleNight();
  }
}

/* --- click to identify a part, using a ray cast from the pointer --- */
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function pickPart(e) {
  ndc.x = (e.clientX / window.innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(car, true);
  if (hits.length) {
    const name = hits[0].object.userData.part || hits[0].object.name || 'Car body';
    toast(`<b>${name}</b> &nbsp; ${hits[0].distance.toFixed(1)} m from the camera`);
  } else {
    const road = raycaster.intersectObjects([roadMesh, terrain], false);
    if (road.length) toast(`<b>${road[0].object.name}</b>`);
  }
}

/* --- keyboard: onKey handles the one-shot commands, the `keys` map below
   holds the keys that are read every frame while they are held down --- */
function onKey(e) {
  if (e.target instanceof HTMLInputElement) return;
  const k = e.key.toLowerCase();

  if (k === 'i' || k === 'tab') { e.preventDefault(); toggleInfo(); return; }
  if (UI('info').classList.contains('on') && k === 'escape') { toggleInfo(); return; }

  switch (k) {
    case '1': case '2': case '3': case '4':
      setCamMode(+k - 1); break;
    case 'c': setCamMode((camMode + 1) % CAM_MODES.length); break;

    /* --- the keyboard interaction the brief asks for: the camera moves around
       the car. The keys are held rather than tapped, so the actual stepping is
       done in updateCamera; this only makes sure the orbit camera is the one
       being flown and that it has stopped following the car by itself. --- */
    case 'q': case 'e': case ',': case '.':
      if (camMode !== 0) { setCamModeValue(0); toast('Camera <b>orbit</b>'); }
      orbit.follow = false; orbit.auto = false; intro = null;
      break;
    case '-': case '_':
      orbit.distGoal = clamp(orbit.distGoal * 1.12, 4.5, 90);
      toast(`Camera <b>${orbit.distGoal.toFixed(1)} m</b> from the car`);
      break;
    case '=': case '+':
      orbit.distGoal = clamp(orbit.distGoal * 0.89, 4.5, 90);
      toast(`Camera <b>${orbit.distGoal.toFixed(1)} m</b> from the car`);
      break;
    case 'j':
      setLampAuto(!lampAuto);
      toast(lampAuto
        ? 'Light <b>circling</b> the road on its own'
        : 'Light <b>held</b> &mdash; shift drag to rotate it by hand');
      break;
    case 'arrowleft': case 'arrowright':
      e.preventDefault();
      if (drive.auto) takeTheWheel();          // steering means you want to drive
      break;
    case 'arrowup': case 'arrowdown':
      e.preventDefault();
      if (drive.auto) setSpeed(drive.target + (k === 'arrowup' ? 3 : -3));
      break;
    case 'm':
      drive.auto ? takeTheWheel() : rejoinRoad();
      break;
    case ' ':
      e.preventDefault();
      if (drive.auto) {
        drive.running = !drive.running;
        toast(drive.running ? 'Driving' : '<b>Stopped</b>');
      }
      break;
    case 'p':
      setProjection(!usingPerspective);
      toast(usingPerspective
        ? 'Projection <b>perspective</b> &mdash; the road edges converge'
        : 'Projection <b>orthographic</b> &mdash; parallel lines stay parallel');
      break;
    case '[': setFOV(clamp(FOV - 4, 18, 96)); toast(`Field of view <b>${FOV}&deg;</b>`); break;
    case ']': setFOV(clamp(FOV + 4, 18, 96)); toast(`Field of view <b>${FOV}&deg;</b>`); break;
    case 'n': toggleNight(); break;
    case 't':
      setDayAuto(!dayAuto); dayTween = null;
      toast(dayAuto ? 'Sun <b>moving</b>' : 'Sun <b>held</b>');
      break;
    case 'l':
      setLampOn(!lampOn);
      toast(lampOn ? 'Orbiting lamp <b>on</b>' : 'Orbiting lamp <b>off</b>');
      break;
    case 'o':
      setLampTarget(lampTarget === 'road' ? 'car' : 'road');
      toast(`Lamp rotates around the <b>${lampTarget}</b>`);
      break;
    case 'k':
      setLampShadows(!lampShadows);
      lamp.castShadow = lampShadows;
      if (lampShadows) { lamp.shadow.mapSize.set(512, 512); lamp.shadow.bias = -0.004; }
      toast(lampShadows ? 'Lamp casts <b>shadows</b>' : 'Lamp shadows off');
      break;
    case 'h':
      setHeadlightsManual(!headlightsOn);
      toast(headlightsOn ? 'Head lights <b>on</b>' : 'Head lights <b>off</b>');
      break;
    case 'x': cyclePaint(); break;
    case 'w': toggleWireframe(); break;
    case 'g': toggleHelpers(); break;
    case 'r':
      drive.distance = 0; drive.auto = true; drive.speed = 13.5;
      setSpeed(13.5); drive.running = true;
      orbit.phi = INTRO_END.phi; orbit.distGoal = INTRO_END.dist;
      orbit.follow = true; orbit.auto = false;
      toast('Scene reset');
      break;
    case 'a':
      orbit.auto = !orbit.auto;
      if (orbit.auto) orbit.follow = false;
      toast(orbit.auto ? 'Camera <b>circling</b> the car' : 'Camera held behind the car');
      break;
  }
}

const keys = {};

/* hand control of the car to the player */
function takeTheWheel() {
  if (!drive.auto) return;
  drive.auto = false;
  drive.yaw = car.rotation.y;
  toast('You have the wheel &mdash; <b>&larr; &rarr;</b> steer, <b>&uarr;</b> throttle, <b>&darr;</b> brake and reverse, <b>M</b> to hand it back');
}

/* put the car back on the nearest point of the loop and let it drive itself */
function rejoinRoad() {
  drive.auto = true;
  drive.running = true;
  let a = Math.atan2(car.position.z, car.position.x); if (a < 0) a += TAU;
  drive.distance = arcAt(a);
  drive.target = clamp(Math.abs(drive.speed), 8, MAX_SPEED);
  chassis.rotation.set(0, 0, 0);
  toast('Autopilot <b>on</b> &mdash; the car follows the road again');
}

function setSpeed(v) {
  drive.target = clamp(v, MIN_SPEED, MAX_SPEED);
  toast(`Speed <b>${Math.round(drive.target * 3.6)} km/h</b>`);
}
function setCamMode(i) {
  camMode = i;
  if (i === 0) { orbit.follow = true; orbit.auto = false; orbit.phi = INTRO_END.phi; orbit.distGoal = INTRO_END.dist; }
  toast(`Camera <b>${CAM_MODES[i].toLowerCase()}</b>`);
}

let dayTween = null;
function toggleNight() {
  const now = ((dayPhase % 1) + 1) % 1;
  const goal = (now > 0.12 && now < 0.55) ? 0.80 : 0.22;
  let delta = (goal - now + 1) % 1;
  if (delta < 0.02) delta += 1;
  dayTween = { from: dayPhase, to: dayPhase + delta, t: 0, dur: 3.0 };
  setDayAuto(false);
  toast(goal > 0.5 ? 'Moving the sun to <b>night</b>' : 'Moving the sun to <b>day</b>');
}

let wireOn = false;
function toggleWireframe() {
  wireOn = !wireOn;
  scene.traverse(o => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (o === skyMesh || o === contactShadow) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) if (m && 'wireframe' in m) m.wireframe = wireOn;
  });
  toast(wireOn ? '<b>Wireframe</b> &mdash; every surface is triangles' : 'Solid shading');
}

let helpers = null, helpersOn = false;
function toggleHelpers() {
  if (!helpers) {
    helpers = new THREE.Group();
    helpers.add(new THREE.DirectionalLightHelper(sun, 6, 0xffd27a));
    helpers.add(new THREE.PointLightHelper(lamp, 2.2, 0xff9a3c));
    helpers.add(new THREE.CameraHelper(sun.shadow.camera));
    helpers.add(new THREE.AxesHelper(6));
    scene.add(helpers);
  }
  helpersOn = !helpersOn;
  helpers.visible = helpersOn;
  toast(helpersOn ? '<b>Light helpers</b> visible' : 'Helpers hidden');
}

function setCamModeValue(i) { camMode = i; }
function setDayTween(v) { dayTween = v; }
function setIntro(v) { intro = v; }

export { CAM_MODES, INTRO_END, INTRO_KEYS, camMode, dayTween, dragging, initInteraction, intro, keys, orbit, setCamModeValue, setDayTween, setIntro };
