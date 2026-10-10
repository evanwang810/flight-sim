// A running match: planes, controls, weapons, camera and mode rules. Networking stays in net.js;
// this module only calls this.net when it is online.
import * as THREE from './three.js';
import { Airframe } from './physics.js';
import { steer } from './pilot.js';
import { buildSpec, SKILLS, MISSILES, FLARES, RESPAWN_TIME, SOLO_LIVES, ARENAS, CEILING, MACH, WIND, BOT_NAMES } from './config.js';
import { PlaneModel, buildCockpit } from './models.js';
import { Combat, leadDir } from './combat.js';
import { COL } from './fx.js';
import { Recorder, Replay } from './replay.js';
import { ach } from './achievements.js';
import { think } from './ai.js';
import { input } from './input.js';
import { settings } from './settings.js';
import { audio } from './audio.js';

const STEP = 1 / 120;
const LOCK_TIME = 1.5, LOCK_CONE = 0.2, LOCK_RANGE = 3000;
const INTERP_DELAY = 110;
const UP = new THREE.Vector3(0, 1, 0);
const ENEMY_COLORS = ['#b84a3e', '#a8443f', '#c25e3c', '#9b3b45'];

const _v = new THREE.Vector3(), _f = new THREE.Vector3(), _u = new THREE.Vector3(), _t = new THREE.Vector3(), _d = new THREE.Vector3(),
  _ld = new THREE.Vector3(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _mz = new THREE.Vector3(), _vel = new THREE.Vector3(),
  _xa = new THREE.Vector3(1, 0, 0), _ya = new THREE.Vector3(0, 1, 0), _off = new THREE.Vector3(), _eul = new THREE.Euler(),
  _cr = new THREE.Vector3(), _cw = new THREE.Vector3(), _cn = new THREE.Vector3(), _cv = new THREE.Vector3(), _ct = new THREE.Vector3(),
  _cx = new THREE.Vector3(), _cp = new THREE.Vector3(), _ci = new THREE.Quaternion();

const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class Plane {
  constructor(game, o) {
    this.game = game;
    this.id = o.id;
    this.name = o.name || 'Pilot';
    this.team = o.team ?? o.id;
    this.isBot = !!o.bot;
    this.owned = !!o.owned;
    this.isMe = !!o.me;
    this.skill = SKILLS[o.skill] || SKILLS.normal;
    this.air = null;
    this.prevPos = new THREE.Vector3();
    this.ctrl = { pitch: 0, roll: 0, yaw: 0, throttle: 0.85, ab: false };
    this.alive = false;
    this.hp = { body: 0, wl: 0, wr: 0 };
    this.kills = 0; this.deaths = 0;
    this.life = 0; this.killedLife = -1; this.exploded = -1;
    this.lock = { target: null, t: 0, sent: 0, sendT: 0 };
    this.lockedOn = false;
    this.warnState = 0; this.warnT = 0;
    this.respawnT = 0; this.doomT = 0; this.fxT = 0; this.flareCd = 0;
    this.trigger = false; this.gunCd = 0; this.muzzle = 0; this.mseq = 0; this.flareSeq = 0;
    this.lastAttacker = null; this.lastAttackT = -99;
    this.net = { snaps: [], off: null };
    this.magnet = this.isBot ? this.skill.magnet : 1;
    this.gStress = 0; this.blackout = false;
    this.outT = 0; this.mach = 0; this.trails = null;
    this.setLoadout(o.load);
  }

  setLoadout(load) {
    this.load = { type: load.type, color: load.color, sb: load.sb };
    this.spec = buildSpec(load.type, load.sb);
    const pos = this.air ? this.air.pos.clone() : null;
    this.air = new Airframe(this.spec);
    if (pos) this.air.pos.copy(pos);
    if (this.model) this.game.scene.remove(this.model.root);
    this.model = new PlaneModel(load.type, load.color);
    this.model.root.visible = false;
    this.game.scene.add(this.model.root);
  }

  get maxHp() { return this.spec.hp; }
}

export class Game {
  constructor({ scene, camera, world, fx, hud }) {
    this.scene = scene; this.camera = camera; this.world = world; this.fx = fx; this.hud = hud;
    this.combat = new Combat(this);
    this.ach = ach;
    this.planes = new Map();
    this.planeList = [];
    this.mode = null;
    this.net = null;
    this.me = null;
    this.feed = [];
    this.wind = new THREE.Vector3();
    this.aim = new THREE.Quaternion();
    this.aimDir = new THREE.Vector3(0, 0, -1);
    this.cam = { view: 'chase', off: new THREE.Vector3(), kq: new THREE.Quaternion(), head: new THREE.Quaternion(), throttle: 0.85, orbit: 0, spectate: null, deathPos: new THREE.Vector3(), fov: 70, shake: 0 };
    // the cockpit interior lives in its own scene, drawn after the world with a tiny near plane
    this.cockpitScene = new THREE.Scene();
    this.cockpitSun = new THREE.DirectionalLight(0xffffff, 2);
    this.cockpitHemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.cockpitScene.add(this.cockpitSun, this.cockpitSun.target, this.cockpitHemi);
    this.cockpit = null; this.cockpitType = null; this.showCockpit = false;
    this.onEnd = null;
    this.paused = false;
    this.botSeq = 0;
  }

  // ---------- lifecycle ----------

  start(o) {
    this.stop();
    this.mode = o.mode;
    this.net = o.net || null;
    this.world.setMap(o.map);
    this.windBase = WIND[o.wind] ?? 0;
    this.windDir = o.windDir ?? Math.random() * Math.PI * 2;
    this.time = 0; this.acc = 0; this.over = false; this.paused = false;
    this.feed.length = 0;
    this.solo = { wave: 0, lives: SOLO_LIVES, nextWave: 3, active: false, overT: 0, kills: 0 };
    this.arenaR = o.mode === 'free' ? null : ARENAS[o.arena] || ARENAS.medium;
    this.ceiling = this.world.map.maxH + CEILING;
    this.recorder = new Recorder(this, o);
    this.world.setLimits(this.arenaR, this.ceiling);
    this.cam.view = 'chase';
    this.me = this.addPlane({ id: o.myId || 'me', name: o.name, load: o.load, owned: true, me: true, team: o.mode === 'dogfight' ? 'blue' : undefined });
    this.spawn(this.me);
    this.loading = true;
  }

  // Menu background: one plane drifting over the selected map with an orbiting camera.
  showcase(load, mapId) {
    this.stop();
    this.mode = 'menu';
    this.world.setMap(mapId);
    this.windBase = 0; this.time = 0; this.acc = 0; this.paused = false;
    this.arenaR = null; this.ceiling = 1e9; this.recorder = null;
    this.me = null;
    this.world.setLimits(null);
    this.show = this.addPlane({ id: 'show', name: '', load, owned: true, bot: true, skill: 'normal' });
    const alt = Math.max(this.world.map.spawnAlt * 0.75, this.world.groundAt(0, 0) + 260);
    this.resetPlane(this.show, _v.set(0, alt, 0), 0.3);
    this.cam.orbit = 0.6;
    this.loading = true;
  }

  // Plays back a recorded match through the same planes and effects.
  startReplay(data) {
    this.stop();
    this.mode = 'replay';
    this.world.setMap(data.map);
    this.windBase = 0; this.time = 0; this.acc = 0; this.paused = false; this.over = true;
    this.arenaR = null; this.ceiling = 1e9;
    this.world.setLimits(null);
    this.rp = new Replay(this, data, this.fx.ribbons.uniforms.res);
    this.rp.seek(0);
    this.loading = true;
    return this.rp;
  }

  stop() {
    if (this.recorder) { const d = this.recorder.finish(); if (d) this.lastReplay = d; this.recorder = null; }
    if (this.rp) { this.rp.dispose(); this.rp = null; }
    for (const p of this.planeList) { this.scene.remove(p.model.root); p.model.dispose(); }
    this.planes.clear();
    this.planeList.length = 0;
    this.combat.clear();
    this.fx.clear();
    this.mode = null; this.me = null; this.show = null; this.net = null;
    this.cam.spectate = null;
    audio.engine(false, 0, 0, 0, 'jet');
    audio.tone(0, 0);
  }

  addPlane(o) {
    if (this.planes.has(o.id)) return this.planes.get(o.id);
    const p = new Plane(this, o);
    this.planes.set(p.id, p);
    this.planeList.push(p);
    return p;
  }

  removePlane(id) {
    const p = this.planes.get(id);
    if (!p) return;
    this.scene.remove(p.model.root);
    p.model.dispose();
    this.planes.delete(id);
    this.planeList.splice(this.planeList.indexOf(p), 1);
    if (this.cam.spectate === p) this.cam.spectate = null;
    for (const q of this.planeList) if (q.lock.target === p) q.lock.target = null;
  }

  // ---------- spawning ----------

  spawnAlt(x, z) { return Math.max(this.world.map.spawnAlt, this.world.groundAt(x, z) + 350); }

  spawnPoint(out) {
    const a = Math.random() * Math.PI * 2, r = this.online ? 1700 + Math.random() * 700 : 1200;
    out.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    out.y = this.spawnAlt(out.x, out.z) + Math.random() * 150;
    return Math.atan2(out.x, out.z) + (Math.random() - 0.5) * 0.6;
  }

  get online() { return !!this.net; }

  resetPlane(p, pos, yaw) {
    p.air.reset(pos, yaw, p.spec.spawnSpeed ?? p.spec.trimSpeed * 1.05);
    p.gStress = 0; p.blackout = false;
    p.air.throttle = 0.85;
    p.ctrl.throttle = 0.85;
    p.prevPos.copy(pos);
    const hp = p.spec.hp;
    p.hp = { body: hp.body, wl: hp.wing, wr: hp.wing };
    p.ammo = p.spec.gun.mag; p.reload = 0; p.gunCd = 0;
    p.missiles = MISSILES; p.flares = FLARES;
    p.alive = true; p.life++; p.doomT = 0; p.respawnT = 0;
    p.lastAttacker = null; p.lastAttackT = -99;
    p.lock.target = null; p.lock.t = 0; p.lockedOn = false;
    p.model.setMissiles(MISSILES);
    p.model.setWings(true, true);
    p.model.root.visible = true;
    p.brain = null;
    p.outT = 0;
    this.dropTrails(p);
  }

  dropTrails(p) {
    if (!p.trails) return;
    for (const s of p.trails) s.live = false;
    p.trails = null;
  }

  spawn(p) {
    const yaw = this.spawnPoint(_v);
    this.resetPlane(p, _v, yaw);
    if (p.isMe) {
      this.aim.setFromAxisAngle(UP, yaw);
      this.cam.kq.copy(this.aim);
      this.cam.throttle = 0.85;
      this.cam.off.set(0, p.spec.cam.height, p.spec.cam.dist).applyQuaternion(this.aim);
    }
  }

  spawnWave(n) {
    const me = this.me;
    const count = Math.min(5, 1 + Math.floor((n - 1) / 2));
    const skill = ['easy', 'normal', 'easy', 'normal', 'normal', 'hard', 'hard', 'ace'][Math.min(n - 1, 7)];
    me.air.forward(_f);
    const heading = Math.atan2(_f.x, _f.z);
    for (let i = 0; i < count; i++) {
      let type = 'fighter';
      if (n % 5 === 0 && i === 0) type = 'airliner';
      else if (n >= 3 && i === count - 1 && n % 3 === 0) type = 'trainer';
      const id = 'bot' + (++this.botSeq);
      const p = this.addPlane({
        id, name: BOT_NAMES[(this.botSeq - 1) % BOT_NAMES.length], bot: true, owned: true, skill, team: 'red',
        load: { type, color: ENEMY_COLORS[i % ENEMY_COLORS.length] },
      });
      const h = heading + (Math.random() - 0.5) * 1.4, dist = 2300 + i * 350;
      _v.set(me.air.pos.x + Math.sin(h) * dist, 0, me.air.pos.z + Math.cos(h) * dist);
      const rr = Math.hypot(_v.x, _v.z), lim = this.arenaR * 0.75;
      if (rr > lim) { _v.x *= lim / rr; _v.z *= lim / rr; }
      _v.y = Math.min(this.ceiling - 400, Math.max(me.air.pos.y + (Math.random() - 0.4) * 300, this.world.groundAt(_v.x, _v.z) + 300));
      this.resetPlane(p, _v, Math.atan2(_v.x - me.air.pos.x, _v.z - me.air.pos.z));
    }
    this.solo.active = true;
    ach.event('wave', n);
    this.hud.toast(`Wave ${n}`, `${count} ${count === 1 ? 'enemy' : 'enemies'}, ${SKILLS[skill].name.toLowerCase()}`);
  }

  // ---------- main update ----------

  update(rawDt) {
    if (!this.mode) return;
    const dt = Math.min(rawDt, 0.05);
    const focus = this.me || this.show || (this.rp && (this.rp.focus || this.rp.tracks[0]?.p));
    if (!focus) return;
    if (this.loading) {
      this.world.update(dt, this.camera, 14);
      this.updateCamera(dt);
      if (this.world.readyNear(focus.air.pos.x, focus.air.pos.z, 1)) this.loading = false;
      return;
    }
    if (this.paused && !this.online) {
      this.world.update(0, this.camera, 1);
      return;
    }
    if (this.mode === 'replay') {
      this.rp.update(dt);
      for (const p of this.planeList) this.weapons(p, dt);
      this.combat.update(dt);
      for (const p of this.planeList) this.planeFx(p, dt);
      this.rp.updateCamera(this.camera, dt);
      this.setFov(62, dt);
      this.world.update(dt, this.camera, 2.5);
      this.fx.update(dt, this.world);
      return;
    }
    this.time += dt;
    for (const p of this.planeList) p.prevPos.copy(p.air.pos);
    const gust = this.windBase * (1 + 0.3 * Math.sin(this.time * 0.31) + 0.2 * Math.sin(this.time * 1.73));
    this.wind.set(Math.cos(this.windDir), 0, Math.sin(this.windDir)).multiplyScalar(gust);

    if (this.me) this.playerControl(dt);
    for (const p of this.planeList) {
      if (!p.alive || !p.owned || !p.isBot) continue;
      const act = think(p, this, dt);
      p.trigger = act.fire && this.mode !== 'menu';
      if (act.missile) this.fireMissile(p);
      if (act.flare) this.dropFlare(p);
    }

    for (const p of this.planeList) if (p.owned && p.alive) this.damageState(p);
    this.acc += dt;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      for (const p of this.planeList) {
        if (!p.alive || !p.owned) continue;
        p.air.step(STEP, p.ctrl, this.wind);
        this.contact(p, STEP);
      }
    }
    for (const p of this.planeList) {
      if (p.owned) { if (p.alive) this.limits(p, dt); }
      else this.interp(p);
    }
    if (this.show && !this.show.alive) this.resetPlane(this.show, _v.set(0, this.world.map.spawnAlt, 0), 0);
    if (this.mode !== 'menu') this.collidePlanes(dt);
    if (this.mode !== 'menu') {
      for (const p of this.planeList) this.weapons(p, dt);
      this.combat.update(dt);
    }
    for (const p of this.planeList) this.planeFx(p, dt);
    this.rules(dt);
    this.updateCamera(dt);
    this.world.update(dt, this.camera, 2.5);
    this.fx.update(dt, this.world);
    this.shrapnel();
    if (this.recorder) this.recorder.sample(this.time);
    if (this.me && this.me.alive && this.mode !== 'menu') ach.tick(this.me, this, dt);
    this.updateAudio();
  }

  // Damage feeds back into the flight model: a hurt engine coughs and stalls sooner, hurt wings wobble.
  damageState(p) {
    const a = p.air, hp = p.spec.hp;
    a.dmgEngine = clamp(1 - p.hp.body / hp.body, 0, 1);
    a.dmgL = p.hp.wl <= 0 ? 0 : clamp(1 - p.hp.wl / hp.wing, 0, 1);
    a.dmgR = p.hp.wr <= 0 ? 0 : clamp(1 - p.hp.wr / hp.wing, 0, 1);
    a.gLimit = !(p.isMe && !settings.ctl.assist);
    a.gHeavy = p.isMe ? clamp((p.gStress - 0.45) / 0.5, 0, 1) : 0;
  }

  // Ground and water contact for one physics step. Each contact point pushes back with an impulse; how hard
  // it hits decides the damage to that part, so a gentle touchdown on the gear is a landing and a nose-first
  // dive is not. Water drags hard and tears the airframe apart in about half a second.
  contact(p, h) {
    const a = p.air, info = p.model.info, w = this.world, water = w.map.water;
    const k2 = (info.length * 0.3) ** 2;
    _cw.set(a.q, -a.r, -a.p).applyQuaternion(a.quat);
    let lift = 0, wet = false, touched = false;
    for (const c of info.contacts) {
      if ((c[3] === 'wl' && p.hp.wl <= 0) || (c[3] === 'wr' && p.hp.wr <= 0)) continue;
      _cr.set(c[0], c[1], c[2]).applyQuaternion(a.quat);
      _cp.copy(a.pos).add(_cr);
      const g = w.groundAt(_cp.x, _cp.z);
      if (water !== null && _cp.y < water && g < water) { wet = true; continue; }
      const pen = g - _cp.y;
      if (pen <= 0) continue;
      touched = true;
      const e = 2;
      _cn.set(w.groundAt(_cp.x - e, _cp.z) - w.groundAt(_cp.x + e, _cp.z), 2 * e, w.groundAt(_cp.x, _cp.z - e) - w.groundAt(_cp.x, _cp.z + e)).normalize();
      _cv.copy(_cw).cross(_cr).add(a.vel);
      const vn = _cv.dot(_cn);
      if (vn < 0) {
        const gear = c[3] === 'gear';
        _cx.copy(_cr).cross(_cn);
        const denom = 1 + _cx.lengthSq() / k2;
        const j = -(1 + (gear ? 0.12 : 0.3)) * vn / denom;
        a.vel.addScaledVector(_cn, j);
        _cw.addScaledVector(_cx, j / k2);
        // friction: wheels roll unless the throttle is closed, everything else scrapes
        _ct.copy(_cv).addScaledVector(_cn, -vn);
        const vt = _ct.length();
        if (vt > 1e-3) {
          const mu = gear ? (p.ctrl.throttle < 0.08 ? 0.45 : 0.04) : 0.55;
          const jt = Math.min(mu * j, vt / denom);
          _ct.multiplyScalar(1 / vt);
          a.vel.addScaledVector(_ct, -jt);
          _cx.copy(_cr).cross(_ct);
          _cw.addScaledVector(_cx, -jt / k2);
        }
        const thr = gear ? 4.5 : 2;
        let dmg = j > thr ? (j - thr) ** 2 * 3 : 0;
        if (!gear && vt > 15) dmg += vt * h * 0.5;
        if (dmg > 0.01) {
          this.damage(p, gear ? 'body' : c[3], gear ? dmg * 0.6 : dmg, null, 'crash');
          if (dmg > 2 && Math.random() < 0.5) this.fx.groundHit(_cp, Math.min(80, j * 6), 0.4);
          else if (vt > 20 && Math.random() < 0.2) this.fx.impact(_cp, false);
          if (!p.alive) return;
        }
      }
      if (pen > lift) lift = pen;
    }
    a.pos.y += lift;
    p.grounded = touched;
    _ci.copy(a.quat).invert();
    _cw.applyQuaternion(_ci);
    a.q = _cw.x; a.r = -_cw.y; a.p = -_cw.z;
    if (wet) {
      a.vel.multiplyScalar(Math.exp(-h * 3.5));
      if (a.vel.y < 0) a.vel.y *= Math.exp(-h * 8);
      this.damage(p, 'body', p.spec.hp.body * 2.2 * h, null, 'water');
      if (Math.random() < 0.1) this.fx.splash(_cp.set(a.pos.x, water, a.pos.z), 0.25);
    }
  }

  // Mid-air collisions. Each machine only damages the planes it flies, so both sides of a collision agree
  // without any extra messages.
  collidePlanes(dt) {
    for (const p of this.planeList) {
      if (!p.owned || !p.alive) continue;
      p.bumpT = (p.bumpT || 0) - dt;
      if (p.bumpT > 0) continue;
      for (const q of this.planeList) {
        if (q === p || !q.alive) continue;
        const d = p.air.pos.distanceTo(q.air.pos);
        if (d > (p.spec.hit.r + q.spec.hit.r) * 0.8) continue;
        const part = this.touching(p, q);
        if (!part) continue;
        const rv = _cv.copy(p.air.vel).sub(q.air.vel).length();
        p.bumpT = 0.5;
        _cn.copy(p.air.pos).sub(q.air.pos).normalize();
        p.air.vel.addScaledVector(_cn, Math.min(25, rv * 0.4));
        this.fx.hit(_cp.copy(p.air.pos).lerp(q.air.pos, 0.5));
        this.damage(p, part, rv * 1.4, q, 'collision');
        if (p.alive) this.damage(p, 'body', rv * 0.5, q, 'collision');
        break;
      }
    }
  }

  // Which part of p overlaps q's airframe, using the unscaled hit spheres.
  touching(p, q) {
    const sph = (pl) => {
      const h = pl.spec.hit, out = h.body.map(([z, r]) => [0, 0, z, r, 'body']);
      if (pl.hp.wl > 0) out.push([-h.wingX, 0, h.wingZ, h.wingR, 'wl']);
      if (pl.hp.wr > 0) out.push([h.wingX, 0, h.wingZ, h.wingR, 'wr']);
      return out.map(([x, y, z, r, part]) => [_cr.set(x, y, z).applyQuaternion(pl.air.quat).add(pl.air.pos).toArray(), r, part]);
    };
    const A = sph(p), B = sph(q);
    for (const [pa, ra, part] of A) for (const [pb, rb] of B) {
      if ((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2 + (pa[2] - pb[2]) ** 2 < (ra + rb) ** 2) return part;
    }
    return null;
  }

  // Fresh shrapnel that flies through a plane we own nicks it.
  shrapnel() {
    const deb = this.fx.deb;
    if (!deb.length) return;
    for (const p of this.planeList) {
      if (!p.owned || !p.alive) continue;
      const r2 = (p.spec.hit.r * 0.35 + 1) ** 2;
      for (const d of deb) {
        if (d.age > 1.5 || d.life <= 0) continue;
        if (d.p.distanceToSquared(p.air.pos) < r2) { d.life = 0; this.fx.hit(d.p); this.damage(p, 'body', 3, null, 'explosion'); }
      }
    }
  }

  // Thin air above the ceiling: the engine fades and climbs die out. Outside the arena wall a countdown runs.
  limits(p, dt) {
    const over = p.air.pos.y - (p.spec.rocket ? 400000 : this.ceiling);
    // the pilot is the limit: sustained high g greys you out and then blacks you out for a moment
    if (p.isMe) {
      const g = p.air.g;
      if (g > 7.5) p.gStress += (g - 7.5) * 0.12 * dt;
      else if (g < -2.5) p.gStress += (-2.5 - g) * 0.3 * dt;
      else p.gStress -= (g < 5 && g > -1 ? 0.3 : 0.06) * dt;
      p.gStress = clamp(p.gStress, 0, 1.15);
      if (p.gStress >= 1) p.blackout = true;
      else if (p.gStress < 0.55) p.blackout = false;
    }
    p.air.engine = over > 0 ? Math.max(0, 1 - over / 250) : 1;
    if (over > 0 && p.air.vel.y > 0) p.air.vel.y *= Math.exp(-dt * (0.3 + over / 80));
    const r = Math.hypot(p.air.pos.x, p.air.pos.z);
    if (this.arenaR && this.mode !== 'menu' && r > this.arenaR) {
      // the clock only runs while heading further out
      if (p.air.pos.x * p.air.vel.x + p.air.pos.z * p.air.vel.z > 0) p.outT += dt;
      if (p.outT > 6) this.kill(p, null, 'left the area');
    } else p.outT = Math.max(0, p.outT - dt * 2);
  }

  playerControl(dt) {
    const me = this.me, c = me.ctrl, mouse = settings.ctl.mode === 'mouse';
    const thr = input.axis('throttleDown', 'throttleUp');
    this.cam.throttle = clamp(this.cam.throttle + thr * dt * 0.7, 0, 1);
    c.throttle = this.cam.throttle;
    c.ab = input.down('afterburner') || (this.cam.throttle >= 1 && thr > 0);

    if (mouse) {
      const [mx, my] = input.mouse();
      const k = 0.0021 * settings.ctl.sens;
      this.aim.multiply(_q.setFromAxisAngle(_ya, -mx * k));
      this.aim.multiply(_q.setFromAxisAngle(_xa, -my * k * (settings.ctl.invert ? -1 : 1)));
      if (me.alive) this.followRoll(dt, me);
    } else input.mouse();
    _f.set(0, 0, -1).applyQuaternion(this.aim);
    this.aimDir.copy(_f);

    const pIn = input.axis('pitchDown', 'pitchUp'), rIn = input.axis('rollLeft', 'rollRight'), yIn = input.axis('yawLeft', 'yawRight');
    if (me.blackout) { c.pitch = c.roll = c.yaw = 0; return; }
    if (mouse) {
      if (me.alive) steer(me.air, this.aimDir, c, settings.ctl.assist, 1);
      if (pIn) c.pitch = pIn;
      if (rIn) c.roll = rIn;
      if (yIn) c.yaw = yIn;
    } else {
      const r = Math.min(1, dt * 7);
      c.pitch += (pIn - c.pitch) * r; c.roll += (rIn - c.roll) * r; c.yaw += (yIn - c.yaw) * r;
    }
    if (!me.alive) {
      if (input.hit('fire') && this.mode === 'competitive') this.nextSpectate();
      return;
    }
    me.trigger = input.down('fire');
    if (input.hit('missile')) this.fireMissile(me);
    if (input.hit('flare')) this.dropFlare(me);
    if (input.hit('reload') && me.reload <= 0 && me.ammo < me.spec.gun.mag) me.reload = me.spec.gun.reload;
    if (input.hit('view')) this.cam.view = this.cam.view === 'chase' ? 'cockpit' : 'chase';
  }

  // The mouse-aim camera banks with the aircraft instead of holding the horizon.
  followRoll(dt, me) {
    _f.set(0, 0, -1).applyQuaternion(this.aim);
    _u.set(0, 1, 0).applyQuaternion(this.aim);
    me.air.up(_t).addScaledVector(_f, -_t.dot(_f));
    const len = _t.length();
    if (len < 0.2) return;
    _t.multiplyScalar(1 / len);
    const ang = Math.atan2(_f.dot(_d.crossVectors(_u, _t)), _u.dot(_t));
    this.aim.premultiply(_q.setFromAxisAngle(_f, ang * Math.min(1, dt * 5 * len)));
    this.aim.normalize();
  }

  // ---------- weapons ----------

  weapons(p, dt) {
    p.warnT -= dt;
    if (p.warnT <= 0) p.warnState = 0;
    p.flareCd -= dt;
    if (!p.alive) return;
    const gun = p.spec.gun;
    if (p.reload > 0) { p.reload -= dt; if (p.reload <= 0) { p.reload = 0; p.ammo = gun.mag; } }
    p.gunCd -= dt;
    if (p.trigger && p.reload <= 0 && (p.ammo > 0 || !p.owned)) {
      while (p.gunCd <= 0) {
        this.fireRound(p);
        p.gunCd += 1 / gun.rate;
        if (p.owned && --p.ammo <= 0) { p.reload = gun.reload; break; }
      }
    } else if (p.gunCd < 0) p.gunCd = 0;
    if (p.owned) {
      this.updateLock(p, dt);
      if (p.doomT > 0) { p.doomT -= dt; if (p.doomT <= 0) this.kill(p, null, 'crash'); }
    }
  }

  fireRound(p) {
    const info = p.model.info, gun = p.spec.gun;
    _mz.copy(info.guns[p.muzzle++ % info.guns.length]).applyQuaternion(p.air.quat).add(p.air.pos);
    p.air.forward(_d);
    if (p.isMe) this.aimAssist(p, _d);
    p.air.up(_u);
    _t.crossVectors(_d, _u);
    _d.addScaledVector(_u, gauss() * gun.spread).addScaledVector(_t, gauss() * gun.spread).normalize();
    _vel.copy(p.air.vel).addScaledVector(_d, gun.vel);
    this.combat.bullet(p, _mz, _vel, p.owned);
    if (this.fx.density > 0.5 || p.muzzle % 2) this.fx.add.emit(_mz.x, _mz.y, _mz.z, p.air.vel.x, p.air.vel.y, p.air.vel.z, 0.05, 2.2, 0.8, COL.fireHot, 1);
    if (p.isMe || p.muzzle % 2) audio.shot(_mz.distanceTo(this.camera.position), p.spec.id === 'airliner');
  }

  // Bends the stream a little toward the lead point of a target that is already nearly on the nose.
  aimAssist(p, dir) {
    let best = 0.045, found = false;
    for (const q of this.planeList) {
      if (q === p || !q.alive || q.team === p.team) continue;
      if (q.air.pos.distanceToSquared(p.air.pos) > 900 * 900) continue;
      if (leadDir(p.air.pos, p.air.vel, q.air.pos, q.air.vel, p.spec.gun.vel, _v) < 0) continue;
      const a = dir.angleTo(_v);
      if (a < best) { best = a; _ld.copy(_v); found = true; }
    }
    if (found) dir.lerp(_ld, 0.6).normalize();
  }

  updateLock(p, dt) {
    const L = p.lock;
    if (p.missiles <= 0 || this.mode === 'menu') { L.target = null; L.t = 0; p.lockedOn = false; return; }
    p.air.forward(_f);
    let cand = null, best = LOCK_CONE;
    for (const q of this.planeList) {
      if (q === p || !q.alive || q.team === p.team) continue;
      _t.copy(q.air.pos).sub(p.air.pos);
      const d = _t.length();
      if (d > LOCK_RANGE || d < 150) continue;
      const a = Math.acos(clamp(_t.dot(_f) / d, -1, 1));
      if (a < best) { best = a; cand = q; }
    }
    if (cand && cand === L.target) L.t += dt;
    else { L.target = cand; L.t = 0; }
    p.lockedOn = !!L.target && L.t >= LOCK_TIME;
    const state = !L.target ? 0 : p.lockedOn ? 2 : 1;
    L.sendT -= dt;
    if (L.target && (state !== L.sent || L.sendT <= 0)) { this.warn(L.target, state); L.sendT = 0.4; }
    L.sent = state;
  }

  warn(target, state) {
    if (target.owned) { target.warnState = state; target.warnT = 0.9; }
    else if (this.net) this.net.sendLock(target.id, state);
  }

  fireMissile(p) {
    if (!p.alive || p.missiles <= 0) return;
    if (!p.lockedOn || !p.lock.target) { if (p.isMe) audio.blip(420, 0.09, 0.08); return; }
    p.missiles--;
    p.model.setMissiles(p.missiles);
    const id = p.id + '#' + (++p.mseq);
    _mz.copy(p.model.info.pylons[p.missiles] || p.model.info.guns[0]).applyQuaternion(p.air.quat).add(p.air.pos);
    p.air.up(_u);
    _vel.copy(p.air.vel).addScaledVector(_u, -6);
    const m = this.combat.missile(p, p.lock.target, id, _mz, _vel);
    if (this.net) this.net.sendMissile(p, m);
    this.sound('launch', _mz);
  }

  dropFlare(p) {
    if (!p.alive || p.flares <= 0 || p.flareCd > 0) return;
    p.flares--; p.flareCd = 0.5;
    const seq = ++p.flareSeq;
    this.combat.flare(p, p.air.pos, p.air.vel, seq);
    if (this.net) this.net.sendFlare(p, seq);
    this.sound('pop', p.air.pos);
  }

  // ---------- damage ----------

  // Called by combat for hits decided on this machine.
  bulletHit(owner, target, part, point) {
    this.fx.hit(point);
    const dmg = owner.spec.gun.dmg;
    if (owner.isMe) { this.hud.hitMarker(false); audio.blip(2400, 0.025, 0.05); }
    if (part === 'pilot' && owner.isMe) { this.hud.toast('Headshot', `${target.name}`); audio.blip(3200, 0.2, 0.12); }
    if (target.owned) this.damage(target, part, dmg, owner);
    else if (this.net) this.net.sendHit(target.id, part, dmg, owner.id);
  }

  // Every client simulates missiles; only the machine that owns the target applies damage.
  missileHit(m, target) {
    if (m.owner && m.owner.isMe) this.hud.hitMarker(true);
    if (!target.owned) return;
    const hp = target.spec.hp;
    this.damage(target, 'body', hp.body * 0.55, m.owner, 'missile');
    if (target.alive) {
      _t.copy(m.pos).sub(target.air.pos).applyQuaternion(_q.copy(target.air.quat).invert());
      this.damage(target, _t.x < 0 ? 'wl' : 'wr', hp.wing * 0.3, m.owner, 'missile');
    }
  }

  // Remote hit on something we own (from net).
  netHit(targetId, part, dmg, byId) {
    const t = this.planes.get(targetId);
    if (!t || !t.owned) return;
    this.damage(t, part, dmg, this.planes.get(byId) || null);
  }

  damage(p, part, dmg, by, cause = 'shot') {
    if (!p.alive) return;
    if (by) { p.lastAttacker = by; p.lastAttackT = this.time; }
    if (part === 'pilot') { p.hp.body = 0; cause = 'headshot'; }
    else if (part === 'body') p.hp.body -= dmg;
    else if (part === 'wl') { p.hp.wl -= dmg; if (p.hp.wl <= 0 && !p.air.wingLost) this.loseWing(p, -1); }
    else if (part === 'wr') { p.hp.wr -= dmg; if (p.hp.wr <= 0 && !p.air.wingLost) this.loseWing(p, 1); }
    if (p.isMe && dmg > 0.5) { this.hud.damage(); this.fx.addShake(Math.min(0.5, 0.05 + dmg * 0.01)); }
    if (p.hp.body <= 0) this.kill(p, by, cause);
  }

  loseWing(p, side) {
    if (p.owned) { p.air.wingLost = side; p.doomT = 9; }
    const w = side < 0 ? p.model.wingL : p.model.wingR;
    if (!w.visible) return;
    if (this.recorder) this.recorder.event('wing', p, side);
    p.model.root.updateMatrixWorld(true);
    this.fx.part(w.geometry, w.matrixWorld, p.air.vel);
    w.getWorldPosition(_t);
    this.fx.explosion(_t, 0.35, p.air.vel);
    w.visible = false;
  }

  // Local plane destroyed. Score keeping happens in registerKill (solo) or on the host (online).
  kill(p, by, cause) {
    if (!p.alive) return;
    const killer = by || (this.time - p.lastAttackT < 15 ? p.lastAttacker : null);
    this.explode(p, cause);
    p.respawnT = RESPAWN_TIME;
    if (p.isMe) {
      ach.death(cause);
      this.cam.deathPos.copy(p.air.pos);
      this.cam.spectate = null;
      this.hud.died(killer && killer !== p ? killer.name : null, cause);
    }
    if (p === this.show) return;
    if (this.net) this.net.reportDeath(p, killer && killer !== p ? killer.id : null, cause);
    else this.registerKill(p, killer, cause);
  }

  // Fireball plus the airframe coming apart: nose, tail and both wings tumble away, bounce and burn.
  explode(p, cause) {
    if (this.recorder) this.recorder.event('boom', p, cause);
    p.alive = false;
    p.exploded = p.life;
    p.trigger = false;
    this.dropTrails(p);
    const m = p.model, a = p.air, fx = this.fx, w = this.world;
    const size = { airliner: 2.2, trainer: 0.8, lancer: 1.2 }[p.spec.id] || 1;
    m.root.position.copy(a.pos);
    m.root.quaternion.copy(a.quat);
    m.root.updateMatrixWorld(true);
    _vel.copy(a.vel);
    if (cause === 'crash') {
      // skid along the slope instead of stopping dead
      const e = 3, x = a.pos.x, z = a.pos.z;
      _u.set(w.groundAt(x - e, z) - w.groundAt(x + e, z), 2 * e, w.groundAt(x, z - e) - w.groundAt(x, z + e)).normalize();
      const vn = _vel.dot(_u);
      if (vn < 0) _vel.addScaledVector(_u, -vn * 1.25);
      _vel.multiplyScalar(0.7);
    }
    if (cause !== 'water') {
      a.forward(_f);
      m.info.halves.forEach((h, i) => fx.part(h, m.body.matrixWorld, _v.copy(_vel).addScaledVector(_f, i ? -12 : 12)));
      a.up(_u);
      _t.crossVectors(_f, _u);
      if (m.wingL.visible) fx.part(m.wingL.geometry, m.wingL.matrixWorld, _v.copy(_vel).addScaledVector(_t, -22));
      if (m.wingR.visible) fx.part(m.wingR.geometry, m.wingR.matrixWorld, _v.copy(_vel).addScaledVector(_t, 22));
    }
    m.root.visible = false;
    if (cause === 'water') fx.splash(_v.copy(a.pos).setY(w.map.water ?? a.pos.y), size * 1.4);
    else {
      fx.bigExplosion(a.pos, _vel, size);
      if (cause === 'crash') fx.groundHit(a.pos, a.speed, size * 1.6);
    }
    this.sound('boom', a.pos, 1.5 * size);
    if (this.mode !== 'replay') {
      const R = 35 * size;
      for (const o of this.planeList) {
        if (o === p || !o.owned || !o.alive) continue;
        const od = o.air.pos.distanceTo(a.pos);
        if (od < R) this.damage(o, 'body', 55 * size * (1 - od / R) ** 1.5, null, 'explosion');
      }
    }
    const d = a.pos.distanceTo(this.camera.position);
    if (d < 900) fx.addShake(Math.min(1.4, 1.6 - d / 600));
  }

  registerKill(victim, killer, cause) {
    victim.deaths++;
    if (killer && killer !== victim) killer.kills++;
    this.addFeed(killer && killer !== victim ? killer : null, victim, cause);
    if (killer && killer.isMe && killer !== victim) { this.solo.kills++; this.hud.hitMarker(true, true); this.myKill(victim, cause); }
    if (this.mode === 'dogfight' && victim.isMe) {
      this.solo.lives--;
      if (this.solo.lives <= 0) { this.solo.overT = 3; victim.respawnT = 0; }
    }
  }

  addFeed(killer, victim, cause) {
    this.feed.push({ killer: killer ? killer.name : null, kc: killer ? killer.load.color : null, victim: victim.name, vc: victim.load.color, cause, t: performance.now() });
    if (this.feed.length > 5) this.feed.shift();
  }

  // ---------- mode rules ----------

  rules(dt) {
    const me = this.me;
    if (!me) return;
    for (const p of this.planeList) {
      if (!p.owned || p.alive || p.respawnT <= 0) continue;
      p.respawnT -= dt;
      if (p.respawnT > 0 || this.over) continue;
      const can = p.isMe
        ? this.mode === 'free' || this.mode === 'casual' || (this.mode === 'dogfight' && this.solo.lives > 0)
        : this.online && this.mode === 'casual';
      if (can) this.spawn(p);
    }
    if (this.mode === 'dogfight') {
      const s = this.solo;
      const bots = this.planeList.filter((p) => p.isBot && !p.isMe);
      if (s.active && !bots.some((p) => p.alive)) {
        s.active = false; s.nextWave = 5;
        for (const b of bots) setTimeout(() => this.removePlane(b.id), 4000);
        if (me.alive) this.hud.toast(`Wave ${s.wave} cleared`, 'Next wave incoming');
      }
      if (!s.active && me.alive && !this.over) {
        s.nextWave -= dt;
        if (s.nextWave <= 0) this.spawnWave(++s.wave);
      }
      if (s.overT > 0) {
        s.overT -= dt;
        if (s.overT <= 0) {
          const best = Math.max(settings.bestWave, s.wave);
          const record = s.wave > settings.bestWave;
          settings.bestWave = best;
          this.finish({ title: 'Shot down', sub: record ? 'New best wave' : `Best wave ${best}`, stats: [['Wave reached', s.wave], ['Kills', s.kills]] });
        }
      }
    }
  }

  finish(results) {
    if (this.over) return;
    this.over = true;
    if (this.onEnd) this.onEnd(results);
  }

  nextSpectate() {
    const alive = this.planeList.filter((p) => p.alive && p !== this.me);
    if (!alive.length) { this.cam.spectate = null; return; }
    const i = alive.indexOf(this.cam.spectate);
    this.cam.spectate = alive[(i + 1) % alive.length];
  }

  // ---------- remote planes ----------

  netState(id, s) {
    const p = this.planes.get(id);
    if (!p || p.owned) return;
    const n = p.net, recv = performance.now();
    const sample = s.ts - recv;
    n.off = n.off === null ? sample : Math.max(sample, n.off - 1);
    const last = n.snaps[n.snaps.length - 1];
    if (last && s.ts <= last.ts) return;
    n.snaps.push(s);
    if (n.snaps.length > 16) n.snaps.shift();
  }

  interp(p) {
    const n = p.net, s = n.snaps;
    if (!s.length) return;
    const rt = performance.now() + n.off - INTERP_DELAY;
    let a = s[0], b = null;
    for (let i = s.length - 1; i >= 0; i--) if (s[i].ts <= rt) { a = s[i]; b = s[i + 1] || null; break; }
    const air = p.air;
    if (b) {
      const span = (b.ts - a.ts) / 1000, u = (rt - a.ts) / (b.ts - a.ts);
      const u2 = u * u, u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = (u3 - 2 * u2 + u) * span, h01 = -2 * u3 + 3 * u2, h11 = (u3 - u2) * span;
      for (let k = 0; k < 3; k++) {
        const v = h00 * a.p[k] + h10 * a.v[k] + h01 * b.p[k] + h11 * b.v[k];
        if (k === 0) air.pos.x = v; else if (k === 1) air.pos.y = v; else air.pos.z = v;
      }
      air.vel.set(a.v[0] + (b.v[0] - a.v[0]) * u, a.v[1] + (b.v[1] - a.v[1]) * u, a.v[2] + (b.v[2] - a.v[2]) * u);
      _q.fromArray(a.q); _q2.fromArray(b.q);
      air.quat.copy(_q).slerp(_q2, u).normalize();
    } else {
      const e = clamp((rt - a.ts) / 1000, 0, 0.25);
      air.pos.set(a.p[0] + a.v[0] * e, a.p[1] + a.v[1] * e, a.p[2] + a.v[2] * e);
      air.vel.fromArray(a.v);
      air.quat.fromArray(a.q).normalize();
    }
    air.speed = air.vel.length();
    const L = s[s.length - 1];
    air.throttle = L.th; air.ab = L.ab;
    p.trigger = !!L.f && p.alive;
    p.hp.body = L.h[0]; p.hp.wl = L.h[1]; p.hp.wr = L.h[2];
    if (L.a && L.l > p.killedLife && L.l > (p.lastLife || 0)) {
      // fresh life: respawned
      p.lastLife = L.l;
      p.alive = true;
      p.model.setWings(true, true);
      p.model.root.visible = true;
      p.prevPos.copy(air.pos);
    } else if (!L.a && p.alive) p.alive = false;
    p.missiles = L.m ?? MISSILES;
    if (p.alive && L.h[1] <= 0 && p.model.wingL.visible) this.loseWing(p, -1);
    if (p.alive && L.h[2] <= 0 && p.model.wingR.visible) this.loseWing(p, 1);
  }

  // Kill announced by the host. Plays the explosion for planes we do not own.
  netKill(victimId, killerId, cause) {
    const v = this.planes.get(victimId), k = this.planes.get(killerId);
    if (!v) return;
    if (!v.owned) {
      v.killedLife = v.lastLife || 0;
      if (v.exploded !== v.killedLife) { v.alive = true; this.explode(v, cause); v.exploded = v.killedLife; }
      v.alive = false;
    }
    this.addFeed(k && k !== v ? k : null, v, cause);
    if (k && k.isMe && k !== v) { this.hud.hitMarker(true, true); this.myKill(v, cause); }
  }

  myKill(victim, cause) {
    const me = this.me;
    if (!me) return;
    ach.kill({ cause, dist: victim.air.pos.distanceTo(me.air.pos), hp: me.alive ? me.hp.body / me.spec.hp.body : 0 });
  }

  netMissile(ownerId, id, targetId, p, v) {
    const o = this.planes.get(ownerId);
    if (!o) return;
    const m = this.combat.missile(o, this.planes.get(targetId) || null, id, _t.fromArray(p), _v.fromArray(v));
    if (!o.owned && o.missiles > 0) o.missiles--;
    this.sound('launch', m.pos);
  }

  netFlare(ownerId, seq) {
    const o = this.planes.get(ownerId);
    if (!o || o.owned) return;
    this.combat.flare(o, o.air.pos, o.air.vel, seq);
    this.sound('pop', o.air.pos);
  }

  netLock(targetId, state) {
    const t = this.planes.get(targetId);
    if (t && t.owned) { t.warnState = state; t.warnT = 0.9; }
  }

  stateOf(p) {
    const a = p.air, r = (x) => Math.round(x * 100) / 100, r4 = (x) => Math.round(x * 10000) / 10000;
    return {
      i: p.id, ts: Math.round(performance.now()),
      p: [r(a.pos.x), r(a.pos.y), r(a.pos.z)], q: [r4(a.quat.x), r4(a.quat.y), r4(a.quat.z), r4(a.quat.w)],
      v: [r(a.vel.x), r(a.vel.y), r(a.vel.z)], th: r(a.throttle), ab: r(a.ab), f: p.trigger ? 1 : 0,
      h: [Math.round(p.hp.body), Math.round(p.hp.wl), Math.round(p.hp.wr)], a: p.alive ? 1 : 0, l: p.life, m: p.missiles,
    };
  }

  // ---------- presentation ----------

  planeFx(p, dt) {
    const m = p.model, a = p.air, fx = this.fx;
    if (!p.alive) { m.root.visible = false; return; }
    m.root.visible = true;
    m.root.position.copy(a.pos);
    m.root.quaternion.copy(a.quat);
    m.update(dt, a.throttle, a.ab);
    const far = a.pos.distanceToSquared(this.camera.position) > 1800 * 1800;
    for (let i = 0; i < m.missiles.length; i++) m.missiles[i].visible = !far && i < p.missiles;
    if (m.flame && far) m.flame.visible = false;
    if (m.disc) m.disc.visible = m.prop.visible = !far;
    const info = m.info, hp = p.spec.hp, vel = a.vel;
    const vaporG = p.spec.id === 'trainer' ? 3.5 : p.spec.id === 'airliner' ? 1.8 : 5;

    // contrails from the engines and vortices off the wingtips under load
    if (!p.trails) {
      const kind = p.spec.id === 'trainer' ? 'smoke' : 'contrail';
      p.trails = info.exhaust.slice(0, 2).map(() => fx.ribbons.strip(kind));
      p.trails.push(fx.ribbons.strip('tip'), fx.ribbons.strip('tip'));
    }
    const ne = p.trails.length - 2, now = fx.time;
    const ck = p.spec.id === 'trainer' ? 0.4 + a.throttle * 0.3 : 0.3 + a.throttle * 0.45 + a.ab * 0.45;
    for (let i = 0; i < ne; i++) {
      _t.copy(info.exhaust[i]).applyQuaternion(a.quat).add(a.pos);
      fx.ribbons.feed(p.trails[i], _t.x, _t.y, _t.z, ck, now);
    }
    const tk = a.speed > 60 ? Math.min(1, Math.max(0, (a.g - vaporG * 0.75) / 3)) : 0;
    for (let i = 0; i < 2; i++) {
      _t.copy(info.tips[i]).applyQuaternion(a.quat).add(a.pos);
      fx.ribbons.feed(p.trails[ne + i], _t.x, _t.y, _t.z, tk, now);
    }

    const mach = a.speed / MACH;
    if (p.mach < 1 && mach >= 1 && this.mode !== 'menu') {
      fx.sonicBoom(a.pos, vel);
      this.sound('sonic', a.pos);
      const d = a.pos.distanceTo(this.camera.position);
      if (d < 600) fx.addShake(0.8 - d / 800);
    }
    p.mach = mach;

    p.fxT -= dt;
    if (p.fxT > 0) return;
    p.fxT = 0.045 / fx.density;
    if (a.pos.distanceToSquared(this.camera.position) > 3000 * 3000) return;
    if (mach > 0.9 && mach < 1.1) {
      a.forward(_f); a.up(_u);
      _t.copy(a.pos).addScaledVector(_f, -info.length * 0.15);
      fx.vaporCone(_t, _f, _u, info.length * 0.12 * (1 - Math.abs(mach - 1) * 4));
    }
    const water = this.world.map.water, ground = this.world.groundAt(a.pos.x, a.pos.z);
    if (water !== null && ground < water && a.pos.y - water < 35 && a.speed > 50) fx.spray(a.pos.x, water, a.pos.z, vel, 1 - (a.pos.y - water) / 35);
    else if (a.pos.y - ground < 22 && a.speed > 50 && (water === null || ground > water)) fx.dust(a.pos.x, ground, a.pos.z, vel, 1 - (a.pos.y - ground) / 22);
    if (a.g > vaporG && a.speed > 60) {
      const s = Math.min(1, (p.air.g - vaporG) / 3);
      for (const tip of info.tips) { _t.copy(tip).applyQuaternion(p.air.quat).add(p.air.pos); this.fx.vapor(_t, vel, s); }
    }
    const h = p.hp.body / hp.body;
    if (h < 0.5 || p.air.wingLost) {
      _t.copy(info.exhaust[0]).applyQuaternion(p.air.quat).add(p.air.pos);
      this.fx.smoke(_t, vel, h < 0.3, p.spec.id === 'airliner' ? 2 : 1);
      if (h < 0.25) this.fx.fire(_t, vel);
    }
    for (const side of [-1, 1]) {
      const w = side < 0 ? p.hp.wl : p.hp.wr;
      if (w > 0 && w < hp.wing * 0.5) {
        _t.copy(info.tips[side < 0 ? 0 : 1]).multiplyScalar(0.6).applyQuaternion(p.air.quat).add(p.air.pos);
        this.fx.smoke(_t, vel, false, 0.7);
      }
    }
  }

  updateCamera(dt) {
    const cam = this.camera, c = this.cam;
    let fov = 70, shake = this.fx.shake;
    if (this.mode === 'replay') { this.rp.updateCamera(cam, dt); return; }
    if (this.mode === 'menu') {
      const p = this.show;
      c.orbit += dt * 0.09;
      const R = p.spec.cam.dist * 1.25;
      cam.position.set(p.air.pos.x + Math.sin(c.orbit) * R, p.air.pos.y + R * 0.18, p.air.pos.z + Math.cos(c.orbit) * R);
      cam.lookAt(p.air.pos);
      _t.set(-R * 0.22, 0, 0).applyQuaternion(cam.quaternion);
      cam.position.add(_t);
      this.setFov(58);
      return;
    }
    const me = this.me;
    if (me.alive) {
      const spec = me.spec, a = me.air;
      if (c.view === 'cockpit') {
        // head turns partway toward the mouse aim and sags under g; field of view stays fixed
        _q.copy(a.quat);
        if (settings.ctl.mode === 'mouse') {
          const ang = 2 * Math.acos(Math.min(1, Math.abs(a.quat.dot(this.aim))));
          _q.slerp(this.aim, Math.min(0.5, 1.05 / Math.max(ang, 1e-3)));
        }
        c.head.slerp(_q, 1 - Math.exp(-dt * 9));
        _off.fromArray(spec.cam.cockpit);
        _off.y -= clamp((a.g - 1) * 0.012, -0.04, 0.09);
        cam.position.copy(_off).applyQuaternion(a.quat).add(a.pos);
        cam.quaternion.copy(c.head);
        fov = 78;
        shake = this.fx.shake * 0.5 + (a.stalled ? 0.15 * spec.buffet : 0);
      } else {
        const q = settings.ctl.mode === 'mouse' ? this.aim : c.kq;
        if (settings.ctl.mode !== 'mouse') c.kq.slerp(a.quat, 1 - Math.exp(-dt * 5));
        const pull = 1 + clamp((a.speed - 150) / 400, 0, 1) * 0.1 + a.ab * 0.04;
        _off.set(0, spec.cam.height, spec.cam.dist * pull).applyQuaternion(q);
        c.off.lerp(_off, 1 - Math.exp(-dt * 14));
        cam.position.copy(a.pos).add(c.off);
        cam.quaternion.copy(q);
        c.head.copy(a.quat);
      }
      if (c.view !== 'cockpit') {
        const sk = clamp((a.speed - 210) / 300, 0, 1);
        if (settings.gfx.blur) fov += clamp((a.speed - 120) / 300, 0, 1) * 10 + a.ab * 2;
        shake += sk * sk * 0.04 + a.ab * 0.015;
        if (a.stalled) shake += 0.25 * spec.buffet;
        shake += Math.max(0, a.g - spec.maxG * 0.75) * 0.03;
      }
    } else {
      const s = c.spectate && c.spectate.alive ? c.spectate : null;
      if (s) {
        c.kq.slerp(s.air.quat, 1 - Math.exp(-dt * 4));
        _off.set(0, s.spec.cam.height, s.spec.cam.dist * 1.2).applyQuaternion(c.kq);
        cam.position.copy(s.air.pos).add(_off);
        cam.quaternion.copy(c.kq);
      } else {
        _t.copy(cam.position).sub(c.deathPos);
        const d = _t.length();
        if (d < 120) cam.position.addScaledVector(_t.normalize(), dt * 25);
        cam.lookAt(c.deathPos);
      }
    }
    const g = this.world.surfaceAt(cam.position.x, cam.position.z) + 2;
    if (cam.position.y < g) cam.position.y = g;
    if (shake > 0.01) {
      const s = Math.min(shake, 1.5) * 0.012;
      const t = this.time;
      cam.quaternion.multiply(_q.setFromEuler(_eul.set(Math.sin(t * 41) * Math.sin(t * 13.7) * s, Math.sin(t * 33 + 1) * Math.sin(t * 9.3) * s, Math.sin(t * 27 + 2) * s * 0.5)));
    }
    this.setFov(fov, dt);
    this.updateCockpit();
  }

  updateCockpit() {
    const me = this.me;
    this.showCockpit = !!(me && me.alive && this.cam.view === 'cockpit');
    if (!this.showCockpit) return;
    if (this.cockpitType !== me.spec.id) {
      if (this.cockpit) this.cockpitScene.remove(this.cockpit);
      this.cockpit = buildCockpit(me.spec.id);
      this.cockpitType = me.spec.id;
      this.cockpitScene.add(this.cockpit);
    }
    this.cockpit.position.fromArray(me.spec.cam.cockpit).applyQuaternion(me.air.quat).add(me.air.pos);
    this.cockpit.quaternion.copy(me.air.quat);
    const w = this.world;
    this.cockpitSun.color.copy(w.sun.color); this.cockpitSun.intensity = w.sun.intensity * 0.8;
    this.cockpitSun.position.copy(this.cockpit.position).add(w.sun.position);
    this.cockpitSun.target.position.copy(this.cockpit.position);
    this.cockpitHemi.color.copy(w.hemi.color); this.cockpitHemi.groundColor.copy(w.hemi.groundColor);
    this.cockpitHemi.intensity = w.hemi.intensity * 0.7;
  }

  setFov(f, dt = 1) {
    const cam = this.camera;
    const nf = cam.fov + (f - cam.fov) * Math.min(1, dt * 3);
    if (Math.abs(nf - cam.fov) > 0.01) { cam.fov = nf; cam.updateProjectionMatrix(); }
  }

  updateAudio() {
    const me = this.me;
    if (me && me.alive && !(this.paused && !this.online)) {
      const kind = me.spec.id === 'trainer' ? 'prop' : me.spec.id === 'airliner' ? 'big' : 'jet';
      audio.engine(true, me.air.throttle, me.air.ab, me.air.speed, kind);
      const inc = this.combat.incoming(me);
      audio.tone(inc ? 3 : me.lockedOn ? 2 : me.lock.target ? 1 : 0, this.time);
    } else {
      audio.engine(false, 0, 0, 0, 'jet');
      audio.tone(0, 0);
    }
  }

  sound(kind, pos, size = 1) {
    const d = pos.distanceTo(this.camera.position);
    if (kind === 'boom') audio.boom(d, size);
    else if (kind === 'pop') audio.pop(d);
    else if (kind === 'launch') audio.boom(d * 0.6 + 40, 0.35);
    else if (kind === 'sonic') audio.sonic(d);
  }
}
