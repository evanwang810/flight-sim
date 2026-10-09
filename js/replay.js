// Match recording and playback. The recorder samples every plane at 10 Hz; playback re-drives the same
// planes through the game so trails, tracers and explosions look like the real thing, and draws each
// pilot's whole flight path.
import * as THREE from './three.js';
import { MISSILE_GEO, solid } from './models.js';

const RATE = 0.1;
const MAX_T = 30 * 60;
const PS = 11; // t x y z qx qy qz qw flags throttle ab
const $ = (id) => document.getElementById(id);

class Grow {
  constructor(stride) { this.stride = stride; this.a = new Float32Array(stride * 512); this.n = 0; }
  slot() {
    if ((this.n + 1) * this.stride > this.a.length) { const b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b; }
    return this.n++ * this.stride;
  }
  trim() { return this.a.slice(0, this.n * this.stride); }
}

export class Recorder {
  constructor(game, o) {
    this.game = game;
    this.info = { map: o.map, mode: o.mode, myId: o.myId || 'me' };
    this.last = -1; this.t = 0;
    this.planes = new Map(); this.missiles = new Map(); this.events = [];
  }

  sample(time) {
    if (time - this.last < RATE || time > MAX_T) return;
    this.last = time; this.t = time;
    for (const p of this.game.planeList) {
      let tr = this.planes.get(p.id);
      if (!tr) {
        tr = { id: p.id, name: p.name, load: { ...p.load }, me: p.isMe, s: new Grow(PS) };
        this.planes.set(p.id, tr);
      }
      const a = p.air, o = tr.s.slot(), s = tr.s.a;
      s[o] = time; s[o + 1] = a.pos.x; s[o + 2] = a.pos.y; s[o + 3] = a.pos.z;
      s[o + 4] = a.quat.x; s[o + 5] = a.quat.y; s[o + 6] = a.quat.z; s[o + 7] = a.quat.w;
      s[o + 8] = (p.alive ? 1 : 0) | (p.trigger ? 2 : 0) | (p.hp.wl <= 0 ? 4 : 0) | (p.hp.wr <= 0 ? 8 : 0);
      s[o + 9] = a.throttle; s[o + 10] = a.ab;
    }
    for (const m of this.game.combat.missiles) {
      let tr = this.missiles.get(m.id);
      if (!tr) { tr = { id: m.id, s: new Grow(4) }; this.missiles.set(m.id, tr); }
      const o = tr.s.slot(), s = tr.s.a;
      s[o] = time; s[o + 1] = m.pos.x; s[o + 2] = m.pos.y; s[o + 3] = m.pos.z;
    }
  }

  event(type, p, extra) {
    if (this.game.time > MAX_T) return;
    this.events.push({ t: this.game.time, type, id: p.id, extra, pos: p.air.pos.toArray(), vel: p.air.vel.toArray() });
  }

  finish() {
    if (this.t < 3) return null;
    return {
      ...this.info, duration: this.t, events: this.events,
      planes: [...this.planes.values()].map((t) => ({ id: t.id, name: t.name, load: t.load, me: t.me, s: t.s.trim() })),
      missiles: [...this.missiles.values()].map((t) => ({ id: t.id, s: t.s.trim() })),
    };
  }
}

// Wide camera-facing line through a whole flight path; the part already flown is bright.
const pathVert = /* glsl */`
attribute vec3 prev;
attribute vec3 next;
attribute float side;
attribute float ptime;
uniform vec2 res;
uniform float now;
varying float vAlpha;
varying float vSide;
void main() {
  vec4 vp = viewMatrix * vec4(position, 1.0), vq = viewMatrix * vec4(prev, 1.0), vn = viewMatrix * vec4(next, 1.0);
  float behind = step(-1.0, vp.z);
  vp.z = min(vp.z, -1.0); vq.z = min(vq.z, -1.0); vn.z = min(vn.z, -1.0);
  vec4 c = projectionMatrix * vp, cq = projectionMatrix * vq, cn = projectionMatrix * vn;
  vec2 dir = cn.xy / cn.w * res - cq.xy / cq.w * res;
  dir = length(dir) > 1e-3 ? normalize(dir) : vec2(1.0, 0.0);
  float wpx = max(2.4, 4.0 * projectionMatrix[1][1] * res.y * 0.5 / c.w);
  c.xy += vec2(-dir.y, dir.x) * side * wpx / res * c.w;
  gl_Position = c;
  vAlpha = (ptime <= now ? 0.9 : 0.16) * (1.0 - behind);
  vSide = side;
}`;
const pathFrag = /* glsl */`
uniform vec3 color;
varying float vAlpha;
varying float vSide;
void main() {
  gl_FragColor = vec4(color, vAlpha * (1.0 - 0.5 * vSide * vSide));
  #include <colorspace_fragment>
}`;

