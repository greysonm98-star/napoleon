// Command and control (MODEL 12.1). Active only when scenario.features.commandControl is true.
//
// A tree of commanders stands between the written orders and the units. Orders are carried by
// couriers, wait out a staff delay at each level, and reach a unit only when it is inside the
// command radius of a commander in its chain. Commanders may act on their own initiative.

import type { Replay, ReplayCommander } from '../record.ts';
import type { CommandNode, ExpandedUnit, Formation, OrderSpec, ScenarioSide } from '../scenario.ts';
import { STREAM, emit, gapOf, makeOrder, rnd, setFormation, shock } from '../sim.ts';
import type { Sim, SimInput, Unit } from '../types.ts';
import { clamp, len } from '../math.ts';

export interface FOrder {
  id: number;
  type: OrderSpec['type'];
  objX: number; // NaN when none
  objY: number;
  target: string | null;
  formation: Formation | null;
  /** Centroid of the addressed formation when the order first took effect; unit offsets are measured from it. */
  cx: number;
  cy: number;
  own: boolean;
  until: number; // time at which a self-issued order lapses; Infinity otherwise
  revert: FOrder | null;
}

export interface CNode {
  idx: number;
  id: string;
  name: string;
  level: CommandNode['level'];
  side: number;
  parent: number;
  children: number[];
  units: number[];
  all: number[];
  x: number;
  y: number;
  fixed: boolean;
  alive: boolean;
  replacedAt: number;
  radius: number;
  initiative: number;
  staffDelay: number;
  order: FOrder | null;
  inbox: { order: FOrder; at: number; relay: boolean }[];
  nextInit: number;
}

interface Courier {
  x: number;
  y: number;
  side: number;
  from: number;
  to: number;
  order: FOrder;
  lostAt: number; // remaining distance at which it is lost; -1 if it will arrive
  relay: boolean;
}

interface Scripted {
  side: number;
  spec: OrderSpec;
  fired: boolean;
}

export interface CState {
  nodes: CNode[];
  byId: Map<string, CNode>;
  roots: number[];
  couriers: Courier[];
  resend: { at: number; from: number; to: number; order: FOrder; relay: boolean }[];
  outbox: { at: number; from: number; to: number; order: FOrder }[];
  scripted: Scripted[];
  unitNode: Int32Array;
  unitOrder: (FOrder | null)[];
  offX: Float64Array;
  offY: Float64Array;
  nextOrderId: number;
}

const state = (sim: Sim): CState => sim.ext.command as CState;
const C = (sim: Sim): Record<string, number> => sim.data.command as Record<string, number>;

function levelDefault(sim: Sim, level: string, what: 'radius' | 'staffDelay'): number {
  const k = level === 'army' ? 'Army' : level === 'corps' ? 'Corps' : level === 'division' ? 'Division' : 'Brigade';
  return C(sim)[what + k];
}

/** With no command structure in the scenario: one headquarters, infantry brigades of four, a cavalry brigade per wing. */
function autoCommand(sim: Sim, side: ScenarioSide, sideIdx: number, units: ExpandedUnit[]): { tree: CommandNode; parents: Map<string, string> } {
  const mine = units.filter((u) => u.side === sideIdx);
  const parents = new Map<string, string>();
  const s = sim.sides[sideIdx];
  let cx = 0,
    cy = 0;
  for (const u of mine) (cx += u.x), (cy += u.y);
  cx /= mine.length || 1;
  cy /= mine.length || 1;
  const children: CommandNode[] = [];
  const size = Math.max(1, Math.round(C(sim).autoBrigadeSize));
  const inf = mine.filter((u) => sim.data.units[u.type].arm === 'inf');
  for (let i = 0; i < inf.length; i += size) {
    const id = `${side.id}-bde-${i / size + 1}`;
    children.push({ id, name: `${side.name} ${i / size + 1}${['st', 'nd', 'rd'][i / size] ?? 'th'} Brigade`, level: 'brigade', commander: { name: `Brigadier ${i / size + 1}` } });
    for (const u of inf.slice(i, i + size)) parents.set(u.id, id);
  }
  const cav = mine.filter((u) => sim.data.units[u.type].arm === 'cav');
  const latOf = (u: ExpandedUnit) => (u.x - cx) * -s.rearY + (u.y - cy) * s.rearX;
  for (const wing of [-1, 1]) {
    const w = cav.filter((u) => (latOf(u) < 0 ? -1 : 1) === wing);
    if (!w.length) continue;
    const id = `${side.id}-cav-${wing < 0 ? 'a' : 'b'}`;
    children.push({ id, name: `${side.name} Cavalry Brigade ${wing < 0 ? 'A' : 'B'}`, level: 'brigade', commander: { name: `Cavalry Brigadier ${wing < 0 ? 'A' : 'B'}` } });
    for (const u of w) parents.set(u.id, id);
  }
  const tree: CommandNode = { id: `${side.id}-hq`, name: `${side.name} Headquarters`, level: 'army', commander: { name: `${side.name} Commander`, at: [clamp(cx + s.rearX * 300, 20, sim.map.width - 20), clamp(cy + s.rearY * 300, 20, sim.map.height - 20)] }, children };
  return { tree, parents };
}

