import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConservation, createSim, resolveData, step } from '../src/index.ts';
import type { Data, Formation, Posture, RawData, Scenario, ScenarioUnit, Sim, Unit } from '../src/index.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function rawData(): RawData {
  const dir = join(ROOT, 'data');
  const raw: RawData = {};
  for (const f of readdirSync(dir).sort()) if (f.endsWith('.json')) raw[f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return raw;
}
/** A fresh copy each call, so tests may alter coefficients freely. */
export const freshData = (): Data => resolveData(rawData()).data;
export const loadScenario = (name: string): Scenario => JSON.parse(readFileSync(join(ROOT, 'scenarios', name + '.json'), 'utf8'));

export interface SideSpec {
  posture?: Posture;
  units: (Partial<ScenarioUnit> & { type: string; at: [number, number] })[];
}

/** A flat, empty 2 km field. Side 0 ("blue") faces north from the south; side 1 ("red") faces south. */
export function field(blue: SideSpec, red: SideSpec, extra: Partial<Scenario> = {}): Scenario {
  const mk = (s: SideSpec, id: string) => s.units.map((u, i) => ({ id: `${id}${i + 1}`, ...u }) as ScenarioUnit);
  return {
    format: 'napsim-scenario',
    version: 1,
    name: 'test field',
    map: { width: 2000, height: 2000, cellSize: 50 },
    timeLimit: 3600,
    sides: [
      { id: 'blue', name: 'Blue', posture: blue.posture ?? 'defend', rear: [0, 1], units: mk(blue, 'b') },
      { id: 'red', name: 'Red', posture: red.posture ?? 'defend', rear: [0, -1], units: mk(red, 'r') },
    ],
    ...extra,
  };
}

export const unit = (sim: Sim, id: string): Unit => sim.byId.get(id)!;

/** Take a unit out of the AI's hands and fix its formation without the drill delay. */
export function hold(sim: Sim, id: string, form?: Formation): Unit {
  const u = unit(sim, id);
  u.manual = true;
  u.order = null;
  if (form) u.form = form;
  return u;
}
export function attack(sim: Sim, id: string, target: string, charge = true): Unit {
  const u = unit(sim, id);
  u.manual = true;
  u.order = { type: 'attack', target: unit(sim, target).idx, x: 0, y: 0, charge };
  return u;
}

export function run(sim: Sim, seconds: number, each?: (sim: Sim) => void): void {
  const end = sim.t + seconds;
  while (!sim.ended && sim.t < end) {
    step(sim);
    each?.(sim);
  }
}

export function assertConserved(sim: Sim): void {
  const errs = checkConservation(sim);
  if (errs.length) throw new Error(`t=${sim.t}: ` + errs.join('; '));
}

/** Fraction of seeds for which the predicate holds. */
export function rate(seeds: number, fn: (seed: number) => boolean): number {
  let k = 0;
  for (let s = 1; s <= seeds; s++) if (fn(s)) k++;
  return k / seeds;
}
export const mean = (seeds: number, fn: (seed: number) => number): number => {
  let t = 0;
  for (let s = 1; s <= seeds; s++) t += fn(s);
  return t / seeds;
};
export { createSim };
