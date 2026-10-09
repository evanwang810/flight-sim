import { Vector3, Quaternion } from './three.js';
import { G } from './config.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Lift coefficient: linear between the stall angles, then a sharp break that blends into flat-plate lift.
export function liftCoef(a, s) {
  if (a >= s.aCritNeg && a <= s.aCrit) return s.cl0 + s.cla * a;
  const fp = 1.15 * Math.sin(2 * a);
  if (a > s.aCrit) {
    const peak = (s.cl0 + s.cla * s.aCrit) * 0.72;
    return peak + (fp - peak) * smooth(0, 0.4, a - s.aCrit);
  }
  const peak = (s.cl0 + s.cla * s.aCritNeg) * 0.72;
  return peak + (fp - peak) * smooth(0, 0.4, s.aCritNeg - a);
}

const _va = new Vector3(), _vl = new Vector3(), _qi = new Quaternion(), _fwd = new Vector3(), _up = new Vector3(),
  _right = new Vector3(), _f = new Vector3(), _vh = new Vector3(), _lift = new Vector3(), _w = new Vector3(),
  _dq = new Quaternion(), _y = new Vector3(0, 1, 0);

// Rigid-body flight model. Body rates use pilot conventions:
// p = roll rate (+ right), q = pitch rate (+ nose up), r = yaw rate (+ nose right).
// three.js local axes: +X right wing, +Y up, -Z nose.
export class Airframe {
  constructor(spec) {
    this.spec = spec;
    this.pos = new Vector3();
    this.vel = new Vector3();
    this.quat = new Quaternion();
    this.p = 0; this.q = 0; this.r = 0;
    this.throttle = 0.75; this.ab = 0;
    this.alpha = 0; this.beta = 0; this.speed = 0; this.g = 1;
    this.stalled = false; this.wingLost = 0; this.engine = 1;
    this.starve = 0; this.engineOut = false;
    this.seed = Math.random() * 100;
    this.t = 0;
    // set from outside: damage 0..1 for the engine (body) and each wing, and whether the g-limiter is on
    this.dmgEngine = 0; this.dmgL = 0; this.dmgR = 0; this.gLimit = true;
  }

  reset(pos, yaw, speed) {
    this.pos.copy(pos);
    this.quat.setFromAxisAngle(_y, yaw);
    this.vel.set(0, 0, -1).applyQuaternion(this.quat).multiplyScalar(speed);
    this.p = this.q = this.r = 0;
    this.stalled = false; this.wingLost = 0; this.engine = 1; this.engineOut = false; this.starve = 0;
    this.throttle = 0.8; this.ab = 0; this.g = 1; this.speed = speed;
  }

  forward(out) { return out.set(0, 0, -1).applyQuaternion(this.quat); }
  up(out) { return out.set(0, 1, 0).applyQuaternion(this.quat); }

