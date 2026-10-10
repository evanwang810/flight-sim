// Menus: main, singleplayer setup, multiplayer connect and lobby, settings, pause, results.
import { AIRCRAFT, AIRCRAFT_ORDER, MODES, SKILLS, SWATCHES, SANDBOX_DEFAULT, SECRETS, MAX_PLAYERS, MAX_BOTS } from './config.js';
import { input } from './input.js';
import { ach } from './achievements.js';
import { MAPS } from './world/biomes.js';
import { settings, save, ACTIONS, keyName, resetKeys } from './settings.js';

const $ = (id) => document.getElementById(id);
const MAP_ORDER = ['alpine', 'canyon', 'archipelago', 'grid'];
const WINDS = [['off', 'Off'], ['light', 'Light'], ['strong', 'Strong']];
const ARENAS = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']];

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Segmented control. get/set read and write the current value.
function seg(root, options, get, set) {
  root.innerHTML = '';
  const btns = options.map(([v, label]) => {
    const b = el('button', null, label);
    b.type = 'button';
    b.onclick = () => { set(v); refresh(); };
    root.appendChild(b);
    return [v, b];
  });
  const refresh = () => { const cur = get(); for (const [v, b] of btns) b.classList.toggle('on', v === cur); };
  refresh();
  return refresh;
}

function mapTiles(root, get, set) {
  root.innerHTML = '';
  const btns = MAP_ORDER.map((id) => {
    const b = el('button', `map-${id}`);
    b.type = 'button';
    b.title = MAPS[id].desc;
    b.appendChild(el('span', null, MAPS[id].name));
    b.onclick = () => { set(id); refresh(); };
    root.appendChild(b);
    return [id, b];
  });
  const refresh = () => { const cur = get(); for (const [v, b] of btns) b.classList.toggle('on', v === cur); };
  refresh();
  return refresh;
}

// Aircraft picker bound to settings.plane / colors / sandbox.
const planeOrder = () => [...AIRCRAFT_ORDER, ...Object.keys(settings.eggs).filter((k) => settings.eggs[k])];

