// App shell: tabs, the shared map view, the replay player and the live run.
import { FEATURE_KEYS, applyInput, buildMap, createRecorder, createSim, recordRun, resolveData, step } from '@napoleon/engine';
import type { Data, Formation, GameMap, Posture, RawData, Recorder, Replay, Scenario, Sim, SimEvent } from '@napoleon/engine';
import { paintGround, paintInto } from './ground.ts';
import { Inspector } from './inspector.ts';
import type { InspectorHost } from './inspector.ts';
import { EventIndex, frameFromReplay, frameFromSim, upperBound } from './model.ts';
import type { Frame, FrameUnit } from './model.ts';
import { draw, pickDist } from './render.ts';
import type { Camera, Detail } from './render.ts';
import { BIG, ROUTINE, desnake, sentence } from './text.ts';
import { $, clock, download, el, fmt } from './util.ts';
import { Editor } from './editor.ts';
import { EditorPanel } from './editor-panel.ts';

// ------------------------------------------------------------------ data and scenarios

const rawFiles = import.meta.glob('../../../data/*.json', { eager: true }) as Record<string, { default: unknown }>;
const raw: RawData = {};
for (const [path, mod] of Object.entries(rawFiles)) raw[path.split('/').pop()!.replace(/\.json$/, '')] = mod.default;
const data: Data = resolveData(raw).data;

const scenarioFiles = import.meta.glob('../../../scenarios/*.json', { eager: true }) as Record<string, { default: Scenario }>;
const scenarios = Object.entries(scenarioFiles)
  .map(([path, mod]) => ({ key: path.split('/').pop()!.replace(/\.json$/, ''), sc: mod.default }))
  .filter((s) => s.sc && s.sc.format === 'napsim-scenario')
  .sort((a, b) => a.sc.name.localeCompare(b.sc.name));
const scenarioByKey = (k: string): Scenario => structuredClone(scenarios.find((s) => s.key === k)?.sc ?? scenarios[0].sc);

const POSTURES: [Posture, string][] = [
  ['defend', 'Defend'],
  ['attack_line', 'Attack in line'],
  ['attack_column', 'Attack in column'],
];
const FEATURE_LABEL: Record<string, string> = { commandControl: 'Command and control', fatigue: 'Fatigue', ammunition: 'Ammunition', skirmishers: 'Skirmishers', quality: 'Unit quality', elevationLos: 'Line of sight', smoke: 'Smoke', weatherGround: 'Weather and ground' };
const SPEEDS = [1, 4, 16, 60];

// ------------------------------------------------------------------ state

type Mode = 'replay' | 'live' | 'editor';
interface Live {
  sim: Sim;
  rec: Recorder;
  scenario: Scenario;
  started: boolean;
  done: boolean;
  acc: number;
}

let mode: Mode = 'replay';
let fileRep: Replay | null = null;
let liveRep: Replay | null = null;
let live: Live | null = null;
const time: Record<'replay' | 'live', number> = { replay: 0, live: 0 };
let playing = false;
let speed = 16;
let sel: string | null = null;
let highlight = new Set<string>();
const idx = new EventIndex();

let view: { key: string; scenario: Scenario; map: GameMap; ground: HTMLCanvasElement; ppm: number } | null = null;
let detail: Detail | null = null;
let camSig = '';
let camStill = 0;
const cam: Camera = { scale: 1, ox: 0, oy: 0 };
let camFitted = true;

const cv = $<HTMLCanvasElement>('map');
const ctx = cv.getContext('2d')!;
const mapbox = $('mapbox');
const inspector = new Inspector($('inspector'));
let cssW = 300;
let cssH = 300;
let dpr = 1;

const slot = (): 'replay' | 'live' => (mode === 'live' ? 'live' : 'replay');
const liveActive = (): boolean => mode === 'live' && !!live && !live.done;
/** The recording behind the timeline, inspector and log in the current tab. */
const cur = (): Replay | null => (mode === 'live' ? liveRep : mode === 'replay' ? fileRep : fileRep ?? liveRep);
const endTime = (): number => {
  const r = cur();
  return r && r.times.length ? r.times[r.times.length - 1] : 0;
};
const now = (): number => (liveActive() ? live!.sim.t : time[slot()]);

// ------------------------------------------------------------------ map view

