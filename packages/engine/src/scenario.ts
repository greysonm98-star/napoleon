// Scenario format, validation, expansion of deploy blocks and groups, and map construction.

import type { Data, TerrainType } from './data.ts';
import { DEG, atan2, len } from './math.ts';

export type Posture = 'defend' | 'attack_line' | 'attack_column';
export type Formation = 'line' | 'column' | 'square';

export interface Features {
  commandControl: boolean;
  fatigue: boolean;
  ammunition: boolean;
  skirmishers: boolean;
  quality: boolean;
  elevationLos: boolean;
  smoke: boolean;
  weatherGround: boolean;
}
export const FEATURE_KEYS: (keyof Features)[] = ['commandControl', 'fatigue', 'ammunition', 'skirmishers', 'quality', 'elevationLos', 'smoke', 'weatherGround'];
export const NO_FEATURES: Features = { commandControl: false, fatigue: false, ammunition: false, skirmishers: false, quality: false, elevationLos: false, smoke: false, weatherGround: false };

export interface ScenarioUnit {
  id: string;
  name?: string;
  type: string;
  at: [number, number];
  /** Compass bearing in degrees: 0 north (up the map), 90 east. */
  facing?: number;
  formation?: Formation;
  men?: number;
  quality?: string;
  parent?: string;
  skirmishers?: number;
}

export interface ScenarioGroup {
  id: string;
  name?: string;
  type: string;
  count: number;
  deployAlong: [[number, number], [number, number]];
  facing?: number;
  formation?: Formation;
  men?: number;
  quality?: string;
  parent?: string;
}

/** Standard deployment, ported from the prototype: infantry in rows of five, guns in the gaps, cavalry on the wings. */
export interface DeployBlock {
  centre: [number, number];
  inf: number;
  cav: number;
  art: number;
  roster: string;
  types: { inf: string; cav: string; art: string };
  spacing?: number;
  rowDepth?: number;
  gunForward?: number;
  cavWing?: number;
  cavBack?: number;
  cavTier?: number;
}

export interface CommanderSpec {
  name: string;
  at?: [number, number];
  radius?: number;
  initiative?: number;
  staffDelay?: number;
}
export interface CommandNode {
  id: string;
  name?: string;
  level: 'army' | 'corps' | 'division' | 'brigade';
  commander: CommanderSpec;
  children?: CommandNode[];
}
export interface OrderSpec {
  /** Issue time in seconds, or a trigger. */
  at?: number;
  when?: { unitRouted?: string; enemyWithin?: number; of?: string; formationBroken?: string };
  to: string;
  type: 'attack' | 'defend' | 'hold' | 'support' | 'move' | 'withdraw' | 'reserve';
  objective?: [number, number];
  target?: string;
  formation?: Formation;
  posture?: Posture;
}

export interface ScenarioSide {
  id: string;
  name: string;
  color?: 'blue' | 'red';
  posture: Posture;
  /** Unit vector pointing to this side's rear: routed units flee this way. */
  rear: [number, number];
  deploy?: DeployBlock;
  units?: ScenarioUnit[];
  groups?: ScenarioGroup[];
  command?: CommandNode;
  orders?: OrderSpec[];
}

export interface Hill {
  x: number;
  y: number;
  rx: number;
  ry: number;
  height: number;
}
export interface MapFeature {
  type: string;
  name?: string;
  polygon: [number, number][];
}
export interface ScenarioMap {
  width: number;
  height: number;
  cellSize: number;
  baseElevation?: number;
  hills?: Hill[];
  /** Optional explicit grid, rows of elevations in metres at cellSize spacing. Added to hills. */
  elevation?: number[][];
  features?: MapFeature[];
  labels?: { text: string; at: [number, number]; size?: number }[];
  roads?: [number, number][][];
}
export interface Weather {
  sky: 'clear' | 'rain' | 'heavy_rain' | 'fog';
  ground: 'firm' | 'soft' | 'mud' | 'frozen';
  windFrom: number;
  windSpeed: number;
}

