// The paper map: drawn once per scenario onto an offscreen canvas, in world metres.
// Hills are hachured from the heightmap in the manner of Lehmann: short strokes running
// down the slope from each contour to the next, heavier where the ground is steeper.
import { elevAt, mulberry32 } from '@napoleon/engine';
import type { GameMap, Scenario } from '@napoleon/engine';
import { C } from './util.ts';

const TAU = Math.PI * 2;
const INK = (a: number) => `rgba(32,40,43,${a})`;

function inPoly(poly: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function niceInterval(range: number): number {
  const raw = range / 9;
  for (const s of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10, 15, 20, 25, 50]) if (s >= raw) return s;
  return 100;
}

function hachures(g: CanvasRenderingContext2D, map: GameMap, rnd: () => number): void {
  const W = map.width;
  const H = map.height;
  let lo = Infinity;
  let hi = -Infinity;
  for (const e of map.elev) {
    if (e < lo) lo = e;
    if (e > hi) hi = e;
  }
  if (!(hi - lo > 2)) return;
  const interval = niceInterval(hi - lo);
  const step = Math.max(6, Math.min(12, Math.min(W, H) / 110));
  const cols = Math.ceil(W / step);
  const rows = Math.ceil(H / step);
  const e = new Float32Array((cols + 1) * (rows + 1));
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) e[r * (cols + 1) + c] = elevAt(map, Math.min(W, c * step), Math.min(H, r * step));
  const spacing = step * 0.62;
  g.lineCap = 'butt';
  const h = 3;
  const cross = (ax: number, ay: number, ea: number, bx: number, by: number, eb: number, L: number, out: number[]) => {
    if (ea < L === eb < L) return;
    const k = (L - ea) / (eb - ea);
    out.push(ax + (bx - ax) * k, ay + (by - ay) * k);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * (cols + 1) + c;
      const e00 = e[i];
      const e10 = e[i + 1];
      const e01 = e[i + cols + 1];
      const e11 = e[i + cols + 2];
      const mn = Math.min(e00, e10, e01, e11);
      const mx = Math.max(e00, e10, e01, e11);
      if (mx - mn < 1e-4) continue;
      const x0 = c * step;
      const y0 = r * step;
      for (let L = lo + (Math.ceil((mn - lo) / interval - 0.5) + 0.5) * interval; L < mx; L += interval) {
        if (L <= mn) continue;
        const p: number[] = [];
        cross(x0, y0, e00, x0 + step, y0, e10, L, p);
        cross(x0 + step, y0, e10, x0 + step, y0 + step, e11, L, p);
        cross(x0 + step, y0 + step, e11, x0, y0 + step, e01, L, p);
        cross(x0, y0 + step, e01, x0, y0, e00, L, p);
        if (p.length < 4) continue;
        const sx = p[2] - p[0];
        const sy = p[3] - p[1];
        const len = Math.hypot(sx, sy);
        const n = Math.max(1, Math.round(len / spacing + rnd() * 0.6 - 0.3));
        for (let s = 0; s < n; s++) {
          const k = (s + 0.2 + rnd() * 0.6) / n;
          const px = p[0] + sx * k;
          const py = p[1] + sy * k;
          const gx = (elevAt(map, px + h, py) - elevAt(map, px - h, py)) / (2 * h);
          const gy = (elevAt(map, px, py + h) - elevAt(map, px, py - h)) / (2 * h);
          const slope = Math.hypot(gx, gy);
          if (slope < 0.012) continue;
          // downhill is against the gradient
          const dx = -gx / slope;
          const dy = -gy / slope;
          const run = Math.min(interval / slope, 34) * (0.74 + rnd() * 0.14);
          g.strokeStyle = INK(Math.min(0.72, 0.3 + slope * 2.4));
          g.lineWidth = Math.min(2.6, 0.55 + slope * 11);
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + dx * run, py + dy * run);
          g.stroke();
        }
      }
    }
  }
}

function road(g: CanvasRenderingContext2D, pts: [number, number][]): void {
  const path = () => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    if (pts.length === 2) g.lineTo(pts[1][0], pts[1][1]);
    else {
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        if (i === pts.length - 2) g.quadraticCurveTo(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        else g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
    }
  };
  g.lineCap = 'round';
  g.lineJoin = 'round';
  path();
  g.strokeStyle = INK(0.55);
  g.lineWidth = 11;
  g.stroke();
  path();
  g.strokeStyle = '#efeee0';
  g.lineWidth = 8;
  g.stroke();
}

