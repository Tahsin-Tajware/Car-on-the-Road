import * as THREE from 'three';
import { UI } from './helpers.js';
import { orbit } from './interaction.js';

let renderer, scene, camera, perspCam, orthoCam;
let usingPerspective = true;
let FOV = 55; // Field of View

function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  UI('viewport').appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x9fb3c4, 0.0016);

  const aspect = window.innerWidth / window.innerHeight;
  perspCam = new THREE.PerspectiveCamera(FOV, aspect, 0.15, 2400);
  orthoCam = new THREE.OrthographicCamera(-20 * aspect, 20 * aspect, 20, -20, 0.15, 2400);
  camera = perspCam;
}

/* the orthographic frustum is sized from the perspective one at the current orbit distance, so... */
function syncOrthoFrustum(distance) {
  const aspect = window.innerWidth / window.innerHeight;
  const halfH = Math.tan(THREE.MathUtils.degToRad(FOV) * 0.5) * distance;
  const halfW = halfH * aspect;
  orthoCam.left = -halfW; orthoCam.right = halfW;
  orthoCam.top = halfH; orthoCam.bottom = -halfH;
  orthoCam.updateProjectionMatrix();
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h);
  perspCam.aspect = w / h;
  perspCam.updateProjectionMatrix();
  camera === orthoCam && syncOrthoFrustum(orbit.dist);
}

function setFOV(v) { FOV = v; }
function setProjection(p) {
  usingPerspective = p;
  camera = usingPerspective ? perspCam : orthoCam;
}

export { FOV, camera, initRenderer, onResize, orthoCam, perspCam, renderer, scene, setFOV, setProjection, syncOrthoFrustum, usingPerspective };
