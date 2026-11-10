// Powder smoke (MODEL 12.6): a coarse grid of density fed by every discharge, drifting with the wind.

import { DEG, cos, sin } from '../math.ts';
import type { Replay } from '../record.ts';
import type { Sim, Unit } from '../types.ts';
import { smokeDecayFactor } from './weather.ts';

const S = (sim: Sim): Record<string, number> => sim.data.smoke as Record<string, number>;

interface SmokeState {
  cell: number;
  cols: number;
  rows: number;
  d: Float64Array;
  tmp: Float64Array;
  wx: number; // wind velocity, m/s, toward
  wy: number;
  seen: Int8Array;
  at: Float64Array;
}

export function init(sim: Sim): void {
  const cfg = S(sim);
  if (!cfg) throw new Error("smoke is on but data file 'smoke.json' is missing");
  const cell = cfg.cellSize;
  const cols = Math.ceil(sim.map.width / cell);
  const rows = Math.ceil(sim.map.height / cell);
  const w = sim.scenario.weather ?? { sky: 'clear', ground: 'firm', windFrom: 270, windSpeed: 0 };
  // wind FROM a compass bearing blows TOWARD the opposite one; bearing 0 is north (-y), 90 east (+x)
  const toward = (w.windFrom + 180 - 90) * DEG;
  const st: SmokeState = { cell, cols, rows, d: new Float64Array(cols * rows), tmp: new Float64Array(cols * rows), wx: cos(toward) * w.windSpeed, wy: sin(toward) * w.windSpeed, seen: new Int8Array(sim.n * sim.n).fill(-1), at: new Float64Array(sim.n * sim.n).fill(-1e9) };
  sim.ext.smoke = st;
  const frames: string[] = [];
  let k = 0;
  const every = 4;
  (sim.ext.recorders ??= []) && (sim.ext.recorders as unknown[]).push({
    sample: () => {
      if (k++ % every !== 0) return;
      let s = '';
      for (let i = 0; i < st.d.length; i++) {
        const v = Math.round(st.d[i] * 4.5); // density 2 and above saturates at 9
        s += v > 9 ? '9' : String(v);
      }
      frames.push(s);
    },
    finish: (r: Replay) => {
      r.smoke = { cell, cols, rows, every, frames };
    },
  });
}

const state = (sim: Sim): SmokeState => sim.ext.smoke as SmokeState;

function deposit(st: SmokeState, x: number, y: number, amount: number): void {
  const c = Math.floor(x / st.cell);
  const r = Math.floor(y / st.cell);
  if (c < 0 || r < 0 || c >= st.cols || r >= st.rows) return;
  st.d[r * st.cols + c] += amount;
}

export function onFired(sim: Sim, u: Unit, kind: 'musket' | 'roundshot' | 'canister', shots: number): void {
  const st = state(sim);
  const cfg = S(sim);
  const total = shots * (kind === 'musket' ? cfg.perMusket : cfg.perGun);
  // spread along the unit's front, a little ahead of it
  const k = Math.max(1, Math.round(u.w / st.cell));
  const fx = u.x + u.c * (u.d / 2 + 5);
  const fy = u.y + u.s * (u.d / 2 + 5);
  for (let i = 0; i < k; i++) {
    const lat = k === 1 ? 0 : (i / (k - 1) - 0.5) * u.w;
    deposit(st, fx - u.s * lat, fy + u.c * lat, total / k);
  }
}

function sample(st: SmokeState, x: number, y: number): number {
  const gx = x / st.cell - 0.5;
  const gy = y / st.cell - 0.5;
  const c = Math.floor(gx);
  const r = Math.floor(gy);
  const fx = gx - c;
  const fy = gy - r;
  const at = (cc: number, rr: number) => (cc < 0 || rr < 0 || cc >= st.cols || rr >= st.rows ? 0 : st.d[rr * st.cols + cc]);
  return at(c, r) * (1 - fx) * (1 - fy) + at(c + 1, r) * fx * (1 - fy) + at(c, r + 1) * (1 - fx) * fy + at(c + 1, r + 1) * fx * fy;
}

export function update(sim: Sim): void {
  const cfg = S(sim);
  const every = Math.max(1, Math.round(cfg.updateInterval / sim.dt));
  if (sim.tick % every !== 0) return;
  const st = state(sim);
  const dt = every * sim.dt;
  const { cols, rows, cell } = st;
  let keep = 1 - cfg.decayPerSecond * smokeDecayFactor(sim) * dt;
  if (keep < 0) keep = 0;
  // drift: each cell takes the density that was upwind of it
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      st.tmp[r * cols + c] = sample(st, (c + 0.5) * cell - st.wx * dt, (r + 0.5) * cell - st.wy * dt) * keep;
    }
  }
  // spread
  const k = cfg.diffusion;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const n = r > 0 ? st.tmp[i - cols] : 0;
      const s = r < rows - 1 ? st.tmp[i + cols] : 0;
      const w = c > 0 ? st.tmp[i - 1] : 0;
      const e = c < cols - 1 ? st.tmp[i + 1] : 0;
      const v = st.tmp[i] * (1 - 4 * k) + k * (n + s + w + e);
      st.d[i] = v < 0.001 ? 0 : v;
    }
  }
}

/** Smoke summed along a line, in units of one full cell of density 1. */
export function opticalDepth(sim: Sim, x1: number, y1: number, x2: number, y2: number): number {
  const st = state(sim);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const D = Math.sqrt(dx * dx + dy * dy);
  const step = st.cell / 2;
  const nS = Math.max(1, Math.ceil(D / step));
  let tau = 0;
  for (let i = 0; i <= nS; i++) {
    const f = i / nS;
    tau += sample(st, x1 + dx * f, y1 + dy * f);
  }
  return (tau * (D / nS)) / st.cell + sample(st, x1, y1) * 0.5; // the firer's own smoke counts even at point-blank
}

export function hitFactor(sim: Sim, u: Unit, t: Unit): number {
  return 1 / (1 + S(sim).hitLoss * opticalDepth(sim, u.x + u.c * (u.d / 2 + 5), u.y + u.s * (u.d / 2 + 5), t.x, t.y));
}

export function canSee(sim: Sim, a: Unit, b: Unit): boolean {
  const st = state(sim);
  const i = a.idx < b.idx ? a.idx * sim.n + b.idx : b.idx * sim.n + a.idx;
  if (sim.t - st.at[i] < 5 && st.seen[i] >= 0) return st.seen[i] === 1;
  const ok = opticalDepth(sim, a.x, a.y, b.x, b.y) <= S(sim).blockDepth;
  st.seen[i] = ok ? 1 : 0;
  st.at[i] = sim.t;
  return ok;
}

export function densityAt(sim: Sim, x: number, y: number): number {
  return sample(state(sim), x, y);
}
