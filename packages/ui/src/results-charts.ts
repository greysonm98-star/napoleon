// Small SVG charts for the Results tab, drawn to the dataviz rules: thin marks, hairline grid,
// 10% washes for intervals, legend for two or more series, crosshair or per-bar tooltips that
// are also reachable through each chart's table view. Text is set with textContent only.

import { el } from './util.ts';
import type { Bin, Val } from './results-model.ts';

const NS = 'http://www.w3.org/2000/svg';
export const RC = {
  surface: '#e3e5d6',
  ink: '#20282b',
  text2: '#52514e',
  grid: '#c9ccbc',
  side: ['#2b56b0', '#b8322f'],
  cause: ['#d0571f', '#13906a', '#6250d6'],
  other: '#8a8d84',
};

type Attrs = Record<string, string | number>;
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string)[]): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  for (const k of kids) e.append(k);
  return e;
}

export const pct = (v: number): string => (v === v ? `${Math.round(v * 100)}%` : '–');
export const pctRange = (lo: number, hi: number): string => (lo === lo && hi === hi ? `${Math.round(lo * 100)}–${Math.round(hi * 100)}%` : '–');
export const fmtVal = (v: Val): string => (typeof v === 'number' ? String(Number(v.toPrecision(6))) : String(v));
export const f1 = (v: number): string => (v === v ? v.toFixed(1) : '–');

/** Clean tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, target = 5): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}
const tickText = (v: number): string => String(Number(v.toPrecision(6)));

// ------------------------------------------------------------------ card, tooltip, table

export interface Card {
  el: HTMLElement;
  /** Draws (or redraws) the chart at this inner width. */
  draw(width: number): void;
  lastW: number;
}

export function makeTip(host: HTMLElement): { show(x: number, y: number, head: string, rows: { color?: string; value: string; label: string }[]): void; hide(): void } {
  const tip = el('div', { class: 'res-tip' });
  tip.hidden = true;
  host.append(tip);
  return {
    show(x, y, head, rows) {
      tip.replaceChildren();
      if (head) tip.append(el('div', { class: 'res-tip-head' }, head));
      for (const r of rows) {
        const row = el('div', { class: 'res-tip-row' });
        if (r.color) {
          const key = el('i', { class: 'res-key-line' });
          key.style.background = r.color;
          row.append(key);
        }
        row.append(el('strong', {}, r.value), el('span', {}, r.label));
        tip.append(row);
      }
      tip.hidden = false;
      const hw = host.clientWidth;
      const tw = tip.offsetWidth;
      tip.style.left = Math.max(4, Math.min(hw - tw - 4, x + 14)) + 'px';
      tip.style.top = Math.max(4, y - tip.offsetHeight - 10) + 'px';
    },
    hide() {
      tip.hidden = true;
    },
  };
}

export function dataTable(head: string[], rows: (string | number)[][], numericFrom = 1): HTMLTableElement {
  const t = el('table', { class: 'res-table' });
  const tr = el('tr');
  head.forEach((h, i) => tr.append(el('th', { class: i >= numericFrom ? 'num' : '' }, h)));
  t.append(el('thead', {}, tr));
  const tb = el('tbody');
  for (const r of rows) {
    const row = el('tr');
    r.forEach((c, i) => row.append(el('td', { class: i >= numericFrom ? 'num' : '' }, String(c))));
    tb.append(row);
  }
  t.append(tb);
  return t;
}

