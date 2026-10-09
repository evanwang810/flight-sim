// Low-poly aircraft. Each airframe is baked into a few vertex-colored meshes (body, two wings, extras),
// so a plane costs about six draw calls. Local axes: -Z nose, +X right wing, +Y up. Units are meters.
import * as THREE from './three.js';

const C = { dark: 0x2b2e34, glass: 0x1f2c3a, metal: 0x8c9198, white: 0xe2e5e8 };

export const solid = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
const discMat = new THREE.MeshBasicMaterial({ color: 0x1a1a1a, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });
const flameMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });

function lathe(profile, seg, sx = 1, sy = 1) {
  const g = new THREE.LatheGeometry(profile.map(([y, r]) => new THREE.Vector2(r, y)), seg);
  g.rotateX(-Math.PI / 2);
  g.scale(sx, sy, 1);
  return g;
}
// planform in the XZ plane, extruded down by t and centred vertically
function plate(pts, t) {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z))), { depth: t, bevelEnabled: false });
  g.rotateX(Math.PI / 2);
  g.translate(0, t / 2, 0);
  return g;
}
// profile in the ZY plane, extruded sideways by t and centred on x = 0
function fin(pts, t) {
  const g = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y))), { depth: t, bevelEnabled: false });
  g.rotateY(-Math.PI / 2);
  g.translate(t / 2, 0, 0);
  return g;
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

