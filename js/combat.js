// Bullets, missiles and flares. Bullets live in flat arrays; hits are decided by whoever owns the shot.
import * as THREE from './three.js';
import { MISSILE_GEO, solid } from './models.js';
import { COL } from './fx.js';

const MAX = 1400;
const BULLET_LIFE = 0.85;
const HIT_SCALE = 1.4; // generous hitboxes
const GRAV = 9.81;

const MISSILE = { burn: 2.4, accel: 150, top: 640, life: 7.5, gBurn: 24, gCoast: 13, gimbal: 1.2, fuse: 10 };
const FLARE_LIFE = 4;

const _inv = new THREE.Quaternion(), _a = new THREE.Vector3(), _b = new THREE.Vector3(), _d = new THREE.Vector3(),
  _v = new THREE.Vector3(), _t = new THREE.Vector3(), _q = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, -1),
  _pm = new THREE.Vector3(), _r0 = new THREE.Vector3(), _r1 = new THREE.Vector3();

// Earliest t in [0,1] where segment a->b enters sphere (c, r), or -1.
function segSphere(a, b, cx, cy, cz, r) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const fx = a.x - cx, fy = a.y - cy, fz = a.z - cz;
  const A = dx * dx + dy * dy + dz * dz, B = 2 * (fx * dx + fy * dy + fz * dz), Cc = fx * fx + fy * fy + fz * fz - r * r;
  if (Cc <= 0) return 0;
  if (A < 1e-9) return -1;
  const disc = B * B - 4 * A * Cc;
  if (disc < 0) return -1;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t >= 0 && t <= 1 ? t : -1;
}

export function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

// Where to point a gun so a round of speed `s` meets a target moving at constant velocity.
// Returns time of flight (or -1) and writes the aim direction into `out`.
export function leadDir(shooterPos, shooterVel, targetPos, targetVel, s, out) {
  const rx = targetPos.x - shooterPos.x, ry = targetPos.y - shooterPos.y, rz = targetPos.z - shooterPos.z;
  const wx = targetVel.x - shooterVel.x, wy = targetVel.y - shooterVel.y, wz = targetVel.z - shooterVel.z;
  const a = wx * wx + wy * wy + wz * wz - s * s, b = 2 * (rx * wx + ry * wy + rz * wz), c = rx * rx + ry * ry + rz * rz;
  let t;
  if (Math.abs(a) < 1e-6) t = -c / b;
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc), t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a);
    t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  }
  if (!(t > 0)) return -1;
  out.set(rx + wx * t, ry + wy * t + 0.5 * GRAV * t * t, rz + wz * t).normalize();
  return t;
}