function setView(scenario: Scenario, keepCam = false): void {
  const key = JSON.stringify(scenario.map);
  if (view && view.key === key) {
    view.scenario = scenario;
    return;
  }
  const map = buildMap(scenario.map, data);
  const ppm = Math.min(2.4, 3400 / Math.max(map.width, map.height));
  const sameSize = !!view && view.map.width === map.width && view.map.height === map.height;
  view = { key, scenario, map, ground: paintGround(scenario, map, ppm), ppm };
  detail = null;
  if (keepCam && sameSize) return;
  layout();
  fit();
}

function layout(): void {
  const col = mapbox.parentElement!.getBoundingClientRect().width;
  const ar = view ? view.map.height / view.map.width : 1.3;
  const maxH = Math.max(320, window.innerHeight * 0.8);
  let w = col;
  let h = Math.min(w * ar, maxH);
  if (h < w * ar && col > 700) w = Math.max(h / ar, Math.min(col, 560)); // keep the paper snug on wide columns
  mapbox.style.width = Math.round(w) + 'px';
  mapbox.style.height = Math.round(h) + 'px';
  dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cssW = Math.round(w);
  cssH = Math.round(h);
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
  }
  if (camFitted) fit();
}

function fit(): void {
  if (!view) return;
  cam.scale = Math.min(cssW / view.map.width, cssH / view.map.height) * 0.985;
  cam.ox = (cssW - view.map.width * cam.scale) / 2;
  cam.oy = (cssH - view.map.height * cam.scale) / 2;
  camFitted = true;
}

function zoomAt(px: number, py: number, k: number): void {
  if (!view) return;
  const min = Math.min(cssW / view.map.width, cssH / view.map.height) * 0.6;
  const ns = Math.max(min, Math.min(6, cam.scale * k));
  const wx = (px - cam.ox) / cam.scale;
  const wy = (py - cam.oy) / cam.scale;
  cam.scale = ns;
  cam.ox = px - wx * ns;
  cam.oy = py - wy * ns;
  camFitted = false;
}

// ------------------------------------------------------------------ loading replays

function isReplay(o: unknown): o is Replay {
  const r = o as Replay;
  return !!r && r.format === 'napsim-replay' && Array.isArray(r.times) && !!r.tracks && !!r.scenario;
}

function loadReplay(r: Replay, label: string): void {
  fileRep = r;
  time.replay = 0;
  playing = false;
  sel = null;
  highlight = new Set();
  if (mode !== 'replay') setMode('replay');
  setView(r.scenario);
  $('replay-info').textContent = `${label}: ${r.scenario.name}, seed ${r.seed}, ${r.times.length} samples, ${fmt(r.events.length)} events (engine ${r.engineVersion}, data ${r.dataHash}).`;
  syncUi(true);
}

async function loadReplayText(text: string, label: string): Promise<void> {
  try {
    const o = JSON.parse(text);
    if (!isReplay(o)) throw new Error('not a napsim replay file');
    loadReplay(o, label);
  } catch (e) {
    $('replay-info').textContent = `Could not open ${label}: ${e instanceof Error ? e.message : e}`;
  }
}

$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await loadReplayText(await f.text(), f.name);
});
mapbox.addEventListener('dragover', (e) => {
  e.preventDefault();
  mapbox.classList.add('drop');
});
mapbox.addEventListener('dragleave', () => mapbox.classList.remove('drop'));
mapbox.addEventListener('drop', async (e) => {
  e.preventDefault();
  mapbox.classList.remove('drop');
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  const text = await f.text();
  if (mode === 'editor') {
    try {
      const o = JSON.parse(text);
      const sc: Scenario | undefined = o?.format === 'napsim-replay' ? o.scenario : o;
      if (sc && sc.format === 'napsim-scenario' && sc.map) {
        editor.load(sc, `Opened ${f.name}.`);
        return;
      }
    } catch {
      /* fall through to the replay loader's message */
    }
  }
  await loadReplayText(text, f.name);
});

$('rec-go').addEventListener('click', () => {
  const key = $<HTMLSelectElement>('rec-scenario').value;
  const seed = Number($<HTMLInputElement>('rec-seed').value) | 0;
  $('rec-status').textContent = 'Running…';
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const r = recordRun(scenarioByKey(key), data, seed);
      loadReplay(r, 'Recorded here');
      $('rec-status').textContent = `Done in ${Math.round(performance.now() - t0)} ms.`;
    } catch (e) {
      $('rec-status').textContent = e instanceof Error ? e.message : String(e);
    }
  }, 20);
});

// ------------------------------------------------------------------ live run

