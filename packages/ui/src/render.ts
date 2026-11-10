// Drawing the battle on the visible canvas: ground image, smoke, units, fire effects, overlays.
import type { SimEvent } from '@napoleon/engine';
import type { Frame, FrameUnit } from './model.ts';
import { C, strHash } from './util.ts';

const TAU = Math.PI * 2;

export interface Camera {
  /** CSS pixels per metre */
  scale: number;
  /** CSS pixel position of world origin */
  ox: number;
  oy: number;
}

export interface DrawOptions {
  selected: string | null;
  highlight: Set<string>;
  /** fire events around the current time, already filtered */
  fx: SimEvent[];
  /** rout locations up to now */
  routMarks: SimEvent[];
  showOrders: boolean;
}

/** Footprint as drawn: true size, but never thinner than a few screen pixels. */
export function drawnSize(u: FrameUnit, scale: number): [number, number] {
  const minD = 4.5 / scale;
  const minW = 7 / scale;
  return [Math.max(u.w, minW), Math.max(u.d, minD)];
}

/** Distance in metres from a point to a unit's drawn footprint. */
export function pickDist(u: FrameUnit, x: number, y: number, scale: number): number {
  if (u.status === 'rout') return Math.max(0, Math.hypot(x - u.x, y - u.y) - Math.max(14, Math.max(u.w, u.d) * 0.45));
  const [w, d] = drawnSize(u, scale);
  const c = Math.cos(u.f);
  const s = Math.sin(u.f);
  const dx = x - u.x;
  const dy = y - u.y;
  const fw = Math.max(Math.abs(dx * c + dy * s) - d / 2, 0);
  const sd = Math.max(Math.abs(-dx * s + dy * c) - w / 2, 0);
  return Math.hypot(fw, sd);
}

let smokeCanvas: HTMLCanvasElement | null = null;
let smokeKey = '';

function drawSmoke(ctx: CanvasRenderingContext2D, f: NonNullable<Frame['smoke']>): void {
  const key = `${f.key}:${f.cols}x${f.rows}:${f.frame.length}`;
  if (!smokeCanvas || smokeKey !== key) {
    smokeCanvas ??= document.createElement('canvas');
    smokeCanvas.width = f.cols;
    smokeCanvas.height = f.rows;
    const g = smokeCanvas.getContext('2d')!;
    const img = g.createImageData(f.cols, f.rows);
    for (let i = 0; i < f.cols * f.rows; i++) {
      const v = f.frame.charCodeAt(i) - 48;
      // a grey wash: white smoke would not show against the paper
      img.data[i * 4] = 104;
      img.data[i * 4 + 1] = 110;
      img.data[i * 4 + 2] = 108;
      img.data[i * 4 + 3] = v > 0 ? Math.min(185, 34 + v * 19) : 0;
    }
    g.putImageData(img, 0, 0);
    smokeKey = key;
  }
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(smokeCanvas, 0, 0, f.cols * f.cell, f.rows * f.cell);
  ctx.restore();
}

