// Fatigue and ammunition (MODEL 12.2). Two independent toggles: features.fatigue and features.ammunition.

import { gradAt } from '../scenario.ts';
import { emit } from '../sim.ts';
import type { Sim, Unit } from '../types.ts';
import { fatigueFactor } from './weather.ts';

const F = (sim: Sim): Record<string, number> => sim.data.fatigue as Record<string, number>;
interface AmmoData {
  cartridges: Record<string, number>;
  guns: Record<string, { roundshot: number; canister: number }>;
  firstVolleyBonus: number;
  foulingRounds: number;
  foulingSlowdown: number;
  foulingMisfire: number;
  resupplyTime: number;
  resupplyDistance: number;
  resupplyFraction: number;
  maxResupplies: number;
}
const A = (sim: Sim): AmmoData => sim.data.ammunition as AmmoData;

interface AmmoState {
  full: Float64Array;
  quiet: Float64Array; // seconds with no formed enemy near
  resupplies: Int32Array;
  lastFired: Float64Array;
}

export function init(sim: Sim): void {
  if (sim.features.fatigue && !sim.data.fatigue) throw new Error("fatigue is on but data file 'fatigue.json' is missing");
  if (sim.features.ammunition) {
    const a = A(sim);
    if (!a) throw new Error("ammunition is on but data file 'ammunition.json' is missing");
    const st: AmmoState = { full: new Float64Array(sim.n), quiet: new Float64Array(sim.n), resupplies: new Int32Array(sim.n), lastFired: new Float64Array(sim.n).fill(-1e9) };
    for (const u of sim.units) {
      if (u.arm === 'inf') {
        const c = a.cartridges[u.ut.doctrine!];
        if (typeof c !== 'number') throw new Error(`ammunition.json: no cartridges for doctrine '${u.ut.doctrine}'`);
        u.ammo = c;
        st.full[u.idx] = c;
      } else if (u.arm === 'art') {
        const g = a.guns[u.ut.gun!];
        if (!g) throw new Error(`ammunition.json: no entry for gun '${u.ut.gun}'`);
        u.gunRounds = g.roundshot * u.ut.guns!;
        u.gunCanister = g.canister * u.ut.guns!;
      }
    }
    sim.ext.ammo = st;
  }
  sim.ext.lastFired = new Float64Array(sim.n).fill(-1e9);
}

const fouling = (sim: Sim, u: Unit): number => {
  const f = u.roundsFired / A(sim).foulingRounds;
  return f > 1 ? 1 : f;
};

export function onMoved(sim: Sim, u: Unit, metres: number): void {
  if (!sim.features.fatigue) return;
  const f = F(sim);
  let per = u.arm === 'cav' ? (u.charging ? f.gallopPerKm : f.trotPerKm) : f.marchPerKm;
  if (u.feat) per *= f.roughFactor;
  else {
    const [gx, gy] = gradAt(sim.map, u.x, u.y);
    const T = sim.data.terrain.slopeThreshold;
    if (gx * gx + gy * gy > T * T) per *= f.roughFactor;
  }
  per *= fatigueFactor(sim);
  u.fatigue += (per * metres) / 1000;
  if (u.fatigue > 1) u.fatigue = 1;
}

export function onFired(sim: Sim, u: Unit, kind: 'musket' | 'roundshot' | 'canister', shots: number): void {
  (sim.ext.lastFired as Float64Array)[u.idx] = sim.t;
  if (sim.features.fatigue) {
    u.fatigue += kind === 'musket' ? F(sim).perVolley : F(sim).perSalvo;
    if (u.fatigue > 1) u.fatigue = 1;
  }
  if (sim.features.ammunition) {
    if (kind === 'musket') {
      // rounds per man of the whole battalion: only the men who fired spend a cartridge
      const men = u.men * sim.data.weapons.musketry.rankAndFileShare;
      u.ammo -= men > 0 ? shots / men : 1;
      if (u.ammo < 0) u.ammo = 0;
      u.roundsFired += 1;
      if (u.ammo < 1 && sim.eventLevel === 'full') emit(sim, { type: 'ammunition', unit: u.id, side: u.side, state: 'cartridges exhausted' });
    } else if (kind === 'canister') {
      u.gunCanister = Math.max(0, u.gunCanister - shots);
      if (u.gunCanister < 1 && sim.eventLevel === 'full') emit(sim, { type: 'ammunition', unit: u.id, side: u.side, state: 'canister exhausted' });
    } else {
      u.gunRounds = Math.max(0, u.gunRounds - shots);
      if (u.gunRounds < 1 && sim.eventLevel === 'full') emit(sim, { type: 'ammunition', unit: u.id, side: u.side, state: 'roundshot exhausted' });
    }
  }
}

