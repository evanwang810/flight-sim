// In-flight HUD: DOM readouts plus one overlay canvas for symbology, and a small radar.
import * as THREE from './three.js';
import { leadDir } from './combat.js';
import { settings } from './settings.js';
import { KILL_LIMIT } from './config.js';

const $ = (id) => document.getElementById(id);
const ENEMY = '#ff5a48', WHITE = 'rgba(255,255,255,0.92)', DIM = 'rgba(255,255,255,0.5)';
const _p = new THREE.Vector3(), _c = new THREE.Vector3(), _f = new THREE.Vector3(), _ld = new THREE.Vector3(), _r = new THREE.Vector3();

function hpColor(f) {
  if (f <= 0) return 'rgba(120,120,120,0.55)';
  if (f > 0.6) return '#8fdc7a';
  if (f > 0.3) return '#f2c94c';
  return '#ff5a48';
}

export class HUD {
  constructor() {
    this.root = $('hud');
    this.cv = $('hud-canvas');
    this.ctx = this.cv.getContext('2d');
    this.radar = $('radar').getContext('2d');
    this.dmg = $('dmg').getContext('2d');
    this.el = {
      spd: $('spd'), alt: $('alt'), thr: $('thr'), ab: $('thr-ab'), ammo: $('ammo'), reload: $('reload'), msl: $('msl'), flr: $('flr'),
      feed: $('feed'), status: $('status'), warn: $('warn'), toast: $('toast'), dead: $('dead'), board: $('board'), vignette: $('vignette'),
    };
    this.cache = {};
    this.hits = [];
    this.toastT = 0;
    this.dmgFlash = 0;
    this.feedKey = '';
    this.textT = 0;
    this.scores = null;
    this.showBoard = false;
  }

  show(on) { this.root.hidden = !on; if (!on) this.el.dead.hidden = true; }

  set(key, el, text) {
    if (this.cache[key] === text) return;
    this.cache[key] = text;
    el.textContent = text;
  }

  toast(title, sub = '') {
    this.el.toast.innerHTML = `<b></b><span></span>`;
    this.el.toast.firstChild.textContent = title;
    this.el.toast.lastChild.textContent = sub;
    this.el.toast.classList.remove('on');
    void this.el.toast.offsetWidth;
    this.el.toast.classList.add('on');
  }

  hitMarker(missile, kill = false) { this.hits.push({ t: 0, kill, missile }); if (this.hits.length > 6) this.hits.shift(); }
  damage() { this.dmgFlash = 1; }

  died(killer, cause) {
    this.deathText = cause === 'headshot' ? `${killer} hit you right through the canopy` : killer ? `Shot down by ${killer}`
      : { water: 'You hit the water', 'left the area': 'You left the combat area', explosion: 'Caught in the blast', collision: 'Mid-air collision' }[cause] || 'You crashed';
  }

  update(g, dt) {
    const me = g.me;
    if (!me) return;
    const cv = this.cv, dpr = Math.min(devicePixelRatio || 1, 2);
    const W = innerWidth, H = innerHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const x = this.ctx;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, W, H);
    this.textT -= dt;
    const slowTick = this.textT <= 0;
    if (slowTick) this.textT = 0.08;

    const cam = g.camera;
    cam.updateMatrixWorld();
    const proj = (v) => {
      _c.copy(v).applyMatrix4(cam.matrixWorldInverse);
      if (_c.z > -1) return null;
      _p.copy(v).project(cam);
      return [(_p.x * 0.5 + 0.5) * W, (-_p.y * 0.5 + 0.5) * H];
    };