function drawUnit(ctx: CanvasRenderingContext2D, u: FrameUnit, cam: Camera, sel: boolean, hl: boolean, t: number): void {
  const col = C.side[u.side] ?? C.ink;
  const px = 1 / cam.scale;
  if (u.status === 'gone') {
    if (u.arm === 'art') {
      // abandoned guns
      ctx.save();
      ctx.translate(u.x, u.y);
      ctx.rotate(u.f + Math.PI / 2);
      ctx.strokeStyle = 'rgba(32,40,43,0.7)';
      ctx.lineWidth = 2.2 * px;
      for (let k = -1; k <= 1; k++) {
        ctx.beginPath();
        ctx.moveTo(k * 9 * px, 5 * px);
        ctx.lineTo(k * 9 * px + k * 3 * px, -5 * px);
        ctx.stroke();
      }
      ctx.restore();
    }
    return;
  }
  if (u.status === 'rout') {
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.72;
    const n = Math.max(4, Math.round(14 * (u.men / u.startMen)));
    const h = strHash(u.id);
    const R = Math.max(10 * px, Math.min(34, Math.max(u.w, u.d) * 0.5));
    for (let i = 0; i < n; i++) {
      const a = i * 2.4 + (h % 7);
      const q = R * (0.25 + ((i * 7 + (h % 13)) % 15) / 20) + Math.sin(t * 0.9 + i) * 1.2 * px;
      ctx.beginPath();
      ctx.arc(u.x + Math.cos(a) * q, u.y + Math.sin(a) * q * 0.8, Math.max(1.6 * px, 1.4), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (sel || hl) ring(ctx, u, cam, sel);
    return;
  }
  const [w, d] = drawnSize(u, cam.scale);
  ctx.save();
  ctx.translate(u.x, u.y);
  ctx.rotate(u.f + Math.PI / 2); // local -y is the unit's front
  if (u.forming) ctx.setLineDash([4 * px, 3 * px]);
  ctx.lineWidth = 1.3 * px;
  ctx.strokeStyle = col;
  ctx.fillStyle = C.paper;
  if (u.arm === 'inf') {
    if (u.form === 'square') {
      const lw = Math.min(w * 0.28, Math.max(2.4 * px, w * 0.2));
      ctx.fillRect(-w / 2, -d / 2, w, d);
      ctx.lineWidth = lw;
      ctx.strokeRect(-w / 2 + lw / 2, -d / 2 + lw / 2, w - lw, d - lw);
    } else {
      ctx.fillStyle = col;
      ctx.fillRect(-w / 2, -d / 2, w, d);
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 0.9 * px;
      ctx.strokeRect(-w / 2, -d / 2, w, d);
      // a short tick shows which way the battalion faces
      ctx.setLineDash([]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.4 * px;
      ctx.beginPath();
      ctx.moveTo(0, -d / 2);
      ctx.lineTo(0, -d / 2 - 4 * px);
      ctx.stroke();
    }
  } else if (u.arm === 'cav') {
    ctx.fillRect(-w / 2, -d / 2, w, d);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-w / 2, d / 2);
    ctx.lineTo(w / 2, -d / 2);
    ctx.lineTo(w / 2, d / 2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeRect(-w / 2, -d / 2, w, d);
    if (u.blown) {
      // blown: a hollow ring on the block
      ctx.setLineDash([]);
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 1.2 * px;
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(w, Math.max(d, 6 * px)) * 0.3, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 0.6 * px;
      ctx.stroke();
    }
  } else {
    const guns = 6;
    const live = Math.max(1, Math.ceil(guns * (u.men / u.startMen)));
    const dd = Math.max(d, 8 * px);
    ctx.lineWidth = Math.max(2.2 * px, 2.4);
    for (let i = 0; i < live; i++) {
      const x = -w / 2 + ((i + 0.5) * w) / guns;
      ctx.beginPath();
      ctx.moveTo(x, dd / 2);
      ctx.lineTo(x, -dd / 2);
      ctx.stroke();
      ctx.fillStyle = col;
      ctx.fillRect(x - Math.min(5, w / 14), dd * 0.12, Math.min(10, w / 7), Math.max(1.6 * px, 1.6));
    }
  }
  ctx.restore();
  // morale bar, in screen terms, just below the footprint at the unit's centre
  const sf = Math.abs(Math.sin(u.f));
  const cf = Math.abs(Math.cos(u.f));
  const ext = Math.min(sf > 1e-6 ? d / 2 / sf : Infinity, cf > 1e-6 ? w / 2 / cf : Infinity);
  const bw = 24 * px;
  const by = u.y + ext + 4 * px;
  const m = Math.max(0, Math.min(100, u.morale)) / 100;
  ctx.fillStyle = 'rgba(32,40,43,0.3)';
  ctx.fillRect(u.x - bw / 2, by, bw, 3 * px);
  ctx.fillStyle = u.morale >= 65 ? C.good : u.morale >= 40 ? C.warn : C.crit;
  ctx.fillRect(u.x - bw / 2, by, bw * m, 3 * px);
  if (u.manual) {
    ctx.fillStyle = C.brass;
    ctx.beginPath();
    ctx.arc(u.x + bw / 2 + 5 * px, by + 1.5 * px, 2.6 * px, 0, TAU);
    ctx.fill();
  }
  if (u.melee) {
    // crossed strokes: hand to hand
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.3 * px;
    const r = 4 * px;
    ctx.beginPath();
    ctx.moveTo(u.x - bw / 2 - 9 * px - r, by - r + 1.5 * px);
    ctx.lineTo(u.x - bw / 2 - 9 * px + r, by + r + 1.5 * px);
    ctx.moveTo(u.x - bw / 2 - 9 * px + r, by - r + 1.5 * px);
    ctx.lineTo(u.x - bw / 2 - 9 * px - r, by + r + 1.5 * px);
    ctx.stroke();
  }
  if (sel || hl) ring(ctx, u, cam, sel);
}

function ring(ctx: CanvasRenderingContext2D, u: FrameUnit, cam: Camera, sel: boolean): void {
  const px = 1 / cam.scale;
  const [w, d] = drawnSize(u, cam.scale);
  ctx.save();
  ctx.strokeStyle = C.brass;
  ctx.lineWidth = (sel ? 2.4 : 1.8) * px;
  if (!sel) ctx.setLineDash([5 * px, 4 * px]);
  ctx.beginPath();
  ctx.arc(u.x, u.y, Math.max(w, d) / 2 + 9 * px, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

type Box = [number, number, number, number];

/** A name tag above the unit, nudged upward until it clears the tags already placed. */
function label(ctx: CanvasRenderingContext2D, u: FrameUnit, cam: Camera, text: string, placed: Box[]): void {
  const px = 1 / cam.scale;
  const [w, d] = drawnSize(u, cam.scale);
  let y = u.y - Math.min(Math.max(w, d) / 2, 40 * px) - 16 * px;
  ctx.save();
  ctx.font = `${13 * px}px "IM Fell English",Georgia,serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width + 10 * px;
  for (let tries = 0; tries < 12; tries++) {
    const hit = placed.some(([bx, by, bw, bh]) => Math.abs(bx - u.x) < (bw + tw) / 2 && Math.abs(by - y) < (bh + 18 * px) / 2);
    if (!hit) break;
    y -= 19 * px;
  }
  placed.push([u.x, y, tw, 18 * px]);
  ctx.fillStyle = 'rgba(227,229,214,0.92)';
  ctx.fillRect(u.x - tw / 2, y - 9 * px, tw, 18 * px);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 0.8 * px;
  ctx.strokeRect(u.x - tw / 2, y - 9 * px, tw, 18 * px);
  ctx.fillStyle = C.ink;
  ctx.fillText(text, u.x, y + 0.5 * px);
  ctx.restore();
}

function drawFx(ctx: CanvasRenderingContext2D, e: SimEvent, frame: Frame, cam: Camera, life: number): void {
  const u = frame.byId.get(e.unit ?? '');
  if (!u) return;
  const age = (frame.t - e.t) / life;
  if (age < 0 || age > 1) return;
  const a = 1 - age;
  const px = 1 / cam.scale;
  const [w, d] = drawnSize(u, cam.scale);
  const tg = frame.byId.get(String(e.target ?? ''));
  // direction of fire: toward the target if known, else the unit's front
  const dir = tg ? Math.atan2(tg.y - u.y, tg.x - u.x) : u.f;
  const c = Math.cos(dir);
  const s = Math.sin(dir);
  const fc = Math.cos(u.f);
  const fs = Math.sin(u.f);
  if (e.kind === 'musket') {
    ctx.fillStyle = `rgba(250,250,244,${0.62 * a})`;
    const n = Math.max(3, Math.min(14, Math.round(w / 12)));
    const sq = u.form === 'square';
    for (let i = 0; i < n; i++) {
      const lat = ((i + 0.5) / n) * w - w / 2;
      const fwd = d / 2 + 3 * px + age * 14 + ((i * 37) % 5);
      // puffs along the firing face
      const bx = sq ? u.x + c * fwd - s * lat : u.x + fc * fwd - fs * lat;
      const by = sq ? u.y + s * fwd + c * lat : u.y + fs * fwd + fc * lat;
      ctx.beginPath();
      ctx.arc(bx, by, 2.2 * px + 3 + age * 7 + (i % 3), 0, TAU);
      ctx.fill();
    }
  } else {
    const can = e.kind === 'canister';
    if (age < 0.22 && tg) {
      ctx.strokeStyle = can ? `rgba(200,120,30,${0.75 * (1 - age * 4)})` : `rgba(32,40,43,${0.6 * (1 - age * 4)})`;
      ctx.lineWidth = (can ? 0.8 : 1.2) * px;
      const mx = u.x + c * (d / 2 + 6);
      const my = u.y + s * (d / 2 + 6);
      if (!can) {
        ctx.beginPath();
        ctx.moveTo(mx, my);
        ctx.lineTo(tg.x, tg.y);
        ctx.stroke();
      } else {
        const R = Math.hypot(tg.x - u.x, tg.y - u.y);
        for (let i = -2; i <= 2; i++) {
          ctx.beginPath();
          ctx.moveTo(mx, my);
          ctx.lineTo(tg.x - s * i * R * 0.05, tg.y + c * i * R * 0.05);
          ctx.stroke();
        }
      }
    }
    ctx.fillStyle = `rgba(250,250,244,${0.7 * a})`;
    for (let i = -1; i <= 1; i++) {
      const lat = (i * w) / 3;
      ctx.beginPath();
      ctx.arc(u.x + c * (d / 2 + 8 + age * 22) - s * lat, u.y + s * (d / 2 + 8 + age * 22) + c * lat, 4 * px + 4 + age * 12, 0, TAU);
      ctx.fill();
    }
  }
}

/** A close-up of the ground rendered for one exact camera position; used instead of the overview image while it still fits. */
export interface Detail {
  canvas: HTMLCanvasElement;
  scale: number;
  ox: number;
  oy: number;
}

export function draw(ctx: CanvasRenderingContext2D, cssW: number, cssH: number, dpr: number, cam: Camera, ground: HTMLCanvasElement | null, mapW: number, mapH: number, frame: Frame | null, opt: DrawOptions, detail: Detail | null = null): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.baize;
  ctx.fillRect(0, 0, cssW, cssH);
  if (!ground) return;
  ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.ox, dpr * cam.oy);
  const px = 1 / cam.scale;
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur = 14 * dpr;
  ctx.fillStyle = C.paper;
  ctx.fillRect(0, 0, mapW, mapH);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'transparent';
  ctx.imageSmoothingQuality = 'high';
  if (detail && detail.scale === cam.scale && detail.ox === cam.ox && detail.oy === cam.oy) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(detail.canvas, 0, 0);
    ctx.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.ox, dpr * cam.oy);
  } else ctx.drawImage(ground, 0, 0, mapW, mapH);
  if (frame) {
    if (frame.smoke) drawSmoke(ctx, frame.smoke);
    // where units broke, up to now
    ctx.lineWidth = 1.3 * px;
    for (const e of opt.routMarks) {
      if (e.x === undefined || e.y === undefined) continue;
      ctx.strokeStyle = e.side === 0 ? 'rgba(31,63,140,0.55)' : 'rgba(168,38,43,0.55)';
      const r = 4 * px;
      ctx.beginPath();
      ctx.moveTo(e.x - r, e.y - r);
      ctx.lineTo(e.x + r, e.y + r);
      ctx.moveTo(e.x + r, e.y - r);
      ctx.lineTo(e.x - r, e.y + r);
      ctx.stroke();
    }
    // command: radius, link to superior, marker
    if (frame.commanders.length) {
      const pos = new Map(frame.commanders.map((c) => [c.id, c]));
      for (const c of frame.commanders) {
        const col = C.side[c.side] ?? C.ink;
        if (c.alive && c.radius > 0) {
          // brigade radii matter most on the field; the wider circles of higher commanders are kept faint
          const a = c.level === 'brigade' ? 0.3 : 0.13;
          ctx.strokeStyle = c.side === 0 ? `rgba(31,63,140,${a})` : `rgba(168,38,43,${a})`;
          ctx.lineWidth = 1 * px;
          ctx.setLineDash([6 * px, 5 * px]);
          ctx.beginPath();
          ctx.arc(c.x, c.y, c.radius, 0, TAU);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const p = c.parent ? pos.get(c.parent) : undefined;
        if (p) {
          ctx.strokeStyle = c.side === 0 ? 'rgba(31,63,140,0.35)' : 'rgba(168,38,43,0.35)';
          ctx.lineWidth = 0.8 * px;
          ctx.beginPath();
          ctx.moveTo(c.x, c.y);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        }
        const r = (c.level === 'army' ? 7 : c.level === 'corps' ? 6 : c.level === 'division' ? 5 : 4) * px;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y - r);
        ctx.lineTo(c.x + r, c.y);
        ctx.lineTo(c.x, c.y + r);
        ctx.lineTo(c.x - r, c.y);
        ctx.closePath();
        ctx.fillStyle = c.alive ? col : C.paper;
        ctx.fill();
        ctx.strokeStyle = c.alive ? C.paper : col;
        ctx.lineWidth = 1.2 * px;
        ctx.stroke();
        // a small pennon marks the staff
        ctx.strokeStyle = col;
        ctx.lineWidth = 1 * px;
        ctx.beginPath();
        ctx.moveTo(c.x, c.y - r);
        ctx.lineTo(c.x, c.y - r - 7 * px);
        ctx.lineTo(c.x + 5 * px, c.y - r - 5 * px);
        ctx.lineTo(c.x, c.y - r - 3 * px);
        ctx.stroke();
      }
    }
    for (let i = 0; i + 2 < frame.couriers.length; i += 3) {
      ctx.fillStyle = C.side[frame.couriers[i + 2]] ?? C.ink;
      ctx.beginPath();
      ctx.arc(frame.couriers[i], frame.couriers[i + 1], 2.4 * px, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 0.8 * px;
      ctx.stroke();
    }
    // skirmish screens: a thin row of dots about 150 m ahead of the parent battalion
    for (const u of frame.units) {
      if (u.status !== 'ok' || !u.skirm) continue;
      const c = Math.cos(u.f);
      const s = Math.sin(u.f);
      const n = Math.max(4, Math.min(16, Math.round(u.skirm / 10)));
      const span = Math.max(u.w * 1.25, 60);
      ctx.fillStyle = C.side[u.side] ?? C.ink;
      ctx.globalAlpha = 0.85;
      const h = strHash(u.id);
      for (let i = 0; i < n; i++) {
        const lat = (i / (n - 1) - 0.5) * span;
        const fwd = 150 + (((h >> (i % 16)) & 3) - 1.5) * 7; // an irregular line, as skirmishers keep
        ctx.beginPath();
        ctx.arc(u.x + c * fwd - s * lat, u.y + s * fwd + c * lat, Math.max(1.3 * px, 1.6), 0, TAU);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    for (const u of frame.units) if (u.status !== 'ok') drawUnit(ctx, u, cam, u.id === opt.selected, opt.highlight.has(u.id), frame.t);
    for (const u of frame.units) if (u.status === 'ok') drawUnit(ctx, u, cam, u.id === opt.selected, opt.highlight.has(u.id), frame.t);
    for (const e of opt.fx) drawFx(ctx, e, frame, cam, 6);
    const sel = opt.selected ? frame.byId.get(opt.selected) : undefined;
    if (sel && sel.status !== 'gone') {
      if (opt.showOrders && sel.orderX !== undefined && sel.orderY !== undefined) {
        ctx.strokeStyle = C.brass;
        ctx.setLineDash([6 * px, 4 * px]);
        ctx.lineWidth = 1.6 * px;
        ctx.beginPath();
        ctx.moveTo(sel.x, sel.y);
        ctx.lineTo(sel.orderX, sel.orderY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = C.brass;
        ctx.beginPath();
        ctx.arc(sel.orderX, sel.orderY, 4 * px, 0, TAU);
        ctx.fill();
      }
    }
    const placed: Box[] = [];
    if (sel && sel.status !== 'gone') label(ctx, sel, cam, sel.name, placed);
    for (const u of frame.units) if (u.status !== 'gone' && u.id !== opt.selected && opt.highlight.has(u.id)) label(ctx, u, cam, u.name, placed);
  }
  // overlays in screen space: scale bar and north arrow
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const target = 120 / cam.scale;
  let bar = 50;
  for (const b of [50, 100, 200, 250, 500, 1000, 2000]) if (b <= target) bar = b;
  const bw = bar * cam.scale;
  const sx = 14;
  const sy = cssH - 16;
  ctx.fillStyle = 'rgba(227,229,214,0.9)';
  ctx.fillRect(sx - 8, sy - 20, bw + 58, 30);
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = i % 2 ? C.paper : C.ink;
    ctx.fillRect(sx + (i * bw) / 4, sy - 2, bw / 4, 5);
    ctx.strokeRect(sx + (i * bw) / 4 + 0.5, sy - 2 + 0.5, bw / 4, 5);
  }
  ctx.fillStyle = C.ink;
  ctx.font = '12px "IM Fell English",Georgia,serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('0', sx - 2, sy - 6);
  ctx.fillText(`${bar} m`, sx + bw - 6, sy - 6);
  ctx.save();
  ctx.translate(26, 34);
  ctx.fillStyle = 'rgba(227,229,214,0.9)';
  ctx.beginPath();
  ctx.arc(0, 4, 24, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = C.ink;
  ctx.fillStyle = C.ink;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, 14);
  ctx.lineTo(0, -8);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -16);
  ctx.lineTo(-5, -4);
  ctx.lineTo(0, -7);
  ctx.lineTo(5, -4);
  ctx.closePath();
  ctx.fill();
  ctx.font = '11px "IM Fell English SC",Georgia,serif';
  ctx.textAlign = 'center';
  ctx.fillText('N', 0, 25);
  ctx.restore();
}
