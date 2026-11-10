import { cos, sin } from './math.ts';
import type { Unit } from './types.ts';

/** Refresh cached trig and corner coordinates after a unit's position, facing or size changes. */
export function refreshGeom(u: Unit): void {
  const c = cos(u.f);
  const s = sin(u.f);
  u.c = c;
  u.s = s;
  const hw = u.w / 2;
  const hd = u.d / 2;
  // forward axis (c, s); side axis (-s, c)
  const fx = c * hd,
    fy = s * hd,
    sx = -s * hw,
    sy = c * hw;
  const k = u.cx;
  k[0] = u.x + fx + sx;
  k[1] = u.y + fy + sy;
  k[2] = u.x + fx - sx;
  k[3] = u.y + fy - sy;
  k[4] = u.x - fx - sx;
  k[5] = u.y - fy - sy;
  k[6] = u.x - fx + sx;
  k[7] = u.y - fy + sy;
}

/** Distance from a point to a unit's rectangle (0 inside). */
export function pointRectDist(px: number, py: number, u: Unit): number {
  const dx = px - u.x;
  const dy = py - u.y;
  let fw = dx * u.c + dy * u.s;
  let sd = -dx * u.s + dy * u.c;
  if (fw < 0) fw = -fw;
  if (sd < 0) sd = -sd;
  fw -= u.d / 2;
  sd -= u.w / 2;
  if (fw < 0) fw = 0;
  if (sd < 0) sd = 0;
  return Math.sqrt(fw * fw + sd * sd);
}

/** Largest separation over the four face normals. Positive means the rectangles do not overlap. */
function satSeparation(a: Unit, b: Unit): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const cc = a.c * b.c + a.s * b.s; // cos of the angle between facings
  const cs = a.c * b.s - a.s * b.c; // sin of it
  const acc = cc < 0 ? -cc : cc;
  const acs = cs < 0 ? -cs : cs;
  const ahw = a.w / 2,
    ahd = a.d / 2,
    bhw = b.w / 2,
    bhd = b.d / 2;
  let p = dx * a.c + dy * a.s;
  let best = (p < 0 ? -p : p) - ahd - (bhd * acc + bhw * acs);
  p = -dx * a.s + dy * a.c;
  let v = (p < 0 ? -p : p) - ahw - (bhw * acc + bhd * acs);
  if (v > best) best = v;
  p = dx * b.c + dy * b.s;
  v = (p < 0 ? -p : p) - bhd - (ahd * acc + ahw * acs);
  if (v > best) best = v;
  p = -dx * b.s + dy * b.c;
  v = (p < 0 ? -p : p) - bhw - (ahw * acc + ahd * acs);
  if (v > best) best = v;
  return best;
}

/** Beyond every range any rule uses, so the cheap bound is only ever returned for pairs that cannot interact. */
const EXACT_WITHIN = 2500;

/** Gap in metres between two unit rectangles; 0 if they overlap. Exact within EXACT_WITHIN metres. */
export function rectGap(a: Unit, b: Unit): number {
  const sep = satSeparation(a, b);
  if (sep <= 0) return 0;
  if (sep > EXACT_WITHIN) return sep;
  let best = Infinity;
  for (let i = 0; i < 8; i += 2) {
    let d = pointRectDist(a.cx[i], a.cx[i + 1], b);
    if (d < best) best = d;
    d = pointRectDist(b.cx[i], b.cx[i + 1], a);
    if (d < best) best = d;
  }
  return best;
}