/** A paper card with a title, an optional legend, and a Table toggle that swaps the chart for its numbers. */
export function card(title: string, subtitle: string, legend: { color: string; label: string; kind: 'line' | 'rect' }[], drawChart: (box: HTMLElement, width: number) => void, makeTable?: () => HTMLElement): Card {
  const box = el('div', { class: 'res-plot' });
  const head = el('div', { class: 'res-card-head' }, el('h4', {}, title));
  const c: Card = {
    el: el('section', { class: 'res-card' }),
    lastW: 0,
    draw(w: number) {
      c.lastW = w;
      if (showingTable) return;
      box.replaceChildren();
      drawChart(box, w);
    },
  };
  let showingTable = false;
  if (makeTable) {
    const b = el('button', { class: 'res-toggle', type: 'button' }, 'Table');
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      showingTable = !showingTable;
      b.setAttribute('aria-pressed', String(showingTable));
      b.textContent = showingTable ? 'Chart' : 'Table';
      box.replaceChildren();
      if (showingTable) box.append(el('div', { class: 'res-table-wrap' }, makeTable()));
      else drawChart(box, c.lastW);
    });
    head.append(b);
  }
  c.el.append(head);
  if (subtitle) c.el.append(el('p', { class: 'res-sub' }, subtitle));
  if (legend.length >= 2) {
    const lg = el('div', { class: 'res-legend' });
    for (const l of legend) {
      const key = el('i', { class: l.kind === 'line' ? 'res-key-line' : 'res-key-rect' });
      key.style.background = l.color;
      lg.append(el('span', {}, key, l.label));
    }
    c.el.append(lg);
  }
  c.el.append(box);
  return c;
}

// ------------------------------------------------------------------ line chart with interval bands

export interface LineSeries {
  name: string;
  color: string;
  pts: { y: number; lo: number; hi: number }[]; // one per x, NaN where missing
}

export interface LineOpts {
  xs: Val[];
  xLabel: string;
  yDomain: [number, number];
  yFmt: (v: number) => string;
  intervalName: string;
  series: LineSeries[];
  selected: number; // index into xs
  height?: number;
}