export function init(sim: Sim, expanded: ExpandedUnit[]): void {
  const cfg = C(sim);
  if (!cfg) throw new Error("command and control is on but data file 'command.json' is missing");
  const st: CState = { nodes: [], byId: new Map(), roots: [], couriers: [], resend: [], outbox: [], scripted: [], unitNode: new Int32Array(sim.n).fill(-1), unitOrder: new Array(sim.n).fill(null), offX: new Float64Array(sim.n), offY: new Float64Array(sim.n), nextOrderId: 1 };
  sim.ext.command = st;
  sim.scenario.sides.forEach((side, sideIdx) => {
    let tree = side.command;
    let parents = new Map<string, string>();
    for (const u of expanded) if (u.side === sideIdx && u.parent) parents.set(u.id, u.parent);
    if (!tree) {
      const a = autoCommand(sim, side, sideIdx, expanded);
      tree = a.tree;
      parents = a.parents;
    }
    const add = (n: CommandNode, parent: number): number => {
      const node: CNode = { idx: st.nodes.length, id: n.id, name: n.commander?.name ?? n.name ?? n.id, level: n.level, side: sideIdx, parent, children: [], units: [], all: [], x: n.commander?.at?.[0] ?? NaN, y: n.commander?.at?.[1] ?? NaN, fixed: parent < 0 && !!n.commander?.at, alive: true, replacedAt: -1, radius: n.commander?.radius ?? levelDefault(sim, n.level, 'radius'), initiative: n.commander?.initiative ?? cfg.initiativeDefault, staffDelay: n.commander?.staffDelay ?? levelDefault(sim, n.level, 'staffDelay'), order: null, inbox: [], nextInit: 0 };
      if (st.byId.has(node.id)) throw new Error(`duplicate command id '${node.id}'`);
      st.nodes.push(node);
      st.byId.set(node.id, node);
      for (const uid of n.units ?? []) parents.set(uid, n.id);
      for (const c of n.children ?? []) node.children.push(add(c, node.idx));
      return node.idx;
    };
    const root = add(tree, -1);
    st.roots[sideIdx] = root;
    // attach units; anything unassigned goes to the nearest leaf formation of its side
    const leaves = st.nodes.filter((n) => n.side === sideIdx && !n.children.length && n.idx !== root);
    for (const u of sim.units) {
      if (u.side !== sideIdx) continue;
      const pid = parents.get(u.id);
      let node = pid ? st.byId.get(pid) : undefined;
      if (pid && (!node || node.side !== sideIdx)) throw new Error(`unit ${u.id}: unknown parent formation '${pid}'`);
      if (!node) {
        let best = Infinity;
        for (const lf of leaves) {
          const ms = sim.units.filter((v) => st.unitNode[v.idx] === lf.idx);
          for (const m of ms) {
            const d = len(m.x - u.x, m.y - u.y);
            if (d < best) (best = d), (node = lf);
          }
        }
        node ??= st.nodes[root];
      }
      st.unitNode[u.idx] = node.idx;
      node.units.push(u.idx);
      u.parent = node.id;
    }
    // descendants, bottom-up
    const collect = (i: number): number[] => {
      const n = st.nodes[i];
      n.all = [...n.units];
      for (const c of n.children) n.all.push(...collect(c));
      return n.all;
    };
    collect(root);
    for (const n of st.nodes) if (n.side === sideIdx) n.nextInit = cfg.initiativeInterval + ((n.idx * 17) % Math.max(1, Math.round(cfg.initiativeInterval)));
    // written orders; with none, the side's posture becomes a standing order to the whole army
    const specs: OrderSpec[] = side.orders?.length ? side.orders : [{ at: 0, to: st.nodes[root].id, type: side.posture === 'defend' ? 'defend' : 'attack', formation: side.posture === 'attack_column' ? 'column' : 'line' }];
    for (const spec of specs) {
      if (!st.byId.has(spec.to)) throw new Error(`side ${side.id}: order addressed to unknown formation '${spec.to}'`);
      st.scripted.push({ side: sideIdx, spec, fired: false });
    }
  });
  // place commanders that were given no position
  for (let i = st.nodes.length - 1; i >= 0; i--) {
    const n = st.nodes[i];
    if (n.x === n.x) continue;
    const [tx, ty] = station(sim, n);
    n.x = tx;
    n.y = ty;
  }
  // orders "at 0" are the orders of the day: already in everyone's hands when the action opens
  for (const sc of st.scripted) {
    if (sc.spec.at === 0 && !sc.spec.when) {
      sc.fired = true;
      activate(sim, st.byId.get(sc.spec.to)!, makeFOrder(sim, sc.spec, false), true);
    }
  }
  (sim.ext.recorders ??= []) && (sim.ext.recorders as unknown[]).push(recorderHooks(sim));
}

