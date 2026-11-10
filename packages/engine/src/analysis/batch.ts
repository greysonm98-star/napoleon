// Batch runs: running a set of seeds at one sweep point, summarising them, and the output files.
// Pure: shared by the command line (worker threads) and the browser (web workers).

import type { Data } from '../data.ts';
import { ENGINE_VERSION } from '../record.ts';
import { checkConservation, dataHash, summarise } from '../result.ts';
import type { RunResult } from '../result.ts';
import type { Scenario } from '../scenario.ts';
import { createSim } from '../sim.ts';
import { runToEnd } from '../record.ts';
import { applyOverrides } from './overrides.ts';
import type { Override, SweepAxis } from './overrides.ts';
import { csv, dist, histogram, wilson } from './stats.ts';
import type { Dist } from './stats.ts';

export interface Job {
  point: number;
  overrides: Override[];
  seeds: number[];
}
export interface JobResult {
  point: number;
  results: RunResult[];
  violations: string[];
}

/** Scenario and data are plain JSON, so a JSON round trip is a faithful deep copy in every runtime. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function runJob(baseData: Data, baseScenario: Scenario, job: Job): JobResult {
  const data = clone(baseData);
  const scenario = clone(baseScenario);
  applyOverrides(data, scenario, job.overrides);
  const results: RunResult[] = [];
  const violations: string[] = [];
  for (const seed of job.seeds) {
    const sim = createSim(scenario, data, seed);
    results.push(runToEnd(sim));
    const bad = checkConservation(sim);
    if (bad.length) violations.push(`seed ${seed}: ${bad[0]}`);
  }
  return { point: job.point, results, violations };
}

/** Split a batch into jobs of a few seeds each, so workers stay evenly loaded. */
export function makeJobs(points: Override[][], seeds: number[], workers: number): Job[] {
  const chunk = Math.max(5, Math.ceil(seeds.length / (workers * 2)));
  const jobs: Job[] = [];
  points.forEach((overrides, point) => {
    for (let i = 0; i < seeds.length; i += chunk) jobs.push({ point, overrides, seeds: seeds.slice(i, i + chunk) });
  });
  return jobs;
}

/** The contents of summary.json. `scenarioSpec` (the scenario before any override) is absent from files written before it was added. */
export interface BatchSummary {
  scenario: string;
  scenarioFile: string;
  engineVersion: string;
  dataHash: string;
  seeds: { first: number; count: number };
  sides?: { id: string; name: string }[];
  fixedOverrides: Override[];
  axes: SweepAxis[];
  points: PointSummary[];
  scenarioSpec?: Scenario;
}

export interface PointSummary {
  point: number;
  params: Record<string, unknown>;
  runs: number;
  wins: Record<string, { n: number; rate: number; lo: number; hi: number }>;
  endReasons: Record<string, number>;
  decidedBy: Record<string, number>;
  durationMin: Dist;
  sides: Record<
    string,
    {
      lossFraction: Dist;
      casualtyFraction: Dist;
      casualties: Dist;
      captured: Dist;
      unitsRouted: Dist;
      brokeRate: number;
      brokeAtMin: Dist;
      breakX: Dist;
      breakY: Dist;
      lossHistogram: number[];
      topRootCauses: [string, number][];
      firstToBreak: [string, number][];
    }
  >;
}

export function summarisePoint(point: number, params: Record<string, unknown>, rs: RunResult[]): PointSummary {
  const n = rs.length;
  const ids = rs[0].sides.map((s) => s.id);
  const wins: PointSummary['wins'] = {};
  for (const id of [...ids, 'draw']) {
    const k = rs.filter((r) => r.winner === id).length;
    const [lo, hi] = wilson(k, n);
    wins[id] = { n: k, rate: k / n, lo, hi };
  }
  const endReasons: Record<string, number> = {};
  for (const r of rs) endReasons[r.endReason] = (endReasons[r.endReason] ?? 0) + 1;
  const decidedBy: Record<string, number> = {};
  for (const r of rs) decidedBy[r.decidedBy] = (decidedBy[r.decidedBy] ?? 0) + 1;
  const sides: PointSummary['sides'] = {};
  ids.forEach((id, i) => {
    const ss = rs.map((r) => r.sides[i]);
    const broke = ss.filter((s) => s.broke);
    const count = (items: string[]): [string, number][] => {
      const m = new Map<string, number>();
      for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
      return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 6);
    };
    const routs = rs.flatMap((r) => r.routs.filter((x) => x.side === id && x.kind !== 'army_broken'));
    const firsts = rs.map((r) => r.routs.find((x) => x.side === id && x.kind !== 'army_broken')?.name).filter((x): x is string => !!x);
    sides[id] = {
      lossFraction: dist(ss.map((s) => s.lossFraction)),
      casualtyFraction: dist(ss.map((s) => s.casualtyFraction)),
      casualties: dist(ss.map((s) => s.casualties)),
      captured: dist(ss.map((s) => s.captured)),
      unitsRouted: dist(ss.map((s) => s.unitsEverRouted)),
      brokeRate: broke.length / n,
      brokeAtMin: dist(broke.map((s) => s.brokeAt! / 60)),
      breakX: dist(broke.map((s) => s.breakX!).filter((v) => v !== null)),
      breakY: dist(broke.map((s) => s.breakY!).filter((v) => v !== null)),
      lossHistogram: histogram(ss.map((s) => s.lossFraction), 0, 1, 10),
      topRootCauses: count(routs.map((x) => x.rootCause || '(none)')),
      firstToBreak: count(firsts),
    };
  });
  return { point, params, runs: n, wins, endReasons, decidedBy, durationMin: dist(rs.map((r) => r.duration / 60)), sides };
}

