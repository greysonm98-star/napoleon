import { describe, expect, it } from 'vitest';
import { assertConserved, createSim, field, freshData, hold, loadScenario, mean, run, unit } from './helpers.ts';

const FR = 'fr_line_battalion';
const BR = 'br_line_battalion';
const on = { features: { skirmishers: true } };

describe('skirmishers', () => {
  it('a battalion throws out its light company when the enemy is near, and takes it back when he closes', () => {
    const sim = createSim(field({ units: [{ type: FR, at: [1000, 1400], formation: 'line' }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line' }] }, on), freshData(), 1);
    hold(sim, 'r1');
    const b = hold(sim, 'b1');
    run(sim, 10);
    expect(b.skirmishers).toBe(96); // one company in six
    expect(b.men).toBe(504);
    expect(b.detached).toBe(96);
    assertConserved(sim);
    b.order = { type: 'move', target: -1, x: 1000, y: 1150, charge: false };
    run(sim, 400, assertConserved);
    expect(b.skirmishers).toBe(0);
    expect(b.detached).toBe(0);
  });

  it('an unopposed screen wears a formed battalion down slowly', () => {
    const loss = mean(20, (seed) => {
      const d = freshData();
      d.morale.routThreshold = -1e9;
      const sim = createSim(field({ units: [{ type: FR, at: [1000, 1280], formation: 'line' }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line', skirmishers: 0 }] }, on), d, seed);
      hold(sim, 'r1');
      hold(sim, 'b1');
      run(sim, 600);
      return unit(sim, 'r1').casualties;
    });
    expect(loss).toBeGreaterThan(15);
    expect(loss).toBeLessThan(80); // a few percent in ten minutes, not a volley's worth each minute
  });

  it('an opposing screen shields the battalion behind it', () => {
    const lossWith = (redScreen: number | undefined) =>
      mean(20, (seed) => {
        const d = freshData();
        d.morale.routThreshold = -1e9;
        const sim = createSim(field({ units: [{ type: FR, at: [1000, 1280], formation: 'line' }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line', skirmishers: redScreen }] }, on), d, seed);
        hold(sim, 'r1');
        hold(sim, 'b1');
        run(sim, 600);
        return unit(sim, 'r1').casualties;
      });
    expect(lossWith(96)).toBeLessThan(lossWith(0) * 0.4);
  });

  it('skirmishers run in from cavalry', () => {
    const sim = createSim(field({ units: [{ type: FR, at: [1000, 1400], formation: 'line' }] }, { units: [{ type: BR, at: [1000, 1000] }, { type: 'cavalry_squadron', at: [1300, 1300] }] }, on), freshData(), 1);
    for (const id of ['b1', 'r1', 'r2']) hold(sim, id);
    run(sim, 20);
    expect(unit(sim, 'b1').skirmishers).toBe(0);
  });

  it('a screen picks off gunners, and men are conserved throughout a full battle', () => {
    const d = freshData();
    d.morale.routThreshold = -1e9;
    d.weapons.guns.field_8pdr.canisterRange = 0;
    const sim = createSim(field({ units: [{ type: 'fr_light_battalion', at: [1000, 1290], formation: 'line' }] }, { units: [{ type: 'foot_battery', at: [1000, 1000] }] }, on), d, 1);
    hold(sim, 'b1');
    hold(sim, 'r1').reload = 1e9;
    run(sim, 900);
    expect(unit(sim, 'r1').casualties).toBeGreaterThan(10);
    const full = createSim({ ...loadScenario('pitched'), features: { skirmishers: true } }, freshData(), 5);
    run(full, 4000, assertConserved);
  });
});