export class Combat {
  constructor(game) {
    this.game = game;
    this.n = 0;
    this.p = new Float32Array(MAX * 3); this.v = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX); this.auth = new Uint8Array(MAX); this.owner = new Array(MAX);
    this.missiles = [];
    this.flares = [];
    this.meshes = [];
  }

  clear() {
    this.n = 0;
    for (const m of this.missiles) m.mesh.visible = false;
    this.missiles.length = 0;
    this.flares.length = 0;
  }

  bullet(owner, pos, vel, auth) {
    if (this.n >= MAX) return;
    const i = this.n++;
    this.p[i * 3] = pos.x; this.p[i * 3 + 1] = pos.y; this.p[i * 3 + 2] = pos.z;
    this.v[i * 3] = vel.x; this.v[i * 3 + 1] = vel.y; this.v[i * 3 + 2] = vel.z;
    this.life[i] = BULLET_LIFE; this.auth[i] = auth ? 1 : 0; this.owner[i] = owner;
  }

  remove(i) {
    const l = --this.n;
    if (i === l) return;
    for (let k = 0; k < 3; k++) { this.p[i * 3 + k] = this.p[l * 3 + k]; this.v[i * 3 + k] = this.v[l * 3 + k]; }
    this.life[i] = this.life[l]; this.auth[i] = this.auth[l]; this.owner[i] = this.owner[l];
  }

  // Forgiving gunnery: if a round is going to pass close to an enemy, bend it in. The capture radius grows
  // with the distance the round has flown, so long shots that are nearly right still connect.
  magnet(i, owner, planes, dt) {
    const i3 = i * 3, v = this.v;
    const px = this.p[i3], py = this.p[i3 + 1], pz = this.p[i3 + 2], vx = v[i3], vy = v[i3 + 1], vz = v[i3 + 2];
    const travel = (BULLET_LIFE - this.life[i]) * owner.spec.gun.vel;
    const R = (2 + travel * 0.024) * owner.magnet;
    let best = 1, bt = 0, mx = 0, my = 0, mz = 0;
    for (const pl of planes) {
      if (!pl.alive || pl === owner || (owner.team && pl.team === owner.team)) continue;
      const a = pl.air;
      const rx = a.pos.x - px, ry = a.pos.y - py, rz = a.pos.z - pz;
      const wx = vx - a.vel.x, wy = vy - a.vel.y, wz = vz - a.vel.z;
      const ww = wx * wx + wy * wy + wz * wz;
      const t = (rx * wx + ry * wy + rz * wz) / ww;
      if (t <= 0 || t > 0.6) continue;
      const ex = rx - wx * t, ey = ry - wy * t, ez = rz - wz * t;
      const k = Math.sqrt(ex * ex + ey * ey + ez * ez) / (R + pl.spec.hit.r * 0.25);
      if (k < best) { best = k; bt = t; mx = ex; my = ey; mz = ez; }
    }
    if (best >= 1) return;
    const g = Math.min(2 * dt / (bt * bt), 1 / bt);
    v[i3] += mx * g; v[i3 + 1] += my * g; v[i3 + 2] += mz * g;
  }

  // Segment from a (at frame start) to b (at frame end), tested in the plane's own moving frame.
  hitTest(pl, ax, ay, az, bx, by, bz, scale = HIT_SCALE) {
    const h = pl.spec.hit;
    _a.set(ax - pl.prevPos.x, ay - pl.prevPos.y, az - pl.prevPos.z);
    _b.set(bx - pl.air.pos.x, by - pl.air.pos.y, bz - pl.air.pos.z);
    if (segSphere(_a, _b, 0, 0, 0, h.r * scale) < 0) return null;
    _inv.copy(pl.air.quat).invert();
    _a.applyQuaternion(_inv); _b.applyQuaternion(_inv);
    let best = 2, part = null;
    for (const [z, r] of h.body) {
      const t = segSphere(_a, _b, 0, 0, z, r * scale);
      if (t >= 0 && t < best) { best = t; part = 'body'; }
    }
    if (pl.hp.wl > 0) { const t = segSphere(_a, _b, -h.wingX, 0, h.wingZ, h.wingR * scale); if (t >= 0 && t < best) { best = t; part = 'wl'; } }
    if (pl.hp.wr > 0) { const t = segSphere(_a, _b, h.wingX, 0, h.wingZ, h.wingR * scale); if (t >= 0 && t < best) { best = t; part = 'wr'; } }
    return part ? { part, t: best } : null;
  }

  missile(owner, target, id, pos, vel) {
    let mesh = this.meshes.find((m) => !m.visible);
    if (!mesh) {
      mesh = new THREE.Mesh(MISSILE_GEO, solid);
      mesh.scale.setScalar(1.2);
      this.game.scene.add(mesh);
      this.meshes.push(mesh);
    }
    mesh.visible = true;
    const m = { id, owner, target, origTarget: target, pos: pos.clone(), vel: vel.clone(), t: 0, mesh, guided: true, trail: 0 };
    this.missiles.push(m);
    return m;
  }

  flare(owner, pos, vel, seq) {
    const f = { owner, pos: pos.clone(), vel: vel.clone().multiplyScalar(0.6).add(_d.set(0, -12, 0)), life: FLARE_LIFE, alive: true, isFlare: true };
    f.vel.addScaledVector(_v.set(Math.random() - 0.5, 0, Math.random() - 0.5), 30);
    this.flares.push(f);
    // decoy any missile chasing this plane; the roll is deterministic so every client agrees
    for (const m of this.missiles) {
      if (m.target !== owner || !m.guided) continue;
      const d = m.pos.distanceTo(owner.air.pos);
      const p = d < 1800 ? 0.75 : 0.35;
      if (hash01(m.id + '/' + seq) < p) m.target = f;
    }
    return f;
  }

  update(dt) {
    const g = this.game, world = g.world, fx = g.fx, maxH = world.map.maxH + 30, waterY = world.map.water;
    const streaks = fx.streaks;
    streaks.begin();
    const planes = g.planeList;
    for (let i = 0; i < this.n;) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.remove(i); continue; }
      const i3 = i * 3;
      const ax = this.p[i3], ay = this.p[i3 + 1], az = this.p[i3 + 2];
      const owner0 = this.owner[i];
      if (owner0.magnet > 0 && this.life[i] < BULLET_LIFE - 0.03) this.magnet(i, owner0, planes, dt);
      this.v[i3 + 1] -= GRAV * dt;
      const bx = ax + this.v[i3] * dt, by = ay + this.v[i3 + 1] * dt, bz = az + this.v[i3 + 2] * dt;
      this.p[i3] = bx; this.p[i3 + 1] = by; this.p[i3 + 2] = bz;
      const owner = this.owner[i];
      let gone = false;
      if (this.auth[i]) {
        for (const pl of planes) {
          if (!pl.alive || pl === owner || (owner.team && pl.team === owner.team)) continue;
          const hit = this.hitTest(pl, ax, ay, az, bx, by, bz);
          if (hit) {
            _t.set(ax + (bx - ax) * hit.t, ay + (by - ay) * hit.t, az + (bz - az) * hit.t);
            g.bulletHit(owner, pl, hit.part, _t);
            gone = true;
            break;
          }
        }
      }
      if (!gone && by < maxH) {
        const ground = world.groundAt(bx, bz);
        if (waterY !== null && by < waterY && ground < waterY) { _t.set(bx, waterY, bz); fx.impact(_t, true); gone = true; }
        else if (by < ground) { _t.set(bx, ground, bz); fx.impact(_t, false); gone = true; }
      }
      if (gone) { this.remove(i); continue; }
      const sp = Math.hypot(this.v[i3], this.v[i3 + 1], this.v[i3 + 2]) || 1;
      const len = Math.min(24, (BULLET_LIFE - this.life[i]) * sp + 2) / sp;
      streaks.push(bx, by, bz, bx - this.v[i3] * len, by - this.v[i3 + 1] * len, bz - this.v[i3 + 2] * len,
        owner === g.me ? COL.tracer : COL.tracerEnemy, Math.min(1, this.life[i] * 4));
      i++;
    }
    streaks.end();

    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.life -= dt;
      f.vel.multiplyScalar(1 - 0.8 * dt); f.vel.y -= 9.81 * dt * 0.6;
      f.pos.addScaledVector(f.vel, dt);
      fx.flare(f.pos);
      if (f.life <= 0) { f.alive = false; this.flares.splice(i, 1); }
    }

    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.t += dt;
      const prev = _pm.copy(m.pos);
      let speed = m.vel.length();
      const fwd = _d.copy(m.vel).multiplyScalar(1 / Math.max(speed, 1));
      speed = m.t < MISSILE.burn ? Math.min(MISSILE.top, speed + MISSILE.accel * dt) : Math.max(120, speed - speed * 0.06 * dt - 4 * dt);

      // a decoyed missile re-acquires its original target if the flare burns out while it is still in view
      if (m.target && m.target.isFlare && !m.target.alive) {
        const o = m.origTarget;
        _t.copy(o.air.pos).sub(m.pos).normalize();
        m.target = o.alive && _t.dot(fwd) > Math.cos(0.6) ? o : null;
      }
      const tgt = m.target;
      const tpos = tgt ? (tgt.isFlare ? tgt.pos : tgt.air.pos) : null;
      if (m.guided && tgt && (tgt.isFlare || tgt.alive) && m.t > 0.15) {
        const tvel = tgt.isFlare ? tgt.vel : tgt.air.vel;
        const dist = _t.copy(tpos).sub(m.pos).length();
        const tti = dist / Math.max(200, speed);
        _t.copy(tpos).addScaledVector(tvel, Math.min(tti, 3) * 0.85).sub(m.pos).normalize();
        const off = Math.acos(Math.min(1, Math.max(-1, _t.dot(fwd))));
        if (off > MISSILE.gimbal) m.guided = false;
        else {
          const maxTurn = (m.t < MISSILE.burn ? MISSILE.gBurn : MISSILE.gCoast) * 9.81 / speed * dt;
          if (off > 1e-5) {
            const k = Math.min(1, maxTurn / off);
            fwd.lerp(_t, k).normalize();
          }
        }
      }
      m.vel.copy(fwd).multiplyScalar(speed);
      m.pos.addScaledVector(m.vel, dt);
      _q.setFromUnitVectors(_z, fwd);
      m.mesh.position.copy(m.pos);
      m.mesh.quaternion.copy(_q);
      m.trail -= dt;
      if (m.trail <= 0) { m.trail = 0.012 / fx.density; fx.missileTrail(m.pos, m.vel); }

      let boom = m.t > MISSILE.life;
      if (tgt && !tgt.isFlare && tgt.alive) {
        _r0.copy(prev).sub(tgt.prevPos); _r1.copy(m.pos).sub(tgt.air.pos);
        if (segSphere(_r0, _r1, 0, 0, 0, MISSILE.fuse + tgt.spec.hit.r * 0.4) >= 0) { boom = true; g.missileHit(m, tgt); }
      } else if (tgt && tgt.isFlare && m.pos.distanceTo(tgt.pos) < 12) boom = true;
      if (!boom && m.pos.y < world.surfaceAt(m.pos.x, m.pos.z)) boom = true;
      if (boom) {
        fx.explosion(m.pos, 0.6);
        g.sound('boom', m.pos, 0.6);
        m.mesh.visible = false;
        this.missiles.splice(i, 1);
      }
    }
  }

  // Missiles currently guiding on a plane.
  incoming(pl) {
    let best = null, bd = Infinity;
    for (const m of this.missiles) {
      if (m.target !== pl || !m.guided) continue;
      const d = m.pos.distanceTo(pl.air.pos);
      if (d < bd) { bd = d; best = m; }
    }
    return best ? { m: best, d: bd } : null;
  }
}