function wood(g: CanvasRenderingContext2D, poly: [number, number][], rnd: () => number): void {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  g.beginPath();
  poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fillStyle = 'rgba(92,118,88,0.16)';
  g.fill();
  const n = Math.min(900, Math.round(((maxX - minX) * (maxY - minY)) / 260));
  for (let i = 0; i < n; i++) {
    const x = minX + rnd() * (maxX - minX);
    const y = minY + rnd() * (maxY - minY);
    if (!inPoly(poly, x, y)) continue;
    const q = 5.5 + rnd() * 5;
    g.beginPath();
    g.arc(x, y, q, 0, TAU);
    g.fillStyle = 'rgba(92,118,88,0.5)';
    g.fill();
    g.strokeStyle = INK(0.42);
    g.lineWidth = 0.9;
    g.stroke();
    // a little shade stroke on the south-east, as engravers did
    g.beginPath();
    g.arc(x, y, q, 0.1, 1.5);
    g.strokeStyle = INK(0.5);
    g.lineWidth = 1.5;
    g.stroke();
  }
}

function farm(g: CanvasRenderingContext2D, poly: [number, number][], rnd: () => number): void {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of poly) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  g.beginPath();
  poly.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fillStyle = 'rgba(255,255,240,0.4)';
  g.fill();
  g.strokeStyle = C.ink;
  g.lineWidth = 3;
  g.lineJoin = 'miter';
  g.stroke();
  g.save();
  g.clip();
  g.fillStyle = INK(0.82);
  // buildings ranged round a yard
  g.fillRect(minX + w * 0.08, minY + h * 0.1, w * 0.4, h * 0.22);
  g.fillRect(minX + w * 0.62, minY + h * 0.46, w * 0.26, h * 0.4);
  g.fillRect(minX + w * 0.1, minY + h * 0.64, w * 0.2, h * 0.22);
  for (let i = 0; i < 12; i++) {
    g.beginPath();
    g.arc(minX + w * (0.6 + (i % 4) * 0.09), minY + h * (0.12 + Math.floor(i / 4) * 0.1) + rnd() * 2, 2.6, 0, TAU);
    g.fillStyle = 'rgba(92,118,88,0.85)';
    g.fill();
  }
  g.restore();
}

/** Lettering with a paper halo, so it reads where it crosses hachures. */
function letter(g: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  g.save();
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(227,229,214,0.9)';
  g.lineWidth = 7;
  g.strokeText(text, x, y);
  g.fillStyle = INK(0.8);
  g.fillText(text, x, y);
  g.restore();
}

export function paintGround(scenario: Scenario, map: GameMap, pxPerM: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = Math.round(map.width * pxPerM);
  cv.height = Math.round(map.height * pxPerM);
  const g = cv.getContext('2d')!;
  g.setTransform(pxPerM, 0, 0, pxPerM, 0, 0);
  paintInto(g, scenario, map);
  return cv;
}

/**
 * Draw the whole map in world metres into a context whose transform is already set.
 * Everything is vector work from a fixed seed, so a close-up drawn this way matches the overview exactly.
 */
export function paintInto(g: CanvasRenderingContext2D, scenario: Scenario, map: GameMap): void {
  const W = map.width;
  const H = map.height;
  const rnd = mulberry32(11);
  g.fillStyle = C.paper;
  g.fillRect(0, 0, W, H);
  // foxing and wash
  const blots = Math.round((W * H) / 26000);
  for (let i = 0; i < blots; i++) {
    g.fillStyle = i % 2 ? 'rgba(120,130,100,0.05)' : 'rgba(255,255,240,0.07)';
    g.beginPath();
    g.ellipse(rnd() * W, rnd() * H, 50 + rnd() * 120, 35 + rnd() * 85, rnd() * 3, 0, TAU);
    g.fill();
  }
  // faint field boundaries on the low ground
  g.strokeStyle = INK(0.1);
  g.lineWidth = 1.2;
  for (let i = 0; i < Math.round((W * H) / 170000); i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rnd() - 0.5) * 420, y + (rnd() - 0.5) * 250);
    g.stroke();
  }
  for (const r of scenario.map.roads ?? []) if (r.length >= 2) road(g, r);
  hachures(g, map, rnd);
  for (const f of scenario.map.features ?? []) {
    if (f.type === 'wood') wood(g, f.polygon, rnd);
    else farm(g, f.polygon, rnd);
  }
  // lettering
  g.fillStyle = INK(0.74);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  for (const f of scenario.map.features ?? []) {
    if (!f.name) continue;
    let cx = 0,
      top = Infinity,
      bot = -Infinity;
    for (const [x, y] of f.polygon) {
      cx += x / f.polygon.length;
      top = Math.min(top, y);
      bot = Math.max(bot, y);
    }
    g.font = 'italic 21px "IM Fell English",Georgia,serif';
    if (f.type === 'wood') letter(g, f.name, cx, bot + 24);
    else letter(g, f.name, cx, top - 10);
  }
  for (const l of scenario.map.labels ?? []) {
    g.font = `italic ${l.size ?? 25}px "IM Fell English",Georgia,serif`;
    letter(g, l.text, l.at[0], l.at[1]);
  }
  // neat line: a heavy rule and a hair rule inside it
  g.strokeStyle = C.ink;
  g.lineWidth = 3.4;
  g.strokeRect(8, 8, W - 16, H - 16);
  g.lineWidth = 1;
  g.strokeRect(15, 15, W - 30, H - 30);
}