function pathMesh(s, color, res) {
  const n = s.length / PS;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const o = i * PS;
    if (!(s[o + 8] & 1)) { pts.push(null); continue; }
    pts.push([s[o + 1], s[o + 2], s[o + 3], s[o]]);
  }
  const P = [], Q = [], N = [], S = [], T = [], I = [];
  let run = [];
  const flush = () => {
    if (run.length > 1) {
      const base = P.length / 3;
      run.forEach((p, j) => {
        const q = run[Math.max(0, j - 1)], nx = run[Math.min(run.length - 1, j + 1)];
        for (const sd of [-1, 1]) { P.push(p[0], p[1], p[2]); Q.push(q[0], q[1], q[2]); N.push(nx[0], nx[1], nx[2]); S.push(sd); T.push(p[3]); }
        if (j < run.length - 1) { const a = base + j * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      });
    }
    run = [];
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p) { flush(); continue; }
    if (run.length && Math.hypot(p[0] - run[run.length - 1][0], p[2] - run[run.length - 1][2]) > 400) flush();
    run.push(p);
  }
  flush();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('prev', new THREE.Float32BufferAttribute(Q, 3));
  g.setAttribute('next', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('side', new THREE.Float32BufferAttribute(S, 1));
  g.setAttribute('ptime', new THREE.Float32BufferAttribute(T, 1));
  g.setIndex(P.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(I, 1) : new THREE.Uint16BufferAttribute(I, 1));
  const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
    vertexShader: pathVert, fragmentShader: pathFrag, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { color: { value: new THREE.Color(color) }, res, now: { value: 0 } },
  }));
  m.frustumCulled = false;
  m.renderOrder = 3;
  return m;
}

