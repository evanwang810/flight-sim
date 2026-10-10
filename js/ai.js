// Bot pilot. Reads the whole fight, not just its target: breaks when someone is on its tail, presses with
// lead pursuit when it has the advantage, eases off or yo-yos to avoid overshooting, keeps its energy up,
// extends and comes back head-on when a turning fight stalls, and treats the ground, the ceiling and the
// arena wall as hard limits. All flying goes through pilot.steer, the same autopilot the mouse aim uses.
import * as THREE from './three.js';
import { steer } from './pilot.js';
import { leadDir } from './combat.js';
import { G } from './config.js';

const UP = new THREE.Vector3(0, 1, 0);
const _aim = new THREE.Vector3(), _f = new THREE.Vector3(), _to = new THREE.Vector3(), _ld = new THREE.Vector3(),
  _p = new THREE.Vector3(), _h = new THREE.Vector3(), _rel = new THREE.Vector3(), _tf = new THREE.Vector3(), _s = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function brain(bot) {
  return bot.brain || (bot.brain = {
    retarget: 0, target: null, noise: new THREE.Vector3(), goal: new THREE.Vector3(), noiseT: 0, flareT: 0, missileT: 3 + Math.random() * 3,
    jink: Math.random() * 10, mode: 'engage', modeT: 0, stale: 0, side: Math.random() < 0.5 ? -1 : 1, burst: 0, reverseT: 0,
    lookT: Math.random() * 2, aware: null, ierr: new THREE.Vector3(), track: null,
  });
}

function stillThreat(bot, e) {
  _to.copy(e.air.pos).sub(bot.air.pos);
  const d = _to.length();
  return d < 1300 && -e.air.forward(_tf).dot(_to) / d > Math.cos(0.7);
}

// Corner speed: the slowest speed that still reaches max g at full pull.
function cornerSpeed(spec) {
  return Math.sqrt(spec.maxG * G / (spec.liftK * (spec.cl0 + spec.cla * Math.min(spec.stickAlpha, spec.aCrit * 0.9))));
}

