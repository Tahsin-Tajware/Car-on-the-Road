import * as THREE from 'three';
import { TAU, clamp, lerp, smoothstep } from './helpers.js';
import { LAMP_ORBIT_R, dayFactor, headL, headR, lamp, lampAngle, lampAuto, lampBall, lampGlow, lampOn, lampPool, lampSpeed, lampTarget, setLampAngle, sun, sunDir } from './lighting.js';
import { LOOP_LENGTH, ROAD_HALF, SHOULDER, angleAtArc, groundHeight, loopHeight, loopRadius, nearbyObstacles, pathCurvature, pathPoint, pathTangent, streetLamps } from './world.js';
import { car, carBody, chassis, contactShadow, frontPivots, headLens, headlightGlow, reverseMats, tailMats, wheels } from './car.js';
import { keys } from './interaction.js';
import { elapsed, toast } from './main.js';



const drive = {
  distance: 0,        // metres travelled around the loop, used by the autopilot
  speed: 13.5,        // metres per second, negative while reversing
  target: 13.5,       // the autopilot's cruise speed
  auto: true,         // true while the car drives itself
  running: true,
  wheelSpin: 0,
  steer: 0,
  yaw: 0,             // heading, kept up to date in both modes
  roll: 0,
  pitch: 0,
  jolt: 0,            // decays after an impact, felt through the suspension
  stuck: 0,           // how long the car has been pinned against something
  braking: false
};

const WHEEL_R = 0.40;
const WHEELBASE = 2.45;      // front axle to rear axle, matching where they are placed
const MAX_SPEED = 32;        // about 115 km/h
const MIN_SPEED = 0;
const MAX_REVERSE = -6;
const MAX_STEER = 0.55;      // roughly 31 degrees of lock
const THROTTLE = 9.0;        // metres per second squared
const BRAKING = 17.0;
const ROLL_DRAG = 1.1;

const _cp = new THREE.Vector3(), _ct = new THREE.Vector3();

/* the frame time of the step being run, so resolveCollisions can measure how
   long the car has been pinned without being handed dt through every call */
let lastDt = 1 / 60;

/* the height of whatever the car is standing on: */
function surfaceHeight(x, z) {
  const r = Math.hypot(x, z);
  let a = Math.atan2(z, x); if (a < 0) a += TAU;
  const d = Math.abs(r - loopRadius(a));
  const onRoad = 1 - smoothstep(ROAD_HALF - 0.4, ROAD_HALF + SHOULDER + 1.6, d);
  return lerp(groundHeight(x, z), loopHeight(a) + 0.06, onRoad);
}

/* AUTOPILOT - the... */
function driveAuto(dt) {
  const prev = drive.speed;
  drive.speed += (drive.target * (drive.running ? 1 : 0) - drive.speed) * Math.min(1, dt * 1.6);
  if (drive.speed < 0.02) drive.speed = 0;

  drive.distance = (drive.distance + drive.speed * dt) % LOOP_LENGTH;
  const a = angleAtArc(drive.distance);

  pathPoint(a, _cp); pathTangent(a, _ct);
  car.position.copy(_cp);
  car.position.y += 0.07;
  drive.yaw = Math.atan2(_ct.x, _ct.z) - Math.PI / 2;
  car.rotation.y = drive.yaw;

  /* turn the front wheels by however hard the road is bending here */
  const steerTarget = clamp(-pathCurvature(a) * 2.6, -MAX_STEER, MAX_STEER);
  drive.steer += (steerTarget - drive.steer) * Math.min(1, dt * 5);

  return (drive.speed - prev) / Math.max(dt, 1e-4);
}

