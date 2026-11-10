// Deterministic maths. Only + - * / and Math.sqrt/floor/abs/imul are used, so results are
// bit-identical in every JavaScript engine. Math.sin/cos/atan2 are NOT guaranteed to be.

export const PI = 3.141592653589793;
export const TAU = 2 * PI;
export const HALF_PI = PI / 2;
export const DEG = PI / 180;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function sin(x: number): number {
  x = x - TAU * Math.floor((x + PI) / TAU); // [-PI, PI)
  if (x > HALF_PI) x = PI - x;
  else if (x < -HALF_PI) x = -PI - x;
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800)))))));
}

export const cos = (x: number): number => sin(x + HALF_PI);

/** atan2 by polynomial (Abramowitz & Stegun 4.4.49), error below 1e-5 rad. */
export function atan2(y: number, x: number): number {
  if (x === 0 && y === 0) return 0;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const swap = ay > ax;
  const z = swap ? ax / ay : ay / ax;
  const z2 = z * z;
  let a = z * (0.999866 + z2 * (-0.3302995 + z2 * (0.180141 + z2 * (-0.085133 + z2 * 0.0208351))));
  if (swap) a = HALF_PI - a;
  if (x < 0) a = PI - a;
  return y < 0 ? -a : a;
}

/** Signed smallest difference a - b, in [-PI, PI). */
export function angDiff(a: number, b: number): number {
  const d = a - b;
  return d - TAU * Math.floor((d + PI) / TAU);
}

export const len = (dx: number, dy: number): number => Math.sqrt(dx * dx + dy * dy);

/** 32-bit mixing hash of four integers. The basis of all randomness in the engine. */
export function hash4(a: number, b: number, c: number, d: number): number {
  let h = 0x9e3779b9 ^ a;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h ^= b;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= c;
  h = Math.imul(h ^ (h >>> 16), 0x27d4eb2f);
  h ^= d;
  h = Math.imul(h ^ (h >>> 15), 0x165667b1);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A small sequential generator for bulk draws, seeded from a hash. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Curve {
  points: [number, number][];
}

/** Piecewise-linear interpolation, clamped at both ends. */
export function interp(c: Curve, x: number): number {
  const p = c.points;
  if (x <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) {
    if (x <= p[i][0]) {
      const [x0, y0] = p[i - 1];
      const [x1, y1] = p[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return p[p.length - 1][1];
}
