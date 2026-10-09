// Keyboard and mouse state. Actions resolve through the rebindable key map in settings.
import { settings } from './settings.js';

const held = new Set();
const tapped = new Set();
const buttons = [false, false, false];
const clicked = [false, false, false];
let dx = 0, dy = 0;
let canvas = null;

export const input = {
  active: false, // true while flying; swallows bound keys
  locked: false,
  onUnlock: null,
  onEscape: null,

  init(el) {
    canvas = el;
    addEventListener('keydown', (e) => {
      if (e.code === 'Escape') { if (this.active && this.onEscape) this.onEscape(); return; }
      if (!this.active) return;
      if (e.target instanceof HTMLInputElement) return;
      if (!e.repeat) tapped.add(e.code);
      held.add(e.code);
      if (isBound(e.code) || e.code === 'Tab') e.preventDefault();
    });
    addEventListener('keyup', (e) => held.delete(e.code));
    addEventListener('blur', () => { held.clear(); buttons.fill(false); });
    el.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      if (settings.ctl.mode === 'mouse' && !this.locked) { this.lock(); return; }
      if (e.button < 3) { buttons[e.button] = true; clicked[e.button] = true; }
    });
    addEventListener('mouseup', (e) => { if (e.button < 3) buttons[e.button] = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      dx += e.movementX; dy += e.movementY;
    });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === canvas;
      if (was && !this.locked) { buttons.fill(false); if (this.onUnlock) this.onUnlock(); }
    });
  },

  lock() {
    if (!canvas || this.locked) return;
    try {
      const p = canvas.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => canvas.requestPointerLock());
    } catch { canvas.requestPointerLock(); }
  },
  unlock() { if (document.pointerLockElement) document.exitPointerLock(); },

  down(action) {
    const keys = settings.ctl.keys[action];
    if (keys) for (const k of keys) if (held.has(k)) return true;
    if (action === 'fire') return buttons[0];
    if (action === 'missile') return buttons[2];
    return false;
  },
  hit(action) {
    const keys = settings.ctl.keys[action];
    if (keys) for (const k of keys) if (tapped.has(k)) return true;
    if (action === 'missile') return clicked[2];
    if (action === 'fire') return clicked[0];
    return false;
  },
  axis(neg, pos) { return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0); },
  mouse() { const m = [dx, dy]; dx = dy = 0; return m; },
  endFrame() { tapped.clear(); clicked.fill(false); },
  reset() { held.clear(); tapped.clear(); buttons.fill(false); clicked.fill(false); dx = dy = 0; },
};

function isBound(code) {
  for (const k of Object.values(settings.ctl.keys)) if (k.includes(code)) return true;
  return false;
}
