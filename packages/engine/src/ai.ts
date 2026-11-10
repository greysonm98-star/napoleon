// Per-unit behaviour, ported from the prototype's think() (MODEL 9).
// Each unit acts on its posture and what is around it; there is no plan above the unit
// unless command and control is switched on.

import { hooks } from './hooks.ts';
import { clamp, len } from './math.ts';
import { flankOf, formationTime, gapOf, makeOrder, setFormation } from './sim.ts';
import type { Formation } from './scenario.ts';
import type { Sim, Unit } from './types.ts';

function nearest(sim: Sim, u: Unit, list: Unit[]): [Unit | null, number] {
  let best: Unit | null = null;
  let bd = Infinity;
  for (const e of list) {
    const d = gapOf(sim, u, e);
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return [best, bd];
}

export function think(sim: Sim, u: Unit): void {
  const A = sim.data.ai;
  const M = sim.data.morale;
  const side = sim.sides[u.side];
  const st = u.posture;
  const foes: Unit[] = [];
  const formed: Unit[] = [];
  for (const e of sim.units) {
    if (e.side === u.side || e.status === 'gone') continue;
    if (!hooks.canSee(sim, u, e)) continue;
    foes.push(e);
    if (e.status === 'ok') formed.push(e);
  }
  const margin = sim.data.terrain.mapMargin;

  if (u.arm === 'inf') {
    // 9.1 form square against cavalry
    let threat = false;
    for (const e of formed) {
      if (e.arm !== 'cav' || e.blown > 0) continue;
      const d = gapOf(sim, u, e);
      if (d < (u.form === 'square' ? A.squareHoldProximity : A.squareProximity)) threat = true;
      else if (e.order && e.order.type === 'attack' && e.order.target === u.idx) {
        const tts = u.form === 'square' ? 0 : formationTime(u, 'square') * hooks.drillTimeFactor(sim, u);
        const lim = (tts + A.squareSafetyMargin) * A.cavApproachSpeed + (1 - u.q) * A.threatQualityBonus;
        if (d < lim) threat = true;
      }
    }
    if (!formed.length && !threat) {
      if (!hooks.aiOverride(sim, u, null, Infinity)) u.order = null;
      return;
    }
    const foot = formed.filter((e) => e.arm !== 'cav');
    const [t, td] = nearest(sim, u, foot.length ? foot : formed);
    let want: Formation;
    if (threat) {
      want = 'square';
      u.order = null;
    } else if (hooks.aiOverride(sim, u, t, td)) {
      return;
    } else if (st === 'defend' || !t) {
      want = 'line';
      u.order = null;
    } else if (st === 'attack_column') {
      want = 'column';
      u.order = makeOrder('attack', t.idx, 0, 0, true);
    } else {
      want = td > A.deployRange * (u.form === 'line' ? A.redeployFactor : 1) ? 'column' : 'line';
      u.order = makeOrder('attack', t.idx, 0, 0, t.arm === 'art' || t.morale < A.chargeMoraleAbsolute || t.morale < u.morale - A.chargeMoraleAdvantage || hooks.mustCharge(sim, u));
    }
    if (want !== u.form && u.formT <= 0 && !u.melee) setFormation(sim, u, want);
    return;
  }

  if (u.arm === 'cav') {
    // 9.2 cavalry picks the most promising target by score
    if (u.blown > 0) return;
    const defend = st === 'defend';
    const leash = (defend ? A.cavLeashDefend : A.cavLeashAttack) * hooks.cavLeashFactor(sim, u);
    let best: Unit | null = null;
    let bs = A.cavMinScore;
    for (const e of foes) {
      const d = gapOf(sim, u, e);
      if (d > leash) continue;
      let sc: number;
      if (e.status === 'rout') sc = d < A.cavRoutChaseRange ? A.cavScoreRouted - d / A.cavDistanceCostRouted : -1;
      else if (e.arm === 'art') {
        sc = A.cavScoreGuns - d / A.cavDistanceCostNear;
        const r = A.cavGunsSupportRadius;
        for (const o of formed) {
          if (o.arm === 'inf' && len(o.x - e.x, o.y - e.y) < r) {
            sc -= A.cavGunsSupportedPenalty;
            break;
          }
        }
      } else if (e.arm === 'cav') sc = (e.blown > 0 ? A.cavScoreCavBlown : A.cavScoreCavFresh) - d / A.cavDistanceCostNear;
      else if (e.form === 'square' && e.formT <= 0) sc = e.morale >= M.squareSteadyMorale ? -99 : A.cavScoreShakenSquare - d / A.cavDistanceCostFar;
      else {
        const fl = flankOf(sim, u, e);
        if (u.avoidId === e.idx && sim.t < u.avoidUntil && fl === 0 && e.morale >= A.chargeMoraleAbsolute && e.formT <= 0) continue;
        const base = e.formT > d / u.ut.chargeSpeed! + A.cavFormingMargin ? A.cavScoreForming : fl !== 0 ? A.cavScoreFlank : e.morale < A.chargeMoraleAbsolute ? A.cavScoreShaken : sim.t - e.lastHitT < A.cavUnderFireWindow ? A.cavScoreUnderFire : defend ? A.cavScoreFrontDefend : A.cavScoreFrontAttack;
        sc = base - d / (defend ? A.cavDistanceCostNear : A.cavDistanceCostFar);
      }
      if (sc > bs) {
        bs = sc;
        best = e;
      }
    }
    if (best) {
      u.order = makeOrder('attack', best.idx, 0, 0, true);
      return;
    }
    if (hooks.aiOverride(sim, u, null, Infinity)) return;
    if (!defend) {
      // keep station behind the leading friendly infantry, on the squadron's own wing
      let lead: Unit | null = null;
      let leadLon = Infinity;
      for (const v of sim.units) {
        if (v.side !== u.side || v.status !== 'ok' || v.arm !== 'inf') continue;
        const lon = v.x * side.rearX + v.y * side.rearY;
        if (lon < leadLon) {
          leadLon = lon;
          lead = v;
        }
      }
      if (lead) {
        const homeLon = u.homeX * side.rearX + u.homeY * side.rearY;
        const shift = leadLon + A.cavFollowDistance - homeLon;
        u.order = makeOrder('move', -1, clamp(u.homeX + side.rearX * shift, margin, sim.map.width - margin), clamp(u.homeY + side.rearY * shift, margin, sim.map.height - margin), false);
      } else if (formed.length) {
        const [t] = nearest(sim, u, formed);
        const D = len(t!.x - u.x, t!.y - u.y);
        if (D > A.cavStandoff + 20) {
          const k = 1 - A.cavStandoff / D;
          u.order = makeOrder('move', -1, u.x + (t!.x - u.x) * k, u.y + (t!.y - u.y) * k, false);
        } else u.order = null;
      } else u.order = null;
    } else if (len(u.x - u.homeX, u.y - u.homeY) > A.cavHomeTolerance) u.order = makeOrder('move', -1, u.homeX, u.homeY, false);
    else u.order = null;
    return;
  }

  // 9.3 artillery: stand and fire; when attacking, close to effective range first
  if (!formed.length) {
    if (!hooks.aiOverride(sim, u, null, Infinity)) u.order = null;
    return;
  }
  const [t, td] = nearest(sim, u, formed);
  if (hooks.aiOverride(sim, u, t, td)) return;
  u.order = st !== 'defend' && t && td > u.gun!.roundshotEffectiveRange * A.artAdvanceFraction ? makeOrder('attack', t.idx, 0, 0, false) : null;
}
