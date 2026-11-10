import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ENGINE_VERSION, dataHash, recordRun } from '@napoleon/engine';
import type { Data, Replay, RunResult, Scenario } from '@napoleon/engine';
import { intOpt } from './args.ts';
import { loadData, loadScenario } from './load.ts';
import { applyOverrides, parseAxis, sweepPoints } from './overrides.ts';
import type { Override, SweepAxis } from './overrides.ts';
import { csv, dist, histogram, wilson } from './stats.ts';
import type { Dist } from './stats.ts';
import { runJob } from './worker.ts';
import type { Job, JobResult } from './worker.ts';

type Opt = Record<string, string[]>;

async function runJobs(data: Data, scenario: Scenario, jobs: Job[], nWorkers: number, onDone: (r: JobResult) => void): Promise<void> {
  if (nWorkers <= 1 || jobs.length === 1) {
    for (const j of jobs) onDone(runJob(data, scenario, j));
    return;
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(nWorkers, jobs.length) }, () =>
      new Promise<void>((resolve, reject) => {
        const w = new Worker(new URL('./worker.ts', import.meta.url), { workerData: { data, scenario } });
        const feed = () => {
          if (next < jobs.length) w.postMessage(jobs[next++]);
          else {
            w.postMessage(null);
            resolve();
          }
        };
        w.on('message', (m: JobResult & { error?: string }) => {
          if (m.error) return reject(new Error(m.error));
          onDone(m);
          feed();
        });
        w.on('error', reject);
        feed();
      }),
    ),
  );
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

function summarisePoint(point: number, params: Record<string, unknown>, rs: RunResult[]): PointSummary {
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

const pct = (v: number) => (v === v ? (v * 100).toFixed(0) + '%' : '-');
const f1 = (v: number) => (v === v ? v.toFixed(1) : '-');

function printSummary(s: PointSummary, axes: SweepAxis[]): void {
  const ids = Object.keys(s.sides);
  const head = axes.length ? axes.map((a) => `${a.label}=${s.params[a.path]}`).join(' ') + '  ' : '';
  const w = ids.map((id) => `${id} ${pct(s.wins[id].rate)} [${pct(s.wins[id].lo)}-${pct(s.wins[id].hi)}]`).join('  ');
  console.log(`${head}wins: ${w}  none ${pct(s.wins.draw.rate)}   duration ${f1(s.durationMin.median)} min (p10 ${f1(s.durationMin.p10)}, p90 ${f1(s.durationMin.p90)})`);
  for (const id of ids) {
    const d = s.sides[id];
    console.log(`    ${id.padEnd(8)} loss ${pct(d.lossFraction.median)} (p10 ${pct(d.lossFraction.p10)}, p90 ${pct(d.lossFraction.p90)})  K/W ${pct(d.casualtyFraction.median)}  broke ${pct(d.brokeRate)}${d.brokeRate > 0 ? ` at ${f1(d.brokeAtMin.median)} min near (${f1(d.breakX.mean)}, ${f1(d.breakY.mean)})` : ''}`);
  }
}

function writeOutputs(outDir: string, scenarioPath: string, scenario: Scenario, data: Data, axes: SweepAxis[], fixed: Override[], points: Override[][], results: RunResult[][], summaries: PointSummary[], seeds: number[]): void {
  mkdirSync(outDir, { recursive: true });
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
  writeFileSync(join(outDir, 'runs.csv'), csv(runRows));
  writeFileSync(join(outDir, 'routs.csv'), csv(routRows));
  writeFileSync(join(outDir, 'units.csv'), csv(unitRows));
  writeFileSync(join(outDir, 'summary.csv'), csv(sumRows));
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ scenario: scenario.name, scenarioFile: scenarioPath, engineVersion: ENGINE_VERSION, dataHash: dataHash(data), seeds: { first: seeds[0], count: seeds.length }, fixedOverrides: fixed, axes, points: summaries }, null, 2));
}