function liveScenario(): Scenario {
  const sc = scenarioByKey($<HTMLSelectElement>('live-scenario').value);
  sc.sides[0].posture = $<HTMLSelectElement>('live-post0').value as Posture;
  sc.sides[1].posture = $<HTMLSelectElement>('live-post1').value as Posture;
  const f: Record<string, boolean> = {};
  for (const k of FEATURE_KEYS) f[k] = $<HTMLInputElement>('feat-' + k).checked;
  sc.features = f;
  return sc;
}

/** Build a fresh sim from the Live panel's settings, drawn up and waiting. */
function prepareLive(): void {
  const sc = liveScenario();
  try {
    const sim = createSim(sc, data, Number($<HTMLInputElement>('live-seed').value) | 0, { events: 'full' });
    live = { sim, rec: createRecorder(sim, 5), scenario: sc, started: false, done: false, acc: 0 };
    liveRep = live.rec.finish(sim);
    time.live = 0;
    playing = false;
    sel = null;
    highlight = new Set();
    setView(sc);
    $('live-status').textContent = 'Drawn up and waiting. Both sides run from their orders; you may step in, but you never have to.';
  } catch (e) {
    live = null;
    liveRep = null;
    $('live-status').textContent = e instanceof Error ? e.message : String(e);
  }
  syncUi(true);
}

function syncLiveSettings(): void {
  // posture selects follow the chosen scenario
  const sc = scenarioByKey($<HTMLSelectElement>('live-scenario').value);
  $<HTMLSelectElement>('live-post0').value = sc.sides[0].posture;
  $<HTMLSelectElement>('live-post1').value = sc.sides[1].posture;
  $('live-post0-label').textContent = sc.sides[0].name;
  $('live-post1-label').textContent = sc.sides[1].name;
  for (const k of FEATURE_KEYS) $<HTMLInputElement>('feat-' + k).checked = !!sc.features?.[k];
}

function finishLive(): void {
  if (!live) return;
  live.done = true;
  liveRep = live.rec.finish(live.sim);
  time.live = live.sim.t;
  playing = false;
  $('live-status').textContent = 'The run is over and recorded. Scrub the timeline, inspect any unit, or save the replay.';
  syncUi(true);
}

function advanceLive(ticks: number): void {
  if (!live || live.done) return;
  live.started = true;
  for (let i = 0; i < ticks && !live.sim.ended; i++) {
    step(live.sim);
    live.rec.sample(live.sim);
  }
  if (live.sim.ended) finishLive();
}

$('live-start').addEventListener('click', () => {
  if (!live || live.started) prepareLive();
  if (live) {
    live.started = true;
    playing = true;
    cv.focus({ preventScroll: true });
  }
  syncUi(true);
});
$('live-save').addEventListener('click', () => {
  if (!live) return;
  const r = live.done && liveRep ? liveRep : live.rec.finish(live.sim);
  download(`${r.scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-seed${r.seed}.replay.json`, JSON.stringify(r));
});
for (const id of ['live-scenario', 'live-seed']) $(id).addEventListener('change', () => {
  if (id === 'live-scenario') syncLiveSettings();
  prepareLive();
});
for (const i of [0, 1]) $('live-post' + i).addEventListener('change', (e) => {
  const p = (e.target as HTMLSelectElement).value as Posture;
  if (live && live.started && !live.done) applyInput(live.sim, { kind: 'posture', side: live.sim.sides[i].id, posture: p });
  else prepareLive();
});

function order(input: Parameters<typeof applyInput>[1]): void {
  if (!live || live.done) return;
  applyInput(live.sim, input);
  syncUi(true);
}
for (const f of ['line', 'column', 'square'] as Formation[]) $('o-' + f).addEventListener('click', () => sel && order({ kind: 'unit_formation', unit: sel, formation: f }));
$('o-halt').addEventListener('click', () => sel && order({ kind: 'unit_order', unit: sel, order: { type: 'halt' } }));
$('o-release').addEventListener('click', () => sel && order({ kind: 'unit_release', unit: sel }));

// ------------------------------------------------------------------ tabs and transport

function setMode(m: Mode): void {
  if (mode === m) return;
  playing = false;
  mode = m;
  sel = null;
  highlight = new Set();
  for (const k of ['replay', 'live', 'editor'] as Mode[]) {
    $('tab-' + k).setAttribute('aria-selected', String(k === m));
    $('panel-' + k).hidden = k !== m;
  }
  document.body.classList.toggle('mode-editor', m === 'editor');
  cv.style.cursor = '';
  if (m === 'editor') editor.activate();
  else editor.deactivate();
  if (m === 'live') {
    if (!live) prepareLive();
    else setView(live.scenario);
  } else if (m === 'replay' && fileRep) setView(fileRep.scenario);
  if (m !== 'editor') $('hint').textContent = '';
  syncUi(true);
}
for (const k of ['replay', 'live', 'editor'] as Mode[]) $('tab-' + k).addEventListener('click', () => setMode(k));

