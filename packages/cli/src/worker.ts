import { parentPort, workerData } from 'node:worker_threads';
import { checkConservation, createSim, runToEnd } from '@napoleon/engine';
import type { Data, RunResult, Scenario } from '@napoleon/engine';
import { applyOverrides } from './overrides.ts';
import type { Override } from './overrides.ts';

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

export function runJob(baseData: Data, baseScenario: Scenario, job: Job): JobResult {
  const data = structuredClone(baseData);
  const scenario = structuredClone(baseScenario);
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

if (parentPort) {
  const { data, scenario } = workerData as { data: Data; scenario: Scenario };
  parentPort.on('message', (job: Job | null) => {
    if (job === null) process.exit(0);
    try {
      parentPort!.postMessage(runJob(data, scenario, job));
    } catch (e) {
      parentPort!.postMessage({ error: e instanceof Error ? e.message : String(e) });
    }
  });
}
