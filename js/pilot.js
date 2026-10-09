import { Vector3 } from './three.js';
import { G } from './config.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const _f = new Vector3(), _u = new Vector3(), _r = new Vector3(), _p = new Vector3(), _a = new Vector3();

// Flies the nose toward a world-space direction (mouse aim and AI).
// Bank: lift-vector placement (demand toward the aim plus 1 g against gravity, roll it overhead).
// Pitch/yaw: direct nose pointing with a lift feedforward so the nose does not sag.
// Large downward aims roll inverted and pull rather than pushing negative g.
// Returns the angle between nose and aim (rad).
export function steer(air, aim, out, protect = true, aggression = 1) {
  const s = air.spec;
  air.forward(_f); air.up(_u); _r.set(1, 0, 0).applyQuaternion(air.quat);
  const d = clamp(aim.dot(_f), -1, 1);
  const off = Math.acos(d);
  const pitchErr = Math.atan2(aim.dot(_u), d);
  const yawErr = Math.atan2(aim.dot(_r), d);

  _p.copy(aim).addScaledVector(_f, -d);
  const pl = _p.length();
  if (pl < 1e-4) _p.copy(_u); else _p.multiplyScalar(1 / pl);
  const nMax = Math.min(s.maxG, 9) * aggression;
  const nTurn = nMax * clamp(off / 0.5, 0, 1);
  const upDot = _f.y;
  _a.set(-_f.x * upDot, 1 - _f.y * upDot, -_f.z * upDot).addScaledVector(_p, nTurn);
  const ax = _a.dot(_r), ay = _a.dot(_u);
  const bankTo = Math.abs(ax) + Math.abs(ay) < 1e-5 ? 0 : Math.atan2(ax, ay);

  // lead the roll by the airframe's roll time constant so it stops on target
  const qd = Math.min((air.speed / s.vref) ** 2, s.qMax);
  const lead = 1.15 / (s.rollDamp * Math.sqrt(qd) + 0.3);
  out.roll = clamp(2.2 * (bankTo - lead * air.p), -1, 1);

  const v = Math.max(air.speed, 15);
  let aFF = (Math.max(0, ay) * G / (s.liftK * v * v) - s.cl0) / s.cla;
  if (protect) aFF = clamp(aFF, s.aCritNeg * 0.8, s.aCrit * 0.9);
  const span = Math.max(0.05, s.stickAlpha - s.trimAlpha);
  let pitch = (aFF - s.trimAlpha) / span + 3.5 * aggression * pitchErr - 0.4 * air.q;
  if (protect) {
    if (pitch > 0 && air.alpha > s.aCrit * 0.86) pitch *= clamp((s.aCrit * 0.96 - air.alpha) / (s.aCrit * 0.1), 0, 1);
    else if (pitch < 0 && air.alpha < s.aCritNeg * 0.8) pitch *= clamp((air.alpha - s.aCritNeg * 0.95) / (-s.aCritNeg * 0.15), 0, 1);
  }
  out.pitch = clamp(pitch, -1, 1);

  const fine = 1 - smooth(0.06, 0.25, off);
  out.yaw = clamp(4 * yawErr * fine + 1.2 * air.beta * (1 - fine) - 0.45 * air.r, -1, 1);
  return off;
}