export function onFormationChange(sim: Sim, u: Unit): void {
  if (!sim.features.fatigue) return;
  u.fatigue = Math.min(1, u.fatigue + F(sim).formationChange);
}

export function postTick(sim: Sim): void {
  const dt = sim.dt;
  if (sim.features.fatigue) {
    const f = F(sim);
    const last = sim.ext.lastFired as Float64Array;
    for (const u of sim.units) {
      if (u.status === 'gone') continue;
      if (u.melee) u.fatigue = Math.min(1, u.fatigue + f.meleePerSecond * dt);
      else if (!u.moving && u.status === 'ok' && sim.t - last[u.idx] > f.restAfterFire && u.fatigue > 0) u.fatigue = Math.max(0, u.fatigue - f.restPerSecond * dt);
    }
  }
  if (sim.features.ammunition && sim.tick % 5 === 0) {
    const a = A(sim);
    const st = sim.ext.ammo as AmmoState;
    for (const u of sim.units) {
      if (u.arm !== 'inf' || u.status !== 'ok') continue;
      let near = false;
      const row = u.idx * sim.n;
      for (const e of sim.units) {
        if (e.side !== u.side && e.status === 'ok' && sim.gap[row + e.idx] < a.resupplyDistance) {
          near = true;
          break;
        }
      }
      if (near) {
        st.quiet[u.idx] = 0;
        continue;
      }
      st.quiet[u.idx] += 5 * dt;
      const target = st.full[u.idx] * a.resupplyFraction;
      if (st.quiet[u.idx] >= a.resupplyTime && u.ammo < target && st.resupplies[u.idx] < a.maxResupplies) {
        u.ammo = target;
        u.roundsFired = 0; // time to clean barrels and change flints
        st.resupplies[u.idx]++;
        st.quiet[u.idx] = 0;
        emit(sim, { type: 'ammunition', unit: u.id, side: u.side, state: 'resupplied' });
      }
    }
  }
}

export const speedFactor = (sim: Sim, u: Unit): number => (sim.features.fatigue ? 1 - F(sim).speedLoss * u.fatigue : 1);
export const meleeFactor = (sim: Sim, u: Unit): number => (sim.features.fatigue ? 1 - F(sim).meleeLoss * u.fatigue : 1);
export const recoveryFactor = (sim: Sim, u: Unit): number => (sim.features.fatigue ? 1 - F(sim).recoveryLoss * u.fatigue : 1);
export const shockFactor = (sim: Sim, u: Unit): number => (sim.features.fatigue ? 1 + F(sim).shockGain * u.fatigue : 1);
export const tooTiredToCharge = (sim: Sim, u: Unit): boolean => sim.features.fatigue && u.arm === 'cav' && u.fatigue > F(sim).noChargeAbove;

export function reloadFactor(sim: Sim, u: Unit): number {
  let f = 1;
  if (sim.features.fatigue) f *= 1 + F(sim).reloadSlowdown * u.fatigue;
  if (sim.features.ammunition && u.arm === 'inf') f *= 1 + A(sim).foulingSlowdown * fouling(sim, u);
  return f;
}

export function musketFactor(sim: Sim, u: Unit): number {
  if (!sim.features.ammunition) return 1;
  const a = A(sim);
  return u.roundsFired === 0 ? a.firstVolleyBonus : 1 - a.foulingMisfire * fouling(sim, u);
}

export const canFire = (sim: Sim, u: Unit): boolean => !sim.features.ammunition || u.ammo >= 0.5;
export const hasCanister = (sim: Sim, u: Unit): boolean => !sim.features.ammunition || u.gunCanister >= 1;
export const hasRoundshot = (sim: Sim, u: Unit): boolean => !sim.features.ammunition || u.gunRounds >= 1;
/** Infantry with empty pouches has only the bayonet left. */
export const outOfAmmo = (sim: Sim, u: Unit): boolean => sim.features.ammunition && u.arm === 'inf' && u.ammo < 0.5;
