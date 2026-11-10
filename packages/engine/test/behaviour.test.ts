// One behavioural test per core tradeoff. Each runs over many seeds and states its pass rate.
import { describe, expect, it } from 'vitest';
import { setDims, refreshGeom, baseSpeed } from '../src/index.ts';
import type { Sim } from '../src/index.ts';
import { attack, createSim, field, freshData, hold, mean, rate, run, unit } from './helpers.ts';

const INF_FR = 'fr_line_battalion';
const INF_BR = 'br_line_battalion';
const CAV = 'cavalry_squadron';
const GUNS = 'foot_battery';
const SEEDS = 40;

function reform(sim: Sim, id: string): void {
  const u = unit(sim, id);
  setDims(u);
  refreshGeom(u);
}

describe('square, line and cavalry', () => {
  it('a steady square repels cavalry (every time)', () => {
    const held = rate(SEEDS, (seed) => {
      const sim = createSim(field({ units: [{ type: CAV, at: [1000, 1400] }, { type: CAV, at: [1100, 1400] }] }, { units: [{ type: INF_BR, at: [1000, 1000], formation: 'square' }] }), freshData(), seed);
      hold(sim, 'r1');
      attack(sim, 'b1', 'r1');
      attack(sim, 'b2', 'r1');
      run(sim, 600);
      return unit(sim, 'r1').status === 'ok' && unit(sim, 'r1').form === 'square' && unit(sim, 'r1').men > 560;
    });
    expect(held).toBe(1);
  });

  it('the cavalry recoils from the square blown and shaken', () => {
    const sim = createSim(field({ units: [{ type: CAV, at: [1000, 1300] }] }, { units: [{ type: INF_BR, at: [1000, 1000], formation: 'square' }] }), freshData(), 3);
    hold(sim, 'r1');
    const cav = attack(sim, 'b1', 'r1');
    const m0 = cav.morale;
    run(sim, 120);
    expect(cav.blown).toBeGreaterThan(0);
    expect(cav.morale).toBeLessThan(m0);
    expect(cav.y).toBeGreaterThan(1100); // fell back
  });

  const lineVsCav = (seed: number, cavAt: [number, number]) => {
    // red line at (1000,1000) facing south; the squadron comes from the given point
    const sim = createSim(field({ units: [{ type: CAV, at: cavAt }] }, { units: [{ type: INF_BR, at: [1000, 1000], formation: 'line' }] }), freshData(), seed);
    hold(sim, 'r1');
    attack(sim, 'b1', 'r1');
    run(sim, 420);
    return sim;
  };

  it('cavalry breaks a line taken in flank (at least 95% of runs), and does far worse frontally', () => {
    const flank = rate(SEEDS, (seed) => unit(lineVsCav(seed, [1250, 1000]), 'r1').status !== 'ok');
    const front = rate(SEEDS, (seed) => unit(lineVsCav(seed, [1000, 1400]), 'r1').status !== 'ok');
    expect(flank).toBeGreaterThanOrEqual(0.95);
    expect(front).toBeLessThan(flank - 0.3);
  });

  it('a line caught changing formation is ridden down', () => {
    const broke = rate(SEEDS, (seed) => {
      const sim = createSim(field({ units: [{ type: CAV, at: [1000, 1250] }] }, { units: [{ type: INF_BR, at: [1000, 1000], formation: 'line' }] }), freshData(), seed);
      const inf = hold(sim, 'r1');
      inf.formT = 90; // mid-evolution
      attack(sim, 'b1', 'r1');
      run(sim, 240);
      return inf.status !== 'ok';
    });
    expect(broke).toBeGreaterThanOrEqual(0.95);
  });

  it('infantry left to itself forms square when cavalry comes for it, and holds', () => {
    const held = rate(SEEDS, (seed) => {
      const sim = createSim(field({ posture: 'attack_line', units: [{ type: CAV, at: [1000, 1700] }, { type: CAV, at: [1150, 1700] }] }, { units: [{ type: INF_BR, at: [1000, 1000], formation: 'line' }] }), freshData(), seed);
      attack(sim, 'b1', 'r1');
      attack(sim, 'b2', 'r1');
      let squared = false;
      run(sim, 600, () => {
        if (unit(sim, 'r1').form === 'square') squared = true;
      });
      return squared && unit(sim, 'r1').status === 'ok';
    });
    expect(held).toBeGreaterThanOrEqual(0.95);
  });

  it('blown cavalry loses to fresh cavalry (at least 80% of runs)', () => {
    const freshWins = rate(SEEDS, (seed) => {
      const sim = createSim(field({ units: [{ type: CAV, at: [1000, 1250] }] }, { units: [{ type: CAV, at: [1000, 1000] }] }), freshData(), seed);
      const tired = hold(sim, 'r1');
      tired.blown = 600;
      attack(sim, 'b1', 'r1');
      run(sim, 400);
      return tired.status !== 'ok' && unit(sim, 'b1').status === 'ok';
    });
    expect(freshWins).toBeGreaterThanOrEqual(0.8);
  });
});

