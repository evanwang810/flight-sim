// Map definitions: height field, vertex coloring and sky/light palette.
// No three.js imports: this module also runs inside the terrain worker.
import { simplex2, fbm, ridged, smoothstep, clamp, lerp } from './noise.js';

const mix = (out, a, b, t) => { out[0] = lerp(a[0], b[0], t); out[1] = lerp(a[1], b[1], t); out[2] = lerp(a[2], b[2], t); return out; };
const set = (out, c) => { out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; return out; };
const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const _t = [0, 0, 0];

// ---------- Alpine: ridged ranges cut by winding valleys you can fly through ----------
const A = {
  meadow: hex(0x5e7f3a), forest: hex(0x2f4a25), forestDark: hex(0x22381d), rock: hex(0x6b655d),
  rockDark: hex(0x4a4642), snow: hex(0xeef2f7), scree: hex(0x8a8274), river: hex(0x6d7f5a),
};
function alpineHeight(x, z) {
  const X = x * 0.001, Z = z * 0.001;
  const mask = smoothstep(-0.75, 0.25, fbm(X * 0.2 + 11, Z * 0.2 - 7, 2));
  const r = ridged(X * 0.5, Z * 0.5, 5);
  const v = Math.abs(simplex2(X * 0.16 + 3.1, Z * 0.16 + 1.7) + 0.35 * simplex2(X * 0.45 - 5, Z * 0.45 + 2));
  const valley = smoothstep(0.02, 0.2, v);
  const base = fbm(X * 0.4 + 40, Z * 0.4 + 40, 3) * 45;
  return 60 + base + Math.pow(r, 1.25) * 900 * (0.35 + 0.65 * mask) * valley;
}
function alpineColor(h, ny, x, z, out) {
  const n = simplex2(x * 0.004, z * 0.004);
  const steep = smoothstep(0.82, 0.62, ny);
  const snowLine = 640 + n * 90;
  if (h < 140) mix(out, A.meadow, A.forest, smoothstep(70, 140, h + n * 30));
  else mix(out, A.forest, A.forestDark, smoothstep(0.2, 0.7, n * 0.5 + 0.5));
  mix(out, out, A.rock, smoothstep(380, 640, h + n * 60) * 0.85);
  mix(out, out, n > 0 ? A.rock : A.rockDark, steep);
  const snow = smoothstep(snowLine - 40, snowLine + 60, h) * smoothstep(0.55, 0.78, ny);
  return mix(out, out, A.snow, snow);
}

// ---------- Canyon: terraced mesas split by deep sandstone canyons ----------
const C = {
  floor: hex(0xd8b682), sand: hex(0xe3c08c), top: hex(0xc58e55), scrub: hex(0x8a7a4a),
  bands: [hex(0xb8603a), hex(0xd88a52), hex(0x9c4b30), hex(0xe7b07a), hex(0xc46c42)],
};
function canyonHeight(x, z) {
  const X = x * 0.001, Z = z * 0.001;
  const n = simplex2(X * 0.32, Z * 0.32) + 0.45 * simplex2(X * 0.85 + 5, Z * 0.85 - 3);
  const canyon = smoothstep(0.08, 0.27, Math.abs(n));
  const butte = smoothstep(0.62, 0.78, simplex2(X * 0.9 + 21, Z * 0.9 - 13)) * (1 - canyon);
  const top = 230 + fbm(X * 0.25 + 9, Z * 0.25 + 2, 3) * 80;
  let h = top * Math.max(canyon, butte * 0.85);
  const step = 34, tf = h / step, fl = Math.floor(tf);
  h = (fl + smoothstep(0.3, 0.7, tf - fl)) * step;
  const dunes = (1 - canyon) * Math.abs(simplex2(X * 2.4, Z * 1.2)) * 12;
  return h + dunes + 6;
}
function canyonColor(h, ny, x, z, out) {
  const n = simplex2(x * 0.006, z * 0.006);
  if (ny > 0.9) {
    if (h < 30) return mix(out, C.floor, C.sand, n * 0.5 + 0.5);
    mix(out, C.top, C.scrub, smoothstep(0.35, 0.8, simplex2(x * 0.02, z * 0.02)) * 0.6);
    return out;
  }
  const b = Math.floor((h + n * 6) / 11) % C.bands.length;
  set(out, C.bands[(b + C.bands.length) % C.bands.length]);
  return mix(out, out, C.top, smoothstep(0.75, 0.9, ny));
}

