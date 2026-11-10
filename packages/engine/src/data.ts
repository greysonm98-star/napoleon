// Data bundle: loading, validation and flattening of the JSON parameter files.
// Every number in the raw files must sit inside a parameter object
// { value, unit, source, confidence, note } or a curve { points, xUnit, yUnit, source, ... }.

import type { Curve } from './math.ts';

export type Confidence = 'sourced' | 'secondary' | 'recalled' | 'derived' | 'prototype' | 'assumption';
const CONFIDENCES = ['sourced', 'secondary', 'recalled', 'derived', 'prototype', 'assumption'];

export interface ParamInfo {
  path: string;
  value: number | string;
  unit: string;
  source: string;
  confidence: Confidence;
  note: string;
}

export interface Doctrine {
  label: string;
  ranks: number;
  firingRanks: number;
  fileWidth: number;
  rankDepth: number;
  paceLength: number;
  cadenceLine: number;
  cadenceColumn: number;
  lineDressingFactor: number;
  squareSpeed: number;
  routSpeed: number;
  columnDivisions: number;
  columnIntervalFraction: number;
  squareRanks: number;
  squareFiringRanks: number;
  timeLineToColumn: number;
  timeColumnToLine: number;
  timeColumnToSquare: number;
  timeLineToSquare: number;
  timeSquareToColumn: number;
  timeSquareToLine: number;
  timeRallyReform: number;
}

export interface Musket {
  label: string;
  trialCurve: Curve;
  battlefieldFactor: number;
  roundsPerMinute: number;
  reloadJitter: number;
}

export interface Gun {
  label: string;
  roundshotCurve: Curve;
  roundshotBattlefieldFactor: number;
  roundshotMaxRange: number;
  roundshotEffectiveRange: number;
  roundshotReload: number;
  menPerRank: number;
  maxRanksTraversed: number;
  squareTargetFactor: number;
  canisterRange: number;
  canisterHitsCurve: Curve;
  canisterBattlefieldFactor: number;
  canisterReload: number;
}

export interface UnitType {
  label: string;
  arm: 'inf' | 'cav' | 'art';
  doctrine?: string;
  weapon?: string;
  gun?: string;
  men: number;
  skirmishFraction?: number;
  // cavalry
  ranks?: number;
  fileWidth?: number;
  rankDepth?: number;
  trotSpeed?: number;
  chargeSpeed?: number;
  routSpeed?: number;
  chargeStartRange?: number;
  turnRate?: number;
  // artillery
  guns?: number;
  gunInterval?: number;
  depth?: number;
  speed?: number;
}

export interface TerrainType {
  label: string;
  moveInfantry: number;
  moveCavalry: number;
  moveArtillery: number;
  coverMusketry: number;
  coverArtillery: number;
  cavalryMelee: number;
  cavalryVsInfantryInside: number;
  sightHeight: number;
}

export interface QualityClass {
  label: string;
  steadiness: number;
  fire: number;
  reload: number;
  drill: number;
  melee: number;
  rally: number;
}

type Nums = Record<string, number>;

export interface Data {
  sources: Record<string, string>;
  doctrine: Record<string, Doctrine>;
  weapons: {
    muskets: Record<string, Musket>;
    musketry: Nums;
    guns: Record<string, Gun>;
    gunnery: Nums;
  };
  units: Record<string, UnitType>;
  morale: Nums;
  melee: Nums;
  terrain: { types: Record<string, TerrainType> } & Nums;
  ai: Nums;
  quality: { classes: Record<string, QualityClass> };
  rosters: Record<string, Record<'inf' | 'cav' | 'art', [string, string][]>>;
  // later phases add: command, fatigue, ammunition, skirmish, los, smoke, weather
  [k: string]: unknown;
}

export type RawData = Record<string, unknown>;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isParam = (v: unknown): v is Record<string, unknown> => isObj(v) && 'value' in v && 'unit' in v;
const isCurve = (v: unknown): v is Record<string, unknown> => isObj(v) && Array.isArray(v.points);

/** Files that hold no tunable numbers and are passed through untouched. */
const PASSTHROUGH = new Set(['sources', 'rosters']);

