// Terrain chunks, sky, fog, clouds and water. Terrain is generated on the main thread under a per-frame
// time budget, flat shaded with one color per triangle.
import * as THREE from '../three.js';
import { getMap } from './biomes.js';
import { seedNoise, simplex2, smoothstep } from './noise.js';

export const CELL = 16;
export const CHUNK = 640;
const SEG = CHUNK / CELL;
const SEED = 1337;
const SPACE = new THREE.Color(0x000000);
// planet colours per map: land, second land tone, sea level (higher means more ocean)
const PLANETS = { alpine: [0x3f5a32, 0x6a6a58, 0.5], canyon: [0x9a6e45, 0xc49a68, 0.47], archipelago: [0x3f7a35, 0x5f8f3e, 0.56], grid: [0x6d747c, 0x8a9099, 0.5] };
const _pr = new THREE.Matrix4(), _pr2 = new THREE.Matrix4(), _c3 = new THREE.Color();
// Terrain scale. The biome functions are tuned at 1.0; shrinking height and width together keeps the shapes
// but puts ridges and valleys closer, which is what makes speed readable.
export const TERRAIN_SCALE = 0.5;

function scaleMap(m, k) {
  if (k === 1 || m.grid) return m;
  return {
    ...m,
    height: (x, z) => m.height(x / k, z / k) * k,
    color: (h, ny, x, z, out) => m.color(h / k, ny, x / k, z / k, out),
    maxH: m.maxH * k,
    spawnAlt: Math.max(450, m.spawnAlt * k + 150),
    sky: { ...m.sky, cloudAlt: m.sky.cloudAlt * 0.7 },
  };
}

const QUALITY = {
  low: { radius: 5, clouds: 45, treeLod: 0, trees: 0.6 },
  medium: { radius: 7, clouds: 80, treeLod: 1, trees: 1 },
  high: { radius: 10, clouds: 130, treeLod: 1, trees: 1.3 },
};

// Where trees grow on each map: candidate spacing and a probability from height, slope and position.
const TREES = {
  alpine: { kind: 'pine', step: 24, pick: (h, ny, x, z) => (ny < 0.83 || h > 640 ? 0 : (h < 110 ? 0.2 : 0.85) * smoothstep(-0.35, 0.25, simplex2(x * 0.0021 + 7, z * 0.0021 - 3))) },
  archipelago: { kind: 'round', step: 22, pick: (h, ny, x, z) => (h < 9 || h > 320 || ny < 0.8 ? 0 : 0.7 * smoothstep(-0.5, 0.2, simplex2(x * 0.003, z * 0.003))) },
  canyon: { kind: 'bush', step: 38, pick: (h, ny) => (ny > 0.95 ? (h < 30 ? 0.07 : 0.04) : 0) },
};
const TREE_MAX = 9000;
const hash2 = (a, b) => { let h = Math.imul(a, 374761393) + Math.imul(b, 668265263) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const now = () => performance.now();

const GRID_GLSL = /* glsl */`
float gridLine(vec2 p, float cell, float w) {
  vec2 q = p / cell;
  vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
  return 1.0 - clamp(min(g.x, g.y) - w, 0.0, 1.0);
}
vec3 gridColor(vec3 base, vec3 wp) {
  float d = length(wp - cameraPosition);
  vec2 cell = floor(wp.xz / 400.0);
  base *= mod(cell.x + cell.y, 2.0) < 1.0 ? 1.0 : 0.84;
  base = mix(base, vec3(0.30, 0.36, 0.44), gridLine(wp.xz, 50.0, 0.0) * 0.5 * (1.0 - smoothstep(900.0, 2600.0, d)));
  base = mix(base, vec3(0.13, 0.17, 0.24), gridLine(wp.xz, 400.0, 0.7) * 0.85);
  return base;
}`;

function terrainMaterial(grid) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <color_pars_vertex>', 'flat varying vec3 vColor;\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <color_pars_fragment>', 'flat varying vec3 vColor;\nvarying vec3 vWPos;\n' + GRID_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + (grid ? 'diffuseColor.rgb = gridColor(diffuseColor.rgb, vWPos);' : ''));
  };
  m.customProgramCacheKey = () => (grid ? 'terrain-grid' : 'terrain');
  return m;
}

