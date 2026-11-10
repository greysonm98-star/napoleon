import { describe, expect, it } from 'vitest';
import { command, createSim, runToEnd, stateHash, step } from '../src/index.ts';
import type { Scenario } from '../src/index.ts';
import { field, freshData, hold, loadScenario, rate, run, unit } from './helpers.ts';

const INF = 'fr_line_battalion';
const CAV = 'cavalry_squadron';

/** Blue: a headquarters at hqY and one brigade of two battalions at y = 1500. Red: one battalion far to the north. */
function chain(hqY: number, extra: Partial<Scenario['sides'][0]> = {}): Scenario {
  const sc = field({ units: [{ type: INF, at: [900, 1500], formation: 'column' }, { type: INF, at: [1100, 1500], formation: 'column' }] }, { units: [{ type: 'br_line_battalion', at: [1000, 100] }] }, { features: { commandControl: true } });
  Object.assign(sc.sides[0], {
    command: { id: 'hq', level: 'corps', commander: { name: 'HQ', at: [1000, hqY] }, children: [{ id: 'bde', level: 'brigade', commander: { name: 'Bde' }, units: ['b1', 'b2'] }] },
    orders: [
      { at: 0, to: 'hq', type: 'hold' },
      { at: 60, to: 'bde', type: 'move', objective: [1000, 1000] },
    ],
    ...extra,
  });
  return sc;
}

const firstMove = (sc: Scenario, seed = 1): number => {
  const sim = createSim(sc, freshData(), seed);
  hold(sim, 'r1');
  const y0 = unit(sim, 'b1').y;
  while (!sim.ended && sim.t < 3000) {
    step(sim);
    if (unit(sim, 'b1').y < y0 - 1) return sim.t;
  }
  return Infinity;
};

describe('command and control', () => {
  it('an order takes time: staff delay, a ride, and the brigadier’s own delay', () => {
    const d = freshData();
    const t = firstMove(chain(1900));
    // issued at 60 s; cannot possibly take effect before the minimum of the three delays
    const c = d.command as Record<string, number>;
    const least = 60 + c.staffDelayCorps * (1 - c.delayJitter) + c.staffDelayBrigade * (1 - c.delayJitter);
    expect(t).toBeGreaterThan(least);
    expect(t).toBeLessThan(60 + 1200);
  });

  it('an order arrives later when the commander is farther away', () => {
    const d = freshData();
    (d.command as Record<string, number>).courierLossChance = 0;
    const run1 = (hqY: number) => {
      const sim = createSim(chain(hqY), d, 5);
      hold(sim, 'r1');
      run(sim, 1500);
      return sim.events.find((e) => e.type === 'order_received')!.t - sim.events.find((e) => e.type === 'order_sent')!.t;
    };
    const near = run1(1650);
    const far = run1(1950);
    expect(far).toBeGreaterThan(near + 40); // 300 m more at 5 m/s is 60 s
  });

  it('orders "at 0" are already in hand when the action opens', () => {
    const sc = chain(1900);
    sc.sides[0].orders = [{ at: 0, to: 'bde', type: 'move', objective: [1000, 1000] }];
    expect(firstMove(sc)).toBeLessThan(15);
  });

  it('a unit outside every command radius does not receive a new order until it comes back inside one', () => {
    const sc = chain(1900);
    sc.sides[0].units![1].at = [1900, 1500]; // b2 strays 700 m from the brigadier
    sc.sides[0].units!.push({ id: 'b3', type: INF, at: [800, 1500], formation: 'column' });
    sc.sides[0].command!.children![0].units = ['b1', 'b2', 'b3'];
    (sc.sides[0].command!.children![0].commander as { radius?: number }).radius = 450;
    (sc.sides[0].command!.commander as { radius?: number }).radius = 300;
    const sim = createSim(sc, freshData(), 1);
    hold(sim, 'r1');
    run(sim, 900);
    expect(unit(sim, 'b1').y).toBeLessThan(1400); // b1 marched
    expect(unit(sim, 'b2').y).toBe(1500); // b2 never heard
    expect(unit(sim, 'b2').inCommand).toBe(false);
    expect(command.inCommand(sim, unit(sim, 'b1'))).toBe(true);
  });

  it('cavalry held in reserve charges a disordered enemy only if its commander has initiative', () => {
    const go = (init: number) =>
      rate(30, (seed) => {
        const sc = field({ units: [{ type: CAV, at: [1000, 1400] }, { type: CAV, at: [1100, 1400] }] }, { units: [{ type: 'br_line_battalion', at: [1000, 1050], formation: 'line' }, { type: 'br_line_battalion', at: [300, 300] }, { type: 'br_line_battalion', at: [1700, 300] }] }, { features: { commandControl: true } });
        Object.assign(sc.sides[0], {
          command: { id: 'hq', level: 'corps', commander: { name: 'HQ', at: [1000, 1800] }, children: [{ id: 'cav', level: 'brigade', commander: { name: 'Cav', initiative: init }, units: ['b1', 'b2'] }] },
          orders: [{ at: 0, to: 'hq', type: 'reserve' }],
        });
        const sim = createSim(sc, freshData(), seed, { events: 'full' });
        for (const id of ['r1', 'r2', 'r3']) hold(sim, id);
        unit(sim, 'r1').morale = 40; // shaken, and held in line
        unit(sim, 'r1').reload = 1e9;
        sim.data.morale.recoveryRate = 0;
        run(sim, 600);
        return sim.events.some((e) => e.type === 'contact' && e.target === 'r1');
      });
    expect(go(0)).toBe(0);
    expect(go(1)).toBeGreaterThan(0.9);
  });

  it('losing a commander shakes his troops and leaves them out of command until he is replaced', () => {
    const d = freshData();
    const c = d.command as Record<string, number>;
    c.commanderRiskPerSecond = 1; // certain, once exposed
    c.commanderRiskRange = 5000;
    const sim = createSim(chain(1900), d, 1);
    hold(sim, 'r1');
    const m0 = unit(sim, 'b1').morale;
    run(sim, 10);
    expect(sim.events.some((e) => e.type === 'commander_down')).toBe(true);
    expect(unit(sim, 'b1').morale).toBeLessThan(m0);
    expect(unit(sim, 'b1').inCommand).toBe(false);
  });

  it('is deterministic, and with the toggle off the baseline is untouched', () => {
    const sc = loadScenario('pitched-orders');
    const a = runToEnd(createSim(sc, freshData(), 9));
    const b = runToEnd(createSim(sc, freshData(), 9));
    expect(a.stateHash).toBe(b.stateHash);
    // pinned: the documented numbers for this scenario are stale if this moves (tools/rerun-documented-numbers.sh)
    expect(a.stateHash).toMatchSnapshot();
    const off = loadScenario('pitched');
    const on = structuredClone(off);
    on.features = { ...on.features, commandControl: true };
    const s1 = createSim(off, freshData(), 4);
    const s2 = createSim(on, freshData(), 4);
    expect(s1.ext.command).toBeUndefined();
    expect(s2.ext.command).toBeDefined();
    for (let i = 0; i < 200; i++) step(s1);
    expect(stateHash(s1)).toMatchSnapshot(); // pinned baseline: must not move when features are added
  });
});
