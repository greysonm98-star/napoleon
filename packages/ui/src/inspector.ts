// The unit inspector: state history, the unit's morale events, and for a unit that broke,
// the chain of events behind it, followed across units through "a friend broke" links.
import type { Replay, SimEvent } from '@napoleon/engine';
import { EventIndex, sampleIndex } from './model.ts';
import { causeBy, causeWords, desnake } from './text.ts';
import { C, clock, el, fmt } from './util.ts';

export interface InspectorHost {
  rep: Replay;
  idx: EventIndex;
  t: number;
  /** select a unit and optionally jump to a time */
  go(unit: string | null, t?: number): void;
  setHighlight(ids: Set<string>): void;
  typeLabel(type: string): string;
}

interface CauseRow {
  cause: string;
  from?: string;
  delta: number;
  child?: ChainNode;
}
interface ChainNode {
  ev: SimEvent;
  unit: string;
  rows: CauseRow[];
  /** set when this unit simply joined a general flight: the unit whose loss tipped the army */
  tip?: ChainNode;
}

const isBreak = (e: SimEvent) => e.type === 'rout' || e.type === 'destroyed' || e.type === 'guns_abandoned';

function buildChain(idx: EventIndex, ev: SimEvent, seen: Set<string>, depth: number): ChainNode {
  const unit = String(ev.unit);
  seen.add(unit);
  const node: ChainNode = { ev, unit, rows: [] };
  const causes = ((ev.causes as CauseRow[] | undefined) ?? []).slice().sort((a, b) => a.delta - b.delta);
  const chainIds = (ev.chain as number[] | undefined) ?? [];
  for (const c of causes) {
    const row: CauseRow = { cause: c.cause, from: c.from, delta: c.delta };
    if (c.cause === 'friend_routed' && c.from && depth < 7 && !seen.has(c.from)) {
      // the morale event that recorded this shock carries the id of the friend's own rout event
      let parent: SimEvent | undefined;
      for (const id of chainIds) {
        const m = idx.byId.get(id);
        if (m && m.cause === 'friend_routed' && m.from === c.from && m.parent) {
          const p = idx.byId.get(m.parent as number);
          if (p && isBreak(p)) parent = p;
        }
      }
      parent ??= idx.breakOf(c.from, ev.t);
      if (parent) row.child = buildChain(idx, parent, seen, depth + 1);
    }
    node.rows.push(row);
  }
  if (ev.kind === 'army_broken') {
    const tipId = [...idx.byId.values()].find((e) => e.type === 'army_broken' && e.side === ev.side)?.tipUnit as string | undefined;
    if (tipId && !seen.has(tipId) && depth < 7) {
      const p = idx.breakOf(tipId, ev.t);
      if (p) node.tip = buildChain(idx, p, seen, depth + 1);
    }
  }
  return node;
}

function collect(node: ChainNode, out: Set<string>): void {
  out.add(node.unit);
  for (const r of node.rows) {
    if (r.from) out.add(r.from);
    if (r.child) collect(r.child, out);
  }
  if (node.tip) collect(node.tip, out);
}