function picker(root, onChange) {
  root.innerHTML = '';
  root.appendChild(el('h3', null, 'Aircraft'));
  const tabs = el('div', 'tabs');
  root.appendChild(tabs);
  const name = el('div', 'pname'), blurb = el('p', 'blurb'), stats = el('div', 'stats');
  root.append(name, blurb, stats);
  const sw = el('div', 'swatches');
  root.appendChild(sw);
  const sliders = el('div', 'sliders');
  root.appendChild(sliders);
  let locked = null;

  const order = planeOrder();
  tabs.classList.toggle('many', order.length > 5);
  const tabBtns = order.map((id) => {
    const b = el('button', null, AIRCRAFT[id].name);
    b.type = 'button';
    b.onclick = () => { settings.plane = id; save(); render(); onChange(); };
    tabs.appendChild(b);
    return [id, b];
  });

  const swBtns = SWATCHES.map((c) => {
    const b = el('button');
    b.type = 'button';
    b.style.background = c;
    b.title = c;
    b.onclick = () => { settings.colors[settings.plane] = c; save(); render(); onChange(); };
    sw.appendChild(b);
    return [c, b];
  });
  const custom = el('label');
  custom.title = 'Custom color';
  const ci = el('input');
  ci.type = 'color';
  ci.oninput = () => { settings.colors[settings.plane] = ci.value; custom.style.background = ci.value; render(false); };
  ci.onchange = () => { save(); onChange(); };
  custom.appendChild(ci);
  sw.appendChild(custom);

  const sb = settings.sandbox;
  const sliderDefs = [
    ['speed', 'Top speed', 120, 340, 5, (v) => `${Math.round(v * 3.6)} km/h`],
    ['control', 'Control', 0.4, 2, 0.05, (v) => `${Math.round(v * 100)}%`],
    ['stall', 'Stall', 0, 10, 0.5, (v) => (v < 2 ? 'gentle' : v < 6 ? 'normal' : 'vicious')],
  ];
  const outs = {};
  for (const [k, label, min, max, step, fmt] of sliderDefs) {
    const row = el('div', 'row split');
    row.appendChild(el('span', null, label));
    const r = el('input');
    r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = sb[k] ?? SANDBOX_DEFAULT[k];
    const out = el('output', null, fmt(+r.value));
    outs[k] = [r, out, fmt];
    r.oninput = () => { sb[k] = +r.value; out.textContent = fmt(+r.value); };
    r.onchange = () => { save(); onChange(); };
    const wrap = el('div', 'row');
    wrap.append(r, out);
    row.appendChild(wrap);
    sliders.appendChild(row);
  }

  function render(full = true) {
    const id = locked || settings.plane;
    const a = AIRCRAFT[id];
    for (const [t, b] of tabBtns) { b.classList.toggle('on', t === id); b.disabled = !!locked && t !== locked; }
    if (full) {
      name.innerHTML = '';
      name.append(document.createTextNode(a.name), el('small', null, a.role));
      blurb.textContent = a.blurb;
      stats.innerHTML = '';
      for (const [k, label] of [['speed', 'Speed'], ['agility', 'Agility'], ['armor', 'Armor']]) {
        stats.appendChild(el('span', null, label));
        const m = el('div', 'meter'), i = el('i');
        i.style.width = `${a.stats[k] * 10}%`;
        m.appendChild(i);
        stats.appendChild(m);
      }
    }
    const color = settings.colors[id] || a.color;
    let match = false;
    for (const [c, b] of swBtns) { const on = c.toLowerCase() === color.toLowerCase(); b.classList.toggle('on', on); match ||= on; }
    custom.style.background = match ? '' : color;
    ci.value = color;
    sliders.hidden = id !== 'sandbox' || !!locked;
    for (const [k, [r, out, fmt]] of Object.entries(outs)) { r.value = sb[k]; out.textContent = fmt(+r.value); }
  }
  render();
  return {
    render,
    lock(type) { locked = type || null; render(); },
  };
}