/* DRIVING BY HAND... */
function driveManual(dt) {
  const throttle = keys['arrowup'] ? 1 : 0;
  const brake = keys['arrowdown'] ? 1 : 0;
  const handbrake = keys[' '] ? 1 : 0;
  const steerIn = (keys['arrowleft'] ? 1 : 0) - (keys['arrowright'] ? 1 : 0);

  const prev = drive.speed;

  if (throttle) drive.speed += THROTTLE * dt;
  if (brake) {
    /* the pedal stops the car first and only then backs it up */
    drive.speed -= (drive.speed > 0.3 ? BRAKING : THROTTLE * 0.5) * dt;
  }
  if (handbrake) drive.speed -= Math.sign(drive.speed) * BRAKING * 1.5 * dt;
  if (!throttle && !brake && !handbrake) {
    const dragStep = (ROLL_DRAG + Math.abs(drive.speed) * 0.32) * dt;
    drive.speed -= Math.sign(drive.speed) * Math.min(Math.abs(drive.speed), dragStep);
  }
  drive.speed = clamp(drive.speed, MAX_REVERSE, MAX_SPEED);
  if (Math.abs(drive.speed) < 0.04 && !throttle && !brake) drive.speed = 0;

  /* less lock the faster it goes, which is what keeps it stable at speed */
  const lock = MAX_STEER * (1 - 0.55 * clamp(Math.abs(drive.speed) / MAX_SPEED, 0, 1));
  drive.steer += (steerIn * lock - drive.steer) * Math.min(1, dt * 6);

  drive.yaw += (drive.speed / WHEELBASE) * Math.tan(drive.steer) * dt;

  const fx = Math.cos(-drive.yaw), fz = Math.sin(-drive.yaw);
  car.position.x += fx * drive.speed * dt;
  car.position.z += fz * drive.speed * dt;

  /* the ground runs out eventually, so turn it back rather than let it fall off */
  const r = Math.hypot(car.position.x, car.position.z);
  if (r > 380) {
    car.position.x *= 380 / r;
    car.position.z *= 380 / r;
    drive.speed *= 0.35;
  }

  const force = resolveCollisions();
  if (force > 2.5) drive.jolt = Math.min(1, force / 14);

  car.position.y = surfaceHeight(car.position.x, car.position.z);
  car.rotation.y = drive.yaw;

  return (drive.speed - prev) / Math.max(dt, 1e-4);
}

/* ===========================================================================
   S10  COLLISION
   The car is three circles down its centre line, tested against the obstacle
   circles in the surrounding grid cells. Overlap is pushed apart along the line
   of centres; the speed lost depends on how square the hit was.
   =========================================================================== */
const CAR_R = 1.00;
const CAR_SAMPLES = [-1.30, 0, 1.30];
const _near = [];
let lastHitTime = -99;

/* shortest way round from one heading to another */
function angleLerp(a, b, t) {
  const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * t;
}

function resolveCollisions() {
  const fx = Math.cos(-drive.yaw), fz = Math.sin(-drive.yaw);
  const dirSign = drive.speed < 0 ? -1 : 1;
  const vx = fx * dirSign, vz = fz * dirSign;      // unit vector of travel

  let struck = null, worst = -1, nx = 0, nz = 0;

  for (const t of CAR_SAMPLES) {
    const px = car.position.x + fx * t, pz = car.position.z + fz * t;
    nearbyObstacles(px, pz, _near);

    for (const o of _near) {
      const dx = px - o.x, dz = pz - o.z;
      const reach = o.r + CAR_R;
      const d2 = dx * dx + dz * dz;
      if (d2 >= reach * reach) continue;

      const d = Math.sqrt(d2) || 0.0001;
      const ux = dx / d, uz = dz / d;               // out of the obstacle, toward the car

      /* separate them first: */
      car.position.x += ux * (reach - d);
      car.position.z += uz * (reach - d);

      const closing = -(vx * ux + vz * uz);         // positive when driving into it
      if (closing > worst) { worst = closing; struck = o; nx = ux; nz = uz; }
    }
  }

  /* touching something while already driving away from it is not an impact, and treating it as... */
  if (!struck || worst <= 0.01) { drive.stuck = 0; return 0; }

  /* If the car has been pinned against something for a moment, stop taking its speed away and... */
  drive.stuck += lastDt;
  if (drive.stuck > 0.7) {
    car.position.x += nx * 0.06;
    car.position.z += nz * 0.06;
    return 0;
  }

  /* Split the travel into the part heading into the surface and the part running along it */
  const tx = -nz, tz = nx;
  const dotT = vx * tx + vz * tz;
  const along = Math.abs(dotT);                     // 1 a clean graze, 0 square on
  const before = Math.abs(drive.speed);

  drive.speed *= lerp(0.08, 0.97, along);

  /* Swing the nose toward the way out, so a glancing hit deflects the car */
  if (along > 0.25) {
    const sgn = dotT < 0 ? -1 : 1;
    const slideX = tx * sgn * dirSign, slideZ = tz * sgn * dirSign;
    drive.yaw = angleLerp(drive.yaw, -Math.atan2(slideZ, slideX), 0.30 * along);
  }

  const force = before * (1 - along);
  if (force > 2.5 && elapsed - lastHitTime > 1.2) {
    lastHitTime = elapsed;
    toast(`Hit a <b>${struck.name.toLowerCase()}</b>`);
  }
  return force;
}

