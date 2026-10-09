// Static game data: aircraft, modes, tuning constants.

export const GAME_NAME = 'Contrail';
export const PEER_PREFIX = 'contrail2-';
export const G = 9.81;

export const KILL_LIMIT = 10;
// Room size counts people and bots together.
export const MAX_PLAYERS = 20;
export const MAX_BOTS = 19;
export const SECRET = 'blackbird';
export const RESPAWN_TIME = 3;
export const SOLO_LIVES = 3;
export const MISSILES = 2;
export const FLARES = 3;
export const MACH = 343;
// Combat area radius by setting; free flight has no wall. Ceiling is per map (biomes maxH + CEILING).
export const ARENAS = { small: 3000, medium: 4500, large: 7000 };
export const CEILING = 2000;

// Flight model notes:
//   vstall/vmax/vref in m/s, thrust in m/s^2 (thrust-to-weight * g).
//   stickAlpha = steady angle of attack at full back stick; above aCrit means full stick can stall it.
//   *Auth / *Stab / *Damp are angular accelerations at reference dynamic pressure (v = vref).
// hit: body spheres along the fuselage [z, radius] plus one sphere per wing at x = +-wingX.
export const AIRCRAFT = {
  fighter: {
    name: 'Viper', role: 'Fighter', color: '#8b99ab',
    blurb: 'Fast, agile and hard to stall. Hold Shift for afterburner.',
    stats: { speed: 8, agility: 7, armor: 5 },
    vstall: 47, vmax: 215, vref: 150, trimSpeed: 170, thrust: 7.5, abThrust: 4.5, spool: 0.9, qMax: 2,
    cl0: 0.02, cla: 4.0, aCrit: 0.44, aCritNeg: -0.32, stickAlpha: 0.4, ind: 0.065,
    pitchStab: 30, pitchDamp: 6, rollAuth: 12, rollDamp: 3, yawAuth: 3, yawStab: 14, yawDamp: 4, dihedral: 0.8,
    sideK: 1.0, maxG: 9, minG: -3, stallCtrl: 0.4, buffet: 0.8,
    hp: { body: 100, wing: 60 },
    hit: { r: 9, body: [[-5, 1.8], [-1.5, 2.1], [2, 2.1], [5.5, 1.8]], wingX: 3.4, wingZ: 2, wingR: 2.6 },
    gun: { rate: 15, vel: 1000, dmg: 9, spread: 0.0025, mag: 150, reload: 2.5 },
    cam: { dist: 22, height: 4.5, cockpit: [0, 0.85, -3.4] },
  },
  lancer: {
    name: 'Lancer', role: 'Supersonic interceptor', color: '#d6dbe1',
    blurb: 'A dart with two huge engines. Mach 2 on afterburner, sonic booms included. Turns like a freight train, so use the speed.',
    stats: { speed: 10, agility: 4, armor: 5 },
    vstall: 72, vmax: 355, vref: 260, trimSpeed: 260, thrust: 7, abThrust: 18, spool: 0.8, qMax: 2.4,
    cl0: 0, cla: 3.0, aCrit: 0.52, aCritNeg: -0.42, stickAlpha: 0.44, ind: 0.11,
    pitchStab: 32, pitchDamp: 7, rollAuth: 13, rollDamp: 3, yawAuth: 2.4, yawStab: 16, yawDamp: 4, dihedral: 0.5,
    sideK: 0.9, maxG: 7.5, minG: -3, stallCtrl: 0.45, buffet: 0.6,
    hp: { body: 110, wing: 65 },
    hit: { r: 14, body: [[-10, 1.7], [-5, 2.1], [0, 2.3], [5, 2.3], [9.5, 1.9]], wingX: 4, wingZ: 5, wingR: 3.4 },
    gun: { rate: 18, vel: 1150, dmg: 8, spread: 0.0025, mag: 180, reload: 2.6 },
    cam: { dist: 30, height: 6, cockpit: [0, 1.05, -7.6] },
  },
  // Not an aircraft. No wings; steers by swivelling its engines (tvc) and ignores the altitude ceiling.
  rocket: {
    name: 'Tin Can', role: 'Reusable booster', color: '#eceff2', rocket: true,
    blurb: 'Not technically an aircraft. No wings, steers by swivelling its engines, and has legs, so in theory it lands. Point it up.',
    stats: { speed: 9, agility: 3, armor: 7 },
    vstall: 150, vmax: 520, vref: 220, trimSpeed: 240, thrust: 30, abThrust: 20, spool: 1.4, qMax: 2, tvc: 1,
    cl0: 0, cla: 0.6, aCrit: 1.4, aCritNeg: -1.4, stickAlpha: 0.5, ind: 0.02,
    pitchStab: 1.5, pitchDamp: 2, rollAuth: 2, rollDamp: 2, yawAuth: 1, yawStab: 1.5, yawDamp: 2, dihedral: 0,
    sideK: 0.4, maxG: 12, minG: -6, stallCtrl: 1, buffet: 0, spin: 0,
    hp: { body: 150, wing: 40 },
    hit: { r: 23, body: [[-19, 2.3], [-10, 2.3], [0, 2.3], [9, 2.3], [17, 2.3]], wingX: 2.7, wingZ: -12, wingR: 1.3 },
    gun: { rate: 7, vel: 900, dmg: 12, spread: 0.008, mag: 60, reload: 3 },
    cam: { dist: 75, height: 12, cockpit: [0, 0.6, -19.5] },
  },
  // Easter egg: not in AIRCRAFT_ORDER until unlocked from the menu.
  blackbird: {
    name: 'Blackbird', role: 'Mach 3 reconnaissance', color: '#1e2126', hidden: true,
    blurb: 'You found it. Mach 3 in a straight line, a turning circle the size of a county, and no business being in a dogfight.',
    stats: { speed: 10, agility: 2, armor: 6 },
    vstall: 80, vmax: 420, vref: 300, trimSpeed: 300, thrust: 9, abThrust: 89, spool: 1.2, qMax: 2.4,
    cl0: 0.02, cla: 2.8, aCrit: 0.5, aCritNeg: -0.4, stickAlpha: 0.42, ind: 0.14,
    pitchStab: 26, pitchDamp: 6, rollAuth: 7, rollDamp: 2.6, yawAuth: 1.8, yawStab: 14, yawDamp: 4, dihedral: 0.6,
    sideK: 0.9, maxG: 4, minG: -2, stallCtrl: 0.4, buffet: 0.7,
    hp: { body: 160, wing: 90 },
    hit: { r: 19, body: [[-14, 1.8], [-7, 2.2], [0, 2.4], [7, 2.4], [13, 2]], wingX: 5.5, wingZ: 6, wingR: 4 },
    gun: { rate: 14, vel: 1250, dmg: 9, spread: 0.0025, mag: 160, reload: 2.8 },
    cam: { dist: 42, height: 7, cockpit: [0, 1.0, -11.5] },
  },
  trainer: {
    name: 'Kestrel', role: 'Prop trainer', color: '#e7b13b',
    blurb: 'Slow, forgiving and turns inside anything. The engine starves under negative g, so no inverted flight.',
    stats: { speed: 2, agility: 9, armor: 3 },
    vstall: 22, vmax: 68, vref: 45, trimSpeed: 50, thrust: 3.2, abThrust: 0, spool: 1.6, qMax: 1.8, carb: true,
    cl0: 0.35, cla: 5.2, aCrit: 0.26, aCritNeg: -0.09, stickAlpha: 0.29, ind: 0.05,
    pitchStab: 16, pitchDamp: 4, rollAuth: 3.3, rollDamp: 2.2, yawAuth: 1.6, yawStab: 8, yawDamp: 3, dihedral: 1.2,
    sideK: 1.2, maxG: 6, minG: -2.5, stallCtrl: 0.35, buffet: 1,
    hp: { body: 75, wing: 45 },
    hit: { r: 7, body: [[-2.5, 1.5], [0.5, 1.7], [3, 1.2]], wingX: 3.4, wingZ: 0, wingR: 2.4 },
    gun: { rate: 12, vel: 850, dmg: 8, spread: 0.003, mag: 120, reload: 2.2 },
    cam: { dist: 14, height: 3.5, cockpit: [0, 0.95, -0.4] },
  },
  airliner: {
    name: 'Albatross', role: 'Airliner', color: '#e9edf2',
    blurb: 'Huge, heavy and very hard to bring down. Turns like a bank vault. Do not stall it.',
    stats: { speed: 4, agility: 1, armor: 10 },
    vstall: 62, vmax: 140, vref: 100, trimSpeed: 115, thrust: 3.0, abThrust: 0, spool: 0.35, qMax: 1.8,
    cl0: 0.4, cla: 5.5, aCrit: 0.24, aCritNeg: -0.08, stickAlpha: 0.21, ind: 0.04,
    pitchStab: 8, pitchDamp: 3, rollAuth: 0.7, rollDamp: 1.3, yawAuth: 0.5, yawStab: 5, yawDamp: 2, dihedral: 1.5,
    sideK: 0.8, maxG: 2.5, minG: -1, stallCtrl: 0.3, buffet: 1.2,
    hp: { body: 320, wing: 160 },
    hit: { r: 24, body: [[-14, 3.4], [-6, 3.6], [2, 3.6], [10, 3.2], [16, 2.6]], wingX: 10, wingZ: 2, wingR: 6.5 },
    gun: { rate: 9, vel: 950, dmg: 13, spread: 0.004, mag: 120, reload: 3 },
    cam: { dist: 70, height: 15, cockpit: [0, 1.6, -15.5] },
  },
  sandbox: {
    name: 'Sandbox', role: 'Test jet', color: '#5fd4c3',
    blurb: 'Forward-swept test jet. Tune its top speed, control authority and how nasty the stall is.',
    stats: { speed: 7, agility: 7, armor: 5 },
    configurable: true,
  },
};

