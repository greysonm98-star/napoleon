// The simulation: state construction and the fixed-timestep update.
// Rules are documented in MODEL.md; section numbers in comments refer to it.

import type { Data } from './data.ts';
import { requireKeys } from './data.ts';
import { refreshGeom, rectGap } from './geom.ts';
import { DEG, angDiff, atan2, clamp, hash4, interp, len, mulberry32 } from './math.ts';
import { NO_FEATURES, buildMap, elevAt, expandUnits, featureAt, gradAt, validateScenario } from './scenario.ts';
import type { Formation, Scenario } from './scenario.ts';
import type { Order, RoutRecord, Sim, SimEvent, SimInput, SimOptions, Unit } from './types.ts';
import { think } from './ai.ts';
import { hooks } from './hooks.ts';

export const STREAM = { RELOAD: 1, MUSKET: 2, GUN: 3, DEPLOY: 4, COMMAND: 5, SKIRMISH: 6, WEATHER: 7, MISC: 8 } as const;

/** Uniform [0,1) keyed by seed, stream, an entity number and the current tick. */
export function rnd(sim: Sim, stream: number, a: number, b = 0): number {
  return hash4(sim.seed ^ Math.imul(stream, 0x9e3779b1), a, sim.tick, b) / 4294967296;
}

const MORALE_KEYS = ['startMorale', 'startMoraleSteady', 'steadyThreshold', 'routThreshold', 'destroyedFraction', 'casualtyShock', 'shockFireFront', 'shockFireFlank', 'shockColumnClose', 'columnCloseRange', 'shockRoundshot', 'shockCanister', 'shockMelee', 'artilleryCrewFactor', 'rippleRadius', 'rippleFriend', 'rippleEnemy', 'squareSteadyMorale', 'contactCavOnForming', 'contactCavFront', 'contactCavFlank', 'contactCavRear', 'contactCavOnShakenSquare', 'contactSquareRepulse', 'contactCavOnGuns', 'contactInfOnGuns', 'contactBayonet', 'recoveryRate', 'recoveryDelay', 'recoveryCapBase', 'routRecoveryRate', 'routRecoveryCap', 'rallyMorale', 'rallyMinStrength', 'rallyEnemyDistance', 'maxRallies', 'armyBreakFraction', 'aftermathDuration', 'cavRecoilRange', 'cavRecoilMorale', 'frontArc', 'flankArc', 'chainWindow'] as const;
const MELEE_KEYS = ['contactDistance', 'lethality', 'moraleBase', 'armCavalry', 'armInfantry', 'armArtillery', 'infVsCavForming', 'infVsCavSquareSteady', 'infVsCavSquareShaken', 'infVsCavColumn', 'infVsCavLine', 'infForming', 'infColumn', 'infSquare', 'infLine', 'infFlankBonus', 'cavVsSquareSteady', 'cavVsSquareShaken', 'cavVsInfFront', 'cavVsInfFlank', 'cavVsInfRear', 'cavVsInfForming', 'cavVsArtillery', 'cavChargeBonus', 'chargeImpetusTime', 'pursuitCavalry', 'pursuitInfantry', 'capturedShare', 'blownTime', 'blownAfterCharge', 'bounceDistance', 'avoidTime', 'contactHoldFactor', 'recontactTime'] as const;
const AI_KEYS = ['thinkInterval', 'squareProximity', 'squareHoldProximity', 'squareSafetyMargin', 'cavApproachSpeed', 'threatQualityBonus', 'deployRange', 'redeployFactor', 'engageRange', 'chargeMoraleAbsolute', 'chargeMoraleAdvantage', 'faceTolerance', 'moveFaceToleranceInfantry', 'moveFaceToleranceCavalry', 'separationFactor', 'separationPush', 'cavLeashDefend', 'cavLeashAttack', 'cavMinScore', 'cavScoreRouted', 'cavRoutChaseRange', 'cavScoreGuns', 'cavGunsSupportedPenalty', 'cavGunsSupportRadius', 'cavScoreCavBlown', 'cavScoreCavFresh', 'cavScoreShakenSquare', 'cavScoreForming', 'cavScoreFlank', 'cavScoreShaken', 'cavScoreUnderFire', 'cavUnderFireWindow', 'cavScoreFrontAttack', 'cavScoreFrontDefend', 'cavDistanceCostNear', 'cavDistanceCostRouted', 'cavDistanceCostFar', 'cavFormingMargin', 'cavFollowDistance', 'cavStandoff', 'cavHomeTolerance', 'artAdvanceFraction', 'artScoreSquare', 'artScoreColumn', 'artScoreLine', 'artScoreCavalry', 'artScoreArtillery', 'artDistanceScale', 'artCanisterPriority', 'artPreferredBonus'] as const;
const MUSKETRY_KEYS = ['openFireRange', 'arcHalfAngle', 'moraleFloor', 'vsArtillery', 'vsColumn', 'artilleryTargetPenalty', 'lookRange', 'rankAndFileShare'] as const;
const GUNNERY_KEYS = ['aimTolerance', 'unlimberTime', 'turnRate', 'canisterVsSquare', 'canisterVsColumn', 'canisterVsLine', 'canisterVsCavalry', 'canisterVsArtillery', 'strengthJitter'] as const;
const TERRAIN_KEYS = ['heightAdvantageMin', 'highGroundMelee', 'highGroundFire', 'roundshotUphill', 'slopeThreshold', 'slopeMove', 'mapMargin'] as const;

export function checkData(data: Data): void {
  requireKeys(data.morale, 'morale', MORALE_KEYS);
  requireKeys(data.melee, 'melee', MELEE_KEYS);
  requireKeys(data.ai, 'ai', AI_KEYS);
  requireKeys(data.weapons.musketry, 'weapons.musketry', MUSKETRY_KEYS);
  requireKeys(data.weapons.gunnery, 'weapons.gunnery', GUNNERY_KEYS);
  requireKeys(data.terrain as unknown as Record<string, unknown>, 'terrain', TERRAIN_KEYS);
}

// ------------------------------------------------------------------ geometry of formations (MODEL 3)

export function setDims(u: Unit): void {
  const men = u.men > 1 ? u.men : 1;
  if (u.arm === 'inf') {
    const d = u.doc!;
    if (u.status === 'rout' || u.form === 'column') {
      const deep = d.ranks * d.columnDivisions;
      const w = (men / deep) * d.fileWidth;
      u.w = w;
      u.d = (d.columnDivisions - 1) * w * d.columnIntervalFraction + deep * d.rankDepth;
    } else if (u.form === 'line') {
      u.w = (men / d.ranks) * d.fileWidth;
      u.d = d.ranks * d.rankDepth;
    } else {
      const side = (men / (4 * d.squareRanks)) * d.fileWidth + 2 * d.squareRanks * d.rankDepth;
      u.w = side;
      u.d = side;
    }
  } else if (u.arm === 'cav') {
    u.w = (men / u.ut.ranks!) * u.ut.fileWidth!;
    u.d = u.ut.ranks! * u.ut.rankDepth!;
  } else {
    u.w = u.ut.guns! * u.ut.gunInterval!;
    u.d = u.ut.depth!;
  }
  if (u.w < 8) u.w = 8;
  if (u.d < 2) u.d = 2;
}

