import { hashString } from './math.ts';
import type { EndReason, Sim } from './types.ts';

export interface SideResult {
  id: string;
  name: string;
  posture: string;
  units: number;
  startMen: number;
  /** Men still in formed units at the end. */
  formedMen: number;
  /** Men in units that are routed but still on the field at the end. */
  routedMen: number;
  casualties: number;
  captured: number;
  dispersed: number;
  /** casualties + captured + dispersed, as a fraction of starting strength. */
  lossFraction: number;
  /** killed and wounded only, as a fraction of starting strength. */
  casualtyFraction: number;
  unitsEverRouted: number;
  unitsGone: number;
  unitsFormedAtEnd: number;
  rallies: number;
  broke: boolean;
  brokeAt: number | null;
  breakX: number | null;
  breakY: number | null;
  breakCentroidX: number | null;
  breakCentroidY: number | null;
  tipUnit: string | null;
}

export interface RoutRow {
  t: number;
  side: string;
  unit: string;
  name: string;
  x: number;
  y: number;
  kind: string;
  topCause: string;
  trigger: string;
  rootCause: string;
  rootUnit: string;
}

export interface RunResult {
  scenario: string;
  seed: number;
  /** Side id of the winner, or 'draw'. */
  winner: string;
  endReason: EndReason;
  duration: number;
  sides: SideResult[];
  routs: RoutRow[];
  stateHash: string;
}

const r1 = (v: number) => Math.round(v * 10) / 10;
const nn = (v: number) => (v === v ? r1(v) : null);

export function summarise(sim: Sim): RunResult {
  const sides: SideResult[] = sim.sides.map((s, i) => {
    const us = sim.units.filter((u) => u.side === i);
    const sum = (f: (u: (typeof us)[number]) => number) => us.reduce((a, u) => a + f(u), 0);
    const casualties = sum((u) => u.casualties);
    const captured = sum((u) => u.captured);
    const dispersed = sum((u) => u.dispersed);
    return {
      id: s.id,
      name: s.name,
      posture: s.posture,
      units: s.initUnits,
      startMen: s.initMen,
      formedMen: sum((u) => (u.status === 'ok' ? u.men : 0)),
      routedMen: sum((u) => (u.status === 'rout' ? u.men : 0)),
      casualties,
      captured,
      dispersed,
      lossFraction: (casualties + captured + dispersed) / s.initMen,
      casualtyFraction: casualties / s.initMen,
      unitsEverRouted: us.filter((u) => u.everRouted).length,
      unitsGone: us.filter((u) => u.status === 'gone').length,
      unitsFormedAtEnd: us.filter((u) => u.status === 'ok').length,
      rallies: sum((u) => u.rallies),
      broke: s.brokeAt >= 0,
      brokeAt: s.brokeAt >= 0 ? s.brokeAt : null,
      breakX: nn(s.breakX),
      breakY: nn(s.breakY),
      breakCentroidX: nn(s.breakCentroidX),
      breakCentroidY: nn(s.breakCentroidY),
      tipUnit: s.tipUnit >= 0 ? sim.units[s.tipUnit].id : null,
    };
  });
  let winner = 'draw';
  if (sim.over && sim.over.losers.length === 1) winner = sim.sides[1 - sim.over.losers[0]].id;
  return {
    scenario: sim.scenario.name,
    seed: sim.seed,
    winner,
    endReason: sim.endReason,
    duration: sim.t,
    sides,
    routs: sim.routs.map((r) => ({ t: r.t, side: sim.sides[r.side].id, unit: sim.units[r.unit].id, name: sim.units[r.unit].name, x: r1(r.x), y: r1(r.y), kind: r.kind, topCause: r.topCause, trigger: r.trigger, rootCause: r.rootCause, rootUnit: r.rootUnit })),
    stateHash: stateHash(sim),
  };
}

/** Conservation: every man is present, a casualty, a prisoner, dispersed or detached. Returns a list of violations. */
export function checkConservation(sim: Sim): string[] {
  const errs: string[] = [];
  for (const u of sim.units) {
    const total = u.men + u.casualties + u.captured + u.dispersed + u.detached;
    if (total !== u.startMen) errs.push(`${u.id}: ${total} accounted for, started with ${u.startMen}`);
    if (u.men < 0 || u.casualties < 0 || u.captured < 0 || u.dispersed < 0 || u.detached < 0) errs.push(`${u.id}: negative tally`);
    if (!Number.isInteger(u.men)) errs.push(`${u.id}: fractional men ${u.men}`);
    if (u.x !== u.x || u.y !== u.y || u.morale !== u.morale || u.f !== u.f) errs.push(`${u.id}: NaN in state`);
  }
  return errs;
}

const buf = new Float64Array(1);
const bytes = new Uint8Array(buf.buffer);

/** FNV-1a hash of the core state of every unit. Stable across phases: only baseline fields are included. */
export function stateHash(sim: Sim): string {
  let h = 0x811c9dc5;
  const add = (v: number) => {
    buf[0] = v;
    for (let i = 0; i < 8; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193);
    }
  };
  add(sim.tick);
  for (const u of sim.units) {
    add(u.x);
    add(u.y);
    add(u.f);
    add(u.men);
    add(u.morale);
    add(u.casualties);
    add(u.status === 'ok' ? 0 : u.status === 'rout' ? 1 : 2);
    add(u.form === 'line' ? 1 : u.form === 'column' ? 2 : u.form === 'square' ? 3 : 0);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function dataHash(data: unknown): string {
  return hashString(JSON.stringify(data)).toString(16).padStart(8, '0');
}
