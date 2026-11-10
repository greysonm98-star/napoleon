// The results viewer's data model. PURE: no DOM, no window, so it can be tested in Node.
// It reads the files `napsim batch --out` writes (or the same files made in the browser) and
// computes everything the Results tab shows.

import { dist, wilson } from '@napoleon/engine';
import type { BatchSummary, Dist, Scenario } from '@napoleon/engine';

export type Val = number | boolean | string;

// ------------------------------------------------------------------ CSV

/** RFC 4180 CSV: quoted fields, "" escapes, commas and newlines inside quotes, CRLF or LF, optional trailing newline. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let started = false; // anything seen on the current row
  if (text.charCodeAt(0) === 0xfeff) i = 1; // byte-order mark, as Excel writes
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      if (started || field !== '') {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (quoted) throw new Error('a quoted field is not closed');
  if (started || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

interface Table {
  head: string[];
  col: Map<string, number>;
  rows: string[][];
}

function table(name: string, text: string): Table {
  const all = parseCsv(text);
  if (!all.length) throw new Error(`${name} is empty`);
  const head = all[0];
  const col = new Map(head.map((h, i) => [h, i] as [string, number]));
  const rows = all.slice(1);
  for (let r = 0; r < rows.length; r++) {
    if (rows[r].length !== head.length) throw new Error(`${name}, line ${r + 2}: ${rows[r].length} fields where the header has ${head.length}`);
  }
  return { head, col, rows };
}

const num = (s: string | undefined): number => (s === undefined || s === '' ? NaN : Number(s));
const numOrNull = (s: string | undefined): number | null => (s === undefined || s === '' ? null : Number(s));

/** Axis values come back from CSV as text; restore booleans and numbers. */
export function parseVal(s: string): Val {
  if (s === 'true') return true;
  if (s === 'false') return false;
  const n = Number(s);
  return s !== '' && Number.isFinite(n) ? n : s;
}

// ------------------------------------------------------------------ the view

export interface SideRun {
  menStart: number;
  kw: number;
  prisoners: number;
  dispersed: number;
  lossFraction: number;
  kwFraction: number;
  units: number;
  unitsRouted: number;
  broke: boolean;
  brokeAt: number | null;
  breakX: number | null;
  breakY: number | null;
  tipUnit: string;
}

export interface RunRow {
  seed: number;
  winner: string;
  decidedBy: string;
  endReason: string;
  duration: number;
  sides: SideRun[];
  firstRoutT: number | null;
  firstRoutUnit: string;
  firstRoutCause: string;
  stateHash: string;
}

