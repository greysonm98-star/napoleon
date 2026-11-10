// Scenario editor: the working copy, undo, validation, map tools and the overlay drawn over the map.
// The form panel beside the map lives in editor-panel.ts.
import { createSim, expandUnits, radToBearing, recordRun, setDims, validateScenario } from '@napoleon/engine';
import type { CommandNode, Data, ExpandedUnit, Formation, MapFeature, Replay, Scenario, ScenarioSide, ScenarioUnit, Unit } from '@napoleon/engine';
import type { Frame, FrameCommander, FrameUnit } from './model.ts';
import { pickDist } from './render.ts';
import type { Camera } from './render.ts';
import { C } from './util.ts';

const TAU = Math.PI * 2;

export type Sel =
  | { kind: 'unit'; id: string }
  | { kind: 'commander'; id: string }
  | { kind: 'feature'; i: number }
  | { kind: 'hill'; i: number }
  | { kind: 'road'; i: number }
  | { kind: 'label'; i: number }
  | { kind: 'objective' }
  | null;

export type Tool = 'select' | 'unit' | 'elev' | 'poly' | 'hill' | 'road' | 'label' | 'objective';

export interface EditorHost {
  data: Data;
  scenarios: { key: string; sc: Scenario }[];
  cam: Camera;
  /** Show this scenario's map in the shared view. keepCam leaves pan and zoom alone. */
  showScenario(sc: Scenario, keepCam: boolean): void;
  loadReplay(r: Replay, label: string): void;
  replayScenario(): Scenario | null;
}

interface Drag {
  kind: 'move' | 'rotate' | 'vertex' | 'hillrx' | 'hillry' | 'paint' | 'newhill';
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  moved: boolean;
  vertex?: number;
}

const STORE = 'napsim-editor-scenario';

export function blankScenario(width: number, height: number, cell: number): Scenario {
  return {
    format: 'napsim-scenario',
    version: 1,
    name: 'New scenario',
    description: '',
    map: { width, height, cellSize: cell, hills: [], features: [], labels: [], roads: [] },
    weather: { sky: 'clear', ground: 'firm', windFrom: 270, windSpeed: 3 },
    features: { commandControl: false, fatigue: false, ammunition: false, skirmishers: false, quality: false, elevationLos: false, smoke: false, weatherGround: false },
    timeLimit: 7200,
    sides: [
      { id: 'blue', name: 'Blue', color: 'blue', posture: 'attack_line', rear: [0, 1], units: [] },
      { id: 'red', name: 'Red', color: 'red', posture: 'defend', rear: [0, -1], units: [] },
    ],
  };
}

function distSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let k = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  k = Math.max(0, Math.min(1, k));
  return Math.hypot(px - ax - dx * k, py - ay - dy * k);
}
function inPoly(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const r0 = (v: number): number => Math.round(v);

export class Editor {
  sc: Scenario;
  sel: Sel = null;
  tool: Tool = 'select';
  opts = { side: 0, type: '', formation: 'line' as Formation, quality: 'line', terrain: 'wood', featureName: '', hillHeight: 20, brushR: 150, brushS: 2, lower: false, label: 'Place name', objRadius: 300 };
  problems: string[] = [];
  warnings: string[] = [];
  status = '';
  pick: { hint: string; cb: (x: number, y: number) => void } | null = null;
  active = false;
  /** Set by the panel: called (deferred) whenever the forms should be rebuilt. */
  onRender: () => void = () => {};

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private version = 0;
  private frameVersion = -1;
  private frameCache: Frame | null = null;
  private ex: ExpandedUnit[] = [];
  private explicit = new Set<string>();
  private draft: [number, number][] = [];
  private hover: { x: number; y: number } | null = null;
  private drag: Drag | null = null;
  private stamps: [number, number][] = [];
  private lastClick = { t: 0, x: 0, y: 0 };
  private validateTimer = 0;
  private renderTimer = 0;

  constructor(readonly host: EditorHost) {
    let sc: Scenario | null = null;
    try {
      const saved = localStorage.getItem(STORE);
      if (saved) {
        const o = JSON.parse(saved) as Scenario;
        if (o && o.format === 'napsim-scenario' && o.map && Array.isArray(o.sides)) sc = o;
      }
    } catch {
      /* storage unavailable: start from a bundled scenario */
    }
    this.sc = sc ?? structuredClone((host.scenarios.find((s) => s.key === 'pitched') ?? host.scenarios[0])?.sc ?? blankScenario(1200, 1600, 25));
    const types = Object.keys(host.data.units);
    this.opts.type = types.find((t) => host.data.units[t].arm === 'inf') ?? types[0] ?? '';
    this.validateNow();
  }

  // ------------------------------------------------------------------ working copy

  get data(): Data {
    return this.host.data;
  }

  activate(): void {
    this.active = true;
    this.host.showScenario(this.sc, false);
    this.requestRender();
  }
  deactivate(): void {
    this.active = false;
    this.draft = [];
    this.pick = null;
    this.drag = null;
  }

  load(sc: Scenario, note: string): void {
    this.pushUndo();
    this.sc = structuredClone(sc);
    this.sel = null;
    this.draft = [];
    this.status = note;
    this.after(true, false);
  }

  private pushUndo(): void {
    this.undoStack.push(JSON.stringify(this.sc));
    if (this.undoStack.length > 80) this.undoStack.shift();
    this.redoStack.length = 0;
  }
  canUndo = (): boolean => this.undoStack.length > 0;
  canRedo = (): boolean => this.redoStack.length > 0;
  undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.sc));
    this.sc = JSON.parse(s);
    this.fixSelection();
    this.after(true, true);
  }
  redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.sc));
    this.sc = JSON.parse(s);
    this.fixSelection();
    this.after(true, true);
  }
  private fixSelection(): void {
    const s = this.sel;
    if (!s) return;
    const m = this.sc.map;
    if ((s.kind === 'feature' && !(m.features ?? [])[s.i]) || (s.kind === 'hill' && !(m.hills ?? [])[s.i]) || (s.kind === 'road' && !(m.roads ?? [])[s.i]) || (s.kind === 'label' && !(m.labels ?? [])[s.i]) || (s.kind === 'objective' && !this.sc.objective)) this.sel = null;
  }

  /** Change the scenario. `map` says the ground must be repainted. */
  mutate(fn: () => void, map = false): void {
    this.pushUndo();
    fn();
    this.after(map, true);
  }

  private after(map: boolean, keepCam: boolean): void {
    this.version++;
    if (map && this.active) this.host.showScenario(this.sc, keepCam);
    clearTimeout(this.validateTimer);
    this.validateTimer = window.setTimeout(() => {
      this.validateNow();
      this.requestRender();
    }, 220);
    try {
      localStorage.setItem(STORE, JSON.stringify(this.sc));
    } catch {
      /* not essential */
    }
    this.requestRender();
  }

  requestRender(): void {
    clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => this.onRender(), 0);
  }

  validateNow(): void {
    const problems: string[] = [];
    const warnings: string[] = [];
    try {
      problems.push(...validateScenario(this.sc, this.data));
      if (!problems.length) {
        try {
          createSim(structuredClone(this.sc), this.data, 1);
        } catch (e) {
          problems.push(...String(e instanceof Error ? e.message : e).replace(/^Scenario errors:\s*/, '').split('\n').map((l) => l.trim()).filter(Boolean));
        }
        // command structure and orders are only read when command and control is on: check them anyway
        if (!problems.length && !this.sc.features?.commandControl && this.sc.sides.some((s) => s.command || s.orders?.length)) {
          try {
            const c = structuredClone(this.sc);
            c.features = { ...c.features, commandControl: true };
            createSim(c, this.data, 1);
          } catch (e) {
            warnings.push(`With command and control on: ${e instanceof Error ? e.message : e}`);
          }
        }
        if (this.sc.sides.some((s) => s.command || s.orders?.length) && !this.sc.features?.commandControl) warnings.push('This scenario has a command structure or orders, but command and control is switched off, so they are ignored.');
        const m = this.sc.map;
        for (const u of this.expanded()) if (u.x < 0 || u.y < 0 || u.x > m.width || u.y > m.height) warnings.push(`${u.name} is off the map.`);
      }
    } catch (e) {
      problems.push(String(e instanceof Error ? e.message : e));
    }
    this.problems = problems;
    this.warnings = warnings;
  }

  testRun(seed: number): void {
    try {
      const t0 = performance.now();
      const rep = recordRun(structuredClone(this.sc), this.data, seed);
      this.status = `Test run finished in ${Math.round(performance.now() - t0)} ms.`;
      this.host.loadReplay(rep, 'Test run from the editor');
    } catch (e) {
      this.status = `Could not run: ${e instanceof Error ? e.message : e}`;
      this.requestRender();
    }
  }

  // ------------------------------------------------------------------ lookups

  expanded(): ExpandedUnit[] {
    this.frame();
    return this.ex;
  }
  isExplicit = (id: string): boolean => this.explicit.has(id);
  hasGenerated = (): boolean => this.sc.sides.some((s) => !!s.deploy || !!s.groups?.length);

  findUnit(id: string): { side: number; unit: ScenarioUnit } | null {
    for (let i = 0; i < this.sc.sides.length; i++) {
      const u = this.sc.sides[i].units?.find((x) => x.id === id);
      if (u) return { side: i, unit: u };
    }
    return null;
  }

  /** Every formation of a side, depth-first, with its depth and parent. */
  nodes(side: number): { node: CommandNode; depth: number; parent: CommandNode | null }[] {
    const out: { node: CommandNode; depth: number; parent: CommandNode | null }[] = [];
    const walk = (n: CommandNode, depth: number, parent: CommandNode | null) => {
      out.push({ node: n, depth, parent });
      for (const c of n.children ?? []) walk(c, depth + 1, n);
    };
    const root = this.sc.sides[side]?.command;
    if (root) walk(root, 0, null);
    return out;
  }
  findNode(id: string): { side: number; node: CommandNode; parent: CommandNode | null } | null {
    for (let i = 0; i < this.sc.sides.length; i++) for (const n of this.nodes(i)) if (n.node.id === id) return { side: i, node: n.node, parent: n.parent };
    return null;
  }
  /** The formation a unit belongs to: its own `parent`, or a formation that lists it. */
  parentOf(unitId: string, side: number): string {
    const u = this.ex.find((x) => x.id === unitId);
    if (u?.parent) return u.parent;
    for (const n of this.nodes(side)) if (n.node.units?.includes(unitId)) return n.node.id;
    return '';
  }

  uniqueUnitId(side: ScenarioSide, arm: string): string {
    const taken = new Set(this.expanded().map((u) => u.id));
    for (let i = 1; ; i++) {
      const id = `${side.id}-${arm}-${i}`;
      if (!taken.has(id)) return id;
    }
  }
  uniqueNodeId(side: ScenarioSide, level: string): string {
    const taken = new Set(this.sc.sides.flatMap((_, i) => this.nodes(i).map((n) => n.node.id)));
    const stem = `${side.id}-${level === 'brigade' ? 'bde' : level === 'division' ? 'div' : level === 'corps' ? 'corps' : 'hq'}`;
    if (!taken.has(stem) && level !== 'brigade' && level !== 'division') return stem;
    for (let i = 1; ; i++) if (!taken.has(`${stem}-${i}`)) return `${stem}-${i}`;
  }
  /** Bearing that faces the enemy for a side, from its rear vector. */
  defaultFacing(side: number): number {
    const r = this.sc.sides[side].rear;
    return Math.round(radToBearing(Math.atan2(-r[1], -r[0])));
  }

  // ------------------------------------------------------------------ structural edits used by the panel

  /** Replace deploy blocks and groups by the units they generate, so each can be edited. */
  convertToExplicit(): void {
    this.mutate(() => {
      const ex = expandUnits(this.sc, this.data);
      this.sc.sides.forEach((s, i) => {
        const listed = new Map<string, string>();
        const walk = (n: CommandNode) => {
          for (const id of n.units ?? []) listed.set(id, n.id);
          delete n.units;
          for (const c of n.children ?? []) walk(c);
        };
        if (s.command) walk(s.command);
        s.units = ex
          .filter((u) => u.side === i)
          .map((u) => {
            const o: ScenarioUnit = { id: u.id, name: u.name, type: u.type, at: [r0(u.x), r0(u.y)], facing: Math.round(radToBearing(u.facing)), men: u.men, quality: u.quality };
            if (u.formation) o.formation = u.formation;
            const parent = u.parent ?? listed.get(u.id);
            if (parent) o.parent = parent;
            if (u.skirmishers !== null) o.skirmishers = u.skirmishers;
            return o;
          });
        delete s.deploy;
        delete s.groups;
      });
    });
  }

  renameNode(oldId: string, newId: string): void {
    if (!newId || newId === oldId || this.findNode(newId)) return;
    const hit = this.findNode(oldId);
    if (!hit) return;
    hit.node.id = newId;
    for (const s of this.sc.sides) {
      for (const u of s.units ?? []) if (u.parent === oldId) u.parent = newId;
      for (const g of s.groups ?? []) if (g.parent === oldId) g.parent = newId;
      for (const o of s.orders ?? []) {
        if (o.to === oldId) o.to = newId;
        if (o.target === oldId) o.target = newId;
        if (o.when?.formationBroken === oldId) o.when.formationBroken = newId;
        if (o.when?.of === oldId) o.when.of = newId;
      }
    }
    if (this.sel?.kind === 'commander' && this.sel.id === oldId) this.sel = { kind: 'commander', id: newId };
  }

  removeNode(id: string): void {
    const hit = this.findNode(id);
    if (!hit) return;
    const gone = new Set<string>();
    const walk = (n: CommandNode) => {
      gone.add(n.id);
      for (const c of n.children ?? []) walk(c);
    };
    walk(hit.node);
    const s = this.sc.sides[hit.side];
    if (hit.parent) hit.parent.children = (hit.parent.children ?? []).filter((c) => c !== hit.node);
    else delete s.command;
    for (const u of s.units ?? []) if (u.parent && gone.has(u.parent)) delete u.parent;
    s.orders = (s.orders ?? []).filter((o) => !gone.has(o.to));
    if (this.sel?.kind === 'commander' && gone.has(this.sel.id)) this.sel = null;
  }

  renameUnit(oldId: string, newId: string): boolean {
    if (!newId || newId === oldId || this.expanded().some((u) => u.id === newId)) return false;
    const hit = this.findUnit(oldId);
    if (!hit) return false;
    hit.unit.id = newId;
    for (let i = 0; i < this.sc.sides.length; i++) {
      for (const n of this.nodes(i)) if (n.node.units) n.node.units = n.node.units.map((x) => (x === oldId ? newId : x));
      for (const o of this.sc.sides[i].orders ?? []) if (o.when?.unitRouted === oldId) o.when.unitRouted = newId;
    }
    this.sel = { kind: 'unit', id: newId };
    return true;
  }

  setUnitParent(unit: ScenarioUnit, side: number, parent: string): void {
    for (const n of this.nodes(side)) if (n.node.units) n.node.units = n.node.units.filter((x) => x !== unit.id);
    if (parent) unit.parent = parent;
    else delete unit.parent;
  }

  deleteSelection(): void {
    const s = this.sel;
    if (!s) return;
    const m = this.sc.map;
    if (s.kind === 'unit') {
      const hit = this.findUnit(s.id);
      if (!hit) return;
      this.mutate(() => {
        const side = this.sc.sides[hit.side];
        side.units = (side.units ?? []).filter((u) => u.id !== s.id);
        for (const n of this.nodes(hit.side)) if (n.node.units) n.node.units = n.node.units.filter((x) => x !== s.id);
        this.sel = null;
      });
    } else if (s.kind === 'commander') {
      this.mutate(() => this.removeNode(s.id));
    } else if (s.kind === 'feature') {
      this.mutate(() => {
        m.features!.splice(s.i, 1);
        this.sel = null;
      }, true);
    } else if (s.kind === 'hill') {
      this.mutate(() => {
        m.hills!.splice(s.i, 1);
        this.sel = null;
      }, true);
    } else if (s.kind === 'road') {
      this.mutate(() => {
        m.roads!.splice(s.i, 1);
        this.sel = null;
      }, true);
    } else if (s.kind === 'label') {
      this.mutate(() => {
        m.labels!.splice(s.i, 1);
        this.sel = null;
      }, true);
    } else if (s.kind === 'objective') {
      this.mutate(() => {
        delete this.sc.objective;
        this.sel = null;
      });
    }
  }

  /** Change the map's size or grid, keeping what is on it. */
  resizeMap(width: number, height: number, cell: number): void {
    const m = this.sc.map;
    if (!(width >= 200 && height >= 200 && cell >= 5) || (width === m.width && height === m.height && cell === m.cellSize)) return;
    this.mutate(() => {
      const old = m.elevation;
      const oc = m.cellSize;
      m.width = Math.round(width);
      m.height = Math.round(height);
      m.cellSize = cell;
      if (old && old.length) {
        const rows = Math.floor(m.height / cell) + 1;
        const cols = Math.floor(m.width / cell) + 1;
        const at = (r: number, c: number) => old[Math.min(old.length - 1, Math.max(0, r))]?.[Math.min((old[0]?.length ?? 1) - 1, Math.max(0, c))] ?? 0;
        const grid: number[][] = [];
        for (let r = 0; r < rows; r++) {
          const row: number[] = [];
          for (let c = 0; c < cols; c++) {
            const gx = (c * cell) / oc;
            const gy = (r * cell) / oc;
            if (gx > (old[0]?.length ?? 1) - 1 || gy > old.length - 1) {
              row.push(0);
              continue;
            }
            const c0 = Math.floor(gx);
            const r0i = Math.floor(gy);
            const fx = gx - c0;
            const fy = gy - r0i;
            row.push(Math.round((at(r0i, c0) * (1 - fx) * (1 - fy) + at(r0i, c0 + 1) * fx * (1 - fy) + at(r0i + 1, c0) * (1 - fx) * fy + at(r0i + 1, c0 + 1) * fx * fy) * 10) / 10);
          }
          grid.push(row);
        }
        m.elevation = grid;
      }
    }, true);
  }

  // ------------------------------------------------------------------ what the renderer draws

  selectedUnit(): string | null {
    return this.sel?.kind === 'unit' ? this.sel.id : null;
  }

  frame(): Frame {
    if (this.frameCache && this.frameVersion === this.version) return this.frameCache;
    const data = this.data;
    let ex: ExpandedUnit[] = [];
    try {
      ex = expandUnits(this.sc, data);
    } catch {
      ex = [];
    }
    this.ex = ex;
    this.explicit = new Set(this.sc.sides.flatMap((s) => (s.units ?? []).map((u) => u.id)));
    const units: FrameUnit[] = [];
    const byId = new Map<string, FrameUnit>();
    for (const e of ex) {
      const ut = data.units[e.type];
      if (!ut) continue;
      const fake = { arm: ut.arm, ut, doc: ut.doctrine ? data.doctrine[ut.doctrine] : null, men: e.men, form: e.formation, status: 'ok', w: 60, d: 10 };
      try {
        setDims(fake as unknown as Unit);
      } catch {
        fake.w = 60;
        fake.d = 10;
      }
      const u: FrameUnit = { id: e.id, name: e.name, side: e.side, arm: ut.arm, x: e.x, y: e.y, f: e.facing, w: fake.w, d: fake.d, men: e.men, startMen: e.men, morale: 100, form: e.formation, status: 'ok', forming: false, melee: false, blown: false, moving: false, manual: false };
      units.push(u);
      byId.set(u.id, u);
    }
    this.frameCache = { t: 0, units, byId, commanders: this.commanders(ex), couriers: [], smoke: null };
    this.frameVersion = this.version;
    return this.frameCache;
  }

  /** Commanders at their given positions, or where the engine would first station them. */
  private commanders(ex: ExpandedUnit[]): FrameCommander[] {
    const out: FrameCommander[] = [];
    const cmd = (this.data.command ?? {}) as Record<string, number>;
    const m = this.sc.map;
    this.sc.sides.forEach((s, si) => {
      if (!s.command) return;
      const owner = new Map<string, string>();
      for (const u of ex) if (u.side === si && u.parent) owner.set(u.id, u.parent);
      for (const n of this.nodes(si)) for (const id of n.node.units ?? []) owner.set(id, n.node.id);
      const rl = Math.hypot(s.rear[0], s.rear[1]) || 1;
      const rx = s.rear[0] / rl;
      const ry = s.rear[1] / rl;
      const mine = ex.filter((u) => u.side === si);
      const cen = (pts: { x: number; y: number }[]): [number, number] | null => (pts.length ? [pts.reduce((a, p) => a + p.x, 0) / pts.length, pts.reduce((a, p) => a + p.y, 0) / pts.length] : null);
      const clampIn = (p: [number, number]): [number, number] => [Math.max(5, Math.min(m.width - 5, p[0])), Math.max(5, Math.min(m.height - 5, p[1]))];
      const place = (n: CommandNode, parent: string | null): { x: number; y: number } => {
        const kids = (n.children ?? []).map((c) => place(c, n.id));
        let pos: [number, number];
        if (n.commander?.at) pos = [n.commander.at[0], n.commander.at[1]];
        else {
          const k = cen(kids);
          const own = cen(mine.filter((u) => owner.get(u.id) === n.id));
          const all = cen(mine);
          pos = k ? [k[0] + rx * 200, k[1] + ry * 200] : own ? [own[0] + rx * 80, own[1] + ry * 80] : all ? [all[0] + rx * 300, all[1] + ry * 300] : [m.width / 2, m.height / 2];
          pos = clampIn(pos);
        }
        const lv = n.level === 'army' ? 'Army' : n.level === 'corps' ? 'Corps' : n.level === 'division' ? 'Division' : 'Brigade';
        out.push({ id: n.id, name: n.commander?.name ?? n.name ?? n.id, side: si, level: n.level, radius: n.commander?.radius ?? cmd['radius' + lv] ?? 400, parent, x: pos[0], y: pos[1], alive: true });
        return { x: pos[0], y: pos[1] };
      };
      place(s.command, null);
    });
    return out;
  }

  // ------------------------------------------------------------------ elevation brush

  private grid(): number[][] {
    const m = this.sc.map;
    const rows = Math.floor(m.height / m.cellSize) + 1;
    const cols = Math.floor(m.width / m.cellSize) + 1;
    const old = m.elevation ?? [];
    if (old.length !== rows || (old[0]?.length ?? 0) !== cols) {
      const g: number[][] = [];
      for (let r = 0; r < rows; r++) {
        const row = new Array<number>(cols).fill(0);
        for (let c = 0; c < cols; c++) if (typeof old[r]?.[c] === 'number') row[c] = old[r][c];
        g.push(row);
      }
      m.elevation = g;
    }
    return m.elevation!;
  }

  private stamp(x: number, y: number, lower: boolean): void {
    const m = this.sc.map;
    const g = this.grid();
    const R = this.opts.brushR;
    const S = this.opts.brushS * (lower ? -1 : 1);
    const c0 = Math.max(0, Math.floor((x - R) / m.cellSize));
    const c1 = Math.min(g[0].length - 1, Math.ceil((x + R) / m.cellSize));
    const rA = Math.max(0, Math.floor((y - R) / m.cellSize));
    const rB = Math.min(g.length - 1, Math.ceil((y + R) / m.cellSize));
    for (let r = rA; r <= rB; r++) {
      for (let c = c0; c <= c1; c++) {
        const q = ((c * m.cellSize - x) ** 2 + (r * m.cellSize - y) ** 2) / (R * R);
        if (q >= 1) continue;
        g[r][c] = Math.round((g[r][c] + S * (1 - q) * (1 - q)) * 10) / 10;
      }
    }
    this.stamps.push([x, y]);
  }

  // ------------------------------------------------------------------ pointer

  private px(): number {
    return 1 / this.host.cam.scale;
  }

  private rotateHandle(u: FrameUnit): [number, number] {
    const r = Math.max(u.d / 2, 2) + 26 * this.px();
    return [u.x + Math.cos(u.f) * r, u.y + Math.sin(u.f) * r];
  }

  private hitObject(x: number, y: number): Sel {
    const px = this.px();
    const f = this.frame();
    let best: FrameUnit | null = null;
    let bd = 9 * px;
    for (const u of f.units) {
      const d = pickDist(u, x, y, this.host.cam.scale);
      if (d < bd) (bd = d), (best = u);
    }
    if (best) return { kind: 'unit', id: best.id };
    for (const c of f.commanders) if (Math.hypot(c.x - x, c.y - y) < 10 * px) return { kind: 'commander', id: c.id };
    const ob = this.sc.objective;
    if (ob && Math.hypot(ob.at[0] - x, ob.at[1] - y) < 12 * px) return { kind: 'objective' };
    const m = this.sc.map;
    const labels = m.labels ?? [];
    for (let i = 0; i < labels.length; i++) if (Math.abs(labels[i].at[0] - x) < Math.max(40, labels[i].text.length * 6) && Math.abs(labels[i].at[1] - 8 - y) < 16) return { kind: 'label', i };
    const hills = m.hills ?? [];
    for (let i = 0; i < hills.length; i++) if (Math.hypot(hills[i].x - x, hills[i].y - y) < 11 * px) return { kind: 'hill', i };
    const feats = m.features ?? [];
    for (let i = feats.length - 1; i >= 0; i--) if (inPoly(feats[i].polygon, x, y)) return { kind: 'feature', i };
    const roads = m.roads ?? [];
    for (let i = 0; i < roads.length; i++) for (let k = 1; k < roads[i].length; k++) if (distSeg(x, y, roads[i][k - 1][0], roads[i][k - 1][1], roads[i][k][0], roads[i][k][1]) < 7 * px) return { kind: 'road', i };
    return null;
  }

  private vertices(): [number, number][] | null {
    const s = this.sel;
    if (s?.kind === 'feature') return this.sc.map.features?.[s.i]?.polygon ?? null;
    if (s?.kind === 'road') return this.sc.map.roads?.[s.i] ?? null;
    return null;
  }

  /** Returns true if the editor takes this drag; false lets the map pan. */
  pointerDown(x: number, y: number, e: PointerEvent): boolean {
    if (e.button !== 0 || this.pick) return false;
    const px = this.px();
    const start = (kind: Drag['kind'], vertex?: number): boolean => {
      this.drag = { kind, sx: x, sy: y, lx: x, ly: y, moved: false, vertex };
      return true;
    };
    if (this.tool === 'elev') {
      this.pushUndo();
      this.stamps = [];
      this.stamp(x, y, this.opts.lower !== e.shiftKey);
      return start('paint');
    }
    if (this.tool === 'hill') return start('newhill');
    if (this.tool !== 'select') return false;
    // handles of the current selection come first
    const s = this.sel;
    if (s?.kind === 'unit' && this.isExplicit(s.id)) {
      const u = this.frame().byId.get(s.id);
      if (u) {
        const [hx, hy] = this.rotateHandle(u);
        if (Math.hypot(hx - x, hy - y) < 9 * px) return start('rotate');
      }
    }
    const vs = this.vertices();
    if (vs) for (let i = 0; i < vs.length; i++) if (Math.hypot(vs[i][0] - x, vs[i][1] - y) < 8 * px) return start('vertex', i);
    if (s?.kind === 'hill') {
      const h = this.sc.map.hills![s.i];
      if (Math.hypot(h.x + h.rx - x, h.y - y) < 9 * px) return start('hillrx');
      if (Math.hypot(h.x - x, h.y + h.ry - y) < 9 * px) return start('hillry');
    }
    const hit = this.hitObject(x, y);
    if (!hit) return false;
    const changed = JSON.stringify(hit) !== JSON.stringify(this.sel);
    this.sel = hit;
    if (changed) this.requestRender();
    if (hit.kind === 'unit' && !this.isExplicit(hit.id)) return false; // generated by a deploy block: select only
    return start('move');
  }

  pointerMove(x: number, y: number, e: PointerEvent): void {
    this.hover = { x, y };
    const d = this.drag;
    if (!d) return;
    const px = this.px();
    if (d.kind === 'paint') {
      if (Math.hypot(x - d.lx, y - d.ly) >= this.opts.brushR / 3) {
        this.stamp(x, y, this.opts.lower !== e.shiftKey);
        d.lx = x;
        d.ly = y;
        d.moved = true;
      }
      return;
    }
    if (d.kind === 'newhill') {
      d.lx = x;
      d.ly = y;
      d.moved = Math.hypot(x - d.sx, y - d.sy) > 6 * px;
      return;
    }
    if (!d.moved) {
      if (Math.hypot(x - d.sx, y - d.sy) < 4 * px) return;
      d.moved = true;
      this.pushUndo();
    }
    const dx = x - d.lx;
    const dy = y - d.ly;
    d.lx = x;
    d.ly = y;
    const s = this.sel;
    const m = this.sc.map;
    if (d.kind === 'rotate' && s?.kind === 'unit') {
      const hit = this.findUnit(s.id);
      if (hit) {
        let b = radToBearing(Math.atan2(y - hit.unit.at[1], x - hit.unit.at[0]));
        b = e.shiftKey ? Math.round(b) : Math.round(b / 5) * 5;
        hit.unit.facing = b % 360;
      }
    } else if (d.kind === 'vertex') {
      const vs = this.vertices();
      if (vs && d.vertex !== undefined) vs[d.vertex] = [r0(x), r0(y)];
    } else if (d.kind === 'hillrx' && s?.kind === 'hill') {
      m.hills![s.i].rx = Math.max(30, r0(Math.abs(x - m.hills![s.i].x)));
    } else if (d.kind === 'hillry' && s?.kind === 'hill') {
      m.hills![s.i].ry = Math.max(30, r0(Math.abs(y - m.hills![s.i].y)));
    } else if (d.kind === 'move' && s) {
      if (s.kind === 'unit') {
        const hit = this.findUnit(s.id);
        if (hit) hit.unit.at = [hit.unit.at[0] + dx, hit.unit.at[1] + dy];
      } else if (s.kind === 'commander') {
        const hit = this.findNode(s.id);
        const c = this.frame().commanders.find((k) => k.id === s.id);
        if (hit && c) {
          hit.node.commander ??= { name: hit.node.id };
          const at = hit.node.commander.at ?? [c.x, c.y];
          hit.node.commander.at = [at[0] + dx, at[1] + dy];
        }
      } else if (s.kind === 'objective' && this.sc.objective) {
        this.sc.objective.at = [this.sc.objective.at[0] + dx, this.sc.objective.at[1] + dy];
      } else if (s.kind === 'label') {
        const l = m.labels![s.i];
        l.at = [l.at[0] + dx, l.at[1] + dy];
      } else if (s.kind === 'hill') {
        m.hills![s.i].x += dx;
        m.hills![s.i].y += dy;
      } else if (s.kind === 'feature') {
        m.features![s.i].polygon = m.features![s.i].polygon.map(([a, b]) => [a + dx, b + dy] as [number, number]);
      } else if (s.kind === 'road') {
        m.roads![s.i] = m.roads![s.i].map(([a, b]) => [a + dx, b + dy] as [number, number]);
      }
    }
    this.version++; // redraw units from the working copy; the ground waits for the release
  }

  pointerUp(x: number, y: number): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    const m = this.sc.map;
    if (d.kind === 'paint') {
      this.stamps = [];
      this.after(true, true);
      return;
    }
    if (d.kind === 'newhill') {
      if (!d.moved) return;
      this.mutate(() => {
        (m.hills ??= []).push({ x: r0(d.sx), y: r0(d.sy), rx: Math.max(40, r0(Math.abs(x - d.sx))), ry: Math.max(40, r0(Math.abs(y - d.sy))), height: this.opts.hillHeight });
        this.sel = { kind: 'hill', i: m.hills!.length - 1 };
      }, true);
      return;
    }
    if (!d.moved) return;
    // round what was dragged, then settle
    const s = this.sel;
    if (s?.kind === 'unit') {
      const hit = this.findUnit(s.id);
      if (hit) hit.unit.at = [r0(hit.unit.at[0]), r0(hit.unit.at[1])];
    } else if (s?.kind === 'commander') {
      const hit = this.findNode(s.id);
      if (hit?.node.commander?.at) hit.node.commander.at = [r0(hit.node.commander.at[0]), r0(hit.node.commander.at[1])];
    } else if (s?.kind === 'objective' && this.sc.objective) this.sc.objective.at = [r0(this.sc.objective.at[0]), r0(this.sc.objective.at[1])];
    else if (s?.kind === 'label') m.labels![s.i].at = [r0(m.labels![s.i].at[0]), r0(m.labels![s.i].at[1])];
    else if (s?.kind === 'hill') (m.hills![s.i].x = r0(m.hills![s.i].x)), (m.hills![s.i].y = r0(m.hills![s.i].y));
    else if (s?.kind === 'feature') m.features![s.i].polygon = m.features![s.i].polygon.map(([a, b]) => [r0(a), r0(b)] as [number, number]);
    else if (s?.kind === 'road') m.roads![s.i] = m.roads![s.i].map(([a, b]) => [r0(a), r0(b)] as [number, number]);
    const ground = s?.kind === 'label' || s?.kind === 'hill' || s?.kind === 'feature' || s?.kind === 'road';
    this.after(ground, true);
  }

  setHover(x: number, y: number): void {
    this.hover = { x, y };
  }

  private finishDraft(): void {
    const pts = this.draft.map(([a, b]) => [r0(a), r0(b)] as [number, number]);
    this.draft = [];
    const m = this.sc.map;
    if (this.tool === 'poly' && pts.length >= 3) {
      this.mutate(() => {
        const f: MapFeature = { type: this.opts.terrain, polygon: pts };
        if (this.opts.featureName.trim()) f.name = this.opts.featureName.trim();
        (m.features ??= []).push(f);
        this.sel = { kind: 'feature', i: m.features!.length - 1 };
      }, true);
    } else if (this.tool === 'road' && pts.length >= 2) {
      this.mutate(() => {
        (m.roads ??= []).push(pts);
        this.sel = { kind: 'road', i: m.roads!.length - 1 };
      }, true);
    } else this.requestRender();
  }

  /** A click that was not a drag. */
  click(x: number, y: number, e: PointerEvent): void {
    const m = this.sc.map;
    const inside = x >= 0 && y >= 0 && x <= m.width && y <= m.height;
    if (this.pick) {
      if (!inside) return;
      const cb = this.pick.cb;
      this.pick = null;
      cb(r0(x), r0(y));
      return;
    }
    const now = performance.now();
    const px = this.px();
    const dbl = now - this.lastClick.t < 380 && Math.hypot(x - this.lastClick.x, y - this.lastClick.y) < 8 * px;
    this.lastClick = { t: now, x, y };
    switch (this.tool) {
      case 'select': {
        const hit = this.hitObject(x, y);
        if (JSON.stringify(hit) !== JSON.stringify(this.sel)) {
          this.sel = hit;
          this.requestRender();
        }
        break;
      }
      case 'unit': {
        if (!inside) return;
        const side = this.sc.sides[this.opts.side];
        const ut = this.data.units[this.opts.type];
        if (!side || !ut) return;
        this.mutate(() => {
          const id = this.uniqueUnitId(side, ut.arm);
          const u: ScenarioUnit = { id, name: `${ut.label} ${id.split('-').pop()}`, type: this.opts.type, at: [r0(x), r0(y)], facing: this.defaultFacing(this.opts.side), men: ut.men, quality: this.opts.quality };
          if (ut.arm === 'inf') u.formation = this.opts.formation;
          (side.units ??= []).push(u);
          this.sel = { kind: 'unit', id };
        });
        break;
      }
      case 'poly':
      case 'road': {
        if (dbl && this.draft.length >= (this.tool === 'poly' ? 3 : 2)) {
          this.finishDraft();
          return;
        }
        if (!inside) return;
        // closing a polygon by clicking its first point
        if (this.tool === 'poly' && this.draft.length >= 3 && Math.hypot(this.draft[0][0] - x, this.draft[0][1] - y) < 9 * px) {
          this.finishDraft();
          return;
        }
        this.draft.push([x, y]);
        break;
      }
      case 'label': {
        if (!inside || !this.opts.label.trim()) return;
        this.mutate(() => {
          (m.labels ??= []).push({ text: this.opts.label.trim(), at: [r0(x), r0(y)] });
          this.sel = { kind: 'label', i: m.labels!.length - 1 };
        }, true);
        break;
      }
      case 'objective': {
        if (!inside) return;
        this.mutate(() => {
          const prev = this.sc.objective;
          this.sc.objective = { at: [r0(x), r0(y)], radius: prev?.radius ?? this.opts.objRadius, defender: prev?.defender ?? this.sc.sides[1].id, name: prev?.name };
          if (!this.sc.objective.name) delete this.sc.objective.name;
          this.sel = { kind: 'objective' };
        });
        break;
      }
      default:
        break;
    }
    void e;
  }

  setTool(t: Tool): void {
    this.tool = t;
    this.draft = [];
    this.pick = null;
    this.requestRender();
  }

  /** Ask for a point on the map; the next click supplies it. */
  pickPoint(hint: string, cb: (x: number, y: number) => void): void {
    this.pick = { hint, cb };
    this.draft = [];
  }

  key(e: KeyboardEvent): boolean {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      if (e.shiftKey) this.redo();
      else this.undo();
      return true;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      this.redo();
      return true;
    }
    if (mod) return false;
    if (e.key === 'Escape') {
      if (this.pick) this.pick = null;
      else if (this.draft.length) this.draft = [];
      else this.sel = null;
      this.requestRender();
      return true;
    }
    if (e.key === 'Enter' && this.draft.length) {
      this.finishDraft();
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.draft.length) {
        this.draft.pop();
        return true;
      }
      if (this.sel) {
        this.deleteSelection();
        return true;
      }
      return false;
    }
    if ((e.key === 'q' || e.key === 'Q' || e.key === 'e' || e.key === 'E') && this.sel?.kind === 'unit') {
      const hit = this.findUnit(this.sel.id);
      if (!hit) return true;
      const step = (e.shiftKey ? 5 : 15) * (e.key.toLowerCase() === 'q' ? -1 : 1);
      this.mutate(() => {
        hit.unit.facing = ((((hit.unit.facing ?? this.defaultFacing(hit.side)) + step) % 360) + 360) % 360;
      });
      return true;
    }
    return false;
  }

  cursor(): string {
    if (this.pick) return 'crosshair';
    if (this.drag) return this.drag.kind === 'paint' || this.drag.kind === 'newhill' ? 'crosshair' : 'grabbing';
    return this.tool === 'select' ? 'grab' : 'crosshair';
  }

  hint(): string {
    if (this.pick) return `${this.pick.hint} Click the map. Esc cancels.`;
    switch (this.tool) {
      case 'select':
        return 'Click to select; drag to move. A selected unit has a handle to turn it (or press Q and E). Delete removes. Drag empty ground to pan.';
      case 'unit':
        return 'Click the map to place a unit of the chosen side and type. Drag to pan.';
      case 'elev':
        return 'Drag to raise the ground; hold Shift (or tick Lower) to cut it down. The hachures are redrawn when you let go. Scroll to zoom.';
      case 'poly':
        return 'Click each corner. Double-click, press Enter or click the first corner to close. Esc cancels, Backspace removes the last corner.';
      case 'hill':
        return 'Press at the summit and drag out to the foot of the hill.';
      case 'road':
        return 'Click along the road. Double-click or press Enter to finish.';
      case 'label':
        return 'Click where the name should be lettered.';
      case 'objective':
        return 'Click to set the ground the attacker must take.';
    }
  }

  // ------------------------------------------------------------------ overlay

  drawOverlay(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number, cssW: number): void {
    const px = 1 / cam.scale;
    const f = this.frame();
    const m = this.sc.map;
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.ox, dpr * cam.oy);
    ctx.lineJoin = 'round';
    const brass = C.brass;
    const handle = (x: number, y: number, round = false) => {
      ctx.fillStyle = C.paper;
      ctx.strokeStyle = brass;
      ctx.lineWidth = 1.6 * px;
      ctx.beginPath();
      if (round) ctx.arc(x, y, 5 * px, 0, TAU);
      else ctx.rect(x - 4 * px, y - 4 * px, 8 * px, 8 * px);
      ctx.fill();
      ctx.stroke();
    };
    const flag = (x: number, y: number, col: string, text: string) => {
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 1.4 * px;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 20 * px);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x, y - 20 * px);
      ctx.lineTo(x + 13 * px, y - 16 * px);
      ctx.lineTo(x, y - 12 * px);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (text) {
        ctx.font = `${11 * px}px "Alegreya Sans","Segoe UI",sans-serif`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(text).width;
        ctx.fillStyle = 'rgba(227,229,214,0.92)';
        ctx.fillRect(x + 4 * px, y - 9 * px, w + 6 * px, 14 * px);
        ctx.fillStyle = C.ink;
        ctx.fillText(text, x + 7 * px, y - 2 * px);
      }
    };

    // the objective
    const ob = this.sc.objective;
    if (ob) {
      ctx.strokeStyle = brass;
      ctx.lineWidth = (this.sel?.kind === 'objective' ? 2.4 : 1.4) * px;
      ctx.setLineDash([8 * px, 5 * px]);
      ctx.beginPath();
      ctx.arc(ob.at[0], ob.at[1], ob.radius, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      flag(ob.at[0], ob.at[1], brass, ob.name ? `Objective: ${ob.name}` : 'Objective');
    }

    // orders that name a place: a flag, tied to the formation it is addressed to
    const cpos = new Map(f.commanders.map((c) => [c.id, c]));
    this.sc.sides.forEach((s, si) => {
      (s.orders ?? []).forEach((o, i) => {
        if (!o.objective) return;
        const c = cpos.get(o.to);
        const col = C.side[si] ?? C.ink;
        if (c) {
          ctx.strokeStyle = si === 0 ? 'rgba(31,63,140,0.6)' : 'rgba(168,38,43,0.6)';
          ctx.lineWidth = 1.2 * px;
          ctx.setLineDash([3 * px, 4 * px]);
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(o.objective[0], o.objective[1]);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        flag(o.objective[0], o.objective[1], col, `${i + 1}. ${o.type}${o.at !== undefined ? ` at ${Math.round(o.at / 60)} min` : ' on trigger'}`);
      });
    });

    // hills: a mark at each summit so they can be picked; the selected one in full
    if (this.tool === 'select' || this.tool === 'hill') {
      (m.hills ?? []).forEach((h, i) => {
        const selH = this.sel?.kind === 'hill' && this.sel.i === i;
        ctx.fillStyle = selH ? brass : 'rgba(184,138,30,0.75)';
        ctx.strokeStyle = C.paper;
        ctx.lineWidth = 1 * px;
        ctx.beginPath();
        ctx.moveTo(h.x, h.y - 6 * px);
        ctx.lineTo(h.x + 6 * px, h.y + 5 * px);
        ctx.lineTo(h.x - 6 * px, h.y + 5 * px);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        if (selH) {
          ctx.strokeStyle = brass;
          ctx.lineWidth = 1.6 * px;
          ctx.setLineDash([7 * px, 5 * px]);
          ctx.beginPath();
          ctx.ellipse(h.x, h.y, h.rx, h.ry, 0, 0, TAU);
          ctx.stroke();
          ctx.setLineDash([]);
          handle(h.x + h.rx, h.y);
          handle(h.x, h.y + h.ry);
        }
      });
    }

    // selected polygon, road or label
    const s = this.sel;
    if (s?.kind === 'feature' || s?.kind === 'road') {
      const vs = this.vertices();
      if (vs && vs.length) {
        ctx.strokeStyle = brass;
        ctx.lineWidth = 2 * px;
        ctx.setLineDash([7 * px, 4 * px]);
        ctx.beginPath();
        vs.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        if (s.kind === 'feature') ctx.closePath();
        ctx.stroke();
        ctx.setLineDash([]);
        for (const [x, y] of vs) handle(x, y);
      }
    } else if (s?.kind === 'label') {
      const l = m.labels?.[s.i];
      if (l) {
        ctx.strokeStyle = brass;
        ctx.lineWidth = 1.6 * px;
        ctx.setLineDash([5 * px, 4 * px]);
        const w = Math.max(60, l.text.length * 12);
        ctx.strokeRect(l.at[0] - w / 2, l.at[1] - 26, w, 34);
        ctx.setLineDash([]);
      }
    } else if (s?.kind === 'commander') {
      const c = cpos.get(s.id);
      if (c) {
        ctx.strokeStyle = brass;
        ctx.lineWidth = 2.2 * px;
        ctx.beginPath();
        ctx.arc(c.x, c.y, 12 * px, 0, TAU);
        ctx.stroke();
      }
    } else if (s?.kind === 'unit') {
      const u = f.byId.get(s.id);
      if (u && this.isExplicit(u.id)) {
        const [hx, hy] = this.rotateHandle(u);
        ctx.strokeStyle = brass;
        ctx.lineWidth = 1.6 * px;
        ctx.beginPath();
        ctx.moveTo(u.x, u.y);
        ctx.lineTo(hx, hy);
        ctx.stroke();
        handle(hx, hy, true);
      }
    }

    // work in progress
    if (this.draft.length) {
      ctx.strokeStyle = brass;
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      this.draft.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (this.hover) ctx.lineTo(this.hover.x, this.hover.y);
      ctx.stroke();
      if (this.tool === 'poly' && this.draft.length >= 2) {
        ctx.fillStyle = 'rgba(184,138,30,0.14)';
        ctx.beginPath();
        this.draft.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        if (this.hover) ctx.lineTo(this.hover.x, this.hover.y);
        ctx.closePath();
        ctx.fill();
      }
      for (const [x, y] of this.draft) handle(x, y);
    }
    const d = this.drag;
    if (d?.kind === 'newhill' && d.moved) {
      ctx.strokeStyle = brass;
      ctx.lineWidth = 1.8 * px;
      ctx.setLineDash([7 * px, 5 * px]);
      ctx.beginPath();
      ctx.ellipse(d.sx, d.sy, Math.max(40, Math.abs(d.lx - d.sx)), Math.max(40, Math.abs(d.ly - d.sy)), 0, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (this.tool === 'elev') {
      ctx.fillStyle = 'rgba(184,138,30,0.10)';
      for (const [x, y] of this.stamps) {
        ctx.beginPath();
        ctx.arc(x, y, this.opts.brushR * 0.7, 0, TAU);
        ctx.fill();
      }
      if (this.hover) {
        ctx.strokeStyle = brass;
        ctx.lineWidth = 1.5 * px;
        ctx.beginPath();
        ctx.arc(this.hover.x, this.hover.y, this.opts.brushR, 0, TAU);
        ctx.stroke();
      }
    }

    // a banner while waiting for a point
    if (this.pick) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = '14px "Alegreya Sans","Segoe UI",sans-serif';
      const text = `${this.pick.hint} Click the map.`;
      const w = ctx.measureText(text).width + 24;
      ctx.fillStyle = 'rgba(200,160,74,0.96)';
      ctx.fillRect((cssW - w) / 2, 10, w, 28);
      ctx.fillStyle = C.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, cssW / 2, 24);
    }
  }
}

/** The sides of a scenario as select options. */
export const sideOptions = (sc: Scenario): [string, string][] => sc.sides.map((s, i) => [String(i), s.name || s.id || `Side ${i + 1}`]);