function updateCar(dt) {
  lastDt = dt;
  const accel = drive.auto ? driveAuto(dt) : driveManual(dt);
  drive.braking = accel < -1.2;

  /* wheels: one turn for every 2 pi r metres, exactly as in the real thing */
  const omega = drive.speed / WHEEL_R;
  drive.wheelSpin -= omega * dt;
  for (const w of wheels) w.rotation.z = drive.wheelSpin;
  for (const p of frontPivots) p.rotation.y = drive.steer;

  /* the body leans out of the bend and dips under braking */
  const yawRate = (drive.speed / WHEELBASE) * Math.tan(drive.steer);
  const rollTarget = clamp(yawRate * drive.speed * 0.028, -0.12, 0.12);
  drive.roll += (rollTarget - drive.roll) * Math.min(1, dt * 3.5);
  const pitchTarget = clamp(-accel * 0.010, -0.038, 0.038);
  drive.pitch += (pitchTarget - drive.pitch) * Math.min(1, dt * 6);
  carBody.rotation.x = drive.roll;
  carBody.rotation.z = drive.pitch;
  drive.jolt *= Math.max(0, 1 - dt * 3.2);
  carBody.position.y = Math.sin(drive.distance * 0.9 + elapsed) * 0.005
    + Math.sin(elapsed * 46) * drive.jolt * 0.055;
  carBody.rotation.z += Math.sin(elapsed * 38) * drive.jolt * 0.05;

  /* the chassis lies along the ground, worked out by sampling the surface a little ahead, behind... */
  const fx = Math.cos(-drive.yaw), fz = Math.sin(-drive.yaw);
  const rx = -fz, rz = fx;
  const px = car.position.x, pz = car.position.z;
  const hF = surfaceHeight(px + fx * 1.3, pz + fz * 1.3);
  const hB = surfaceHeight(px - fx * 1.3, pz - fz * 1.3);
  const hR = surfaceHeight(px + rx * 0.8, pz + rz * 0.8);
  const hL = surfaceHeight(px - rx * 0.8, pz - rz * 0.8);
  const slopePitch = clamp(Math.atan2(hF - hB, 2.6), -0.35, 0.35);
  const slopeRoll = clamp(Math.atan2(hR - hL, 1.6), -0.30, 0.30);
  chassis.rotation.z += (slopePitch - chassis.rotation.z) * Math.min(1, dt * 6);
  chassis.rotation.x += (-slopeRoll - chassis.rotation.x) * Math.min(1, dt * 6);

  /* brake lights */
  /* the tail lights only burn red under braking. Cruising leaves them dark by
     day and at a dim running-light level after dark, as a real car's are. */
  const onBrakes = drive.braking || keys['arrowdown'] || keys[' '];
  const glowAmount = onBrakes ? 4.6 : 0.04 + (1 - dayFactor) * 0.85;
  for (const m of tailMats) m.emissiveIntensity += (glowAmount - m.emissiveIntensity) * Math.min(1, dt * 10);

  /* white lamps while reversing */
  const revGlow = drive.speed < -0.15 ? 3.0 : 0.0;
  for (const m of reverseMats) m.emissiveIntensity += (revGlow - m.emissiveIntensity) * Math.min(1, dt * 10);

  /* contact shadow tracks the car and fades as the sun drops */
  contactShadow.position.set(car.position.x, car.position.y + 0.035, car.position.z);
  contactShadow.rotation.z = -car.rotation.y;
  contactShadow.material.opacity = 0.22 + 0.6 * dayFactor;
}