function togglePlay(): void {
  if (mode === 'live' && live && !live.done) {
    live.started = true;
    playing = !playing;
  } else if (cur()) {
    if (!playing && time[slot()] >= endTime() - 0.01) time[slot()] = 0;
    playing = !playing;
  }
  syncUi(true);
}
function stepBy(dir: number): void {
  if (liveActive()) {
    if (dir > 0) {
      playing = false;
      advanceLive(5);
    }
  } else if (cur()) {
    playing = false;
    const si = cur()!.sampleInterval || 5;
    time[slot()] = Math.max(0, Math.min(endTime(), Math.round((time[slot()] + dir * si) / si) * si));
  }
  syncUi(true);
}
function seek(t: number): void {
  if (liveActive() || !cur()) return;
  time[slot()] = Math.max(0, Math.min(endTime(), t));
}
$('play').addEventListener('click', togglePlay);
$('step-back').addEventListener('click', () => stepBy(-1));
$('step-fwd').addEventListener('click', () => stepBy(1));
const scrub = $<HTMLInputElement>('scrub');
scrub.addEventListener('input', () => {
  playing = false;
  seek(Number(scrub.value));
  syncUi(false);
});
for (const s of SPEEDS) {
  const b = el('button', { class: 'btn', type: 'button' }, `${s}×`);
  b.id = 'sp' + s;
  b.setAttribute('aria-label', `Speed ${s} times`);
  b.addEventListener('click', () => {
    speed = s;
    syncUi(true);
  });
  $('speeds').append(b);
}
$('zoom-in').addEventListener('click', () => zoomAt(cssW / 2, cssH / 2, 1.4));
$('zoom-out').addEventListener('click', () => zoomAt(cssW / 2, cssH / 2, 1 / 1.4));
$('zoom-fit').addEventListener('click', fit);

// ------------------------------------------------------------------ pointer and keyboard

const pointers = new Map<number, { x: number; y: number }>();
let dragStart: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
let pinch: { d: number } | null = null;
const local = (e: PointerEvent | WheelEvent) => {
  const r = cv.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};
const world = (p: { x: number; y: number }) => ({ x: (p.x - cam.ox) / cam.scale, y: (p.y - cam.oy) / cam.scale });
let edDrag = false;

cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  const p = local(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 1) {
    if (mode === 'editor') {
      const w = world(p);
      if (editor.pointerDown(w.x, w.y, e)) {
        edDrag = true;
        dragStart = null;
        return;
      }
    }
    dragStart = { x: p.x, y: p.y, ox: cam.ox, oy: cam.oy, moved: false };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
    if (dragStart) dragStart.moved = true;
  }
});
cv.addEventListener('pointermove', (e) => {
  if (mode === 'editor') {
    const w = world(local(e));
    if (edDrag) {
      editor.pointerMove(w.x, w.y, e);
      return;
    }
    editor.setHover(w.x, w.y);
  }
  if (!pointers.has(e.pointerId)) return;
  const p = local(e);
  pointers.set(e.pointerId, p);
  if (pointers.size === 2 && pinch) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch.d > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d);
    pinch.d = d;
  } else if (dragStart && pointers.size === 1) {
    const dx = p.x - dragStart.x;
    const dy = p.y - dragStart.y;
    if (!dragStart.moved && Math.hypot(dx, dy) > 5) {
      dragStart.moved = true;
      cv.classList.add('dragging');
    }
    if (dragStart.moved) {
      cam.ox = dragStart.ox + dx;
      cam.oy = dragStart.oy + dy;
      camFitted = false;
    }
  }
});
const pointerEnd = (e: PointerEvent) => {
  if (edDrag) {
    pointers.delete(e.pointerId);
    edDrag = false;
    const w = world(local(e));
    editor.pointerUp(w.x, w.y);
    return;
  }
  const had = pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (had && pointers.size === 0 && dragStart) {
    if (!dragStart.moved && e.type === 'pointerup') {
      if (mode === 'editor') {
        const w = world(dragStart);
        editor.click(w.x, w.y, e);
      } else click(dragStart.x, dragStart.y, e.shiftKey);
    }
    dragStart = null;
    cv.classList.remove('dragging');
  }
};
cv.addEventListener('pointerup', pointerEnd);
cv.addEventListener('pointercancel', pointerEnd);
cv.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
  },
  { passive: false },
);