export interface Scenario {
  format: 'napsim-scenario';
  version: 1;
  name: string;
  description?: string;
  map: ScenarioMap;
  weather?: Weather;
  features?: Partial<Features>;
  timeLimit: number;
  /** End the run early if nothing has moved or been hit for this long (seconds). */
  stallLimit?: number;
  sides: ScenarioSide[];
}

export interface ExpandedUnit {
  id: string;
  name: string;
  side: number;
  type: string;
  x: number;
  y: number;
  facing: number; // radians, screen space: 0 = east (+x), HALF_PI = south (+y)
  formation: Formation | null;
  men: number;
  quality: string;
  parent: string | null;
  skirmishers: number | null;
}

export const bearingToRad = (deg: number): number => (deg - 90) * DEG;
export const radToBearing = (rad: number): number => {
  const d = rad / DEG + 90;
  return ((d % 360) + 360) % 360;
};

export function validateScenario(sc: Scenario, data: Data): string[] {
  const e: string[] = [];
  if (sc.format !== 'napsim-scenario') e.push(`format must be 'napsim-scenario'`);
  if (!sc.map || !(sc.map.width > 0) || !(sc.map.height > 0) || !(sc.map.cellSize > 0)) e.push('map needs width, height and cellSize');
  if (!(sc.timeLimit > 0)) e.push('timeLimit must be positive');
  if (!Array.isArray(sc.sides) || sc.sides.length !== 2) e.push('exactly two sides are required');
  for (const f of sc.map?.features ?? []) {
    if (!data.terrain.types[f.type]) e.push(`map feature: unknown terrain type '${f.type}'`);
    if (!Array.isArray(f.polygon) || f.polygon.length < 3) e.push(`map feature '${f.name ?? f.type}': polygon needs three or more points`);
  }
  const ids = new Set<string>();
  (sc.sides ?? []).forEach((s, i) => {
    const tag = `side ${s.id ?? i}`;
    if (!s.id) e.push(`${tag}: missing id`);
    if (!['defend', 'attack_line', 'attack_column'].includes(s.posture)) e.push(`${tag}: bad posture '${s.posture}'`);
    if (!Array.isArray(s.rear) || !(len(s.rear[0], s.rear[1]) > 0)) e.push(`${tag}: rear must be a non-zero vector`);
    const checkType = (t: string, what: string) => {
      if (!data.units[t]) e.push(`${tag}: ${what}: unknown unit type '${t}'`);
    };
    for (const u of s.units ?? []) {
      if (!u.id) e.push(`${tag}: unit without id`);
      if (ids.has(u.id)) e.push(`${tag}: duplicate unit id '${u.id}'`);
      ids.add(u.id);
      checkType(u.type, `unit ${u.id}`);
      if (u.quality && !data.quality.classes[u.quality]) e.push(`${tag}: unit ${u.id}: unknown quality '${u.quality}'`);
      if (!Array.isArray(u.at)) e.push(`${tag}: unit ${u.id}: missing position`);
    }
    for (const g of s.groups ?? []) {
      checkType(g.type, `group ${g.id}`);
      if (!(g.count >= 0)) e.push(`${tag}: group ${g.id}: bad count`);
    }
    if (s.deploy) {
      if (!data.rosters[s.deploy.roster]) e.push(`${tag}: unknown roster '${s.deploy.roster}'`);
      for (const k of ['inf', 'cav', 'art'] as const) checkType(s.deploy.types?.[k], `deploy.types.${k}`);
    }
  });
  return e;
}

