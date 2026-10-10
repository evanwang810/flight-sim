// Achievements and lifetime stats, saved with the rest of the settings. The game reports events; a few
// things (speed, low flying, landings, rolls, spins) are checked every frame from the player's plane.
import { settings, save } from './settings.js';
import { MACH } from './config.js';

export const ACHIEVEMENTS = [
  ['first_blood', 'First blood', 'Shoot down your first enemy.'],
  ['ace', 'Ace in a day', 'Five kills without dying.'],
  ['fox_two', 'Fox two', 'Score a kill with a missile.'],
  ['long_shot', 'Long shot', 'Gun kill from more than 900 m away.'],
  ['headshot', 'Through the canopy', 'Hit the pilot. Good luck.'],
  ['ram', 'Kamikaze', 'Take someone down by flying into them.'],
  ['tape', 'Held together with tape', 'Get a kill with less than 15 % health left.'],
  ['wave5', 'Holding the line', 'Reach wave 5 in Dogfight.'],
  ['wave10', 'Untouchable', 'Reach wave 10 in Dogfight.'],
  ['flare', 'Not today', 'Pull a missile off you with a flare.'],
  ['dodge', 'Juke', 'Outfly a missile without using flares.'],
  ['sound', 'Sound barrier', 'Go supersonic.'],
  ['mach3', 'Speed demon', 'Reach Mach 3.'],
  ['low', 'Grass cutter', 'Stay under 15 m above the ground at over 700 km/h for 3 seconds.'],
  ['roll', 'Do a barrel roll', 'Roll all the way around in under 1.5 seconds.'],
  ['spin', 'Departure', 'Get into a spin and fly out of it.'],
  ['land', 'Greaser', 'Touch down and roll to a stop in one piece.'],
  ['splash', 'Swimming lessons', 'Find out what happens when you hit the sea.'],
  ['space', 'Escape velocity', 'Take the Tin Can above 10 km.', true],
  ['orbit', 'Orbital', 'Hit 7.8 km/s. Nothing is stopping you now.', true],
  ['blackbird', 'Back of the hangar', 'Find the hidden aircraft.', true],
  ['liftoff', 'Way past the hangar', 'Find the other hidden aircraft.', true],
  ['host', 'Air boss', 'Host a room with six or more pilots.'],
  ['win', 'Top of the board', 'Win a multiplayer match.'],
  ['replay', 'Instant replay', 'Watch a replay.'],
];

const STAT_LABELS = [['kills', 'Kills'], ['deaths', 'Deaths'], ['flight', 'Hours flown'], ['top', 'Top speed (km/h)'], ['headshots', 'Headshots']];

let toastEl = null, queue = [], showing = false;

function toast(name) {
  if (typeof document === 'undefined') return;
  if (!toastEl) toastEl = document.getElementById('ach-toast');
  if (!toastEl) return;
  queue.push(name);
  if (!showing) next();
}
function next() {
  const name = queue.shift();
  if (!name) { showing = false; return; }
  showing = true;
  toastEl.innerHTML = '<span>Achievement</span><b></b>';
  toastEl.lastChild.textContent = name;
  toastEl.classList.remove('on');
  void toastEl.offsetWidth;
  toastEl.classList.add('on');
  setTimeout(next, 3600);
}

