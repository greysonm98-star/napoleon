// Parameter overrides for --set and --param (and the browser's batch runner): "data:morale.rippleFriend=4,7,10" or
// "scenario:sides.french.deploy.cav=0..8..2". Array elements may be addressed by index or by id.

import type { Data } from '../data.ts';
import type { Scenario } from '../scenario.ts';

export interface Override {
  scope: 'data' | 'scenario';
  path: string;
  value: unknown;
}
export interface SweepAxis {
  scope: 'data' | 'scenario';
  path: string;
  values: unknown[];
  label: string;
}

function parseValue(s: string): unknown {
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  return s !== '' && n === n ? n : s;
}

export function parseAxis(spec: string): SweepAxis {
  const eq = spec.indexOf('=');
  if (eq < 0) throw new Error(`bad parameter '${spec}': expected scope:path=values`);
  const lhs = spec.slice(0, eq);
  const rhs = spec.slice(eq + 1);
  const colon = lhs.indexOf(':');
  const scope = lhs.slice(0, colon);
  if (scope !== 'data' && scope !== 'scenario') throw new Error(`bad parameter '${spec}': scope must be data: or scenario:`);
  const path = lhs.slice(colon + 1);
  let values: unknown[];
  const NUM = '-?\\d+(?:\\.\\d+)?';
  const range = new RegExp(`^(${NUM})\\.\\.(${NUM})(?:\\.\\.(${NUM}))?$`).exec(rhs);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    const st = range[3] ? Number(range[3]) : 1;
    if (!(st > 0)) throw new Error(`bad range step in '${spec}'`);
    values = [];
    for (let i = 0; a + i * st <= b + 1e-9; i++) values.push(Math.round((a + i * st) * 1e9) / 1e9);
  } else values = rhs.split(',').map(parseValue);
  if (!values.length || rhs === '') throw new Error(`parameter '${spec}' has no values`);
  return { scope, path, values, label: path.split('.').slice(-2).join('.') };
}

function walkTo(root: unknown, path: string): { parent: Record<string, unknown>; key: string } {
  const parts = path.split('.');
  let node = root as Record<string, unknown>;
  const stepInto = (n: Record<string, unknown>, p: string): unknown => {
    if (Array.isArray(n)) {
      if (/^\d+$/.test(p)) return n[Number(p)];
      return (n as Record<string, unknown>[]).find((e) => e && e.id === p);
    }
    return n[p];
  };
  for (let i = 0; i < parts.length - 1; i++) {
    const next = stepInto(node, parts[i]);
    if (next === undefined || next === null || typeof next !== 'object') throw new Error(`path '${path}': '${parts[i]}' not found${typeof next === 'number' ? ' (it is a number; data paths end at the parameter name, without .value)' : ''}`);
    node = next as Record<string, unknown>;
  }
  return { parent: node, key: parts[parts.length - 1] };
}

/** Scenario fields that may legitimately be absent from a file and so may be created by an override. */
const OPTIONAL_SCENARIO_KEYS = new Set(['description', 'stallLimit', 'objective', 'weather', 'features', 'baseElevation', 'spacing', 'rowDepth', 'gunForward', 'cavWing', 'cavBack', 'cavTier', 'men', 'quality', 'formation', 'facing', 'skirmishers', 'name', 'radius', 'initiative', 'staffDelay', 'at', 'commandControl', 'fatigue', 'ammunition', 'skirmishers', 'elevationLos', 'smoke', 'weatherGround']);

export function applyOverrides(data: Data, scenario: Scenario, overrides: Override[]): void {
  for (const o of overrides) {
    const root = o.scope === 'data' ? data : scenario;
    const { parent, key } = walkTo(root, o.path);
    if (o.scope === 'data') {
      if (!(key in parent)) throw new Error(`data path '${o.path}' not found`);
      if (typeof parent[key] !== typeof o.value) throw new Error(`data path '${o.path}' is a ${typeof parent[key]}, not a ${typeof o.value}`);
    } else if (!(key in parent) && !OPTIONAL_SCENARIO_KEYS.has(key)) {
      // a mistyped key would otherwise be created and silently change nothing
      throw new Error(`scenario path '${o.path}': '${key}' not found. Existing keys here: ${Object.keys(parent).join(', ')}`);
    }
    if (Array.isArray(parent) && !/^\d+$/.test(key)) throw new Error(`scenario path '${o.path}': cannot set an array element by id`);
    parent[key] = o.value;
  }
}

/** Cartesian product of the axes. */
export function sweepPoints(axes: SweepAxis[]): Override[][] {
  let points: Override[][] = [[]];
  for (const ax of axes) {
    const next: Override[][] = [];
    for (const p of points) for (const v of ax.values) next.push([...p, { scope: ax.scope, path: ax.path, value: v }]);
    points = next;
  }
  return points;
}
