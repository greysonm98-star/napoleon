import { describe, expect, it } from 'vitest';
import { createSim, field, freshData, hold, mean, run, unit } from './helpers.ts';

const INF = 'fr_line_battalion';
const BR = 'br_line_battalion';

describe('fatigue', () => {
  const march = (fatigue: boolean) => {
    const sim = createSim(field({ units: [{ type: INF, at: [1000, 1900], formation: 'column' }] }, { units: [{ type: BR, at: [1000, 100] }] }, { features: { fatigue } }), freshData(), 1);
    hold(sim, 'r1');
    const u = hold(sim, 'b1');
    u.order = { type: 'move', target: -1, x: 1000, y: 700, charge: false };
    run(sim, 900);
    return u;
  };
  it('marching tires a unit and tired units move slower; rest restores them', () => {
    const fresh = march(false);
    const tired = march(true);
    expect(fresh.fatigue).toBe(0);
    expect(tired.fatigue).toBeGreaterThan(0.04);
    expect(tired.y).toBeGreaterThan(fresh.y); // covered less ground
    const sim = createSim(field({ units: [{ type: INF, at: [1000, 1900] }] }, { units: [{ type: BR, at: [1000, 100] }] }, { features: { fatigue: true } }), freshData(), 1);
    hold(sim, 'r1');
    const u = hold(sim, 'b1');
    u.fatigue = 0.5;
    run(sim, 600);
    expect(u.fatigue).toBeLessThan(0.3);
    expect(u.fatigue).toBeGreaterThan(0.2);
  });
  it('a tired battalion does less harm in a melee', () => {
    const fight = (fatigue: number) =>
      mean(10, (seed) => {
        const d = freshData();
        d.morale.routThreshold = -1e9;
        const sim = createSim(field({ units: [{ type: INF, at: [1000, 1012], formation: 'line' }] }, { units: [{ type: INF, at: [1000, 1000], formation: 'line' }] }, { features: { fatigue: true } }), d, seed);
        hold(sim, 'r1').reload = 1e9;
        const b = hold(sim, 'b1');
        b.reload = 1e9;
        b.fatigue = fatigue;
        b.order = { type: 'attack', target: unit(sim, 'r1').idx, x: 0, y: 0, charge: true };
        run(sim, 40);
        return unit(sim, 'r1').casualties;
      });
    expect(fight(0)).toBeGreaterThan(20);
    expect(fight(0.9)).toBeLessThan(fight(0) * 0.8);
  });
});

describe('ammunition', () => {
  it('a battalion fires until its pouches are empty, then stops; the first volley is the best', () => {
    const d = freshData();
    d.morale.routThreshold = -1e9;
    d.morale.destroyedFraction = 0;
    const sim = createSim(field({ units: [{ type: BR, at: [1000, 1080], formation: 'line' }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line' }] }, { features: { ammunition: true } }), d, 2, { events: 'full' });
    hold(sim, 'b1');
    hold(sim, 'r1').reload = 1e9; // red holds its fire and stands as a target
    run(sim, 3500);
    const volleys = sim.events.filter((e) => e.type === 'fire' && e.unit === 'b1');
    // two-deep line: every man fires each volley, 60 rounds a man
    expect(volleys.length).toBeGreaterThanOrEqual(58);
    expect(volleys.length).toBeLessThanOrEqual(62);
    expect(unit(sim, 'b1').ammo).toBeLessThan(1);
    const last = volleys[volleys.length - 1].t;
    run(sim, 300);
    expect(sim.events.filter((e) => e.type === 'fire' && e.unit === 'b1' && e.t > last).length).toBe(0);
    // fouling: the last ten volleys come more slowly than the first ten
    const span = (a: number, b: number) => volleys[b].t - volleys[a].t;
    expect(span(volleys.length - 11, volleys.length - 1)).toBeGreaterThan(span(0, 10) * 1.2);
  });
  it('the first volley hits harder than later ones', () => {
    const first = mean(40, (seed) => {
      const d = freshData();
      d.morale.routThreshold = -1e9;
      const sim = createSim(field({ units: [{ type: BR, at: [1000, 1080], formation: 'line' }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line' }] }, { features: { ammunition: true } }), d, seed, { events: 'full' });
      hold(sim, 'b1');
      hold(sim, 'r1').reload = 1e9;
      run(sim, 200);
      const v = sim.events.filter((e) => e.type === 'fire' && e.unit === 'b1');
      return (v[0].loss as number) - ((v[1].loss as number) + (v[2].loss as number)) / 2;
    });
    expect(first).toBeGreaterThan(1);
  });
  it('a battery runs out of canister and falls back on roundshot', () => {
    const d = freshData();
    d.morale.routThreshold = -1e9;
    d.morale.destroyedFraction = 0;
    const sim = createSim(field({ units: [{ type: 'foot_battery', at: [1000, 1250] }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line' }] }, { features: { ammunition: true } }), d, 2, { events: 'full' });
    hold(sim, 'r1').reload = 1e9;
    run(sim, 1500);
    const shots = sim.events.filter((e) => e.type === 'fire' && e.unit === 'b1');
    const can = shots.filter((e) => e.kind === 'canister');
    expect(can.length).toBe(20);
    expect(shots.slice(20).every((e) => e.kind === 'roundshot')).toBe(true);
    expect(unit(sim, 'b1').gunCanister).toBeLessThan(1);
  });
  it('a battalion out of contact is resupplied once from its reserve', () => {
    const sim = createSim(field({ units: [{ type: BR, at: [1000, 1900] }] }, { units: [{ type: BR, at: [1000, 100] }] }, { features: { ammunition: true } }), freshData(), 1);
    hold(sim, 'r1');
    const u = hold(sim, 'b1');
    u.ammo = 2;
    run(sim, 700);
    expect(u.ammo).toBe(30);
    u.ammo = 2;
    run(sim, 700);
    expect(u.ammo).toBe(2);
  });
});