export interface RoutRow {
  seed: number;
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

export interface UnitRow {
  seed: number;
  side: string;
  unit: string;
  name: string;
  formation: string;
  arm: string;
  menStart: number;
  menEnd: number;
  kw: number;
  prisoners: number;
  dispersed: number;
  status: string;
  everRouted: boolean;
  rallies: number;
}

export interface AxisInfo {
  /** The runs.csv column, e.g. 'data:morale.casualtyShock'. */
  key: string;
  scope: 'data' | 'scenario';
  path: string;
  /** The last two parts of the path, for labels. */
  label: string;
  /** Distinct values in the order they first appear. */
  values: Val[];
}

export interface PointView {
  index: number;
  params: Record<string, Val>;
  runs: RunRow[];
  routs: RoutRow[];
  units: UnitRow[];
}

export interface BatchView {
  label: string;
  files: string[];
  summary: BatchSummary | null;
  scenario: Scenario | null;
  scenarioSource: 'summary' | 'bundled' | 'none';
  sides: { id: string; name: string }[];
  axes: AxisInfo[];
  points: PointView[];
  has: { routs: boolean; units: boolean; summary: boolean };
  /** One line per missing file or other limitation, for the panel. */
  notes: string[];
}

export interface InFile {
  name: string;
  text: string;
}

const base = (p: string): string => p.split(/[\\/]/).pop() ?? p;

function findScenario(summary: BatchSummary | null, bundled: { key: string; sc: Scenario }[]): [Scenario | null, BatchView['scenarioSource']] {
  if (summary?.scenarioSpec) return [summary.scenarioSpec, 'summary'];
  if (summary) {
    const byName = bundled.find((b) => b.sc.name === summary.scenario);
    if (byName) return [byName.sc, 'bundled'];
    const key = base(summary.scenarioFile ?? '').replace(/\.json$/, '');
    const byKey = bundled.find((b) => b.key === key);
    if (byKey) return [byKey.sc, 'bundled'];
  }
  return [null, 'none'];
}

/** Build the view from a batch's output files. runs.csv is required; everything else is optional. */
export function buildBatchView(files: InFile[], bundled: { key: string; sc: Scenario }[], label = 'batch'): BatchView {
  const by = new Map(files.map((f) => [base(f.name), f.text] as [string, string]));
  const runsText = by.get('runs.csv');
  if (runsText === undefined) throw new Error('no runs.csv here: open the folder that napsim batch or sweep wrote with --out');
  const notes: string[] = [];

  let summary: BatchSummary | null = null;
  const sj = by.get('summary.json');
  if (sj !== undefined) {
    try {
      summary = JSON.parse(sj) as BatchSummary;
    } catch (e) {
      throw new Error(`summary.json is not valid JSON (${e instanceof Error ? e.message : e})`);
    }
  } else notes.push('No summary.json: the map needs it to know the scenario, and replays cannot reapply --set overrides.');

  const runs = table('runs.csv', runsText);
  const ci = runs.col;
  const pIdx = ci.get('point');
  const sIdx = ci.get('seed');
  if (pIdx === undefined || sIdx === undefined) throw new Error('runs.csv has no point or seed column: is it a napsim runs.csv?');

  // sides: from summary.json, else from the per-side columns
  let sideIds = summary?.sides?.map((s) => s.id) ?? runs.head.filter((h) => h.endsWith('_men_start')).map((h) => h.slice(0, -'_men_start'.length));
  if (!sideIds.length) throw new Error('runs.csv has no per-side columns');
  const [scenario, scenarioSource] = findScenario(summary, bundled);
  const sides = sideIds.map((id) => ({ id, name: summary?.sides?.find((s) => s.id === id)?.name ?? scenario?.sides.find((s) => s.id === id)?.name ?? id }));
  if (!scenario) notes.push('The scenario could not be found (no summary.json, or one naming no bundled scenario): the map of where units broke is not shown.');
  else if (scenarioSource === 'bundled') notes.push(`summary.json predates the embedded scenario; using the bundled "${scenario.name}".`);

  const axisCols = runs.head.slice(pIdx + 1, sIdx);
  const axes: AxisInfo[] = axisCols.map((key) => {
    const colon = key.indexOf(':');
    const scope = (key.slice(0, colon) === 'data' ? 'data' : 'scenario') as AxisInfo['scope'];
    const path = key.slice(colon + 1);
    return { key, scope, path, label: path.split('.').slice(-2).join('.'), values: [] };
  });

  const points = new Map<number, PointView>();
  const get = (r: string[], name: string): string | undefined => {
    const i = ci.get(name);
    return i === undefined ? undefined : r[i];
  };
  for (const r of runs.rows) {
    const p = Number(r[pIdx]);
    let pt = points.get(p);
    if (!pt) {
      const params: Record<string, Val> = {};
      axes.forEach((a, k) => {
        const v = parseVal(r[pIdx + 1 + k]);
        params[a.key] = v;
        if (!a.values.some((x) => x === v)) a.values.push(v);
      });
      pt = { index: p, params, runs: [], routs: [], units: [] };
      points.set(p, pt);
    }
    pt.runs.push({
      seed: Number(r[sIdx]),
      winner: get(r, 'winner') ?? '',
      decidedBy: get(r, 'decided_by') ?? '',
      endReason: get(r, 'end_reason') ?? '',
      duration: num(get(r, 'duration_s')),
      sides: sideIds.map((id) => {
        const g = (c: string) => get(r, `${id}_${c}`);
        return {
          menStart: num(g('men_start')),
          kw: num(g('killed_wounded')),
          prisoners: num(g('prisoners')),
          dispersed: num(g('dispersed')),
          lossFraction: num(g('loss_fraction')),
          kwFraction: num(g('kw_fraction')),
          units: num(g('units')),
          unitsRouted: num(g('units_routed')),
          broke: g('broke') === '1' || g('broke') === 'true',
          brokeAt: numOrNull(g('broke_at_s')),
          breakX: numOrNull(g('break_x')),
          breakY: numOrNull(g('break_y')),
          tipUnit: g('tip_unit') ?? '',
        };
      }),
      firstRoutT: numOrNull(get(r, 'first_rout_s')),
      firstRoutUnit: get(r, 'first_rout_unit') ?? '',
      firstRoutCause: get(r, 'first_rout_cause') ?? '',
      stateHash: get(r, 'state_hash') ?? '',
    });
  }

  const routsText = by.get('routs.csv');
  if (routsText !== undefined) {
    const t = table('routs.csv', routsText);
    const c = (n: string) => t.col.get(n) ?? -1;
    const [cp, cs, ct, csd, cu, cn, cx, cy, ck, ctop, ctr, croot, cru] = ['point', 'seed', 't_s', 'side', 'unit', 'name', 'x', 'y', 'kind', 'top_cause', 'trigger', 'root_cause', 'root_unit'].map(c);
    if (cp < 0 || cs < 0) throw new Error('routs.csv has no point or seed column');
    for (const r of t.rows) {
      const pt = points.get(Number(r[cp]));
      if (!pt) continue;
      pt.routs.push({ seed: Number(r[cs]), t: num(r[ct]), side: r[csd], unit: r[cu], name: r[cn], x: num(r[cx]), y: num(r[cy]), kind: r[ck], topCause: r[ctop] ?? '', trigger: r[ctr] ?? '', rootCause: r[croot] ?? '', rootUnit: r[cru] ?? '' });
    }
  } else notes.push('No routs.csv: the map of where units broke is not shown.');

  const unitsText = by.get('units.csv');
  if (unitsText !== undefined) {
    const t = table('units.csv', unitsText);
    const c = (n: string) => t.col.get(n) ?? -1;
    const [cp, cs, csd, cu, cn, cf, ca, cms, cme, ckw, cpr, cdi, cst, cer, cra] = ['point', 'seed', 'side', 'unit', 'name', 'formation', 'arm', 'men_start', 'men_end', 'killed_wounded', 'prisoners', 'dispersed', 'status', 'ever_routed', 'rallies'].map(c);
    if (cp < 0 || cs < 0) throw new Error('units.csv has no point or seed column');
    for (const r of t.rows) {
      const pt = points.get(Number(r[cp]));
      if (!pt) continue;
      pt.units.push({ seed: Number(r[cs]), side: r[csd], unit: r[cu], name: r[cn], formation: r[cf] ?? '', arm: r[ca] ?? '', menStart: num(r[cms]), menEnd: num(r[cme]), kw: num(r[ckw]), prisoners: num(r[cpr]), dispersed: num(r[cdi]), status: r[cst] ?? '', everRouted: r[cer] === '1' || r[cer] === 'true', rallies: num(r[cra]) });
    }
  } else notes.push('No units.csv: the table of formations and units is not shown.');

  const pts = [...points.values()].sort((a, b) => a.index - b.index);
  for (const p of pts) p.runs.sort((a, b) => a.seed - b.seed);
  return {
    label,
    files: [...by.keys()].sort(),
    summary,
    scenario,
    scenarioSource,
    sides,
    axes,
    points: pts,
    has: { routs: routsText !== undefined, units: unitsText !== undefined, summary: !!summary },
    notes,
  };
}

// ------------------------------------------------------------------ what the views compute

export interface Rate {
  id: string;
  k: number;
  n: number;
  rate: number;
  lo: number;
  hi: number;
}

/** Wins per side and no-decision share, with 95% Wilson intervals. */
export function winRates(pt: PointView, sides: { id: string }[]): { sides: Rate[]; draw: Rate } {
  const n = pt.runs.length;
  const r = (id: string): Rate => {
    const k = pt.runs.filter((x) => x.winner === id).length;
    const [lo, hi] = wilson(k, n);
    return { id, k, n, rate: n ? k / n : NaN, lo, hi };
  };
  return { sides: sides.map((s) => r(s.id)), draw: r('draw') };
}

export function decidedSplit(pt: PointView): { key: string; label: string; n: number }[] {
  const order: [string, string][] = [
    ['army_broken', 'An army broke'],
    ['objective', 'Held the objective'],
    ['none', 'No decision'],
  ];
  const counts = new Map<string, number>();
  for (const r of pt.runs) {
    const k = r.decidedBy || (r.winner === 'draw' ? 'none' : 'army_broken');
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return order.map(([key, label]) => ({ key, label, n: counts.get(key) ?? 0 })).filter((x) => x.n > 0);
}

export const lossDist = (pt: PointView, side: number): Dist => dist(pt.runs.map((r) => r.sides[side].lossFraction).filter((v) => v === v));
export const durationDist = (pt: PointView): Dist => dist(pt.runs.map((r) => r.duration / 60).filter((v) => v === v));
export const breakTimes = (pt: PointView, side: number): number[] => pt.runs.filter((r) => r.sides[side].broke && r.sides[side].brokeAt !== null).map((r) => r.sides[side].brokeAt! / 60);

export interface Bin {
  lo: number;
  hi: number;
  count: number;
}

/** Fixed-width bins from lo to hi; the last bin includes hi. */
export function bins(values: number[], lo: number, hi: number, width: number): Bin[] {
  const n = Math.max(1, Math.round((hi - lo) / width));
  const out: Bin[] = Array.from({ length: n }, (_, i) => ({ lo: lo + i * width, hi: lo + (i + 1) * width, count: 0 }));
  for (const v of values) {
    if (v !== v) continue;
    let i = Math.floor((v - lo) / width);
    if (i < 0) i = 0;
    if (i >= n) i = n - 1;
    out[i].count++;
  }
  return out;
}

/** A tidy bin width that gives roughly `target` bins over the range. */
export function niceWidth(span: number, target = 16): number {
  if (!(span > 0)) return 1;
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}

export interface LossStats {
  men: number;
  kw: number;
  prisoners: number;
  dispersed: number;
  total: Dist;
}

export interface FormationRow extends LossStats {
  side: string;
  formation: string;
  units: number;
  /** Median number of its units routed per run. */
  routedMedian: number;
  members: UnitStat[];
}

export interface UnitStat extends LossStats {
  side: string;
  unit: string;
  name: string;
  formation: string;
  arm: string;
  /** Share of runs in which the unit routed at least once. */
  routedShare: number;
}

const median = (xs: number[]): number => dist(xs).median;

function lossStats(perRun: { start: number; kw: number; pr: number; di: number }[]): LossStats {
  const f = (g: (a: { start: number; kw: number; pr: number; di: number }) => number) => median(perRun.map((a) => (a.start ? g(a) / a.start : NaN)).filter((v) => v === v));
  return {
    men: perRun.length ? perRun[0].start : 0,
    kw: f((a) => a.kw),
    prisoners: f((a) => a.pr),
    dispersed: f((a) => a.di),
    total: dist(perRun.map((a) => (a.start ? (a.kw + a.pr + a.di) / a.start : NaN)).filter((v) => v === v)),
  };
}

/**
 * Losses by formation (summed per run, then the median across runs, as tools/derlon-report.mjs does)
 * and by unit. `group` lets several formations be read as one, e.g. a division of brigades.
 */
export function formationRows(pt: PointView, group: (u: UnitRow) => string = (u) => u.formation || 'Unassigned'): FormationRow[] {
  const forms = new Map<string, { side: string; perSeed: Map<number, { start: number; kw: number; pr: number; di: number; routed: number }>; units: Map<string, UnitRow[]> }>();
  for (const u of pt.units) {
    const key = `${u.side}\u0000${group(u)}`;
    let f = forms.get(key);
    if (!f) forms.set(key, (f = { side: u.side, perSeed: new Map(), units: new Map() }));
    let a = f.perSeed.get(u.seed);
    if (!a) f.perSeed.set(u.seed, (a = { start: 0, kw: 0, pr: 0, di: 0, routed: 0 }));
    a.start += u.menStart;
    a.kw += u.kw;
    a.pr += u.prisoners;
    a.di += u.dispersed;
    a.routed += u.everRouted ? 1 : 0;
    let list = f.units.get(u.unit);
    if (!list) f.units.set(u.unit, (list = []));
    list.push(u);
  }
  const out: FormationRow[] = [];
  for (const [key, f] of forms) {
    const per = [...f.perSeed.values()];
    const members: UnitStat[] = [...f.units.values()].map((rows) => ({
      side: rows[0].side,
      unit: rows[0].unit,
      name: rows[0].name,
      formation: rows[0].formation,
      arm: rows[0].arm,
      routedShare: rows.filter((r) => r.everRouted).length / rows.length,
      ...lossStats(rows.map((r) => ({ start: r.menStart, kw: r.kw, pr: r.prisoners, di: r.dispersed }))),
    }));
    out.push({ side: f.side, formation: key.split('\u0000')[1], units: f.units.size, routedMedian: median(per.map((a) => a.routed)), members, ...lossStats(per) });
  }
  return out;
}

/** The causes of a side's routs at a point, most frequent first; the first three get colours. */
export function causeRanking(pt: PointView, side: string): { cause: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of pt.routs) {
    if (r.side !== side || r.kind === 'army_broken') continue;
    const c = r.rootCause || '(none)';
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  return [...m.entries()].map(([cause, n]) => ({ cause, n })).sort((a, b) => b.n - a.n || (a.cause < b.cause ? -1 : 1));
}

/** The point whose parameters match `want` on every axis, if any. */
export function findPoint(view: BatchView, want: Record<string, Val>): PointView | undefined {
  return view.points.find((p) => view.axes.every((a) => p.params[a.key] === want[a.key]));
}

/** The overrides that reproduce a point: the batch's fixed ones, then the point's own. */
export function pointOverrides(view: BatchView, pt: PointView): { scope: 'data' | 'scenario'; path: string; value: unknown }[] {
  const fixed = (view.summary?.fixedOverrides ?? []).map((o) => ({ scope: o.scope, path: o.path, value: o.value }));
  return [...fixed, ...view.axes.map((a) => ({ scope: a.scope, path: a.path, value: pt.params[a.key] as unknown }))];
}
