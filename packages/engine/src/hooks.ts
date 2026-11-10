// Extension points for the deeper-model features (Phase 4). Each hook checks the scenario's
// feature toggles, so with every toggle off these all reduce to the baseline: factor 1, no-op.

import type { ExpandedUnit } from './scenario.ts';
import type { Sim, SimInput, Unit } from './types.ts';
import * as command from './features/command.ts';

export const hooks = {
  init(sim: Sim, expanded: ExpandedUnit[]): void {
    if (sim.features.commandControl) command.init(sim, expanded);
  },
  preTick(sim: Sim): void {
    if (sim.features.commandControl) command.update(sim);
  },
  preFire(_sim: Sim): void {},
  postTick(_sim: Sim): void {},
  onCommandInput(sim: Sim, input: SimInput): void {
    if (sim.features.commandControl) command.onCommandInput(sim, input);
  },
  onRout(_sim: Sim, _u: Unit): void {},
  onRemove(_sim: Sim, _u: Unit): void {},
  onMoved(_sim: Sim, _u: Unit, _metres: number): void {},
  onFired(_sim: Sim, _u: Unit, _kind: 'musket' | 'roundshot' | 'canister', _shots: number, _range: number): void {},

  canSee(_sim: Sim, _a: Unit, _b: Unit): boolean {
    return true;
  },
  canFire(_sim: Sim, _u: Unit): boolean {
    return true;
  },
  hasCanister(_sim: Sim, _u: Unit): boolean {
    return true;
  },
  hasRoundshot(_sim: Sim, _u: Unit): boolean {
    return true;
  },

  speedFactor(_sim: Sim, _u: Unit, _heading: number): number {
    return 1;
  },
  drillTimeFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  reloadFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  musketFactor(_sim: Sim, _u: Unit, _t: Unit, _range: number): number {
    return 1;
  },
  musketRangeFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  gunFactor(_sim: Sim, _u: Unit, _t: Unit, _range: number, _canister: boolean): number {
    return 1;
  },
  gunRangeFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  meleeFactor(_sim: Sim, _a: Unit, _b: Unit): number {
    return 1;
  },
  casualtyShockFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  rippleFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  routThresholdFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  recoveryFactor(sim: Sim, u: Unit): number {
    let f = 1;
    if (sim.features.commandControl) f *= command.recoveryFactor(sim, u);
    return f;
  },
  rallyFactor(sim: Sim, u: Unit): number {
    let f = 1;
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
