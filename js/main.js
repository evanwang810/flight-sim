// Boot, render loop and the glue between menus, the game and the network.
import * as THREE from './three.js';
import { World } from './world/world.js';
import { FX } from './fx.js';
import { HUD } from './hud.js';
import { Game } from './game.js';
import { Menu } from './menu.js';
import { Net } from './net.js';
import { ReplayUI } from './replay.js';
import { ach } from './achievements.js';
import { input } from './input.js';
import { audio } from './audio.js';
import { settings, save, loadout } from './settings.js';
import { SKILLS } from './config.js';

const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 1, 8000);
const world = new World(scene);
const fx = new FX(scene);
const hud = new HUD();
const game = new Game({ scene, camera, world, fx, hud });
const fade = document.getElementById('fade');
const hint = document.getElementById('hint');
let net = null;
let state = 'menu'; // menu | play | pause | results | replay
let lastRes = null, lastKind = null;

// ---------- optional radial speed blur ----------
const post = {
  rt: null,
  mat: new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, strength: { value: 0 }, ca: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: /* glsl */`
      uniform sampler2D tDiffuse; uniform float strength; uniform float ca; varying vec2 vUv;
      void main() {
        vec2 dir = vUv - 0.5;
        float edge = smoothstep(0.18, 0.75, length(dir));
        vec2 off = dir * ca * edge;
        vec3 c = vec3(0.0);
        for (int i = 0; i < 6; i++) {
          vec2 uv = vUv - dir * strength * edge * (float(i) / 5.0);
          c += vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
        }
        gl_FragColor = vec4(c / 6.0, 1.0);
        #include <colorspace_fragment>
      }`,
    depthTest: false, depthWrite: false,
  }),
  scene: new THREE.Scene(),
  cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1),
  resize(w, h) {
    if (!settings.gfx.blur) { if (this.rt) { this.rt.dispose(); this.rt = null; } return; }
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(w, h, { samples: 4 });
      this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    } else this.rt.setSize(w, h);
    this.mat.uniforms.tDiffuse.value = this.rt.texture;
  },
};
post.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), post.mat));

const PR_CAP = { low: 1, medium: 1.5, high: 2 };

function resize() {
  const pr = Math.min(devicePixelRatio || 1, PR_CAP[settings.gfx.quality] || 1.5) * settings.gfx.res;
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.far = world.viewDist * 1.15;
  camera.updateProjectionMatrix();
  const w = renderer.domElement.width, h = renderer.domElement.height;
  fx.resize(w, h, camera, world.viewDist);
  post.resize(w, h);
}

function applyGraphics() {
  world.setQuality(settings.gfx.quality);
  fx.setQuality(settings.gfx.quality);
  resize();
}

function showcase() {
  const map = net && net.lobby ? net.lobby.settings.map : settings.solo.map;
  game.showcase(loadout(), map);
}

function playerName() {
  if (!settings.name) { settings.name = `Pilot ${10 + Math.floor(Math.random() * 90)}`; save(); }
  return settings.name;
}

// ---------- state changes ----------

function enterPlay() {
  replayUI.close();
  state = 'play';
  menu.hide();
  hud.show(true);
  input.reset();
  input.active = true;
  if (settings.ctl.mode === 'mouse') input.lock();
}

function toMenu(screen) {
  replayUI.close();
  state = 'menu';
  input.active = false;
  input.unlock();
  hud.show(false);
  game.paused = false;
  showcase();
  menu.go(screen);
}

function startSolo() {
  audio.init();
  if (net) leaveRoom(false);
  const s = settings.solo;
  game.start({ mode: s.mode, map: s.map, wind: s.wind, arena: s.arena, load: loadout(), name: playerName() });
  enterPlay();
}

function pause() {
  if (state !== 'play') return;
  state = 'pause';
  input.active = false;
  input.unlock();
  game.paused = true;
  document.getElementById('pause-note').textContent = game.online ? 'The match keeps running while this menu is open.' : '';
  menu.go('pause');
}

function resume() {
  if (state !== 'pause') return;
  game.paused = false;
  enterPlay();
}

function showResults(res, kind) {
  lastRes = res; lastKind = kind;
  state = 'results';
  input.active = false;
  input.unlock();
  hud.show(false);
  menu.showResults(res, kind, net ? net.myId : null);
}

// ---------- multiplayer ----------