/** Turn deploy blocks and groups into an explicit list of units. Pure and deterministic. */
export function expandUnits(sc: Scenario, data: Data): ExpandedUnit[] {
  const out: ExpandedUnit[] = [];
  sc.sides.forEach((s, side) => {
    const rl = len(s.rear[0], s.rear[1]);
    const rx = s.rear[0] / rl;
    const ry = s.rear[1] / rl;
    const lx = -ry; // lateral axis (to the side's right when looking at the enemy... sign is immaterial)
    const ly = rx;
    const faceEnemy = atan2(-ry, -rx);
    const defForm: Formation = s.posture === 'defend' ? 'line' : 'column';
    const push = (id: string, name: string, type: string, x: number, y: number, facing: number, formation: Formation | undefined, men: number | undefined, quality: string | undefined, parent?: string, skirmishers?: number) => {
      const ut = data.units[type];
      out.push({
        id,
        name,
        side,
        type,
        x,
        y,
        facing,
        formation: ut.arm === 'inf' ? formation ?? defForm : null,
        men: Math.round(men ?? ut.men),
        quality: quality ?? 'line',
        parent: parent ?? null,
        skirmishers: skirmishers ?? null,
      });
    };
    const d = s.deploy;
    if (d) {
      const R = data.rosters[d.roster];
      const sp = d.spacing ?? 185;
      const rowDepth = d.rowDepth ?? 130;
      const gunForward = d.gunForward ?? 40;
      const cavWing = d.cavWing ?? 520;
      const cavBack = d.cavBack ?? 50;
      const cavTier = d.cavTier ?? 60;
      const [cx, cy] = d.centre;
      for (let i = 0; i < d.inf; i++) {
        const row = Math.floor(i / 5);
        const n = Math.min(5, d.inf - row * 5);
        const k = i - row * 5;
        const lat = (k - (n - 1) / 2) * sp;
        const nm = R.inf[i % R.inf.length];
        const suffix = i >= R.inf.length ? ` (${Math.floor(i / R.inf.length) + 1})` : '';
        push(`${s.id}-inf-${i + 1}`, nm[0] + suffix, d.types.inf, cx + lx * lat + rx * row * rowDepth, cy + ly * lat + ry * row * rowDepth, faceEnemy, undefined, undefined, nm[1]);
      }
      // guns: first in the gaps between front-row battalions (those nearest 200 m from the centre first), then outside the flanks
      const n1 = Math.min(5, d.inf);
      const slots: number[] = [];
      for (let j = 0; j < n1 - 1; j++) slots.push((j - (n1 - 2) / 2) * sp);
      const pref = sp * 1.06;
      slots.sort((a, b) => Math.abs(Math.abs(a) - pref) - Math.abs(Math.abs(b) - pref) || a - b);
      const edge = n1 ? ((n1 - 1) / 2) * sp + sp * 0.79 : sp * 0.53;
      for (let k = 0; slots.length < d.art; k++) slots.push((k % 2 ? 1 : -1) * Math.min(cavWing - 100, edge + Math.floor(k / 2) * sp * 0.53));
      for (let i = 0; i < d.art; i++) {
        const nm = R.art[i % R.art.length];
        const suffix = i >= R.art.length ? ` (${Math.floor(i / R.art.length) + 1})` : '';
        push(`${s.id}-art-${i + 1}`, nm[0] + suffix, d.types.art, cx + lx * slots[i] - rx * gunForward, cy + ly * slots[i] - ry * gunForward, faceEnemy, undefined, undefined, nm[1]);
      }
      // cavalry: the prototype's 300-sabre unit j is two squadrons, one behind the other, alternating wings
      for (let i = 0; i < d.cav; i++) {
        const j = Math.floor(i / 2);
        const sq = i % 2;
        const wing = j % 2 === 0 ? -1 : 1;
        const tier = Math.floor(j / 2) * 2 + sq;
        const nm = R.cav[j % R.cav.length];
        const back = cavBack + tier * cavTier;
        push(`${s.id}-cav-${i + 1}`, `${nm[0]}, ${sq ? '2nd' : '1st'} sqn`, d.types.cav, cx + lx * wing * cavWing + rx * back, cy + ly * wing * cavWing + ry * back, faceEnemy, undefined, undefined, nm[1]);
      }
    }
    for (const g of s.groups ?? []) {
      const [[x1, y1], [x2, y2]] = g.deployAlong;
      for (let i = 0; i < g.count; i++) {
        const f = g.count === 1 ? 0.5 : i / (g.count - 1);
        push(`${g.id}-${i + 1}`, `${g.name ?? g.id} ${i + 1}`, g.type, x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, g.facing === undefined ? faceEnemy : bearingToRad(g.facing), g.formation, g.men, g.quality, g.parent);
      }
    }
    for (const u of s.units ?? []) {
      push(u.id, u.name ?? u.id, u.type, u.at[0], u.at[1], u.facing === undefined ? faceEnemy : bearingToRad(u.facing), u.formation, u.men, u.quality, u.parent, u.skirmishers);
    }
  });
  return out;
}

