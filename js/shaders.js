import * as THREE from 'three';


const GLSL_NOISE = `
float hash21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i),            hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++){ v += a * vnoise(p); p *= 2.07; a *= 0.5; }
  return v;
}`;


const GLSL_LIGHT_UNIFORMS = `
uniform vec3  uSunDir;      
uniform vec3  uSunColor;
uniform float uSunPower;
uniform vec3  uLampPos;     
uniform vec3  uLampColor;
uniform float uLampPower;
uniform vec3  uAmbient;
uniform vec3  uSkyTint;
uniform vec3  uCamPos;
uniform vec3  uFogColor;
uniform float uFogDensity;`;

const GLSL_FOG = `
vec3 addFog(vec3 col, float dist){
  float f = 1.0 - exp(-uFogDensity * uFogDensity * dist * dist);
  return mix(col, uFogColor, clamp(f, 0.0, 1.0));
}`;

/* every material built here is registered so the light uniforms stay in sync */
const SHADED = [];
function registerShaded(mat) { SHADED.push(mat); return mat; }

function lightUniformBlock() {
  return {
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
    uSunColor: { value: new THREE.Color(1, 0.92, 0.78) },
    uSunPower: { value: 2.4 },
    uLampPos: { value: new THREE.Vector3(0, 20, 0) },
    uLampColor: { value: new THREE.Color(1, 0.78, 0.42) },
    uLampPower: { value: 60 },
    uAmbient: { value: new THREE.Color(0.30, 0.34, 0.42) },
    uSkyTint: { value: new THREE.Color(0.42, 0.55, 0.72) },
    uCamPos: { value: new THREE.Vector3() },
    uFogColor: { value: new THREE.Color(0.62, 0.70, 0.79) },
    uFogDensity: { value: 0.0016 }
  };
}

/* SKY — a sphere... */
function makeSkyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3) },
      uDay: { value: 1 },
      uHorizon: { value: new THREE.Color(0.94, 0.72, 0.48) },
      uZenith: { value: new THREE.Color(0.24, 0.44, 0.78) },
      uGround: { value: new THREE.Color(0.30, 0.32, 0.28) }
    },
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      precision highp float;
      varying vec3 vDir;
      uniform float uTime, uDay;
      uniform vec3  uSunDir, uHorizon, uZenith, uGround;
      ${GLSL_NOISE}
      void main(){
        vec3 d = normalize(vDir);
        float h = d.y;

        /* three stops rather than two: */
        vec3 mid = mix(uHorizon, uZenith, 0.42) * vec3(1.03, 1.0, 1.02);
        float t = smoothstep(-0.06, 0.62, h);
        vec3 col = h < 0.24
          ? mix(uHorizon, mid, smoothstep(-0.06, 0.24, h))
          : mix(mid, uZenith, smoothstep(0.24, 0.78, h));
        col = mix(uGround, col, smoothstep(-0.16, 0.008, h));

        /* the sun warms the whole sky around it, not just its own disc */
        float around = max(dot(d, normalize(uSunDir)), 0.0);
        col += uHorizon * pow(around, 4.0) * 0.16 * uDay;

        /* sun disc plus the wide bloom around it */
        float sd = max(dot(d, normalize(uSunDir)), 0.0);
        col += uHorizon * pow(sd, 26.0) * 0.85 * uDay;
        col += vec3(1.0, 0.94, 0.80) * smoothstep(0.9985, 0.99965, sd) * 9.0;

        /* stars, only while the sun is down */
        if (h > 0.0) {
          vec2 sp = d.xz / max(h + 0.28, 0.05) * 26.0;
          float st = pow(hash21(floor(sp * 3.0)), 96.0);
          col += vec3(0.86, 0.90, 1.0) * st * (1.0 - uDay) * 2.2;
        }

        /* cloud sheet projected onto the dome, drifting on the wind */
        if (h > 0.02) {
          vec2 cp = d.xz / (h + 0.14) * 0.9 + vec2(uTime * 0.0075, uTime * 0.0034);
          float c = fbm(cp * 1.35);
          c = smoothstep(0.50, 0.86, c) * smoothstep(0.02, 0.30, h);
          vec3 lit = mix(vec3(0.55, 0.58, 0.66), vec3(1.0, 0.95, 0.88), uDay);
          vec3 shade = mix(vec3(0.20, 0.23, 0.30), vec3(0.62, 0.60, 0.64), uDay);
          col = mix(col, mix(shade, lit, pow(sd, 3.0) * 0.6 + 0.45), c * 0.82);
        }

        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  });
}

