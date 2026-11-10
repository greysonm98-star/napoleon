import { describe, expect, it } from 'vitest';
import { hooks } from '../src/index.ts';
import { createSim, field, freshData, hold, mean, run, unit } from './helpers.ts';

const FR = 'fr_line_battalion';
const GUNS = 'foot_battery';
const hill = { hills: [{ x: 1000, y: 1000, rx: 900, ry: 200, height: 25 }] };

describe('line of sight and elevation', () => {
  /** A battery 700 m south of the crest fires at a battalion 150 m north of it, on the reverse slope. */
  const bombard = (elevationLos: boolean, targetY: number) =>
    mean(10, (seed) => {
      const d = freshData();
      d.morale.routThreshold = -1e9;
      const sc = field({ units: [{ type: GUNS, at: [1000, 1700] }] }, { units: [{ type: FR, at: [1000, targetY], formation: 'line' }] }, { features: { elevationLos } });
      Object.assign(sc.map, hill);
      const sim = createSim(sc, d, seed);
      hold(sim, 'r1');
      run(sim, 600);
      return unit(sim, 'r1').casualties;
    });

  it('a unit on a reverse slope takes no direct fire; without the feature it does', () => {
    expect(bombard(true, 850)).toBe(0);
    expect(bombard(false, 850)).toBeGreaterThan(5);
  });
  it('the same unit on the forward slope is hit', () => {
    expect(bombard(true, 1100)).toBeGreaterThan(5);
  });
  it('a wood between two units blocks the view, but a unit inside a wood sees out', () => {
    const mk = (bluePos: [number, number]) => {
      const sc = field({ units: [{ type: FR, at: bluePos }] }, { units: [{ type: FR, at: [1000, 500] }] }, { features: { elevationLos: true } });
      sc.map.features = [{ type: 'wood', polygon: [[700, 900], [1300, 900], [1300, 1100], [700, 1100]] }];
      const sim = createSim(sc, freshData(), 1);
      return hooks.canSee(sim, unit(sim, 'b1'), unit(sim, 'r1'));
    };
    expect(mk([1000, 1500])).toBe(false); // wood in between
    expect(mk([1000, 1000])).toBe(true); // standing in it
    expect(mk([1800, 1500])).toBe(true); // clear line past its corner
  });
  it('troops climb a steep slope more slowly than the baseline allows, and are not slowed going down', () => {
    const climb = (elevationLos: boolean, fromY: number, toY: number) => {
      const sc = field({ units: [{ type: FR, at: [1000, fromY], formation: 'column' }] }, { units: [{ type: FR, at: [1000, 100] }] }, { features: { elevationLos } });
      sc.map.hills = [{ x: 1000, y: 1000, rx: 900, ry: 200, height: 60 }];
      const sim = createSim(sc, freshData(), 1);
      hold(sim, 'r1');
      const u = hold(sim, 'b1');
      u.order = { type: 'move', target: -1, x: 1000, y: toY, charge: false };
      run(sim, 240); // long enough to face about first
      return Math.abs(u.y - fromY);
    };
    expect(climb(true, 1150, 1000)).toBeLessThan(climb(false, 1150, 1000) * 0.8);
    expect(climb(true, 1000, 1150)).toBeGreaterThan(climb(false, 1000, 1150));
    expect(climb(false, 1000, 1150)).toBeGreaterThan(20);
  });
});
