// Per-user preferences, kept in localStorage.
import { AIRCRAFT, AIRCRAFT_ORDER, SANDBOX_DEFAULT } from './config.js';

const KEY = 'contrail.settings.v2';

// [action, label, default keys]
export const ACTIONS = [
  ['throttleUp', 'Throttle up', ['KeyW']],
  ['throttleDown', 'Throttle down', ['KeyS']],
  ['afterburner', 'Afterburner', ['ShiftLeft', 'ShiftRight']],
  ['rollLeft', 'Roll left', ['KeyA', 'ArrowLeft']],
  ['rollRight', 'Roll right', ['KeyD', 'ArrowRight']],
  ['pitchUp', 'Pitch up', ['ArrowDown']],
  ['pitchDown', 'Pitch down', ['ArrowUp']],
  ['yawLeft', 'Rudder left', ['KeyQ']],
  ['yawRight', 'Rudder right', ['KeyE']],
  ['fire', 'Guns', ['Space']],
  ['missile', 'Missile', ['KeyF']],
  ['flare', 'Flare', ['KeyC']],
  ['reload', 'Reload', ['KeyR']],
  ['view', 'Cockpit view', ['KeyV']],
  ['scores', 'Scoreboard', ['Tab']],
];

function defaults() {
  const colors = {};
  for (const id of AIRCRAFT_ORDER) colors[id] = AIRCRAFT[id].color;
  return {
    name: '',
    plane: 'fighter',
    colors,
    sandbox: { ...SANDBOX_DEFAULT },
    gfx: { quality: 'medium', res: 1, blur: false, fog: true, volume: 0.7 },
    ctl: { mode: 'mouse', assist: true, sens: 1, invert: false, keys: Object.fromEntries(ACTIONS.map(([a, , k]) => [a, [...k]])) },
    solo: { mode: 'dogfight', map: 'alpine', wind: 'light', arena: 'medium' },
    host: { mode: 'casual', map: 'alpine', wind: 'light', arena: 'medium', bots: 0, skill: 'normal' },
    bestWave: 0,
    unlocked: false,
    overdrive: false,
    eggs: { blackbird: false, rocket: false },
    ach: {},
    stats: { kills: 0, deaths: 0, flight: 0, top: 0, headshots: 0 },
  };
}

function merge(base, over) {
  if (!over || typeof over !== 'object') return base;
  for (const k of Object.keys(base)) {
    if (!(k in over)) continue;
    const b = base[k], o = over[k];
    if (b && typeof b === 'object' && !Array.isArray(b)) {
      if (!Object.keys(b).length && o && typeof o === 'object') base[k] = { ...o };
      else merge(b, o);
    }
    else if (typeof o === typeof b || (Array.isArray(b) && Array.isArray(o))) base[k] = o;
  }
  return base;
}

function load() {
  try { return merge(defaults(), JSON.parse(localStorage.getItem(KEY))); } catch { return defaults(); }
}

export const settings = load();
if (settings.unlocked) settings.eggs.blackbird = true;

export function save() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

export function resetKeys() {
  settings.ctl.keys = defaults().ctl.keys;
  save();
}

export function loadout() {
  return { type: settings.plane, color: settings.colors[settings.plane], sb: { ...settings.sandbox } };
}

const NAMES = { Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'R Shift', ControlLeft: 'Ctrl', ControlRight: 'R Ctrl', AltLeft: 'Alt', Tab: 'Tab',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Enter', Backspace: 'Bksp', CapsLock: 'Caps' };

export function keyName(code) {
  if (NAMES[code]) return NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