const skyVert = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const skyFrag = /* glsl */`
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunColor;
uniform vec3 sunDir;
uniform float camH;
uniform float planetK;
uniform float spaceK;
uniform float time;
uniform vec3 land;
uniform vec3 land2;
uniform vec3 sea;
uniform float seaLevel;
uniform mat3 planetRot;
varying vec3 vDir;

float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 6; i++) { s += a * n3(p); p = p * 2.13 + 7.1; a *= 0.5; } return s; }

const float R = 6.371e6;
const float ATM = 9.0e4;

void main() {
  vec3 d = normalize(vDir);
  vec3 col = mix(horizon, zenith, pow(clamp(d.y, 0.0, 1.0), 0.55));
  // stars once the air is gone
  if (spaceK > 0.01) {
    vec3 c = floor(d * 260.0);
    float st = step(0.9965, h3(c)) * (0.35 + 0.65 * h3(c + 3.1));
    col += vec3(st) * spaceK;
  }
  float s = max(dot(d, sunDir), 0.0);
  col += sunColor * (smoothstep(0.9993, 0.9996, s) * (1.5 + spaceK * 2.0) + pow(s, 48.0) * 0.25 * (1.0 - spaceK * 0.7) + pow(s, 5.0) * 0.08 * (1.0 - spaceK));

  if (planetK > 0.0) {
    float h = camH;
    float b = (R + h) * d.y, cc = h * (2.0 * R + h), disc = b * b - cc;
    if (d.y < 0.0 && disc > 0.0) {
      float t = -b - sqrt(disc);
      vec3 n = vec3(d.x * t, R + h + d.y * t, d.z * t) / R;
      vec3 w = planetRot * n;
      // continents from warped fbm, ice toward the poles, a drier band near the equator
      vec3 q = w * 2.6;
      q += vec3(fbm(q + 1.7), fbm(q + 9.2), fbm(q + 4.4)) * 0.8;
      float e = fbm(q);
      float ice = smoothstep(0.8, 0.92, abs(w.z) + (fbm(w * 9.0) - 0.5) * 0.15);
      vec3 ground = mix(land, land2, smoothstep(0.35, 0.75, fbm(w * 7.0 + 3.0)));
      ground = mix(ground, vec3(0.62, 0.52, 0.36), smoothstep(0.6, 1.0, 1.0 - abs(w.z) * 3.5) * 0.45);
      float coast = smoothstep(seaLevel - 0.008, seaLevel + 0.012, e);
      vec3 ocean = mix(sea * 0.7, sea * 1.5 + vec3(0.02, 0.09, 0.07), smoothstep(seaLevel - 0.06, seaLevel, e));
      vec3 surf = mix(mix(ocean, ground, coast), vec3(0.92, 0.95, 0.98), ice);
      float sl = dot(n, sunDir);
      float day = smoothstep(-0.12, 0.25, sl);
      vec3 rf = reflect(d, n);
      float glint = pow(max(dot(rf, sunDir), 0.0), 60.0) * (1.0 - coast) * (1.0 - ice) * day;
      vec3 lit = surf * (0.03 + 0.97 * max(sl, 0.0) * day) + sunColor * glint * 0.8;
      float cl = smoothstep(0.6, 0.78, fbm(w * 6.5 + vec3(time * 0.004, 0.0, time * 0.002)));
      lit = mix(lit, vec3(0.05 + 0.9 * max(sl, 0.0) * day), cl * 0.75);
      // atmosphere: thicker toward the limb, warm along the terminator
      float mu = max(dot(n, -d), 0.0);
      float haze = pow(1.0 - mu, 2.5);
      vec3 atm = mix(vec3(0.35, 0.55, 1.0), vec3(1.0, 0.55, 0.3), smoothstep(0.25, -0.05, sl) * day);
      lit = mix(lit, atm * (0.12 + 0.88 * day), haze * 0.5);
      // low down, blend toward the ordinary sky colour so the hand-off from the terrain is soft
      lit = mix(lit, horizon, (1.0 - spaceK) * 0.3);
      col = mix(col, lit, planetK);
    } else if (spaceK > 0.01) {
      // thin glowing shell above the limb
      float closest = (R + h) * sqrt(max(0.0, 1.0 - d.y * d.y));
      float above = d.y < 0.0 ? closest - R : h;
      float glow = exp(-max(above, 0.0) / (ATM * 0.3));
      col += vec3(0.32, 0.55, 1.0) * glow * planetK * spaceK;
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}`;

const waterNearVert = /* glsl */`
#include <common>
#include <fog_pars_vertex>
uniform float time;
uniform vec2 center;
uniform float radius;
uniform mat4 texMatrix;
varying vec3 vWorld;
varying float vCrest;
varying vec4 vRefl;
void main() {
  vec3 p = position;
  p.xz += center;
  float fade = 1.0 - smoothstep(radius * 0.55, radius * 0.95, length(p.xz - cameraPosition.xz));
  float h = sin(dot(p.xz, vec2(0.8, 0.6)) * 0.034 + time * 1.05) * 0.95
          + sin(dot(p.xz, vec2(-0.45, 0.89)) * 0.061 + time * 1.55) * 0.5
          + sin(dot(p.xz, vec2(0.96, -0.28)) * 0.12 + time * 2.3) * 0.22;
  h *= fade;
  p.y += h;
  vCrest = h * (0.6 + 0.4 * fade);
  vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
  vRefl = texMatrix * vec4(vWorld.x, vWorld.y - h, vWorld.z, 1.0);
  vec4 mvPosition = viewMatrix * vec4(vWorld, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const WATER_SHADE = /* glsl */`