function walk(node: unknown, path: string, params: ParamInfo[], errors: string[], sources: Record<string, string>): unknown {
  if (isParam(node)) {
    const { value, unit, source, confidence, note } = node as Record<string, unknown>;
    if (typeof value !== 'number' && typeof value !== 'string') errors.push(`${path}: value must be a number`);
    if (typeof unit !== 'string' || !unit) errors.push(`${path}: missing unit`);
    if (typeof source !== 'string' || !(source in sources)) errors.push(`${path}: unknown source '${String(source)}'`);
    if (typeof confidence !== 'string' || !CONFIDENCES.includes(confidence)) errors.push(`${path}: bad confidence '${String(confidence)}'`);
    if (typeof note !== 'string' || !note) errors.push(`${path}: missing note`);
    params.push({ path, value: value as number, unit: String(unit), source: String(source), confidence: confidence as Confidence, note: String(note) });
    return value;
  }
  if (isCurve(node)) {
    const c = node as Record<string, unknown>;
    if (typeof c.xUnit !== 'string' || typeof c.yUnit !== 'string') errors.push(`${path}: curve needs xUnit and yUnit`);
    if (typeof c.source !== 'string' || !(c.source in sources)) errors.push(`${path}: unknown source '${String(c.source)}'`);
    if (typeof c.confidence !== 'string' || !CONFIDENCES.includes(c.confidence)) errors.push(`${path}: bad confidence`);
    if (typeof c.note !== 'string' || !c.note) errors.push(`${path}: missing note`);
    const pts = c.points as [number, number][];
    for (let i = 0; i < pts.length; i++) {
      if (!Array.isArray(pts[i]) || pts[i].length !== 2 || typeof pts[i][0] !== 'number' || typeof pts[i][1] !== 'number') errors.push(`${path}: bad point ${i}`);
      if (i > 0 && pts[i][0] <= pts[i - 1][0]) errors.push(`${path}: x values must increase`);
    }
    params.push({ path, value: JSON.stringify(pts), unit: `${c.yUnit} by ${c.xUnit}`, source: String(c.source), confidence: c.confidence as Confidence, note: String(c.note) });
    return { points: pts.map((p) => [p[0], p[1]] as [number, number]) };
  }
  if (typeof node === 'number') {
    errors.push(`${path}: bare number ${node}; wrap it as { value, unit, source, confidence, note }`);
    return node;
  }
  if (Array.isArray(node)) return node.map((v, i) => walk(v, `${path}[${i}]`, params, errors, sources));
  if (isObj(node)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(node)) out[k] = walk(node[k], path ? `${path}.${k}` : k, params, errors, sources);
    return out;
  }
  return node;
}

export interface ResolvedData {
  data: Data;
  params: ParamInfo[];
}

/** Validate the raw bundle (one key per data file) and flatten parameters to plain numbers. */
export function resolveData(raw: RawData): ResolvedData {
  const sources = (raw.sources ?? {}) as Record<string, string>;
  const params: ParamInfo[] = [];
  const errors: string[] = [];
  const out: Record<string, unknown> = {};
  for (const file of Object.keys(raw).sort()) {
    out[file] = PASSTHROUGH.has(file) ? raw[file] : walk(raw[file], file, params, errors, sources);
  }
  for (const need of ['doctrine', 'weapons', 'units', 'morale', 'melee', 'terrain', 'ai', 'quality', 'rosters']) {
    if (!(need in out)) errors.push(`missing data file '${need}.json'`);
  }
  if (errors.length) throw new Error('Data errors:\n  ' + errors.join('\n  '));
  return { data: out as Data, params };
}

/** Set a value in a flattened bundle by dotted path, e.g. "morale.rippleFriend". */
export function setPath(root: unknown, path: string, value: unknown): void {
  const parts = path.split('.');
  let node = root as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const next = node[parts[i]];
    if (next === undefined || next === null) throw new Error(`path '${path}': '${parts[i]}' not found`);
    node = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (!(last in node)) throw new Error(`path '${path}': '${last}' not found`);
  node[last] = value;
}

export function getPath(root: unknown, path: string): unknown {
  let node = root as Record<string, unknown>;
  for (const p of path.split('.')) {
    if (node === undefined || node === null) return undefined;
    node = node[p] as Record<string, unknown>;
  }
  return node;
}

/**
 * Guard against typos: wraps the flat number tables so that reading a missing key throws.
 * Applied once at sim creation; hot loops read from the plain objects captured after the check.
 */
export function requireKeys(table: Record<string, unknown>, name: string, keys: readonly string[]): void {
  const missing = keys.filter((k) => typeof table[k] !== 'number');
  if (missing.length) throw new Error(`data ${name}: missing numeric parameters: ${missing.join(', ')}`);
}