export class Menu {
  constructor(h) {
    this.h = h;
    this.current = 'main';
    this.settingsReturn = 'main';
    this.listening = null;

    for (const b of document.querySelectorAll('[data-go]')) b.onclick = () => this.go(b.dataset.go);

    // singleplayer
    const solo = settings.solo;
    const soloNote = () => { $('solo-mode-note').textContent = MODES[solo.mode].blurb; $('solo-arena-row').hidden = solo.mode === 'free'; };
    seg($('solo-mode'), [['dogfight', 'Dogfight'], ['free', 'Free flight']], () => solo.mode, (v) => { solo.mode = v; save(); soloNote(); });
    soloNote();
    mapTiles($('solo-map'), () => solo.map, (v) => { solo.map = v; save(); h.onPreview(); });
    seg($('solo-wind'), WINDS, () => solo.wind, (v) => { solo.wind = v; save(); });
    seg($('solo-arena'), ARENAS, () => solo.arena, (v) => { solo.arena = v; save(); });
    this.soloPicker = picker($('solo-plane'), () => h.onLoadout());
    $('solo-go').onclick = () => h.onFly();
    $('go-replay').onclick = () => h.onReplay();

    // multiplayer connect
    $('mp-name').value = settings.name;
    $('mp-name').oninput = () => { settings.name = $('mp-name').value.trim().slice(0, 14); save(); };
    $('mp-host').onclick = () => h.onHost();
    $('mp-join').onclick = () => h.onJoin($('mp-code').value);
    $('mp-code').onkeydown = (e) => { if (e.key === 'Enter') h.onJoin($('mp-code').value); };
    $('mp-back').onclick = () => h.onMpBack();
    this.mpPicker = picker($('mp-plane'), () => h.onLoadout());

    // lobby (host controls; clients see the same widgets read-only)
    const hs = () => (this.lobby ? this.lobby.settings : settings.host);
    const push = (s) => { Object.assign(settings.host, s); save(); h.onLobbySettings(s); };
    this.lobbyRefresh = [
      seg($('room-mode'), [['casual', 'Casual'], ['competitive', 'Competitive']], () => hs().mode, (v) => push({ mode: v })),
      mapTiles($('room-map'), () => hs().map, (v) => push({ map: v })),
      seg($('room-wind'), WINDS, () => hs().wind, (v) => push({ wind: v })),
      seg($('room-arena'), ARENAS, () => hs().arena || 'medium', (v) => push({ arena: v })),
      seg($('room-skill'), Object.entries(SKILLS).map(([k, s]) => [k, s.name]), () => hs().skill, (v) => push({ skill: v })),
    ];
    $('bots-dec').onclick = () => push({ bots: Math.max(0, (hs().bots | 0) - 1) });
    $('bots-inc').onclick = () => {
      const humans = this.lobby ? this.lobby.players.filter((p) => !p.bot).length : 1;
      push({ bots: Math.min(MAX_BOTS, MAX_PLAYERS - humans, (hs().bots | 0) + 1) });
    };
    $('room-start').onclick = () => h.onStartMatch();
    $('room-leave').onclick = () => h.onLeaveRoom();
    $('room-copy').onclick = () => {
      const url = `${location.origin}${location.pathname}?join=${this.lobby ? this.lobby.code : ''}`;
      const done = () => { $('room-copy').textContent = 'Copied'; setTimeout(() => { $('room-copy').textContent = 'Copy invite link'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('Invite link', url));
      else prompt('Invite link', url);
    };

    // settings
    const g = settings.gfx, c = settings.ctl;
    seg($('set-quality'), [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], () => g.quality, (v) => { g.quality = v; save(); h.onGraphics(); });
    seg($('set-res'), [[0.5, '50%'], [0.75, '75%'], [1, '100%']], () => g.res, (v) => { g.res = v; save(); h.onGraphics(); });
    seg($('set-fog'), [[true, 'On'], [false, 'Off']], () => g.fog, (v) => { g.fog = v; save(); h.onGraphics(); });
    seg($('set-blur'), [[false, 'Off'], [true, 'On']], () => g.blur, (v) => { g.blur = v; save(); h.onGraphics(); });
    const modeNote = () => {
      $('set-mode-note').textContent = c.mode === 'mouse'
        ? 'The plane flies toward where you look. Keys override the autopilot on their axis.'
        : 'Arrow keys pitch, A and D roll, Q and E use the rudder. The camera follows the plane.';
    };
    seg($('set-mode'), [['mouse', 'Mouse aim'], ['keyboard', 'Keyboard']], () => c.mode, (v) => { c.mode = v; save(); modeNote(); });
    modeNote();
    seg($('set-invert'), [[false, 'Off'], [true, 'On']], () => c.invert, (v) => { c.invert = v; save(); });
    const assistNote = () => {
      $('set-assist-note').textContent = c.assist
        ? 'The autopilot keeps you out of stalls and the g-limiter protects the airframe.'
        : 'No stall protection and no g-limiter. Yank too hard and you will spin, or bend the wings off.';
    };
    seg($('set-assist'), [[true, 'On'], [false, 'Off']], () => c.assist, (v) => { c.assist = v; save(); assistNote(); });
    assistNote();
    $('set-sens').value = c.sens;
    $('set-sens').oninput = () => { c.sens = +$('set-sens').value; save(); };
    $('set-vol').value = g.volume;
    $('set-vol').oninput = () => { g.volume = +$('set-vol').value; save(); h.onVolume(); };
    $('keys-reset').onclick = () => { resetKeys(); this.renderKeys(); };
    $('set-back').onclick = () => this.go(this.settingsReturn);
    this.renderKeys();
    addEventListener('keydown', (e) => {
      if (!this.listening) return;
      e.preventDefault(); e.stopPropagation();
      if (e.code !== 'Escape') { settings.ctl.keys[this.listening] = [e.code]; save(); }
      this.listening = null;
      this.renderKeys();
    }, true);

    // pause
    $('pause-resume').onclick = () => h.onResume();
    $('pause-settings').onclick = () => { this.settingsReturn = 'pause'; this.go('settings', true); };
    $('pause-quit').onclick = () => h.onQuit();

    this.updateBest();

    // type a secret word anywhere in the menus to roll a hidden aircraft out of the hangar
    let typed = '';
    addEventListener('keydown', (e) => {
      if (input.active || this.listening || e.target instanceof HTMLInputElement || e.key.length !== 1) return;
      typed = (typed + e.key.toLowerCase()).slice(-12);
      if (typed.endsWith('overdrive')) {
        typed = '';
        settings.overdrive = !settings.overdrive;
        save();
        $('best').textContent = settings.overdrive ? 'Overdrive on. Singleplayer only.' : 'Overdrive off.';
        return;
      }
      const word = Object.keys(SECRETS).find((w) => typed.endsWith(w));
      const id = word && SECRETS[word];
      if (!id || settings.eggs[id]) return;
      settings.eggs[id] = true;
      if (id === 'blackbird') settings.unlocked = true;
      settings.plane = id;
      save();
      this.soloPicker = picker($('solo-plane'), () => h.onLoadout());
      this.mpPicker = picker($('mp-plane'), () => h.onLoadout());
      h.onLoadout();
      $('best').textContent = id === 'rocket' ? 'Something without wings just rolled out of the hangar.' : 'Something very fast just rolled out of the hangar.';
      ach.event(id === 'rocket' ? 'liftoff' : 'blackbird');
    });
  }

  updateBest() {
    $('best').textContent = settings.bestWave ? `Best dogfight run: wave ${settings.bestWave}` : '';
    $('go-replay').hidden = !this.h.hasReplay();
  }

  go(id, keepReturn = false) {
    if (id === 'settings' && !keepReturn) this.settingsReturn = 'main';
    this.current = id;
    const map = { main: 'scr-main', solo: 'scr-solo', mp: 'scr-mp', settings: 'scr-settings', pause: 'scr-pause', results: 'scr-results', ach: 'scr-ach' };
    if (id === 'ach') ach.render($('ach-list'));
    for (const [k, sid] of Object.entries(map)) $(sid).hidden = k !== id;
    $('lobby-plane').hidden = !(id === 'mp' && this.inLobby);
    if (id === 'solo') this.soloPicker.render();
    if (id === 'main') this.updateBest();
    if (id === 'mp') $('mp-name').value = settings.name;
    if (this.h.onScreen) this.h.onScreen(id);
  }

  hide() { this.go(null); }

  // ---------- multiplayer ----------

  setStatus(text) { $('mp-status').textContent = text; $('room-status').textContent = text; }

  showLobby(on) {
    this.inLobby = on;
    $('mp-connect').hidden = on;
    $('mp-lobby').hidden = !on;
    $('mp-foot').hidden = !on;
    $('lobby-plane').hidden = !(on && this.current === 'mp');
    if (!on) this.lobby = null;
  }

  renderLobby(lobby, myId, isHost) {
    this.lobby = lobby;
    $('room-code').textContent = lobby.code;
    const list = $('room-players');
    list.innerHTML = '';
    const humans = lobby.players.filter((p) => !p.bot).length;
    $('room-count').textContent = `${lobby.players.length}/${MAX_PLAYERS}`;
    for (const p of lobby.players) {
      const li = el('li', p.id === myId ? 'me' : '');
      const dot = el('span', 'dot');
      dot.style.background = p.load.color;
      li.append(dot, el('span', 'nm', p.name));
      if (p.host) li.appendChild(el('span', 'tag', 'Host'));
      if (p.bot) li.appendChild(el('span', 'tag bot', `Bot, ${SKILLS[p.skill]?.name.toLowerCase() || ''}`));
      const forced = lobby.settings.mode === 'competitive';
      const type = forced ? null : AIRCRAFT[p.load.type]?.name;
      li.appendChild(el('span', 'meta', [type, p.bot || p.host ? '' : p.ping != null ? `${p.ping} ms` : '...'].filter(Boolean).join('   ')));
      list.appendChild(li);
    }
    const s = lobby.settings;
    for (const r of this.lobbyRefresh) r();
    $('room-mode-note').textContent = MODES[s.mode].blurb + (s.mode === 'competitive' ? ' Everyone flies the host\'s aircraft.' : '');
    $('bots-n').textContent = s.bots | 0;
    $('room-settings').classList.toggle('locked', !isHost);
    $('room-lock').textContent = isHost ? '' : '(host picks)';
    $('room-start').hidden = !isHost;
    $('room-wait').hidden = isHost;
    const field = lobby.players.length;
    const canStart = s.mode !== 'competitive' || field >= 2;
    $('room-start').disabled = !canStart;
    $('room-wait').textContent = lobby.phase === 'match' ? 'Match in progress, joining...' : 'Waiting for the host to start';
    if (isHost && !canStart) $('room-status').textContent = 'Competitive needs at least two pilots. Add a bot or wait for a friend.';
    else if ($('room-status').textContent.startsWith('Competitive')) $('room-status').textContent = '';
    const hostLoad = lobby.players.find((p) => p.host)?.load;
    this.mpPicker.lock(s.mode === 'competitive' && !isHost && hostLoad ? hostLoad.type : null);
  }

  // ---------- results ----------

  showResults(res, kind, myId) {
    $('res-title').textContent = res.title;
    $('res-sub').textContent = res.sub || '';
    const body = $('res-body'), act = $('res-actions');
    body.innerHTML = ''; act.innerHTML = '';
    if (res.stats) {
      const b = el('div', 'bigstats');
      for (const [label, v] of res.stats) { const d = el('div'); d.append(el('b', null, String(v)), el('span', null, label)); b.appendChild(d); }
      body.appendChild(b);
    }
    if (res.board) {
      const t = el('table', 'results');
      t.innerHTML = '<thead><tr><th>Pilot</th><th>Kills</th><th>Deaths</th></tr></thead>';
      const tb = el('tbody');
      for (const r of res.board) {
        const tr = el('tr', [r.id === res.winner ? 'win' : '', r.id === myId ? 'me' : ''].join(' ').trim());
        for (const v of [r.name + (r.bot ? ' (bot)' : ''), r.k, r.d]) tr.appendChild(el('td', null, String(v)));
        tb.appendChild(tr);
      }
      t.appendChild(tb);
      body.appendChild(t);
    }
    const btn = (label, fn, primary) => { const b = el('button', primary ? 'primary' : null, label); b.type = 'button'; b.onclick = fn; act.appendChild(b); };
    if (kind === 'solo') {
      btn('Fly again', () => this.h.onFly(), true);
      btn('Watch replay', () => this.h.onReplay());
      btn('Main menu', () => this.h.onQuit());
    } else if (kind === 'host') {
      btn('Rematch', () => this.h.onStartMatch(), true);
      btn('Watch replay', () => this.h.onReplay());
      btn('Back to lobby', () => this.h.onBackToLobby());
    } else {
      act.appendChild(el('p', 'note', 'Waiting for the host to pick what happens next.'));
      btn('Watch replay', () => this.h.onReplay());
      btn('Leave room', () => this.h.onLeaveRoom());
    }
    this.go('results');
  }

  renderKeys() {
    const box = $('set-keys');
    box.innerHTML = '';
    for (const [action, label] of ACTIONS) {
      box.appendChild(el('span', null, label));
      const b = el('button', this.listening === action ? 'listen' : null, this.listening === action ? 'Press a key' : settings.ctl.keys[action].map(keyName).join(' / '));
      b.type = 'button';
      b.onclick = () => { this.listening = action; this.renderKeys(); };
      box.appendChild(b);
    }
  }
}
