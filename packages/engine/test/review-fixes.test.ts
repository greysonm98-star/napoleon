// Regression tests for defects found in review. Each failed before its fix.
import { describe, expect, it } from 'vitest';
import * as engine from '../src/index.ts';
import type { Scenario } from '../src/index.ts';
import { assertConserved, attack, createSim, field, freshData, hold, rate, run, unit } from './helpers.ts';

const INF = 'fr_line_battalion';
const BR = 'br_line_battalion';
type Cmd = { byId: Map<string, { order: { type: string; objX: number } | null; x: number; y: number }> };
const cmd = (sim: { ext: Record<string, unknown> }) => sim.ext.command as Cmd;

function brigade(orders: Scenario['sides'][0]['orders'], extra: Partial<Scenario> = {}): Scenario {
  const sc = field({ units: [{ type: INF, at: [900, 1700], formation: 'column' }, { type: INF, at: [1100, 1700], formation: 'column' }] }, { units: [{ type: BR, at: [1000, 100] }] }, { features: { commandControl: true }, ...extra });
  Object.assign(sc.sides[0], { command: { id: 'hq', level: 'corps', commander: { name: 'HQ', at: [1000, 1950] }, children: [{ id: 'bde', level: 'brigade', commander: { name: 'Bde' }, units: ['b1', 'b2'] }] }, orders });
  return sc;
}

