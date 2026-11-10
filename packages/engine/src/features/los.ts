// Line of sight and elevation (MODEL 12.5).

import { elevAt, gradAt, pointInPoly } from '../scenario.ts';
import type { Sim, Unit } from '../types.ts';
import { cos, sin } from '../math.ts';

const L = (sim: Sim): Record<string, number> => sim.data.los as Record<string, number>;

interface LosState {
  seen: Int8Array; // -1 unknown, 0 blocked, 1 clear
  at: Float64Array;
}

export function init(sim: Sim): void {
  if (!sim.data.los) throw new Error("line of sight is on but data file 'los.json' is missing");
  sim.ext.los = { seen: new Int8Array(sim.n * sim.n).fill(-1), at: new Float64Array(sim.n * sim.n).fill(-1e9) } as LosState;
}

/** Can a point at height h1 above the ground at (x1,y1) see a point at h2 above the ground at (x2,y2)? */
export function clearLine(sim: Sim, x1: number, y1: number, h1: number, x2: number, y2: number, h2: number): boolean {
  const l = L(sim);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const D = Math.sqrt(dx * dx + dy * dy);
  if (D > l.maxSight) return false;
  const z1 = elevAt(sim.map, x1, y1) + h1;
  const z2 = elevAt(sim.map, x2, y2) + h2;
  const steps = Math.floor(D / l.sampleStep);
  const feats = sim.map.features;
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const x = x1 + dx * f;
    const y = y1 + dy * f;
    const line = z1 + (z2 - z1) * f;
    let ground = elevAt(sim.map, x, y);
    if (ground > line) return false;
    for (const ft of feats) {
      if (x < ft.minX || x > ft.maxX || y < ft.minY || y > ft.maxY) continue;
      if (!pointInPoly(ft.poly, x, y)) continue;
      // a unit standing in the feature looks out from its edge
      if (pointInPoly(ft.poly, x1, y1) || pointInPoly(ft.poly, x2, y2)) continue;
      ground += ft.tt.sightHeight;
      break;
    }
    if (ground > line) return false;
  }
  return true;
}

export function canSee(sim: Sim, a: Unit, b: Unit): boolean {
  const st = sim.ext.los as LosState;
  const l = L(sim);
  const i = a.idx < b.idx ? a.idx * sim.n + b.idx : b.idx * sim.n + a.idx;
  if (sim.t - st.at[i] < l.recheckInterval && st.seen[i] >= 0) return st.seen[i] === 1;
  const ha = a.arm === 'cav' ? l.eyeHeightMounted : l.eyeHeightFoot;
  const hb = b.arm === 'cav' ? l.eyeHeightMounted : l.eyeHeightFoot;
  const ok = clearLine(sim, a.x, a.y, ha, b.x, b.y, hb);
  st.seen[i] = ok ? 1 : 0;
  st.at[i] = sim.t;
  return ok;
}

/** Speed factor for the grade along the line of march; replaces the baseline's flat slope penalty. */
export function slopeSpeed(sim: Sim, u: Unit, heading: number): number {
  const l = L(sim);
  const T = sim.data.terrain;
  const [gx, gy] = gradAt(sim.map, u.x, u.y);
  const along = gx * cos(heading) + gy * sin(heading); // positive is uphill
  // undo the flat penalty the baseline applied, then apply the graded one
  const flat = !u.feat && gx * gx + gy * gy > T.slopeThreshold * T.slopeThreshold ? 1 / T.slopeMove : 1;
  if (along <= 0) return flat;
  let loss = (along / 0.1) * l.uphillSpeedLossPer10;
  if (loss > l.maxSlopeLoss) loss = l.maxSlopeLoss;
  return flat * (1 - loss);
}