describe('artillery', () => {
  /** Mean casualties a battery inflicts in five minutes on one halted battalion. */
  const bombard = (range: number, formation: 'line' | 'column' | 'square', tweak?: (d: ReturnType<typeof freshData>) => void, type = INF_FR) =>
    mean(SEEDS, (seed) => {
      const d = freshData();
      tweak?.(d);
      d.morale.routThreshold = -1e9; // hold the target in place so only the gunnery is measured
      d.morale.destroyedFraction = 0;
      const sim = createSim(field({ units: [{ type: GUNS, at: [1000, 1000 + range] }] }, { units: [{ type, at: [1000, 1000], formation }] }), d, seed);
      hold(sim, 'r1');
      reform(sim, 'r1');
      run(sim, 300);
      return unit(sim, 'r1').casualties;
    });

  it('canister outperforms roundshot inside canister range (by more than 2x at 250 m)', () => {
    const canister = bombard(250, 'line');
    const roundshot = bombard(250, 'line', (d) => {
      d.weapons.guns.field_8pdr.canisterRange = 0;
    });
    expect(roundshot).toBeGreaterThan(5);
    expect(canister).toBeGreaterThan(roundshot * 2);
  });

  it('roundshot hurts a column more than a line, and a square most of all', () => {
    const line = bombard(700, 'line');
    const column = bombard(700, 'column');
    const square = bombard(700, 'square');
    expect(column).toBeGreaterThan(line * 1.8);
    expect(square).toBeGreaterThan(column);
  });

  it('a two-deep line suffers less from roundshot than a three-deep one', () => {
    expect(bombard(700, 'line', undefined, INF_BR)).toBeLessThan(bombard(700, 'line', undefined, INF_FR) * 0.8);
  });

  it('roundshot effect falls with range', () => {
    expect(bombard(1100, 'line')).toBeLessThan(bombard(600, 'line') * 0.5);
  });

  it('guns are helpless once infantry reaches them', () => {
    const lost = rate(SEEDS, (seed) => {
      const sim = createSim(field({ units: [{ type: INF_FR, at: [1000, 1060], formation: 'column' }] }, { units: [{ type: GUNS, at: [1000, 1000] }] }), freshData(), seed);
      attack(sim, 'b1', 'r1');
      run(sim, 200);
      return unit(sim, 'r1').status === 'gone';
    });
    expect(lost).toBe(1);
  });
});