/* --- the lamp the brief asks for: its position rotates around the road ---
   The angle advances on its own timer, but a shift drag or a right button drag
   hands the angle to the mouse instead. See dragLamp in interaction.js.        */
function updateOrbitLamp(dt) {
  if (lampAuto) setLampAngle((lampAngle + dt * lampSpeed) % TAU);

  if (lampTarget === 'road') {
    /* a circle centred on the middle of the loop, at the loop's own radius, so the lamp sweeps... */
    const r = LAMP_ORBIT_R;
    lamp.position.set(
      Math.cos(lampAngle) * r,
      21 + Math.sin(lampAngle * 2) * 5.0,
      Math.sin(lampAngle) * r
    );
  } else {
    /* the same rotation, re-centred on the car */
    const r = 11;
    lamp.position.set(
      car.position.x + Math.cos(lampAngle) * r,
      car.position.y + 5.5 + Math.sin(lampAngle * 2) * 1.6,
      car.position.z + Math.sin(lampAngle) * r
    );
  }

  lamp.intensity = lampOn ? (lampTarget === 'road' ? 900 : 220) : 0;
  lampBall.position.copy(lamp.position);
  lampBall.visible = lampOn;
  lampGlow.position.copy(lamp.position);
  lampGlow.visible = lampOn;
  lampGlow.material.opacity = lampOn ? 0.9 : 0;
  const s = lampTarget === 'road' ? 13 : 8;
  lampGlow.scale.set(s, s, 1);
  lampBall.scale.setScalar(lampTarget === 'road' ? 1 : 0.45);
}

/* --- head lights, street lamps and the sun's shadow frustum --- */
let headlightsOn = false, headlightAuto = true;

function updateLighting(dt) {
  /* keep the shadow camera wrapped tightly around the car */
  sun.position.copy(car.position).addScaledVector(sunDir, 95);
  sun.target.position.copy(car.position);
  sun.target.updateMatrixWorld();

  const wantHead = headlightAuto ? dayFactor < 0.45 : headlightsOn;
  const k = Math.min(1, dt * 4);
  const targetInt = wantHead ? 280 : 0;
  headL.intensity += (targetInt - headL.intensity) * k;
  headL.castShadow = headL.intensity > 4;
  headR.intensity += (targetInt - headR.intensity) * k;
  headLens.emissiveIntensity += ((wantHead ? 2.6 : 0.05) - headLens.emissiveIntensity) * k;
  for (const g of headlightGlow) g.material.opacity += ((wantHead ? 0.85 : 0) - g.material.opacity) * k;

  /* street lamps light up at dusk; three real point lights follow the car */
  const nightAmount = 1 - dayFactor;
  for (const g of streetLamps) {
    g.userData.lens.material.emissiveIntensity = nightAmount * 3.4;
    g.userData.glow.material.opacity = nightAmount * 0.8;
  }
  const sorted = streetLamps
    .map(g => ({ g, d: g.userData.world.distanceToSquared(car.position) }))
    .sort((a, b) => a.d - b.d);
  for (let i = 0; i < lampPool.length; i++) {
    const s = sorted[i];
    lampPool[i].position.copy(s.g.userData.world);
    lampPool[i].intensity = nightAmount * 150;
  }
}

function setHeadlightsManual(on) { headlightAuto = false; headlightsOn = on; }

export { MAX_SPEED, MIN_SPEED, WHEEL_R, angleLerp, drive, headlightsOn, setHeadlightsManual, updateCar, updateLighting, updateOrbitLamp };
