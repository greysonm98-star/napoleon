import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { ENGINE_VERSION, applyOverrides, batchFiles, csv, dataHash, makeJobs, parseAxis, recordRun, runJob, summarisePoint, sweepPoints } from '@napoleon/engine';
import type { Data, Job, JobResult, Override, PointSummary, Replay, RunResult, Scenario, SweepAxis } from '@napoleon/engine';
import { intOpt } from './args.ts';
import { loadData, loadScenario } from './load.ts';

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
  const jobs: Job[] = makeJobs(points, seeds, jobsN);
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
    mkdirSync(out, { recursive: true });
    const files = batchFiles(scenarioPath, scenario, data, axes, fixed, points.map((p) => p.slice(fixed.length)), results, summaries, seeds);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(out, name), text);
    console.log(`wrote ${join(out, 'runs.csv')}, routs.csv, units.csv, summary.csv, summary.json (open the folder in the interface's Results tab)`);
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
