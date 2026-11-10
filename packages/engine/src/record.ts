// Replay recording. A replay stores sampled state and the full event log, so it can be viewed
// without re-running the engine, plus the scenario, seed and inputs so it can be re-run and verified.

import type { Data } from './data.ts';
import { dataHash, summarise } from './result.ts';
import type { RunResult } from './result.ts';
import type { Scenario } from './scenario.ts';
import { createSim, execInput, step } from './sim.ts';
import type { Sim, SimEvent, SimInput } from './types.ts';

export const ENGINE_VERSION = '0.1.0';

export interface ReplayUnit {
  id: string;
  name: string;
  side: number;
  type: string;
  arm: string;
  quality: string;
  startMen: number;
  parent: string | null;
}

export interface ReplayTrack {
  x: number[];
  y: number[];
  f: number[];
  w: number[];
  d: number[];
  men: number[];
  morale: number[];
  /** One character per sample: L line, C column, S square, - none. */
  form: string;
  /** One character per sample: o formed, r routed, g gone. */
  status: string;
  /** Bit flags per sample: 1 forming, 2 melee, 4 blown, 8 moving, 16 charging. */
  flags: number[];
  fatigue?: number[];
  ammo?: number[];
}

export interface ReplayCommander {
  id: string;
  name: string;
  side: number;
  level: string;
  radius: number;
  parent: string | null;
  x: number[];
  y: number[];
  /** One character per sample: a alive, d down. */
  alive: string;
}

export interface Replay {
  format: 'napsim-replay';
  version: 1;
  engineVersion: string;
  dataHash: string;
  seed: number;
  scenario: Scenario;
  inputs: SimInput[];
  /** Coefficient changes applied on top of the data files for this run (from --set), so it can be re-run. */
  dataOverrides?: { path: string; value: unknown }[];
  sampleInterval: number;
  /** Simulation time of each sample, seconds. Every per-sample array below is aligned with this. */
  times: number[];
  units: ReplayUnit[];
  tracks: Record<string, ReplayTrack>;
  /** Present when command and control is on. */
  commanders?: ReplayCommander[];
  /** Per sample: flat list of x, y, side for each courier on the road. */
  couriers?: number[][];
  /** Present when smoke is on. One frame every `every` samples; each frame is rows x cols digits 0-9 (density x 9), row by row. */
  smoke?: { cell: number; cols: number; rows: number; every: number; frames: string[] };
  events: SimEvent[];
  result: RunResult;
}

export interface Recorder {
  sample(sim: Sim): void;
  finish(sim: Sim): Replay;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function createRecorder(sim: Sim, sampleInterval = 5): Recorder {
  const times: number[] = [];
  const tracks: Record<string, ReplayTrack> = {};
  const fat = sim.features.fatigue;
  const amm = sim.features.ammunition;
  for (const u of sim.units) {
    tracks[u.id] = { x: [], y: [], f: [], w: [], d: [], men: [], morale: [], form: '', status: '', flags: [] };
    if (fat) tracks[u.id].fatigue = [];
    if (amm) tracks[u.id].ammo = [];
  }
  const extras = (sim.ext.recorders as { sample?: (sim: Sim) => void; finish?: (r: Replay) => void }[] | undefined) ?? [];
  const sample = (s: Sim) => {
    times.push(s.t);
    for (const u of s.units) {
      const t = tracks[u.id];
      t.x.push(r1(u.x));
      t.y.push(r1(u.y));
      t.f.push(Math.round(u.f * 1000) / 1000);
      t.w.push(r1(u.w));
      t.d.push(r1(u.d));
      t.men.push(u.men);
      t.morale.push(r1(u.morale));
      t.form += u.form === 'line' ? 'L' : u.form === 'column' ? 'C' : u.form === 'square' ? 'S' : '-';
      t.status += u.status === 'ok' ? 'o' : u.status === 'rout' ? 'r' : 'g';
      t.flags.push((u.formT > 0 ? 1 : 0) | (u.melee ? 2 : 0) | (u.blown > 0 ? 4 : 0) | (u.moving ? 8 : 0) | (u.charging ? 16 : 0));
      if (t.fatigue) t.fatigue.push(Math.round(u.fatigue * 100) / 100);
      if (t.ammo) t.ammo.push(Math.round(u.arm === 'art' ? u.gunRounds + u.gunCanister : u.ammo));
    }
    for (const x of extras) x.sample?.(s);
  };
  sample(sim);
  return {
    sample(s: Sim) {
      if (s.tick % sampleInterval === 0 || s.ended) sample(s);
    },
    finish(s: Sim): Replay {
      const rep: Replay = {
        format: 'napsim-replay',
        version: 1,
        engineVersion: ENGINE_VERSION,
        dataHash: dataHash(s.data),
        seed: s.seed,
        scenario: s.scenario,
        inputs: s.inputs,
        sampleInterval,
        times,
        units: s.units.map((u) => ({ id: u.id, name: u.name, side: u.side, type: u.typeId, arm: u.arm, quality: u.quality, startMen: u.startMen, parent: u.parent })),
        tracks,
        events: s.events,
        result: summarise(s),
      };
      for (const x of extras) x.finish?.(rep);
      return rep;
    },
  };
}

export interface RunOptions {
  inputs?: SimInput[];
  onTick?: (sim: Sim) => void;
}

/** Run a prepared sim to its end, feeding any recorded inputs at the times they were given. */
export function runToEnd(sim: Sim, opts: RunOptions = {}): RunResult {
  const inputs = (opts.inputs ?? []).slice().sort((a, b) => a.t - b.t);
  let k = 0;
  while (!sim.ended) {
    while (k < inputs.length && inputs[k].t <= sim.t) {
      sim.inputs.push(inputs[k]);
      execInput(sim, inputs[k++]);
    }
    step(sim);
    opts.onTick?.(sim);
  }
  return summarise(sim);
}

export function runScenario(scenario: Scenario, data: Data, seed: number, opts: RunOptions = {}): RunResult {
  return runToEnd(createSim(scenario, data, seed), opts);
}

export function recordRun(scenario: Scenario, data: Data, seed: number, opts: RunOptions & { sampleInterval?: number } = {}): Replay {
  const sim = createSim(scenario, data, seed, { events: 'full' });
  const rec = createRecorder(sim, opts.sampleInterval ?? 5);
  runToEnd(sim, { inputs: opts.inputs, onTick: (s) => rec.sample(s) });
  return rec.finish(sim);
}