export class Inspector {
  private root: HTMLElement;
  private sig = '';
  private unit: string | null = null;
  private charts: { cv: HTMLCanvasElement; kind: 'men' | 'morale' | 'fatigue' | 'ammo' | 'strip' }[] = [];
  private nowEl: HTMLElement | null = null;
  private chartT = -1;
  private chartN = -1;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  /** Call every UI tick; rebuilds the panel only when what it shows has changed. */
  update(h: InspectorHost | null, unit: string | null): void {
    if (!h || !unit || !h.rep.tracks[unit]) {
      const none = h ? 'none-loaded' : 'none';
      if (this.sig !== none) {
        this.sig = none;
        this.unit = null;
        this.root.replaceChildren(el('p', { class: 'muted' }, h ? 'Click a unit on the map.' : 'No battle loaded.'));
        h?.setHighlight(new Set());
      }
      return;
    }
    const evs = h.idx.byUnit.get(unit) ?? [];
    let n = 0;
    for (const e of evs) if (e.t <= h.t) n++;
    const brk = h.idx.breakOf(unit, h.t);
    const sig = `${unit}|${n}|${brk?.id ?? 0}|${h.rep.events.length > 0 ? 1 : 0}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.unit = unit;
      this.build(h, unit, evs, brk);
      this.chartT = -1;
    }
    this.refresh(h, unit);
  }

  private nameOf(h: InspectorHost, id: string | undefined): string {
    if (!id) return '';
    return h.rep.units.find((u) => u.id === id)?.name ?? id;
  }

  private link(h: InspectorHost, id: string, t?: number, text?: string): HTMLElement {
    const b = el('button', { class: 'link', type: 'button' }, text ?? this.nameOf(h, id));
    b.addEventListener('click', () => h.go(id, t));
    return b;
  }

  private build(h: InspectorHost, unit: string, evs: SimEvent[], brk: SimEvent | undefined): void {
    const meta = h.rep.units.find((u) => u.id === unit)!;
    const tr = h.rep.tracks[unit];
    const kids: Node[] = [];
    kids.push(el('div', { class: 'u-name' }, el('span', { class: `chip s${meta.side}` }), meta.name));
    this.nowEl = el('div', { class: 'u-meta' });
    kids.push(el('div', { class: 'u-meta' }, `${h.typeLabel(meta.type)} · ${meta.quality} · ${fmt(meta.startMen)} at the start`), this.nowEl);

    this.charts = [];
    const chart = (kind: (typeof this.charts)[number]['kind'], left: string, right: string) => {
      const cv = el('canvas', { class: kind === 'strip' ? 'chart strip' : 'chart' });
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', `${left} over the run`);
      cv.addEventListener('click', (e) => {
        const r = cv.getBoundingClientRect();
        const end = h.rep.times[h.rep.times.length - 1] || 1;
        h.go(unit, ((e.clientX - r.left) / r.width) * end);
      });
      this.charts.push({ cv, kind });
      kids.push(el('div', { class: 'cap' }, el('span', {}, left), el('span', {}, right)), cv);
    };
    chart('men', 'Men present', `of ${fmt(meta.startMen)}`);
    chart('morale', 'Morale', 'breaks at 20');
    if (tr.fatigue) chart('fatigue', 'Fatigue', '0 to 1');
    if (tr.ammo) chart('ammo', meta.arm === 'art' ? 'Rounds left' : 'Rounds per man', '');
    chart('strip', 'Formation and state', 'line · column · square · routed');

    // why it broke
    const hl = new Set<string>();
    if (brk) {
      const node = buildChain(h.idx, brk, new Set(), 0);
      collect(node, hl);
      hl.delete(unit);
      kids.push(el('h3', {}, brk.type === 'destroyed' ? 'Why it was destroyed' : brk.type === 'guns_abandoned' ? 'Why the guns were abandoned' : 'Why it broke'));
      kids.push(this.sentence(h, node));
      kids.push(el('div', { class: 'cap' }, el('span', {}, `Morale lost in the ${Math.round(((brk.t - Math.max(0, brk.t - 300)) / 60) * 10) / 10} min before`), el('span', {}, 'points')));
      kids.push(this.tree(h, node));
    }
    h.setHighlight(hl);

    // morale events
    const ms = evs.filter((e) => e.type === 'morale' && e.t <= h.t);
    kids.push(el('h3', {}, 'Morale events'));
    if (!ms.length) kids.push(el('p', { class: 'muted' }, h.rep.events.some((e) => e.type === 'morale') ? 'None so far.' : 'This recording holds no morale events.'));
    else {
      const list = el('ul', { class: 'mlist' });
      for (let i = ms.length - 1; i >= 0 && i >= ms.length - 120; i--) {
        const e = ms[i];
        const d = Number(e.delta);
        const li = el('li', {}, el('time', {}, clock(e.t)), el('span', { class: d < 0 ? 'neg' : 'pos' }, (d > 0 ? '+' : '') + d.toFixed(1)));
        const what = el('span', {});
        const from = e.from as string | undefined;
        if (from) {
          const jump = e.parent ? h.idx.byId.get(e.parent as number)?.t ?? e.t : e.t;
          const phrase = causeBy(String(e.cause), '\u0000');
          const [a, b] = phrase.includes('\u0000') ? phrase.split('\u0000') : [causeWords(String(e.cause)) + ' from ', ''];
          what.append(a, this.link(h, from, jump), b);
        } else what.append(causeWords(String(e.cause)));
        li.append(what);
        list.append(li);
      }
      kids.push(list);
    }
    this.root.replaceChildren(...kids);
  }

  /** One line following the heaviest cause at each step: "A broke ← B broke 40 s earlier, 120 m away ← charged in flank by C". */
  private sentence(h: InspectorHost, node: ChainNode): HTMLElement {
    const p = el('p', { class: 'sentence' });
    const verb = (e: SimEvent) => (e.type === 'destroyed' ? 'was destroyed' : e.type === 'guns_abandoned' ? 'abandoned its guns' : 'broke');
    p.append(this.link(h, node.unit, node.ev.t), ` ${verb(node.ev)} at ${clock(node.ev.t)}`);
    let cur: ChainNode | undefined = node;
    let guard = 0;
    while (cur && guard++ < 8) {
      if (cur.tip) {
        p.append(' when the army gave way ← ', this.link(h, cur.tip.unit, cur.tip.ev.t), ` ${verb(cur.tip.ev)}, the loss that tipped it`);
        cur = cur.tip;
        continue;
      }
      // the engine's top cause sums over sources; follow its heaviest single source
      const topCause = cur.ev.topCause;
      const top: CauseRow | undefined = cur.rows.find((r) => r.cause === topCause) ?? cur.rows[0];
      if (!top) {
        if (cur.ev.kind === 'army_broken') p.append(' when the army gave way');
        break;
      }
      if (top.child) {
        const c: ChainNode = top.child;
        const dt = Math.max(0, Math.round(cur.ev.t - c.ev.t));
        const dist = Math.round(Math.hypot(Number(cur.ev.x) - Number(c.ev.x), Number(cur.ev.y) - Number(c.ev.y)));
        p.append(' ← ', this.link(h, c.unit, c.ev.t), ` ${verb(c.ev)} ${dt} s earlier, ${dist} m away`);
        cur = c;
      } else {
        p.append(' ← ');
        if (top.from) {
          const phrase = causeBy(top.cause, '\u0000');
          if (phrase.includes('\u0000')) {
            const [a, b] = phrase.split('\u0000');
            p.append(a, this.link(h, top.from, cur.ev.t), b);
          } else p.append(phrase);
        } else p.append(causeWords(top.cause));
        break;
      }
    }
    return p;
  }

  private tree(h: InspectorHost, node: ChainNode, depth = 0): HTMLElement {
    const ul = el('ul', { class: 'chain' });
    for (const r of node.rows.slice(0, depth ? 4 : 8)) {
      const li = el('li', {}, el('span', { class: 'd' }, r.delta.toFixed(1)));
      const why = el('span', { class: 'why' });
      if (r.from) {
        const phrase = causeBy(r.cause, '\u0000');
        if (phrase.includes('\u0000')) {
          const [a, b] = phrase.split('\u0000');
          why.append(a, this.link(h, r.from, r.child ? r.child.ev.t : node.ev.t), b);
        } else why.append(phrase);
      } else why.append(causeWords(r.cause));
      li.append(why);
      if (r.child) {
        const dt = Math.max(0, Math.round(node.ev.t - r.child.ev.t));
        li.append(el('span', { class: 'muted' }, ` (${dt} s earlier; it broke because:)`), (() => {
          const sub = this.tree(h, r.child!, depth + 1);
          const wrap = el('ul', {});
          wrap.append(...Array.from(sub.children));
          return wrap;
        })());
      }
      ul.append(li);
    }
    if (node.tip) {
      const li = el('li', {}, el('span', { class: 'd' }, ''), el('span', { class: 'why' }, 'the army gave way when ', this.link(h, node.tip.unit, node.tip.ev.t), ' broke, because:'));
      const sub = this.tree(h, node.tip, depth + 1);
      const wrap = el('ul', {});
      wrap.append(...Array.from(sub.children));
      li.append(wrap);
      ul.append(li);
    }
    if (!ul.children.length) ul.append(el('li', { class: 'muted' }, node.ev.kind === 'army_broken' ? 'It was still in good order when the army gave way.' : 'No morale loss was recorded before it.'));
    return ul;
  }

  private refresh(h: InspectorHost, unit: string): void {
    const tr = h.rep.tracks[unit];
    const i = Math.min(tr.x.length - 1, sampleIndex(h.rep.times, h.t));
    if (i < 0) return;
    if (this.nowEl) {
      const st = tr.status[i];
      const form = { L: 'in line', C: 'in column', S: 'in square', '-': '' }[tr.form[i]] ?? '';
      const fl = tr.flags[i] ?? 0;
      const state = st === 'g' ? 'gone from the field' : st === 'r' ? 'routed' : [form, fl & 1 ? 'changing formation' : '', fl & 2 ? 'in melee' : '', fl & 4 ? 'blown' : ''].filter(Boolean).join(', ') || 'formed';
      this.nowEl.textContent = `At ${clock(h.t)}: ${fmt(tr.men[i])} men · morale ${Math.round(tr.morale[i])} · ${state}`;
    }
    const n = h.rep.times.length;
    if (Math.abs(h.t - this.chartT) < 0.5 && n === this.chartN) return;
    this.chartT = h.t;
    this.chartN = n;
    const end = h.rep.times[n - 1] || 1;
    const meta = h.rep.units.find((u) => u.id === unit)!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const { cv, kind } of this.charts) {
      const r = cv.getBoundingClientRect();
      const W = Math.max(50, Math.round(r.width));
      const H = Math.max(10, Math.round(r.height));
      if (cv.width !== W * dpr || cv.height !== H * dpr) {
        cv.width = W * dpr;
        cv.height = H * dpr;
      }
      const g = cv.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const X = (t: number) => (t / end) * (W - 2) + 1;
      if (kind === 'strip') {
        const colour = (k: number) => (tr.status[k] === 'g' ? '#1b2221' : tr.status[k] === 'r' ? C.crit : tr.form[k] === 'L' ? C.sideLt[meta.side] : tr.form[k] === 'C' ? C.side[meta.side] : tr.form[k] === 'S' ? C.brassLt : C.muted);
        let start = 0;
        for (let k = 1; k <= tr.x.length; k++) {
          if (k === tr.x.length || colour(k) !== colour(start)) {
            g.fillStyle = colour(start);
            const x0 = X(h.rep.times[start]);
            const x1 = k < tr.x.length ? X(h.rep.times[k]) : X(h.rep.times[tr.x.length - 1]) + 1;
            g.fillRect(x0, 3, Math.max(1, x1 - x0), H - 6);
            start = k;
          }
        }
        // hatch the spells of formation change
        g.fillStyle = 'rgba(227,229,214,0.55)';
        for (let k = 0; k < tr.x.length; k++) if ((tr.flags[k] ?? 0) & 1 && tr.status[k] === 'o') g.fillRect(X(h.rep.times[k]), H / 2 - 1, Math.max(1, X(h.rep.times[Math.min(n - 1, k + 1)]) - X(h.rep.times[k])), 2);
      } else {
        const series = kind === 'men' ? tr.men : kind === 'morale' ? tr.morale : kind === 'fatigue' ? tr.fatigue! : tr.ammo!;
        let max = kind === 'men' ? meta.startMen : kind === 'morale' ? 100 : kind === 'fatigue' ? 1 : 1;
        if (kind === 'ammo') for (const v of series) if (v > max) max = v;
        const Y = (v: number) => H - 4 - (Math.max(0, v) / max) * (H - 8);
        g.strokeStyle = 'rgba(169,179,166,0.25)';
        g.lineWidth = 1;
        for (const frac of [0.5, 1]) {
          g.beginPath();
          g.moveTo(0, Math.round(Y(max * frac)) + 0.5);
          g.lineTo(W, Math.round(Y(max * frac)) + 0.5);
          g.stroke();
        }
        if (kind === 'morale') {
          g.strokeStyle = 'rgba(210,87,91,0.7)';
          g.setLineDash([4, 3]);
          g.beginPath();
          g.moveTo(0, Y(20));
          g.lineTo(W, Y(20));
          g.stroke();
          g.setLineDash([]);
        }
        // shade the spells when the unit was routed
        g.fillStyle = 'rgba(125,26,26,0.35)';
        for (let k = 0; k < series.length; k++) if (tr.status[k] === 'r') g.fillRect(X(h.rep.times[k]), 0, Math.max(1, X(h.rep.times[Math.min(n - 1, k + 1)]) - X(h.rep.times[k])), H);
        g.strokeStyle = kind === 'morale' ? C.brassLt : C.sideLt[meta.side];
        g.lineWidth = 1.6;
        g.beginPath();
        for (let k = 0; k < series.length; k++) {
          const x = X(h.rep.times[k]);
          const y = Y(series[k]);
          if (k) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.stroke();
      }
      g.strokeStyle = C.paper;
      g.lineWidth = 1;
      const cx = Math.round(X(Math.min(h.t, end))) + 0.5;
      g.beginPath();
      g.moveTo(cx, 0);
      g.lineTo(cx, H);
      g.stroke();
    }
  }
}

export { desnake };