async function cmdBatch(pos: string[], opt: Opt, sweep: boolean): Promise<void> {
  const scenarioPath = pos[0];
  if (!scenarioPath) throw new Error(`usage: napsim ${sweep ? 'sweep' : 'batch'} <scenario.json> ${sweep ? '--param scope:path=values ' : ''}[--runs N] [--seed0 N] [--out dir] [--jobs N] [--set scope:path=value]`);
  const { data } = loadData(opt.data?.[0]);
  const scenario = loadScenario(scenarioPath);
  const runs = intOpt(opt, 'runs', 200, 1);
  const seed0 = intOpt(opt, 'seed0', 1, -2147483648);
  const jobsN = intOpt(opt, 'jobs', Math.max(1, availableParallelism() - 1), 1);
  const fixed: Override[] = (opt.set ?? []).map((s) => {
    const a = parseAxis(s);
    if (a.values.length !== 1) throw new Error(`--set takes one value: ${s}`);
    return { scope: a.scope, path: a.path, value: a.values[0] };
  });
  const axes = sweep ? (opt.param ?? []).map(parseAxis) : [];
  if (sweep && !axes.length) throw new Error('sweep needs at least one --param');
  const points = sweepPoints(axes).map((p) => [...fixed, ...p]);
  // fail early on a bad path
  for (const p of points) applyOverrides(structuredClone(data), structuredClone(scenario), p);
  const seeds = Array.from({ length: runs }, (_, i) => seed0 + i);
  const chunk = Math.max(5, Math.ceil(runs / (jobsN * 2)));
  const jobs: Job[] = [];
  points.forEach((overrides, point) => {
    for (let i = 0; i < seeds.length; i += chunk) jobs.push({ point, overrides, seeds: seeds.slice(i, i + chunk) });
  });
  const results: RunResult[][] = points.map(() => []);
  const violations: string[] = [];
  const t0 = performance.now();
  let done = 0;
  await runJobs(data, scenario, jobs, jobsN, (r) => {
    results[r.point].push(...r.results);
    violations.push(...r.violations);
    done += r.results.length;
    if (process.stderr.isTTY) process.stderr.write(`\r${done}/${points.length * runs} runs`);
  });
  if (process.stderr.isTTY) process.stderr.write('\r');
  for (const rs of results) rs.sort((a, b) => a.seed - b.seed);
  const summaries = results.map((rs, p) => summarisePoint(p, Object.fromEntries(points[p].slice(fixed.length).map((o) => [o.path, o.value])), rs));
  console.log(`${scenario.name}: ${points.length} point${points.length > 1 ? 's' : ''} x ${runs} runs, seeds ${seed0}-${seed0 + runs - 1}, ${((performance.now() - t0) / 1000).toFixed(1)} s on ${Math.min(jobsN, jobs.length)} worker${jobsN > 1 ? 's' : ''}`);
  if (fixed.length) console.log('fixed: ' + fixed.map((o) => `${o.scope}:${o.path}=${o.value}`).join(' '));
  for (const s of summaries) printSummary(s, axes);
  if (!sweep) {
    const s = summaries[0];
    for (const id of Object.keys(s.sides)) {
      const d = s.sides[id];
      if (d.topRootCauses.length) console.log(`    ${id} routs by root cause: ${d.topRootCauses.map(([c, n]) => `${c} ${n}`).join(', ')}`);
      if (d.firstToBreak.length) console.log(`    ${id} first to break: ${d.firstToBreak.map(([c, n]) => `${c} ${n}`).join(', ')}`);
    }
    console.log('    end reasons: ' + Object.entries(s.endReasons).map(([k, v]) => `${k} ${v}`).join(', ') + '; decided by: ' + Object.entries(s.decidedBy).map(([k, v]) => `${k} ${v}`).join(', '));
  }
  if (violations.length) {
    console.error(`CONSERVATION VIOLATED in ${violations.length} runs, e.g. ${violations[0]}`);
    process.exitCode = 2;
  }
  const out = opt.out?.[0];
  if (out) {
    writeOutputs(out, scenarioPath, scenario, data, axes, fixed, points.map((p) => p.slice(fixed.length)), results, summaries, seeds);
    console.log(`wrote ${join(out, 'runs.csv')}, routs.csv, units.csv, summary.csv, summary.json`);
  }
}

