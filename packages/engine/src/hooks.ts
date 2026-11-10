// Extension points for the deeper-model features (Phase 4). Each hook checks the scenario's
// feature toggles, so with every toggle off these all reduce to the baseline: factor 1, no-op.

import type { ExpandedUnit } from './scenario.ts';
import type { Sim, SimInput, Unit } from './types.ts';
import * as command from './features/command.ts';
import * as endurance from './features/endurance.ts';
import * as skirmish from './features/skirmish.ts';
import * as los from './features/los.ts';

const QC = (sim: Sim, u: Unit) => sim.data.quality.classes[u.quality];

export const hooks = {
  init(sim: Sim, expanded: ExpandedUnit[]): void {
    if (sim.features.fatigue || sim.features.ammunition) endurance.init(sim);
    if (sim.features.elevationLos) los.init(sim);
    if (sim.features.skirmishers) skirmish.init(sim, expanded);
    if (sim.features.commandControl) command.init(sim, expanded);
  },
  preTick(sim: Sim): void {
    if (sim.features.commandControl) command.update(sim);
  },
  preFire(sim: Sim): void {
    if (sim.features.skirmishers) skirmish.update(sim);
  },
  postTick(sim: Sim): void {
    if (sim.features.fatigue || sim.features.ammunition) endurance.postTick(sim);
  },
  onCommandInput(sim: Sim, input: SimInput): void {
    if (sim.features.commandControl) command.onCommandInput(sim, input);
  },
  onRout(sim: Sim, u: Unit): void {
    if (sim.features.skirmishers) skirmish.onBreak(sim, u);
  },
  onRemove(sim: Sim, u: Unit): void {
    if (sim.features.skirmishers) skirmish.onBreak(sim, u);
  },
  onMoved(sim: Sim, u: Unit, metres: number): void {
    if (sim.features.fatigue) endurance.onMoved(sim, u, metres);
  },
  onFormationChange(sim: Sim, u: Unit): void {
    if (sim.features.fatigue) endurance.onFormationChange(sim, u);
  },
  onFired(sim: Sim, u: Unit, kind: 'musket' | 'roundshot' | 'canister', shots: number, _range: number): void {
    if (sim.features.fatigue || sim.features.ammunition) endurance.onFired(sim, u, kind, shots);
  },

  canSee(sim: Sim, a: Unit, b: Unit): boolean {
    if (sim.features.elevationLos && !los.canSee(sim, a, b)) return false;
    return true;
  },
  canFire(sim: Sim, u: Unit): boolean {
    return endurance.canFire(sim, u);
  },
  hasCanister(sim: Sim, u: Unit): boolean {
    return endurance.hasCanister(sim, u);
  },
  hasRoundshot(sim: Sim, u: Unit): boolean {
    return endurance.hasRoundshot(sim, u);
  },
  /** Infantry that cannot fire closes with the bayonet instead of standing in a firefight. */
  mustCharge(sim: Sim, u: Unit): boolean {
    return endurance.outOfAmmo(sim, u);
  },
  mayGallop(sim: Sim, u: Unit): boolean {
    return !endurance.tooTiredToCharge(sim, u);
  },

  speedFactor(sim: Sim, u: Unit, heading: number): number {
    let f = endurance.speedFactor(sim, u);
    if (sim.features.elevationLos) f *= los.slopeSpeed(sim, u, heading);
    return f;
  },
  // quality (MODEL 12.4): with the toggle on, a unit's class also scales its fire, loading, drill, melee and rallying
  drillTimeFactor(sim: Sim, u: Unit): number {
    return sim.features.quality ? QC(sim, u).drill : 1;
  },
  reloadFactor(sim: Sim, u: Unit): number {
    return endurance.reloadFactor(sim, u) * (sim.features.quality ? QC(sim, u).reload : 1);
  },
  musketFactor(sim: Sim, u: Unit, _t: Unit, _range: number): number {
    return endurance.musketFactor(sim, u) * (sim.features.quality ? QC(sim, u).fire : 1);
  },
  musketRangeFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  gunFactor(sim: Sim, u: Unit, _t: Unit, _range: number, _canister: boolean): number {
    return sim.features.quality ? QC(sim, u).fire : 1;
  },
  gunRangeFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  meleeFactor(sim: Sim, a: Unit, _b: Unit): number {
    return endurance.meleeFactor(sim, a) * (sim.features.quality ? QC(sim, a).melee : 1);
  },
  casualtyShockFactor(sim: Sim, u: Unit): number {
    return endurance.shockFactor(sim, u);
  },
  rippleFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  routThresholdFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  recoveryFactor(sim: Sim, u: Unit): number {
    let f = endurance.recoveryFactor(sim, u);
    if (sim.features.commandControl) f *= command.recoveryFactor(sim, u);
    return f;
  },
  rallyFactor(sim: Sim, u: Unit): number {
    let f = sim.features.quality ? QC(sim, u).rally : 1;
    if (sim.features.commandControl) f *= command.rallyFactor(sim, u);
    return f;
  },
  blownFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  cavLeashFactor(sim: Sim, u: Unit): number {
    return sim.features.commandControl ? command.cavLeashFactor(sim, u) : 1;
  },
  /** Lets command and control replace the posture-driven choice. Return true if it set the unit's order. */
  aiOverride(sim: Sim, u: Unit, nearest: Unit | null, dist: number): boolean {
    return sim.features.commandControl ? command.aiOverride(sim, u, nearest, dist) : false;
  },
};