/** Muskets that can bear to the front (MODEL 5.1). */
export function musketsBearing(sim: Sim, u: Unit): number {
  const d = u.doc!;
  const share = sim.data.weapons.musketry.rankAndFileShare;
  let n: number;
  if (u.form === 'line') n = (u.men / d.ranks) * Math.min(d.firingRanks, d.ranks);
  else if (u.form === 'column') n = (u.men / (d.ranks * d.columnDivisions)) * Math.min(d.firingRanks, d.ranks);
  else n = (u.men / (4 * d.squareRanks)) * Math.min(d.squareFiringRanks, d.squareRanks);
  return Math.round(n * share);
}

export function formationTime(u: Unit, to: Formation): number {
  const d = u.doc!;
  const from = u.form;
  if (from === 'line') return to === 'column' ? d.timeLineToColumn : d.timeLineToSquare;
  if (from === 'column') return to === 'line' ? d.timeColumnToLine : d.timeColumnToSquare;
  return to === 'line' ? d.timeSquareToLine : d.timeSquareToColumn;
}

export function setFormation(sim: Sim, u: Unit, form: Formation): void {
  if (u.arm !== 'inf' || u.form === form || u.status !== 'ok') return;
  const time = formationTime(u, form) * hooks.drillTimeFactor(sim, u);
  const from = u.form;
  u.form = form;
  u.formT = time;
  hooks.onFormationChange(sim, u);
  setDims(u);
  refreshGeom(u);
  if (sim.eventLevel === 'full') emit(sim, { type: 'formation', unit: u.id, side: u.side, from, to: form, time: Math.round(time) });
}

// ------------------------------------------------------------------ events and the morale ledger (MODEL 8)

export function emit(sim: Sim, ev: Omit<SimEvent, 'id' | 't'>, store = true): number {
  const id = sim.nextEventId++;
  if (store) sim.events.push({ id, t: sim.t, ...ev } as SimEvent);
  return id;
}

/** Change a unit's morale and remember why. */
export function shock(sim: Sim, u: Unit, delta: number, cause: string, from = -1, parent = 0): void {
  if (delta === 0) return;
  u.morale += delta;
  for (const e of u.ledger) {
    if (e.cause === cause && e.from === from && e.parent === parent) {
      e.delta += delta;
      return;
    }
  }
  u.ledger.push({ cause, from, delta, parent });
}

export function flushLedger(sim: Sim, u: Unit): void {
  if (!u.ledger.length) return;
  const full = sim.eventLevel === 'full';
  for (const e of u.ledger) {
    const id = sim.nextEventId++;
    if (full) {
      const ev: SimEvent = { id, t: sim.t, type: 'morale', unit: u.id, side: u.side, delta: Math.round(e.delta * 100) / 100, cause: e.cause, morale: Math.round(u.morale * 10) / 10 };
      if (e.from >= 0) ev.from = sim.units[e.from].id;
      if (e.parent) ev.parent = e.parent;
      sim.events.push(ev);
    }
    u.recent.push({ id, t: sim.t, cause: e.cause, from: e.from, delta: e.delta, parent: e.parent });
  }
  u.ledger.length = 0;
  const cutoff = sim.t - sim.data.morale.chainWindow;
  while (u.recent.length && u.recent[0].t < cutoff) u.recent.shift();
}

function summariseCauses(sim: Sim, u: Unit): { causes: { cause: string; from?: string; delta: number }[]; chain: number[]; top: string; trigger: string; rootCause: string; rootUnit: string } {
  const agg = new Map<string, { cause: string; from: number; delta: number; parent: number }>();
  const chain: number[] = [];
  let trigger = '';
  for (const r of u.recent) {
    if (r.delta >= 0) continue;
    chain.push(r.id);
    trigger = r.cause;
    const key = r.cause + '|' + r.from;
    const a = agg.get(key);
    if (a) a.delta += r.delta;
    else agg.set(key, { cause: r.cause, from: r.from, delta: r.delta, parent: r.parent });
  }
  const list = [...agg.values()].sort((a, b) => a.delta - b.delta || (a.cause < b.cause ? -1 : 1));
  const byCause = new Map<string, number>();
  for (const a of list) byCause.set(a.cause, (byCause.get(a.cause) ?? 0) + a.delta);
  let top = '';
  let topV = 0;
  for (const [c, v] of byCause) if (v < topV) (topV = v), (top = c);
  // Root cause: follow "a friend routed" back to whatever broke that friend.
  let rootCause = top;
  let rootUnit = u.id;
  if (top === 'friend_routed') {
    const first = list.find((a) => a.cause === 'friend_routed');
    const rec = first ? sim.routs.find((r) => r.eventId === first.parent) : undefined;
    if (rec) {
      rootCause = rec.rootCause || rec.topCause;
      rootUnit = rec.rootUnit;
    }
  }
  return {
    causes: list.map((a) => (a.from >= 0 ? { cause: a.cause, from: sim.units[a.from].id, delta: Math.round(a.delta * 10) / 10 } : { cause: a.cause, delta: Math.round(a.delta * 10) / 10 })),
    chain,
    top,
    trigger,
    rootCause,
    rootUnit,
  };
}

// ------------------------------------------------------------------ rout, ripple, removal (MODEL 7)

function ripple(sim: Sim, u: Unit, eventId: number): void {
  const M = sim.data.morale;
  const r2 = M.rippleRadius * M.rippleRadius;
  for (const v of sim.units) {
    if (v === u || v.status !== 'ok') continue;
    const dx = v.x - u.x;
    const dy = v.y - u.y;
    if (dx * dx + dy * dy >= r2) continue;
    if (v.side === u.side) shock(sim, v, -M.rippleFriend * v.q * hooks.rippleFactor(sim, v), 'friend_routed', u.idx, eventId);
    else if (v.morale < 100) shock(sim, v, Math.min(M.rippleEnemy, 100 - v.morale), 'enemy_routed', u.idx, eventId);
  }
}

