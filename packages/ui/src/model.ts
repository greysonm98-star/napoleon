// What the renderer draws (a Frame), built either from a replay at a time t or from a live sim.
import type { Replay, Sim, SimEvent } from '@napoleon/engine';

export interface FrameUnit {
  id: string;
  name: string;
  side: number;
  arm: string;
  x: number;
  y: number;
  f: number;
  w: number;
  d: number;
  men: number;
  startMen: number;
  morale: number;
  form: 'line' | 'column' | 'square' | null;
  status: 'ok' | 'rout' | 'gone';
  forming: boolean;
  melee: boolean;
  blown: boolean;
  moving: boolean;
  manual: boolean;
  /** Skirmishers out in front of the battalion, if any. */
  skirm?: number;
  /** Where its current order points, if known (live runs only). */
  orderX?: number;
  orderY?: number;
}
export interface FrameCommander {
  id: string;
  name: string;
  side: number;
  level: string;
  radius: number;
  parent: string | null;
  x: number;
  y: number;
  alive: boolean;
}
export interface Frame {
  t: number;
  units: FrameUnit[];
  byId: Map<string, FrameUnit>;
  commanders: FrameCommander[];
  couriers: number[];
  smoke: { cell: number; cols: number; rows: number; key: number; frame: string } | null;
}

const FORM: Record<string, FrameUnit['form']> = { L: 'line', C: 'column', S: 'square', '-': null };
const STATUS: Record<string, FrameUnit['status']> = { o: 'ok', r: 'rout', g: 'gone' };

/** Index of the last sample at or before t. */
export function sampleIndex(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0) return 0;
  if (t >= times[hi]) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  d -= Math.PI * 2 * Math.floor((d + Math.PI) / (Math.PI * 2));
  return a + d * k;
}

function extras(rep: Replay, i: number, j: number, k: number): Pick<Frame, 'commanders' | 'couriers' | 'smoke'> {
  const commanders: FrameCommander[] = (rep.commanders ?? []).map((c) => ({
    id: c.id,
    name: c.name,
    side: c.side,
    level: c.level,
    radius: c.radius,
    parent: c.parent,
    x: lerp(c.x[i] ?? 0, c.x[j] ?? c.x[i] ?? 0, k),
    y: lerp(c.y[i] ?? 0, c.y[j] ?? c.y[i] ?? 0, k),
    alive: (c.alive[i] ?? 'a') === 'a',
  }));
  const couriers = rep.couriers?.[i] ?? [];
  let smoke: Frame['smoke'] = null;
  if (rep.smoke && rep.smoke.frames.length) {
    const key = Math.min(rep.smoke.frames.length - 1, Math.floor(i / Math.max(1, rep.smoke.every)));
    smoke = { cell: rep.smoke.cell, cols: rep.smoke.cols, rows: rep.smoke.rows, key, frame: rep.smoke.frames[key] };
  }
  return { commanders, couriers, smoke };
}

export function frameFromReplay(rep: Replay, t: number): Frame {
  const i = sampleIndex(rep.times, t);
  const j = Math.min(rep.times.length - 1, i + 1);
  const span = rep.times[j] - rep.times[i];
  const k = span > 0 ? Math.min(1, Math.max(0, (t - rep.times[i]) / span)) : 0;
  const units: FrameUnit[] = [];
  const byId = new Map<string, FrameUnit>();
  for (const m of rep.units) {
    const tr = rep.tracks[m.id];
    if (!tr || tr.x.length <= i) continue;
    const jj = Math.min(tr.x.length - 1, j);
    const status = STATUS[tr.status[i]] ?? 'ok';
    const flags = tr.flags[i] ?? 0;
    const u: FrameUnit = {
      id: m.id,
      name: m.name,
      side: m.side,
      arm: m.arm,
      x: lerp(tr.x[i], tr.x[jj], k),
      y: lerp(tr.y[i], tr.y[jj], k),
      f: lerpAngle(tr.f[i], tr.f[jj], k),
      w: tr.w[i],
      d: tr.d[i],
      men: tr.men[i],
      startMen: m.startMen,
      morale: lerp(tr.morale[i], tr.morale[jj], k),
      form: FORM[tr.form[i]] ?? null,
      status,
      forming: (flags & 1) !== 0,
      melee: (flags & 2) !== 0,
      blown: (flags & 4) !== 0,
      moving: (flags & 8) !== 0,
      manual: false,
      skirm: (tr as unknown as { skirm?: number[] }).skirm?.[i] ?? 0,
    };
    units.push(u);
    byId.set(u.id, u);
  }
  return { t, units, byId, ...extras(rep, i, j, k) };
}

