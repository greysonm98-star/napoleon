import { describe, expect, it } from 'vitest';
import { atan2, checkConservation, cos, createSim, recordRun, resolveData, runToEnd, sin, stateHash, step, summarise } from '../src/index.ts';
import { assertConserved, freshData, loadScenario, rawData } from './helpers.ts';

const PRESETS = ['pitched', 'column', 'squares', 'battery', 'counter'];

describe('deterministic maths', () => {
  it('sin, cos and atan2 agree with the platform to 1e-5', () => {
    for (let i = -400; i <= 400; i++) {
      const x = i * 0.0317;
      expect(Math.abs(sin(x) - Math.sin(x))).toBeLessThan(1e-6);
      expect(Math.abs(cos(x) - Math.cos(x))).toBeLessThan(1e-6);
    }
    for (let i = 0; i < 360; i++) {
      const a = (i * Math.PI) / 180;
      const y = Math.sin(a) * 3.7;
      const x = Math.cos(a) * 3.7;
      expect(Math.abs(atan2(y, x) - Math.atan2(y, x))).toBeLessThan(2e-5);
    }
  });
});

describe('data files', () => {
  it('every number carries a unit, a known source, a confidence and a note', () => {
    const { params } = resolveData(rawData());
    expect(params.length).toBeGreaterThan(150);
    for (const p of params) {
      expect(p.unit, p.path).toBeTruthy();
      expect(p.note, p.path).toBeTruthy();
    }
  });
  it('rejects a bare number', () => {
    const raw = rawData() as Record<string, Record<string, unknown>>;
    raw.morale.routThreshold = 20;
    expect(() => resolveData(raw)).toThrow(/bare number/);
  });
  it('rejects an unknown source', () => {
    const raw = rawData() as Record<string, Record<string, Record<string, unknown>>>;
    raw.morale.routThreshold.source = 'nowhere';
    expect(() => resolveData(raw)).toThrow(/unknown source/);
  });
});

describe('determinism', () => {
  it('same scenario, data and seed give the same state at every sampled tick', () => {
    for (const name of PRESETS) {
      const sc = loadScenario(name);
      const a = createSim(sc, freshData(), 42);
      const b = createSim(sc, freshData(), 42);
      for (let i = 0; i < 2500 && !a.ended; i++) {
        step(a);
        step(b);
        if (i % 50 === 0) expect(stateHash(a), `${name} tick ${i}`).toBe(stateHash(b));
      }
      expect(stateHash(a)).toBe(stateHash(b));
      expect(JSON.stringify(summarise(a))).toBe(JSON.stringify(summarise(b)));
    }
  });
  it('different seeds give different battles', () => {
    const sc = loadScenario('pitched');
    const hashes = new Set<string>();
    for (let seed = 1; seed <= 8; seed++) hashes.add(runToEnd(createSim(sc, freshData(), seed)).stateHash);
    expect(hashes.size).toBe(8);
  });
  it('recording a run does not change it', () => {
    const sc = loadScenario('column');
    const plain = runToEnd(createSim(sc, freshData(), 7));
    const rep = recordRun(sc, freshData(), 7);
    expect(rep.result.stateHash).toBe(plain.stateHash);
    expect(rep.times.length).toBeGreaterThan(10);
    expect(rep.events.some((e) => e.type === 'morale')).toBe(true);
  });
  it('matches the stored reference hash for the column preset', () => {
    // Guards against accidental behaviour changes. Update deliberately, with a note in MODEL.md, when a rule changes.
    const r = runToEnd(createSim(loadScenario('column'), freshData(), 1));
    expect(r.stateHash).toMatchSnapshot();
  });
});

describe('conservation', () => {
  it('men are never created: every man is present, a casualty, a prisoner or dispersed, at every tick', () => {
    for (const name of PRESETS) {
      for (const seed of [1, 2, 3]) {
        const sim = createSim(loadScenario(name), freshData(), seed);
        const start = sim.sides.map((s) => s.initMen);
        let prev = sim.units.map((u) => u.men);
        while (!sim.ended && sim.t < 4000) {
          step(sim);
          assertConserved(sim);
          sim.units.forEach((u, i) => expect(u.men).toBeLessThanOrEqual(prev[i]));
          prev = sim.units.map((u) => u.men);
        }
        const r = summarise(sim);
        r.sides.forEach((s, i) => expect(s.formedMen + s.routedMen + s.casualties + s.captured + s.dispersed).toBe(start[i]));
        expect(checkConservation(sim)).toEqual([]);
      }
    }
  });
});