let lastFrame: Frame | null = null;

function pick(px: number, py: number): FrameUnit | null {
  if (!lastFrame) return null;
  const wx = (px - cam.ox) / cam.scale;
  const wy = (py - cam.oy) / cam.scale;
  let best: FrameUnit | null = null;
  let bd = 10 / cam.scale;
  for (const u of lastFrame.units) {
    if (u.status === 'gone') continue;
    const d = pickDist(u, wx, wy, cam.scale) + (u.status === 'rout' ? 2 / cam.scale : 0);
    if (d < bd) {
      bd = d;
      best = u;
    }
  }
  return best;
}

function click(px: number, py: number, shift: boolean): void {
  const hit = pick(px, py);
  const selU = sel && lastFrame ? lastFrame.byId.get(sel) : undefined;
  if (liveActive() && live!.started && selU && selU.status === 'ok' && !shift) {
    if (hit && hit.side !== selU.side) {
      order({ kind: 'unit_order', unit: selU.id, order: { type: 'attack', target: hit.id } });
      return;
    }
    if (!hit && view) {
      const m = 30;
      const x = Math.max(m, Math.min(view.map.width - m, (px - cam.ox) / cam.scale));
      const y = Math.max(m, Math.min(view.map.height - m, (py - cam.oy) / cam.scale));
      order({ kind: 'unit_order', unit: selU.id, order: { type: 'move', x, y } });
      return;
    }
  }
  sel = hit ? (hit.id === sel ? null : hit.id) : null;
  syncUi(true);
}

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range' && (e.target as HTMLInputElement).type !== 'checkbox') return;
  if (tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (mode === 'editor') {
    if (editor.key(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === ' ' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Escape') return; // the transport keys mean nothing here
  }
  if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'LABEL') {
    e.preventDefault();
    togglePlay();
  } else if (e.key === 'ArrowRight' && tag !== 'INPUT') {
    e.preventDefault();
    stepBy(1);
  } else if (e.key === 'ArrowLeft' && tag !== 'INPUT') {
    e.preventDefault();
    stepBy(-1);
  } else if (e.key === 'Escape') {
    sel = null;
    syncUi(true);
  } else if (e.key === 'f' || e.key === 'F') fit();
  else if (e.key === '+' || e.key === '=') zoomAt(cssW / 2, cssH / 2, 1.3);
  else if (e.key === '-') zoomAt(cssW / 2, cssH / 2, 1 / 1.3);
});

// ------------------------------------------------------------------ readouts

let logSig = '';
let marksSig = '';
let lastUi = 0;

const namer = () => {
  const r = cur();
  const byId = new Map((r?.units ?? []).map((u) => [u.id, u]));
  return {
    name: (id: unknown) => (typeof id === 'string' ? byId.get(id)?.name ?? id : ''),
    arm: (id: unknown) => (typeof id === 'string' ? byId.get(id)?.arm ?? '' : ''),
    sideName: (i: number) => r?.scenario.sides[i]?.name ?? (i ? 'Red' : 'Blue'),
  };
};

function updateLog(r: Replay | null, t: number): void {
  const ol = $('log');
  const only = $<HTMLInputElement>('log-filter').checked && sel;
  const n = r ? upperBound(r.events, t) : 0;
  const sig = `${mode}|${n}|${only ? sel : ''}|${r ? r.seed + r.scenario.name : ''}`;
  if (sig === logSig) return;
  logSig = sig;
  ol.textContent = '';
  if (!r) return;
  const nm = namer();
  let shown = 0;
  for (let i = n - 1; i >= 0 && shown < 60; i--) {
    const e = r.events[i];
    if (only && e.unit !== sel && e.target !== sel && e.from !== sel) continue;
    if (!only && ROUTINE.has(e.type)) continue; // routine evolutions crowd out the news
    const s = sentence(e, nm);
    if (!s) continue;
    const li = el('li', { class: BIG.has(e.type) ? 'big' : '' }, el('time', {}, clock(e.t)), el('b', { class: e.side === 0 ? 's0' : e.side === 1 ? 's1' : 'sn' }), el('span', {}, s));
    li.tabIndex = 0;
    const act = () => {
      if (e.unit) sel = e.unit;
      playing = false;
      seek(e.t);
      syncUi(true);
    };
    li.addEventListener('click', act);
    li.addEventListener('keydown', (k) => {
      if (k.key === 'Enter') act();
    });
    ol.append(li);
    shown++;
  }
  if (!shown) ol.append(el('li', { class: 'empty-row' }, only ? 'Nothing yet for this unit.' : 'The armies are drawn up. Nothing to report.'));
}