export function lineChart(box: HTMLElement, width: number, o: LineOpts): void {
  const H = o.height ?? 220;
  const numeric = o.xs.every((x) => typeof x === 'number');
  const m = { l: 46, r: o.series.length >= 2 ? 64 : 14, t: 10, b: 38 };
  const W = Math.max(220, width);
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const xv = o.xs.map((x) => x as number);
  const xmin = numeric ? Math.min(...xv) : 0;
  const xmax = numeric ? Math.max(...xv) : Math.max(1, o.xs.length - 1);
  const pad = numeric ? (xmax - xmin || 1) * 0.04 : 0.35;
  const X = (i: number): number => {
    const v = numeric ? xv[i] : i;
    return m.l + ((v - (xmin - pad)) / (xmax - xmin + 2 * pad)) * pw;
  };
  const [y0, y1] = o.yDomain;
  const Y = (v: number): number => m.t + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
  const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', tabindex: 0, class: 'res-svg' });
  s.setAttribute('aria-label', `${o.series.map((x) => x.name).join(' and ')} against ${o.xLabel}. Use the Table button for the numbers; arrow keys move the readout.`);
  // grid and y ticks
  const yt = niceTicks(y0, y1, 4);
  for (const v of yt) {
    s.append(svg('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), stroke: RC.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    s.append(svg('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'res-tick' }, o.yFmt(v)));
  }
  // x ticks
  const xt = numeric ? niceTicks(xmin, xmax, Math.max(2, Math.min(6, Math.floor(pw / 70)))) : o.xs.map((_, i) => i);
  for (const v of xt) {
    const px = numeric ? m.l + ((v - (xmin - pad)) / (xmax - xmin + 2 * pad)) * pw : X(v);
    if (px < m.l - 1 || px > m.l + pw + 1) continue;
    s.append(svg('line', { x1: px, x2: px, y1: m.t + ph, y2: m.t + ph + 4, stroke: RC.grid }));
    s.append(svg('text', { x: px, y: m.t + ph + 16, 'text-anchor': 'middle', class: 'res-tick' }, numeric ? tickText(v) : fmtVal(o.xs[v])));
  }
  s.append(svg('text', { x: m.l + pw / 2, y: H - 4, 'text-anchor': 'middle', class: 'res-axis' }, o.xLabel));
  // the selected point
  if (o.selected >= 0) {
    // the value shown in the sections below: a narrow highlight band, not a line that reads as an axis
    s.append(svg('rect', { x: X(o.selected) - 9, y: m.t, width: 18, height: ph, fill: RC.text2, 'fill-opacity': 0.1, rx: 3 }));
  }
  // bands, then lines, then markers
  for (const ser of o.series) {
    const ok = ser.pts.map((p, i) => [p, i] as const).filter(([p]) => p.lo === p.lo && p.hi === p.hi);
    if (ok.length >= 2) {
      const top = ok.map(([p, i]) => `${X(i)},${Y(p.hi)}`);
      const bot = ok.slice().reverse().map(([p, i]) => `${X(i)},${Y(p.lo)}`);
      s.append(svg('polygon', { points: [...top, ...bot].join(' '), fill: ser.color, 'fill-opacity': 0.1 }));
    }
  }
  for (const ser of o.series) {
    const ok = ser.pts.map((p, i) => [p, i] as const).filter(([p]) => p.y === p.y);
    if (ok.length >= 2) s.append(svg('polyline', { points: ok.map(([p, i]) => `${X(i)},${Y(p.y)}`).join(' '), fill: 'none', stroke: ser.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    for (const [p, i] of ok) s.append(svg('circle', { cx: X(i), cy: Y(p.y), r: 4, fill: ser.color, stroke: RC.surface, 'stroke-width': 2 }));
  }
  // direct labels at the right end when they do not collide; the legend carries them otherwise
  if (o.series.length >= 2) {
    const ends = o.series.map((ser) => {
      const last = [...ser.pts.keys()].reverse().find((i) => ser.pts[i].y === ser.pts[i].y);
      return last === undefined ? null : { name: ser.name, x: X(last), y: Y(ser.pts[last].y) };
    });
    const ys = ends.filter((e) => e).map((e) => e!.y).sort((a, b) => a - b);
    const apart = ys.every((y, i) => i === 0 || y - ys[i - 1] >= 14);
    if (apart) for (const e of ends) if (e) s.append(svg('text', { x: e.x + 8, y: e.y + 4, class: 'res-direct' }, e.name));
  }
  // crosshair and readout
  const cross = svg('line', { y1: m.t, y2: m.t + ph, stroke: RC.ink, 'stroke-width': 1, visibility: 'hidden' });
  s.append(cross);
  const hit = svg('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' });
  s.append(hit);
  box.append(s);
  const tip = makeTip(box);
  let at = -1;
  const show = (i: number) => {
    at = i;
    cross.setAttribute('x1', String(X(i)));
    cross.setAttribute('x2', String(X(i)));
    cross.setAttribute('visibility', 'visible');
    const rows = o.series.map((ser) => ({ color: ser.color, value: ser.pts[i].y === ser.pts[i].y ? `${o.yFmt(ser.pts[i].y)}  (${o.yFmt(ser.pts[i].lo)}–${o.yFmt(ser.pts[i].hi)})` : '–', label: ser.name }));
    const ymin = Math.min(...o.series.map((ser) => (ser.pts[i].y === ser.pts[i].y ? Y(ser.pts[i].y) : m.t + ph)));
    tip.show(X(i), ymin, `${o.xLabel} = ${fmtVal(o.xs[i])} · ${o.intervalName} in brackets`, rows);
  };
  const hide = () => {
    at = -1;
    cross.setAttribute('visibility', 'hidden');
    tip.hide();
  };
  hit.addEventListener('pointermove', (e) => {
    const r = s.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0;
    for (let i = 1; i < o.xs.length; i++) if (Math.abs(X(i) - px) < Math.abs(X(best) - px)) best = i;
    show(best);
  });
  hit.addEventListener('pointerleave', hide);
  s.addEventListener('focus', () => show(o.selected >= 0 ? o.selected : 0));
  s.addEventListener('blur', hide);
  s.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      show(Math.max(0, Math.min(o.xs.length - 1, (at < 0 ? 0 : at) + (e.key === 'ArrowRight' ? 1 : -1))));
    }
  });
}