export const AIRCRAFT_ORDER = ['fighter', 'lancer', 'trainer', 'airliner', 'sandbox', 'rocket'];
export const SANDBOX_DEFAULT = { speed: 220, control: 1, stall: 3 };
export const SWATCHES = ['#8b99ab', '#e7b13b', '#e9edf2', '#5fd4c3', '#d9534f', '#3f7fd8', '#6bbf59', '#2f3540', '#f08cc0', '#ff8c3a'];

const lerp = (a, b, t) => a + (b - a) * t;

function sandboxRaw(cfg) {
  const base = AIRCRAFT.fighter;
  const c = Math.max(0.3, cfg.control ?? 1);
  const st = Math.min(10, Math.max(0, cfg.stall ?? 3)) / 10;
  const speed = Math.min(340, Math.max(70, cfg.speed ?? 220));
  return {
    ...base, ...AIRCRAFT.sandbox, configurable: false,
    vmax: speed, vstall: Math.max(28, 47 * Math.sqrt(speed / 215)), vref: speed * 0.7, trimSpeed: speed * 0.8,
    thrust: 7.5 * (speed / 215), abThrust: 4.5 * (speed / 215),
    clRef: base.cl0 + base.cla * base.aCrit,
    aCrit: lerp(0.95, 0.24, st), aCritNeg: -lerp(0.85, 0.12, st),
    stickAlpha: lerp(0.42, 0.33, st), buffet: lerp(0, 2.2, st), stallCtrl: lerp(0.85, 0.12, st),
    rollAuth: base.rollAuth * c, pitchStab: base.pitchStab * c, yawAuth: base.yawAuth * c,
    rollDamp: base.rollDamp * Math.sqrt(c), pitchDamp: base.pitchDamp * Math.sqrt(c),
    maxG: lerp(7, 12, Math.min(1, c / 2)),
  };
}