function makeFOrder(sim: Sim, spec: Partial<OrderSpec> & { type: OrderSpec['type'] }, own: boolean): FOrder {
  const st = state(sim);
  return { id: st.nextOrderId++, type: spec.type, objX: spec.objective ? spec.objective[0] : NaN, objY: spec.objective ? spec.objective[1] : NaN, target: spec.target ?? null, formation: spec.formation ?? null, cx: NaN, cy: NaN, own, until: Infinity, revert: null };
}

function centroid(sim: Sim, idxs: number[], formedOnly: boolean): [number, number, number] {
  let x = 0,
    y = 0,
    k = 0;
  for (const i of idxs) {
    const u = sim.units[i];
    if (u.status === 'gone' || (formedOnly && u.status !== 'ok')) continue;
    x += u.x;
    y += u.y;
    k++;
  }
  return k ? [x / k, y / k, k] : [NaN, NaN, 0];
}

/** Where a commander wants to be: behind the centre of what he commands. */
function station(sim: Sim, n: CNode): [number, number] {
  const cfg = C(sim);
  const st = state(sim);
  const s = sim.sides[n.side];
  let [x, y, k] = centroid(sim, n.units, true);
  let back = cfg.brigadierBehind;
  if (n.children.length) {
    let cx = 0,
      cy = 0,
      ck = 0;
    for (const c of n.children) {
      const ch = st.nodes[c];
      if (ch.x === ch.x) (cx += ch.x), (cy += ch.y), ck++;
    }
    if (ck) {
      x = cx / ck;
      y = cy / ck;
      k = ck;
      back = cfg.generalBehind;
    }
  }
  if (!k) {
    const [ax, ay, ak] = centroid(sim, n.all, false);
    if (!ak) return [n.x === n.x ? n.x : sim.map.width / 2, n.y === n.y ? n.y : sim.map.height / 2];
    x = ax;
    y = ay;
  }
  return [clamp(x + s.rearX * back, 5, sim.map.width - 5), clamp(y + s.rearY * back, 5, sim.map.height - 5)];
}

const describe = (o: FOrder): string => o.type + (o.formation ? ` in ${o.formation}` : '') + (o.objX === o.objX ? ` on (${Math.round(o.objX)}, ${Math.round(o.objY)})` : '') + (o.target ? ` ${o.target}` : '');

/** An order takes effect at a formation: its own units adopt it when in command, and it is passed down. */
function activate(sim: Sim, n: CNode, order: FOrder, instant: boolean): void {
  const st = state(sim);
  if (order.cx !== order.cx) {
    const [cx, cy, k] = centroid(sim, n.all, false);
    order.cx = k ? cx : n.x;
    order.cy = k ? cy : n.y;
  }
  n.order = order;
  if (!instant) emit(sim, { type: 'order_active', side: n.side, formation: n.id, commander: n.name, order: describe(order), own: order.own, x: Math.round(n.x), y: Math.round(n.y) });
  for (const c of n.children) {
    const ch = st.nodes[c];
    if (instant) activate(sim, ch, order, true);
    else st.outbox.push({ at: sim.t, from: n.idx, to: ch.idx, order });
  }
  if (instant) for (const i of n.units) adopt(sim, sim.units[i], order);
}