export const ach = {
  run: { kills: 0, low: 0, rollAcc: 0, rollT: 0, spinT: 0, spun: false, calmT: 0, groundT: 0, saveT: 0 },

  has(id) { return !!settings.ach[id]; },

  unlock(id) {
    if (settings.ach[id]) return;
    const a = ACHIEVEMENTS.find((x) => x[0] === id);
    if (!a) return;
    settings.ach[id] = Date.now();
    save();
    toast(a[1]);
  },

  stat(k, v) { settings.stats[k] = (settings.stats[k] || 0) + v; },

  // kill by the player: { cause, dist, hp (0..1), wingLost }
  kill(k) {
    this.stat('kills', 1);
    this.run.kills++;
    this.unlock('first_blood');
    if (this.run.kills >= 5) this.unlock('ace');
    if (k.cause === 'missile') this.unlock('fox_two');
    if (k.cause === 'shot' && k.dist > 900) this.unlock('long_shot');
    if (k.cause === 'headshot') { this.unlock('headshot'); this.stat('headshots', 1); }
    if (k.cause === 'collision') this.unlock('ram');
    if (k.hp < 0.15) this.unlock('tape');
    save();
  },

  death(cause) {
    this.stat('deaths', 1);
    this.run.kills = 0;
    if (cause === 'water') this.unlock('splash');
    save();
  },

  event(type, n) {
    if (type === 'wave') { if (n >= 5) this.unlock('wave5'); if (n >= 10) this.unlock('wave10'); }
    else if (type === 'host') { if (n >= 6) this.unlock('host'); }
    else this.unlock(type);
  },

  // every frame while the player is alive
  tick(me, game, dt) {
    const a = me.air, r = this.run, s = settings.stats;
    s.flight = (s.flight || 0) + dt / 3600;
    const kmh = a.speed * 3.6;
    if (kmh > (s.top || 0)) s.top = Math.round(kmh);
    if (a.speed > MACH) this.unlock('sound');
    if (a.speed > MACH * 3) this.unlock('mach3');
    if (me.spec.rocket && a.pos.y > 10000) this.unlock('space');
    if (a.speed > 7800) this.unlock('orbit');
    const agl = a.pos.y - game.world.surfaceAt(a.pos.x, a.pos.z);
    r.low = agl < 15 && kmh > 700 ? r.low + dt : 0;
    if (r.low > 3) this.unlock('low');
    // barrel roll: 360 degrees of roll inside 1.5 s
    r.rollAcc += a.p * dt; r.rollT += dt;
    if (Math.abs(r.rollAcc) >= Math.PI * 2) this.unlock('roll');
    if (r.rollT > 1.5 || Math.sign(a.p) !== Math.sign(r.rollAcc)) { r.rollAcc = 0; r.rollT = 0; }
    // spin, then three calm seconds flying normally
    if (a.stalled && Math.abs(a.p) > 1.4 && Math.abs(a.r) > 0.5) { r.spinT += dt; if (r.spinT > 1.5) r.spun = true; r.calmT = 0; }
    else if (r.spun) { r.calmT = !a.stalled && Math.abs(a.p) < 0.5 ? r.calmT + dt : 0; if (r.calmT > 3) { this.unlock('spin'); r.spun = false; r.spinT = 0; } }
    // landing: resting on the ground, nearly stopped, airframe mostly intact
    r.groundT = me.grounded && a.speed < 4 && me.hp.body > me.spec.hp.body * 0.6 && me.hp.wl > 0 && me.hp.wr > 0 ? r.groundT + dt : 0;
    if (r.groundT > 1.5) this.unlock('land');
    r.saveT -= dt;
    if (r.saveT <= 0) { r.saveT = 15; save(); }
  },

  render(root) {
    root.innerHTML = '';
    const stats = document.createElement('div');
    stats.className = 'bigstats';
    for (const [k, label] of STAT_LABELS) {
      let v = settings.stats[k] || 0;
      if (k === 'flight') v = v.toFixed(1);
      const d = document.createElement('div');
      d.innerHTML = '<b></b><span></span>';
      d.firstChild.textContent = v; d.lastChild.textContent = label;
      stats.appendChild(d);
    }
    root.appendChild(stats);
    const got = ACHIEVEMENTS.filter((a) => settings.ach[a[0]]).length;
    const head = document.createElement('p');
    head.className = 'note';
    head.textContent = `${got} of ${ACHIEVEMENTS.length} unlocked`;
    root.appendChild(head);
    const grid = document.createElement('div');
    grid.className = 'achs';
    for (const [id, name, desc, secret] of ACHIEVEMENTS) {
      const on = !!settings.ach[id];
      const c = document.createElement('div');
      c.className = on ? 'ach on' : 'ach';
      c.innerHTML = '<b></b><span></span>';
      c.firstChild.textContent = on || !secret ? name : 'Hidden';
      c.lastChild.textContent = on || !secret ? desc : 'Keep playing.';
      grid.appendChild(c);
    }
    root.appendChild(grid);
  },
};
