// Extension points for the deeper-model features (Phase 4). Each hook checks the scenario's
// feature toggles, so with every toggle off these all reduce to the baseline: factor 1, no-op.

import type { ExpandedUnit } from './scenario.ts';
import type { Sim, SimInput, Unit } from './types.ts';

export const hooks = {
  init(_sim: Sim, _expanded: ExpandedUnit[]): void {},
  preTick(_sim: Sim): void {},
  preFire(_sim: Sim): void {},
  postTick(_sim: Sim): void {},
  onCommandInput(_sim: Sim, _input: SimInput): void {},
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
  recoveryFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  rallyFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  blownFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  cavLeashFactor(_sim: Sim, _u: Unit): number {
    return 1;
  },
  /** Lets command and control replace the posture-driven choice. Return true if it set the unit's order. */
  aiOverride(_sim: Sim, _u: Unit, _nearest: Unit | null, _dist: number): boolean {
    return false;
  },
};