function recordBreak(sim: Sim, u: Unit, kind: RoutRecord['kind'], forcedCause?: string): number {
  flushLedger(sim, u);
  const s = summariseCauses(sim, u);
  if (forcedCause) {
    s.top = s.trigger = s.rootCause = forcedCause;
    s.rootUnit = u.id;
  }
  const id = emit(sim, { type: kind === 'rout' || kind === 'army_broken' ? 'rout' : kind, unit: u.id, side: u.side, x: Math.round(u.x), y: Math.round(u.y), men: u.men, morale: Math.round(u.morale), kind, topCause: s.top, trigger: s.trigger, rootCause: s.rootCause, rootUnit: s.rootUnit, causes: s.causes, chain: s.chain });
  sim.routs.push({ eventId: id, t: sim.t, unit: u.idx, side: u.side, x: u.x, y: u.y, kind, topCause: s.top, trigger: s.trigger, rootCause: s.rootCause, rootUnit: s.rootUnit });
  u.lastRoutEvent = id;
  return id;
}

export function rout(sim: Sim, u: Unit, forcedCause?: string): void {
  if (u.status !== 'ok') return;
  const id = recordBreak(sim, u, forcedCause ? 'army_broken' : u.arm === 'art' ? 'guns_abandoned' : 'rout', forcedCause);
  u.everRouted = true;
  if (u.arm === 'art') {
    remove(sim, u, 'guns_abandoned', false);
  } else {
    u.status = 'rout';
    u.order = null;
    u.melee = false;
    u.formT = 0;
    u.charged = false;
    if (u.arm === 'inf') u.form = 'column';
    hooks.onRout(sim, u);
    setDims(u);
    refreshGeom(u);
  }
  ripple(sim, u, id);
}

function remove(sim: Sim, u: Unit, reason: Unit['goneReason'], announce = true): void {
  if (u.status === 'gone') return;
  const wasFormed = u.status === 'ok';
  let id = u.lastRoutEvent;
  if (announce) {
    if (wasFormed && reason === 'destroyed') {
      id = recordBreak(sim, u, 'destroyed');
      u.everRouted = true;
    } else {
      flushLedger(sim, u);
      id = emit(sim, { type: 'gone', unit: u.id, side: u.side, x: Math.round(u.x), y: Math.round(u.y), men: u.men, reason });
    }
  }
  hooks.onRemove(sim, u);
  u.status = 'gone';
  u.goneReason = reason;
  u.goneT = sim.t;
  u.dispersed += u.men;
  u.men = 0;
  u.order = null;
  u.melee = false;
  if (announce && (reason === 'destroyed' || reason === 'scattered')) ripple(sim, u, id);
}

function bounce(sim: Sim, u: Unit, from: Unit | null): void {
  const E = sim.data.melee;
  const side = sim.sides[u.side];
  u.blown = E.blownTime * hooks.blownFactor(sim, u);
  if (from) {
    u.avoidId = from.idx;
    u.avoidUntil = sim.t + E.avoidTime;
  }
  u.charging = false;
  u.chargeT = 0;
  u.charged = false;
  const m = sim.data.terrain.mapMargin;
  u.order = { type: 'move', target: -1, x: clamp(u.x + side.rearX * E.bounceDistance, m, sim.map.width - m), y: clamp(u.y + side.rearY * E.bounceDistance, m, sim.map.height - m), charge: false };
}

// ------------------------------------------------------------------ helpers

/** 0 front, 1 flank, 2 rear: where attacker a stands relative to b's facing. A square has no flank. */
export function flankOf(sim: Sim, a: Unit, b: Unit): 0 | 1 | 2 {
  if (b.arm === 'inf' && b.form === 'square') return 0;
  const M = sim.data.morale;
  let d = angDiff(atan2(a.y - b.y, a.x - b.x), b.f);
  if (d < 0) d = -d;
  return d < M.frontArc * DEG ? 0 : d < M.flankArc * DEG ? 1 : 2;
}
const FLANK_NAME = ['front', 'flank', 'rear'];

export const gapOf = (sim: Sim, a: Unit, b: Unit): number => sim.gap[a.idx * sim.n + b.idx];

function computeGaps(sim: Sim): void {
  const { units, n, gap } = sim;
  for (let i = 0; i < n; i++) {
    const a = units[i];
    if (a.status === 'gone') continue;
    for (let j = i + 1; j < n; j++) {
      const b = units[j];
      if (b.side === a.side || b.status === 'gone') continue;
      const g = rectGap(a, b);
      gap[i * n + j] = g;
      gap[j * n + i] = g;
    }
  }
}

function refreshTerrain(sim: Sim, u: Unit): void {
  u.elev = elevAt(sim.map, u.x, u.y);
  u.feat = sim.map.features.length ? featureAt(sim.map, u.x, u.y) : null;
}

const higher = (sim: Sim, a: Unit, b: Unit): boolean => a.elev - b.elev >= sim.data.terrain.heightAdvantageMin;

// ------------------------------------------------------------------ melee (MODEL 6)

function power(sim: Sim, a: Unit, b: Unit): number {
  const E = sim.data.melee;
  const M = sim.data.morale;
  let p = a.men * (a.arm === 'cav' ? E.armCavalry : a.arm === 'art' ? E.armArtillery : E.armInfantry);
  const fl = flankOf(sim, a, b);
  if (a.arm === 'inf') {
    if (b.arm === 'cav') {
      p *= a.formT > 0 ? E.infVsCavForming : a.form === 'square' ? (a.morale >= M.squareSteadyMorale ? E.infVsCavSquareSteady : E.infVsCavSquareShaken) : a.form === 'column' ? E.infVsCavColumn : E.infVsCavLine;
    } else {
      p *= a.formT > 0 ? E.infForming : a.form === 'column' ? E.infColumn : a.form === 'square' ? E.infSquare : E.infLine;
      if (b.arm === 'inf' && b.form !== 'square' && fl !== 0) p *= E.infFlankBonus;
    }
  } else if (a.arm === 'cav') {
    if (b.arm === 'inf') {
      if (b.form === 'square' && b.formT <= 0) p *= b.morale >= M.squareSteadyMorale ? E.cavVsSquareSteady : E.cavVsSquareShaken;
      else {
        p *= fl === 0 ? E.cavVsInfFront : fl === 1 ? E.cavVsInfFlank : E.cavVsInfRear;
        if (b.formT > 0) p *= E.cavVsInfForming;
      }
      if (b.feat) p *= b.feat.tt.cavalryVsInfantryInside;
    } else if (b.arm === 'art') p *= E.cavVsArtillery;
    if (a.chargeT > 0) p *= E.cavChargeBonus;
    const ta = a.feat ? a.feat.tt.cavalryMelee : 1;
    const tb = b.feat ? b.feat.tt.cavalryMelee : 1;
    p *= ta < tb ? ta : tb;
  }
  if (higher(sim, a, b)) p *= sim.data.terrain.highGroundMelee;
  return p * (E.moraleBase + a.morale / 100) * hooks.meleeFactor(sim, a, b);
}