// Collects parts with a color and transform, then bakes them into one non-indexed geometry.
class Parts {
  constructor(palette) { this.palette = palette; this.pos = []; this.col = []; }
  add(geo, color, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
    g.applyMatrix4(_m);
    const a = g.getAttribute('position').array;
    if (_m.determinant() < 0) {
      for (let i = 0; i < a.length; i += 9) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
    }
    _c.set(this.palette[color] ?? color);
    for (let i = 0; i < a.length; i++) { this.pos.push(a[i]); }
    for (let i = 0; i < a.length; i += 3) this.col.push(_c.r, _c.g, _c.b);
    g.dispose();
    return this;
  }
  // mirrored copy across x = 0
  pair(geo, color, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    this.add(geo, color, x, y, z, rx, ry, rz, sx, sy, sz);
    return this.add(geo, color, -x, y, z, rx, -ry, -rz, -sx, sy, sz);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

function missileGeo() {
  return new Parts({}).add(lathe([[-1.5, 0.1], [1.1, 0.12], [1.5, 0.0]], 6), C.white)
    .add(plate([[0, 1.0], [0.35, 1.3], [0.35, 1.5], [0, 1.5]], 0.03), C.dark, 0, 0, 0)
    .add(plate([[0, 1.0], [0.35, 1.3], [0.35, 1.5], [0, 1.5]], 0.03), C.dark, 0, 0, 0, 0, 0, Math.PI / 2)
    .add(plate([[0, 1.0], [0.35, 1.3], [0.35, 1.5], [0, 1.5]], 0.03), C.dark, 0, 0, 0, 0, 0, Math.PI)
    .add(plate([[0, 1.0], [0.35, 1.3], [0.35, 1.5], [0, 1.5]], 0.03), C.dark, 0, 0, 0, 0, 0, -Math.PI / 2)
    .geometry();
}
export const MISSILE_GEO = missileGeo();

function flameGeo(r, len, xs = [0]) {
  const p = new Parts({});
  for (const x of xs) {
    p.add(new THREE.ConeGeometry(r, len, 8, 1, true).rotateX(Math.PI / 2).translate(x, 0, len / 2), 0xff8a30);
    p.add(new THREE.ConeGeometry(r * 0.6, len * 0.6, 8, 1, true).rotateX(Math.PI / 2).translate(x, 0, len * 0.3), 0x9fc8ff);
  }
  return p.geometry();
}

function trainer(pal) {
  const body = new Parts(pal), wing = new Parts(pal);
  body.add(lathe([[-4.3, 0.12], [-2.6, 0.4], [-0.6, 0.64], [1.6, 0.68], [2.6, 0.56], [3.15, 0.38], [3.45, 0.0]], 8, 1, 1.12), 'body');
  body.add(new THREE.SphereGeometry(0.62, 8, 5), 'glass', 0, 0.48, 0.3, 0, 0, 0, 0.95, 0.6, 1.6);
  body.add(new THREE.ConeGeometry(0.24, 0.5, 8).rotateX(-Math.PI / 2), 'metal', 0, 0, -3.6);
  body.add(plate([[0, 3.2], [1.9, 3.45], [1.9, 4.1], [0, 4.25]], 0.1), 'body');
  body.add(plate([[0, 3.2], [1.9, 3.45], [1.9, 4.1], [0, 4.25]], 0.1), 'body', 0, 0, 0, 0, 0, 0, -1);
  body.add(fin([[3.0, 0.3], [4.3, 0.3], [4.3, 1.85], [3.8, 1.85]], 0.1), 'accent');
  body.pair(new THREE.BoxGeometry(0.08, 0.08, 2.6), 'dark', 1.4, 0.15, 0.2, 0, Math.PI / 2, 0.42);
  body.pair(new THREE.BoxGeometry(0.1, 0.9, 0.12), 'dark', 0.9, -0.85, 0.3, 0, 0, 0.4);
  body.pair(new THREE.CylinderGeometry(0.3, 0.3, 0.16, 8), 'dark', 1.15, -1.25, 0.3, 0, 0, Math.PI / 2);
  body.add(new THREE.CylinderGeometry(0.25, 0.25, 0.14, 8), 'dark', 0, -1.15, -2.4, 0, 0, Math.PI / 2);
  wing.add(plate([[0.45, -1.0], [5.3, -0.85], [5.3, 0.55], [0.45, 0.6]], 0.16), 'body', 0, 0.8, 0.1);
  wing.add(plate([[5.0, -0.86], [5.32, -0.86], [5.32, 0.56], [5.0, 0.56]], 0.18), 'accent', 0, 0.8, 0.1);
  const prop = new Parts(pal).add(new THREE.BoxGeometry(2.1, 0.16, 0.04), 'dark').geometry();
  return {
    body, wing, prop, propZ: -3.52, propR: 1.08,
    tips: [new THREE.Vector3(-5.3, 0.8, 0.4), new THREE.Vector3(5.3, 0.8, 0.4)],
    exhaust: [new THREE.Vector3(0.5, -0.4, -2.4)], guns: [new THREE.Vector3(-2.4, 0.6, -0.9), new THREE.Vector3(2.4, 0.6, -0.9)],
    pylons: [new THREE.Vector3(-2.0, 0.45, 0.2), new THREE.Vector3(2.0, 0.45, 0.2)], missileScale: 0.7, length: 8,
  };
}

function fighter(pal, swept) {
  const body = new Parts(pal), wing = new Parts(pal);
  body.add(lathe([[-7.4, 0.5], [-6.6, 0.72], [-3.5, 0.95], [0.5, 1.0], [3, 0.8], [5.2, 0.5], [6.9, 0.2], [8.0, 0.0]], 8, 1, 0.82), 'body');
  body.add(new THREE.SphereGeometry(0.55, 8, 5), 'glass', 0, 0.62, -3.6, 0, 0, 0, 0.95, 0.85, 2.6);
  body.add(new THREE.BoxGeometry(1.1, 0.7, 3.2), 'dark', 0, -0.62, -1.2);
  body.pair(plate([[0.6, 4.6], [2.9, 6.2], [2.9, 6.9], [0.6, 7.0]], 0.08), 'body', 0, 0, 0);
  body.add(fin([[3.4, 0.5], [6.9, 0.6], [7.3, 3.2], [6.2, 3.2]], 0.12), 'accent');
  body.add(new THREE.CylinderGeometry(0.5, 0.62, 1.1, 8, 1, true).rotateX(Math.PI / 2), 'dark', 0, 0, 7.7);
  let tips;
  if (swept) {
    wing.add(plate([[0.7, 0.6], [5.0, -1.2], [5.0, -0.2], [0.7, 3.2]], 0.14), 'body', 0, -0.1, 0);
    wing.add(plate([[4.7, -1.1], [5.02, -1.22], [5.02, -0.18], [4.7, -0.05]], 0.16), 'accent', 0, -0.1, 0);
    body.pair(plate([[0.6, -4.6], [2.2, -4.0], [2.2, -3.5], [0.6, -3.2]], 0.08), 'accent', 0, 0.2, 0);
    tips = [new THREE.Vector3(-5, -0.1, -0.7), new THREE.Vector3(5, -0.1, -0.7)];
  } else {
    wing.add(plate([[0.7, -1.6], [4.9, 2.5], [4.9, 3.3], [0.7, 3.4]], 0.14), 'body', 0, -0.1, 0);
    wing.add(plate([[4.6, 2.2], [4.92, 2.5], [4.92, 3.32], [4.6, 3.32]], 0.16), 'accent', 0, -0.1, 0);
    tips = [new THREE.Vector3(-4.9, -0.1, 2.9), new THREE.Vector3(4.9, -0.1, 2.9)];
  }
  return {
    body, wing, flame: flameGeo(0.45, 4.5), flameZ: 8.0,
    tips, exhaust: [new THREE.Vector3(0, 0, 8.3)], guns: [new THREE.Vector3(0.7, 0.3, -5.5)],
    pylons: [new THREE.Vector3(-2.6, -0.42, swept ? 0.8 : 1.6), new THREE.Vector3(2.6, -0.42, swept ? 0.8 : 1.6)], missileScale: 1, length: 15,
  };
}

function lancer(pal) {
  const body = new Parts(pal), wing = new Parts(pal);
  body.add(lathe([[-11.2, 0.95], [-9, 1.2], [-4, 1.3], [2, 1.2], [6, 0.95], [9, 0.6], [11.5, 0.24], [13.4, 0.0]], 10, 1, 0.85), 'body');
  body.add(new THREE.SphereGeometry(0.55, 8, 5), 'glass', 0, 0.78, -6.6, 0, 0, 0, 0.85, 0.75, 2.6);
  body.pair(new THREE.BoxGeometry(0.7, 1.0, 6.5), 'dark', 1.15, -0.25, 1.5);
  body.pair(new THREE.CylinderGeometry(0.62, 0.7, 1.4, 8, 1, true).rotateX(Math.PI / 2), 'dark', 0.62, -0.05, 11.4);
  body.add(fin([[4.4, 0.7], [10.4, 0.8], [11.4, 4.8], [9.0, 4.8]], 0.14), 'accent');
  body.pair(plate([[0.7, -7.6], [2.3, -6.6], [2.3, -6.1], [0.7, -6.0]], 0.08), 'accent', 0, 0.1, 0);
  wing.add(plate([[0.8, -3.2], [6.4, 6.6], [6.4, 7.8], [0.8, 8.6]], 0.16), 'body', 0, -0.25, 0);
  wing.add(plate([[5.4, 4.8], [6.42, 6.6], [6.42, 7.82], [5.4, 7.95]], 0.18), 'accent', 0, -0.25, 0);
  return {
    body, wing, flame: flameGeo(0.55, 6, [-0.62, 0.62]), flameZ: 11.9,
    tips: [new THREE.Vector3(-6.4, -0.25, 7.2), new THREE.Vector3(6.4, -0.25, 7.2)],
    exhaust: [new THREE.Vector3(-0.62, -0.05, 12.3), new THREE.Vector3(0.62, -0.05, 12.3)], guns: [new THREE.Vector3(0.9, 0.35, -8.5)],
    pylons: [new THREE.Vector3(-3.0, -0.55, 4.5), new THREE.Vector3(3.0, -0.55, 4.5)], missileScale: 1.1, length: 25,
  };
}

function blackbird(pal) {
  const body = new Parts(pal), wing = new Parts(pal);
  body.add(lathe([[-15.5, 0.7], [-12, 1.25], [-5, 1.5], [2, 1.45], [8, 1.2], [12, 0.75], [15.5, 0.25], [17.4, 0.0]], 10, 1, 0.62), 'body');
  body.add(new THREE.SphereGeometry(0.5, 8, 5), 'glass', 0, 0.62, -11.2, 0, 0, 0, 0.8, 0.6, 2.4);
  // chines: the flat knife edges running down the nose
  body.pair(plate([[0.6, -16.5], [1.9, -9], [2.4, -3], [1.2, 2]], 0.1), 'body', 0, 0.05, 0);
  wing.add(plate([[1.2, -2.5], [9.2, 9.6], [9.2, 11.2], [1.2, 12.2]], 0.16), 'body', 0, -0.05, 0);
  // nacelle with its inlet spike, and an inward-canted fin on top
  wing.add(new THREE.CylinderGeometry(1.15, 1.25, 18, 10).rotateX(Math.PI / 2), 'body', 4.4, 0, 3.6);
  wing.add(new THREE.ConeGeometry(0.75, 3.2, 10).rotateX(-Math.PI / 2), 'metal', 4.4, 0, -6.9);
  wing.add(new THREE.CylinderGeometry(1.0, 0.95, 1.2, 10, 1, true).rotateX(Math.PI / 2), 'dark', 4.4, 0, 13.1);
  wing.add(fin([[7.2, 0.6], [12.4, 0.6], [12.8, 4.6], [10.6, 4.6]], 0.14), 'accent', 4.4, 0.6, 0, 0, 0, 0.26);
  return {
    body, wing, flame: flameGeo(0.95, 9, [-4.4, 4.4]), flameZ: 13.6,
    tips: [new THREE.Vector3(-9.2, -0.05, 10.8), new THREE.Vector3(9.2, -0.05, 10.8)],
    exhaust: [new THREE.Vector3(-4.4, 0, 14), new THREE.Vector3(4.4, 0, 14)], guns: [new THREE.Vector3(0.9, 0.2, -12)],
    pylons: [new THREE.Vector3(-2.2, -0.75, 3), new THREE.Vector3(2.2, -0.75, 3)], missileScale: 1.1, length: 33,
  };
}

function airliner(pal) {
  const body = new Parts(pal), wing = new Parts(pal);
  body.add(lathe([[-19.4, 0.35], [-16, 1.5], [-11, 2.05], [12, 2.05], [15.3, 1.8], [17.5, 1.1], [18.8, 0.2], [19.1, 0]], 12), 'body');
  body.pair(new THREE.BoxGeometry(0.06, 0.32, 26), 'glass', 2.0, 0.55, 0.5);
  body.add(new THREE.BoxGeometry(2.2, 0.45, 0.9), 'glass', 0, 0.75, -16.4, -0.35);
  body.add(new THREE.BoxGeometry(4.0, 0.5, 9), 'accent', 0, -1.7, 0.5);
  body.pair(plate([[0.8, 13.6], [7, 17.6], [7, 19.0], [0.8, 18.0]], 0.22), 'body', 0, 0.5, 0);
  body.add(fin([[11.5, 1.4], [18.8, 1.2], [19.6, 9.5], [16.4, 9.5]], 0.3), 'accent');
  wing.add(plate([[1.6, -3.8], [17.5, 4.6], [17.5, 6.4], [1.6, 3.8]], 0.38), 'body', 0, -0.9, 0);
  wing.add(fin([[4.6, 0], [6.4, 0], [6.6, 2.2], [5.8, 2.2]], 0.15), 'accent', 17.5, -0.9, 0);
  wing.add(new THREE.CylinderGeometry(1.05, 0.85, 4.4, 10).rotateX(Math.PI / 2), 'accent', 6.6, -2.2, -2.6);
  wing.add(new THREE.CircleGeometry(0.95, 10), 'dark', 6.6, -2.2, -4.82, 0, Math.PI);
  return {
    body, wing,
    tips: [new THREE.Vector3(-17.3, -0.8, 5.5), new THREE.Vector3(17.3, -0.8, 5.5)],
    exhaust: [new THREE.Vector3(-6.6, -2.2, 0), new THREE.Vector3(6.6, -2.2, 0)], guns: [new THREE.Vector3(0, -1.6, -17.5)],
    pylons: [new THREE.Vector3(-10, -1.6, 1.5), new THREE.Vector3(10, -1.6, 1.5)], missileScale: 1.4, length: 38,
  };
}

// Splits a baked body into nose and tail halves (by triangle centroid) for breakups.
function split(g) {
  const pos = g.getAttribute('position').array, col = g.getAttribute('color').array;
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < pos.length; i += 3) { lo = Math.min(lo, pos[i]); hi = Math.max(hi, pos[i]); }
  const mid = (lo + hi) / 2;
  const out = [[[], []], [[], []]];
  for (let i = 0; i < pos.length; i += 9) {
    const k = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3 < mid ? 0 : 1;
    for (let j = 0; j < 9; j++) { out[k][0].push(pos[i + j]); out[k][1].push(col[i + j]); }
  }
  return out.map(([p, c]) => {
    const h = new THREE.BufferGeometry();
    h.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    h.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    h.computeBoundingSphere();
    return h;
  });
}

const BUILD = { trainer, fighter: (p) => fighter(p, false), sandbox: (p) => fighter(p, true), airliner, lancer, blackbird };
const cache = new Map();

function geometries(type, color) {
  const key = type + color;
  if (cache.has(key)) return cache.get(key);
  const c = new THREE.Color(color), hsl = {};
  c.getHSL(hsl);
  const accent = new THREE.Color().setHSL(hsl.h, Math.min(1, hsl.s * 1.1), hsl.l * 0.55);
  const pal = { body: c.getHex(), accent: accent.getHex(), ...C };
  const d = (BUILD[type] || BUILD.fighter)(pal);
  const wingR = d.wing.geometry();
  const wingL = wingR.clone().applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  const a = wingL.getAttribute('position').array;
  for (let i = 0; i < a.length; i += 9) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
  const body = d.body.geometry();
  const out = { ...d, body, wingL, wingR, halves: split(body) };
  if (cache.size > 40) cache.clear();
  cache.set(key, out);
  return out;
}

export class PlaneModel {
  constructor(type, color) {
    const d = geometries(type, color);
    this.info = d;
    this.root = new THREE.Group();
    this.body = new THREE.Mesh(d.body, solid);
    this.wingL = new THREE.Mesh(d.wingL, solid);
    this.wingR = new THREE.Mesh(d.wingR, solid);
    this.root.add(this.body, this.wingL, this.wingR);
    this.missiles = d.pylons.map((p) => {
      const m = new THREE.Mesh(MISSILE_GEO, solid);
      m.position.copy(p); m.scale.setScalar(d.missileScale);
      this.root.add(m);
      return m;
    });
    if (d.prop) {
      this.prop = new THREE.Mesh(d.prop, solid);
      this.prop.position.z = d.propZ;
      this.disc = new THREE.Mesh(new THREE.CircleGeometry(d.propR, 16), discMat);
      this.disc.position.z = d.propZ - 0.02;
      this.root.add(this.prop, this.disc);
    }
    if (d.flame) {
      this.flame = new THREE.Mesh(d.flame, flameMat);
      this.flame.position.z = d.flameZ;
      this.root.add(this.flame);
    }
    this.t = Math.random() * 10;
  }