uniform float time;
uniform vec3 deep;
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform sampler2D tRefl;
uniform float hasRefl;
varying vec4 vRefl;
vec2 wg(vec2 p, vec2 d, float f, float sp, float a) { return d * (cos(dot(d, p) * f + time * sp) * a * f); }
vec4 shadeWater(vec3 wp, float crest) {
  vec2 p = wp.xz;
  float d = length(wp - cameraPosition);
  float fine = 1.0 - smoothstep(300.0, 2500.0, d);
  vec2 g = wg(p, vec2(0.8, 0.6), 0.034, 1.05, 0.95) + wg(p, vec2(-0.45, 0.89), 0.061, 1.55, 0.5) + wg(p, vec2(0.96, -0.28), 0.12, 2.3, 0.22);
  g += (wg(p, vec2(0.31, 0.95), 0.53, 3.1, 0.035) + wg(p, vec2(-0.86, 0.5), 0.91, 4.2, 0.022) + wg(p, vec2(0.6, -0.8), 1.7, 5.3, 0.012)) * fine;
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
  vec3 v = normalize(cameraPosition - wp);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 r = reflect(-v, n);
  vec3 sky = mix(horizon, zenith, pow(clamp(r.y, 0.0, 1.0), 0.5));
  if (hasRefl > 0.5) {
    vec2 uv = vRefl.xy / vRefl.w + n.xz * 0.035;
    sky = mix(sky, texture2D(tRefl, uv).rgb, 0.92);
  }
  float spec = pow(max(dot(r, sunDir), 0.0), 260.0) * 6.0 + pow(max(dot(r, sunDir), 0.0), 40.0) * 0.25;
  vec3 body = deep * (0.55 + 0.45 * max(dot(n, sunDir), 0.0)) + vec3(0.02, 0.06, 0.06) * (1.0 - fres);
  vec3 col = mix(body, sky, fres) + sunColor * spec;
  col = mix(col, vec3(0.92, 0.96, 1.0), smoothstep(1.1, 1.6, crest) * 0.35);
  return vec4(col, mix(0.78, 0.97, fres));
}`;

const waterNearFrag = /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform vec2 center;
uniform float radius;
varying vec3 vWorld;
varying float vCrest;
` + WATER_SHADE + `
void main() {
  if (length(vWorld.xz - center) > radius) discard;
  gl_FragColor = shadeWater(vWorld, vCrest);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

const wallVert = /* glsl */`
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const wallFrag = /* glsl */`
uniform float radius;
varying vec3 vW;
float line(float v, float cell) {
  float q = v / cell;
  float g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
  return 1.0 - clamp(g - 0.6, 0.0, 1.0);
}
void main() {
  float d = length(vW - cameraPosition);
  float a = 1.0 - smoothstep(150.0, 1400.0, d);
  if (a < 0.01) discard;
  float l = max(line(atan(vW.z, vW.x) * radius, 100.0), line(vW.y, 100.0));
  gl_FragColor = vec4(1.0, 0.32, 0.2, a * (0.06 + 0.6 * l));
  #include <colorspace_fragment>
}`;