function onContact(sim: Sim, a: Unit, b: Unit): void {
  const M = sim.data.morale;
  const E = sim.data.melee;
  const full = sim.eventLevel === 'full';
  const note = (kind: string, extra: Record<string, unknown> = {}) => {
    if (full) emit(sim, { type: 'contact', unit: a.id, side: a.side, target: b.id, kind, x: Math.round(a.x), y: Math.round(a.y), ...extra });
  };
  if (a.arm === 'cav') {
    if (b.arm === 'inf') {
      if (b.form === 'square' && b.formT <= 0 && b.morale < M.squareSteadyMorale) {
        shock(sim, b, -M.contactCavOnShakenSquare * b.q, 'square_broken_into', a.idx);
        if (a.charging) {
          a.chargeT = E.chargeImpetusTime;
          a.charged = true;
        }
        note('cavalry_breaks_shaken_square');
      } else if (b.form === 'square' && b.formT <= 0) {
        shock(sim, a, -M.contactSquareRepulse * a.q, 'repulsed_by_square', b.idx);
        bounce(sim, a, b);
        note('cavalry_repulsed_by_square');
      } else {
        const fl = flankOf(sim, a, b);
        const forming = b.formT > 0;
        shock(sim, b, -(forming ? M.contactCavOnForming : fl === 0 ? M.contactCavFront : fl === 1 ? M.contactCavFlank : M.contactCavRear) * b.q, forming ? 'charged_while_forming' : `charged_in_${FLANK_NAME[fl]}`, a.idx);
        if (a.charging) {
          a.chargeT = E.chargeImpetusTime;
          a.charged = true;
        }
        note('cavalry_charge', { facing: FLANK_NAME[fl], forming });
      }
    } else if (b.arm === 'art') {
      shock(sim, b, -M.contactCavOnGuns, 'guns_overrun', a.idx);
      if (a.charging) a.charged = true;
      note('cavalry_overruns_guns');
    } else if (a.charging) {
      a.chargeT = E.chargeImpetusTime;
      a.charged = true;
      note('cavalry_melee');
    }
  } else if (a.arm === 'inf' && b.arm !== 'cav') {
    if (b.arm === 'art') {
      shock(sim, b, -M.contactInfOnGuns, 'guns_overrun', a.idx);
      note('infantry_overruns_guns');
    } else if (a.form === 'column' && a.wasMoving) {
      shock(sim, b, -M.contactBayonet * b.q, 'bayonet_charge', a.idx);
      note('bayonet_charge');
    }
  }
}

/** Apply queued losses together, so the order in which units acted cannot favour a side (MODEL 4.3). */
function applyHits(sim: Sim): void {
  const M = sim.data.morale;
  const cap = sim.data.melee.capturedShare;
  for (const h of sim.pending) {
    const u = sim.units[h.target];
    if (u.status === 'gone' || h.loss <= 0) continue;
    const total = u.lossCarry + h.loss;
    let n = Math.floor(total);
    u.lossCarry = total - n;
    if (n > u.men) {
      n = u.men;
      u.lossCarry = 0;
    }
    u.lastHitT = sim.t;
    sim.lastActivityT = sim.t;
    if (n <= 0) continue;
    u.men -= n;
    if (h.pursuit) {
      const c = Math.round(n * cap);
      u.captured += c;
      u.casualties += n - c;
    } else {
      u.casualties += n;
      shock(sim, u, -((n / u.startMen) * 100) * M.casualtyShock * h.k * u.q * (u.arm === 'art' ? M.artilleryCrewFactor : 1) * hooks.casualtyShockFactor(sim, u), h.cause, h.from);
    }
  }
  sim.pending.length = 0;
}

function contactPhase(sim: Sim): void {
  const { units, n, dt } = sim;
  const E = sim.data.melee;
  const pairs: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = units[i];
    if (a.status === 'gone') continue;
    for (let j = i + 1; j < n; j++) {
      const b = units[j];
      if (b.status === 'gone' || a.side === b.side) continue;
      const g = sim.gap[i * n + j];
      if (g >= E.contactDistance && !(g < E.contactDistance * E.contactHoldFactor && a.con.includes(j))) continue;
      const ar = a.status === 'rout';
      const br = b.status === 'rout';
      if (ar && br) continue;
      if (ar || br) {
        const p = ar ? b : a;
        const v = ar ? a : b;
        const rate = p.arm === 'cav' ? E.pursuitCavalry : p.arm === 'inf' ? E.pursuitInfantry : 0;
        if (rate > 0) sim.pending.push({ target: v.idx, loss: rate * dt, k: 0, cause: 'pursuit', from: p.idx, pursuit: true });
        continue;
      }
      if ((a.arm === 'cav' && a.blown > 0 && b.arm !== 'cav') || (b.arm === 'cav' && b.blown > 0 && a.arm !== 'cav')) continue;
      pairs.push(i, j);
    }
  }
  for (let k = 0; k < pairs.length; k += 2) {
    const a = units[pairs[k]];
    const b = units[pairs[k + 1]];
    a.con2.push(b.idx);
    b.con2.push(a.idx);
    const ci = a.idx * n + b.idx;
    if (!a.con.includes(b.idx) && sim.t - sim.contactT[ci] > E.recontactTime) {
      onContact(sim, a, b);
      onContact(sim, b, a);
    }
    sim.contactT[ci] = sim.t;
  }
  for (let k = 0; k < pairs.length; k += 2) {
    const a = units[pairs[k]];
    const b = units[pairs[k + 1]];
    if ((a.arm === 'cav' && a.blown > 0 && b.arm !== 'cav') || (b.arm === 'cav' && b.blown > 0 && a.arm !== 'cav')) continue;
    a.melee = b.melee = true;
    const pa = power(sim, a, b);
    const pb = power(sim, b, a);
    const ks = sim.data.morale.shockMelee;
    sim.pending.push({ target: b.idx, loss: E.lethality * pa * dt, k: ks, cause: 'melee', from: a.idx, pursuit: false });
    sim.pending.push({ target: a.idx, loss: E.lethality * pb * dt, k: ks, cause: 'melee', from: b.idx, pursuit: false });
  }
  applyHits(sim);
  for (const u of units) {
    const t = u.con;
    u.con = u.con2;
    u.con2 = t;
    u.con2.length = 0;
    // A squadron that charged home is blown once the melee is over (MODEL 6.4).
    if (u.arm === 'cav' && u.charged && !u.melee && u.status === 'ok') {
      u.charged = false;
      if (E.blownAfterCharge > 0 && u.blown <= 0) {
        u.blown = E.blownTime * hooks.blownFactor(sim, u);
        if (sim.eventLevel === 'full') emit(sim, { type: 'blown', unit: u.id, side: u.side });
      }
    }
  }
}

// ------------------------------------------------------------------ movement (MODEL 4)

