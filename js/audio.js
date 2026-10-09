// Procedural sound: engine, wind, guns, explosions and lock tones. No asset files.
let ctx = null, master, noise, eng, tone;

function noiseBuffer(sec, shape) {
  const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    last = last * 0.6 + w * 0.4;
    d[i] = (shape ? last * shape(i / n) : w);
  }
  return b;
}

function loop(buf) {
  const s = ctx.createBufferSource();
  s.buffer = buf; s.loop = true; s.start();
  return s;
}

function filter(type, f, q = 1) {
  const x = ctx.createBiquadFilter();
  x.type = type; x.frequency.value = f; x.Q.value = q;
  return x;
}

function gain(v = 0) { const g = ctx.createGain(); g.gain.value = v; return g; }

let shotBuf, boomBuf, popBuf, shotsThisFrame = 0;

export const audio = {
  volume: 0.7,

  // Must be called from a user gesture.
  init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    try { ctx = new AudioContext(); } catch { return; }
    master = gain(this.volume);
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp); comp.connect(ctx.destination);
    noise = noiseBuffer(2);
    shotBuf = noiseBuffer(0.09, (t) => Math.exp(-t * 6) * 1.6);
    boomBuf = noiseBuffer(2.2, (t) => Math.exp(-t * 3.2) * (t < 0.02 ? t / 0.02 : 1) * 2);
    popBuf = noiseBuffer(0.25, (t) => Math.exp(-t * 9));

    eng = { out: gain(0) };
    eng.out.connect(master);
    eng.osc = ctx.createOscillator(); eng.osc.type = 'sawtooth';
    eng.oscLp = filter('lowpass', 300); eng.oscG = gain(0);
    eng.osc.connect(eng.oscLp); eng.oscLp.connect(eng.oscG); eng.oscG.connect(eng.out);
    eng.osc.start();
    eng.hiss = loop(noise); eng.hissBp = filter('bandpass', 800, 0.7); eng.hissG = gain(0);
    eng.hiss.connect(eng.hissBp); eng.hissBp.connect(eng.hissG); eng.hissG.connect(eng.out);
    eng.rumble = loop(noise); eng.rumbleLp = filter('lowpass', 140); eng.rumbleG = gain(0);
    eng.rumble.connect(eng.rumbleLp); eng.rumbleLp.connect(eng.rumbleG); eng.rumbleG.connect(eng.out);
    eng.wind = loop(noise); eng.windLp = filter('lowpass', 500, 0.5); eng.windG = gain(0);
    eng.wind.connect(eng.windLp); eng.windLp.connect(eng.windG); eng.windG.connect(master);

    tone = { osc: ctx.createOscillator(), g: gain(0) };
    tone.osc.type = 'square';
    const tl = filter('lowpass', 2500);
    tone.osc.connect(tl); tl.connect(tone.g); tone.g.connect(master);
    tone.osc.start();
  },

  setVolume(v) {
    this.volume = v;
    if (master) master.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
  },

  // kind: 'jet' | 'prop' | 'big'. on = false fades everything out (menus, death).
  engine(on, throttle, ab, speed, kind) {
    if (!ctx) return;
    const t = ctx.currentTime, k = 0.08;
    const set = (p, v) => p.setTargetAtTime(v, t, k);
    set(eng.out.gain, on ? 1 : 0);
    if (kind === 'prop') {
      set(eng.osc.frequency, 38 + throttle * 46);
      set(eng.oscLp.frequency, 260 + throttle * 700);
      set(eng.oscG.gain, 0.10 + throttle * 0.10);
      set(eng.hissG.gain, 0.012);
      set(eng.rumbleG.gain, 0.10);
    } else {
      const big = kind === 'big';
      set(eng.osc.frequency, (big ? 55 : 70) + throttle * (big ? 30 : 60));
      set(eng.oscLp.frequency, 160 + throttle * 220);
      set(eng.oscG.gain, 0.03 + throttle * 0.03);
      set(eng.hissBp.frequency, (big ? 500 : 700) + throttle * 1100);
      set(eng.hissG.gain, 0.025 + throttle * 0.05 + ab * 0.03);
      set(eng.rumbleG.gain, 0.10 + throttle * 0.12 + ab * 0.45);
    }
    const w = Math.min(1, speed / 260);
    set(eng.windLp.frequency, 300 + w * 1400);
    set(eng.windG.gain, on ? w * w * 0.22 : 0);
  },

  shot(dist = 0, heavy = false) {
    if (!ctx || shotsThisFrame > 3) return;
    const g = (heavy ? 0.5 : 0.32) / (1 + dist / 120);
    if (g < 0.01) return;
    shotsThisFrame++;
    const s = ctx.createBufferSource(), f = filter('lowpass', heavy ? 1600 : 2600), gg = gain(g);
    s.buffer = shotBuf; s.playbackRate.value = 0.85 + Math.random() * 0.3;
    s.connect(f); f.connect(gg); gg.connect(master); s.start();
  },

  boom(dist = 0, size = 1) {
    if (!ctx) return;
    const g = Math.min(1.3, size) / (1 + dist / 450);
    if (g < 0.02) return;
    const t = ctx.currentTime;
    const s = ctx.createBufferSource(), f = filter('lowpass', 500 + 500 / (1 + dist / 300)), gg = gain(g);
    s.buffer = boomBuf; s.playbackRate.value = (0.75 + Math.random() * 0.2) / Math.sqrt(Math.max(0.6, size));
    s.connect(f); f.connect(gg); gg.connect(master); s.start();
    if (size > 0.8) {
      // sub-bass thump under the big ones
      const o = ctx.createOscillator(), og = gain(0);
      o.type = 'sine';
      o.frequency.setValueAtTime(78, t); o.frequency.exponentialRampToValueAtTime(28, t + 0.9);
      og.gain.setValueAtTime(Math.min(0.9, g * 0.8), t); og.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
      o.connect(og); og.connect(master); o.start(t); o.stop(t + 1.2);
    }
  },

  // Double crack of a plane going supersonic.
  sonic(dist = 0) {
    this.boom(dist * 0.6, 1.1);
    setTimeout(() => this.boom(dist * 0.6, 0.85), 120);
  },

  pop(dist = 0) {
    if (!ctx) return;
    const s = ctx.createBufferSource(), f = filter('bandpass', 1800, 1.2), gg = gain(0.35 / (1 + dist / 200));
    s.buffer = popBuf; s.connect(f); f.connect(gg); gg.connect(master); s.start();
  },

  blip(freq = 1400, len = 0.05, vol = 0.12) {
    if (!ctx) return;
    const o = ctx.createOscillator(), g = gain(0), t = ctx.currentTime;
    o.type = 'triangle'; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + len);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + len + 0.02);
  },

  // 0 silent, 1 locking (slow beeps), 2 locked (steady), 3 missile warning (fast high beeps)
  tone(state, time) {
    if (!ctx) return;
    let f = 0, on = 0;
    if (state === 1) { f = 880; on = (time * 4) % 1 < 0.35 ? 1 : 0; }
    else if (state === 2) { f = 1320; on = 1; }
    else if (state === 3) { f = 1760; on = (time * 9) % 1 < 0.5 ? 1 : 0; }
    tone.osc.frequency.setTargetAtTime(f || 880, ctx.currentTime, 0.005);
    tone.g.gain.setTargetAtTime(on * 0.045, ctx.currentTime, 0.005);
  },

  endFrame() { shotsThisFrame = 0; },
};