// Returns a fresh spec with derived aerodynamic constants.
export function buildSpec(id, sandboxCfg) {
  if (!AIRCRAFT[id]) id = 'fighter';
  const s = id === 'sandbox' ? sandboxRaw(sandboxCfg || SANDBOX_DEFAULT) : { ...AIRCRAFT[id] };
  s.id = id;
  s.clMax = s.cl0 + s.cla * s.aCrit;
  s.liftK = G / ((s.clRef || s.clMax) * s.vstall * s.vstall);
  s.cd0K = s.thrust / (s.vmax * s.vmax);
  s.indK = s.ind * s.liftK;
  s.sideKK = s.sideK * s.liftK;
  s.sideDrag = s.indK * 2;
  const clTrim = G / (s.liftK * s.trimSpeed * s.trimSpeed);
  s.trimAlpha = (clTrim - s.cl0) / s.cla;
  s.pitchAuth = (s.stickAlpha - s.trimAlpha) * s.pitchStab;
  // with flight assist off the stick can drag the wing well past the stall
  s.pitchAuthMax = (Math.max(s.stickAlpha, s.aCrit * 1.35) - s.trimAlpha) * s.pitchStab;
  s.gWindow = Math.min(1.5, s.maxG * 0.2);
  s.gWindowNeg = Math.min(1, -s.minG * 0.4);
  return s;
}