export function baseSpeed(sim: Sim, u: Unit): number {
  if (u.arm === 'inf') {
    const d = u.doc!;
    if (u.form === 'line') return ((d.cadenceLine * d.paceLength) / 60) * d.lineDressingFactor;
    if (u.form === 'column') return (d.cadenceColumn * d.paceLength) / 60;
    return d.squareSpeed;
  }
  if (u.arm === 'cav') return u.charging ? u.ut.chargeSpeed! : u.ut.trotSpeed!;
  return u.ut.speed!;
}

export function turnRate(sim: Sim, u: Unit): number {
  if (u.arm === 'art') return sim.data.weapons.gunnery.turnRate;
  // A wheel on a fixed pivot: the outer flank marches at the quick pace (MODEL 4.2).
  if (u.arm === 'cav') return u.ut.turnRate!;
  return (u.doc!.cadenceColumn * u.doc!.paceLength) / 60 / (u.w > 10 ? u.w : 10);
}

function movementPhase(sim: Sim): void {
  const { units, dt, map } = sim;
  const M = sim.data.morale;
  const A = sim.data.ai;
  const T = sim.data.terrain;
  const margin = T.mapMargin;
  for (const u of units) {
    if (u.status === 'gone') continue;
    const side = sim.sides[u.side];
    if (u.status === 'rout') {
      const sp = (u.arm === 'cav' ? u.ut.routSpeed! : u.doc!.routSpeed) * dt;
      u.x += side.rearX * sp;
      u.y += side.rearY * sp;
      u.f = atan2(side.rearY, side.rearX);
      let nr2 = Infinity;
      for (const e of units) {
        if (e.side === u.side || e.status !== 'ok') continue;
        const dx = e.x - u.x;
        const dy = e.y - u.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < nr2) nr2 = d2;
      }
      const clear = nr2 > M.rallyEnemyDistance * M.rallyEnemyDistance;
      if (clear && u.morale < M.routRecoveryCap) u.morale = Math.min(M.routRecoveryCap, u.morale + M.routRecoveryRate * hooks.rallyFactor(sim, u) * dt);
      if (u.x < -margin || u.x > map.width + margin || u.y < -margin || u.y > map.height + margin) {
        remove(sim, u, 'left_field');
        continue;
      }
      if (!sim.over && clear && u.morale >= M.rallyMorale && u.men >= u.startMen * M.rallyMinStrength && u.rallies < M.maxRallies) {
        u.status = 'ok';
        u.rallies++;
        u.f = atan2(-side.rearY, -side.rearX);
        if (u.arm === 'inf') {
          u.form = 'line';
          u.formT = u.doc!.timeRallyReform;
        }
        u.thinkT = 0;
        setDims(u);
        emit(sim, { type: 'rally', unit: u.id, side: u.side, x: Math.round(u.x), y: Math.round(u.y), men: u.men });
      }
      refreshGeom(u);
      continue;
    }
    if (u.melee) {
      // Keep pressing an opponent whose ranks have thinned and drawn back (footprints shrink with losses).
      const o = u.order;
      if (o && o.type === 'attack') {
        const t = units[o.target];
        if (t && t.status === 'ok') {
          const g = gapOf(sim, u, t);
          const D = len(t.x - u.x, t.y - u.y);
          if (g > 1 && D > 1) {
            const adv = Math.min(g, baseSpeed(sim, u) * dt);
            u.x += ((t.x - u.x) / D) * adv;
            u.y += ((t.y - u.y) / D) * adv;
            refreshGeom(u);
          }
        }
      }
      continue;
    }
    if (u.formT > 0) continue;
    let destX = NaN,
      destY = NaN,
      face = NaN;
    u.charging = false;
    const o = u.order;
    if (o) {
      if (o.type === 'attack') {
        const t = units[o.target];
        if (!t || t.status === 'gone') u.order = null;
        else {
          const g = gapOf(sim, u, t);
          let stop: number;
          if (u.arm === 'cav') {
            stop = -12;
            u.charging = g < u.ut.chargeStartRange! && u.blown <= 0 && hooks.mayGallop(sim, u);
          } else if (u.arm === 'art') stop = u.gun!.roundshotEffectiveRange * A.artAdvanceFraction;
          else stop = o.charge || t.status === 'rout' ? -12 : A.engageRange;
          if (g > stop) {
            destX = t.x;
            destY = t.y;
          } else face = atan2(t.y - u.y, t.x - u.x);
        }
      } else {
        if (len(o.x - u.x, o.y - u.y) < 7) u.order = null;
        else {
          destX = o.x;
          destY = o.y;
        }
      }
    }
    const sq = u.arm === 'inf' && u.form === 'square';
    if (destX === destX) {
      const h = atan2(destY - u.y, destX - u.x);
      const tr = turnRate(sim, u) * dt;
      const dd = angDiff(h, u.f);
      if (!sq) u.f += clamp(dd, -tr, tr);
      const tol = (u.arm === 'cav' ? A.moveFaceToleranceCavalry : A.moveFaceToleranceInfantry) * DEG;
      if (sq || (dd < 0 ? -dd : dd) < tol) {
        let sp = baseSpeed(sim, u);
        if (u.feat) sp *= u.arm === 'inf' ? u.feat.tt.moveInfantry : u.arm === 'cav' ? u.feat.tt.moveCavalry : u.feat.tt.moveArtillery;
        else {
          const [gx, gy] = gradAt(map, u.x, u.y);
          if (gx * gx + gy * gy > T.slopeThreshold * T.slopeThreshold) sp *= T.slopeMove;
        }
        sp *= hooks.speedFactor(sim, u, h);
        const step = sp * dt;
        const remaining = len(destX - u.x, destY - u.y);
        const adv = step < remaining ? step : remaining;
        u.x += (Math.abs(dd) < 1e-9 ? u.c : (destX - u.x) / (remaining || 1)) * adv;
        u.y += (Math.abs(dd) < 1e-9 ? u.s : (destY - u.y) / (remaining || 1)) * adv;
        u.moving = true;
        u.settle = 0;
        sim.lastActivityT = sim.t;
        const ru = (u.w > u.d ? u.w : u.d) / 2;
        for (const v of units) {
          if (v === u || v.side !== u.side || v.status !== 'ok') continue;
          const dx = u.x - v.x;
          const dy = u.y - v.y;
          const m = (ru + (v.w > v.d ? v.w : v.d) / 2) * A.separationFactor;
          if (dx > m || dx < -m || dy > m || dy < -m) continue;
          const d = len(dx, dy);
          if (d < m && d > 0.01) {
            const p = Math.min((m - d) * A.separationPush, step * 0.9);
            u.x += (dx / d) * p;
            u.y += (dy / d) * p;
          }
        }
        u.x = clamp(u.x, margin, map.width - margin);
        u.y = clamp(u.y, margin, map.height - margin);
        hooks.onMoved(sim, u, adv);
      }
      refreshGeom(u);
    } else {
      const want = face === face ? face : u.aim;
      if (want === want && !sq) {
        const tr = turnRate(sim, u) * dt;
        const dd = angDiff(want, u.f);
        if (u.arm !== 'inf' || face === face || (dd < 0 ? -dd : dd) > A.faceTolerance * DEG) {
          u.f += clamp(dd, -tr, tr);
          refreshGeom(u);
        }
      }
    }
  }
}

