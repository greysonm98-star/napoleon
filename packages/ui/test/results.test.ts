import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { batchFiles, parseAxis, resolveData, runJob, summarisePoint, sweepPoints } from '@napoleon/engine';
import type { RawData, RunResult, Scenario } from '@napoleon/engine';
import { buildBatchView, causeRanking, findPoint, formationRows, parseCsv, pointOverrides, winRates } from '../src/results-model.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
function data() {
  const raw: RawData = {};
  for (const f of readdirSync(join(ROOT, 'data')).sort()) if (f.endsWith('.json')) raw[f.slice(0, -5)] = JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8'));
  return resolveData(raw).data;
}
const scenario = (k: string): Scenario => JSON.parse(readFileSync(join(ROOT, 'scenarios', k + '.json'), 'utf8'));
const bundled = readdirSync(join(ROOT, 'scenarios')).filter((f) => f.endsWith('.json')).map((f) => ({ key: f.slice(0, -5), sc: scenario(f.slice(0, -5)) }));

describe('CSV parser', () => {
  it('handles quoted commas, escaped quotes, CRLF, a BOM and a trailing newline', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
    expect(parseCsv('﻿a,b\n1,\n')).toEqual([['a', 'b'], ['1', '']]);
    expect(parseCsv('a\n"two\nlines"')).toEqual([['a'], ['two\nlines']]);
    expect(() => parseCsv('a\n"open')).toThrow(/not closed/);
  });
  it('rejects a row with the wrong number of fields', () => {
    expect(() => buildBatchView([{ name: 'runs.csv', text: 'point,seed,a_men_start\n0,1\n' }], [])).toThrow(/line 2/);
  });
  it('needs runs.csv', () => {
    expect(() => buildBatchView([{ name: 'summary.json', text: '{}' }], [])).toThrow(/no runs\.csv/);
  });
});

describe('a batch read back from its files', () => {
  const d = data();
  const sc = scenario('column');
  const axes = [parseAxis('data:morale.casualtyShock=2,3'), parseAxis('scenario:features.skirmishers=false,true')];
  const points = sweepPoints(axes);
  const seeds = [1, 2, 3, 4, 5, 6];
  const results: RunResult[][] = points.map((p, i) => runJob(d, sc, { point: i, overrides: p, seeds }).results);
  const summaries = results.map((rs, p) => summarisePoint(p, Object.fromEntries(points[p].map((o) => [o.path, o.value])), rs));
  const files = batchFiles('scenarios/column.json', sc, d, axes, [], points, results, summaries, seeds);
  const asFiles = Object.entries(files).map(([name, text]) => ({ name: 'out/col/' + name, text }));

  it('has every point and run, with axis values of the right type', () => {
    const v = buildBatchView(asFiles, bundled);
    expect(v.points.length).toBe(4);
    expect(v.points.every((p) => p.runs.length === 6)).toBe(true);
    expect(v.axes.map((a) => a.key)).toEqual(['data:morale.casualtyShock', 'scenario:features.skirmishers']);
    expect(v.axes[0].values).toEqual([2, 3]);
    expect(v.axes[1].values).toEqual([false, true]);
    expect(v.sides.map((s) => s.name)).toEqual(['French', 'Allied']);
    expect(v.scenarioSource).toBe('summary');
    expect(v.has).toEqual({ routs: true, units: true, summary: true });
    expect(v.notes).toEqual([]);
  });

  it('counts the same wins as the runs themselves', () => {
    const v = buildBatchView(asFiles, bundled);
    v.points.forEach((pt, i) => {
      const w = winRates(pt, v.sides);
      for (const s of w.sides) expect(s.k).toBe(results[i].filter((r) => r.winner === s.id).length);
      expect(w.draw.k).toBe(results[i].filter((r) => r.winner === 'draw').length);
      expect(pt.runs.map((r) => r.stateHash)).toEqual(results[i].map((r) => r.stateHash));
      expect(pt.routs.length).toBe(results[i].reduce((a, r) => a + r.routs.length, 0));
      expect(pt.units.length).toBe(results[i].reduce((a, r) => a + r.units.length, 0));
    });
    const p = findPoint(v, { 'data:morale.casualtyShock': 3, 'scenario:features.skirmishers': true })!;
    expect(p.index).toBe(3);
    expect(pointOverrides(v, p)).toEqual([
      { scope: 'data', path: 'morale.casualtyShock', value: 3 },
      { scope: 'scenario', path: 'features.skirmishers', value: true },
    ]);
  });

  it('sums formation losses per run before taking the median', () => {
    const v = buildBatchView(asFiles, bundled);
    const pt = v.points[0];
    const rows = formationRows(pt, (u) => u.side);
    const allied = rows.find((r) => r.side === 'allied')!;
    const perRun = results[0].map((r) => {
      const s = r.sides.find((x) => x.id === 'allied')!;
      return (s.casualties + s.captured + s.dispersed) / s.startMen;
    });
    const sorted = perRun.slice().sort((a, b) => a - b);
    expect(allied.total.median).toBeCloseTo((sorted[2] + sorted[3]) / 2, 9);
    expect(allied.members.length).toBe(4);
    expect(causeRanking(pt, 'french').length).toBeGreaterThan(0);
  });

  it('finds the bundled scenario when summary.json predates the embedded one, and copes without it', () => {
    const old = JSON.parse(files['summary.json']);
    delete old.scenarioSpec;
    delete old.sides;
    const v = buildBatchView(asFiles.map((f) => (f.name.endsWith('summary.json') ? { ...f, text: JSON.stringify(old) } : f)), bundled);
    expect(v.scenarioSource).toBe('bundled');
    expect(v.scenario!.name).toBe('Column against line');
    expect(v.sides.map((s) => s.id)).toEqual(['french', 'allied']);
    const bare = buildBatchView(asFiles.filter((f) => f.name.endsWith('runs.csv')), bundled);
    expect(bare.scenario).toBeNull();
    expect(bare.has).toEqual({ routs: false, units: false, summary: false });
    expect(bare.notes.length).toBe(4);
  });
});