function drawMarks(r: Replay | null, end: number): void {
  const mc = $<HTMLCanvasElement>('marks');
  const w = Math.round(mc.getBoundingClientRect().width);
  const sig = `${w}|${idx.marks.length}|${Math.round(end)}|${r ? r.seed : ''}`;
  if (sig === marksSig) return;
  marksSig = sig;
  const d = Math.min(2, window.devicePixelRatio || 1);
  mc.width = w * d;
  mc.height = 14 * d;
  const g = mc.getContext('2d')!;
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, w, 14);
  if (!r || end <= 0) return;
  const pad = 8; // range thumbs do not reach the very ends
  for (const e of idx.marks) {
    const x = pad + (e.t / end) * (w - 2 * pad);
    if (e.type === 'army_broken') {
      g.fillStyle = '#c8a04a';
      g.fillRect(x - 1.5, 0, 3, 14);
    } else if (e.type === 'rally') {
      g.fillStyle = '#8fbf8f';
      g.fillRect(x - 0.5, 8, 1.5, 6);
    } else {
      g.fillStyle = e.side === 0 ? '#5f83d6' : '#d2575b';
      g.fillRect(x - 0.75, e.side === 0 ? 1 : 5, 1.5, 8);
    }
  }
}

function resultText(r: Replay): string {
  const res = r.result;
  const loser = res.sides.find((s) => s.broke && res.winner !== s.id);
  const head = res.endReason === 'mutual_break' ? 'Both armies break' : loser ? `The ${loser.name} army breaks` : res.endReason === 'stalemate' ? 'Stalemate' : 'No decision';
  const sides = res.sides.map((s) => `${s.name}: ${fmt(s.casualties)} killed and wounded, ${fmt(s.captured)} prisoners, ${fmt(s.dispersed)} dispersed of ${fmt(s.startMen)}`).join('. ');
  return `${head}|${res.winner === 'draw' ? '' : `${res.sides.find((s) => s.id === res.winner)?.name} victory in ${clock(res.duration)}. `}${sides}.`;
}

