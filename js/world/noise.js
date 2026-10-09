// Seeded 2D simplex noise plus fbm/ridged helpers. Shared by the main thread and the terrain worker,
// so both produce bit-identical heights.

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = new Float64Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1]);
const perm = new Uint8Array(512);
const pg = new Uint8Array(512);

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedNoise(seed) {
  const rnd = mulberry32(seed >>> 0);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; pg[i] = (perm[i] & 7) * 2; }
}
seedNoise(1337);

export function simplex2(xin, yin) {
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s), j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t), y0 = yin - (j - t);
  const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) { const g = pg[ii + perm[jj]]; t0 *= t0; n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0); }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) { const g = pg[ii + i1 + perm[jj + j1]]; t1 *= t1; n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1); }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) { const g = pg[ii + 1 + perm[jj + 1]]; t2 *= t2; n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2); }
  return 70 * n;
}

// Fractal sum, roughly in [-1, 1].
export function fbm(x, y, oct, lac = 2, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += simplex2(x, y) * amp; norm += amp;
    x = x * lac + 17.3; y = y * lac - 9.1; amp *= gain;
  }
  return sum / norm;
}

// Ridged multifractal in [0, 1]; sharp crests where the base noise crosses zero.
export function ridged(x, y, oct, lac = 2.1, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, w = 1;
  for (let o = 0; o < oct; o++) {
    let n = 1 - Math.abs(simplex2(x, y));
    n *= n;
    sum += n * amp * w; norm += amp;
    w = Math.min(1, n * 1.6);
    x = x * lac + 31.7; y = y * lac + 11.3; amp *= gain;
  }
  return sum / norm;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const lerp = (a, b, t) => a + (b - a) * t;