// ------------------------------------------------------------------ fire (MODEL 5)

/** Exact binomial draw with a local generator seeded from the tick hash. */
function binomial(sim: Sim, stream: number, key: number, n: number, p: number): number {
  if (n <= 0 || p <= 0) return 0;
  if (p >= 1) return n;
  const r = mulberry32(hash4(sim.seed ^ Math.imul(stream, 0x9e3779b1), key, sim.tick, 0x51ed));
  let k = 0;
  for (let i = 0; i < n; i++) if (r() < p) k++;
  return k;
}

function ranksAlongFire(u: Unit, fl: number, cap: number): number {
  let r: number;
  if (u.arm === 'inf') {
    const d = u.doc!;
    if (u.form === 'square' || fl !== 0) r = cap;
    else r = u.form === 'column' ? d.ranks * d.columnDivisions : d.ranks;
  } else if (u.arm === 'cav') r = fl !== 0 ? cap : u.ut.ranks!;
  else r = 1;
  return r < cap ? r : cap;
}

function firePhase(sim: Sim): void {
  const { units, n } = sim;
  const W = sim.data.weapons.musketry;
  const G = sim.data.weapons.gunnery;
  const M = sim.data.morale;
  const A = sim.data.ai;
  const T = sim.data.terrain;
  const full = sim.eventLevel === 'full';
  for (const u of units) {
    if (u.status !== 'ok' || u.arm === 'cav') continue;
    u.aim = NaN;
    if (u.melee || u.formT > 0) continue;
    if (u.arm === 'inf') {
      let t: Unit | null = null,
        tg = Infinity,
        tgs = Infinity,
        look: Unit | null = null,
        lg = W.lookRange;
      const row = u.idx * n;
      const range = W.openFireRange * hooks.musketRangeFactor(sim, u);
      for (const e of units) {
        if (e.side === u.side || e.status !== 'ok') continue;
        const g = sim.gap[row + e.idx];
        if (g < lg && hooks.canSee(sim, u, e)) {
          lg = g;
          look = e;
        }
        if (e.melee) continue;
        const gg = g + (e.arm === 'art' ? W.artilleryTargetPenalty : 0);
        if (g < range && gg < tgs && hooks.canSee(sim, u, e)) {
          tgs = gg;
          tg = g;
          t = e;
        }
      }
      const sq = u.form === 'square';
      const at = t ?? look;
      if (at) u.aim = atan2(at.y - u.y, at.x - u.x);
      if (!t || u.moving || u.reload > 0) continue;
      if (!hooks.canFire(sim, u)) continue;
      if (!sq && Math.abs(angDiff(u.aim, u.f)) > W.arcHalfAngle * DEG) continue;
      const mk = u.musket!;
      const muskets = musketsBearing(sim, u);
      let p = interp(mk.trialCurve, tg) * mk.battlefieldFactor * (W.moraleFloor + ((1 - W.moraleFloor) * clamp(u.morale, 0, 100)) / 100);
      if (t.arm === 'art') p *= W.vsArtillery;
      else if (t.arm === 'inf' && t.form === 'column') p *= W.vsColumn;
      if (t.feat) p *= t.feat.tt.coverMusketry;
      if (higher(sim, u, t)) p *= T.highGroundFire;
      p *= hooks.musketFactor(sim, u, t, tg);
      const loss = binomial(sim, STREAM.MUSKET, u.idx, muskets, p);
      const fl = flankOf(sim, u, t);
      const k = t.arm === 'inf' && fl !== 0 ? M.shockFireFlank : t.arm === 'inf' && t.form === 'column' && tg < M.columnCloseRange ? M.shockColumnClose : M.shockFireFront;
      const cause = t.arm === 'inf' && fl !== 0 ? 'musketry_flank' : k === M.shockColumnClose ? 'musketry_close_on_column' : 'musketry';
      sim.pending.push({ target: t.idx, loss, k, cause, from: u.idx, pursuit: false });
      u.reload = (60 / mk.roundsPerMinute) * hooks.reloadFactor(sim, u) * (1 - mk.reloadJitter + 2 * mk.reloadJitter * rnd(sim, STREAM.RELOAD, u.idx));
      sim.lastActivityT = sim.t;
      hooks.onFired(sim, u, 'musket', muskets, tg);
      if (full) emit(sim, { type: 'fire', unit: u.id, side: u.side, target: t.id, kind: 'musket', loss, range: Math.round(tg) });
      if (t.arm === 'cav' && tg < M.cavRecoilRange && t.morale < M.cavRecoilMorale && t.blown <= 0 && !t.melee) {
        bounce(sim, t, u);
        if (full) emit(sim, { type: 'contact', unit: t.id, side: t.side, target: u.id, kind: 'cavalry_recoils_from_volley' });
      }
    } else {
      const gun = u.gun!;
      const eff = gun.roundshotEffectiveRange;
      const maxRange = gun.roundshotMaxRange * hooks.gunRangeFactor(sim, u);
      let t: Unit | null = null,
        bs = 0;
      const row = u.idx * n;
      for (const e of units) {
        if (e.side === u.side || e.status !== 'ok' || e.melee) continue;
        const g = sim.gap[row + e.idx];
        if (g > maxRange) continue;
        if (!hooks.canSee(sim, u, e)) continue;
        let sc = (e.arm === 'inf' ? (e.form === 'square' ? A.artScoreSquare : e.form === 'column' ? A.artScoreColumn : A.artScoreLine) : e.arm === 'cav' ? A.artScoreCavalry : A.artScoreArtillery) / (1 + g / (A.artDistanceScale * eff));
        if (g < gun.canisterRange) sc *= A.artCanisterPriority;
        if (e.idx === u.pref) sc *= A.artPreferredBonus;
        if (sc > bs) {
          bs = sc;
          t = e;
        }
      }
      if (!t) continue;
      u.aim = atan2(t.y - u.y, t.x - u.x);
      if (u.moving || u.settle < G.unlimberTime || u.reload > 0 || Math.abs(angDiff(u.aim, u.f)) > G.aimTolerance * DEG) continue;
      const g = sim.gap[row + t.idx];
      const can = g < gun.canisterRange && hooks.hasCanister(sim, u);
      if (!can && !hooks.hasRoundshot(sim, u)) continue;
      const guns = u.ut.guns! * (u.men / u.startMen);
      let mean: number;
      if (can) {
        const mult = t.arm === 'inf' ? (t.form === 'square' ? G.canisterVsSquare : t.form === 'column' ? G.canisterVsColumn : G.canisterVsLine) : t.arm === 'cav' ? G.canisterVsCavalry : G.canisterVsArtillery;
        mean = guns * interp(gun.canisterHitsCurve, g) * gun.canisterBattlefieldFactor * mult;
      } else {
        const fl = flankOf(sim, u, t);
        let perHit = ranksAlongFire(t, fl, gun.maxRanksTraversed) * gun.menPerRank;
        if (t.arm === 'inf' && t.form === 'square') perHit *= gun.squareTargetFactor;
        mean = guns * interp(gun.roundshotCurve, g) * gun.roundshotBattlefieldFactor * perHit;
        if (higher(sim, t, u)) mean *= T.roundshotUphill;
      }
      if (t.feat) mean *= t.feat.tt.coverArtillery;
      mean *= hooks.gunFactor(sim, u, t, g, can);
      mean *= 1 - G.strengthJitter + 2 * G.strengthJitter * rnd(sim, STREAM.GUN, u.idx);
      // stochastic rounding keeps men whole without biasing the mean
      let loss = Math.floor(mean);
      if (rnd(sim, STREAM.GUN, u.idx, 1) < mean - loss) loss++;
      sim.pending.push({ target: t.idx, loss, k: can ? M.shockCanister : M.shockRoundshot, cause: can ? 'canister' : 'roundshot', from: u.idx, pursuit: false });
      u.reload = (can ? gun.canisterReload : gun.roundshotReload) * hooks.reloadFactor(sim, u) * (0.9 + 0.2 * rnd(sim, STREAM.RELOAD, u.idx));
      sim.lastActivityT = sim.t;
      hooks.onFired(sim, u, can ? 'canister' : 'roundshot', guns, g);
      if (full) emit(sim, { type: 'fire', unit: u.id, side: u.side, target: t.id, kind: can ? 'canister' : 'roundshot', loss, range: Math.round(g) });
    }
  }
  applyHits(sim);
}