function syncUi(force: boolean): void {
  const ts = performance.now();
  if (!force && ts - lastUi < 120) return;
  lastUi = ts;
  if (mode === 'editor') {
    $('empty').hidden = true;
    return;
  }
  const t = now();
  const active = liveActive();
  if (active && live) liveRep = live.rec.finish(live.sim); // a live view of the recording so far
  const rr = cur();
  if (rr) idx.sync(rr.events);
  const end = active ? Math.max(1, live!.sim.t) : endTime();
  const f = lastFrame;
  const sc = view?.scenario;
  $('empty').hidden = !!(rr || (mode === 'live' && live));
  for (const i of [0, 1]) {
    $(`side${i}-name`).textContent = sc?.sides[i]?.name ?? (i ? 'Red' : 'Blue');
    let men = 0,
      up = 0,
      tot = 0,
      start = 0;
    if (f) for (const u of f.units) if (u.side === i) {
      tot++;
      start += u.startMen;
      if (u.status === 'ok') {
        men += u.men;
        up++;
      }
    }
    $('hud' + i).textContent = f ? `${fmt(men)} of ${fmt(start)} men formed · ${up}/${tot} units` : ' ';
    $('bar' + i).style.width = (tot ? Math.round((100 * up) / tot) : 100) + '%';
  }
  $('clock').textContent = clock(t);
  $('clock-sub').textContent = rr ? (active ? `${rr.scenario.name} · seed ${rr.seed} · live` : `of ${clock(end)} · ${rr.scenario.name} · seed ${rr.seed}`) : ' ';
  const res = $('result');
  const atEnd = !!rr && !active && rr.times.length > 1 && t >= end - 0.5 && !!rr.result && rr.result.endReason !== '';
  if (atEnd) {
    const [head, body] = resultText(rr!).split('|');
    res.replaceChildren(el('strong', {}, head), body);
  }
  res.hidden = !atEnd;

  scrub.max = String(Math.max(1, Math.round(end)));
  if (document.activeElement !== scrub || playing) scrub.value = String(Math.round(Math.min(t, end)));
  scrub.disabled = active || !rr;
  $('play').textContent = playing ? 'Pause' : active && !live!.started ? 'Begin' : 'Play';
  ($('play') as HTMLButtonElement).disabled = !rr && !(mode === 'live' && live);
  ($('step-back') as HTMLButtonElement).disabled = active || !rr;
  ($('step-fwd') as HTMLButtonElement).disabled = !rr && !active;
  for (const s of SPEEDS) $('sp' + s).setAttribute('aria-pressed', String(speed === s));
  drawMarks(rr, end);

  // live panel
  const running = !!live && live.started && !live.done;
  $('live-start').textContent = live && live.started ? 'Restart' : 'Start';
  ($('live-save') as HTMLButtonElement).disabled = !(live && live.started);
  for (const k of FEATURE_KEYS) $<HTMLInputElement>('feat-' + k).disabled = running;
  $<HTMLSelectElement>('live-scenario').disabled = running;
  $<HTMLInputElement>('live-seed').disabled = running;
  $('orders').hidden = !(mode === 'live' && running);
  if (mode === 'live' && running) {
    const u = sel && f ? f.byId.get(sel) : undefined;
    const ok = !!u && u.status === 'ok';
    $('orders-unit').textContent = ok ? `${u!.name}: ${u!.manual ? 'under your orders' : 'under staff orders'}.` : 'Select a formed unit on the map.';
    for (const fm of ['line', 'column', 'square']) {
      const b = $('o-' + fm) as HTMLButtonElement;
      b.disabled = !ok || u!.arm !== 'inf';
      b.setAttribute('aria-pressed', String(ok && u!.form === fm));
    }
    ($('o-halt') as HTMLButtonElement).disabled = !ok;
    ($('o-release') as HTMLButtonElement).disabled = !ok || !u!.manual;
    cv.classList.toggle('pick', ok);
    $('live-status').textContent = `Running. ${live!.sim.inputs.length ? live!.sim.inputs.length + ' intervention' + (live!.sim.inputs.length > 1 ? 's' : '') + ' recorded.' : 'No interventions: both sides are on their own orders.'}`;
  } else cv.classList.remove('pick');
  $('hint').textContent = mode === 'live' && running ? 'Drag to pan, scroll to zoom. Click a unit to select it; then click ground to march or an enemy to attack. Esc clears the selection.' : 'Drag to pan, scroll to zoom. Click a unit to inspect it. Space plays and pauses; arrow keys step.';

  // inspector and log
  const host: InspectorHost | null = rr
    ? {
        rep: rr,
        idx,
        t,
        go: (unit, tt) => {
          sel = unit;
          if (tt !== undefined) {
            playing = false;
            seek(tt);
          }
          syncUi(true);
        },
        setHighlight: (ids) => {
          highlight = ids;
        },
        typeLabel: (type) => (data.units[type]?.label as string | undefined) ?? desnake(type),
      }
    : null;
  inspector.update(host, sel);
  if (!sel) highlight = new Set();
  updateLog(rr, t);
}

// ------------------------------------------------------------------ editor

const NONE = new Set<string>();
const editor = new Editor({
  data,
  scenarios,
  cam,
  showScenario: (sc, keepCam) => setView(sc, keepCam),
  loadReplay: (r, label) => loadReplay(r, label),
  replayScenario: () => fileRep?.scenario ?? liveRep?.scenario ?? null,
});
new EditorPanel($('panel-editor'), editor);

// ------------------------------------------------------------------ frame loop