export function think(bot, game, dt) {
  const air = bot.air, sk = bot.skill, c = bot.ctrl, world = game.world, spec = bot.spec;
  const b = brain(bot);
  const act = { fire: false, missile: false, flare: false };
  b.retarget -= dt; b.noiseT -= dt; b.flareT -= dt; b.missileT -= dt; b.jink += dt; b.modeT -= dt; b.burst -= dt; b.reverseT -= dt; b.lookT -= dt;
  if (b.noiseT <= 0) {
    b.noiseT = sk.react;
    b.goal.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize().multiplyScalar(sk.aimErr);
  }
  b.noise.lerp(b.goal, Math.min(1, dt * 3));
  air.forward(_f);
  const vc = b.vc || (b.vc = cornerSpeed(spec));

  // ---- read the fight: who is a threat, who is the best target ----
  let threat = null, threatD = Infinity, best = null, bestS = Infinity;
  for (const e of game.planeList) {
    if (e === bot || !e.alive || e.team === bot.team) continue;
    _to.copy(e.air.pos).sub(air.pos);
    const d = _to.length();
    _to.multiplyScalar(1 / d);
    const myAta = Math.acos(clamp(_f.dot(_to), -1, 1));
    const theirAta = Math.acos(clamp(-e.air.forward(_tf).dot(_to), -1, 1));
    if (d < 1000 && theirAta < 0.45 && myAta > 1.2 && d < threatD) { threat = e; threatD = d; }
    let score = d * (0.6 + myAta) * (e.hp.body / e.spec.hp.body * 0.5 + 0.5);
    if (e === b.target) score *= 0.7;
    if (e === bot.lastAttacker && game.time - bot.lastAttackT < 8) score *= 0.6;
    if (e.isMe) score *= 0.85;
    if (score < bestS) { bestS = score; best = e; }
  }
  if (b.retarget <= 0 || !b.target || !b.target.alive) { b.target = best; b.retarget = 2; }
  // nobody watches their six every frame: threats are noticed on a skill-based scan, or by getting hit
  const hurt = bot.lastAttacker && bot.lastAttacker.alive && game.time - bot.lastAttackT < 0.5;
  if (hurt) b.aware = bot.lastAttacker;
  else if (b.lookT <= 0) { b.lookT = sk.scan * (0.6 + Math.random() * 0.8); if (threat) b.aware = threat; }
  if (b.aware && !(b.aware.alive && stillThreat(bot, b.aware))) b.aware = null;
  b.threatT = b.aware ? (b.threatT || 0) + dt : 0;
  threat = b.aware;
  const t = b.target;

  c.throttle = 1; c.ab = false;
  let aggr = sk.aggr, pull = sk.pull;
  const inc = game.combat.incoming(bot);

  if (inc && inc.d < 2800) {
    // missile: beam it (turn across its line of sight), dive a little, flare when it gets close
    _to.copy(inc.m.pos).sub(air.pos).normalize();
    _aim.crossVectors(_to, UP);
    if (_aim.lengthSq() < 1e-4) _aim.copy(_f);
    _aim.normalize();
    if (_aim.dot(_f) < 0) _aim.negate();
    _aim.y -= 0.2;
    c.ab = true; aggr = 1; pull = 1;
    if (inc.d < 1300 && b.flareT <= 0 && bot.flares > 0) {
      b.flareT = 1.2;
      if (Math.random() < sk.flare) act.flare = true;
    }
    b.mode = 'engage'; b.stale = 0;
  } else if (threat && b.threatT > sk.react) {
    // guns threat behind: break turn toward the attacker's side, reversing now and then (scissors)
    _to.copy(threat.air.pos).sub(air.pos).normalize();
    _p.copy(_to).addScaledVector(_f, -_to.dot(_f)).normalize();
    if (b.reverseT <= 0) { b.reverseT = 1.4 + Math.random() * 1.2; b.side = Math.random() < 0.35 ? -b.side : b.side; }
    _aim.copy(_f).addScaledVector(_p, 1.6 * (b.side > 0 ? 1 : 0.6)).normalize();
    _aim.addScaledVector(_s.set(Math.sin(b.jink * 2.1), Math.sin(b.jink * 1.3) * 0.6, Math.cos(b.jink * 2.1)), sk.jink);
    if (air.speed < vc * 0.8) _aim.y -= 0.25;
    c.ab = true; aggr = 1; pull = Math.max(pull, 0.85);
    b.mode = 'engage';
  } else if (t) {
    const tp = t.air.pos, dist = tp.distanceTo(air.pos);
    _p.copy(tp).sub(air.pos).normalize(); // line of sight
    const ata = Math.acos(clamp(_f.dot(_p), -1, 1));
    const aspect = Math.acos(clamp(t.air.forward(_tf).dot(_p), -1, 1)); // 0 = we are dead astern
    const closing = -_rel.copy(t.air.vel).sub(air.vel).dot(_p);

    if (b.mode === 'engage') {
      b.stale = ata > 0.9 && dist < 1800 ? b.stale + dt : Math.max(0, b.stale - dt * 2);
      if (b.stale > 8 + Math.random() * 4 && aspect > 1.6) { b.mode = 'extend'; b.modeT = 3.5 + Math.random() * 2; b.side = -b.side; }
    } else if (b.modeT <= 0 || dist > 2600) { b.mode = 'engage'; b.stale = 0; }

    if (b.mode !== 'engage' || ata > 1.1) b.ierr.multiplyScalar(Math.exp(-dt * 3));
    if (b.mode === 'extend') {
      // run out with speed, angling toward the middle of the arena, then come back for a head-on pass
      _aim.copy(_p).negate().setY(0).normalize();
      _aim.addScaledVector(_h.set(-_aim.z, 0, _aim.x), 0.4 * b.side);
      _aim.addScaledVector(_h.set(-air.pos.x, 0, -air.pos.z).normalize(), 0.5).normalize();
      _aim.y = 0.05;
      c.ab = true;
    } else {
      let tof = -1;
      if (dist < 1600) tof = leadDir(air.pos, air.vel, tp, t.air.vel, spec.gun.vel, _ld);
      if (dist < 260 && (closing > 35 || ata > 0.5) && aspect < 1.2) {
        // about to overshoot: lag behind the target and climb out of plane (high yo-yo)
        _aim.copy(tp).addScaledVector(t.air.vel, -0.6).sub(air.pos).normalize();
        _aim.y += 0.35;
        c.throttle = 0.2;
      } else if (tof > 0 && ata < 1.1) {
        // pilot.steer pulls in proportion to aim error, so push the aim point past the lead (PI) until
        // the nose actually sits on it
        if (b.track !== t) { b.ierr.set(0, 0, 0); b.track = t; }
        _s.copy(_ld).sub(_f);
        if (aspect < 1.5 && dist > 150) b.ierr.addScaledVector(_s, dt * 2.2 * sk.aggr);
        else b.ierr.multiplyScalar(Math.exp(-dt * 4));
        if (b.ierr.length() > 0.7) b.ierr.setLength(0.7);
        _aim.copy(_ld).addScaledVector(_s, 1.2).add(b.ierr);
        if (ata < 0.6 && dist < 900) { aggr = Math.max(aggr, 0.95); pull = Math.max(pull, 0.9); }
        if (dist < 700) _aim.add(b.noise); else _aim.addScaledVector(b.noise, 0.5);
        if (dist < 520 && closing > 30) c.throttle = clamp(0.75 - closing / 140, 0.1, 0.8);
        else if (dist > 650 || air.speed < vc) c.ab = true;
      } else {
        // neutral: pursue the target's future position, keep turns fairly flat to hold energy
        _aim.copy(tp).addScaledVector(t.air.vel, clamp(dist / 700, 0.3, 1.8)).sub(air.pos).normalize();
        if (air.speed < vc * 0.95) { _aim.y = Math.min(_aim.y, 0.15) - 0.08; c.ab = true; }
        else if (_aim.y > 0.5) _aim.y = 0.5;
        if (dist > 1200 || air.speed < vc * 1.1) c.ab = true;
      }
      // guns: wider tolerance up close, keep a started burst going briefly
      const range = closing > 220 ? 1000 : 820;
      if (tof > 0 && dist < range) {
        const err = _f.angleTo(_ld), tol = sk.cone + 7 / Math.max(dist, 60);
        if (err < tol || (b.burst > 0 && err < tol * 1.7)) { act.fire = true; if (b.burst <= 0) b.burst = 0.3; }
      }
      if (sk.missiles && bot.lockedOn && bot.missiles > 0 && b.missileT <= 0 && dist > 450 && dist < 2600 && (t.air.g < 4.5 || dist < 1300)) {
        act.missile = true; b.missileT = 6 + Math.random() * 4;
      }
    }
  } else {
    // nobody to fight: lazy orbit around the arena centre
    _p.set(-air.pos.z, 0, air.pos.x).normalize().multiplyScalar(0.6).add(_h.set(-air.pos.x, 0, -air.pos.z).normalize().multiplyScalar(0.4));
    _aim.copy(_p).normalize();
    _aim.y = clamp((world.map.spawnAlt - air.pos.y) / 1500, -0.3, 0.3);
    c.throttle = 0.75;
  }

  // ---- hard limits: arena wall, ceiling, terrain ----
  // speed governor: a fast jet cannot turn inside the arena, so do not go faster than the fight needs
  const turnR = air.speed * air.speed / (spec.maxG * 0.75 * G);
  if (game.arenaR && turnR > game.arenaR * 0.35) { c.ab = false; c.throttle = Math.min(c.throttle, 0.25); }
  else if (air.speed > vc * 2 && !(inc && inc.d < 2800)) { c.ab = false; c.throttle = Math.min(c.throttle, 0.6); }
  if (game.arenaR) {
    const r = Math.hypot(air.pos.x, air.pos.z), lim = Math.max(game.arenaR * 0.3, game.arenaR * 0.92 - turnR * 1.3);
    if (r > lim) {
      _h.set(-air.pos.x, 0, -air.pos.z).normalize();
      _aim.normalize().lerp(_h, clamp((r - lim) / (game.arenaR * 0.12), 0.25, 1));
    }
  }
  if (air.pos.y > game.ceiling - 350) _aim.y = Math.min(_aim.y, -0.1 - (air.pos.y - game.ceiling + 350) / 500);
  // heavy, slow-turning aircraft need to see trouble earlier
  const slug = Math.max(1, (spec.inertia ?? 1.5) / 1.5) * (spec.maxG < 4 ? 1.35 : 1);
  const clear = (110 + air.speed * 0.6) * slug;
  let danger = 0;
  for (const s0 of [0.6, 1.5, 3, 4.5]) {
    const s = s0 * slug;
    _p.copy(air.pos).addScaledVector(air.vel, s);
    const m = _p.y - world.surfaceAt(_p.x, _p.z);
    if (m < clear) danger = Math.max(danger, Math.min(1.5, (clear - m) / clear) * (s0 < 2 ? 1.3 : 1));
  }
  if (danger > 0) {
    _h.set(_f.x, 0, _f.z).normalize().add(_p.set(0, 0.6 + danger * 1.6, 0)).normalize();
    _aim.normalize().lerp(_h, Math.min(1, danger * 1.4));
    aggr = 1; pull = 1; c.throttle = 1;
    if (danger > 0.6) act.fire = false;
  }

  _aim.normalize();
  if (!(_aim.lengthSq() > 0.5)) _aim.copy(_f);
  // never dive steeper than the plane can pull out of before the ground: radius v^2 / (g (n - 1))
  const agl = air.pos.y - world.surfaceAt(air.pos.x, air.pos.z);
  const rPull = air.speed * air.speed / (G * (Math.max(1.3, spec.maxG * 0.75) - 1));
  const maxDive = Math.acos(1 - clamp(agl * 0.45 / rPull, 0, 1));
  if (_aim.y < -Math.sin(maxDive)) { _aim.y = -Math.sin(maxDive); _aim.normalize(); }
  steer(air, _aim, c, true, aggr);
  if (c.pitch > pull) c.pitch = pull;
  if (c.pitch < -0.45) c.pitch = -0.45; // bots roll and pull rather than push into negative g
  return act;
}