/* CAR PAINT —... */
function makePaintMaterial(map, tint, clearcoat, flake) {
  return registerShaded(new THREE.ShaderMaterial({
    uniforms: Object.assign(lightUniformBlock(), {
      map: { value: map },
      uTint: { value: new THREE.Color(tint) },
      uClear: { value: clearcoat === undefined ? 1.0 : clearcoat },
      uFlake: { value: flake === undefined ? 0.35 : flake }
    }),
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vWP;
      void main(){
        vUv = uv;
        vN  = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv; varying vec3 vN; varying vec3 vWP;
      uniform sampler2D map;
      uniform vec3 uTint; uniform float uClear, uFlake;
      ${GLSL_LIGHT_UNIFORMS}
      ${GLSL_NOISE}
      ${GLSL_FOG}
      void main(){
        vec3 N = normalize(vN);
        vec3 V = normalize(uCamPos - vWP);
        /* the flake is already in the texture; sampling it in surface coordinates keeps it stable... */
        /* the speckle already in the bitmap is what reads as metallic flake once it is multiplied... */
        vec3 base = texture2D(map, vUv * 3.0).rgb * uTint;

        vec3 col = base * uAmbient;

        /* key light: the sun */
        vec3 L = normalize(uSunDir);
        float ndl = max(dot(N, L), 0.0);
        vec3  H = normalize(L + V);
        float sp = pow(max(dot(N, H), 0.0), 96.0);
        col += uSunColor * uSunPower * (base * ndl + vec3(sp) * uClear * ndl * 0.85);

        /* the lamp circling the road */
        vec3 Lv = uLampPos - vWP;
        float dist = length(Lv);
        Lv /= max(dist, 0.001);
        float att = uLampPower / (1.0 + 0.05 * dist + 0.006 * dist * dist);
        float ndl2 = max(dot(N, Lv), 0.0);
        vec3  H2 = normalize(Lv + V);
        col += uLampColor * att * (base * ndl2 + vec3(pow(max(dot(N, H2), 0.0), 70.0)) * uClear * ndl2);

        /* the sky reflected in the clear coat, strongest at the silhouette */
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        col += uSkyTint * fres * uClear * 0.30;
        col += uSkyTint * max(N.y, 0.0) * 0.06;

        col = addFog(col, length(uCamPos - vWP));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  }));
}

/* GLASS —... */
function makeGlassMaterial(map) {
  return registerShaded(new THREE.ShaderMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
    uniforms: Object.assign(lightUniformBlock(), { map: { value: map } }),
    vertexShader: `
      varying vec2 vUv; varying vec3 vN; varying vec3 vWP;
      void main(){
        vUv = uv;
        vN  = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWP = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv; varying vec3 vN; varying vec3 vWP;
      uniform sampler2D map;
      ${GLSL_LIGHT_UNIFORMS}
      ${GLSL_FOG}
      void main(){
        vec3 N = normalize(vN);
        vec3 V = normalize(uCamPos - vWP);
        if (dot(N, V) < 0.0) N = -N;

        float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
        vec3 tintCol = texture2D(map, vUv).rgb;

        vec3 col = tintCol * (uAmbient + uSunColor * uSunPower * 0.10);
        col += uSkyTint * fres * 0.85;

        vec3 L = normalize(uSunDir);
        vec3 H = normalize(L + V);
        col += uSunColor * pow(max(dot(N, H), 0.0), 220.0) * 2.6;

        vec3 Lv = normalize(uLampPos - vWP);
        vec3 H2 = normalize(Lv + V);
        col += uLampColor * pow(max(dot(N, H2), 0.0), 180.0) * 1.4;

        float alpha = clamp(0.74 + fres * 0.24, 0.0, 0.98);
        col = addFog(col, length(uCamPos - vWP));
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  }));
}

/* GRASS — instanced... */
function makeGrassMaterial(map) {
  return registerShaded(new THREE.ShaderMaterial({
    transparent: false, side: THREE.DoubleSide, alphaTest: 0.4,
    uniforms: Object.assign(lightUniformBlock(), {
      map: { value: map }, uTime: { value: 0 }, uWind: { value: 0.42 }
    }),
    vertexShader: `
      varying vec2 vUv; varying vec3 vWP; varying vec3 vN;
      uniform float uTime, uWind;
      void main(){
        vUv = uv;
        vec3 p = position;
        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);

        /* uv.y is 0 at the root and 1 at the tip, so the bend grows upward */
        float bend = pow(uv.y, 1.7) * uWind;
        float w = sin(uTime * 1.9 + wp.x * 0.22 + wp.z * 0.17)  
                + 0.45 * sin(uTime * 4.3 + wp.x * 0.55);
        wp.x += w * bend * 0.34;
        wp.z += w * bend * 0.20;

        vWP = wp.xyz;
        vN  = normalize(mat3(modelMatrix) * vec3(0.0, 1.0, 0.0));
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv; varying vec3 vWP; varying vec3 vN;
      uniform sampler2D map;
      ${GLSL_LIGHT_UNIFORMS}
      ${GLSL_FOG}
      void main(){
        vec4 t = texture2D(map, vUv);
        if (t.a < 0.4) discard;

        vec3 N = normalize(vN);
        float ndl = max(dot(N, normalize(uSunDir)), 0.0) * 0.55 + 0.45;
        vec3 col = t.rgb * (uAmbient + uSunColor * uSunPower * ndl * 0.78);

        /* light passing through the blade from behind */
        float back = max(dot(-N, normalize(uSunDir)), 0.0);
        col += t.rgb * uSunColor * back * 0.30 * uSunPower;

        vec3 Lv = uLampPos - vWP;
        float d = length(Lv);
        col += t.rgb * uLampColor * (uLampPower / (1.0 + 0.06 * d + 0.01 * d * d)) * 0.6;

        col = addFog(col, length(uCamPos - vWP));
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`
  }));
}

/* ROAD SURFACE —... */
function attachRoadShader(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWet = { value: 0.0 };
    mat.userData.shader = shader;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        float gLine = 0.0;
        uniform float uWet;
        ${GLSL_NOISE}`)
      .replace('#include <map_fragment>', `
        /* The surface coordinates run 0 to 1 across the width and one unit per dash pitch along the length */
        float coarse = texture2D(map, vMapUv * vec2(0.83, 0.29) + vec2(0.31, 0.67)).r;
        diffuseColor.rgb *= texture2D(map, vMapUv * vec2(3.0, 3.0)).rgb * (0.74 + 1.05 * coarse);
        {
          float u = vMapUv.x;                 // 0 at the left kerb, 1 at the right
          float v = vMapUv.y;                 // one unit for every dash pitch

          /* two solid edge lines */
          float line  = 1.0 - smoothstep(0.008, 0.016, abs(u - 0.062));
          line += 1.0 - smoothstep(0.008, 0.016, abs(u - 0.938));

          /* broken centre line, painted for the first 42% of every pitch */
          float dash = step(fract(v), 0.42);
          line += (1.0 - smoothstep(0.007, 0.014, abs(u - 0.5))) * dash;
          gLine = clamp(line, 0.0, 1.0);

          /* the paint is scuffed where traffic runs over it */
          float wear = 0.68 + 0.32 * fbm(vMapUv * vec2(6.0, 40.0));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.88, 0.82) * wear, gLine * 0.94);

          /* darker ribbons in the two wheel tracks */
          float tl = 1.0 - smoothstep(0.0, 0.11, abs(u - 0.30));
          float tr = 1.0 - smoothstep(0.0, 0.11, abs(u - 0.70));
          diffuseColor.rgb *= 1.0 - 0.17 * max(tl, tr) * (1.0 - gLine);

          /* the kerb edges pick up grit */
          float edge = smoothstep(0.10, 0.0, u) + smoothstep(0.90, 1.0, u);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.26, 0.24, 0.21), edge * 0.42);
        }`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.34, gLine);        // fresh paint is glossier
        roughnessFactor = mix(roughnessFactor, 0.12, uWet);         // and so is a wet road`);
  };
  mat.customProgramCacheKey = () => 'road-v1';
  return mat;
}

/* TERRAIN — grass... */
function attachTerrainShader(mat, dirtTex) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDirt = { value: dirtTex };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aBlend;
        varying float vBlend;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBlend = aBlend;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D uDirt;
        varying float vBlend;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          /* the grass texture repeats every few metres */
          vec3 broad = texture2D(map, vMapUv * 0.055).rgb;
          diffuseColor.rgb *= 0.74 + broad * 0.62;

          vec3 soil = texture2D(uDirt, vMapUv * 3.0).rgb;
          diffuseColor.rgb = mix(diffuseColor.rgb, soil, clamp(vBlend, 0.0, 1.0));
        }`);
  };
  mat.customProgramCacheKey = () => 'terrain-v1';
  return mat;
}

export { SHADED, attachRoadShader, attachTerrainShader, makeGlassMaterial, makeGrassMaterial, makePaintMaterial, makeSkyMaterial };