/** Everything a batch run produces, as file name -> contents. The command line writes these to disk; the browser offers them for download. */
export function batchFiles(scenarioFile: string, scenario: Scenario, data: Data, axes: SweepAxis[], fixed: Override[], points: Override[][], results: RunResult[][], summaries: PointSummary[], seeds: number[]): Record<string, string> {
  const ids = scenario.sides.map((s) => s.id);
  const axisCols = axes.map((a) => `${a.scope}:${a.path}`);
  const sideCols = ['men_start', 'killed_wounded', 'prisoners', 'dispersed', 'loss_fraction', 'kw_fraction', 'units', 'units_routed', 'units_gone', 'units_formed_end', 'rallies', 'broke', 'broke_at_s', 'break_x', 'break_y', 'break_centroid_x', 'break_centroid_y', 'tip_unit'];
  const runRows: unknown[][] = [['point', ...axisCols, 'seed', 'winner', 'decided_by', 'end_reason', 'duration_s', ...ids.flatMap((id) => sideCols.map((c) => `${id}_${c}`)), 'first_rout_s', 'first_rout_unit', 'first_rout_cause', 'state_hash']];
  const routRows: unknown[][] = [['point', ...axisCols, 'seed', 't_s', 'side', 'unit', 'name', 'x', 'y', 'kind', 'top_cause', 'trigger', 'root_cause', 'root_unit']];
  const unitRows: unknown[][] = [['point', ...axisCols, 'seed', 'side', 'unit', 'name', 'formation', 'arm', 'men_start', 'men_end', 'killed_wounded', 'prisoners', 'dispersed', 'status', 'ever_routed', 'rallies']];
  results.forEach((rs, p) => {
    const vals = points[p].map((o) => o.value);
    for (const r of rs) {
      for (const u of r.units) unitRows.push([p, ...vals, r.seed, u.side, u.id, u.name, u.formation, u.arm, u.startMen, u.men, u.casualties, u.captured, u.dispersed, u.status, u.everRouted ? 1 : 0, u.rallies]);
      const first = r.routs.find((x) => x.kind !== 'army_broken');
      runRows.push([p, ...vals, r.seed, r.winner, r.decidedBy, r.endReason, r.duration, ...r.sides.flatMap((s) => [s.startMen, s.casualties, s.captured, s.dispersed, s.lossFraction, s.casualtyFraction, s.units, s.unitsEverRouted, s.unitsGone, s.unitsFormedAtEnd, s.rallies, s.broke ? 1 : 0, s.brokeAt, s.breakX, s.breakY, s.breakCentroidX, s.breakCentroidY, s.tipUnit]), first?.t, first?.unit, first?.rootCause, r.stateHash]);
      for (const x of r.routs) routRows.push([p, ...vals, r.seed, x.t, x.side, x.unit, x.name, x.x, x.y, x.kind, x.topCause, x.trigger, x.rootCause, x.rootUnit]);
    }
  });
  const distCols = (name: string) => ['mean', 'sd', 'p10', 'median', 'p90'].map((k) => `${name}_${k}`);
  const distVals = (d: Dist) => [d.mean, d.sd, d.p10, d.median, d.p90];
  const sumRows: unknown[][] = [['point', ...axisCols, 'runs', ...[...ids, 'draw'].flatMap((id) => [`win_${id}`, `win_${id}_lo95`, `win_${id}_hi95`]), ...distCols('duration_min'), ...ids.flatMap((id) => [...distCols(`${id}_loss_fraction`), ...distCols(`${id}_kw_fraction`), `${id}_broke_rate`, ...distCols(`${id}_broke_at_min`), `${id}_break_x_mean`, `${id}_break_y_mean`, `${id}_break_x_sd`, `${id}_break_y_sd`])]];
  for (const s of summaries) {
    sumRows.push([s.point, ...points[s.point].map((o) => o.value), s.runs, ...[...ids, 'draw'].flatMap((id) => [s.wins[id].rate, s.wins[id].lo, s.wins[id].hi]), ...distVals(s.durationMin), ...ids.flatMap((id) => { const d = s.sides[id]; return [...distVals(d.lossFraction), ...distVals(d.casualtyFraction), d.brokeRate, ...distVals(d.brokeAtMin), d.breakX.mean, d.breakY.mean, d.breakX.sd, d.breakY.sd]; })]);
  }
  const summary: BatchSummary = {
    scenario: scenario.name,
    scenarioFile,
    engineVersion: ENGINE_VERSION,
    dataHash: dataHash(data),
    seeds: { first: seeds[0], count: seeds.length },
    sides: scenario.sides.map((s) => ({ id: s.id, name: s.name })),
    fixedOverrides: fixed,
    axes,
    points: summaries,
    scenarioSpec: scenario,
  };
  return {
    'runs.csv': csv(runRows),
    'routs.csv': csv(routRows),
    'units.csv': csv(unitRows),
    'summary.csv': csv(sumRows),
    'summary.json': JSON.stringify(summary, null, 2),
  };
}