    const a = me.air;
    if (me.alive) {
      if (slowTick) {
        this.set('spd', this.el.spd, Math.round(a.speed * 3.6));
        this.set('alt', this.el.alt, Math.round(a.pos.y - (g.world.map.water ?? 0)));
        const gv = document.getElementById('gval');
        this.set('g', gv, a.g.toFixed(1));
        gv.parentNode.className = 'gread' + (a.g > me.spec.maxG * 0.85 || a.g < -2 ? ' hi' : a.g > 5 ? ' mid' : '');
        this.el.thr.style.height = `${Math.round(a.throttle * 100)}%`;
        this.el.ab.style.opacity = a.ab > 0.1 ? a.ab : 0;
        const gun = me.spec.gun;
        this.set('ammo', this.el.ammo, me.reload > 0 ? '--' : me.ammo);
        this.el.reload.style.width = me.reload > 0 ? `${(1 - me.reload / gun.reload) * 100}%` : `${(me.ammo / gun.mag) * 100}%`;
        this.el.reload.classList.toggle('loading', me.reload > 0);
        this.pips('mslp', this.el.msl, me.missiles, 2);
        this.pips('flrp', this.el.flr, me.flares, 3);
        this.drawDamage(me);
      }

      // nose (where the guns point) and mouse aim
      a.forward(_f);
      const nose = proj(_r.copy(a.pos).addScaledVector(_f, 800));
      if (nose) this.cross(x, nose[0], nose[1]);
      if (settings.ctl.mode === 'mouse' && g.cam.view === 'chase') {
        const aim = proj(_r.copy(cam.position).addScaledVector(g.aimDir, 1000));
        if (aim) { x.strokeStyle = WHITE; x.lineWidth = 1.5; x.beginPath(); x.arc(aim[0], aim[1], 9, 0, Math.PI * 2); x.stroke(); }
      } else if (settings.ctl.mode === 'mouse') {
        const aim = proj(_r.copy(a.pos).addScaledVector(g.aimDir, 1000));
        if (aim) { x.strokeStyle = WHITE; x.lineWidth = 1.5; x.beginPath(); x.arc(aim[0], aim[1], 9, 0, Math.PI * 2); x.stroke(); }
      }

      // lead pipper on the enemy closest to the nose
      let tgt = null, best = 0.6;
      for (const p of g.planeList) {
        if (p === me || !p.alive || p.team === me.team) continue;
        const d = p.air.pos.distanceTo(a.pos);
        if (d > 1300) continue;
        _r.copy(p.air.pos).sub(a.pos).normalize();
        const ang = _r.angleTo(_f);
        if (ang < best) { best = ang; tgt = p; }
      }
      if (tgt) {
        const tof = leadDir(a.pos, a.vel, tgt.air.pos, tgt.air.vel, me.spec.gun.vel, _ld);
        if (tof > 0) {
          const d = tgt.air.pos.distanceTo(a.pos);
          const pp = proj(_r.copy(a.pos).addScaledVector(_ld, d));
          if (pp) {
            const on = _ld.angleTo(_f) < 0.03;
            x.strokeStyle = on ? '#ffd25a' : ENEMY; x.lineWidth = 2;
            x.beginPath(); x.arc(pp[0], pp[1], 6, 0, Math.PI * 2); x.stroke();
            x.beginPath(); x.arc(pp[0], pp[1], 1.5, 0, Math.PI * 2); x.fillStyle = x.strokeStyle; x.fill();
          }
        }
      }
    }

