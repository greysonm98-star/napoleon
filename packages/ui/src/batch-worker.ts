// A web worker that runs batch jobs with the same engine code the command line uses.
// First message: { init: { data, scenario } }. Then one Job per message; replies with the JobResult.
import { runJob } from '@napoleon/engine';
import type { Data, Job, Scenario } from '@napoleon/engine';

const scope = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null };
let data: Data | null = null;
let scenario: Scenario | null = null;

scope.onmessage = (e: MessageEvent) => {
  const m = e.data as { init?: { data: Data; scenario: Scenario } } & Partial<Job>;
  if (m.init) {
    data = m.init.data;
    scenario = m.init.scenario;
    return;
  }
  try {
    if (!data || !scenario) throw new Error('worker not initialised');
    scope.postMessage(runJob(data, scenario, m as Job));
  } catch (err) {
    scope.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
