// Pooled visual effects: point particles, tracer streaks, ribbon contrails, wreckage and shockwaves.
// Everything is batched, so the whole module costs about eight draw calls.
import * as THREE from './three.js';
import { solid } from './models.js';

const pVert = /* glsl */`
#include <common>
#include <fog_pars_vertex>
attribute float size;
attribute float alpha;
attribute vec3 pcolor;
uniform float scale;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = alpha;
  vColor = pcolor;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(size * scale / max(-mvPosition.z, 0.5), 1.5, 900.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;
const pFrag = /* glsl */`
#include <common>
#include <fog_pars_fragment>
uniform float soft;
uniform float additive;
varying float vAlpha;
varying vec3 vColor;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(soft, 1.0, r)) * vAlpha;
  #ifdef USE_FOG
    if (additive > 0.5) a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);
  #endif
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
  if (additive < 0.5) {
    #include <fog_fragment>
  }
}`;

class Pool {
  constructor(scene, max, additive) {
    this.max = max; this.count = 0;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max); this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max); this.a0 = new Float32Array(max);
    this.drag = new Float32Array(max); this.grav = new Float32Array(max);
    const attr = (arr, n) => new THREE.BufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [[attr(this.pos, 3), 3], [attr(this.col, 3), 3], [attr(this.size, 1), 1], [attr(this.alpha, 1), 1]];
    g.setAttribute('position', this.attrs[0][0]); g.setAttribute('pcolor', this.attrs[1][0]);
    g.setAttribute('size', this.attrs[2][0]); g.setAttribute('alpha', this.attrs[3][0]);
    g.setDrawRange(0, 0);
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      scale: { value: 600 }, soft: { value: additive ? 0.0 : 0.4 }, additive: { value: additive ? 1 : 0 },
    }]);
    this.mesh = new THREE.Points(g, new THREE.ShaderMaterial({
      vertexShader: pVert, fragmentShader: pFrag, uniforms: this.uniforms, fog: true, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 7 : 6;
    scene.add(this.mesh);
  }

  emit(x, y, z, vx, vy, vz, life, s0, s1, c, a0, drag = 0, grav = 0) {
    if (this.count >= this.max) return;
    const i = this.count++, i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = c.r; this.col[i3 + 1] = c.g; this.col[i3 + 2] = c.b;
    this.life[i] = this.maxLife[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = a0;
    this.drag[i] = drag; this.grav[i] = grav; this.size[i] = s0; this.alpha[i] = a0;
  }

  update(dt) {
    let i = 0;
    const pos = this.pos, vel = this.vel, life = this.life;
    while (i < this.count) {
      life[i] -= dt;
      if (life[i] <= 0) {
        const l = --this.count;
        if (i !== l) {
          const i3 = i * 3, l3 = l * 3;
          for (let k = 0; k < 3; k++) { pos[i3 + k] = pos[l3 + k]; vel[i3 + k] = vel[l3 + k]; this.col[i3 + k] = this.col[l3 + k]; }
          life[i] = life[l]; this.maxLife[i] = this.maxLife[l]; this.s0[i] = this.s0[l]; this.s1[i] = this.s1[l];
          this.a0[i] = this.a0[l]; this.drag[i] = this.drag[l]; this.grav[i] = this.grav[l];
        }
        continue;
      }
      const i3 = i * 3, d = Math.max(0, 1 - this.drag[i] * dt);
      vel[i3] *= d; vel[i3 + 1] = vel[i3 + 1] * d - this.grav[i] * dt; vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      const t = 1 - life[i] / this.maxLife[i];
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t);
      this.alpha[i] = this.a0[i] * (1 - t) * (1 - t * 0.5);
      i++;
    }
    const n = this.count;
    this.mesh.geometry.setDrawRange(0, n);
    for (const [a, w] of this.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, n * w)); a.needsUpdate = true; }
  }

  clear() { this.count = 0; this.mesh.geometry.setDrawRange(0, 0); }
}

// Camera-facing segments with a minimum on-screen width. Tracers and speed streaks.
const sVert = /* glsl */`
attribute vec3 aA;
attribute vec3 aB;
attribute vec4 aC;
uniform vec2 res;
uniform float minPx;
uniform float worldW;
uniform float fadeFar;
varying vec3 vCol;
varying float vAcross;
varying float vAlpha;
void main() {
  vec4 a = viewMatrix * vec4(aA, 1.0);
  vec4 b = viewMatrix * vec4(aB, 1.0);
  const float nearZ = -0.6;
  if (a.z > nearZ && b.z > nearZ) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  if (a.z > nearZ) a = mix(a, b, (a.z - nearZ) / (a.z - b.z));
  if (b.z > nearZ) b = mix(b, a, (b.z - nearZ) / (b.z - a.z));
  vec4 ca = projectionMatrix * a, cb = projectionMatrix * b;
  vec2 sa = ca.xy / ca.w * res * 0.5, sb = cb.xy / cb.w * res * 0.5;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  vec4 c = mix(ca, cb, position.x);
  float wpx = max(minPx, worldW * projectionMatrix[1][1] * res.y * 0.5 / c.w);
  c.xy += (nrm * position.y + dir * (position.x * 2.0 - 1.0)) * wpx * 0.5 / (res * 0.5) * c.w;
  gl_Position = c;
  vCol = aC.rgb;
  vAcross = position.y;
  vAlpha = aC.a * (1.0 - smoothstep(fadeFar * 0.5, fadeFar, -mix(a.z, b.z, position.x)));
}`;
const sFrag = /* glsl */`
varying vec3 vCol;
varying float vAcross;
varying float vAlpha;
void main() {
  float f = 1.0 - abs(vAcross);
  gl_FragColor = vec4(vCol * (0.35 + f * f * 1.4) * vAlpha, 1.0);
  #include <colorspace_fragment>
}`;

class Streaks {
  constructor(scene, max, worldW = 0.32) {
    this.max = max; this.n = 0;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    this.a = new Float32Array(max * 3); this.b = new Float32Array(max * 3); this.c = new Float32Array(max * 4);
    const ia = (arr, n) => new THREE.InstancedBufferAttribute(arr, n).setUsage(THREE.DynamicDrawUsage);
    this.attrs = [[ia(this.a, 3), 3], [ia(this.b, 3), 3], [ia(this.c, 4), 4]];
    g.setAttribute('aA', this.attrs[0][0]); g.setAttribute('aB', this.attrs[1][0]); g.setAttribute('aC', this.attrs[2][0]);
    g.instanceCount = 0;
    this.uniforms = { res: { value: new THREE.Vector2(1280, 720) }, minPx: { value: 2.2 }, worldW: { value: worldW }, fadeFar: { value: 3000 } };
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      vertexShader: sVert, fragmentShader: sFrag, uniforms: this.uniforms,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    scene.add(this.mesh);
  }
  begin() { this.n = 0; }
  push(ax, ay, az, bx, by, bz, col, alpha) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.a[i * 3] = ax; this.a[i * 3 + 1] = ay; this.a[i * 3 + 2] = az;
    this.b[i * 3] = bx; this.b[i * 3 + 1] = by; this.b[i * 3 + 2] = bz;
    this.c[i * 4] = col.r; this.c[i * 4 + 1] = col.g; this.c[i * 4 + 2] = col.b; this.c[i * 4 + 3] = alpha;
  }
  end() {
    this.mesh.geometry.instanceCount = this.n;
    for (const [a, w] of this.attrs) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, this.n * w)); a.needsUpdate = true; }
  }
}

// Continuous camera-facing ribbons through sampled points: contrails and wingtip vortices.
const rVert = /* glsl */`
attribute vec3 prev;
attribute vec3 next;
attribute float side;
attribute float width;
attribute float alpha;
uniform vec2 res;
uniform float minPx;
uniform float fogFar;
varying float vAlpha;
varying float vSide;
void main() {
  vec4 vp = viewMatrix * vec4(position, 1.0);
  vec4 vq = viewMatrix * vec4(prev, 1.0);
  vec4 vn = viewMatrix * vec4(next, 1.0);
  float a = alpha * (1.0 - smoothstep(-28.0, -3.0, vp.z)) * (1.0 - smoothstep(fogFar * 0.45, fogFar, length(vp.xyz)));
  vp.z = min(vp.z, -1.0); vq.z = min(vq.z, -1.0); vn.z = min(vn.z, -1.0);
  vec4 c = projectionMatrix * vp, cq = projectionMatrix * vq, cn = projectionMatrix * vn;
  vec2 dir = cn.xy / cn.w * res - cq.xy / cq.w * res;
  dir = length(dir) > 1e-3 ? normalize(dir) : vec2(1.0, 0.0);
  float rpx = width * projectionMatrix[1][1] * res.y * 0.5 / c.w;
  float wpx = max(minPx, rpx);
  c.xy += vec2(-dir.y, dir.x) * side * wpx / res * c.w;
  gl_Position = c;
  vAlpha = a * clamp(rpx / minPx, 0.3, 1.0);
  vSide = side;
}`;
const rFrag = /* glsl */`
uniform vec3 color;
varying float vAlpha;
varying float vSide;
void main() {
  float e = 1.0 - vSide * vSide;
  gl_FragColor = vec4(color, vAlpha * (0.25 + 0.75 * e));
  #include <colorspace_fragment>
}`;

export const TRAIL = {
  contrail: { life: 5.5, w0: 0.6, w1: 6, a0: 0.42, dt: 0.05, cap: 112 },
  smoke: { life: 3.5, w0: 0.5, w1: 3.5, a0: 0.3, dt: 0.05, cap: 72 },
  tip: { life: 1.3, w0: 0.14, w1: 0.6, a0: 0.75, dt: 0.03, cap: 46 },
};

class Ribbons {
  constructor(scene, maxPts = 12000) {
    this.max = maxPts;
    this.strips = [];
    const g = new THREE.BufferGeometry();
    const f = (n) => new THREE.BufferAttribute(new Float32Array(maxPts * 2 * n), n).setUsage(THREE.DynamicDrawUsage);
    this.attrs = { position: f(3), prev: f(3), next: f(3), side: f(1), width: f(1), alpha: f(1) };
    for (const [k, a] of Object.entries(this.attrs)) g.setAttribute(k, a);
    this.index = new THREE.BufferAttribute(new Uint16Array(maxPts * 6), 1).setUsage(THREE.DynamicDrawUsage);
    g.setIndex(this.index);
    g.setDrawRange(0, 0);
    this.uniforms = { res: { value: new THREE.Vector2(1280, 720) }, minPx: { value: 1.3 }, fogFar: { value: 5000 }, color: { value: new THREE.Color(0xf4f7fa) } };
    this.mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({
      vertexShader: rVert, fragmentShader: rFrag, uniforms: this.uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    scene.add(this.mesh);
  }

  strip(kind) {
    const k = TRAIL[kind], n = k.cap;
    const s = { k, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), t: new Float32Array(n), a: new Float32Array(n),
      head: 0, n: 0, last: -1, live: true, hx: 0, hy: 0, hz: 0, ha: 0 };
    this.strips.push(s);
    return s;
  }

  // Moves the live end of a strip and drops a sample every k.dt seconds.
  feed(s, x, y, z, a, now) {
    s.hx = x; s.hy = y; s.hz = z; s.ha = a;
    if (now - s.last < s.k.dt) return;
    s.last = now;
    const i = (s.head + s.n) % s.k.cap;
    if (s.n === s.k.cap) s.head = (s.head + 1) % s.k.cap; else s.n++;
    s.x[i] = x; s.y[i] = y; s.z[i] = z; s.t[i] = now; s.a[i] = a;
  }

  build(now) {
    const A = this.attrs, P = A.position.array, Q = A.prev.array, N = A.next.array, S = A.side.array, W = A.width.array, L = A.alpha.array;
    const I = this.index.array;
    let v = 0, ii = 0;
    for (let si = this.strips.length - 1; si >= 0; si--) {
      const s = this.strips[si], k = s.k;
      while (s.n && now - s.t[s.head] > k.life) { s.head = (s.head + 1) % k.cap; s.n--; }
      if (!s.live && s.n === 0) { this.strips.splice(si, 1); continue; }
      const cnt = s.n + (s.live ? 1 : 0);
      if (cnt < 2 || v / 2 + cnt > this.max) continue;
      const base = v / 2;
      for (let j = 0; j < cnt; j++) {
        let x, y, z, t, a;
        if (j < s.n) { const i = (s.head + j) % k.cap; x = s.x[i]; y = s.y[i]; z = s.z[i]; t = now - s.t[i]; a = s.a[i]; }
        else { x = s.hx; y = s.hy; z = s.hz; t = 0; a = s.ha; }
        const u = Math.min(1, t / k.life);
        const w = k.w0 + (k.w1 - k.w0) * Math.sqrt(u);
        const al = k.a0 * a * (1 - u) * (1 - u) * Math.min(1, t / 0.12 + 0.15);
        for (let sd = -1; sd <= 1; sd += 2) {
          P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
          S[v] = sd; W[v] = w; L[v] = al;
          v++;
        }
      }
      // prev/next neighbours for each pair
      for (let j = 0; j < cnt; j++) {
        const cur = (base + j) * 2, pj = (base + Math.max(0, j - 1)) * 2, nj = (base + Math.min(cnt - 1, j + 1)) * 2;
        for (let o = 0; o < 2; o++) for (let c = 0; c < 3; c++) {
          Q[(cur + o) * 3 + c] = P[pj * 3 + c];
          N[(cur + o) * 3 + c] = P[nj * 3 + c];
        }
        if (j < cnt - 1) {
          const a = cur, b = cur + 1, c2 = cur + 2, d = cur + 3;
          I[ii++] = a; I[ii++] = b; I[ii++] = c2; I[ii++] = b; I[ii++] = d; I[ii++] = c2;
        }
      }
    }
    this.mesh.geometry.setDrawRange(0, ii);
    for (const a of Object.values(A)) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(1, v * a.itemSize)); a.needsUpdate = true; }
    this.index.clearUpdateRanges(); this.index.addUpdateRange(0, Math.max(1, ii)); this.index.needsUpdate = true;
  }

  clear() { this.strips.length = 0; this.mesh.geometry.setDrawRange(0, 0); }
}

// Expanding additive shells for explosions and sonic booms.
const shockVert = /* glsl */`
varying float vRim;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vRim = 1.0 - abs(dot(n, normalize(-mv.xyz)));
  gl_Position = projectionMatrix * mv;
}`;
const shockFrag = /* glsl */`
uniform vec3 color;
uniform float opacity;
varying float vRim;
void main() {
  gl_FragColor = vec4(color * pow(vRim, 3.0) * opacity, 1.0);
  #include <colorspace_fragment>
}`;

// Instanced low-poly balls for fireballs and smoke: they grow, drift, change color and shrink away.
const FIRE = [new THREE.Color(1.6, 1.45, 1.0), new THREE.Color(1.4, 0.62, 0.16), new THREE.Color(0.55, 0.13, 0.05)];
const SMOKE = [new THREE.Color(0.32, 0.3, 0.29), new THREE.Color(0.2, 0.19, 0.19)];
const _bc = new THREE.Color();
class Blobs {
  constructor(scene, max, mat) {
    this.items = [];
    this.max = max;
    this.mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), mat, max);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._e = new THREE.Euler();
  }
  add(x, y, z, vx, vy, vz, s0, s1, life, delay, kind) {
    if (this.items.length >= this.max) this.items.shift();
    this.items.push({ x, y, z, vx, vy, vz, s0, s1, life, t: -delay, kind, r: Math.random() * 6 });
  }
  update(dt) {
    let n = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const b = this.items[i];
      b.t += dt;
      if (b.t >= b.life) { this.items.splice(i, 1); continue; }
      if (b.t < 0) continue;
      const u = b.t / b.life, drag = Math.exp(-dt * (b.kind === 'fire' ? 3 : 0.8));
      b.vx *= drag; b.vy = b.vy * drag + (b.kind === 'smoke' ? 1.2 * dt : 0); b.vz *= drag;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      let s = b.s0 + (b.s1 - b.s0) * (1 - (1 - u) * (1 - u));
      if (u > 0.7) s *= 1 - (u - 0.7) / 0.3;
      if (b.kind === 'fire') {
        if (u < 0.35) _bc.lerpColors(FIRE[0], FIRE[1], u / 0.35); else _bc.lerpColors(FIRE[1], FIRE[2], (u - 0.35) / 0.65);
      } else _bc.lerpColors(SMOKE[0], SMOKE[1], u);
      this._m.compose(this._p.set(b.x, b.y, b.z), this._q.setFromEuler(this._e.set(b.r, b.r * 1.3, 0)), this._s.setScalar(Math.max(0.01, s)));
      this.mesh.setMatrixAt(n, this._m);
      this.mesh.setColorAt(n, _bc);
      n++;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
  clear() { this.items.length = 0; this.mesh.count = 0; }
}

const col = (h) => new THREE.Color(h);
export const COL = {
  fire: col(0xff7a1f), fireHot: col(0xffd27a), flash: col(0xfff4d6), spark: col(0xffc36b), smoke: col(0x37383a), smokeLight: col(0xa4a29e),
  dust: col(0xb59f7f), water: col(0xe8f4fa), vapor: col(0xffffff), flare: col(0xfff0c8), trail: col(0xdcdcdc),
  tracer: col(0xffb43c), tracerEnemy: col(0xff5a3c), streak: col(0xffffff),
};

const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;
const debrisGeo = new THREE.BoxGeometry(1, 0.25, 0.7);
const _n = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion();

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.add = new Pool(scene, 3000, true);
    this.alpha = new Pool(scene, 5000, false);
    this.streaks = new Streaks(scene, 1500);
    this.fireBlobs = new Blobs(scene, 160, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.smokeBlobs = new Blobs(scene, 220, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }));
    this.ribbons = new Ribbons(scene);
    this.debris = new THREE.InstancedMesh(debrisGeo, new THREE.MeshLambertMaterial({ color: 0x3a3836, flatShading: true }), 320);
    this.debris.count = 0;
    this.debris.frustumCulled = false;
    this.debris.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.debris);
    this.deb = [];
    this.parts = [];
    this.shocks = [];
    this.later = [];
    this.shake = 0;
    this.density = 1;
    this.time = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._e = new THREE.Euler();
    const sg = new THREE.IcosahedronGeometry(1, 2);
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(sg, new THREE.ShaderMaterial({
        vertexShader: shockVert, fragmentShader: shockFrag, uniforms: { color: { value: new THREE.Color() }, opacity: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      m.visible = false;
      m.renderOrder = 9;
      scene.add(m);
      this.shocks.push({ mesh: m, t: 0, life: 0, r: 0 });
    }
  }

  setQuality(q) { this.density = q === 'low' ? 0.45 : q === 'high' ? 1 : 0.75; }

  resize(w, h, camera, fadeFar) {
    const s = h / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    this.add.uniforms.scale.value = s;
    this.alpha.uniforms.scale.value = s;
    this.streaks.uniforms.res.value.set(w, h); this.streaks.uniforms.fadeFar.value = fadeFar;
    this.streaks.uniforms.minPx.value = Math.max(1.6, h / 420);
    this.ribbons.uniforms.res.value.set(w, h);
    this.ribbons.uniforms.fogFar.value = fadeFar;
    this.ribbons.uniforms.minPx.value = Math.max(1, h / 900);
  }

  addShake(a) { this.shake = Math.min(2.5, this.shake + a); }
  n(k) { return Math.max(1, Math.round(k * this.density)); }

  explosion(p, size = 1, vel = null) {
    const vx = vel ? vel.x * 0.3 : 0, vy = vel ? vel.y * 0.3 : 0, vz = vel ? vel.z * 0.3 : 0;
    for (let i = 0; i < this.n(24); i++) {
      const s = (8 + Math.random() * 10) * size;
      this.add.emit(p.x + rnd(3 * size), p.y + rnd(3 * size), p.z + rnd(3 * size), vx + rnd(18 * size), vy + rnd(18 * size), vz + rnd(18 * size),
        0.5 + Math.random() * 0.5, s, s * 2.4, Math.random() < 0.4 ? COL.fireHot : COL.fire, 0.9, 1.5, -2);
    }
    for (let i = 0; i < this.n(18); i++) {
      this.add.emit(p.x, p.y, p.z, vx + rnd(60), vy + rnd(60) + 10, vz + rnd(60), 0.6 + Math.random() * 0.8, 1.2, 0.4, COL.spark, 1, 0.8, 18);
    }
    for (let i = 0; i < this.n(16); i++) {
      const s = (10 + Math.random() * 12) * size;
      this.alpha.emit(p.x + rnd(4 * size), p.y + rnd(4 * size), p.z + rnd(4 * size), vx + rnd(8), vy + rnd(6) + 3, vz + rnd(8),
        2.5 + Math.random() * 2.5, s, s * 3.5, COL.smoke, 0.55, 0.6, -1.2);
    }
  }

  // The big one: flash, fireball, shockwave, sparks, burning debris, a smoke column and a few late pops.
  bigExplosion(p, vel, size = 1) {
    const vx = vel.x * 0.35, vy = vel.y * 0.35, vz = vel.z * 0.35;
    this.add.emit(p.x, p.y, p.z, vx, vy, vz, 0.22, 45 * size, 110 * size, COL.flash, 1);
    // solid low-poly fireball: hot blobs that cool to red, then a column of dark smoke balls
    for (let i = 0; i < 16; i++) {
      const sp = (8 + Math.random() * 22) * size;
      _a.set(rnd(1), rnd(1), rnd(1)).normalize();
      this.fireBlobs.add(p.x + _a.x * 4 * size, p.y + _a.y * 4 * size, p.z + _a.z * 4 * size, vx + _a.x * sp, vy + _a.y * sp + 4, vz + _a.z * sp,
        2 * size, (7 + Math.random() * 9) * size, 0.45 + Math.random() * 0.5, 0, 'fire');
    }
    for (let i = 0; i < 14; i++) {
      const sp = (3 + Math.random() * 8) * size;
      this.smokeBlobs.add(p.x + rnd(8 * size), p.y + rnd(6 * size), p.z + rnd(8 * size), vx * 0.3 + rnd(sp), vy * 0.3 + 3 + Math.random() * 5, vz * 0.3 + rnd(sp),
        3 * size, (9 + Math.random() * 12) * size, 3.5 + Math.random() * 3.5, 0.15 + Math.random() * 0.35, 'smoke');
    }
    for (let i = 0; i < this.n(26); i++) {
      const s = (12 + Math.random() * 16) * size, sp = 30 * size;
      this.add.emit(p.x + rnd(4 * size), p.y + rnd(4 * size), p.z + rnd(4 * size), vx + rnd(sp), vy + rnd(sp) + 6, vz + rnd(sp),
        0.7 + Math.random() * 0.9, s, s * 2.8, Math.random() < 0.45 ? COL.fireHot : COL.fire, 0.95, 1.6, -4);
    }
    for (let i = 0; i < this.n(60); i++) {
      this.add.emit(p.x, p.y, p.z, vx + rnd(140), vy + rnd(120) + 20, vz + rnd(140), 0.8 + Math.random() * 1.4, 1.6, 0.4, COL.spark, 1, 0.6, 22);
    }
    for (let i = 0; i < this.n(20); i++) {
      const s = (14 + Math.random() * 18) * size;
      this.alpha.emit(p.x + rnd(8 * size), p.y + rnd(8 * size), p.z + rnd(8 * size), vx * 0.5 + rnd(12), vy * 0.5 + rnd(8) + 5, vz * 0.5 + rnd(12),
        4 + Math.random() * 5, s, s * 4, COL.smoke, 0.6, 0.5, -1.5);
    }
    // shrapnel everywhere
    for (let i = 0; i < 50; i++) {
      if (this.deb.length >= 320) this.deb.shift();
      _a.set(rnd(1), rnd(1) + 0.3, rnd(1)).normalize();
      const sp = 30 + Math.random() * 110;
      this.deb.push({
        p: p.clone(), v: new THREE.Vector3(vel.x * 0.55 + _a.x * sp, vel.y * 0.55 + _a.y * sp, vel.z * 0.55 + _a.z * sp),
        r: new THREE.Vector3(rnd(12), rnd(12), rnd(12)), a: new THREE.Euler(rnd(3), rnd(3), rnd(3)),
        s: (0.35 + Math.random() * Math.random() * 2.2) * size, life: 5 + Math.random() * 5, puff: Math.random() * 0.2, fire: Math.random() < 0.35,
      });
    }
    this.shockwave(p, 70 * size, 0.55, COL.fireHot);
    for (let i = 0; i < 3; i++) {
      this.later.push({ t: 0.12 + Math.random() * 0.6, p: p.clone().add(_a.set(rnd(12 * size), rnd(10 * size), rnd(12 * size))).addScaledVector(vel, 0.2), size: size * (0.4 + Math.random() * 0.4), vel: vel.clone() });
    }
  }

  shockwave(p, radius, life, color, opacity = 1) {
    const s = this.shocks.find((x) => !x.mesh.visible) || this.shocks[0];
    s.mesh.visible = true; s.t = 0; s.life = life; s.r = radius; s.o = opacity;
    s.mesh.position.copy(p);
    s.mesh.material.uniforms.color.value.copy(color);
  }

  // A detached piece of airframe that tumbles, bounces along the terrain and burns where it stops.
  part(geometry, matrixWorld, vel, burn = true) {
    if (this.parts.length >= 24) { const old = this.parts.shift(); this.scene.remove(old.mesh); }
    const mesh = new THREE.Mesh(geometry, solid);
    matrixWorld.decompose(mesh.position, mesh.quaternion, mesh.scale);
    this.scene.add(mesh);
    const r = geometry.boundingSphere ? geometry.boundingSphere.radius : 3;
    this.parts.push({
      mesh, v: vel.clone().add(_a.set(rnd(25), 6 + Math.random() * 18, rnd(25))), w: new THREE.Vector3(rnd(3), rnd(3), rnd(5)),
      life: 14, rest: false, burn, puff: 0, r: Math.min(4, r * 0.25), hitT: 0,
    });
  }

  hit(p) {
    for (let i = 0; i < this.n(6); i++) this.add.emit(p.x, p.y, p.z, rnd(30), rnd(30), rnd(30), 0.28, 1.6, 0.3, COL.spark, 1, 2, 5);
    this.add.emit(p.x, p.y, p.z, 0, 0, 0, 0.06, 5, 3, COL.fireHot, 0.9);
    this.alpha.emit(p.x, p.y, p.z, 0, 0, 0, 0.9, 2, 7, COL.smoke, 0.5, 0, -1);
  }

  impact(p, water) {
    if (water) {
      for (let i = 0; i < this.n(4); i++) this.alpha.emit(p.x + rnd(1), p.y, p.z + rnd(1), rnd(3), 9 + Math.random() * 10, rnd(3), 0.9, 1.5, 4, COL.water, 0.85, 0.5, 18);
    } else {
      for (let i = 0; i < this.n(3); i++) this.alpha.emit(p.x + rnd(1), p.y + 0.5, p.z + rnd(1), rnd(4), 3 + Math.random() * 5, rnd(4), 1.3, 2, 8, COL.dust, 0.75, 1.5, 2);
      this.add.emit(p.x, p.y + 0.5, p.z, 0, 0, 0, 0.1, 5, 7, COL.spark, 0.9);
    }
  }

  // Heavy ground strike: dust ring, sparks, a burst of fire.
  groundHit(p, speed, size = 1) {
    const k = Math.min(1.5, speed / 60) * size;
    for (let i = 0; i < this.n(16); i++) {
      const a = Math.random() * Math.PI * 2, sp = 10 + Math.random() * 25;
      this.alpha.emit(p.x, p.y + 1, p.z, Math.cos(a) * sp * k, 3 + Math.random() * 8, Math.sin(a) * sp * k, 2 + Math.random() * 2, 4 * k, 16 * k, COL.dust, 0.7, 1.2, 1);
    }
    for (let i = 0; i < this.n(14); i++) this.add.emit(p.x, p.y + 1, p.z, rnd(40), 10 + Math.random() * 30, rnd(40), 0.6 + Math.random() * 0.6, 1.4, 0.4, COL.spark, 1, 0.5, 20);
    if (speed > 40) this.explosion(p, 0.45 * size);
  }

  splash(p, size = 1) {
    for (let i = 0; i < this.n(80); i++) {
      const a = Math.random() * Math.PI * 2, sp = 8 + Math.random() * 26;
      this.alpha.emit(p.x, p.y, p.z, Math.cos(a) * sp * size, (25 + Math.random() * 55) * size, Math.sin(a) * sp * size, 1.6 + Math.random() * 1.2, 4 * size, 14 * size, COL.water, 0.9, 0.3, 22);
    }
    for (let i = 0; i < this.n(16); i++) this.alpha.emit(p.x + rnd(8), p.y, p.z + rnd(8), rnd(6), 2, rnd(6), 3.5, 12 * size, 36 * size, COL.water, 0.55, 0.8, 0);
    this.shockwave(p, 40 * size, 0.6, COL.water, 0.5);
  }

  // Water kicked up under a plane flying very low over the sea.
  spray(x, y, z, vel, k) {
    for (let i = 0; i < this.n(3); i++) {
      this.alpha.emit(x + rnd(3), y, z + rnd(3), vel.x * 0.25 + rnd(6), 6 + Math.random() * 12 * k, vel.z * 0.25 + rnd(6), 1 + Math.random() * 0.6, 2, 7 + 6 * k, COL.water, 0.55 * k, 0.8, 14);
    }
  }
  dust(x, y, z, vel, k) {
    for (let i = 0; i < this.n(2); i++) {
      this.alpha.emit(x + rnd(3), y + 1, z + rnd(3), vel.x * 0.15 + rnd(5), 2 + Math.random() * 4, vel.z * 0.15 + rnd(5), 1.6, 3, 12 * k, COL.dust, 0.4 * k, 1, 0);
    }
  }

  // Vapor shroud near Mach 1, and a ring plus a pale shell when a plane goes through it.
  vaporCone(p, fwd, up, r) {
    _b.crossVectors(fwd, up);
    for (let i = 0; i < this.n(5); i++) {
      const a = Math.random() * Math.PI * 2, c = Math.cos(a) * r, s = Math.sin(a) * r;
      this.alpha.emit(p.x + up.x * c + _b.x * s, p.y + up.y * c + _b.y * s, p.z + up.z * c + _b.z * s, 0, 0, 0, 0.12, 1.4, 2.4, COL.vapor, 0.45, 0, 0);
    }
  }
  sonicBoom(p, vel) {
    _n.copy(vel).normalize();
    _a.set(0, 1, 0).cross(_n);
    if (_a.lengthSq() < 1e-4) _a.set(1, 0, 0);
    _a.normalize();
    _b.crossVectors(_n, _a);
    for (let i = 0; i < this.n(48); i++) {
      const t = (i / 48) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      const ox = _a.x * c + _b.x * s, oy = _a.y * c + _b.y * s, oz = _a.z * c + _b.z * s;
      this.alpha.emit(p.x + ox * 4, p.y + oy * 4, p.z + oz * 4, vel.x * 0.6 + ox * 60, vel.y * 0.6 + oy * 60, vel.z * 0.6 + oz * 60, 0.9, 3, 12, COL.vapor, 0.6, 2.5, 0);
    }
    this.shockwave(p, 55, 0.45, COL.vapor, 0.6);
  }

  smoke(p, v, dark, size = 1) {
    this.alpha.emit(p.x, p.y, p.z, v.x * 0.15 + rnd(1), v.y * 0.15 + rnd(1) + 1, v.z * 0.15 + rnd(1), 2.5, 2 * size, 9 * size, dark ? COL.smoke : COL.smokeLight, dark ? 0.6 : 0.35, 0.5, -0.5);
  }
  fire(p, v, size = 1) {
    this.add.emit(p.x, p.y, p.z, v.x * 0.1 + rnd(2), v.y * 0.1 + rnd(2), v.z * 0.1 + rnd(2), 0.35, 2.5 * size, 1 * size, COL.fire, 0.9, 1, 0);
  }
  vapor(p, v, strength) {
    this.alpha.emit(p.x, p.y, p.z, v.x * 0.9, v.y * 0.9, v.z * 0.9, 0.35, 0.6, 2.5, COL.vapor, 0.35 * strength, 3, 0);
  }
  missileTrail(p, v) {
    this.alpha.emit(p.x + rnd(0.3), p.y + rnd(0.3), p.z + rnd(0.3), v.x * 0.05 + rnd(1.5), v.y * 0.05 + rnd(1.5) + 0.5, v.z * 0.05 + rnd(1.5), 2.4, 1.5, 7, COL.trail, 0.5, 0.4, -0.3);
    this.add.emit(p.x, p.y, p.z, v.x * 0.2, v.y * 0.2, v.z * 0.2, 0.08, 2.4, 0.8, COL.fireHot, 1, 0, 0);
  }
  flare(p) {
    this.add.emit(p.x, p.y, p.z, 0, 0, 0, 0.12, 10, 4, COL.flare, 1, 0, 0);
    this.alpha.emit(p.x, p.y, p.z, rnd(1), rnd(1), rnd(1), 1.6, 1.5, 6, COL.smokeLight, 0.4, 0.6, -0.5);
  }

  update(dt, world) {
    this.time += dt;
    this.add.update(dt);
    this.alpha.update(dt);
    const groundAt = (x, z) => world.surfaceAt(x, z);
    for (let i = this.later.length - 1; i >= 0; i--) {
      const l = this.later[i];
      l.t -= dt;
      if (l.t <= 0) { this.explosion(l.p, l.size, l.vel); this.later.splice(i, 1); }
    }
    let n = 0;
    for (let i = this.deb.length - 1; i >= 0; i--) {
      const d = this.deb[i];
      d.life -= dt;
      d.v.y -= 9.81 * dt; d.v.multiplyScalar(1 - 0.15 * dt);
      d.p.addScaledVector(d.v, dt);
      d.a.x += d.r.x * dt; d.a.y += d.r.y * dt; d.a.z += d.r.z * dt;
      d.puff -= dt;
      if (d.puff <= 0) {
        d.puff = (d.fire ? 0.07 : 0.16) / this.density;
        this.smoke(d.p, d.v, true, d.fire ? 0.7 : 0.4);
        if (d.fire && d.life > 2) this.fire(d.p, d.v, 0.8);
      }
      const ground = groundAt(d.p.x, d.p.z);
      if (d.life <= 0 || d.p.y < ground) {
        if (d.p.y < ground) this.impact(d.p, false);
        this.deb.splice(i, 1);
        continue;
      }
      this._q.setFromEuler(d.a);
      this._m.compose(d.p, this._q, this._s.setScalar(d.s));
      this.debris.setMatrixAt(n++, this._m);
    }
    this.debris.count = n;
    this.debris.instanceMatrix.needsUpdate = true;
    this.updateParts(dt, world);
    this.fireBlobs.update(dt);
    this.smokeBlobs.update(dt);
    for (const s of this.shocks) {
      if (!s.mesh.visible) continue;
      s.t += dt;
      const u = s.t / s.life;
      if (u >= 1) { s.mesh.visible = false; continue; }
      s.mesh.scale.setScalar(2 + s.r * (1 - (1 - u) * (1 - u)));
      s.mesh.material.uniforms.opacity.value = (1 - u) * (1 - u) * 1.6 * s.o;
    }
    this.ribbons.build(this.time);
    this.shake *= Math.exp(-dt * 5);
  }

  updateParts(dt, world) {
    const water = world.map.water;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i], m = p.mesh, pos = m.position;
      p.life -= dt; p.hitT -= dt;
      if (!p.rest) {
        p.v.y -= 9.81 * dt;
        p.v.multiplyScalar(1 - 0.08 * dt);
        pos.addScaledVector(p.v, dt);
        _q.setFromEuler(this._e.set(p.w.x * dt, p.w.y * dt, p.w.z * dt));
        m.quaternion.multiply(_q);
        const g = world.groundAt(pos.x, pos.z);
        if (water !== null && g < water && pos.y < water) {
          this.splash(_a.set(pos.x, water, pos.z), 0.6);
          this.scene.remove(m); this.parts.splice(i, 1);
          continue;
        }
        if (pos.y < g + p.r) {
          // bounce off the local terrain slope
          const e = 2;
          _n.set(world.groundAt(pos.x - e, pos.z) - world.groundAt(pos.x + e, pos.z), 2 * e, world.groundAt(pos.x, pos.z - e) - world.groundAt(pos.x, pos.z + e)).normalize();
          const vn = p.v.dot(_n);
          const speed = p.v.length();
          pos.y = g + p.r;
          if (vn < 0) {
            p.v.addScaledVector(_n, -vn);
            p.v.multiplyScalar(0.72);
            p.v.addScaledVector(_n, -vn * 0.32);
            p.w.multiplyScalar(0.55).add(_a.set(rnd(2), rnd(2), rnd(2)));
            if (p.hitT <= 0 && -vn > 12) {
              p.hitT = 0.25;
              this.groundHit(pos, -vn + speed * 0.3, 0.8);
            }
          }
          if (speed < 7) { p.rest = true; p.life = Math.min(p.life, 9); p.v.set(0, 0, 0); }
        }
      } else if (p.life < 1.5) pos.y -= dt * 1.5;
      p.puff -= dt;
      if (p.burn && p.puff <= 0 && p.life > 1.5) {
        p.puff = (p.rest ? 0.12 : 0.04) / this.density;
        this.fire(pos, p.v, p.rest ? 2.2 : 1.4);
        this.alpha.emit(pos.x, pos.y + 1, pos.z, p.v.x * 0.1 + rnd(1), p.v.y * 0.1 + 3 + Math.random() * 3, p.v.z * 0.1 + rnd(1),
          p.rest ? 5 : 3, 3, p.rest ? 16 : 10, COL.smoke, p.rest ? 0.5 : 0.6, 0.3, p.rest ? -2 : -0.5);
      }
      if (p.life <= 0) { this.scene.remove(m); this.parts.splice(i, 1); }
    }
  }

  clear() {
    this.add.clear(); this.alpha.clear(); this.deb.length = 0; this.debris.count = 0; this.shake = 0;
    this.streaks.begin(); this.streaks.end();
    this.fireBlobs.clear(); this.smokeBlobs.clear();
    this.ribbons.clear();
    for (const p of this.parts) this.scene.remove(p.mesh);
    this.parts.length = 0;
    this.later.length = 0;
    for (const s of this.shocks) s.mesh.visible = false;
  }
}