/** A frame straight from the running engine; commanders, couriers and smoke come from the recorder's latest sample. */
export function frameFromSim(sim: Sim, view: Replay | null): Frame {
  const units: FrameUnit[] = [];
  const byId = new Map<string, FrameUnit>();
  for (const s of sim.units) {
    let ox: number | undefined;
    let oy: number | undefined;
    if (s.order) {
      if (s.order.type === 'attack') {
        const tg = sim.units[s.order.target];
        if (tg && tg.status !== 'gone') {
          ox = tg.x;
          oy = tg.y;
        }
      } else {
        ox = s.order.x;
        oy = s.order.y;
      }
    }
    const u: FrameUnit = { id: s.id, name: s.name, side: s.side, arm: s.arm, x: s.x, y: s.y, f: s.f, w: s.w, d: s.d, men: s.men, startMen: s.startMen, morale: s.morale, form: s.form, status: s.status, forming: s.formT > 0, melee: s.melee, blown: s.blown > 0, moving: s.moving, manual: s.manual, skirm: s.skirmishers, orderX: ox, orderY: oy };
    units.push(u);
    byId.set(u.id, u);
  }
  const n = view ? view.times.length - 1 : -1;
  const ex = view && n >= 0 ? extras(view, n, n, 0) : { commanders: [], couriers: [], smoke: null };
  return { t: sim.t, units, byId, ...ex };
}

/** Lookup tables over a replay's event log. Grows incrementally, so it also serves a run in progress. */
export class EventIndex {
  byId = new Map<number, SimEvent>();
  byUnit = new Map<string, SimEvent[]>();
  /** rout, destroyed and guns_abandoned events, in time order */
  breaks: SimEvent[] = [];
  marks: SimEvent[] = [];
  private done = 0;
  private src: SimEvent[] = [];

  sync(events: SimEvent[]): boolean {
    if (events !== this.src) {
      this.byId.clear();
      this.byUnit.clear();
      this.breaks = [];
      this.marks = [];
      this.done = 0;
      this.src = events;
    }
    if (this.done === events.length) return false;
    for (let i = this.done; i < events.length; i++) {
      const e = events[i];
      this.byId.set(e.id, e);
      if (e.unit) {
        let l = this.byUnit.get(e.unit);
        if (!l) this.byUnit.set(e.unit, (l = []));
        l.push(e);
      }
      if (e.type === 'rout' || e.type === 'destroyed' || e.type === 'guns_abandoned') {
        this.breaks.push(e);
        if (e.kind !== 'army_broken') this.marks.push(e);
      } else if (e.type === 'rally' || e.type === 'army_broken') this.marks.push(e);
    }
    this.done = events.length;
    return true;
  }

  /** The unit's last break at or before t (or its last at all). */
  breakOf(unit: string, t = Infinity): SimEvent | undefined {
    const l = this.byUnit.get(unit);
    if (!l) return undefined;
    for (let i = l.length - 1; i >= 0; i--) {
      const e = l[i];
      if ((e.type === 'rout' || e.type === 'destroyed' || e.type === 'guns_abandoned') && e.t <= t) return e;
    }
    return undefined;
  }
}

/** First index in a time-sorted event list with e.t > t. */
export function upperBound(events: SimEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