describe('infantry fire and movement', () => {
  it('a line outshoots a column in a stand-up firefight (more than 2x the casualties inflicted)', () => {
    let byLine = 0;
    let byColumn = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const d = freshData();
      d.morale.routThreshold = -1e9;
      const sim = createSim(field({ units: [{ type: INF_FR, at: [1000, 1090], formation: 'column' }] }, { units: [{ type: INF_FR, at: [1000, 1000], formation: 'line' }] }), d, seed);
      hold(sim, 'b1');
      hold(sim, 'r1');
      run(sim, 300);
      byLine += unit(sim, 'b1').casualties;
      byColumn += unit(sim, 'r1').casualties;
    }
    expect(byColumn).toBeGreaterThan(0);
    expect(byLine).toBeGreaterThan(byColumn * 2);
  });

  it('a British two-deep line brings more muskets to bear than a French three-deep line', () => {
    let fr = 0;
    let br = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const d = freshData();
      d.morale.routThreshold = -1e9;
      const sim = createSim(field({ units: [{ type: INF_FR, at: [1000, 1100], formation: 'line' }] }, { units: [{ type: INF_BR, at: [1000, 1000], formation: 'line' }] }), d, seed);
      hold(sim, 'b1');
      hold(sim, 'r1');
      run(sim, 300);
      fr += unit(sim, 'r1').casualties;
      br += unit(sim, 'b1').casualties;
    }
    expect(br).toBeGreaterThan(fr * 1.25);
  });

  it('musketry falls off with range', () => {
    const at = (gap: number) =>
      mean(SEEDS, (seed) => {
        const d = freshData();
        d.morale.routThreshold = -1e9;
        d.weapons.musketry.openFireRange = 400;
        const sim = createSim(field({ units: [{ type: INF_FR, at: [1000, 1000 + gap], formation: 'line' }] }, { units: [{ type: INF_FR, at: [1000, 1000], formation: 'line' }] }), d, seed);
        hold(sim, 'b1');
        hold(sim, 'r1');
        run(sim, 300);
        return unit(sim, 'r1').casualties;
      });
    expect(at(300)).toBeLessThan(at(60) * 0.6);
  });

  it('a column crosses the same ground faster than a line, and a square barely moves', () => {
    const sim = createSim(field({ units: [{ type: INF_FR, at: [500, 1500], formation: 'column' }, { type: INF_FR, at: [1000, 1500], formation: 'line' }, { type: INF_FR, at: [1500, 1500], formation: 'square' }] }, { units: [{ type: INF_FR, at: [1000, 100] }] }), freshData(), 1);
    hold(sim, 'r1');
    for (const id of ['b1', 'b2', 'b3']) {
      const u = hold(sim, id);
      u.order = { type: 'move', target: -1, x: u.x, y: 700, charge: false };
    }
    run(sim, 300);
    const moved = (id: string) => 1500 - unit(sim, id).y;
    expect(moved('b1')).toBeGreaterThan(moved('b2') * 1.4);
    expect(moved('b3')).toBeLessThan(moved('b2') * 0.5);
    // and the rates are the regulation ones
    expect(baseSpeed(sim, unit(sim, 'b1'))).toBeCloseTo((100 * 0.65) / 60, 3);
  });

  it('changing formation takes the drill-book time and the unit cannot fire meanwhile', () => {
    const sim = createSim(field({ posture: 'defend', units: [{ type: INF_FR, at: [1000, 1100], formation: 'column' }] }, { units: [{ type: INF_FR, at: [1000, 1000], formation: 'line' }] }), freshData(), 1);
    hold(sim, 'r1').reload = 1e9; // red holds its fire
    const b = unit(sim, 'b1'); // AI: defend posture, so it deploys into line
    run(sim, 10);
    expect(b.form).toBe('line');
    expect(b.formT).toBeGreaterThan(100);
    run(sim, 100);
    expect(unit(sim, 'r1').casualties).toBe(0);
    run(sim, 200);
    expect(b.formT).toBe(0);
    expect(unit(sim, 'r1').casualties).toBeGreaterThan(0);
  });
});

describe('morale', () => {
  it('a rout shakes friends inside the radius and not those outside it, and heartens the enemy', () => {
    const d = freshData();
    d.morale.recoveryRate = 0;
    const sim = createSim(field({ units: [{ type: INF_FR, at: [1000, 1500] }, { type: INF_FR, at: [1200, 1500] }, { type: INF_FR, at: [1600, 1500] }] }, { units: [{ type: INF_BR, at: [1000, 1300] }, { type: INF_BR, at: [1000, 200] }] }), d, 1);
    for (const id of ['b1', 'b2', 'b3', 'r1', 'r2']) hold(sim, id).reload = 1e9;
    unit(sim, 'r1').morale = 80;
    const near0 = unit(sim, 'b2').morale;
    const far0 = unit(sim, 'b3').morale;
    unit(sim, 'b1').morale = 5;
    run(sim, 2);
    expect(unit(sim, 'b1').status).toBe('rout');
    expect(unit(sim, 'b2').morale).toBeCloseTo(near0 - d.morale.rippleFriend, 5);
    expect(unit(sim, 'b3').morale).toBe(far0);
    expect(unit(sim, 'r1').morale).toBeCloseTo(80 + d.morale.rippleEnemy, 5);
    expect(sim.routs[0].topCause).toBe('');
  });

  it('steadier troops lose less morale from the same shock', () => {
    const sim = createSim(field({ units: [{ type: INF_FR, at: [1000, 1500] }, { type: INF_FR, at: [1150, 1500], quality: 'guard' }, { type: INF_FR, at: [850, 1500], quality: 'conscript' }] }, { units: [{ type: INF_BR, at: [1000, 200] }] }), freshData(), 1);
    for (const id of ['b1', 'b2', 'b3', 'r1']) hold(sim, id);
    const g0 = unit(sim, 'b2').morale;
    const c0 = unit(sim, 'b3').morale;
    unit(sim, 'b1').morale = 5;
    run(sim, 2);
    expect(g0 - unit(sim, 'b2').morale).toBeLessThan(c0 - unit(sim, 'b3').morale);
  });

  it('a routed unit rallies when unpursued, but not when weak or pressed', () => {
    const mk = (men: number, pursuer: boolean) => {
      const sim = createSim(field({ units: [{ type: INF_FR, at: [1000, 1000], men: 600 }, { type: INF_FR, at: [100, 1900] }, { type: INF_FR, at: [1900, 1900] }] }, { units: pursuer ? [{ type: INF_BR, at: [1000, 800] }, { type: CAV, at: [1000, 960] }] : [{ type: INF_BR, at: [1000, 300] }] }), freshData(), 1);
      for (const u of sim.units) hold(sim, u.id).reload = 1e9;
      const b = unit(sim, 'b1');
      b.casualties = 600 - men;
      b.men = men;
      b.morale = 10;
      if (pursuer) attack(sim, 'r2', 'b1');
      let rallied = false;
      run(sim, 400, () => {
        if (b.status === 'ok' && b.everRouted) rallied = true;
      });
      return rallied;
    };
    expect(mk(500, false)).toBe(true);
    expect(mk(150, false)).toBe(false);
    expect(mk(500, true)).toBe(false);
  });

  it('an army breaks when three fifths of its units have broken, and the run ends after the pursuit', () => {
    const sim = createSim(field({ units: [0, 1, 2, 3, 4].map((i) => ({ type: INF_FR, at: [400 + i * 300, 1700] as [number, number] })) }, { units: [{ type: INF_BR, at: [1000, 200] }] }), freshData(), 1);
    for (const u of sim.units) hold(sim, u.id).reload = 1e9;
    const d = sim.data.morale;
    d.rippleFriend = 0;
    d.routRecoveryRate = 0;
    unit(sim, 'b1').morale = 0;
    unit(sim, 'b2').morale = 0;
    run(sim, 5);
    expect(sim.over).toBeNull(); // 2 of 5 broken
    unit(sim, 'b3').morale = 0;
    run(sim, 5);
    expect(sim.over).not.toBeNull(); // 3 of 5 broken
    expect(sim.sides[0].brokeAt).toBeGreaterThan(0);
    expect(sim.units.filter((u) => u.side === 0 && u.status === 'ok').length).toBe(0);
    run(sim, 1000);
    expect(sim.ended).toBe(true);
    expect(sim.endReason).toBe('army_broken');
  });

  it('units recover morale when left alone, up to a ceiling set by their losses', () => {
    const sim = createSim(field({ units: [{ type: INF_FR, at: [1000, 1700] }] }, { units: [{ type: INF_BR, at: [1000, 200] }] }), freshData(), 1);
    for (const u of sim.units) hold(sim, u.id);
    const b = unit(sim, 'b1');
    b.men = 300;
    b.casualties = 300;
    b.morale = 30;
    run(sim, 600);
    expect(b.morale).toBeCloseTo(75, 5); // 100 x (0.5 + 0.5 x 300/600)
  });
});