const FWD = new THREE.Vector3(0, 0, -1), _q0 = new THREE.Quaternion(), _q1 = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class Replay {
  constructor(game, data, res) {
    this.game = game; this.data = data;
    this.t = 0; this.speed = 1; this.playing = true; this.showPaths = true;
    this.ev = 0;
    this.cam = { yaw: 0.6, pitch: 0.25, dist: 0, drag: null };
    this.tracks = [];
    this.paths = [];
    this.res = res;
    for (const tr of data.planes) {
      const p = game.addPlane({ id: tr.id, name: tr.name, load: tr.load, owned: false });
      p.magnet = 0;
      p.alive = false;
      const path = pathMesh(tr.s, tr.load.color, res);
      game.scene.add(path);
      this.paths.push(path);
      this.tracks.push({ tr, p, i: 0, wl: false, wr: false });
    }
    const mine = this.tracks.find((k) => k.tr.me) || this.tracks[0];
    this.focus = mine ? mine.p : null;
    this.mmesh = data.missiles.map(() => { const m = new THREE.Mesh(MISSILE_GEO, solid); m.scale.setScalar(1.2); m.visible = false; game.scene.add(m); return m; });
    this.trailT = 0;
  }

  dispose() {
    for (const m of [...this.paths, ...this.mmesh]) { this.game.scene.remove(m); if (m.geometry !== MISSILE_GEO) m.geometry.dispose(); }
  }

  seek(t) {
    t = Math.max(0, Math.min(this.data.duration, t));
    const back = t < this.t - 0.05 || t > this.t + 1;
    this.t = t;
    if (back) {
      this.game.fx.clear();
      this.game.combat.clear();
      for (const k of this.tracks) { this.game.dropTrails(k.p); k.i = 0; k.p.alive = false; }
      this.ev = this.data.events.findIndex((e) => e.t > t);
      if (this.ev < 0) this.ev = this.data.events.length;
      this.place(true);
    }
  }

  // Interpolate every plane to the current time.
  place(jump = false) {
    const t = this.t;
    for (const k of this.tracks) {
      const s = k.tr.s, n = s.length / PS, p = k.p, a = p.air;
      if (!n || t < s[0]) { p.alive = false; continue; }
      let i = Math.min(k.i, n - 1);
      if (s[i * PS] > t) i = 0;
      while (i < n - 2 && s[(i + 1) * PS] <= t) i++;
      k.i = i;
      const o = i * PS, o2 = Math.min(n - 1, i + 1) * PS;
      const span = Math.max(1e-3, s[o2] - s[o]), u = Math.min(1, Math.max(0, (t - s[o]) / span));
      const was = p.alive;
      const alive = (s[o + 8] & 1) === 1 && t <= s[(n - 1) * PS] + 0.2;
      _v.set(s[o + 1], s[o + 2], s[o + 3]);
      _w.set(s[o2 + 1], s[o2 + 2], s[o2 + 3]);
      if (_v.distanceToSquared(_w) > 300 * 300 || jump) this.game.dropTrails(p);
      a.pos.lerpVectors(_v, _w, u);
      a.vel.subVectors(_w, _v).multiplyScalar(1 / span);
      if (a.vel.lengthSq() > 2000 * 2000) a.vel.set(0, 0, 0);
      a.speed = a.vel.length();
      _q0.set(s[o + 4], s[o + 5], s[o + 6], s[o + 7]); _q1.set(s[o2 + 4], s[o2 + 5], s[o2 + 6], s[o2 + 7]);
      a.quat.copy(_q0).slerp(_q1, u);
      a.throttle = s[o + 9]; a.ab = s[o + 10];
      p.trigger = alive && !!(s[o + 8] & 2) && this.playing;
      if (alive && !was) { p.model.setWings(!(s[o + 8] & 4), !(s[o + 8] & 8)); this.game.dropTrails(p); p.prevPos.copy(a.pos); }
      p.alive = alive;
    }
  }

  update(dt) {
    const g = this.game, ev = this.data.events;
    for (const k of this.tracks) k.p.prevPos.copy(k.p.air.pos);
    if (this.playing) {
      this.t += dt * this.speed;
      if (this.t >= this.data.duration) { this.t = this.data.duration; this.playing = false; }
    }
    this.place();
    while (this.ev < ev.length && ev[this.ev].t <= this.t) {
      const e = ev[this.ev++];
      const k = this.tracks.find((x) => x.tr.id === e.id);
      if (!k) continue;
      k.p.air.pos.fromArray(e.pos); k.p.air.vel.fromArray(e.vel);
      if (e.type === 'boom') { k.p.alive = true; g.explode(k.p, e.extra); }
      else if (e.type === 'wing') g.loseWing(k.p, e.extra);
    }
    // missiles straight from their tracks
    this.trailT -= dt;
    const puff = this.trailT <= 0 && this.playing;
    if (puff) this.trailT = 0.02;
    this.data.missiles.forEach((m, i) => {
      const s = m.s, n = s.length / 4, mesh = this.mmesh[i];
      if (n < 2 || this.t < s[0] || this.t > s[(n - 1) * 4]) { mesh.visible = false; return; }
      let j = 0;
      while (j < n - 2 && s[(j + 1) * 4] <= this.t) j++;
      const o = j * 4, o2 = (j + 1) * 4, u = Math.min(1, (this.t - s[o]) / Math.max(1e-3, s[o2] - s[o]));
      _v.set(s[o + 1], s[o + 2], s[o + 3]); _w.set(s[o2 + 1], s[o2 + 2], s[o2 + 3]);
      mesh.visible = true;
      mesh.position.lerpVectors(_v, _w, u);
      _w.sub(_v);
      if (_w.lengthSq() > 1e-6) mesh.quaternion.setFromUnitVectors(FWD, _w.normalize());
      if (puff) g.fx.missileTrail(mesh.position, _w.multiplyScalar(300));
    });
    for (const p of this.paths) { p.visible = this.showPaths; p.material.uniforms.now.value = this.t; }
  }

  updateCamera(cam, dt) {
    const c = this.cam;
    const f = this.focus;
    let target, dist;
    if (f) { target = f.air.pos; dist = c.dist || f.spec.cam.dist * 2.2; }
    else { target = _v.set(0, this.game.world.map.spawnAlt, 0); dist = c.dist || 5000; }
    if (!c.dist) c.dist = dist;
    cam.position.set(
      target.x + Math.cos(c.pitch) * Math.sin(c.yaw) * c.dist,
      target.y + Math.sin(c.pitch) * c.dist,
      target.z + Math.cos(c.pitch) * Math.cos(c.yaw) * c.dist,
    );
    const gnd = this.game.world.surfaceAt(cam.position.x, cam.position.z) + 3;
    if (cam.position.y < gnd) cam.position.y = gnd;
    cam.lookAt(target);
  }
}

