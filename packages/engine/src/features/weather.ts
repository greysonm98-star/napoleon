// Weather and ground (MODEL 12.7). Reads scenario.weather; inert unless features.weatherGround is on.

import type { Sim, Unit } from '../types.ts';

interface Sky {
  musket: number;
  sight: number;
  smokeDecay: number;
}
interface Ground {
  infantry: number;
  cavalry: number;
  artillery: number;
  roundshot: number;
  fatigue: number;
}
interface WeatherData {
  sky: Record<string, Sky>;
  ground: Record<string, Ground>;
}

export function init(sim: Sim): void {
  const w = sim.data.weather as WeatherData | undefined;
  if (!w) throw new Error("weather is on but data file 'weather.json' is missing");
  const sc = sim.scenario.weather ?? { sky: 'clear', ground: 'firm', windFrom: 270, windSpeed: 0 };
  if (!w.sky[sc.sky]) throw new Error(`unknown sky '${sc.sky}'`);
  if (!w.ground[sc.ground]) throw new Error(`unknown ground '${sc.ground}'`);
  sim.ext.weather = { sky: w.sky[sc.sky], ground: w.ground[sc.ground] };
}

const st = (sim: Sim): { sky: Sky; ground: Ground } => sim.ext.weather as { sky: Sky; ground: Ground };
const on = (sim: Sim): boolean => sim.features.weatherGround;

export const speedFactor = (sim: Sim, u: Unit): number => (on(sim) ? (u.arm === 'inf' ? st(sim).ground.infantry : u.arm === 'cav' ? st(sim).ground.cavalry : st(sim).ground.artillery) : 1);
export const courierFactor = (sim: Sim): number => (on(sim) ? st(sim).ground.cavalry : 1);
export const musketFactor = (sim: Sim): number => (on(sim) ? st(sim).sky.musket : 1);
export const roundshotFactor = (sim: Sim): number => (on(sim) ? st(sim).ground.roundshot : 1);
export const fatigueFactor = (sim: Sim): number => (on(sim) ? st(sim).ground.fatigue : 1);
export const smokeDecayFactor = (sim: Sim): number => (on(sim) ? st(sim).sky.smokeDecay : 1);
export function inSight(sim: Sim, a: Unit, b: Unit): boolean {
  if (!on(sim)) return true;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const s = st(sim).sky.sight;
  return dx * dx + dy * dy <= s * s;
}
