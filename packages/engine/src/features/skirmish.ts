// Skirmishers (MODEL 12.3). A screen is attached to its parent battalion, not a unit on the map:
// companies are below this simulator's resolution.

import { DEG, hash4, interp, mulberry32 } from '../math.ts';
import { pointRectDist, refreshGeom } from '../geom.ts';
import { STREAM, emit, setDims, shock } from '../sim.ts';
import type { Replay } from '../record.ts';
import type { ExpandedUnit } from '../scenario.ts';
import type { Sim, Unit } from '../types.ts';
import { hooks } from '../hooks.ts';
import { musketFactor as weatherMusket } from './weather.ts';

const K = (sim: Sim): Record<string, number> => sim.data.skirmish as Record<string, number>;

interface SkState {
  next: Float64Array;
  want: Int32Array; // override count from the scenario, -1 for the type's default
  inAt: Float64Array; // when the screen last came in
}

export function init(sim: Sim, expanded: ExpandedUnit[]): void {
  if (!sim.data.skirmish) throw new Error("skirmishers are on but data file 'skirmish.json' is missing");
  const st: SkState = { next: new Float64Array(sim.n), want: new Int32Array(sim.n).fill(-1), inAt: new Float64Array(sim.n).fill(-1e9) };
  expanded.forEach((e, i) => {
    if (e.skirmishers !== null) st.want[i] = e.skirmishers;
    st.next[i] = (i * 7) % Math.max(1, Math.round(K(sim).fireInterval));
  });
  sim.ext.skirmish = st;
  const tracks: number[][] = sim.units.map(() => []);
  (sim.ext.recorders ??= []) && (sim.ext.recorders as unknown[]).push({
    sample: () => sim.units.forEach((u, i) => tracks[i].push(u.skirmishers)),
    finish: (r: Replay) => sim.units.forEach((u, i) => {
      if (tracks[i].some((v) => v > 0)) (r.tracks[u.id] as unknown as { skirm: number[] }).skirm = tracks[i];
    }),
  });
}

function recall(sim: Sim, u: Unit, why: string): void {
  if (u.skirmishers <= 0) return;
  u.men += u.skirmishers;
  u.detached -= u.skirmishers;
  u.skirmishers = 0;
  u.skirmishOut = false;
  (sim.ext.skirmish as SkState).inAt[u.idx] = sim.t;
  setDims(u);
  refreshGeom(u);
  if (sim.eventLevel === 'full') emit(sim, { type: 'skirmishers', unit: u.id, side: u.side, state: 'in', why });
}

/** Called before a unit routs or is removed: its skirmishers go with it. */
export function onBreak(sim: Sim, u: Unit): void {
  recall(sim, u, 'battalion broke');
}

function binom(sim: Sim, key: number, n: number, p: number): number {
  if (n <= 0 || p <= 0) return 0;
  const r = mulberry32(hash4(sim.seed ^ Math.imul(STREAM.SKIRMISH, 0x9e3779b1), key, sim.tick, 0x5c1));
  let k = 0;
  for (let i = 0; i < n; i++) if (r() < p) k++;
  return k;
}

export function update(sim: Sim): void {
  const k = K(sim);
  const st = sim.ext.skirmish as SkState;
  const n = sim.n;
  const decide = sim.tick % 5 === 0;
  const screenLosses: [Unit, number, number][] = [];
  for (const u of sim.units) {
    if (u.arm !== 'inf' || u.status !== 'ok') continue;
    const row = u.idx * n;
    if (decide) {
      let nearFormed = Infinity,
        nearFoot = Infinity,
        nearCav = Infinity;
      for (const e of sim.units) {
        if (e.side === u.side || e.status !== 'ok') continue;
        const g = sim.gap[row + e.idx];
        if (g < nearFormed) nearFormed = g;
        if (e.arm === 'cav') {
          if (e.blown <= 0 && g < nearCav) nearCav = g;
        } else if (e.arm === 'inf' && g < nearFoot) nearFoot = g;
      }
      const want = u.form !== 'square' && !u.melee && nearFormed < k.deployRange && nearFoot > k.recallGap && nearCav > k.cavalryRecallRange;
      if (want && u.skirmishers === 0 && u.formT <= 0 && sim.t - st.inAt[u.idx] >= k.redeployDelay) {
        const frac = u.ut.skirmishFraction ?? 0;
        let out = st.want[u.idx] >= 0 ? st.want[u.idx] : Math.round(u.men * frac);
        const most = Math.floor(u.men * k.maxFraction);
        if (out > most) out = most;
        if (out > 0) {
          u.men -= out;
          u.detached += out;
          u.skirmishers = out;
          u.skirmishOut = true;
          setDims(u);
          refreshGeom(u);
          if (sim.eventLevel === 'full') emit(sim, { type: 'skirmishers', unit: u.id, side: u.side, state: 'out', men: out });
        }
      } else if (!want && u.skirmishers > 0) {
        recall(sim, u, nearCav <= k.cavalryRecallRange ? 'cavalry near' : nearFoot <= k.recallGap ? 'driven in' : u.form === 'square' ? 'square' : 'no enemy near');
      }
    }
    if (u.skirmishers <= 0 || sim.t < st.next[u.idx]) continue;
    st.next[u.idx] = sim.t + k.fireInterval;
    // the screen's position, ahead of the battalion
    const sx = u.x + u.c * k.screenDistance;
    const sy = u.y + u.s * k.screenDistance;
    let t: Unit | null = null,
      td = k.skirmishRange;
    for (const e of sim.units) {
      if (e.side === u.side || e.status !== 'ok') continue;
      if (sim.gap[row + e.idx] > k.screenDistance + k.skirmishRange + 50) continue;
      const d = pointRectDist(sx, sy, e);
      if (d < td && hooks.canSee(sim, u, e)) {
        td = d;
        t = e;
      }
    }
    if (!t) continue;
    const opp = t.arm === 'inf' ? t.skirmishers : 0;
    const p0 = interp(u.musket!.trialCurve, td) * k.battlefieldFactor * weatherMusket(sim) * (sim.features.quality ? sim.data.quality.classes[u.quality].fire : 1);
    // opposing screens fight each other first; only the surplus reaches the formed body
    const engaged = opp > 0 ? Math.min(u.skirmishers, opp) : 0;
    const free = u.skirmishers - engaged;
    if (engaged > 0) {
      const loss = binom(sim, u.idx * 2 + 1, engaged, p0 * k.vsSkirmishers);
      if (loss > 0) screenLosses.push([t, loss, u.idx]); // applied together below, so neither screen shoots first
    }
    if (free > 0) {
      let p = p0;
      if (t.arm === 'art') p *= sim.data.weapons.musketry.vsArtillery;
      if (t.feat) p *= t.feat.tt.coverMusketry;
      const loss = binom(sim, u.idx * 2, free, p);
      if (loss > 0) sim.pending.push({ target: t.idx, loss, k: k.shock, cause: 'skirmish_fire', from: u.idx, pursuit: false });
      if (sim.eventLevel === 'full') emit(sim, { type: 'fire', unit: u.id, side: u.side, target: t.id, kind: 'skirmish', loss, range: Math.round(td) });
    }
    sim.lastActivityT = sim.t;
  }
  for (const [t, wanted, from] of screenLosses) {
    const loss = Math.min(t.skirmishers, wanted);
    if (loss <= 0) continue;
    t.skirmishers -= loss;
    t.detached -= loss;
    t.casualties += loss;
    shock(sim, t, -((loss / t.startMen) * 100) * sim.data.morale.casualtyShock * k.shock * t.q, 'skirmish_fire', from);
  }
  void DEG;
}