let lastTs = 0;
function frameLoop(ts: number): void {
  const dt = Math.min(0.1, (ts - lastTs) / 1000 || 0);
  lastTs = ts;
  if (liveActive() && live) {
    if (playing) {
      live.acc += dt * speed;
      const n = Math.min(Math.floor(live.acc), 240);
      live.acc -= Math.floor(live.acc);
      if (n > 0) advanceLive(n);
    }
  } else if (playing && cur()) {
    const s = slot();
    time[s] += dt * speed;
    if (time[s] >= endTime()) {
      time[s] = endTime();
      playing = false;
      syncUi(true);
    }
  }
  const inEditor = mode === 'editor';
  const rr = cur();
  const t = now();
  let frame: Frame | null = null;
  if (inEditor) frame = editor.frame();
  else if (liveActive() && live) frame = frameFromSim(live.sim, liveRep);
  else if (rr && rr.times.length) frame = frameFromReplay(rr, t);
  lastFrame = frame;
  let fx: SimEvent[] = [];
  let routMarks: SimEvent[] = [];
  const events = inEditor ? undefined : liveActive() && live ? live.sim.events : rr?.events;
  if (events && frame) {
    for (let i = upperBound(events, t) - 1; i >= 0 && events[i].t > t - 6; i--) if (events[i].type === 'fire') fx.push(events[i]);
    if (fx.length > 160) fx = fx.slice(0, 160);
    routMarks = idx.breaks.slice(0, upperBound(idx.breaks, t)).filter((e) => e.kind !== 'army_broken');
  }
  // When the view has been still for a moment and is closer than the overview image resolves,
  // redraw the ground crisply for exactly this camera.
  const sig = `${cam.scale}|${cam.ox}|${cam.oy}|${cssW}|${cssH}`;
  if (sig !== camSig) {
    camSig = sig;
    camStill = ts;
  } else if (view && ts - camStill > 220 && cam.scale * dpr > view.ppm * 1.1 && !(detail && detail.scale === cam.scale && detail.ox === cam.ox && detail.oy === cam.oy && detail.canvas.width === cv.width)) {
    const c = detail?.canvas ?? document.createElement('canvas');
    c.width = cv.width;
    c.height = cv.height;
    const g = c.getContext('2d')!;
    g.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * cam.ox, dpr * cam.oy);
    paintInto(g, view.scenario, view.map);
    detail = { canvas: c, scale: cam.scale, ox: cam.ox, oy: cam.oy };
  }
  if (inEditor) {
    draw(ctx, cssW, cssH, dpr, cam, view?.ground ?? null, view?.map.width ?? 1, view?.map.height ?? 1, frame, { selected: editor.selectedUnit(), highlight: NONE, fx, routMarks, showOrders: false }, detail);
    editor.drawOverlay(ctx, cam, dpr, cssW);
    cv.style.cursor = editor.cursor();
    const h = editor.hint();
    if ($('hint').textContent !== h) $('hint').textContent = h;
  } else draw(ctx, cssW, cssH, dpr, cam, view?.ground ?? null, view?.map.width ?? 1, view?.map.height ?? 1, frame, { selected: sel, highlight, fx, routMarks, showOrders: liveActive() }, detail);
  syncUi(false);
  requestAnimationFrame(frameLoop);
}

// ------------------------------------------------------------------ start-up

function fill(select: HTMLSelectElement, opts: [string, string][]): void {
  for (const [v, t] of opts) select.append(el('option', { value: v }, t));
}
fill($<HTMLSelectElement>('rec-scenario'), scenarios.map((s) => [s.key, s.sc.name]));
fill($<HTMLSelectElement>('live-scenario'), scenarios.map((s) => [s.key, s.sc.name]));
fill($<HTMLSelectElement>('live-post0'), POSTURES);
fill($<HTMLSelectElement>('live-post1'), POSTURES);
for (const k of FEATURE_KEYS) {
  const cb = el('input', { type: 'checkbox', id: 'feat-' + k });
  cb.addEventListener('change', () => {
    if (!(live && live.started && !live.done)) prepareLive();
  });
  $('live-features').append(el('label', { class: 'check' }, cb, el('span', {}, FEATURE_LABEL[k] ?? k)));
}
const preferred = scenarios.find((s) => s.key === 'pitched')?.key ?? scenarios[0]?.key;
if (preferred) {
  $<HTMLSelectElement>('rec-scenario').value = preferred;
  $<HTMLSelectElement>('live-scenario').value = preferred;
}
syncLiveSettings();
$('log-filter').addEventListener('change', () => syncUi(true));
window.addEventListener('resize', () => {
  layout();
  marksSig = '';
});
if (scenarios.length) setView(scenarios.find((s) => s.key === preferred)!.sc);
layout();
if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    // lettering on the paper was drawn with the fallback face; redo it now the period face is in
    if (view) {
      const sc = view.scenario;
      view = null;
      setView(sc);
    }
  });
}
const q = new URLSearchParams(location.search);
const url = q.get('replay');
if (url) {
  $('replay-info').textContent = 'Loading…';
  fetch(url)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((txt) => loadReplayText(txt, url.split('/').pop() || 'replay'))
    .catch((e) => ($('replay-info').textContent = `Could not load ${url}: ${e instanceof Error ? e.message : e}`));
}
if (q.get('mode') === 'live') setMode('live');
if (q.get('mode') === 'editor') setMode('editor');
syncUi(true);
requestAnimationFrame(frameLoop);