function makeNet() {
  net = new Net({
    onStatus: (t) => menu.setStatus(t),
    onLobby: (lobby) => {
      if (net.isHost) ach.event('host', lobby.players.filter((p) => !p.bot).length);
      menu.showLobby(true);
      menu.renderLobby(lobby, net.myId, net.isHost);
      if (lobby.phase === 'lobby' && state !== 'menu') { toMenu('mp'); return; }
      if (state === 'menu' && game.mode === 'menu' && world.mapId !== lobby.settings.map) showcase();
      if (game.online && lobby.phase === 'match') syncRoster(lobby.players);
    },
    onStart: (match, roster, myId, late) => startOnline(match, roster, myId, late),
    onEnd: (res) => { game.over = true; if (res.winner && res.winner === net.myId) ach.event('win'); showResults(res, net.isHost ? 'host' : 'client'); },
    onScores: (b) => { hud.scores = b; },
    onClosed: (reason) => {
      net = null;
      menu.showLobby(false);
      toMenu('mp');
      menu.setStatus(reason);
    },
  });
  net.game = game;
}

function rosterLoad(r) {
  const forced = net && net.match && net.match.forced;
  return forced ? { ...forced, color: r.load.color } : r.load;
}

function addRemote(r) {
  if (game.planes.has(r.id)) return;
  const owned = net.isHost && r.bot;
  const p = game.addPlane({ id: r.id, name: r.name, load: rosterLoad(r), owned, bot: r.bot, skill: r.skill });
  if (owned) game.spawn(p);
}

function syncRoster(players) {
  const ids = new Set(players.map((p) => p.id));
  for (const p of [...game.planeList]) if (!p.isMe && !ids.has(p.id)) game.removePlane(p.id);
  for (const r of players) if (r.id !== net.myId) addRemote(r);
}

function startOnline(match, roster, myId, late) {
  const mine = roster.find((r) => r.id === myId);
  game.start({
    mode: match.mode, map: match.map, wind: match.wind, arena: match.arena, windDir: match.windDir,
    load: mine ? mine.load : loadout(), name: playerName(), myId, net,
  });
  for (const r of roster) if (r.id !== myId) addRemote(r);
  hud.scores = null;
  if (late && match.mode === 'competitive') {
    game.me.alive = false;
    game.me.respawnT = 0;
    hud.died(null, 'late');
    hud.deathText = 'Round in progress';
  }
  enterPlay();
}

function leaveRoom(goToMenu = true) {
  if (net) { net.leave(); net = null; }
  menu.showLobby(false);
  menu.setStatus('');
  if (goToMenu) toMenu('mp');
}

function hostRoom() {
  audio.init();
  if (net) return;
  if (!window.Peer) { menu.setStatus('The multiplayer library did not load. Check your connection and reload.'); return; }
  makeNet();
  net.host(playerName(), loadout(), { ...settings.host });
}

function joinRoom(code) {
  audio.init();
  code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4) { menu.setStatus('Enter the room code from your host.'); return; }
  if (net) leaveRoom(false);
  if (!window.Peer) { menu.setStatus('The multiplayer library did not load. Check your connection and reload.'); return; }
  makeNet();
  net.join(code, playerName(), loadout());
}

// ---------- replays ----------

function watchReplay() {
  game.stop();
  const data = game.lastReplay;
  if (!data) { toMenu(net ? 'mp' : 'main'); return; }
  state = 'replay';
  input.active = false;
  input.unlock();
  hud.show(false);
  menu.hide();
  replayUI.open(game.startReplay(data));
  ach.event('replay');
}

function exitReplay() {
  replayUI.close();
  if (net && net.phase === 'results' && lastRes) { showcase(); showResults(lastRes, lastKind); }
  else toMenu(net ? 'mp' : 'main');
}

const replayUI = new ReplayUI(canvas, exitReplay);

// ---------- menu wiring ----------

const menu = new Menu({
  onFly: startSolo,
  onReplay: watchReplay,
  hasReplay: () => !!game.lastReplay,
  onPreview: () => { if (game.mode === 'menu') showcase(); },
  onLoadout: () => {
    if (game.mode === 'menu') showcase();
    if (net) net.setLoad(loadout());
  },
  onHost: hostRoom,
  onJoin: joinRoom,
  onMpBack: () => { if (net) leaveRoom(false); menu.setStatus(''); toMenu('main'); },
  onLeaveRoom: () => leaveRoom(true),
  onLobbySettings: (s) => { if (net && net.isHost) net.setSettings(s); },
  onStartMatch: () => { if (net && net.isHost) net.startMatch(); },
  onBackToLobby: () => { if (net && net.isHost) net.backToLobby(); },
  onGraphics: applyGraphics,
  onVolume: () => audio.setVolume(settings.gfx.volume),
  onResume: resume,
  onQuit: () => { if (net) leaveRoom(true); else toMenu('main'); },
  onScreen: (id) => {
    if ((id === 'main' || id === 'solo') && state === 'menu' && game.mode === 'menu' && !net && world.mapId !== settings.solo.map) showcase();
    if (id === 'pause' && state === 'menu') state = 'pause';
  },
});