// DOM controls for the replay overlay.
export class ReplayUI {
  constructor(canvas, onExit) {
    this.r = null;
    this.onExit = onExit;
    this.root = $('replay');
    $('rp-play').onclick = () => this.toggle();
    $('rp-exit').onclick = () => this.onExit();
    $('rp-paths').onclick = () => { if (!this.r) return; this.r.showPaths = !this.r.showPaths; this.sync(); };
    $('rp-seek').oninput = () => { if (this.r) this.r.seek($('rp-seek').value / 1000 * this.r.data.duration); };
    this.speeds = [0.25, 0.5, 1, 2, 4];
    $('rp-speed').innerHTML = '';
    for (const sp of this.speeds) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = `${sp}x`;
      b.onclick = () => { if (this.r) { this.r.speed = sp; this.sync(); } };
      $('rp-speed').appendChild(b);
    }
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.r) return;
      this.r.cam.drag = [e.clientX, e.clientY];
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const r = this.r;
      if (!r || !r.cam.drag) return;
      r.cam.yaw -= (e.clientX - r.cam.drag[0]) * 0.006;
      r.cam.pitch = Math.max(-0.4, Math.min(1.45, r.cam.pitch + (e.clientY - r.cam.drag[1]) * 0.005));
      r.cam.drag = [e.clientX, e.clientY];
    });
    canvas.addEventListener('pointerup', () => { if (this.r) this.r.cam.drag = null; });
    canvas.addEventListener('wheel', (e) => {
      if (!this.r) return;
      e.preventDefault();
      this.r.cam.dist = Math.max(12, Math.min(9000, this.r.cam.dist * Math.exp(e.deltaY * 0.0012)));
    }, { passive: false });
    addEventListener('keydown', (e) => {
      if (!this.r) return;
      if (e.code === 'Space') { e.preventDefault(); this.toggle(); }
      else if (e.code === 'ArrowLeft') this.r.seek(this.r.t - 5);
      else if (e.code === 'ArrowRight') this.r.seek(this.r.t + 5);
      else if (e.code === 'Escape') this.onExit();
      else if (/^Digit[0-9]$/.test(e.code)) {
        const i = +e.code.slice(5);
        this.r.focus = i === 0 ? null : this.r.tracks[i - 1]?.p || this.r.focus;
        this.r.cam.dist = 0;
        this.sync();
      }
    });
  }

  open(r) {
    this.r = r;
    this.root.hidden = false;
    const box = $('rp-pilots');
    box.innerHTML = '';
    const chip = (label, color, p, key) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<i></i><span></span>';
      b.firstChild.style.background = color;
      b.lastChild.textContent = `${key}  ${label}`;
      b.onclick = () => { r.focus = p; r.cam.dist = 0; this.sync(); };
      b._p = p;
      box.appendChild(b);
    };
    chip('Overview', 'transparent', null, 0);
    r.tracks.forEach((k, i) => { if (i < 9) chip(k.tr.me ? `${k.tr.name} (you)` : k.tr.name, k.tr.load.color, k.p, i + 1); });
    $('rp-dur').textContent = fmt(r.data.duration);
    this.sync();
  }

  close() { this.r = null; this.root.hidden = true; }

  toggle() {
    const r = this.r;
    if (!r) return;
    if (!r.playing && r.t >= r.data.duration) r.seek(0);
    r.playing = !r.playing;
    this.sync();
  }

  sync() {
    const r = this.r;
    if (!r) return;
    $('rp-play').textContent = r.playing ? 'Pause' : 'Play';
    $('rp-paths').textContent = r.showPaths ? 'Hide paths' : 'Show paths';
    [...$('rp-speed').children].forEach((b, i) => b.classList.toggle('on', this.speeds[i] === r.speed));
    for (const b of $('rp-pilots').children) b.classList.toggle('on', b._p === r.focus);
  }

  tick() {
    const r = this.r;
    if (!r) return;
    $('rp-time').textContent = fmt(r.t);
    if (document.activeElement !== $('rp-seek')) $('rp-seek').value = Math.round(r.t / r.data.duration * 1000);
    if (!r.playing && $('rp-play').textContent === 'Pause') this.sync();
  }
}