describe('orders', () => {
  it('a later order is never overtaken by an earlier one', () => {
    const newerWins = rate(40, (seed) => {
      const d = freshData();
      (d.command as Record<string, number>).courierLossChance = 0;
      const sim = createSim(brigade([{ at: 0, to: 'hq', type: 'hold' }, { at: 60, to: 'bde', type: 'move', objective: [600, 1400] }, { at: 80, to: 'bde', type: 'move', objective: [1400, 1400] }]), d, seed);
      hold(sim, 'r1');
      run(sim, 1500);
      return cmd(sim).byId.get('bde')!.order!.objX === 1400;
    });
    expect(newerWins).toBe(1);
  });

  it('a lost courier delays an order but it still arrives', () => {
    const d = freshData();
    const c = d.command as Record<string, number>;
    c.courierLossChance = 1; // the first rider is always lost; the repeat is a fresh draw at the same odds
    c.resendTime = 100;
    const sim = createSim(brigade([{ at: 0, to: 'hq', type: 'hold' }, { at: 60, to: 'bde', type: 'move', objective: [1000, 1400] }]), d, 3);
    hold(sim, 'r1');
    run(sim, 400);
    expect(sim.events.some((e) => e.type === 'courier_lost')).toBe(true);
    expect(cmd(sim).byId.get('bde')!.order!.type).toBe('hold'); // every rider so far has been lost
    c.courierLossChance = 0;
    run(sim, 600);
    expect(cmd(sim).byId.get('bde')!.order!.type).toBe('move');
    expect(unit(sim, 'b1').y).toBeLessThan(1650);
  });

  it('a formation ends centred on its objective even if the order reached it late and on the march', () => {
    const d = freshData();
    (d.command as Record<string, number>).courierLossChance = 0;
    // marching north under orders of the day when a new destination is sent after them
    const sim = createSim(brigade([{ at: 0, to: 'hq', type: 'move', objective: [1000, 600] }, { at: 30, to: 'bde', type: 'move', objective: [1500, 1300] }]), d, 2);
    hold(sim, 'r1');
    run(sim, 2400);
    const cx = (unit(sim, 'b1').x + unit(sim, 'b2').x) / 2;
    const cy = (unit(sim, 'b1').y + unit(sim, 'b2').y) / 2;
    expect(Math.abs(cx - 1500)).toBeLessThan(35);
    expect(Math.abs(cy - 1300)).toBeLessThan(35);
  });

  it('when a superior’s temporary order lapses, each subordinate goes back to its own orders', () => {
    const d = freshData();
    const c = d.command as Record<string, number>;
    c.courierLossChance = 0;
    c.counterattackTime = 600;
    c.commanderRiskPerSecond = 0;
    const sc = field({ units: [{ type: INF, at: [900, 1200], formation: 'line' }, { type: INF, at: [1500, 1500], formation: 'column' }] }, { units: [{ type: BR, at: [900, 1090], formation: 'line' }, { type: BR, at: [300, 200] }, { type: BR, at: [1700, 200] }] }, { features: { commandControl: true } });
    Object.assign(sc.sides[0], {
      command: { id: 'hq', level: 'corps', commander: { name: 'HQ', at: [1000, 1900] }, children: [{ id: 'div', level: 'division', commander: { name: 'Div', initiative: 1 }, children: [{ id: 'b-one', level: 'brigade', commander: { name: 'One', initiative: 0 }, units: ['b1'] }, { id: 'b-two', level: 'brigade', commander: { name: 'Two', initiative: 0 }, units: ['b2'] }] }] },
      orders: [{ at: 0, to: 'div', type: 'hold' }, { at: 0, to: 'b-two', type: 'reserve' }],
    });
    const sim = createSim(sc, d, 1);
    for (const id of ['r1', 'r2', 'r3']) hold(sim, id).reload = 1e9;
    hold(sim, 'b1').reload = 1e9;
    unit(sim, 'b1').manual = false;
    unit(sim, 'r1').morale = 40; // a shaken enemy 100 m from the division: the divisional commander will counter-attack
    sim.data.morale.recoveryRate = 0;
    sim.data.morale.routThreshold = -1e9;
    let attacked = false;
    let twoAfter = '';
    let twoDuring = '';
    run(sim, 1500, () => {
      const div = cmd(sim).byId.get('div')!.order!.type;
      const two = cmd(sim).byId.get('b-two')!.order!.type;
      if (div === 'attack') attacked = true;
      if (two === 'attack') twoDuring = two;
      // the first moment the division is back on "hold" after its counter-attack (it may go again later)
      if (attacked && div === 'hold' && !twoAfter && twoDuring) twoAfter = two;
    });
    expect(attacked).toBe(true);
    expect(twoDuring).toBe('attack'); // the brigade did receive the temporary order
    expect(twoAfter).toBe('reserve'); // and went back to its own, not to the division's "hold"
  });

  it('a quiet field does not end as a stalemate before a scheduled order is due', () => {
    const sim = createSim(brigade([{ at: 0, to: 'hq', type: 'hold' }, { at: 1500, to: 'bde', type: 'move', objective: [1000, 1300] }], { stallLimit: 600 }), freshData(), 1);
    hold(sim, 'r1');
    run(sim, 2400);
    expect(sim.events.some((e) => e.type === 'order_active')).toBe(true);
  });

  it('rejects orders and formations that name things that do not exist', () => {
    const mk = (orders: Scenario['sides'][0]['orders']) => () => createSim(brigade(orders), freshData(), 1);
    expect(mk([{ at: 0, to: 'bde', type: 'support', target: 'ghost' }])).toThrow(/unknown formation 'ghost'/);
    expect(mk([{ when: { unitRouted: 'nobody' }, to: 'bde', type: 'attack' }])).toThrow(/unknown unit 'nobody'/);
    expect(mk([{ when: { formationBroken: 'ghost' }, to: 'bde', type: 'attack' }])).toThrow(/unknown formation 'ghost'/);
    const sc = brigade([{ at: 0, to: 'hq', type: 'hold' }]);
    sc.sides[0].command!.children![0].units = ['b1', 'phantom'];
    expect(() => createSim(sc, freshData(), 1)).toThrow(/unknown unit 'phantom'/);
  });

  it('a change of posture from outside becomes an order through the chain', () => {
    const sim = createSim(brigade([{ at: 0, to: 'hq', type: 'hold' }]), freshData(), 1);
    hold(sim, 'r1');
    run(sim, 10);
    const y0 = unit(sim, 'b1').y;
    sim.inputs.length = 0;
    engine.applyInput(sim, { kind: 'posture', side: 'blue', posture: 'attack_column' });
    run(sim, 30);
    expect(unit(sim, 'b1').y).toBe(y0); // not yet: the order is still with the staff
    run(sim, 1500);
    expect(unit(sim, 'b1').y).toBeLessThan(y0 - 100);
  });
});