  setMissiles(n) { this.missiles.forEach((m, i) => { m.visible = i < n; }); }

  setWings(l, r) { this.wingL.visible = l; this.wingR.visible = r; }

  update(dt, throttle, ab) {
    this.t += dt;
    if (this.prop) this.prop.rotation.z += dt * (6 + throttle * 34);
    if (this.flame) {
      const flick = 0.92 + Math.sin(this.t * 47) * 0.05 + Math.sin(this.t * 31) * 0.04;
      const k = ab > 0.05 ? (0.55 + ab * 0.65) * flick : Math.max(0, throttle - 0.55) * 0.5;
      this.flame.visible = k > 0.02;
      this.flame.scale.set(0.8 + ab * 0.3, 0.8 + ab * 0.3, k);
    }
  }

  dispose() { if (this.disc) this.disc.geometry.dispose(); }
}

const glassMat = new THREE.MeshBasicMaterial({ color: 0x9fe0c0, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide });
const _bq = new THREE.Quaternion(), _bz = new THREE.Vector3(0, 0, 1), _be = new THREE.Euler();

// Box from a to b (local coords) with a square cross section.
function beam(parts, color, a, b, t) {
  const d = new THREE.Vector3().subVectors(b, a), len = d.length();
  _be.setFromQuaternion(_bq.setFromUnitVectors(_bz, d.normalize()));
  parts.add(new THREE.BoxGeometry(t, t, len), color, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, _be.x, _be.y, _be.z);
}

// First-person cockpit around the eye point: glare shield, panel with screens, consoles, canopy frame.
export function buildCockpit(type) {
  const k = type === 'airliner' ? 1.45 : type === 'trainer' ? 1.15 : 1;
  const v = (x, y, z) => new THREE.Vector3(x * k, y * k, z * k);
  const p = new Parts({ frame: 0x25282d, dash: 0x16181b, panel: 0x2b2f35, screen: 0x24584c, amber: 0x8a6a2a, trim: 0x3a3f46 });
  p.add(new THREE.BoxGeometry(1.3 * k, 0.1 * k, 0.5 * k), 'dash', 0, -0.36 * k, -0.95 * k);
  p.add(new THREE.BoxGeometry(1.2 * k, 0.46 * k, 0.06 * k), 'panel', 0, -0.62 * k, -0.8 * k);
  for (const [x, y, c] of [[-0.38, -0.56, 'screen'], [-0.13, -0.62, 'screen'], [0.13, -0.62, 'screen'], [0.38, -0.56, 'amber']]) {
    p.add(new THREE.BoxGeometry(0.19 * k, 0.14 * k, 0.02 * k), c, x * k, y * k, -0.765 * k);
  }
  p.pair(new THREE.BoxGeometry(0.24 * k, 0.1 * k, 1.3 * k), 'panel', 0.55 * k, -0.64 * k, -0.15 * k);
  p.pair(new THREE.BoxGeometry(0.06 * k, 0.06 * k, 1.9 * k), 'frame', 0.64 * k, -0.33 * k, -0.25 * k);
  beam(p, 'frame', v(-0.62, -0.32, -1.05), v(-0.2, 0.32, -0.9), 0.055 * k);
  beam(p, 'frame', v(0.62, -0.32, -1.05), v(0.2, 0.32, -0.9), 0.055 * k);
  beam(p, 'frame', v(-0.2, 0.32, -0.9), v(0.2, 0.32, -0.9), 0.055 * k);
  beam(p, 'trim', v(-0.2, 0.32, -0.9), v(-0.12, 0.42, 0.1), 0.04 * k);
  beam(p, 'trim', v(0.2, 0.32, -0.9), v(0.12, 0.42, 0.1), 0.04 * k);
  if (type === 'airliner') beam(p, 'frame', v(0, -0.32, -1.05), v(0, 0.32, -0.9), 0.07 * k);
  // HUD combiner on top of the glare shield
  p.add(new THREE.BoxGeometry(0.03 * k, 0.03 * k, 0.12 * k), 'frame', -0.17 * k, -0.24 * k, -0.86 * k);
  p.add(new THREE.BoxGeometry(0.03 * k, 0.03 * k, 0.12 * k), 'frame', 0.17 * k, -0.24 * k, -0.86 * k);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(p.geometry(), solid));
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.34 * k, 0.24 * k), glassMat);
  glass.position.set(0, -0.15 * k, -0.86 * k);
  glass.rotation.x = -0.15;
  g.add(glass);
  return g;
}