// ---------------------------------------------------------------- map

export interface BuiltFeature {
  type: string;
  name: string;
  tt: TerrainType;
  poly: Float64Array; // x0,y0,x1,y1,...
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface GameMap {
  width: number;
  height: number;
  cell: number;
  cols: number; // number of grid nodes across
  rows: number;
  elev: Float64Array; // rows x cols node elevations, metres
  features: BuiltFeature[];
}

export function buildMap(m: ScenarioMap, data: Data): GameMap {
  const cols = Math.floor(m.width / m.cellSize) + 1;
  const rows = Math.floor(m.height / m.cellSize) + 1;
  const elev = new Float64Array(cols * rows);
  const base = m.baseElevation ?? 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * m.cellSize;
      const y = r * m.cellSize;
      let h = base;
      for (const hill of m.hills ?? []) {
        const a = (x - hill.x) / hill.rx;
        const b = (y - hill.y) / hill.ry;
        const q = a * a + b * b;
        if (q < 1) h += hill.height * (1 - q) * (1 - q);
      }
      if (m.elevation && m.elevation[r] && typeof m.elevation[r][c] === 'number') h += m.elevation[r][c];
      elev[r * cols + c] = h;
    }
  }
  const features: BuiltFeature[] = (m.features ?? []).map((f) => {
    const poly = new Float64Array(f.polygon.length * 2);
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    f.polygon.forEach((p, i) => {
      poly[i * 2] = p[0];
      poly[i * 2 + 1] = p[1];
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    });
    return { type: f.type, name: f.name ?? f.type, tt: data.terrain.types[f.type], poly, minX, minY, maxX, maxY };
  });
  return { width: m.width, height: m.height, cell: m.cellSize, cols, rows, elev, features };
}

/** Bilinear elevation in metres. */
export function elevAt(m: GameMap, x: number, y: number): number {
  let gx = x / m.cell;
  let gy = y / m.cell;
  if (gx < 0) gx = 0;
  else if (gx > m.cols - 1) gx = m.cols - 1;
  if (gy < 0) gy = 0;
  else if (gy > m.rows - 1) gy = m.rows - 1;
  let c = Math.floor(gx);
  let r = Math.floor(gy);
  if (c >= m.cols - 1) c = m.cols - 2;
  if (r >= m.rows - 1) r = m.rows - 2;
  if (c < 0) c = 0;
  if (r < 0) r = 0;
  const fx = gx - c;
  const fy = gy - r;
  const i = r * m.cols + c;
  const e00 = m.elev[i];
  const e10 = m.elev[i + 1] ?? e00;
  const e01 = m.elev[i + m.cols] ?? e00;
  const e11 = m.elev[i + m.cols + 1] ?? e00;
  return e00 * (1 - fx) * (1 - fy) + e10 * fx * (1 - fy) + e01 * (1 - fx) * fy + e11 * fx * fy;
}

/** Gradient (rise over run) components at a point. */
export function gradAt(m: GameMap, x: number, y: number): [number, number] {
  const h = m.cell * 0.5;
  return [(elevAt(m, x + h, y) - elevAt(m, x - h, y)) / (2 * h), (elevAt(m, x, y + h) - elevAt(m, x, y - h)) / (2 * h)];
}

export function pointInPoly(poly: Float64Array, x: number, y: number): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2],
      yi = poly[i * 2 + 1],
      xj = poly[j * 2],
      yj = poly[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function featureAt(m: GameMap, x: number, y: number): BuiltFeature | null {
  for (const f of m.features) {
    if (x < f.minX || x > f.maxX || y < f.minY || y > f.maxY) continue;
    if (pointInPoly(f.poly, x, y)) return f;
  }
  return null;
}