function adopt(sim: Sim, u: Unit, order: FOrder): void {
  const st = state(sim);
  st.unitOrder[u.idx] = order;
  st.offX[u.idx] = u.x - order.cx;
  st.offY[u.idx] = u.y - order.cy;
  u.posture = order.type === 'attack' ? (order.formation === 'column' ? 'attack_column' : 'attack_line') : 'defend';
  u.thinkT = 0;
}

/** Is the unit inside the radius of a living commander in its chain? */
export function inCommand(sim: Sim, u: Unit): boolean {
  const st = state(sim);
  let i = st.unitNode[u.idx];
  while (i >= 0) {
    const n = st.nodes[i];
    if (n.alive) {
      const dx = u.x - n.x;
      const dy = u.y - n.y;
      if (dx * dx + dy * dy <= n.radius * n.radius) return true;
    }
    i = n.parent;
  }
  return false;
}

function sendCourier(sim: Sim, from: CNode, to: CNode, order: FOrder, relay: boolean, mayBeLost: boolean): void {
  const st = state(sim);
  const cfg = C(sim);
  const D = len(to.x - from.x, to.y - from.y);
  const lost = mayBeLost && rnd(sim, STREAM.COMMAND, from.idx * 131 + to.idx, order.id) < cfg.courierLossChance;
  st.couriers.push({ x: from.x, y: from.y, side: from.side, from: from.idx, to: to.idx, order, lostAt: lost ? D * rnd(sim, STREAM.COMMAND, from.idx * 131 + to.idx, order.id + 7919) : -1, relay });
  if (!relay) emit(sim, { type: 'order_sent', side: from.side, formation: to.id, from: from.name, commander: to.name, order: describe(order), x: Math.round(from.x), y: Math.round(from.y) });
}

const jitter = (sim: Sim, n: CNode, salt: number): number => {
  const j = C(sim).delayJitter;
  return 1 - j + 2 * j * rnd(sim, STREAM.COMMAND, n.idx, salt);
};

function issue(sim: Sim, side: number, spec: OrderSpec, direct: boolean): void {
  const st = state(sim);
  const to = st.byId.get(spec.to);
  if (!to || to.side !== side) return;
  const order = makeFOrder(sim, spec, false);
  if (direct) {
    activate(sim, to, order, true);
    emit(sim, { type: 'order_active', side, formation: to.id, commander: to.name, order: describe(order), own: false, direct: true });
    return;
  }
  const from = st.nodes[st.roots[side]];
  emit(sim, { type: 'order_issued', side, formation: to.id, from: from.name, commander: to.name, order: describe(order) });
  if (from === to) to.inbox.push({ order, at: sim.t + from.staffDelay * jitter(sim, from, order.id), relay: false });
  else st.resend.push({ at: sim.t + from.staffDelay * jitter(sim, from, order.id), from: from.idx, to: to.idx, order, relay: false });
}

function triggered(sim: Sim, sc: Scripted): boolean {
  const st = state(sim);
  const sp = sc.spec;
  if (sp.when) {
    const w = sp.when;
    if (w.unitRouted) {
      const u = sim.byId.get(w.unitRouted);
      return !!u && u.status !== 'ok';
    }
    if (w.formationBroken) {
      const n = st.byId.get(w.formationBroken);
      if (!n) return false;
      let broken = 0;
      for (const i of n.all) if (sim.units[i].status !== 'ok') broken++;
      return n.all.length > 0 && broken / n.all.length >= 0.5;
    }
    if (w.enemyWithin !== undefined) {
      const n = st.byId.get(w.of ?? sp.to);
      if (!n) return false;
      for (const i of n.all) {
        const u = sim.units[i];
        if (u.status !== 'ok') continue;
        for (const e of sim.units) if (e.side !== u.side && e.status === 'ok' && gapOf(sim, u, e) < w.enemyWithin) return true;
      }
      return false;
    }
    return false;
  }
  return sim.t >= (sp.at ?? 0);
}

