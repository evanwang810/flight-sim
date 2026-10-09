// Peer-to-peer multiplayer on PeerJS's public broker. Star topology: clients connect to the host, the host
// relays and keeps score. Events go as JSON over PeerJS's reliable channel. Plane state goes as 40-byte
// binary records over an extra unordered, no-retransmit channel negotiated on the same connection
// (JSON over the reliable channel is the fallback). The host forwards client records without re-encoding,
// never resends a record a receiver already has, and sends far-away planes at a third of the rate, which
// keeps a 20-player room to roughly 1-2 Mbit/s of host upload.
import { PEER_PREFIX, KILL_LIMIT, BOT_NAMES, PLAYER_COLORS, SANDBOX_DEFAULT, AIRCRAFT, MAX_PLAYERS, MAX_BOTS } from './config.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const STATE_DT = 1 / 20;
const REC = 40;
const NEAR2 = 2500 * 2500;
const BOT_COLORS = ['#c25e3c', '#9b3b45', '#b88a3e', '#6d7b8c', '#7a5c9e', '#3f8f7a', '#8e6b3c', '#4f6d8f'];

const makeCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
const clampI = (v, a, b) => (v < a ? a : v > b ? b : Math.round(v));

// ---------- binary state records ----------
// u8 slot, u8 flags (alive, firing), u8 life, u8 missiles, u32 ms, f32 x y z, i16 quat x4, i16 vel x3 (0.1 m/s),
// u8 throttle, u8 afterburner, u16 body hp, u8 left wing, u8 right wing
export function pack(dv, o, slot, p) {
  const a = p.air;
  dv.setUint8(o, slot);
  dv.setUint8(o + 1, (p.alive ? 1 : 0) | (p.trigger ? 2 : 0));
  dv.setUint8(o + 2, p.life & 255);
  dv.setUint8(o + 3, p.missiles | 0);
  dv.setUint32(o + 4, Math.round(performance.now()) >>> 0, true);
  dv.setFloat32(o + 8, a.pos.x, true); dv.setFloat32(o + 12, a.pos.y, true); dv.setFloat32(o + 16, a.pos.z, true);
  dv.setInt16(o + 20, clampI(a.quat.x * 32767, -32767, 32767), true);
  dv.setInt16(o + 22, clampI(a.quat.y * 32767, -32767, 32767), true);
  dv.setInt16(o + 24, clampI(a.quat.z * 32767, -32767, 32767), true);
  dv.setInt16(o + 26, clampI(a.quat.w * 32767, -32767, 32767), true);
  dv.setInt16(o + 28, clampI(a.vel.x * 10, -32767, 32767), true);
  dv.setInt16(o + 30, clampI(a.vel.y * 10, -32767, 32767), true);
  dv.setInt16(o + 32, clampI(a.vel.z * 10, -32767, 32767), true);
  dv.setUint8(o + 34, clampI(a.throttle * 255, 0, 255));
  dv.setUint8(o + 35, clampI(a.ab * 255, 0, 255));
  dv.setUint16(o + 36, clampI(p.hp.body, 0, 65535), true);
  dv.setUint8(o + 38, clampI(p.hp.wl, 0, 255));
  dv.setUint8(o + 39, clampI(p.hp.wr, 0, 255));
}

export function unpack(dv, o) {
  const f = dv.getUint8(o + 1);
  return {
    slot: dv.getUint8(o), ts: dv.getUint32(o + 4, true), a: f & 1, f: (f >> 1) & 1, l: dv.getUint8(o + 2), m: dv.getUint8(o + 3),
    p: [dv.getFloat32(o + 8, true), dv.getFloat32(o + 12, true), dv.getFloat32(o + 16, true)],
    q: [dv.getInt16(o + 20, true) / 32767, dv.getInt16(o + 22, true) / 32767, dv.getInt16(o + 24, true) / 32767, dv.getInt16(o + 26, true) / 32767],
    v: [dv.getInt16(o + 28, true) / 10, dv.getInt16(o + 30, true) / 10, dv.getInt16(o + 32, true) / 10],
    th: dv.getUint8(o + 34) / 255, ab: dv.getUint8(o + 35) / 255,
    h: [dv.getUint16(o + 36, true), dv.getUint8(o + 38), dv.getUint8(o + 39)],
  };
}