describe('terrain', () => {
  const firefight = (extra: object) =>
    mean(SEEDS, (seed) => {
      const d = freshData();
      d.morale.routThreshold = -1e9;
      const sc = field({ units: [{ type: INF_FR, at: [1000, 1100], formation: 'line' }] }, { units: [{ type: INF_FR, at: [1000, 1000], formation: 'line' }] });
      Object.assign(sc.map, extra);
      const sim = createSim(sc, d, seed);
      hold(sim, 'b1');
      hold(sim, 'r1');
      run(sim, 300);
      return unit(sim, 'r1').casualties / Math.max(1, unit(sim, 'b1').casualties);
    });
  const box = (type: string) => ({ features: [{ type, polygon: [[800, 940], [1200, 940], [1200, 1040], [800, 1040]] }] });

  it('a wood and a walled farm reduce the casualties of the unit inside', () => {
    const open = firefight({});
    const wood = firefight(box('wood'));
    const farm = firefight(box('farm'));
    expect(wood).toBeLessThan(open * 0.85);
    expect(farm).toBeLessThan(wood);
  });

  it('defenders on higher ground do better than on the level', () => {
    const open = firefight({});
    const hill = firefight({ hills: [{ x: 1000, y: 950, rx: 600, ry: 120, height: 25 }] });
    expect(hill).toBeLessThan(open * 0.95);
  });

  it('a wood slows infantry and cavalry', () => {
    const cross = (wood: boolean, type: string) => {
      const sc = field({ units: [{ type, at: [1000, 1500], formation: 'column' }] }, { units: [{ type: INF_FR, at: [1000, 100] }] });
      if (wood) sc.map.features = [{ type: 'wood', polygon: [[500, 900], [1500, 900], [1500, 1600], [500, 1600]] }];
      const sim = createSim(sc, freshData(), 1);
      hold(sim, 'r1');
      const u = hold(sim, 'b1');
      u.order = { type: 'move', target: -1, x: 1000, y: 1000, charge: false };
      run(sim, 120);
      return 1500 - u.y;
    };
    expect(cross(true, INF_FR)).toBeLessThan(cross(false, INF_FR) * 0.6);
    expect(cross(true, CAV)).toBeLessThan(cross(false, CAV) * 0.5);
  });
});
