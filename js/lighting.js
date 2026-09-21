import * as THREE from 'three';
import { TAU, lerp, smoothstep } from './helpers.js';
import { TEX, canvas2d } from './textures.js';
import { SHADED } from './shaders.js';
import { camera, renderer, scene } from './renderer.js';
import { skyMat } from './world.js';


let ambient, hemi, sun, lamp, lampBall, lampGlow;
let headL, headR;
const lampPool = [];
const LAMP_ORBIT_R = 118;         // matches the mean radius of the road loop
let lampAngle = 0, lampSpeed = 0.19, lampOn = true, lampShadows = false;
let lampTarget = 'road';          // 'road' circles the loop, 'car' circles the car
let lampAuto = true;              // false once the mouse takes hold of the lamp

/* Metal with nothing to reflect comes out almost black, so the scene gets a small pre-filtered... */
function buildEnvironment() {
  const [c, g] = canvas2d(128, 128);
  const grd = g.createLinearGradient(0, 0, 0, 128);
  grd.addColorStop(0.00, '#3f79bf');
  grd.addColorStop(0.42, '#b6cee6');
  grd.addColorStop(0.52, '#e0d0ae');
  grd.addColorStop(0.62, '#8d9166');
  grd.addColorStop(1.00, '#43483a');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);

  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromEquirectangular(t).texture;
  if ('environmentIntensity' in scene) scene.environmentIntensity = 0.55;
  pmrem.dispose();
  t.dispose();
}

function initLights() {
  ambient = new THREE.AmbientLight(0x9db4cc, 0.55);
  scene.add(ambient);

  hemi = new THREE.HemisphereLight(0xbcd6f0, 0x4a5236, 0.62);
  scene.add(hemi);

  sun = new THREE.DirectionalLight(0xffe6bd, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 260;
  sun.shadow.camera.left = -54; sun.shadow.camera.right = 54;
  sun.shadow.camera.top = 54; sun.shadow.camera.bottom = -54;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.34;
  scene.add(sun);
  scene.add(sun.target);

  /* --- the light the brief asks for: its position rotates around the road --- */
  lamp = new THREE.PointLight(0xffc270, 800, 200, 2.0);
  scene.add(lamp);

  lampBall = new THREE.Mesh(
    new THREE.SphereGeometry(1.15, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xfff0cf, fog: false })
  );
  scene.add(lampBall);

  lampGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: TEX.glow, color: 0xffcf8a, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false
  }));
  lampGlow.scale.set(13, 13, 1);
  scene.add(lampGlow);

  /* five spare point lights handed to the closest street lamps at night */
  for (let i = 0; i < 5; i++) {
    const p = new THREE.PointLight(0xffd39a, 0, 58, 1.8);
    scene.add(p);
    lampPool.push(p);
  }
}

/* the sun rides a tilted arc; everything else in the scene follows from it */
let dayPhase = 0.30;              // 0 sunrise · 0.25 noon · 0.5 sunset · 0.75 midnight
let dayAuto = false;
const sunDir = new THREE.Vector3();
let dayFactor = 1;

const C_DAWN = new THREE.Color(0xff9a4d);
const C_NOON = new THREE.Color(0xfff3d6);
const C_NIGHT = new THREE.Color(0x9fb6e6);
const FOG_DAY = new THREE.Color(0xa8bccd);
const FOG_DUSK = new THREE.Color(0xc38a63);
const FOG_NIGHT = new THREE.Color(0x1d2740);
const SKY_ZEN_DAY = new THREE.Color(0x2e6fc4);
const SKY_ZEN_NIGHT = new THREE.Color(0x07101f);
const SKY_HOR_DAY = new THREE.Color(0xdfe8ee);
const SKY_HOR_DUSK = new THREE.Color(0xf59a4a);
const SKY_HOR_NIGHT = new THREE.Color(0x18243b);

const _sunColor = new THREE.Color();
const _fogColor = new THREE.Color();
const _skyTint = new THREE.Color();
const _ambColor = new THREE.Color();
const _hemiFill = new THREE.Color();