function initiative(sim: Sim, n: CNode): void {
  const cfg = C(sim);
  if (n.parent < 0 || !n.order || n.inbox.length) return;
  const o = n.order;
  let formed = 0,
    shaken = 0,
    broken = 0,
    cav = 0;
  for (const i of n.all) {
    const u = sim.units[i];
    if (u.status !== 'ok') {
      broken++;
      continue;
    }
    formed++;
    if (u.arm === 'cav') cav++;
    if (u.morale < cfg.shakenMorale) shaken++;
  }
  if (!formed) return;
  const roll = () => rnd(sim, STREAM.COMMAND, n.idx, 3) < n.initiative;
  const act = (order: FOrder, why: string, lasts: number) => {
    order.own = true;
    order.until = sim.t + lasts;
    order.revert = o.own ? o.revert : o;
    n.inbox.push({ order, at: sim.t + n.staffDelay * 0.5, relay: false });
    emit(sim, { type: 'initiative', side: n.side, formation: n.id, commander: n.name, action: describe(order), why, x: Math.round(n.x), y: Math.round(n.y) });
  };
  const s = sim.sides[n.side];
  const [cx, cy] = centroid(sim, n.all, true);
  if (broken / n.all.length >= cfg.collapseFraction && o.type !== 'withdraw') {
    if (roll()) act(makeFOrder(sim, { type: 'withdraw', objective: [clamp(cx + s.rearX * cfg.withdrawDistance, 30, sim.map.width - 30), clamp(cy + s.rearY * cfg.withdrawDistance, 30, sim.map.height - 30)] }, true), 'half the formation has broken', Infinity);
    return;
  }
  if (o.type === 'attack') {
    if (!o.own && shaken / formed > cfg.stallFraction && roll()) act(makeFOrder(sim, { type: 'hold' }, true), 'the attack has stalled; halting to regroup', cfg.regroupTime);
    return;
  }
  if (o.type === 'withdraw') return;
  // opportunity: a vulnerable enemy close to a formation that was not told to attack
  const range = cav * 2 > formed ? cfg.opportunityRangeCavalry : cfg.opportunityRangeInfantry;
  let best: Unit | null = null,
    bd = range;
  for (const e of sim.units) {
    if (e.side === n.side || e.status !== 'ok' || e.arm === 'cav') continue;
    if (!(e.morale < cfg.opportunityMorale || e.formT > 0 || e.melee)) continue;
    if (e.arm === 'inf' && e.form === 'square' && e.formT <= 0 && cav * 2 > formed) continue;
    let d = Infinity;
    for (const i of n.all) {
      const u = sim.units[i];
      if (u.status !== 'ok') continue;
      const g = gapOf(sim, u, e);
      if (g < d) d = g;
    }
    if (d < bd) (bd = d), (best = e);
  }
  if (best && roll()) act(makeFOrder(sim, { type: 'attack', objective: [best.x, best.y], formation: 'line' }, true), `saw ${best.name} in disorder ${Math.round(bd)} m away`, cfg.counterattackTime);
}