const waterVert = /* glsl */`
#include <common>
#include <fog_pars_vertex>
uniform mat4 texMatrix;
varying vec3 vWorld;
varying vec4 vRefl;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vRefl = texMatrix * wp;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const waterFrag = /* glsl */`
#include <common>
#include <fog_pars_fragment>
varying vec3 vWorld;
` + WATER_SHADE + `
void main() {
  gl_FragColor = shadeWater(vWorld, 0.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

let seedState = 7;
const rnd = () => ((seedState = (seedState * 16807) % 2147483647) / 2147483647);

// Instances placed on a repeating tile around the camera, so they stay fixed in the world.
class TiledInstances {
  constructor(scene, geo, mat, items, tile) {
    this.items = items; this.tile = tile;
    let n = 0;
    for (const it of items) n += it.parts.length;
    this.mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    this.mesh.frustumCulled = false;
    this.mesh.count = n;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3();
    this._e = new THREE.Euler();
    for (const it of items) it.wx = it.wz = NaN;
  }
  update(cam) {
    const T = this.tile;
    let k = 0, dirty = false;
    for (const it of this.items) {
      const wx = Math.round((cam.x - it.x) / T), wz = Math.round((cam.z - it.z) / T);
      if (wx !== it.wx || wz !== it.wz) {
        it.wx = wx; it.wz = wz; dirty = true;
        for (let j = 0; j < it.parts.length; j++) {
          const p = it.parts[j];
          this._p.set(it.x + wx * T + p.x, it.y + p.y, it.z + wz * T + p.z);
          this._q.setFromEuler(this._e.set(0, p.r, 0));
          this._m.compose(this._p, this._q, this._s.set(p.sx, p.sy, p.sz));
          this.mesh.setMatrixAt(k + j, this._m);
        }
      }
      k += it.parts.length;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
  dispose(scene) { scene.remove(this.mesh); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.chunks = new Map();
    this.queue = [];
    this.lastKey = '';
    this.quality = QUALITY.medium;
    this.mapId = null;
    this.map = getMap('alpine');
    this.H = new Float32Array((SEG + 3) * (SEG + 3));
    this.col = [0, 0, 0];
    this.hk = new Int32Array(1 << 17).fill(0x7fffffff);
    this.hv = new Float32Array(1 << 16);

    this.skyU = {
      zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
      sunColor: { value: new THREE.Color() }, sunDir: { value: new THREE.Vector3(0, 1, 0) },
      camH: { value: 0 }, planetK: { value: 0 }, spaceK: { value: 0 }, time: { value: 0 }, seaLevel: { value: 0.5 },
      land: { value: new THREE.Color(0x4f6b3a) }, land2: { value: new THREE.Color(0x6b6a4a) }, sea: { value: new THREE.Color(0x0f3557) },
      planetRot: { value: new THREE.Matrix3() },
    };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12),
      new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, uniforms: this.skyU, side: THREE.BackSide, depthWrite: false, fog: false }));
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 2);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = new THREE.Fog(0xffffff, 1000, 5000);

    // water: a faceted, animated grid near the camera (on a fixed world lattice so it does not swim)
    // and a smooth ring out to the horizon
    this.waterR = 950; this.waterCell = 12;
    this.waterU = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      time: { value: 0 }, deep: { value: new THREE.Color(0x0b4150) },
      zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color() },
      center: { value: new THREE.Vector2() }, radius: { value: this.waterR },
      tRefl: { value: null }, hasRefl: { value: 0 }, texMatrix: { value: new THREE.Matrix4() },
    }]);
    this.refl = { rt: null, cam: new THREE.PerspectiveCamera(), clip: [new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)],
      bias: new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1), v: new THREE.Vector3(), u: new THREE.Vector3() };
    const n = Math.round(this.waterR * 2 / this.waterCell);
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(n * this.waterCell, n * this.waterCell, n, n).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({ vertexShader: waterNearVert, fragmentShader: waterNearFrag, uniforms: this.waterU, fog: true, transparent: true }));
    this.water.frustumCulled = false;
    this.water.renderOrder = 1;
    this.waterFar = new THREE.Mesh(new THREE.RingGeometry(this.waterR, 30000, 72, 1).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({ vertexShader: waterVert, fragmentShader: waterFrag, uniforms: this.waterU, fog: true, transparent: true }));
    this.waterFar.frustumCulled = false;
    this.waterFar.renderOrder = 1;
    this.water.visible = this.waterFar.visible = false;
    scene.add(this.water, this.waterFar);

    this.trees = null;
    this.planetOff = new THREE.Vector2();
    this.treesDirty = false;
    this.wall = null;

    this.clouds = null;
    this.towers = null;
    this.material = null;
  }

  get viewDist() { return this.quality.radius * CHUNK * 0.92; }

  setQuality(name) {
    const q = QUALITY[name] || QUALITY.medium;
    if (q === this.quality) return;
    this.quality = q;
    if (this.mapId) { const id = this.mapId; this.mapId = null; this.setMap(id); }
  }

  setMap(id) {
    if (id === this.mapId) return;
    this.mapId = id;
    this.map = scaleMap(getMap(id), TERRAIN_SCALE);
    seedNoise(SEED);
    this.hk.fill(0x7fffffff);
    this.clear();
    if (this.material) this.material.dispose();
    this.material = terrainMaterial(!!this.map.grid);

    const s = this.map.sky;
    this.skyU.zenith.value.setHex(s.zenith);
    this.skyU.horizon.value.setHex(s.horizon);
    this.base = { zenith: this.skyU.zenith.value.clone(), horizon: this.skyU.horizon.value.clone(), fog: new THREE.Color(s.horizon), hemi: this.hemi.intensity };
    this.spaceK = -1;
    // the planet seen from orbit takes its colours from the map you left
    const P = PLANETS[this.mapId] || PLANETS.alpine;
    this.skyU.land.value.setHex(P[0]); this.skyU.land2.value.setHex(P[1]); this.skyU.seaLevel.value = P[2];
    this.skyU.sunColor.value.setHex(s.sunColor);
    this.skyU.sunDir.value.set(...s.sun).normalize();
    this.sun.color.setHex(s.sunColor);
    this.sun.intensity = s.sunI * 1.25;
    this.sun.position.copy(this.skyU.sunDir.value).multiplyScalar(1000);
    this.hemi.color.setHex(s.hemiSky);
    this.hemi.groundColor.setHex(s.hemiGround);
    this.hemi.intensity = s.hemiI * 1.6;
    this.scene.fog.color.setHex(s.horizon);
    this.setFog(this.fogOn ?? true);

    this.water.visible = this.waterFar.visible = this.map.water !== null;
    this.water.position.y = this.map.water ?? 0;
    this.waterFar.position.y = (this.map.water ?? 0) - 0.4;
    for (const k of ['zenith', 'horizon', 'sunColor']) this.waterU[k].value.copy(this.skyU[k].value);
    this.waterU.sunDir.value.copy(this.skyU.sunDir.value);

    this.buildClouds();
    this.buildTowers();
    this.buildTreeMesh();
  }

  // Mirror the camera in the sea and render the world above it into a small texture the water samples.
  renderReflection(renderer, camera) {
    const R = this.refl, U = this.waterU;
    const on = this.water.visible && this.quality !== QUALITY.low;
    U.hasRefl.value = on ? 1 : 0;
    if (!on) return;
    const div = this.quality === QUALITY.high ? 2 : 3;
    const w = Math.max(64, Math.floor(renderer.domElement.width / div)), h = Math.max(64, Math.floor(renderer.domElement.height / div));
    if (!R.rt) { R.rt = new THREE.WebGLRenderTarget(w, h); R.rt.texture.colorSpace = THREE.SRGBColorSpace; U.tRefl.value = R.rt.texture; }
    else if (R.rt.width !== w || R.rt.height !== h) R.rt.setSize(w, h);
    const lvl = this.map.water, c = R.cam, cp = camera.position;
    c.fov = camera.fov; c.aspect = camera.aspect; c.near = camera.near; c.far = camera.far;
    c.projectionMatrix.copy(camera.projectionMatrix);
    camera.getWorldDirection(R.v);
    R.u.set(0, 1, 0).applyQuaternion(camera.quaternion);
    c.position.set(cp.x, 2 * lvl - cp.y, cp.z);
    c.up.set(R.u.x, -R.u.y, R.u.z);
    c.lookAt(cp.x + R.v.x, 2 * lvl - cp.y - R.v.y, cp.z + R.v.z);
    c.updateMatrixWorld();
    U.texMatrix.value.copy(R.bias).multiply(c.projectionMatrix).multiply(c.matrixWorldInverse);
    R.clip[0].constant = -lvl + 0.3;
    this.water.visible = this.waterFar.visible = false;
    const clip = renderer.clippingPlanes;
    renderer.clippingPlanes = R.clip;
    renderer.setRenderTarget(R.rt);
    renderer.clear();
    renderer.render(this.scene, c);
    renderer.clippingPlanes = clip;
    this.water.visible = this.waterFar.visible = true;
  }

  // Fog off pushes it past the draw distance, so the terrain just ends at the edge of the view.
  setFog(on) {
    this.fogOn = on;
    const far = this.viewDist;
    this.scene.fog.near = on ? far * 0.3 : 1e6;
    this.scene.fog.far = on ? far : 1e6 + 1;
  }

  // Red grid wall at the edge of the combat area; it only shows up when you get close.
  setLimits(radius, ceiling) {
    if (this.wall) { this.scene.remove(this.wall); this.wall.geometry.dispose(); this.wall = null; }
    if (!radius) return;
    const top = Math.min(ceiling + 300, 9000), bottom = -200;
    const g = new THREE.CylinderGeometry(radius, radius, top - bottom, 160, 1, true).translate(0, (top + bottom) / 2, 0);
    this.wall = new THREE.Mesh(g, new THREE.ShaderMaterial({
      vertexShader: wallVert, fragmentShader: wallFrag, uniforms: { radius: { value: radius } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.wall.frustumCulled = false;
    this.wall.renderOrder = 2;
    this.scene.add(this.wall);
  }

  buildTreeMesh() {
    if (this.trees) { this.scene.remove(this.trees); this.trees.geometry.dispose(); this.trees = null; }
    const t = TREES[this.mapId];
    if (!t) return;
    const paint = (g, hex) => {
      g = g.index ? g.toNonIndexed() : g;
      const c = new THREE.Color(hex), a = new Float32Array(g.getAttribute('position').count * 3);
      for (let i = 0; i < a.length; i += 3) { a[i] = c.r; a[i + 1] = c.g; a[i + 2] = c.b; }
      g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      g.deleteAttribute('uv');
      g.deleteAttribute('normal');
      return g;
    };
    let parts;
    if (t.kind === 'pine') parts = [
      paint(new THREE.CylinderGeometry(0.35, 0.45, 3, 5).translate(0, 1.5, 0), 0x4a3a2a),
      paint(new THREE.ConeGeometry(2.8, 6.5, 6).translate(0, 5.2, 0), 0x2c4a26),
      paint(new THREE.ConeGeometry(2.0, 4.8, 6).translate(0, 8.4, 0), 0x35572c),
    ];
    else if (t.kind === 'round') parts = [
      paint(new THREE.CylinderGeometry(0.35, 0.5, 4, 5).translate(0, 2, 0), 0x5a4330),
      paint(new THREE.IcosahedronGeometry(3, 0).scale(1, 0.85, 1).translate(0, 5.6, 0), 0x3f7a2e),
    ];
    else parts = [paint(new THREE.IcosahedronGeometry(1.8, 0).scale(1.3, 0.75, 1.1).translate(0, 0.9, 0), 0x7d7444)];
    const geo = mergeSimple(parts);
    this.trees = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }), TREE_MAX);
    this.trees.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(TREE_MAX * 3), 3);
    this.trees.count = 0;
    this.trees.frustumCulled = false;
    this.scene.add(this.trees);
    this.treesDirty = true;
  }

  // Deterministic scatter for one chunk: packed instance matrices and tints.
  chunkTrees(c) {
    const t = TREES[this.mapId];
    const step = t.step / Math.sqrt(this.quality.trees), ox = c.cx * CHUNK, oz = c.cz * CHUNK, n = Math.floor(CHUNK / step);
    const mats = [], cols = [], m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), sc = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const map = this.map, water = map.water;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const gi = c.cx * n + i, gj = c.cz * n + j;
      const x = ox + (i + 0.15 + hash2(gi, gj) * 0.7) * step, z = oz + (j + 0.15 + hash2(gj + 911, gi - 77) * 0.7) * step;
      const h = this.groundAt(x, z);
      if (water !== null && h < water + 2) continue;
      const dx = this.groundAt(x + 6, z) - h, dz = this.groundAt(x, z + 6) - h;
      const ny = 6 / Math.hypot(dx, dz, 6);
      if (hash2(gi * 3 + 1, gj * 7 + 5) > t.pick(h / TERRAIN_SCALE, ny, x / TERRAIN_SCALE, z / TERRAIN_SCALE)) continue;
      const s = 0.7 + hash2(gi + 5, gj + 13) * 0.9;
      m.compose(p.set(x, h - 0.6, z), q.setFromAxisAngle(up, hash2(gi, gj + 3) * 6.28), sc.set(s, s * (0.85 + hash2(gj, gi) * 0.4), s));
      for (let e = 0; e < 16; e++) mats.push(m.elements[e]);
      const k = 0.82 + hash2(gi + 31, gj + 17) * 0.36;
      cols.push(k, k * (0.95 + hash2(gi, gj + 99) * 0.1), k);
    }
    return { m: new Float32Array(mats), c: new Float32Array(cols) };
  }

  rebuildTrees() {
    this.treesDirty = false;
    const t = this.trees;
    if (!t) return;
    const A = t.instanceMatrix.array, C = t.instanceColor.array;
    let n = 0;
    for (const c of this.chunks.values()) {
      if (!c.mesh || c.lod > this.quality.treeLod) continue;
      if (!c.trees) c.trees = this.chunkTrees(c);
      const k = c.trees.m.length / 16;
      if (n + k > TREE_MAX) break;
      A.set(c.trees.m, n * 16);
      C.set(c.trees.c, n * 3);
      n += k;
    }
    t.count = n;
    t.instanceMatrix.needsUpdate = true;
    t.instanceColor.needsUpdate = true;
  }

  buildClouds() {
    if (this.clouds) { this.clouds.dispose(this.scene); this.clouds = null; }
    const s = this.map.sky;
    const n = Math.round(this.quality.clouds * (s.clouds ?? 0.5));
    if (n < 4) return;
    seedState = 99;
    const tile = Math.max(6000, this.viewDist * 2.2);
    const items = [];
    for (let k = 0; k < n; k++) {
      const parts = [];
      const blobs = 3 + Math.floor(rnd() * 5);
      const spread = 90 + rnd() * 160;
      for (let j = 0; j < blobs; j++) {
        const sz = 50 + rnd() * 90;
        parts.push({ x: (rnd() - 0.5) * spread * 2.2, y: (rnd() - 0.2) * 40, z: (rnd() - 0.5) * spread, sx: sz * (1.1 + rnd() * 0.5), sy: sz * 0.55, sz, r: rnd() * 6 });
      }
      items.push({ x: (rnd() - 0.5) * tile, y: s.cloudAlt + (rnd() - 0.5) * 260, z: (rnd() - 0.5) * tile, parts });
    }
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true });
    mat.emissive.setHex(s.hemiSky).multiplyScalar(0.32);
    this.clouds = new TiledInstances(this.scene, new THREE.IcosahedronGeometry(1, 1), mat, items, tile);
  }

  // Proving grounds: scattered pylons for depth and speed cues.
  buildTowers() {
    if (this.towers) { this.towers.dispose(this.scene); this.towers = null; }
    if (!this.map.grid) return;
    seedState = 5;
    const tile = 4000, items = [];
    for (let k = 0; k < 46; k++) {
      const h = 40 + rnd() * 160;
      items.push({ x: (rnd() - 0.5) * tile, y: 0, z: (rnd() - 0.5) * tile, parts: [{ x: 0, y: 0, z: 0, sx: 7, sy: h, sz: 7, r: rnd() }] });
    }
    const paint = (g, rgb) => {
      const c = new Float32Array(g.getAttribute('position').count * 3);
      for (let i = 0; i < c.length; i += 3) c.set(rgb, i);
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
      return g;
    };
    const merged = mergeSimple([
      paint(new THREE.BoxGeometry(1, 0.9, 1).translate(0, 0.45, 0).toNonIndexed(), [0.4, 0.44, 0.5]),
      paint(new THREE.BoxGeometry(1.3, 0.1, 1.3).translate(0, 0.95, 0).toNonIndexed(), [0.85, 0.12, 0.08]),
    ]);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.towers = new TiledInstances(this.scene, merged, mat, items, tile);
  }

  clear() {
    for (const c of this.chunks.values()) if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); }
    this.chunks.clear();
    this.queue.length = 0;
    this.lastKey = '';
  }

  // Height of the rendered surface: matches the finest terrain mesh triangle by triangle.
  groundAt(x, z) {
    if (this.map.grid) return 0;
    const gx = x / CELL, gz = z / CELL;
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    if (fx + fz <= 1) {
      const a = this.hgrid(i, j);
      return a + (this.hgrid(i + 1, j) - a) * fx + (this.hgrid(i, j + 1) - a) * fz;
    }
    const d = this.hgrid(i + 1, j + 1);
    return d + (this.hgrid(i, j + 1) - d) * (1 - fx) + (this.hgrid(i + 1, j) - d) * (1 - fz);
  }

  surfaceAt(x, z) {
    const h = this.groundAt(x, z);
    return this.map.water !== null ? Math.max(h, this.map.water) : h;
  }

  hgrid(i, j) {
    const s = ((i * 73856093) ^ (j * 19349663)) & 0xffff;
    const hk = this.hk;
    if (hk[s * 2] === i && hk[s * 2 + 1] === j) return this.hv[s];
    const h = this.map.height(i * CELL, j * CELL);
    hk[s * 2] = i; hk[s * 2 + 1] = j; this.hv[s] = h;
    return h;
  }

  lodFor(d) { return d < 1.5 ? 0 : d < 3 ? 1 : d < 5.5 ? 2 : 3; }

  update(dt, camera, budgetMs = 2.5) {
    const cp = camera.position;
    const U = this.skyU;
    U.camH.value = Math.max(0, cp.y);
    U.time.value += dt;
    U.planetK.value = smoothstep(2500, 14000, cp.y);
    // the planet scrolls under you by however far you have really travelled (see game.planetOff)
    const R = 6.371e6, lon = (cp.x + this.planetOff.x) / R, lat = (cp.z + this.planetOff.y) / R;
    U.planetRot.value.setFromMatrix4(_pr.makeRotationZ(-lon).multiply(_pr2.makeRotationX(lat)));
    if (this.base) {
      const k = smoothstep(8000, 50000, cp.y);
      if (Math.abs(k - this.spaceK) > 1e-4) {
        this.spaceK = k;
        U.spaceK.value = k;
        U.zenith.value.copy(this.base.zenith).lerp(SPACE, Math.min(1, k * 1.15));
        U.horizon.value.copy(this.base.horizon).lerp(SPACE, k);
        this.scene.fog.color.copy(this.base.fog).lerp(_c3.setHex(PLANETS[this.mapId]?.[0] ?? 0x4f6b3a).multiplyScalar(0.6), U.planetK.value * 0.6).lerp(SPACE, k);
        this.hemi.intensity = this.base.hemi * (1 - 0.85 * k);
      }
    }
    this.sky.position.copy(cp);
    this.sky.scale.setScalar(camera.far * 0.9);
    if (this.water.visible) {
      this.waterU.time.value += dt;
      const k = this.waterCell;
      this.waterU.center.value.set(Math.round(cp.x / k) * k, Math.round(cp.z / k) * k);
      this.waterFar.position.x = this.waterU.center.value.x;
      this.waterFar.position.z = this.waterU.center.value.y;
    }
    if (this.clouds) this.clouds.update(cp);
    if (this.towers) this.towers.update(cp);
    this.stream(cp.x, cp.z, budgetMs);
    if (this.treesDirty && this.queue.length < 4) this.rebuildTrees();
  }

  stream(px, pz, budgetMs) {
    const fx = px / CHUNK, fz = pz / CHUNK;
    const ccx = Math.floor(fx), ccz = Math.floor(fz);
    const key = ccx + ',' + ccz;
    if (key !== this.lastKey) {
      this.lastKey = key;
      const R = this.quality.radius, wanted = new Set();
      this.queue.length = 0;
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const cx = ccx + dx, cz = ccz + dz;
        const d = Math.hypot(cx + 0.5 - fx, cz + 0.5 - fz);
        if (d > R + 0.5) continue;
        const k = cx + ',' + cz;
        wanted.add(k);
        let c = this.chunks.get(k);
        if (!c) { c = { cx, cz, lod: -1, mesh: null }; this.chunks.set(k, c); }
        c.want = this.lodFor(d);
        c.d = d;
        if (c.lod !== c.want) this.queue.push(c);
      }
      for (const [k, c] of this.chunks) {
        if (wanted.has(k)) continue;
        if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); }
        if (c.lod <= this.quality.treeLod) this.treesDirty = true;
        this.chunks.delete(k);
      }
      this.queue.sort((a, b) => (a.mesh ? 1 : 0) - (b.mesh ? 1 : 0) || a.d - b.d);
    }
    const t0 = now();
    while (this.queue.length && now() - t0 < budgetMs) {
      const c = this.queue.shift();
      if (this.chunks.get(c.cx + ',' + c.cz) !== c || c.lod === c.want) continue;
      this.buildChunk(c);
    }
  }

  readyNear(x, z, r = 1) {
    const ccx = Math.floor(x / CHUNK), ccz = Math.floor(z / CHUNK);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const c = this.chunks.get((ccx + dx) + ',' + (ccz + dz));
      if (!c || !c.mesh) return false;
    }
    return true;
  }

  get pending() { return this.queue.length; }

  buildChunk(c) {
    const lod = c.want, seg = SEG >> lod, step = CHUNK / seg;
    const ox = c.cx * CHUNK, oz = c.cz * CHUNK, map = this.map, col = this.col;
    const hw = seg + 3, H = this.H;
    for (let j = 0; j < hw; j++) for (let i = 0; i < hw; i++) H[j * hw + i] = map.height(ox + (i - 1) * step, oz + (j - 1) * step);
    const n1 = seg + 1, vCount = n1 * n1 + 4 * seg;
    const pos = new Float32Array(vCount * 3), clr = new Float32Array(vCount * 3);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < n1; j++) for (let i = 0; i < n1; i++) {
      const v = (j * n1 + i) * 3, h = H[(j + 1) * hw + i + 1];
      const dx = H[(j + 1) * hw + i + 2] - H[(j + 1) * hw + i], dz = H[(j + 2) * hw + i + 1] - H[j * hw + i + 1];
      const ny = 2 * step / Math.hypot(dx, dz, 2 * step);
      pos[v] = i * step; pos[v + 1] = h; pos[v + 2] = j * step;
      map.color(h, ny, ox + i * step, oz + j * step, col);
      clr[v] = toLin(col[0]); clr[v + 1] = toLin(col[1]); clr[v + 2] = toLin(col[2]);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
    const idx = new Uint16Array(seg * seg * 6 + 4 * seg * 6);
    let k = 0;
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
      const a = j * n1 + i, b = a + 1, cc = a + n1, d = cc + 1;
      idx[k++] = a; idx[k++] = cc; idx[k++] = b;
      idx[k++] = b; idx[k++] = cc; idx[k++] = d;
    }
    // skirts hide cracks between neighbouring LODs
    const drop = step * 1.5 + 10;
    let sv = n1 * n1;
    const ring = [];
    for (let i = 0; i < seg; i++) ring.push(i);
    for (let j = 0; j < seg; j++) ring.push(j * n1 + seg);
    for (let i = seg; i > 0; i--) ring.push(seg * n1 + i);
    for (let j = seg; j > 0; j--) ring.push(j * n1);
    const first = sv;
    for (const v of ring) {
      pos[sv * 3] = pos[v * 3]; pos[sv * 3 + 1] = pos[v * 3 + 1] - drop; pos[sv * 3 + 2] = pos[v * 3 + 2];
      clr[sv * 3] = clr[v * 3]; clr[sv * 3 + 1] = clr[v * 3 + 1]; clr[sv * 3 + 2] = clr[v * 3 + 2];
      sv++;
    }
    for (let e = 0; e < ring.length; e++) {
      const a = ring[e], b = ring[(e + 1) % ring.length], sa = first + e, sb = first + (e + 1) % ring.length;
      idx[k++] = a; idx[k++] = b; idx[k++] = sa;
      idx[k++] = b; idx[k++] = sb; idx[k++] = sa;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(clr, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const half = CHUNK / 2, mid = (lo + hi - drop) / 2, ext = (hi - lo + drop) / 2;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(half, mid, half), Math.hypot(half, half, ext));
    if (c.mesh) { c.mesh.geometry.dispose(); c.mesh.geometry = g; }
    else {
      c.mesh = new THREE.Mesh(g, this.material);
      c.mesh.position.set(ox, 0, oz);
      c.mesh.matrixAutoUpdate = false;
      c.mesh.updateMatrix();
      this.group.add(c.mesh);
    }
    if ((c.lod <= this.quality.treeLod) !== (lod <= this.quality.treeLod)) this.treesDirty = true;
    c.lod = lod;
  }
}

// Concatenates non-indexed geometries that share the same attributes.
export function mergeSimple(geos) {
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geos[0].attributes)) {
    const size = geos[0].getAttribute(name).itemSize;
    let n = 0;
    for (const g of geos) n += g.getAttribute(name).array.length;
    const arr = new Float32Array(n);
    let o = 0;
    for (const g of geos) { arr.set(g.getAttribute(name).array, o); o += g.getAttribute(name).array.length; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}