function cmdParams(opt: Opt): void {
  const { params } = loadData(opt.data?.[0]);
  const want = opt.confidence?.[0];
  const rows = params.filter((p) => !want || p.confidence === want);
  if (opt.csv || opt.out) {
    const text = csv([['path', 'value', 'unit', 'confidence', 'source', 'note'], ...rows.map((p) => [p.path, p.value, p.unit, p.confidence, p.source, p.note])]);
    // --out writes UTF-8 directly; redirecting stdout in Windows PowerShell would re-encode it
    if (opt.out) writeFileSync(opt.out[0], text);
    else process.stdout.write(text);
    return;
  }
  for (const p of rows) console.log(`${p.path.padEnd(52)} ${String(p.value).slice(0, 28).padEnd(28)} ${p.unit.slice(0, 26).padEnd(26)} ${p.confidence.padEnd(10)} ${p.source}`);
  const counts: Record<string, number> = {};
  for (const p of params) counts[p.confidence] = (counts[p.confidence] ?? 0) + 1;
  console.log(`\n${params.length} parameters: ` + Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', '));
}

function cmdVerify(pos: string[], opt: Opt): void {
  if (!pos[0]) throw new Error('usage: napsim verify <replay.json>');
  const rep = JSON.parse(readFileSync(pos[0], 'utf8')) as Replay;
  const { data } = loadData(opt.data?.[0]);
  const baseHash = dataHash(data);
  applyOverrides(data, structuredClone(rep.scenario), (rep.dataOverrides ?? []).map((o) => ({ scope: 'data' as const, path: o.path, value: o.value })));
  const now = recordRun(rep.scenario, data, rep.seed, { inputs: rep.inputs, sampleInterval: rep.sampleInterval });
  const sameData = dataHash(data) === rep.dataHash;
  // every recorded part is compared, not only the final state: a replay with edited tracks or events must not pass
  const parts: [string, unknown, unknown][] = [
    ['final state', rep.result?.stateHash, now.result.stateHash],
    ['result', rep.result, now.result],
    ['sample times', rep.times, now.times],
    ['unit tracks', rep.tracks, now.tracks],
    ['events', rep.events, now.events],
  ];
  const differing = parts.filter(([, a, b]) => JSON.stringify(a) !== JSON.stringify(b)).map(([name]) => name);
  console.log(`replay: seed ${rep.seed}, engine ${rep.engineVersion}, data ${rep.dataHash}, state ${rep.result?.stateHash}${rep.dataOverrides?.length ? `, ${rep.dataOverrides.length} coefficient override(s)` : ''}`);
  console.log(`re-run: engine ${ENGINE_VERSION}, data ${dataHash(data)}${rep.dataOverrides?.length ? ` (files ${baseHash})` : ''}, state ${now.result.stateHash}`);
  if (!differing.length) console.log('MATCH: result, tracks and events all reproduce exactly.');
  else if (!sameData) console.log(`MISMATCH (${differing.join(', ')}): the data files differ from those the replay was recorded with.`);
  else if (!rep.result?.endReason) console.log(`MISMATCH (${differing.join(', ')}): this replay was saved before the run had ended, so it cannot be compared with a full run.`);
  else if (differing.includes('final state')) console.log(`MISMATCH (${differing.join(', ')}) with identical data: the engine or the embedded scenario has changed since this was recorded.`);
  else console.log(`MISMATCH (${differing.join(', ')}): the run reproduces, but the file's contents have been altered.`);
  if (differing.length) process.exitCode = 3;
}

export async function dispatch(cmd: string, pos: string[], opt: Opt): Promise<void> {
  if (cmd === 'batch') await cmdBatch(pos, opt, false);
  else if (cmd === 'sweep') await cmdBatch(pos, opt, true);
  else if (cmd === 'params') cmdParams(opt);
  else if (cmd === 'verify') cmdVerify(pos, opt);
}