// ------------------------------------------------------------------ construction

export function createSim(scenario: Scenario, data: Data, seed: number, opts: SimOptions = {}): Sim {
  checkData(data);
  const errs = validateScenario(scenario, data);
  if (errs.length) throw new Error('Scenario errors:\n  ' + errs.join('\n  '));
  const expanded = expandUnits(scenario, data);
  const map = buildMap(scenario.map, data);
  const features = { ...NO_FEATURES, ...(scenario.features ?? {}) };
  const M = data.morale;
  const sim: Sim = {
    scenario,
    data,
    features,
    seed: seed | 0,
    dt: opts.dt ?? 1,
    tick: 0,
    t: 0,
    units: [],
    byId: new Map(),
    sides: scenario.sides.map((s) => {
      const l = len(s.rear[0], s.rear[1]);
      return { id: s.id, name: s.name, posture: s.posture, rearX: s.rear[0] / l, rearY: s.rear[1] / l, initUnits: 0, initMen: 0, ai: true, brokeAt: -1, breakX: NaN, breakY: NaN, breakCentroidX: NaN, breakCentroidY: NaN, tipUnit: -1 };
    }),
    map,
    n: expanded.length,
    gap: new Float64Array(expanded.length * expanded.length),
    contactT: new Float64Array(expanded.length * expanded.length).fill(-1e9),
    over: null,
    ended: false,
    endReason: '',
    lastActivityT: 0,
    events: [],
    eventLevel: opts.events ?? 'summary',
    nextEventId: 1,
    routs: [],
    pending: [],
    inputs: [],
    ext: {},
  };
  expanded.forEach((e, idx) => {
    const ut = data.units[e.type];
    const doc = ut.arm === 'inf' ? data.doctrine[ut.doctrine!] : null;
    if (ut.arm === 'inf' && !doc) throw new Error(`unit type ${e.type}: unknown doctrine '${ut.doctrine}'`);
    const musket = ut.arm === 'inf' ? data.weapons.muskets[ut.weapon!] : null;
    const gun = ut.arm === 'art' ? data.weapons.guns[ut.gun!] : null;
    const qc = data.quality.classes[e.quality];
    if (!qc) throw new Error(`unit ${e.id}: unknown quality '${e.quality}'`);
    const q = qc.steadiness;
    const u: Unit = {
      idx, id: e.id, name: e.name, side: e.side, typeId: e.type, arm: ut.arm, ut, doc, musket, gun, quality: e.quality, q, parent: e.parent,
      x: e.x, y: e.y, f: e.facing, w: 0, d: 0, c: 1, s: 0, cx: new Float64Array(8), elev: 0, feat: null, onSlope: false,
      startMen: e.men, men: e.men, casualties: 0, captured: 0, dispersed: 0, detached: 0, lossCarry: 0,
      morale: q < M.steadyThreshold ? M.startMoraleSteady : M.startMorale,
      form: e.formation, formT: 0, status: 'ok', goneReason: '', goneT: -1,
      order: null, manual: false,
      reload: 0, settle: 1e9, blown: 0, thinkT: (idx * 7) % Math.max(1, Math.round(data.ai.thinkInterval)),
      moving: false, wasMoving: false, melee: false, wasMelee: false, charged: false, chargeT: 0, charging: false, lastHitT: -1e9,
      homeX: e.x, homeY: e.y, aim: NaN, con: [], con2: [], rallies: 0, avoidId: -1, avoidUntil: 0, pref: -1, everRouted: false,
      ledger: [], recent: [], lastRoutEvent: 0,
      fatigue: 0, ammo: 0, roundsFired: 0, gunRounds: 0, gunCanister: 0, skirmishers: 0, skirmishOut: false,
      posture: scenario.sides[e.side].posture, objX: NaN, objY: NaN, inCommand: true,
    };
    if (sim.byId.has(u.id)) throw new Error(`duplicate unit id '${u.id}'`);
    // stagger first volleys a little, as the prototype did
    u.reload = ut.arm === 'cav' ? 0 : 10 * (hash4(sim.seed ^ 0x5bd1e995, idx, 0, STREAM.DEPLOY) / 4294967296);
    setDims(u);
    refreshGeom(u);
    refreshTerrain(sim, u);
    sim.units.push(u);
    sim.byId.set(u.id, u);
    sim.sides[u.side].initUnits++;
    sim.sides[u.side].initMen += u.men;
  });
  for (const s of sim.sides) if (s.initUnits === 0) throw new Error(`side ${s.id} has no units`);
  hooks.init(sim, expanded);
  computeGaps(sim);
  return sim;
}

// ------------------------------------------------------------------ outside input