export function update(sim: Sim): void {
  const st = state(sim);
  const cfg = C(sim);
  const dt = sim.dt;
  // scripted orders
  for (const sc of st.scripted) {
    if (sc.fired) continue;
    const root = st.nodes[st.roots[sc.side]];
    if (!root.alive) continue;
    if (sim.tick % 5 !== 0 && sc.spec.when) continue;
    if (triggered(sim, sc)) {
      sc.fired = true;
      issue(sim, sc.side, sc.spec, false);
    }
  }
  // orders waiting on a staff to be written or passed on
  for (let i = st.outbox.length - 1; i >= 0; i--) {
    const m = st.outbox[i];
    st.outbox.splice(i, 1);
    sendCourier(sim, st.nodes[m.from], st.nodes[m.to], m.order, true, true);
  }
  for (let i = st.resend.length - 1; i >= 0; i--) {
    const m = st.resend[i];
    if (sim.t < m.at) continue;
    if (!st.nodes[m.from].alive) continue;
    st.resend.splice(i, 1);
    sendCourier(sim, st.nodes[m.from], st.nodes[m.to], m.order, m.relay, true);
  }
  // couriers ride
  const step = cfg.courierSpeed * dt;
  for (let i = st.couriers.length - 1; i >= 0; i--) {
    const c = st.couriers[i];
    const to = st.nodes[c.to];
    const D = len(to.x - c.x, to.y - c.y);
    if (c.lostAt >= 0 && D <= c.lostAt) {
      st.couriers.splice(i, 1);
      emit(sim, { type: 'courier_lost', side: c.side, formation: to.id, order: describe(c.order), x: Math.round(c.x), y: Math.round(c.y) });
      st.resend.push({ at: sim.t + cfg.resendTime, from: c.from, to: c.to, order: c.order, relay: c.relay });
      continue;
    }
    if (D <= step + 10) {
      st.couriers.splice(i, 1);
      to.inbox.push({ order: c.order, at: sim.t + to.staffDelay * jitter(sim, to, c.order.id), relay: c.relay });
      emit(sim, { type: 'order_received', side: c.side, formation: to.id, commander: to.name, order: describe(c.order), x: Math.round(to.x), y: Math.round(to.y) });
      continue;
    }
    c.x += ((to.x - c.x) / D) * step;
    c.y += ((to.y - c.y) / D) * step;
  }
  const every5 = sim.tick % 5 === 0;
  for (const n of st.nodes) {
    // succession
    if (!n.alive) {
      if (sim.t >= n.replacedAt) {
        n.alive = true;
        n.initiative *= cfg.successorInitiative;
        n.radius *= cfg.successorRadius;
        emit(sim, { type: 'commander_replaced', side: n.side, formation: n.id, commander: n.name });
      } else continue;
    }
    // keep station
    if (!n.fixed) {
      const [tx, ty] = station(sim, n);
      const D = len(tx - n.x, ty - n.y);
      const sp = cfg.commanderSpeed * dt;
      if (D <= sp) (n.x = tx), (n.y = ty);
      else (n.x += ((tx - n.x) / D) * sp), (n.y += ((ty - n.y) / D) * sp);
    }
    // inbox
    for (let i = n.inbox.length - 1; i >= 0; i--) {
      if (sim.t >= n.inbox[i].at) {
        const m = n.inbox.splice(i, 1)[0];
        // a newer order from above replaces a self-issued one
        activate(sim, n, m.order, false);
      }
    }
    // self-issued orders lapse
    if (n.order && n.order.own && sim.t >= n.order.until && n.order.revert) {
      const back = n.order.revert;
      emit(sim, { type: 'initiative', side: n.side, formation: n.id, commander: n.name, action: 'resumes ' + describe(back), why: 'time is up' });
      activate(sim, n, back, false);
    }
    if (!every5) continue;
    // units adopt the formation's order once in command
    if (n.order) {
      for (const i of n.units) {
        const u = sim.units[i];
        if (u.status !== 'ok' || st.unitOrder[i] === n.order) continue;
        if (inCommand(sim, u)) adopt(sim, u, n.order);
      }
    }
    // risk to the commander
    if (n.alive) {
      const r2 = cfg.commanderRiskRange * cfg.commanderRiskRange;
      let exposed = false;
      for (const e of sim.units) {
        if (e.side === n.side || e.status !== 'ok') continue;
        const dx = e.x - n.x;
        const dy = e.y - n.y;
        if (dx * dx + dy * dy < r2) {
          exposed = true;
          break;
        }
      }
      if (exposed && rnd(sim, STREAM.COMMAND, n.idx, 1) < cfg.commanderRiskPerSecond * 5 * dt) {
        n.alive = false;
        n.replacedAt = sim.t + cfg.successionTime;
        const id = emit(sim, { type: 'commander_down', side: n.side, formation: n.id, commander: n.name, x: Math.round(n.x), y: Math.round(n.y) });
        for (const i of n.all) {
          const u = sim.units[i];
          if (u.status === 'ok' && len(u.x - n.x, u.y - n.y) <= n.radius) shock(sim, u, -cfg.commanderDownShock * u.q, 'commander_down', -1, id);
        }
        n.name = `${n.name}'s successor`;
        continue;
      }
    }
    if (sim.t >= n.nextInit) {
      n.nextInit = sim.t + cfg.initiativeInterval;
      initiative(sim, n);
    }
  }
  if (every5) for (const u of sim.units) if (u.status === 'ok') u.inCommand = inCommand(sim, u);
}

