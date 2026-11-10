import { parentPort, workerData } from 'node:worker_threads';
import { runJob } from '@napoleon/engine';
import type { Data, Job, Scenario } from '@napoleon/engine';

export { runJob };
export type { Job, JobResult } from '@napoleon/engine';

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
