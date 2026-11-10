export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

export function sd(xs: number[]): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/** Quantile by linear interpolation between order statistics. */
export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export interface Dist {
  n: number;
  mean: number;
  sd: number;
  p10: number;
  median: number;
  p90: number;
  min: number;
  max: number;
}

export function dist(xs: number[]): Dist {
  return { n: xs.length, mean: mean(xs), sd: sd(xs), p10: quantile(xs, 0.1), median: quantile(xs, 0.5), p90: quantile(xs, 0.9), min: xs.length ? Math.min(...xs) : NaN, max: xs.length ? Math.max(...xs) : NaN };
}

/** Wilson score interval for a proportion, 95%. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [NaN, NaN];
  const z = 1.959964;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export function histogram(xs: number[], lo: number, hi: number, bins: number): number[] {
  const h = new Array(bins).fill(0);
  for (const x of xs) {
    if (x !== x) continue;
    let b = Math.floor(((x - lo) / (hi - lo)) * bins);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    h[b]++;
  }
  return h;
}

export function csvCell(v: unknown): string {
  if (v === null || v === undefined || (typeof v === 'number' && v !== v)) return '';
  // seven significant figures: enough for small coefficients on a sweep axis, short enough to read
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(7)))) : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const csv = (rows: unknown[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