// ---------- Archipelago: volcanic islands in a shallow tropical sea ----------
const I = {
  deep: hex(0x2c5f6a), shallow: hex(0x7bb3a5), beach: hex(0xeedcab), grass: hex(0x5f9a3a),
  jungle: hex(0x2b6a2b), rock: hex(0x6d6259), ash: hex(0x3b3633),
};
function islandHeight(x, z) {
  const X = x * 0.001, Z = z * 0.001;
  const m = fbm(X * 0.13 + 1, Z * 0.13 - 4, 3);
  const isl = smoothstep(-0.12, 0.38, m);
  const hills = fbm(X * 0.7, Z * 0.7, 4) * 0.5 + 0.5;
  const peaks = Math.pow(ridged(X * 0.42 + 3, Z * 0.42 + 8, 4), 2.2) * 560;
  return -60 + isl * (75 + hills * 70 + peaks * isl);
}
function islandColor(h, ny, x, z, out) {
  const n = simplex2(x * 0.005, z * 0.005);
  if (h < -1) return mix(out, I.deep, I.shallow, smoothstep(-40, -2, h));
  if (h < 7 + n * 3) return set(out, I.beach);
  mix(out, I.grass, I.jungle, smoothstep(20, 90, h + n * 25));
  mix(out, out, I.rock, Math.max(smoothstep(0.84, 0.66, ny), smoothstep(240, 360, h)));
  return mix(out, out, I.ash, smoothstep(380, 480, h + n * 30));
}

// ---------- Proving grounds: flat calibration grid ----------
function gridColor(h, ny, x, z, out) { return set(out, [0.86, 0.88, 0.9]); }

export const MAPS = {
  alpine: {
    name: 'Alpine', desc: 'Snowy ridges and deep valleys. Plenty of cover, plenty to hit.',
    height: alpineHeight, color: alpineColor, water: null, maxH: 1150, spawnAlt: 1300,
    sky: { zenith: 0x3f7bd0, horizon: 0xbfd9ee, sun: [0.45, 0.62, -0.42], sunColor: 0xfff1dc, sunI: 2.2, hemiSky: 0xcfe6ff, hemiGround: 0x4b5a3b, hemiI: 0.9, clouds: 0.55, cloudAlt: 1700, haze: 1 },
  },
  canyon: {
    name: 'Canyon', desc: 'Golden-hour mesas and narrow sandstone canyons. Fly low.',
    height: canyonHeight, color: canyonColor, water: null, maxH: 340, spawnAlt: 700,
    sky: { zenith: 0x4c73b2, horizon: 0xf3c99b, sun: [-0.72, 0.22, 0.42], sunColor: 0xffc787, sunI: 2.6, hemiSky: 0xffe3c2, hemiGround: 0x7a4a2c, hemiI: 0.75, clouds: 0.25, cloudAlt: 1500, haze: 1.2 },
  },
  archipelago: {
    name: 'Archipelago', desc: 'Volcanic islands over a turquoise sea. Splash down and you are done.',
    height: islandHeight, color: islandColor, water: 0, maxH: 650, spawnAlt: 900,
    sky: { zenith: 0x2a86de, horizon: 0xd2ecf7, sun: [0.2, 0.8, 0.3], sunColor: 0xfff8ea, sunI: 2.3, hemiSky: 0xd9f1ff, hemiGround: 0x3c6a55, hemiI: 1.0, clouds: 0.65, cloudAlt: 1200, haze: 0.9 },
  },
  grid: {
    name: 'Proving Grounds', desc: 'Flat calibration grid. Perfect for learning the controls.',
    height: () => 0, color: gridColor, water: null, maxH: 2, spawnAlt: 600, grid: true,
    sky: { zenith: 0x8ea8c4, horizon: 0xe4ebf2, sun: [0.35, 0.7, 0.4], sunColor: 0xffffff, sunI: 2.0, hemiSky: 0xf2f6fa, hemiGround: 0x9aa3ab, hemiI: 1.0, clouds: 0.3, cloudAlt: 900, haze: 0.7 },
  },
};

export function getMap(id) { return MAPS[id] || MAPS.alpine; }
export { clamp };