export function applyInput(sim: Sim, input: Omit<SimInput, 't'>): void {
  const rec: SimInput = { ...input, t: sim.t };
  sim.inputs.push(rec);
  execInput(sim, rec);
}

export function execInput(sim: Sim, input: SimInput): void {
  if (input.kind === 'posture' && input.side && input.posture) {
    const i = sim.sides.findIndex((s) => s.id === input.side);
    if (i < 0) return;
    sim.sides[i].posture = input.posture;
    for (const u of sim.units) if (u.side === i && !sim.features.commandControl) u.posture = input.posture;
    emit(sim, { type: 'input', kind: 'posture', side: i, posture: input.posture });
    return;
  }
  if (input.kind === 'command_order') {
    hooks.onCommandInput(sim, input);
    return;
  }
  const u = input.unit ? sim.byId.get(input.unit) : undefined;
  if (!u || u.status !== 'ok') return;
  if (input.kind === 'unit_release') {
    u.manual = false;
    u.thinkT = 0;
  } else if (input.kind === 'unit_formation' && input.formation) {
    u.manual = true;
    setFormation(sim, u, input.formation);
  } else if (input.kind === 'unit_order' && input.order) {
    u.manual = true;
    const o = input.order;
    if (o.type === 'halt') u.order = null;
    else if (o.type === 'attack') {
      const t = o.target ? sim.byId.get(o.target) : undefined;
      if (t) {
        u.order = { type: 'attack', target: t.idx, x: 0, y: 0, charge: o.charge ?? (u.arm === 'inf' && u.form === 'column') };
        u.pref = t.idx;
      }
    } else u.order = { type: 'move', target: -1, x: o.x ?? u.x, y: o.y ?? u.y, charge: false };
  }
  emit(sim, { type: 'input', kind: input.kind, unit: input.unit, detail: input.order ?? input.formation ?? null });
}

// ------------------------------------------------------------------ the tick

export function step(sim: Sim): void {
  if (sim.ended) return;
  const { units, dt } = sim;
  const M = sim.data.morale;
  const A = sim.data.ai;
  sim.tick++;
  sim.t = sim.tick * dt;

  hooks.preTick(sim);

  // 1. timers and decisions
  for (const u of units) {
    if (u.status === 'gone') continue;
    u.wasMoving = u.moving;
    u.wasMelee = u.melee;
    u.moving = false;
    u.melee = false;
    if (u.blown > 0) u.blown = u.blown > dt ? u.blown - dt : 0;
    if (u.formT > 0) u.formT = u.formT > dt ? u.formT - dt : 0;
    if (u.chargeT > 0) u.chargeT = u.chargeT > dt ? u.chargeT - dt : 0;
    u.settle += dt;
    u.reload -= dt;
    if (u.status !== 'ok') continue;
    u.thinkT -= dt;
    if (u.thinkT <= 0) {
      u.thinkT = A.thinkInterval;
      if (!u.manual && sim.sides[u.side].ai) think(sim, u);
    }
  }

  // 2. contact and melee
  contactPhase(sim);

  // 3. break tests
  for (const u of units) {
    if (u.status === 'gone') continue;
    if (u.men < u.startMen * M.destroyedFraction) {
      remove(sim, u, u.status === 'rout' ? 'scattered' : 'destroyed');
      continue;
    }
    if (u.status === 'ok' && u.morale <= M.routThreshold * hooks.routThresholdFactor(sim, u)) rout(sim, u);
  }

  // 4. movement, rout and rally
  movementPhase(sim);
  for (const u of units) {
    if (u.status === 'gone') continue;
    setDims(u);
    refreshGeom(u);
    refreshTerrain(sim, u);
  }
  computeGaps(sim);

  // 5. fire
  hooks.preFire(sim);
  firePhase(sim);

  // 6. recovery
  for (const u of units) {
    if (u.status !== 'ok') continue;
    if (!u.melee && sim.t - u.lastHitT > M.recoveryDelay) {
      const cap = 100 * (M.recoveryCapBase + ((1 - M.recoveryCapBase) * u.men) / u.startMen);
      if (u.morale < cap) u.morale = Math.min(cap, u.morale + M.recoveryRate * hooks.recoveryFactor(sim, u) * dt);
    }
    if (u.morale > 100) u.morale = 100;
  }

  hooks.postTick(sim);

  // 7. army break
  if (!sim.over) {
    const losers: number[] = [];
    for (let s = 0; s < sim.sides.length; s++) {
      let formed = 0;
      for (const u of units) if (u.side === s && u.status === 'ok') formed++;
      if (formed / sim.sides[s].initUnits <= 1 - M.armyBreakFraction + 1e-9) losers.push(s);
    }
    if (losers.length) {
      sim.over = { t: sim.t, losers };
      for (const s of losers) {
        const side = sim.sides[s];
        side.brokeAt = sim.t;
        // where: the unit whose loss tipped the army over, and the centroid of everything already broken
        let last: RoutRecord | undefined;
        let cx = 0,
          cy = 0,
          cn = 0;
        for (const r of sim.routs) {
          if (r.side !== s) continue;
          last = r;
          cx += r.x;
          cy += r.y;
          cn++;
        }
        if (last) {
          side.tipUnit = last.unit;
          side.breakX = last.x;
          side.breakY = last.y;
          side.breakCentroidX = cx / cn;
          side.breakCentroidY = cy / cn;
        }
        emit(sim, { type: 'army_broken', side: s, x: Math.round(side.breakX), y: Math.round(side.breakY), tipUnit: last ? units[last.unit].id : null });
        for (const u of units) {
          if (u.side === s && u.status === 'ok') {
            u.morale = 0;
            rout(sim, u, 'army_broken');
          }
        }
      }
    }
  }

  if (sim.tick % 10 === 0) for (const u of units) if (u.status !== 'gone') flushLedger(sim, u);

  // 8. end conditions
  if (sim.over && sim.t - sim.over.t >= M.aftermathDuration) {
    sim.ended = true;
    sim.endReason = sim.over.losers.length > 1 ? 'mutual_break' : 'army_broken';
  } else if (sim.t >= sim.scenario.timeLimit) {
    sim.ended = true;
    sim.endReason = sim.over ? (sim.over.losers.length > 1 ? 'mutual_break' : 'army_broken') : 'time_limit';
  } else if (!sim.over && sim.t - sim.lastActivityT > (sim.scenario.stallLimit ?? 1200)) {
    sim.ended = true;
    sim.endReason = 'stalemate';
  }
  if (sim.ended) {
    for (const u of units) if (u.status !== 'gone') flushLedger(sim, u);
    emit(sim, { type: 'end', reason: sim.endReason });
  }
}

export function makeOrder(type: Order['type'], target: number, x: number, y: number, charge: boolean): Order {
  return { type, target, x, y, charge };
}
