import { describe, expect, it } from 'vitest';
import { setFormation } from '../src/index.ts';
import { createSim, field, freshData, hold, mean, run, unit } from './helpers.ts';

const FR = 'fr_line_battalion';
const duel = (quality: boolean, a: string, b: string) =>
  mean(30, (seed) => {
    const d = freshData();
    d.morale.routThreshold = -1e9;
    const sim = createSim(field({ units: [{ type: FR, at: [1000, 1090], formation: 'line', quality: a }] }, { units: [{ type: FR, at: [1000, 1000], formation: 'line', quality: b }] }, { features: { quality } }), d, seed);
    hold(sim, 'b1');
    hold(sim, 'r1');
    run(sim, 600);
    return unit(sim, 'r1').casualties / Math.max(1, unit(sim, 'b1').casualties);
  });

describe('quality', () => {
  it('with the toggle off, class changes steadiness only: guard and militia shoot alike', () => {
    const r = duel(false, 'guard', 'militia');
    expect(r).toBeGreaterThan(0.85);
    expect(r).toBeLessThan(1.15);
  });
  it('with it on, guards outshoot militia', () => {
    expect(duel(true, 'guard', 'militia')).toBeGreaterThan(1.4);
  });
  it('raw troops take longer to form square', () => {
    const t = (q: string) => {
      const sim = createSim(field({ units: [{ type: FR, at: [1000, 1500], formation: 'line', quality: q }] }, { units: [{ type: FR, at: [1000, 100] }] }, { features: { quality: true } }), freshData(), 1);
      hold(sim, 'r1');
      setFormation(sim, hold(sim, 'b1'), 'square');
      return unit(sim, 'b1').formT;
    };
    expect(t('militia')).toBeGreaterThan(t('line') * 1.4);
    expect(t('guard')).toBeLessThan(t('line'));
  });
});