export class Net {
  constructor(h) {
    this.h = h; // { onLobby, onStart, onEnd, onClosed, onStatus, onScores }
    this.game = null;
    this.peer = null;
    this.isHost = false;
    this.players = new Map();
    this.slotIds = new Map();
    this.settings = null;
    this.phase = 'lobby';
    this.match = null;
    this.stateT = 0; this.pingT = 0; this.tickN = 0;
    this.closedFlag = false;
    this.buf = new DataView(new ArrayBuffer(2 + REC * 64));
  }

  get active() { return !!this.peer && !this.closedFlag; }

  freeSlot() {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    for (let i = 0; i < 64; i++) if (!used.has(i)) return i;
    return 63;
  }

  // ---------- host ----------

  host(name, load, settings, attempt = 0) {
    this.isHost = true;
    this.settings = { ...settings };
    this.code = makeCode();
    this.myName = name; this.myLoad = load;
    this.h.onStatus('Opening a room...');
    const peer = new window.Peer(PEER_PREFIX + this.code, { debug: 0 });
    this.peer = peer;
    peer.on('open', (id) => {
      this.myId = id;
      this.players.set(id, { id, slot: 0, name, load, ping: 0, host: true, k: 0, d: 0, alive: true });
      this.syncBots();
      this.h.onStatus('');
      this.pushLobby();
    });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id' && attempt < 5) { peer.destroy(); this.host(name, load, settings, attempt + 1); return; }
      if (e.type === 'peer-unavailable' || (e.type === 'network' && this.myId)) return;
      this.h.onStatus(`Could not open a room (${e.type}). Check your connection and try again.`);
    });
    peer.on('disconnected', () => { if (!this.closedFlag) setTimeout(() => !peer.destroyed && peer.reconnect(), 1000); });
    peer.on('connection', (conn) => {
      conn.on('open', () => {
        this.openFast(conn);
        conn.on('data', (m) => this.hostData(conn, m));
      });
      conn.on('close', () => this.drop(conn.peer));
      conn.on('error', () => this.drop(conn.peer));
    });
  }

  syncBots() {
    for (const [id, p] of this.players) if (p.bot) this.players.delete(id);
    const humans = [...this.players.values()].filter((p) => !p.bot).length;
    const n = Math.max(0, Math.min(MAX_BOTS, MAX_PLAYERS - humans, this.settings.bots | 0));
    for (let i = 0; i < n; i++) {
      const id = 'bot-' + (i + 1);
      this.players.set(id, {
        id, slot: this.freeSlot(), name: BOT_NAMES[i % BOT_NAMES.length], bot: true, skill: this.settings.skill,
        load: { type: 'fighter', color: BOT_COLORS[i % BOT_COLORS.length] }, k: 0, d: 0, alive: true,
      });
    }
  }

  setSettings(s) {
    if (!this.isHost) return;
    Object.assign(this.settings, s);
    if ('bots' in s || 'skill' in s) this.syncBots();
    this.pushLobby();
  }

  setLoad(load) {
    this.myLoad = load;
    if (this.isHost) { const me = this.players.get(this.myId); if (me) me.load = load; this.pushLobby(); }
    else this.send({ t: 'load', load });
  }

  lobbyMsg() {
    return {
      t: 'lobby', code: this.code, phase: this.phase, settings: this.settings,
      players: [...this.players.values()].map((p) => ({ id: p.id, slot: p.slot, name: p.name, load: p.load, ping: p.ping, host: !!p.host, bot: !!p.bot, skill: p.skill })),
    };
  }

  pushLobby() {
    const m = this.lobbyMsg();
    for (const p of this.players.values()) if (p.conn) p.conn.send(m);
    this.applyLobby(m);
  }

  hostData(conn, m) {
    const id = conn.peer;
    const p = this.players.get(id);
    if (m.t === 'hello') {
      const humans = [...this.players.values()].filter((q) => !q.bot).length;
      if (humans >= MAX_PLAYERS) { conn.send({ t: 'full' }); setTimeout(() => conn.close(), 300); return; }
      // a joining person bumps a bot if the room is full
      if (this.players.size >= MAX_PLAYERS && this.phase !== 'match') { this.settings.bots = Math.max(0, MAX_PLAYERS - humans - 1); }
      let name = String(m.name || 'Pilot').slice(0, 14);
      const taken = new Set([...this.players.values()].map((q) => q.name));
      for (let i = 2; taken.has(name); i++) name = `${String(m.name).slice(0, 12)} ${i}`;
      const load = sanitizeLoad(m.load, humans);
      this.players.set(id, {
        id, slot: this.freeSlot(), name, load, ping: null, conn, k: 0, d: 0, alive: this.match?.mode !== 'competitive',
        rec: null, recTs: -1, pos: null, sent: new Map(),
      });
      conn.send({ t: 'welcome', id });
      if (this.phase !== 'match') this.syncBots();
      this.pushLobby();
      if (this.phase === 'match') conn.send(this.startMsg(true));
      else if (this.phase === 'results' && this.results) conn.send({ t: 'end', results: this.results });
      return;
    }
    if (!p) return;
    switch (m.t) {
      case 'load': p.load = sanitizeLoad(m.load, 0); this.pushLobby(); break;
      case 'pong': p.ping = Math.round(performance.now() - m.ts); break;
      case 's': p.pos = m.p; p.json = { ...m, i: id }; if (this.game) this.game.netState(id, m); break;
      case 'hit': this.routeHit(m.tg, m.part, +m.dmg || 0, id); break;
      case 'dead': this.death(id, m.k, m.c); break;
      case 'msl': m.o = id; this.relay(m, id); if (this.game) this.game.netMissile(id, m.id, m.tg, m.p, m.v); break;
      case 'flr': m.o = id; this.relay(m, id); if (this.game) this.game.netFlare(id, m.s); break;
      case 'lock': this.routeLock(m.tg, m.s); break;
      case 'bye': this.drop(id); break;
    }
  }

  // Binary record from a client: keep the bytes for forwarding, with the slot forced to theirs.
  hostRecord(conn, buf) {
    const p = this.players.get(conn.peer);
    if (!p || buf.byteLength < 1 + REC) return;
    const rec = new Uint8Array(buf, 1, REC).slice();
    rec[0] = p.slot;
    const s = unpack(new DataView(rec.buffer), 0);
    if (s.ts === p.recTs) return;
    p.rec = rec; p.recTs = s.ts; p.pos = s.p;
    if (this.game) this.game.netState(p.id, s);
  }

  relay(m, except) { for (const p of this.players.values()) if (p.conn && p.id !== except) p.conn.send(m); }

  routeHit(target, part, dmg, by) {
    const t = this.players.get(target);
    if (!t) return;
    if (t.conn) t.conn.send({ t: 'hit', tg: target, part, dmg, by });
    else if (this.game) this.game.netHit(target, part, dmg, by);
  }

  routeLock(target, s) {
    const t = this.players.get(target);
    if (!t) return;
    if (t.conn) t.conn.send({ t: 'lock', tg: target, s });
    else if (this.game) this.game.netLock(target, s);
  }

  death(victim, killer, cause) {
    if (this.phase !== 'match') return;
    const v = this.players.get(victim), k = killer ? this.players.get(killer) : null;
    if (!v) return;
    v.d++; v.alive = false;
    if (k && k !== v) k.k++;
    const m = { t: 'kill', v: victim, k: k && k !== v ? killer : null, c: cause };
    this.relay(m);
    if (this.game) this.game.netKill(m.v, m.k, m.c);
    this.pushScores();
    const mode = this.match.mode;
    if (mode === 'casual' && k && k !== v && k.k >= KILL_LIMIT) this.end(k);
    if (mode === 'competitive') this.checkLastAlive();
  }

  checkLastAlive() {
    const alive = [...this.players.values()].filter((p) => p.inRound && p.alive);
    if (alive.length <= 1) setTimeout(() => this.phase === 'match' && this.end(alive[0] || null), 1500);
  }

  board() {
    return [...this.players.values()]
      .map((p) => ({ id: p.id, name: p.name, k: p.k, d: p.d, ping: p.ping, bot: !!p.bot, alive: !!p.alive }))
      .sort((a, b) => b.k - a.k || a.d - b.d);
  }

  pushScores() {
    const m = { t: 'score', b: this.board() };
    this.relay(m);
    this.h.onScores(m.b);
  }

  startMsg(late = false) {
    return { t: 'start', match: this.match, late, roster: this.roster() };
  }

  roster() {
    return [...this.players.values()].map((p) => ({
      id: p.id, slot: p.slot, name: p.name, bot: !!p.bot, skill: p.skill,
      load: this.match?.forced ? { ...this.match.forced, color: p.load.color } : p.load,
    }));
  }

  startMatch() {
    if (!this.isHost || !this.peer) return;
    const s = this.settings, me = this.players.get(this.myId);
    this.match = {
      mode: s.mode, map: s.map, wind: s.wind, arena: s.arena, windDir: Math.random() * Math.PI * 2,
      forced: s.mode === 'competitive' ? { type: me.load.type, sb: me.load.sb } : null,
    };
    for (const p of this.players.values()) { p.k = 0; p.d = 0; p.alive = true; p.inRound = true; if (p.sent) p.sent.clear(); }
    this.phase = 'match';
    this.results = null;
    const m = this.startMsg();
    this.relay(m);
    this.pushLobby();
    this.h.onStart(m.match, m.roster, this.myId, false);
    this.pushScores();
  }

  end(winner) {
    if (this.phase !== 'match') return;
    this.phase = 'results';
    const mode = this.match.mode;
    this.results = {
      title: winner ? `${winner.name} wins` : 'Draw',
      sub: mode === 'casual' ? `First to ${KILL_LIMIT} kills` : 'Last pilot standing',
      winner: winner ? winner.id : null,
      board: this.board(),
    };
    this.relay({ t: 'end', results: this.results });
    this.pushLobby();
    this.h.onEnd(this.results);
  }

  backToLobby() {
    if (!this.isHost) return;
    this.phase = 'lobby';
    this.match = null;
    this.pushLobby();
  }

  drop(id) {
    const p = this.players.get(id);
    if (!p || p.bot || p.host) return;
    this.players.delete(id);
    for (const q of this.players.values()) if (q.sent) q.sent.delete(id);
    try { p.conn.close(); } catch { /* already closed */ }
    this.pushLobby();
    if (this.phase === 'match') {
      this.pushScores();
      if (this.match.mode === 'competitive') this.checkLastAlive();
    }
  }

  // ---------- client ----------

  join(code, name, load) {
    this.isHost = false;
    this.code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    this.myName = name; this.myLoad = load;
    this.h.onStatus('Connecting...');
    const peer = new window.Peer({ debug: 0 });
    this.peer = peer;
    let opened = false;
    peer.on('open', () => {
      const conn = peer.connect(PEER_PREFIX + this.code, { reliable: true, serialization: 'json' });
      this.conn = conn;
      setTimeout(() => { if (!opened && !this.closedFlag) this.fail('Could not reach that room. Check the code and try again.'); }, 12000);
      conn.on('open', () => {
        opened = true;
        this.openFast(conn);
        conn.send({ t: 'hello', name, load });
      });
      conn.on('data', (m) => this.clientData(m));
      conn.on('close', () => this.fail('The host closed the room.'));
      conn.on('error', () => this.fail('Lost the connection to the host.'));
    });
    peer.on('error', (e) => {
      if (e.type === 'peer-unavailable') this.fail(`No room with code ${this.code}.`);
      else if (!opened) this.fail(`Could not connect (${e.type}).`);
    });
  }

  clientData(m) {
    switch (m.t) {
      case 'welcome': this.myId = m.id; this.h.onStatus(''); break;
      case 'full': this.fail('That room is full.'); break;
      case 'lobby': this.applyLobby(m); break;
      case 'ping': this.send({ t: 'pong', ts: m.ts }); break;
      case 'start': this.phase = 'match'; this.match = m.match; this.h.onStart(m.match, m.roster, this.myId, m.late); break;
      case 'end': this.phase = 'results'; this.results = m.results; this.h.onEnd(m.results); break;
      case 'score': this.h.onScores(m.b); break;
      case 'S': if (this.game) for (const s of m.s) this.game.netState(s.i, s); break;
      case 'hit': if (this.game) this.game.netHit(m.tg, m.part, m.dmg, m.by); break;
      case 'kill': if (this.game) this.game.netKill(m.v, m.k, m.c); break;
      case 'msl': if (this.game && m.o !== this.myId) this.game.netMissile(m.o, m.id, m.tg, m.p, m.v); break;
      case 'flr': if (this.game && m.o !== this.myId) this.game.netFlare(m.o, m.s); break;
      case 'lock': if (this.game) this.game.netLock(m.tg, m.s); break;
    }
  }

  // Batch of binary records from the host.
  clientRecords(buf) {
    if (!this.game) return;
    const dv = new DataView(buf), n = dv.getUint8(1);
    for (let i = 0; i < n; i++) {
      const s = unpack(dv, 2 + i * REC);
      const id = this.slotIds.get(s.slot);
      if (id && id !== this.myId) this.game.netState(id, s);
    }
  }

  applyLobby(m) {
    this.settings = m.settings;
    this.phase = m.phase;
    this.lobby = m;
    this.slotIds.clear();
    for (const p of m.players) this.slotIds.set(p.slot, p.id);
    this.h.onLobby(m);
  }

  send(m) { if (this.conn && this.conn.open) this.conn.send(m); }

  fail(reason) {
    if (this.closedFlag) return;
    this.closedFlag = true;
    try { this.peer.destroy(); } catch { /* ignore */ }
    this.h.onClosed(reason);
  }

  leave() {
    if (!this.peer || this.closedFlag) return;
    this.closedFlag = true;
    if (this.isHost) {
      for (const p of this.players.values()) if (p.conn) { try { p.conn.close(); } catch { /* ignore */ } }
    } else this.send({ t: 'bye' });
    const peer = this.peer;
    setTimeout(() => { try { peer.destroy(); } catch { /* ignore */ } }, 250);
  }

  // ---------- game hooks ----------

  sendHit(target, part, dmg, by) {
    if (this.isHost) this.routeHit(target, part, dmg, by);
    else this.send({ t: 'hit', tg: target, part, dmg });
  }

  reportDeath(plane, killer, cause) {
    if (this.isHost) this.death(plane.id, killer, cause);
    else this.send({ t: 'dead', k: killer, c: cause });
  }

  sendMissile(plane, m) {
    const msg = { t: 'msl', o: plane.id, id: m.id, tg: m.target ? m.target.id : null, p: m.pos.toArray(), v: m.vel.toArray() };
    if (this.isHost) this.relay(msg);
    else this.send(msg);
  }

  sendFlare(plane, seq) {
    const msg = { t: 'flr', o: plane.id, s: seq };
    if (this.isHost) this.relay(msg);
    else this.send(msg);
  }

  sendLock(target, s) {
    if (this.isHost) this.routeLock(target, s);
    else this.send({ t: 'lock', tg: target, s });
  }

  tick(dt) {
    if (!this.peer || this.closedFlag) return;
    if (this.isHost) {
      this.pingT -= dt;
      if (this.pingT <= 0) {
        this.pingT = 2;
        const ts = performance.now();
        for (const p of this.players.values()) if (p.conn) p.conn.send({ t: 'ping', ts });
        if (this.phase === 'match') this.pushScores();
        else this.pushLobby();
      }
    }
    const g = this.game;
    if (!g || !g.me || g.mode === 'menu' || g.mode === 'replay' || g.loading) return;
    this.stateT -= dt;
    if (this.stateT > 0) return;
    this.stateT += STATE_DT;
    if (this.stateT < 0) this.stateT = 0;
    this.tickN++;
    if (this.isHost) this.hostTick(g);
    else if (this.conn) {
      if (this.fastOpen(this.conn)) {
        const dv = this.buf;
        dv.setUint8(0, 1);
        pack(dv, 1, 0, g.me);
        try { this.conn._fast.send(new Uint8Array(dv.buffer, 0, 1 + REC).slice()); } catch { /* channel closing */ }
      } else this.send({ t: 's', ...g.stateOf(g.me) });
    }
  }

  hostTick(g) {
    // records for everything this machine flies (the host's plane and the bots)
    const own = [];
    for (const p of g.planeList) {
      if (!p.owned) continue;
      const pl = this.players.get(p.id);
      if (!pl) continue;
      const rec = new Uint8Array(REC);
      pack(new DataView(rec.buffer), 0, pl.slot, p);
      own.push({ rec, pos: [p.air.pos.x, p.air.pos.y, p.air.pos.z], slot: pl.slot });
    }
    const near = (a, b) => !a || !b || (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2 < NEAR2;
    const out = new Uint8Array(this.buf.buffer);
    for (const r of this.players.values()) {
      if (!r.conn) continue;
      if (!this.fastOpen(r.conn)) {
        const list = g.planeList.filter((p) => p.owned).map((p) => g.stateOf(p));
        for (const q of this.players.values()) if (q.json && q.id !== r.id) list.push(q.json);
        r.conn.send({ t: 'S', s: list });
        continue;
      }
      let n = 0;
      const add = (rec) => { out.set(rec, 2 + n * REC); n++; };
      for (const o of own) if (near(r.pos, o.pos) || (this.tickN + o.slot) % 3 === 0) add(o.rec);
      for (const q of this.players.values()) {
        if (q === r || !q.rec || r.sent.get(q.id) === q.recTs || n >= 62) continue;
        if (!near(r.pos, q.pos) && (this.tickN + q.slot) % 3 !== 0) continue;
        r.sent.set(q.id, q.recTs);
        add(q.rec);
      }
      if (!n) continue;
      out[0] = 2; out[1] = n;
      try { r.conn._fast.send(out.slice(0, 2 + n * REC)); } catch { /* channel closing */ }
    }
  }

  openFast(conn) {
    try {
      const dc = conn.peerConnection.createDataChannel('state', { negotiated: true, id: 77, ordered: false, maxRetransmits: 0 });
      dc.binaryType = 'arraybuffer';
      dc.onmessage = (e) => {
        if (typeof e.data === 'string') {
          let m;
          try { m = JSON.parse(e.data); } catch { return; }
          if (this.isHost) this.hostData(conn, m); else this.clientData(m);
          return;
        }
        const type = new Uint8Array(e.data, 0, 1)[0];
        if (type === 1 && this.isHost) this.hostRecord(conn, e.data);
        else if (type === 2 && !this.isHost) this.clientRecords(e.data);
      };
      conn._fast = dc;
    } catch { conn._fast = null; }
  }

  fastOpen(conn) { return !!conn._fast && conn._fast.readyState === 'open'; }
}

function sanitizeLoad(l, i) {
  const types = Object.keys(AIRCRAFT);
  const type = types.includes(l?.type) ? l.type : 'fighter';
  const color = /^#[0-9a-fA-F]{6}$/.test(l?.color || '') ? l.color : PLAYER_COLORS[i % PLAYER_COLORS.length];
  const sb = l?.sb && typeof l.sb === 'object' ? { speed: +l.sb.speed || SANDBOX_DEFAULT.speed, control: +l.sb.control || SANDBOX_DEFAULT.control, stall: +l.sb.stall || 0 } : { ...SANDBOX_DEFAULT };
  return { type, color, sb };
}