/** The point a unit should make for under its formation's order, or null if the order names none. */
function orderPoint(sim: Sim, u: Unit, o: FOrder): [number, number] | null {
  const st = state(sim);
  const cfg = C(sim);
  const m = sim.data.terrain.mapMargin;
  let bx = o.objX,
    by = o.objY;
  if (o.type === 'support' && o.target) {
    const tn = st.byId.get(o.target);
    if (tn) {
      const [tx, ty, k] = centroid(sim, tn.all, true);
      if (k) {
        const s = sim.sides[u.side];
        bx = tx + s.rearX * cfg.supportDistance;
        by = ty + s.rearY * cfg.supportDistance;
      }
    }
  }
  if (bx !== bx) return null;
  return [clamp(bx + st.offX[u.idx], m, sim.map.width - m), clamp(by + st.offY[u.idx], m, sim.map.height - m)];
}

/** Called from the unit AI. Returns true if it has set the unit's order for this decision. */
export function aiOverride(sim: Sim, u: Unit, nearest: Unit | null, dist: number): boolean {
  const st = state(sim);
  const cfg = C(sim);
  const o = st.unitOrder[u.idx];
  if (!o) return false;
  if (o.type === 'hold' || (o.type === 'defend' && o.objX !== o.objX)) return false;
  if (o.type === 'reserve') {
    if (u.arm === 'inf' && nearest && dist < sim.data.weapons.musketry.lookRange) return false; // enemy is on top of us: stand and fight
    u.order = null;
    if (u.arm === 'inf' && u.form !== 'column' && u.formT <= 0 && !u.melee) setFormation(sim, u, 'column');
    return true;
  }
  const p = orderPoint(sim, u, o);
  if (o.type === 'attack') {
    if (!p) return false;
    if (nearest && dist < cfg.engageRadius) return false; // enemy in reach: fight as the posture says
    if (len(p[0] - u.x, p[1] - u.y) < cfg.arriveDistance) {
      if (!nearest) return false;
      // objective reached and no enemy near it: press on against the nearest enemy
      return false;
    }
  } else {
    if (!p) return false;
    if (o.type !== 'withdraw' && u.arm !== 'cav' && nearest && dist < sim.data.weapons.musketry.lookRange) return false;
    if (len(p[0] - u.x, p[1] - u.y) < cfg.arriveDistance) {
      u.homeX = p[0];
      u.homeY = p[1];
      return false;
    }
  }
  u.order = makeOrder('move', -1, p[0], p[1], false);
  if (u.arm === 'inf' && u.form !== 'column' && u.formT <= 0 && !u.melee) setFormation(sim, u, 'column');
  return true;
}

export function cavLeashFactor(sim: Sim, u: Unit): number {
  const o = state(sim).unitOrder[u.idx];
  if (!o) return 1;
  return o.type === 'attack' || o.type === 'defend' ? 1 : C(sim).restrainedLeash;
}

export function recoveryFactor(sim: Sim, u: Unit): number {
  return u.inCommand ? 1 : C(sim).outOfCommandRecovery;
}

export function rallyFactor(sim: Sim, u: Unit): number {
  return inCommand(sim, u) ? C(sim).rallyCommanderFactor : 1;
}

/** An order from the player to a formation. It travels like any other unless marked direct. */
export function onCommandInput(sim: Sim, input: SimInput): void {
  const st = state(sim);
  const p = input.payload as (OrderSpec & { direct?: boolean }) | undefined;
  if (!p || !st.byId.has(p.to)) return;
  issue(sim, st.byId.get(p.to)!.side, p, !!p.direct);
}

function recorderHooks(sim: Sim): { sample: (s: Sim) => void; finish: (r: Replay) => void } {
  const st = state(sim);
  const tracks: ReplayCommander[] = st.nodes.map((n) => ({ id: n.id, name: n.name, side: n.side, level: n.level, radius: Math.round(n.radius), parent: n.parent >= 0 ? st.nodes[n.parent].id : null, x: [], y: [], alive: '' }));
  const couriers: number[][] = [];
  return {
    sample() {
      st.nodes.forEach((n, i) => {
        tracks[i].x.push(Math.round(n.x));
        tracks[i].y.push(Math.round(n.y));
        tracks[i].alive += n.alive ? 'a' : 'd';
      });
      couriers.push(st.couriers.flatMap((c) => [Math.round(c.x), Math.round(c.y), c.side]));
    },
    finish(r: Replay) {
      r.commanders = tracks;
      r.couriers = couriers;
    },
  };
}

export interface CommandSummary {
  ordersSent: number;
  couriersLost: number;
  commandersDown: number;
  initiatives: number;
}
