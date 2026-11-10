import type { Data, Doctrine, Gun, Musket, UnitType } from './data.ts';
import type { BuiltFeature, Features, Formation, GameMap, Posture, Scenario } from './scenario.ts';

export type Arm = 'inf' | 'cav' | 'art';
export type Status = 'ok' | 'rout' | 'gone';
export type GoneReason = '' | 'destroyed' | 'scattered' | 'left_field' | 'guns_abandoned';

export interface Order {
  type: 'attack' | 'move';
  target: number; // unit index for attack, -1 otherwise
  x: number;
  y: number;
  charge: boolean;
}

export interface LedgerEntry {
  cause: string;
  from: number;
  delta: number;
  parent: number;
}
export interface MoraleRecord {
  id: number;
  t: number;
  cause: string;
  from: number;
  delta: number;
  parent: number;
}

export interface Unit {
  idx: number;
  id: string;
  name: string;
  side: number;
  typeId: string;
  arm: Arm;
  ut: UnitType;
  doc: Doctrine | null;
  musket: Musket | null;
  gun: Gun | null;
  quality: string;
  /** Steadiness: multiplier on morale loss. Lower is steadier. */
  q: number;
  parent: string | null;

  x: number;
  y: number;
  f: number;
  w: number;
  d: number;
  c: number;
  s: number;
  cx: Float64Array;
  elev: number;
  feat: BuiltFeature | null;
  onSlope: boolean;

  startMen: number;
  men: number;
  casualties: number;
  captured: number;
  dispersed: number;
  detached: number;
  lossCarry: number;
  /** Men lost to pursuit so far; prisoners are a fixed share of this running total. */
  pursued: number;

  morale: number;
  form: Formation | null;
  formT: number;
  status: Status;
  goneReason: GoneReason;
  goneT: number;

  order: Order | null;
  manual: boolean;
  reload: number;
  settle: number;
  blown: number;
  thinkT: number;
  moving: boolean;
  wasMoving: boolean;
  melee: boolean;
  wasMelee: boolean;
  charged: boolean;
  chargeT: number;
  charging: boolean;
  lastHitT: number;
  homeX: number;
  homeY: number;
  aim: number; // NaN when none
  con: number[];
  con2: number[];
  rallies: number;
  avoidId: number;
  avoidUntil: number;
  pref: number;
  everRouted: boolean;

  ledger: LedgerEntry[];
  recent: MoraleRecord[];
  lastRoutEvent: number;

  // Phase 4 state (inert unless the feature is on)
  fatigue: number;
  ammo: number;
  roundsFired: number;
  gunRounds: number;
  gunCanister: number;
  skirmishers: number;
  skirmishOut: boolean;
  posture: Posture; // effective posture; equals the side's unless command and control overrides it
  objX: number; // NaN when none
  objY: number;
  inCommand: boolean;
}

export interface SimEvent {
  id: number;
  t: number;
  type: string;
  unit?: string;
  side?: number;
  x?: number;
  y?: number;
  [k: string]: unknown;
}

export interface RoutRecord {
  eventId: number;
  t: number;
  unit: number;
  side: number;
  x: number;
  y: number;
  kind: 'rout' | 'destroyed' | 'guns_abandoned' | 'army_broken';
  topCause: string;
  trigger: string;
  rootCause: string;
  rootUnit: string;
}

export interface SideState {
  id: string;
  name: string;
  posture: Posture;
  rearX: number;
  rearY: number;
  initUnits: number;
  initMen: number;
  ai: boolean;
  brokeAt: number; // -1 if not broken
  breakX: number;
  breakY: number;
  breakCentroidX: number;
  breakCentroidY: number;
  tipUnit: number;
}

export interface SimOptions {
  /** 'summary': routs and army events only. 'full': every morale change, charge and volley. */
  events?: 'summary' | 'full';
  /** Fixed timestep in seconds. Default 1. */
  dt?: number;
}

export type EndReason = '' | 'army_broken' | 'mutual_break' | 'time_limit' | 'stalemate';

export interface Sim {
  scenario: Scenario;
  data: Data;
  features: Features;
  seed: number;
  dt: number;
  tick: number;
  t: number;
  units: Unit[];
  byId: Map<string, Unit>;
  sides: SideState[];
  map: GameMap;
  n: number;
  gap: Float64Array;
  contactT: Float64Array;
  over: { t: number; losers: number[] } | null;
  ended: boolean;
  endReason: EndReason;
  lastActivityT: number;
  events: SimEvent[];
  eventLevel: 'summary' | 'full';
  nextEventId: number;
  routs: RoutRecord[];
  pending: PendingHit[];
  inputs: SimInput[];
  // feature state, created lazily by the feature modules
  ext: Record<string, unknown>;
}

export interface PendingHit {
  target: number;
  loss: number;
  k: number;
  cause: string;
  from: number;
  pursuit: boolean;
}

/** An outside intervention, recorded so that a run with interventions can be reproduced. */
export interface SimInput {
  t: number;
  kind: 'unit_order' | 'unit_formation' | 'unit_release' | 'posture' | 'command_order';
  unit?: string;
  side?: string;
  order?: { type: 'attack' | 'move' | 'halt'; target?: string; x?: number; y?: number; charge?: boolean };
  formation?: Formation;
  posture?: Posture;
  payload?: unknown;
}