export const MODES = {
  dogfight: { name: 'Dogfight', blurb: 'Waves of AI pilots that get meaner each round. Three lives.' },
  free: { name: 'Free flight', blurb: 'No enemies, no timer. Go look at mountains.' },
  casual: { name: 'Casual', blurb: `Free for all. Any aircraft, respawn after ${RESPAWN_TIME} s. First to ${KILL_LIMIT} kills wins.` },
  competitive: { name: 'Competitive', blurb: 'Everyone flies the same aircraft, one life each. Last pilot standing wins.' },
};

export const WIND = { off: 0, light: 6, strong: 15 };

// Bot skill: aim noise (rad), steering aggression, max stick pull, gun cone (rad), how hard it jinks when
// someone is on its tail, bullet magnetism (humans get 1), seconds between checks of its six, flare chance, whether it uses missiles, reaction time (s).
export const SKILLS = {
  easy: { name: 'Easy', aimErr: 0.05, aggr: 0.65, pull: 0.62, cone: 0.075, jink: 0.12, magnet: 0.25, scan: 4.5, flare: 0.15, missiles: false, react: 0.9 },
  normal: { name: 'Normal', aimErr: 0.028, aggr: 0.8, pull: 0.74, cone: 0.065, jink: 0.28, magnet: 0.4, scan: 3, flare: 0.45, missiles: true, react: 0.55 },
  hard: { name: 'Hard', aimErr: 0.016, aggr: 0.92, pull: 0.86, cone: 0.058, jink: 0.42, magnet: 0.55, scan: 1.8, flare: 0.75, missiles: true, react: 0.35 },
  ace: { name: 'Ace', aimErr: 0.008, aggr: 1, pull: 1, cone: 0.052, jink: 0.55, magnet: 0.7, scan: 0.9, flare: 0.92, missiles: true, react: 0.2 },
};

export const PLAYER_COLORS = ['#ff6b5a', '#5ab8ff', '#ffd25a', '#7ee081', '#c78bff', '#ff9a3d', '#4ee0d0', '#ff7fc4'];
export const BOT_NAMES = ['Rook', 'Jester', 'Iceman', 'Ghost', 'Hollywood', 'Maverick', 'Cougar', 'Merlin', 'Stinger', 'Sundown', 'Wolfman', 'Slider'];