describe('baseline rules', () => {
  it('a battalion in melee does not start changing formation', () => {
    const changed = rate(20, (seed) => {
      // red line locked in melee with a blue column; blue cavalry then comes within square-forming distance
      const sim = createSim(field({ units: [{ type: INF, at: [1000, 1030], formation: 'column' }, { type: 'cavalry_squadron', at: [1250, 1150] }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line' }] }), freshData(), seed, { events: 'full' });
      sim.data.morale.routThreshold = -1e9;
      attack(sim, 'b1', 'r1');
      hold(sim, 'b2');
      run(sim, 60);
      return sim.events.some((e) => e.type === 'formation' && e.unit === 'r1');
    });
    expect(changed).toBe(0);
  });

  it('about 70% of pursuit losses are prisoners, for infantry pursuers as for cavalry', () => {
    const share = (pursuer: string) => {
      const sim = createSim(field({ units: [{ type: INF, at: [1000, 1000] }, { type: INF, at: [100, 1900] }, { type: INF, at: [1900, 1900] }] }, { units: [{ type: pursuer, at: [1000, 985], formation: 'column' }] }), freshData(), 1);
      for (const u of sim.units) hold(sim, u.id).reload = 1e9;
      sim.data.morale.destroyedFraction = 0;
      const b = unit(sim, 'b1');
      b.morale = 0;
      attack(sim, 'r1', 'b1');
      run(sim, 60, assertConserved);
      return b.captured / Math.max(1, b.captured + b.casualties);
    };
    expect(share(BR)).toBeGreaterThan(0.6);
    expect(share(BR)).toBeLessThan(0.8);
    expect(share('cavalry_squadron')).toBeGreaterThan(0.6);
    expect(share('cavalry_squadron')).toBeLessThan(0.8);
  });

  it('refuses a unit with no men', () => {
    expect(() => createSim(field({ units: [{ type: 'foot_battery', at: [1000, 1500], men: 0 }] }, { units: [{ type: BR, at: [1000, 500] }] }), freshData(), 1)).toThrow(/at least 1/);
  });
});

describe('features', () => {
  it('skirmishers out still count toward a battalion’s strength', () => {
    const sim = createSim(field({ units: [{ type: 'br_rifle_battalion', at: [1000, 1400], formation: 'line' }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line' }] }, { features: { skirmishers: true } }), freshData(), 1);
    hold(sim, 'r1').reload = 1e9;
    const b = hold(sim, 'b1');
    b.men = 140; // weak, but well above the 12% line
    b.casualties = 460;
    run(sim, 30, assertConserved);
    expect(b.skirmishers).toBeGreaterThan(0);
    expect(b.status).toBe('ok');
    const total = engine.summarise(sim).sides[0];
    expect(total.formedMen + total.routedMen + total.casualties + total.captured + total.dispersed).toBe(total.startMen);
  });

  it('a scenario cannot put a whole battalion out as skirmishers', () => {
    const sim = createSim(field({ units: [{ type: INF, at: [1000, 1400], formation: 'line', skirmishers: 590 }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line' }] }, { features: { skirmishers: true } }), freshData(), 1);
    hold(sim, 'r1').reload = 1e9;
    const b = hold(sim, 'b1');
    run(sim, 30, assertConserved);
    expect(b.status).toBe('ok');
    expect(b.skirmishers).toBe(360); // 60% of 600
  });

  it('the first-volley bonus is given once, not again after resupply', () => {
    const sim = createSim(field({ units: [{ type: BR, at: [1000, 1900] }] }, { units: [{ type: BR, at: [1000, 100] }] }, { features: { ammunition: true } }), freshData(), 1);
    hold(sim, 'r1');
    const u = hold(sim, 'b1');
    const f = () => engine.hooks.musketFactor(sim, u, unit(sim, 'r1'), 80);
    expect(f()).toBeCloseTo(1.5, 6);
    engine.hooks.onFired(sim, u, 'musket', 540, 80);
    u.ammo = 2;
    expect(f()).toBeLessThan(1.01);
    run(sim, 700); // resupplied from the reserve; barrels cleaned
    expect(u.ammo).toBe(30);
    expect(f()).toBeCloseTo(1, 6);
  });

  it('rain and poor quality weaken skirmish fire as they do volleys', () => {
    const loss = (extra: Partial<Scenario>, quality = 'line') => {
      let total = 0;
      for (let seed = 1; seed <= 15; seed++) {
        const d = freshData();
        d.morale.routThreshold = -1e9;
        const sim = createSim(field({ units: [{ type: INF, at: [1000, 1280], formation: 'line', quality }] }, { units: [{ type: BR, at: [1000, 1000], formation: 'line', skirmishers: 0 }] }, { features: { skirmishers: true }, ...extra }), d, seed);
        hold(sim, 'r1').reload = 1e9;
        hold(sim, 'b1');
        run(sim, 600);
        total += unit(sim, 'r1').casualties;
      }
      return total;
    };
    const dry = loss({});
    expect(loss({ features: { skirmishers: true, weatherGround: true }, weather: { sky: 'heavy_rain', ground: 'firm', windFrom: 0, windSpeed: 0 } })).toBeLessThan(dry * 0.5);
    expect(loss({ features: { skirmishers: true, quality: true } }, 'militia')).toBeLessThan(dry * 0.95);
  });
});
