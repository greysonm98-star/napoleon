import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveData } from '@napoleon/engine';
import type { RawData, ResolvedData, Scenario } from '@napoleon/engine';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export function loadRawData(dir = join(ROOT, 'data')): RawData {
  const raw: RawData = {};
  for (const f of readdirSync(dir).sort()) {
    if (f.endsWith('.json')) raw[f.slice(0, -5)] = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  }
  return raw;
}

export function loadData(dir?: string): ResolvedData {
  return resolveData(loadRawData(dir));
}

export function loadScenario(path: string): Scenario {
  return JSON.parse(readFileSync(path, 'utf8')) as Scenario;
}