game.onEnd = (res) => { save(); menu.updateBest(); showResults(res, 'solo'); };
input.init(canvas);
input.onUnlock = () => { if (state === 'play' && settings.ctl.mode === 'mouse') pause(); };
input.onEscape = () => pause();
addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' || menu.listening) return;
  if (state === 'pause' && menu.current === 'pause') resume();
  else if (state === 'pause' && menu.current === 'settings') menu.go('pause');
});
addEventListener('pointerdown', () => audio.init(), { once: true });
addEventListener('resize', resize);
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'play' && !game.online) pause(); });

audio.volume = settings.gfx.volume;
applyGraphics();
showcase();
menu.go('main');

const params = new URLSearchParams(location.search);
const join = params.get('join');

// ?demo=map,plane,seconds[,replay] starts a dogfight flown by the AI and fast-forwards it (for screenshots).
if (params.has('demo')) {
  const [map = 'alpine', plane = 'fighter', secs = '6', extra = ''] = params.get('demo').split(',');
  settings.ctl.mode = 'keyboard';
  game.start({ mode: 'dogfight', map, wind: 'light', arena: 'medium', load: { type: plane, color: settings.colors[plane] || '#8b99ab' }, name: 'Demo' });
  game.me.isBot = true;
  game.me.skill = { ...SKILLS.ace, magnet: 1 };
  state = 'play';
  menu.hide();
  hud.show(true);
  window.__ff = { secs: +secs, extra };
}
if (join) {
  history.replaceState(null, '', location.pathname);
  menu.go('mp');
  document.getElementById('mp-code').value = join.toUpperCase();
  joinRoom(join);
}

// ---------- loop ----------

// World first, then the cockpit interior on a cleared depth buffer with a near plane of a few centimetres.
function drawWorld() {
  const target = renderer.getRenderTarget();
  world.renderReflection(renderer, camera);
  renderer.setRenderTarget(target);
  renderer.render(scene, camera);
  if (!game.showCockpit) return;
  const near = camera.near;
  renderer.autoClear = false;
  renderer.clearDepth();
  camera.near = 0.03;
  camera.updateProjectionMatrix();
  renderer.render(game.cockpitScene, camera);
  camera.near = near;
  camera.updateProjectionMatrix();
  renderer.autoClear = true;
}

let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (window.__ff && !game.loading) {
    const ff = window.__ff;
    window.__ff = null;
    for (let i = 0; i < ff.secs * 60; i++) game.update(1 / 60);
    if (ff.extra === 'replay') { game.lastReplay = null; watchReplay(); for (let i = 0; i < 60 * 3; i++) game.update(1 / 60); game.rp.seek(ff.secs * 0.6); }
    if (ff.extra === 'cockpit') game.cam.view = 'cockpit';
  }
  game.update(dt);
  if (net) net.tick(dt);
  if (state === 'play' || state === 'pause') hud.update(game, dt);
  hud.showBoard = state === 'play' && input.down('scores');
  replayUI.tick();
  hint.hidden = !(state === 'play' && settings.ctl.mode === 'mouse' && !input.locked);
  fade.classList.toggle('out', !game.loading);

  const me = game.me;
  const blur = post.rt && state === 'play' && me && me.alive && game.cam.view === 'chase';
  if (blur) {
    const k = Math.min(1, Math.max(0, (me.air.speed - 180) / 350));
    post.mat.uniforms.strength.value = k * 0.03 + me.air.ab * 0.008;
    post.mat.uniforms.ca.value = k * 0.014 + me.air.ab * 0.004;
    renderer.setRenderTarget(post.rt);
    drawWorld();
    renderer.setRenderTarget(null);
    renderer.render(post.scene, post.cam);
  } else drawWorld();
  input.endFrame();
  audio.endFrame();
}
requestAnimationFrame(frame);

window.__contrail = { game, world, net: () => net, settings, renderer };
