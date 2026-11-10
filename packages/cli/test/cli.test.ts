import { describe, expect, it } from 'vitest';
import { intOpt, parseArgs } from '../src/args.ts';
import { applyOverrides, parseAxis, sweepPoints } from '../src/overrides.ts';
import { csv, csvCell, dist, histogram, quantile, sd, wilson } from '../src/stats.ts';
import { loadData, loadScenario, ROOT } from '../src/load.ts';
import { runJob } from '../src/worker.ts';
import { join } from 'node:path';

describe('sweep values', () => {
  it('parses lists, two-part and three-part ranges, decimals, negatives, booleans and words', () => {
    expect(parseAxis('data:a.b=1,2,3').values).toEqual([1, 2, 3]);
    expect(parseAxis('scenario:sides.french.deploy.cav=0..4').values).toEqual([0, 1, 2, 3, 4]);
    expect(parseAxis('scenario:sides.french.deploy.cav=0..8..2').values).toEqual([0, 2, 4, 6, 8]);
    expect(parseAxis('data:a=0.5..1.5..0.5').values).toEqual([0.5, 1, 1.5]);
    expect(parseAxis('data:a=-2..2..2').values).toEqual([-2, 0, 2]);
    expect(parseAxis('scenario:features.smoke=false,true').values).toEqual([false, true]);
    expect(parseAxis('scenario:weather.ground=firm,mud').values).toEqual(['firm', 'mud']);
    expect(parseAxis('data:a=0.00005,0.0001').values).toEqual([0.00005, 0.0001]);
  });
  it('rejects a parameter with no values, a bad scope and a missing =', () => {
    expect(() => parseAxis('data:a=')).toThrow(/no values/);
    expect(() => parseAxis('nowhere:a=1')).toThrow(/scope/);
    expect(() => parseAxis('data:a')).toThrow(/expected/);
  });
  it('builds the cartesian product of two axes', () => {
    expect(sweepPoints([parseAxis('data:a=1,2'), parseAxis('data:b=5,6,7')]).length).toBe(6);
  });
});

describe('overrides', () => {
  const fresh = () => ({ data: loadData().data, sc: loadScenario(join(ROOT, 'scenarios', 'pitched.json')) });
  it('sets data and scenario values, addressing array elements by id', () => {
    const { data, sc } = fresh();
    applyOverrides(data, sc, [
      { scope: 'data', path: 'morale.rippleFriend', value: 11 },
      { scope: 'scenario', path: 'sides.french.deploy.cav', value: 2 },
      { scope: 'scenario', path: 'features.smoke', value: true },
    ]);
    expect(data.morale.rippleFriend).toBe(11);
    expect(sc.sides[0].deploy!.cav).toBe(2);
    expect(sc.features!.smoke).toBe(true);
  });
  it('refuses a mistyped path instead of creating it', () => {
    const { data, sc } = fresh();
    expect(() => applyOverrides(data, sc, [{ scope: 'scenario', path: 'sides.french.deploy.cavv', value: 2 }])).toThrow(/not found/);
    expect(() => applyOverrides(data, sc, [{ scope: 'scenario', path: 'features.smok', value: true }])).toThrow(/not found/);
    expect(() => applyOverrides(data, sc, [{ scope: 'data', path: 'morale.nope', value: 1 }])).toThrow(/not found/);
    expect(() => applyOverrides(data, sc, [{ scope: 'data', path: 'morale.casualtyShock.value', value: 1 }])).toThrow(/without \.value/);
    expect(() => applyOverrides(data, sc, [{ scope: 'data', path: 'morale.casualtyShock', value: 'x' }])).toThrow(/is a number/);
  });
});

describe('arguments', () => {
  const spec = { runs: 'value', param: 'multi', csv: 'flag' } as const;
  it('accepts known options and repeated multi options', () => {
    const { pos, opt } = parseArgs('sweep', ['s.json', '--runs', '5', '--param', 'a=1', '--param', 'b=2', '--csv'], spec, 1);
    expect(pos).toEqual(['s.json']);
    expect(opt.param).toEqual(['a=1', 'b=2']);
    expect(opt.csv).toEqual(['true']);
  });
  it('rejects unknown options, missing values and stray arguments (PowerShell comma splitting)', () => {
    expect(() => parseArgs('batch', ['s.json', '--run', '3'], spec, 1)).toThrow(/unknown option --run/);
    expect(() => parseArgs('batch', ['s.json', '--runs'], spec, 1)).toThrow(/needs a value/);
    expect(() => parseArgs('sweep', ['s.json', '--param', 'a=1', '2', '3'], spec, 1)).toThrow(/single quotes/);
    expect(() => parseArgs('batch', ['--csv', 's.json'], spec, 1)).not.toThrow();
  });
  it('validates whole-number options', () => {
    expect(intOpt({ runs: ['12'] }, 'runs', 200, 1)).toBe(12);
    expect(intOpt({}, 'runs', 200, 1)).toBe(200);
    expect(() => intOpt({ runs: ['abc'] }, 'runs', 200, 1)).toThrow(/whole number/);
    expect(() => intOpt({ runs: ['0'] }, 'runs', 200, 1)).toThrow(/at least 1/);
  });
});

describe('statistics', () => {
  it('Wilson interval, quantile, standard deviation and histogram match hand values', () => {
    const [lo, hi] = wilson(5, 10);
    expect(lo).toBeCloseTo(0.2366, 3);
    expect(hi).toBeCloseTo(0.7634, 3);
    expect(wilson(0, 200)[0]).toBe(0);
    expect(wilson(0, 200)[1]).toBeCloseTo(0.0188, 3);
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10], 0.9)).toBe(10);
    expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(histogram([0, 0.05, 0.5, 0.99, 1], 0, 1, 10)).toEqual([2, 0, 0, 0, 0, 1, 0, 0, 0, 2]);
    expect(dist([1, 2, 3]).median).toBe(2);
  });
  it('CSV cells keep small coefficients distinct and quote awkward text', () => {
    expect(csvCell(0.00005)).toBe('0.00005');
    expect(csvCell(0.0001)).toBe('0.0001');
    expect(csvCell(1 / 3)).toBe('0.3333333');
    expect(csvCell(42)).toBe('42');
    expect(csvCell('Cuirassiers, 1st sqn')).toBe('"Cuirassiers, 1st sqn"');
    expect(csvCell(NaN)).toBe('');
    expect(csv([['a', 'b'], [1, null]])).toBe('a,b\n1,\n');
  });
});

describe('batch jobs', () => {
  it('give the same results whatever way the seeds are split, and conserve men', () => {
    const { data } = loadData();
    const sc = loadScenario(join(ROOT, 'scenarios', 'column.json'));
    const whole = runJob(data, sc, { point: 0, overrides: [], seeds: [1, 2, 3, 4] });
    const a = runJob(data, sc, { point: 0, overrides: [], seeds: [1, 2] });
    const b = runJob(data, sc, { point: 0, overrides: [], seeds: [3, 4] });
    expect([...a.results, ...b.results].map((r) => r.stateHash)).toEqual(whole.results.map((r) => r.stateHash));
    expect(whole.violations).toEqual([]);
    expect(whole.results[0].units.length).toBe(8);
  });
});