    // enemy markers and edge arrows
    for (const p of g.planeList) {
      if (p === me || !p.alive || (p.team === me.team && p !== me)) continue;
      const d = p.air.pos.distanceTo(cam.position);
      const s = proj(p.air.pos);
      const label = d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`;
      const m = 26;
      if (s && s[0] > m && s[0] < W - m && s[1] > m && s[1] < H - m) {
        const r = Math.max(9, Math.min(26, 1400 / d * (p.spec.hit.r / 9) * 6));
        x.strokeStyle = ENEMY; x.lineWidth = 1.6;
        this.bracket(x, s[0], s[1], r);
        x.font = '600 11px system-ui, sans-serif'; x.textAlign = 'center'; x.fillStyle = ENEMY;
        x.fillText(g.online ? `${p.name}  ${label}` : label, s[0], s[1] + r + 14);
        if (d < 1600) {
          const f = Math.max(0, p.hp.body / p.spec.hp.body);
          x.fillStyle = 'rgba(0,0,0,0.4)'; x.fillRect(s[0] - 14, s[1] - r - 8, 28, 3);
          x.fillStyle = hpColor(f); x.fillRect(s[0] - 14, s[1] - r - 8, 28 * f, 3);
        }
      } else {
        _c.copy(p.air.pos).applyMatrix4(cam.matrixWorldInverse);
        let ang = Math.atan2(-_c.y, _c.x);
        if (_c.z > 0 && Math.abs(_c.x) < 1e-3 && Math.abs(_c.y) < 1e-3) ang = Math.PI / 2;
        const cx = W / 2, cy = H / 2, rx = W / 2 - 40, ry = H / 2 - 40;
        const k = Math.min(rx / Math.abs(Math.cos(ang) || 1e-6), ry / Math.abs(Math.sin(ang) || 1e-6));
        const ex = cx + Math.cos(ang) * k, ey = cy + Math.sin(ang) * k;
        x.save(); x.translate(ex, ey); x.rotate(ang);
        x.fillStyle = ENEMY; x.beginPath(); x.moveTo(11, 0); x.lineTo(-6, -7); x.lineTo(-3, 0); x.lineTo(-6, 7); x.closePath(); x.fill();
        x.restore();
        x.font = '600 10px system-ui, sans-serif'; x.textAlign = 'center'; x.fillStyle = ENEMY;
        x.fillText(label, ex - Math.cos(ang) * 22, ey - Math.sin(ang) * 22 + 3);
      }
    }

    // lock box
    if (me.alive && me.lock.target && me.lock.target.alive) {
      const s = proj(me.lock.target.air.pos);
      if (s) {
        const k = Math.min(1, me.lock.t / 1.5), size = 34 - 14 * k;
        x.strokeStyle = me.lockedOn ? '#ffd25a' : 'rgba(255,210,90,0.75)'; x.lineWidth = me.lockedOn ? 2.2 : 1.4;
        if (!me.lockedOn) x.setLineDash([5, 4]);
        x.strokeRect(s[0] - size, s[1] - size, size * 2, size * 2);
        x.setLineDash([]);
        if (me.lockedOn) { x.font = '700 11px system-ui, sans-serif'; x.fillStyle = '#ffd25a'; x.textAlign = 'center'; x.fillText('LOCK', s[0], s[1] - size - 6); }
      }
    }

    // hit markers
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      h.t += dt;
      const life = h.kill ? 0.6 : 0.22;
      if (h.t > life) { this.hits.splice(i, 1); continue; }
      const al = 1 - h.t / life, r0 = h.kill ? 12 : 7, r1 = h.kill ? 22 : 13;
      x.strokeStyle = h.kill ? `rgba(255,90,72,${al})` : `rgba(255,255,255,${al})`; x.lineWidth = h.kill ? 3 : 2;
      const cx = W / 2, cy = H / 2;
      x.beginPath();
      for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { x.moveTo(cx + sx * r0, cy + sy * r0); x.lineTo(cx + sx * r1, cy + sy * r1); }
      x.stroke();
    }

    this.drawRadar(g);
    this.warnings(g, slowTick);
    if (slowTick) { this.updateFeed(g); this.updateStatus(g); this.updateDead(g); this.updateBoard(g); }

    this.dmgFlash = Math.max(0, this.dmgFlash - dt * 2.5);
    const gray = me.alive ? Math.min(1, me.gStress) : 0;
    this.el.vignette.style.opacity = Math.min(1, Math.max(gray * 0.95, this.dmgFlash * 0.5)).toFixed(2);
    this.el.vignette.classList.toggle('hurt', this.dmgFlash * 0.5 > gray);
    this.el.vignette.classList.toggle('red', a.g < -1.5 && gray > 0.1);
    this.el.vignette.classList.toggle('black', !!me.blackout);
  }

  cross(x, cx, cy) {
    x.strokeStyle = WHITE; x.lineWidth = 1.6;
    x.beginPath();
    x.moveTo(cx - 12, cy); x.lineTo(cx - 4, cy); x.moveTo(cx + 4, cy); x.lineTo(cx + 12, cy);
    x.moveTo(cx, cy - 12); x.lineTo(cx, cy - 4); x.moveTo(cx, cy + 4); x.lineTo(cx, cy + 12);
    x.stroke();
  }

  bracket(x, cx, cy, r) {
    const k = r * 0.45;
    x.beginPath();
    for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      x.moveTo(cx + sx * r, cy + sy * (r - k)); x.lineTo(cx + sx * r, cy + sy * r); x.lineTo(cx + sx * (r - k), cy + sy * r);
    }
    x.stroke();
  }

  pips(key, el, n, max) {
    const s = `${n}/${max}`;
    if (this.cache[key] === s) return;
    this.cache[key] = s;
    el.innerHTML = '';
    for (let i = 0; i < max; i++) { const d = document.createElement('i'); if (i < n) d.className = 'on'; el.appendChild(d); }
  }

  drawDamage(me) {
    const x = this.dmg, hp = me.spec.hp;
    x.clearRect(0, 0, 64, 64);
    x.fillStyle = hpColor(me.hp.wl / hp.wing); x.beginPath(); x.moveTo(28, 26); x.lineTo(4, 38); x.lineTo(4, 44); x.lineTo(28, 40); x.fill();
    x.fillStyle = hpColor(me.hp.wr / hp.wing); x.beginPath(); x.moveTo(36, 26); x.lineTo(60, 38); x.lineTo(60, 44); x.lineTo(36, 40); x.fill();
    x.fillStyle = hpColor(me.hp.body / hp.body);
    x.beginPath(); x.moveTo(32, 4); x.lineTo(37, 14); x.lineTo(37, 50); x.lineTo(44, 58); x.lineTo(20, 58); x.lineTo(27, 50); x.lineTo(27, 14); x.fill();
  }

  drawRadar(g) {
    const x = this.radar, S = 150, R = 70, range = 3200, me = g.me, cam = g.camera;
    x.clearRect(0, 0, S, S);
    x.fillStyle = 'rgba(8,12,18,0.42)'; x.beginPath(); x.arc(75, 75, R, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(255,255,255,0.14)'; x.lineWidth = 1;
    x.beginPath(); x.arc(75, 75, R * 0.5, 0, Math.PI * 2); x.stroke();
    x.beginPath(); x.arc(75, 75, R, 0, Math.PI * 2); x.stroke();
    const ref = me.alive ? me.air : null;
    const pos = ref ? ref.pos : cam.position;
    cam.getWorldDirection(_f);
    if (ref) ref.forward(_f);
    const hd = Math.atan2(_f.x, -_f.z);
    const cs = Math.cos(-hd), sn = Math.sin(-hd);
    const plot = (wx, wz) => {
      const dx = wx - pos.x, dz = wz - pos.z;
      const rx = dx * cs - (-dz) * sn, ry = dx * sn + (-dz) * cs;
      const d = Math.hypot(rx, ry), k = Math.min(1, R / range * 1) * (d > range ? range / d : 1);
      return [75 + rx * (R / range) * (d > range ? range / d : 1), 75 - ry * (R / range) * (d > range ? range / d : 1), d > range];
    };
    if (g.arenaR && Math.hypot(pos.x, pos.z) > g.arenaR - range) {
      x.strokeStyle = 'rgba(255,90,72,0.55)';
      x.save(); x.beginPath(); x.arc(75, 75, R, 0, Math.PI * 2); x.clip();
      const c = plot(0, 0), rr = g.arenaR * R / range;
      x.beginPath(); x.arc(c[0], c[1], rr, 0, Math.PI * 2); x.stroke();
      x.restore();
    }
    for (const m of g.combat.missiles) {
      const [px, py, out] = plot(m.pos.x, m.pos.z);
      if (out) continue;
      x.fillStyle = m.target === me ? '#ffffff' : 'rgba(255,255,255,0.5)';
      x.fillRect(px - 1.5, py - 1.5, 3, 3);
    }
    for (const p of g.planeList) {
      if (p === me || !p.alive) continue;
      const [px, py, out] = plot(p.air.pos.x, p.air.pos.z);
      const enemy = p.team !== me.team;
      x.fillStyle = enemy ? ENEMY : '#5ab8ff';
      x.globalAlpha = out ? 0.55 : 1;
      x.beginPath(); x.arc(px, py, out ? 2.5 : 3.5, 0, Math.PI * 2); x.fill();
      x.globalAlpha = 1;
    }
    x.fillStyle = WHITE;
    x.beginPath(); x.moveTo(75, 69); x.lineTo(79, 79); x.lineTo(75, 77); x.lineTo(71, 79); x.closePath(); x.fill();
  }

  warnings(g, slowTick) {
    const me = g.me;
    let text = '', cls = '';
    if (me.alive) {
      const inc = g.combat.incoming(me);
      const a = me.air;
      let impact = false;
      if (a.vel.y < -5) {
        for (const t of [1, 2, 3]) {
          _r.copy(a.pos).addScaledVector(a.vel, t);
          if (_r.y < g.world.surfaceAt(_r.x, _r.z)) { impact = true; break; }
        }
      }
      if (inc) { text = `MISSILE  ${Math.round(inc.d)} m`; cls = 'red blink'; }
      else if (impact) { text = 'PULL UP'; cls = 'red blink'; }
      else if (me.warnState) { text = me.warnState === 2 ? 'LOCKED ON' : 'LOCK WARNING'; cls = 'amber'; }
      else if (me.outT > 0.05) { text = `RETURN TO THE COMBAT AREA  ${Math.max(0, Math.ceil(6 - me.outT))}`; cls = 'red'; }
      else if (a.pos.y > g.ceiling - 120) { text = 'ALTITUDE LIMIT'; cls = 'amber'; }
      else if (me.reload > 0) { text = 'RELOADING'; cls = 'dim'; }
    }
    if (this.cache.warn !== text + cls) {
      this.cache.warn = text + cls;
      this.el.warn.textContent = text;
      this.el.warn.className = cls;
    }
  }

  updateFeed(g) {
    const now = performance.now();
    const items = g.feed.filter((f) => now - f.t < 7000);
    const key = items.map((f) => f.t).join(',');
    if (key === this.feedKey) return;
    this.feedKey = key;
    const el = this.el.feed;
    el.innerHTML = '';
    for (const f of items) {
      const row = document.createElement('div');
      const v = document.createElement('b'); v.textContent = f.victim; v.style.color = f.vc;
      if (f.killer) {
        const k = document.createElement('b'); k.textContent = f.killer; k.style.color = f.kc;
        const verb = { headshot: '  HEADSHOT  ', collision: '  rammed  ', missile: '  hit with a missile  ', explosion: '  blew up  ' }[f.cause] || '  shot down  ';
        row.append(k, document.createTextNode(verb), v);
      } else row.append(v, document.createTextNode({ water: '  hit the water', 'left the area': '  left the area', explosion: '  caught the blast', collision: '  had a mid-air' }[f.cause] || '  crashed'));
      el.appendChild(row);
    }
  }

  updateStatus(g) {
    let s = '';
    if (g.mode === 'dogfight') {
      const left = g.planeList.filter((p) => p.isBot && p.alive).length;
      s = `Wave ${g.solo.wave}    Enemies ${left}    Lives ${Math.max(0, g.solo.lives)}    Kills ${g.solo.kills}`;
    } else if (g.mode === 'casual' && this.scores) {
      const me = this.scores.find((r) => r.id === g.me.id);
      const top = this.scores[0];
      s = `First to ${KILL_LIMIT}    You ${me ? me.k : 0}` + (top && top.id !== g.me.id ? `    Leader ${top.name} ${top.k}` : '');
    } else if (g.mode === 'competitive') {
      const alive = g.planeList.filter((p) => p.alive).length;
      s = `Last pilot standing    Alive ${alive} of ${g.planeList.length}`;
    } else if (g.mode === 'free') s = 'Free flight';
    this.set('status', this.el.status, s);
  }

  updateDead(g) {
    const me = g.me, el = this.el.dead;
    if (me.alive || g.over) { el.hidden = true; return; }
    el.hidden = false;
    let sub;
    if (g.mode === 'competitive') sub = g.cam.spectate ? `Spectating ${g.cam.spectate.name}. Click to switch.` : 'Click to spectate.';
    else if (g.mode === 'dogfight' && g.solo.lives <= 0) sub = 'Out of lives';
    else sub = `Respawn in ${Math.max(1, Math.ceil(me.respawnT))}`;
    this.set('dead', el, `${this.deathText || 'Destroyed'}\n${sub}`);
  }

  updateBoard(g) {
    const el = this.el.board;
    const on = this.showBoard && g.online && this.scores;
    el.hidden = !on;
    if (!on) return;
    const key = JSON.stringify(this.scores);
    if (this.cache.board === key) return;
    this.cache.board = key;
    el.innerHTML = '<table><thead><tr><th>Pilot</th><th>Kills</th><th>Deaths</th><th>Ping</th></tr></thead><tbody></tbody></table>';
    const tb = el.querySelector('tbody');
    for (const r of this.scores) {
      const tr = document.createElement('tr');
      if (r.id === g.me.id) tr.className = 'me';
      for (const v of [r.name + (r.bot ? ' (bot)' : ''), r.k, r.d, r.bot ? '' : r.ping != null ? `${r.ping} ms` : '']) {
        const td = document.createElement('td'); td.textContent = v; tr.appendChild(td);
      }
      tb.appendChild(tr);
    }
  }
}