function updateSky() {
  const a = dayPhase * TAU;
  sunDir.set(Math.cos(a), Math.sin(a) * 0.94, 0.36).normalize();

  dayFactor = smoothstep(-0.10, 0.20, sunDir.y);
  const duskFactor = 1.0 - smoothstep(0.0, 0.34, Math.abs(sunDir.y));   // 1 near the horizon

  /* sun colour swings from ember at the horizon to white overhead, then to a cold moon once it... */
  _sunColor.copy(C_DAWN).lerp(C_NOON, smoothstep(0.02, 0.42, sunDir.y));
  _sunColor.lerp(C_NIGHT, 1 - dayFactor);
  sun.color.copy(_sunColor);
  sun.intensity = lerp(0.85, 3.1, dayFactor);      // a generous moon

  _ambColor.setRGB(0.10, 0.13, 0.22).lerp(new THREE.Color(0.62, 0.68, 0.78), dayFactor);
  ambient.color.copy(_ambColor);
  ambient.intensity = lerp(0.42, 0.62, dayFactor);

  hemi.intensity = lerp(0.14, 0.70, dayFactor);
  if ('environmentIntensity' in scene) scene.environmentIntensity = lerp(0.06, 0.55, dayFactor);
  hemi.color.setRGB(0.20, 0.28, 0.46).lerp(new THREE.Color(0.74, 0.85, 0.98), dayFactor);

  _fogColor.copy(FOG_NIGHT).lerp(FOG_DAY, dayFactor).lerp(FOG_DUSK, duskFactor * dayFactor * 0.85);
  scene.fog.color.copy(_fogColor);
  scene.fog.density = lerp(0.0016, 0.0013, dayFactor);
  renderer.setClearColor(_fogColor);

  _skyTint.copy(SKY_ZEN_NIGHT).lerp(SKY_ZEN_DAY, dayFactor);

  if (skyMat) {
    skyMat.uniforms.uSunDir.value.copy(sunDir);
    skyMat.uniforms.uDay.value = dayFactor;
    skyMat.uniforms.uZenith.value.copy(SKY_ZEN_NIGHT).lerp(SKY_ZEN_DAY, dayFactor);
    skyMat.uniforms.uHorizon.value.copy(SKY_HOR_NIGHT)
      .lerp(SKY_HOR_DAY, dayFactor).lerp(SKY_HOR_DUSK, duskFactor * dayFactor);
    skyMat.uniforms.uGround.value.copy(_fogColor);
  }
}

/* push the current lighting state into every hand-written shader */
function updateShaderLights() {
  for (const m of SHADED) {
    const u = m.uniforms;
    u.uSunDir.value.copy(sunDir);
    u.uSunColor.value.copy(sun.color);
    u.uSunPower.value = sun.intensity * 0.34;
    u.uLampPos.value.copy(lamp.position);
    u.uLampColor.value.copy(lamp.color);
    /* the lamp passes directly over the road, so a few metres from the car at its closest */
    u.uLampPower.value = lampOn ? 4.0 : 0;
    _hemiFill.copy(hemi.color).multiplyScalar(hemi.intensity * 0.16);
    u.uAmbient.value.copy(ambient.color).multiplyScalar(ambient.intensity * 0.62).add(_hemiFill);
    u.uSkyTint.value.copy(_skyTint);
    u.uCamPos.value.copy(camera.position);
    u.uFogColor.value.copy(scene.fog.color);
    u.uFogDensity.value = scene.fog.density;
  }
}

/* the car, the driving loop and the key handler reach the lights through these */
function setHeadlights(l, r) { headL = l; headR = r; }
function setLampAngle(v) { lampAngle = v; }
function setLampOn(v) { lampOn = v; }
function setLampShadows(v) { lampShadows = v; }
function setLampTarget(v) { lampTarget = v; }
function setLampAuto(v) { lampAuto = v; }
function setDayAuto(v) { dayAuto = v; }
function setDayPhase(v) { dayPhase = v; }

export { LAMP_ORBIT_R, buildEnvironment, dayAuto, dayFactor, dayPhase, headL, headR, initLights, lamp, lampAngle, lampAuto, lampBall, lampGlow, lampOn, lampPool, lampShadows, lampSpeed, lampTarget, setDayAuto, setDayPhase, setHeadlights, setLampAngle, setLampAuto, setLampOn, setLampShadows, setLampTarget, sun, sunDir, updateShaderLights, updateSky };