// ------------------------------------------------------------------ histogram

export interface HistOpts {
  bins: Bin[];
  color: string;
  xFmt: (v: number) => string;
  xLabel: string;
  yMax: number;
  height?: number;
  /** What one count is, for the readout: 'runs'. */
  noun: string;
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function histogram(box: HTMLElement, width: number, o: HistOpts): void {
  const H = o.height ?? 170;
  const m = { l: 34, r: 10, t: 8, b: 36 };
  const W = Math.max(180, width);
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const lo = o.bins[0]?.lo ?? 0;
  const hi = o.bins[o.bins.length - 1]?.hi ?? 1;
  const X = (v: number) => m.l + ((v - lo) / (hi - lo || 1)) * pw;
  const yMax = Math.max(1, o.yMax);
  const Y = (v: number) => m.t + ph - (v / yMax) * ph;
  const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', tabindex: 0, class: 'res-svg' });
  s.setAttribute('aria-label', `Histogram of ${o.xLabel}. Use the Table button for the counts.`);
  const yt = niceTicks(0, yMax, 3).filter((v) => Number.isInteger(v));
  for (const v of yt) {
    s.append(svg('line', { x1: m.l, x2: m.l + pw, y1: Y(v), y2: Y(v), stroke: RC.grid, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    s.append(svg('text', { x: m.l - 5, y: Y(v) + 4, 'text-anchor': 'end', class: 'res-tick' }, String(v)));
  }
  const xt = niceTicks(lo, hi, Math.max(2, Math.min(6, Math.floor(pw / 60))));
  for (const v of xt) {
    if (v < lo - 1e-9 || v > hi + 1e-9) continue;
    s.append(svg('text', { x: X(v), y: m.t + ph + 15, 'text-anchor': 'middle', class: 'res-tick' }, o.xFmt(v)));
  }
  s.append(svg('text', { x: m.l + pw / 2, y: H - 4, 'text-anchor': 'middle', class: 'res-axis' }, o.xLabel));
  const bars: SVGPathElement[] = [];
  for (const b of o.bins) {
    const slot = X(b.hi) - X(b.lo);
    const w = Math.max(1, Math.min(24, slot - 2));
    const x = X(b.lo) + (slot - w) / 2;
    const h = (b.count / yMax) * ph;
    const p = svg('path', { d: b.count ? roundedTop(x, Y(b.count), w, h, 4) : '', fill: o.color });
    bars.push(p);
    s.append(p);
  }
  const hit = svg('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' });
  s.append(hit);
  box.append(s);
  const tip = makeTip(box);
  let at = -1;
  const show = (i: number) => {
    if (at >= 0) bars[at].removeAttribute('fill-opacity');
    at = i;
    bars[i].setAttribute('fill-opacity', '0.7');
    const b = o.bins[i];
    tip.show(X((b.lo + b.hi) / 2), Y(b.count), '', [{ color: o.color, value: `${b.count} ${o.noun}`, label: `${o.xFmt(b.lo)} to ${o.xFmt(b.hi)}` }]);
  };
  const hide = () => {
    if (at >= 0) bars[at].removeAttribute('fill-opacity');
    at = -1;
    tip.hide();
  };
  hit.addEventListener('pointermove', (e) => {
    const r = s.getBoundingClientRect();
    const v = lo + ((e.clientX - r.left - m.l) / pw) * (hi - lo);
    show(Math.max(0, Math.min(o.bins.length - 1, Math.floor((v - lo) / ((hi - lo) / o.bins.length)))));
  });
  hit.addEventListener('pointerleave', hide);
  s.addEventListener('focus', () => {
    const top = o.bins.reduce((bi, b, i) => (b.count > o.bins[bi].count ? i : bi), 0);
    show(top);
  });
  s.addEventListener('blur', hide);
  s.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      show(Math.max(0, Math.min(o.bins.length - 1, (at < 0 ? 0 : at) + (e.key === 'ArrowRight' ? 1 : -1))));
    }
  });
}
