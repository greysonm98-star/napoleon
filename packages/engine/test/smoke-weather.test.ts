import { describe, expect, it } from 'vitest';
import { smoke } from '../src/index.ts';
import type { Scenario } from '../src/index.ts';
import { assertConserved, createSim, field, freshData, hold, loadScenario, mean, run, unit } from './helpers.ts';

const BR = 'br_line_battalion';
const FR = 'fr_line_battalion';
const weather = (o: Partial<NonNullable<Scenario['weather']>>): Scenario['weather'] => ({ sky: 'clear', ground: 'firm', windFrom: 270, windSpeed: 0, ...o });

/** Casualties inflicted in ten minutes by a line firing at a silent target 80 m away. */
const firefight = (extra: Partial<Scenario>) =>
  mean(20, (seed) => {
    const d = freshData();
    d.morale.routThreshold = -1e9;
    const sim = createSim(field({ units: [{ type: BR, at: [1000, 1080], formation: 'line' }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line' }] }, extra), d, seed);
    hold(sim, 'b1');
    hold(sim, 'r1').reload = 1e9;
    run(sim, 600);
    return unit(sim, 'r1').casualties;
  });

describe('smoke', () => {
  it('sustained fire in still air fouls the view and halves its own effect; a wind clears it', () => {
    const clear = firefight({});
    const still = firefight({ features: { smoke: true }, weather: weather({ windSpeed: 0 }) });
    const windy = firefight({ features: { smoke: true }, weather: weather({ windSpeed: 8, windFrom: 270 }) });
    expect(still).toBeLessThan(clear * 0.7);
    expect(windy).toBeGreaterThan(still * 1.2);
    expect(windy).toBeLessThanOrEqual(clear);
  });
  it('smoke drifts downwind and thins with time', () => {
    const sim = createSim(field({ units: [{ type: BR, at: [1000, 1080], formation: 'line' }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line' }] }, { features: { smoke: true }, weather: weather({ windSpeed: 4, windFrom: 270 }) }), freshData(), 1);
    hold(sim, 'b1');
    hold(sim, 'r1').reload = 1e9;
    run(sim, 120);
    // wind from the west: more smoke 300 m east of the firing line than 300 m west of it
    expect(smoke.densityAt(sim, 1300, 1060)).toBeGreaterThan(smoke.densityAt(sim, 700, 1060) + 0.01);
    unit(sim, 'b1').reload = 1e9;
    const before = smoke.densityAt(sim, 1000, 1060);
    run(sim, 600);
    expect(smoke.densityAt(sim, 1000, 1060)).toBeLessThan(before * 0.2);
  });
});

describe('weather and ground', () => {
  it('rain cuts musketry, heavy rain nearly silences it', () => {
    const dry = firefight({ features: { weatherGround: true }, weather: weather({}) });
    const rain = firefight({ features: { weatherGround: true }, weather: weather({ sky: 'rain' }) });
    const heavy = firefight({ features: { weatherGround: true }, weather: weather({ sky: 'heavy_rain' }) });
    expect(rain).toBeLessThan(dry * 0.75);
    expect(heavy).toBeLessThan(dry * 0.4);
  });
  it('mud halves the effect of roundshot and slows guns far more than infantry', () => {
    const bombard = (ground: 'firm' | 'mud') =>
      mean(20, (seed) => {
        const d = freshData();
        d.morale.routThreshold = -1e9;
        const sim = createSim(field({ units: [{ type: 'foot_battery', at: [1000, 1700] }] }, { units: [{ type: FR, at: [1000, 1000], formation: 'column' }] }, { features: { weatherGround: true }, weather: weather({ ground }) }), d, seed);
        hold(sim, 'r1');
        run(sim, 600);
        return unit(sim, 'r1').casualties;
      });
    const firm = bombard('firm');
    const mud = bombard('mud');
    expect(mud).toBeLessThan(firm * 0.65);
    expect(mud).toBeGreaterThan(firm * 0.35);
    const march = (ground: 'firm' | 'mud', type: string) => {
      const sim = createSim(field({ units: [{ type, at: [1000, 1900], formation: 'column' }] }, { units: [{ type: FR, at: [1000, 100] }] }, { features: { weatherGround: true }, weather: weather({ ground }) }), freshData(), 1);
      hold(sim, 'r1');
      const u = hold(sim, 'b1');
      u.order = { type: 'move', target: -1, x: 1000, y: 1000, charge: false };
      run(sim, 300);
      return 1900 - u.y;
    };
    expect(march('mud', FR) / march('firm', FR)).toBeGreaterThan(0.75);
    expect(march('mud', 'foot_battery') / march('firm', 'foot_battery')).toBeLessThan(0.5);
  });
  it('fog hides the enemy beyond 300 m', () => {
    const fired = (sky: 'clear' | 'fog') => {
      const sim = createSim(field({ units: [{ type: 'foot_battery', at: [1000, 1600] }] }, { units: [{ type: FR, at: [1000, 1000], formation: 'column' }] }, { features: { weatherGround: true }, weather: weather({ sky }) }), freshData(), 1);
      hold(sim, 'r1');
      run(sim, 300);
      return unit(sim, 'r1').casualties;
    };
    expect(fired('clear')).toBeGreaterThan(0);
    expect(fired('fog')).toBe(0);
  });
});

describe('all features together', () => {
  it('conserve men and stay deterministic on every preset', () => {
    const all = { commandControl: true, fatigue: true, ammunition: true, skirmishers: true, quality: true, elevationLos: true, smoke: true, weatherGround: true };
    for (const name of ['pitched', 'column', 'squares', 'battery', 'counter', 'pitched-orders', 'reverse-slope']) {
      const sc = { ...loadScenario(name), features: all, weather: weather({ sky: 'rain', ground: 'soft', windSpeed: 3 }) };
      const a = createSim(sc, freshData(), 11);
      const b = createSim(sc, freshData(), 11);
      run(a, 3000, assertConserved);
      run(b, 3000);
      expect(a.t).toBe(b.t);
      expect(JSON.stringify(a.units.map((u) => [u.x, u.y, u.men, u.morale, u.fatigue, u.ammo]))).toBe(JSON.stringify(b.units.map((u) => [u.x, u.y, u.men, u.morale, u.fatigue, u.ammo])));
    }
  });
});