  // ctrl: { pitch, roll, yaw in [-1,1], throttle in [0,1], ab: bool }
  step(dt, c, wind) {
    const s = this.spec;
    this.t += dt;

    this.throttle += clamp(clamp(c.throttle, 0, 1) - this.throttle, -s.spool * dt, s.spool * dt);
    const abOn = c.ab && s.abThrust > 0 && this.throttle > 0.9 && !this.engineOut;
    this.ab += ((abOn ? 1 : 0) - this.ab) * Math.min(1, dt * 3);
    if (s.carb) {
      this.starve = clamp(this.starve + (this.g < -0.2 ? dt : -dt * 1.5), 0, 1);
      if (this.starve > 0.6) this.engineOut = true;
      else if (this.starve < 0.1) this.engineOut = false;
    }

    _va.copy(this.vel);
    if (wind) _va.sub(wind);
    const v = _va.length();
    this.speed = v;
    _qi.copy(this.quat).invert();
    _vl.copy(_va).applyQuaternion(_qi);
    if (v > 1) {
      this.alpha = Math.atan2(-_vl.y, -_vl.z);
      this.beta = Math.asin(clamp(_vl.x / v, -1, 1));
    } else { this.alpha = 0; this.beta = 0; }
    const a = this.alpha;

    // a damaged airframe stalls earlier
    const aCrit = s.aCrit * (1 - 0.25 * this.dmgEngine), aCritNeg = s.aCritNeg * (1 - 0.25 * this.dmgEngine);
    if (!this.stalled) { if (v > 8 && (a > aCrit || a < aCritNeg)) this.stalled = true; }
    else if (a < aCrit * 0.8 && a > aCritNeg * 0.8) this.stalled = false;
    const broken = this.wingLost !== 0;
    const stalled = this.stalled || broken;

    const qd = Math.min((v / s.vref) ** 2, s.qMax);
    const sq = Math.sqrt(qd);
    const auth = (stalled ? s.stallCtrl : 1) * (broken ? 0.4 : 1);

    let pitch = clamp(c.pitch, -1, 1);
    if (!this.gLimit) { /* no limiter: pull as hard as you like and live with it */ }
    else if (pitch > 0 && this.g > s.maxG - s.gWindow) pitch *= clamp((s.maxG - this.g) / s.gWindow, 0, 1);
    else if (pitch < 0 && this.g < s.minG + s.gWindowNeg) pitch *= clamp((this.g - s.minG) / s.gWindowNeg, 0, 1);
    const pAuth = this.gLimit ? s.pitchAuth : s.pitchAuthMax;
    const pa = pitch >= 0 ? pAuth : pAuth * 0.6;

    const stabA = Math.sin(clamp(a - s.trimAlpha, -1.5, 1.5));
    let dp = qd * (s.rollAuth * clamp(c.roll, -1, 1) * auth - s.dihedral * this.beta) - s.rollDamp * sq * this.p - 0.3 * this.p;
    let dq = qd * (pa * pitch * auth - s.pitchStab * stabA * (stalled ? 0.6 : 1)) - s.pitchDamp * sq * this.q - 0.3 * this.q;
    let dr = qd * (s.yawAuth * clamp(c.yaw, -1, 1) * auth + s.yawStab * this.beta) - s.yawDamp * sq * this.r - 0.3 * this.r;

    const t = this.t, k = this.seed;
    if (stalled && !broken) {
      const b = s.buffet * Math.max(qd, 0.25);
      dp += b * (Math.sin(t * 2.7 + k) + 0.7 * Math.sin(t * 5.3 + k * 1.7)) * 2.2;
      dq += b * (Math.sin(t * 3.4 + k * 2.1) + 0.5 * Math.sin(t * 7.1 + k)) * 0.8;
      dr += b * Math.sin(t * 1.9 + k * 0.6);
      // autorotation: past the stall the dropping wing loses more lift than the rising one, so roll damping
      // turns into roll drive, yaw follows the roll, and the spinning mass pitches the nose up and holds the stall
      const depth = a > 0 ? smooth(aCrit * 0.75, aCrit * 1.1, a) : smooth(-aCritNeg * 0.75, -aCritNeg * 1.1, -a);
      const m = Math.min(Math.max(qd, 0.3), 1.6) * (s.spin ?? 1);
      dp += depth * m * (14 * this.p * (1 - Math.min(1, Math.abs(this.p) / 3.2)) + 7 * this.r + 2 * s.yawAuth * clamp(c.yaw, -1, 1));
      dr += depth * m * 3 * (0.75 * this.p - this.r) - depth * qd * s.yawStab * this.beta * 0.7;
      dq += depth * m * 1.6 * Math.min(Math.abs(this.p), 3) * Math.sign(a);
    }
    // damage: a hurt wing makes less lift (the plane rolls toward it) and shakes; a hurt engine coughs
    const dw = this.dmgL + this.dmgR;
    if (dw > 0.02 || this.dmgEngine > 0.2) {
      const m = Math.min(Math.max(qd, 0.3), 1.5);
      const wob = dw * 0.6 + this.dmgEngine * 0.25;
      dp += (this.dmgR - this.dmgL) * 3.2 * m + wob * m * 7 * (Math.sin(t * 6.1 + k) + 0.6 * Math.sin(t * 13.7 + k * 3));
      dq += wob * m * 2.4 * Math.sin(t * 5.3 + k * 2);
      dr += wob * m * 2 * Math.sin(t * 3.7 + k * 5);
    }
    // engines that steer by swivelling (the rocket): authority from thrust, not airspeed
    if (s.tvc) {
      const tv = s.tvc * (this.engineOut ? 0 : this.throttle + this.ab * 0.6) * this.engine;
      dp += tv * 2.2 * clamp(c.roll, -1, 1) - 1.2 * this.p;
      dq += tv * 3.2 * clamp(c.pitch, -1, 1) - 1.4 * this.q;
      dr += tv * 3.2 * clamp(c.yaw, -1, 1) - 1.4 * this.r;
    }
    if (broken) {
      const m = Math.max(qd, 0.3);
      dp += this.wingLost * 6.5 * m;
      dr += this.wingLost * 1.4 * m;
    }

    this.p = clamp(this.p + dp * dt, -7, 7);
    this.q = clamp(this.q + dq * dt, -4, 4);
    this.r = clamp(this.r + dr * dt, -3, 3);
    _w.set(this.q, -this.r, -this.p);
    const wl = _w.length();
    if (wl > 1e-8) {
      _dq.setFromAxisAngle(_w.multiplyScalar(1 / wl), wl * dt);
      this.quat.multiply(_dq).normalize();
    }

    _fwd.set(0, 0, -1).applyQuaternion(this.quat);
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _right.set(1, 0, 0).applyQuaternion(this.quat);
    let power = this.engine * (1 - 0.5 * this.dmgEngine);
    if (this.dmgEngine > 0.3) power *= smooth(-0.6, 0.6, Math.sin(t * 1.3 + k) + Math.sin(t * 3.1 + k * 2) + 1.7 - 2.4 * this.dmgEngine);
    const thrust = this.engineOut ? 0 : (s.thrust * this.throttle + s.abThrust * this.ab) * power;
    _f.copy(_fwd).multiplyScalar(thrust);
    if (v > 0.5) {
      _vh.copy(_va).multiplyScalar(1 / v);
      let cl = liftCoef(a, s);
      if (this.stalled && a <= s.aCrit && a >= s.aCritNeg) cl *= 0.75;
      if (broken) cl *= 0.45;
      cl *= 1 - 0.18 * dw;
      const v2 = v * v;
      _lift.copy(_up).addScaledVector(_vh, -_up.dot(_vh));
      const ll = _lift.length();
      if (ll > 1e-4) _f.addScaledVector(_lift, s.liftK * cl * v2 / ll);
      let cd = s.cd0K + s.indK * cl * cl + s.sideDrag * this.beta * this.beta;
      if (stalled) { const sa = Math.sin(a); cd += s.cd0K * 3 + s.liftK * 1.4 * sa * sa; }
      if (broken) cd += s.cd0K * 2;
      _f.addScaledVector(_vh, -cd * v2);
      _f.addScaledVector(_right, -s.sideKK * this.beta * v2);
    }
    this.g = _f.dot(_up) / G;
    _f.y -= G;
    this.vel.addScaledVector(_f, dt);
    this.pos.addScaledVector(this.vel, dt);
  }
}
