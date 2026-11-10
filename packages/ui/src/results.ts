// The Results tab: open a batch folder written by `napsim batch --out` (or run a batch here),
// and read it: win rates against the swept setting, loss and timing distributions, where units
// broke, losses by formation, and every run, each of which can be re-run as a replay.

import { applyOverrides, batchFiles, buildMap, dataHash, expandUnits, makeJobs, parseAxis, recordRun, setDims, summarisePoint, sweepPoints } from '@napoleon/engine';
import type { Data, GameMap, Job, JobResult, Override, Replay, RunResult, Scenario, SweepAxis, Unit } from '@napoleon/engine';
import { paintGround } from './ground.ts';
import { RC, card, dataTable, f1, fmtVal, histogram, lineChart, makeTip, pct, pctRange } from './results-charts.ts';
import type { Card } from './results-charts.ts';
import { bins, breakTimes, buildBatchView, causeRanking, decidedSplit, durationDist, findPoint, formationRows, lossDist, niceWidth, pointOverrides, winRates } from './results-model.ts';
import type { BatchView, FormationRow, InFile, PointView, RunRow, Val } from './results-model.ts';
import { clock, download, el, fmt } from './util.ts';
import { desnake } from './text.ts';

export interface ResultsHost {
  data: Data;
  scenarios: { key: string; sc: Scenario }[];
  editorScenario(): Scenario | null;
  openReplay(r: Replay, label: string, note: string): void;
}

const FILES = ['runs.csv', 'routs.csv', 'units.csv', 'summary.csv', 'summary.json'];
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const minutes = (s: number): string => (s === s ? `${f1(s / 60)} min` : '–');

const TEMPLATES: [string, string][] = [
  ['', 'Common settings…'],
  ['data:weapons.guns.field_8pdr.canisterBattlefieldFactor=0.025,0.05,0.1,0.2', 'Canister effect'],
  ['data:weapons.muskets.brown_bess.battlefieldFactor=0.02,0.04,0.08', 'British musketry effect'],
  ['data:weapons.muskets.charleville_1777.battlefieldFactor=0.02,0.04,0.08', 'French musketry effect'],
  ['data:morale.casualtyShock=1,2,3,4', 'Morale lost per casualty'],
  ['data:morale.rippleFriend=0,7,14', 'Shock when a friend routs'],
  ['data:melee.blownTime=60,300,900', 'Time cavalry stays blown'],
  ['scenario:features.commandControl=false,true', 'Command and control on/off'],
  ['scenario:features.fatigue=false,true', 'Fatigue on/off'],
  ['scenario:features.ammunition=false,true', 'Ammunition on/off'],
  ['scenario:features.skirmishers=false,true', 'Skirmishers on/off'],
  ['scenario:features.quality=false,true', 'Unit quality on/off'],
  ['scenario:features.elevationLos=false,true', 'Line of sight on/off'],
  ['scenario:features.smoke=false,true', 'Smoke on/off'],
  ['scenario:features.weatherGround=false,true', 'Weather and ground on/off'],
];

interface Running {
  workers: Worker[];
  cancelled: boolean;
}

export class ResultsView {
  view: BatchView | null = null;
  private sel: Record<string, Val> = {};
  private xAxis = '';
  private mapSide = 0;
  private causesOff = new Set<string>();
  private includeArmy = false;
  private tFrom = 0;
  private tTo = Infinity;
  private selectedSeed: number | null = null;
  private runSort: { key: string; dir: number } = { key: 'seed', dir: 1 };
  private formSort: { key: string; dir: number } = { key: '', dir: 1 };
  private expanded = new Set<string>();
  private cards: Card[] = [];
  private mapDraw: ((w: number) => void) | null = null;
  private mapW = 0;
  private groundCache: { key: string; map: GameMap; img: HTMLCanvasElement } | null = null;
  private running: Running | null = null;
  private lastFiles: Record<string, string> | null = null;
  private active = false;
  private ro: ResizeObserver;
  private info: HTMLElement;
  private runStatus: HTMLElement;
  private progress: HTMLProgressElement;
  private dl: HTMLElement;
  private bundledHash: string;

  constructor(private host: ResultsHost, private main: HTMLElement, private panel: HTMLElement) {
    this.bundledHash = dataHash(host.data);
    this.info = el('div', { class: 'res-info muted' }, 'Nothing loaded yet.');
    this.runStatus = el('span', { class: 'muted' });
    this.progress = el('progress', { max: 1, value: 0, class: 'res-progress' });
    this.progress.hidden = true;
    this.dl = el('div', { class: 'row' });
    this.dl.hidden = true;
    this.buildPanel();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(main);
    this.renderMain();
  }

  activate(): void {
    this.active = true;
    this.resize();
  }
  deactivate(): void {
    this.active = false;
  }

  // ---------------------------------------------------------------- the side panel: sources

  private buildPanel(): void {
    const dir = el('input', { type: 'file', multiple: true, id: 'res-dir', class: 'visually-hidden' });
    dir.setAttribute('webkitdirectory', '');
    const files = el('input', { type: 'file', multiple: true, id: 'res-files', accept: '.csv,.json,text/csv,application/json', class: 'visually-hidden' });
    const onPick = async (inp: HTMLInputElement) => {
      if (inp.files?.length) await this.openFiles([...inp.files]);
      inp.value = '';
    };
    dir.addEventListener('change', () => onPick(dir));
    files.addEventListener('change', () => onPick(files));
    for (const target of [this.main, this.panel]) {
      target.addEventListener('dragover', (e) => {
        e.preventDefault();
        target.classList.add('drop');
      });
      target.addEventListener('dragleave', () => target.classList.remove('drop'));
      target.addEventListener('drop', async (e) => {
        e.preventDefault();
        target.classList.remove('drop');
        const fl = e.dataTransfer?.files;
        if (fl?.length) await this.openFiles([...fl]);
      });
    }

    // run a batch here
    const scSel = el('select', { id: 'res-scenario' });
    const refreshScenarios = () => {
      const keep = scSel.value;
      scSel.replaceChildren(...this.host.scenarios.map((s) => el('option', { value: s.key }, s.sc.name)));
      if (this.host.editorScenario()) scSel.append(el('option', { value: '@editor' }, "Editor's working copy"));
      scSel.value = [...scSel.options].some((o) => o.value === keep) ? keep : this.host.scenarios.find((s) => s.key === 'column')?.key ?? this.host.scenarios[0]?.key ?? '';
    };
    refreshScenarios();
    scSel.addEventListener('focus', refreshScenarios);
    const runs = el('input', { type: 'number', id: 'res-runs', value: '50', min: '1', step: '1' });
    const seed0 = el('input', { type: 'number', id: 'res-seed0', value: '1', step: '1' });
    const params: HTMLInputElement[] = [];
    const paramRows: HTMLElement[] = [];
    for (const i of [1, 2]) {
      const inp = el('input', { type: 'text', id: `res-param${i}`, placeholder: 'none (or data:path=v1,v2,…)', spellcheck: false });
      inp.setAttribute('aria-label', `Sweep parameter ${i}`);
      const tpl = el('select', { id: `res-tpl${i}` });
      tpl.setAttribute('aria-label', `Fill parameter ${i} from a list`);
      const fillTemplates = () => {
        const sc = this.chosenScenario(scSel.value);
        const opts: [string, string][] = [...TEMPLATES];
        for (const s of sc?.sides ?? []) if (s.deploy) for (const [arm, label] of [['inf', 'battalions'], ['cav', 'squadrons'], ['art', 'batteries']] as const) opts.push([`scenario:sides.${s.id}.deploy.${arm}=${arm === 'art' ? '0..6..2' : arm === 'cav' ? '0..8..2' : '2..10..2'}`, `${s.name} ${label}`]);
        tpl.replaceChildren(...opts.map(([v, t]) => el('option', { value: v }, t)));
      };
      fillTemplates();
      scSel.addEventListener('change', fillTemplates);
      tpl.addEventListener('change', () => {
        if (tpl.value) inp.value = tpl.value;
        tpl.value = '';
      });
      params.push(inp);
      paramRows.push(el('label', { htmlFor: `res-param${i}` }, `Sweep ${i}`), el('div', { class: 'res-param' }, tpl, inp));
    }
    const start = el('button', { class: 'btn primary', type: 'button', id: 'res-start' }, 'Run');
    const cancel = el('button', { class: 'btn', type: 'button', id: 'res-cancel', disabled: true }, 'Cancel');
    start.addEventListener('click', () => this.runHere(scSel.value, Number(runs.value), Number(seed0.value), params.map((p) => p.value.trim()).filter(Boolean), start, cancel));
    cancel.addEventListener('click', () => this.cancelRun());

    this.panel.replaceChildren(
      el('h2', {}, 'Results'),
      el('p', { class: 'muted res-lead' }, 'Open the folder that napsim batch or sweep wrote with --out, or run a batch here.'),
      el('div', { class: 'row' }, el('label', { class: 'btn', htmlFor: 'res-dir' }, 'Open a batch folder…'), dir, el('label', { class: 'btn', htmlFor: 'res-files' }, 'Choose files…'), files),
      this.info,
      el('h3', {}, 'Run a batch here'),
      el('div', { class: 'grid2' }, el('label', { htmlFor: 'res-scenario' }, 'Scenario'), scSel, el('label', { htmlFor: 'res-runs' }, 'Runs'), runs, el('label', { htmlFor: 'res-seed0' }, 'First seed'), seed0, ...paramRows),
      el('div', { class: 'row' }, start, cancel, this.runStatus),
      this.progress,
      this.dl,
      el('p', { class: 'muted' }, 'Runs here use the same engine and give the same results as the command line for the same seeds. Large batches are quicker from the command line.'),
    );
  }

  private chosenScenario(key: string): Scenario | null {
    if (key === '@editor') return this.host.editorScenario();
    return this.host.scenarios.find((s) => s.key === key)?.sc ?? null;
  }

  private setInfo(parts: (string | HTMLElement)[], warn: string[] = []): void {
    this.info.replaceChildren(...parts.map((p) => (typeof p === 'string' ? el('div', {}, p) : p)), ...warn.map((w) => el('div', { class: 'res-warn' }, w)));
  }

  async openFiles(list: File[]): Promise<void> {
    try {
      const runsFiles = list.filter((f) => f.name === 'runs.csv');
      const rel = (f: File) => ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
      const dirOf = (f: File) => rel(f).split('/').slice(0, -1).join('/');
      if (!runsFiles.length) throw new Error('no runs.csv here: open the folder that napsim batch or sweep wrote with --out');
      if (runsFiles.length > 1) throw new Error(`this folder holds ${runsFiles.length} batches (${runsFiles.map((f) => dirOf(f) || '.').join(', ')}): open one of them`);
      const dir = dirOf(runsFiles[0]);
      const pick = list.filter((f) => FILES.includes(f.name) && dirOf(f) === dir);
      const files: InFile[] = await Promise.all(pick.map(async (f) => ({ name: f.name, text: await f.text() })));
      this.load(buildBatchView(files, this.host.scenarios, dir.split('/').pop() || 'batch'), null);
    } catch (e) {
      this.setInfo([], [`Could not open these results: ${e instanceof Error ? e.message : e}`]);
    }
  }

  private load(v: BatchView, files: Record<string, string> | null): void {
    this.view = v;
    this.lastFiles = files;
    this.dl.hidden = !files;
    this.sel = {};
    for (const a of v.axes) this.sel[a.key] = a.values[0];
    this.xAxis = v.axes.find((a) => a.values.length > 1)?.key ?? '';
    this.mapSide = 0;
    this.causesOff.clear();
    this.selectedSeed = null;
    this.expanded.clear();
    this.tFrom = 0;
    this.tTo = Infinity;
    const nRuns = v.points.reduce((a, p) => a + p.runs.length, 0);
    const s = v.summary;
    const warn: string[] = [];
    if (s && s.dataHash && s.dataHash !== this.bundledHash) warn.push(`The data files have changed since this batch was run (data ${s.dataHash}, now ${this.bundledHash}); replays of its runs may not match.`);
    this.setInfo(
      [
        `${v.label}: ${v.scenario?.name ?? s?.scenario ?? 'unknown scenario'}`,
        `${v.points.length} point${v.points.length === 1 ? '' : 's'} × ${fmt(v.points[0]?.runs.length ?? 0)} runs (${fmt(nRuns)} in all)${s ? `, seeds from ${s.seeds.first}` : ''}`,
        `Files: ${v.files.join(', ')}`,
        ...(s ? [`Engine ${s.engineVersion}, data ${s.dataHash}`] : []),
        ...v.notes,
      ],
      warn,
    );
    this.renderMain();
  }

  // ---------------------------------------------------------------- running a batch in the browser

  private async runHere(key: string, runs: number, seed0: number, specs: string[], start: HTMLButtonElement, cancel: HTMLButtonElement): Promise<void> {
    if (this.running) return;
    const sc = this.chosenScenario(key);
    let axes: SweepAxis[];
    let points: Override[][];
    try {
      if (!sc) throw new Error('choose a scenario');
      if (!Number.isInteger(runs) || runs < 1) throw new Error('runs must be a whole number of at least 1');
      if (!Number.isInteger(seed0)) throw new Error('the first seed must be a whole number');
      axes = specs.map(parseAxis);
      points = sweepPoints(axes);
      for (const p of points) applyOverrides(clone(this.host.data), clone(sc), p); // fail early on a bad path
    } catch (e) {
      this.runStatus.textContent = `Cannot run: ${e instanceof Error ? e.message : e}`;
      this.runStatus.classList.add('res-warn');
      return;
    }
    this.runStatus.classList.remove('res-warn');
    const scenario = clone(sc!);
    const data = this.host.data;
    const seeds = Array.from({ length: runs }, (_, i) => seed0 + i);
    const nWorkers = Math.min(8, Math.max(1, (navigator.hardwareConcurrency || 2) - 1));
    const jobs: Job[] = makeJobs(points, seeds, nWorkers);
    const results: RunResult[][] = points.map(() => []);
    const violations: string[] = [];
    const total = points.length * runs;
    let done = 0;
    const t0 = performance.now();
    const run: Running = { workers: [], cancelled: false };
    this.running = run;
    start.disabled = true;
    cancel.disabled = false;
    this.progress.hidden = false;
    this.progress.max = total;
    this.progress.value = 0;
    const tick = () => (this.runStatus.textContent = `${fmt(done)} of ${fmt(total)} runs · ${f1((performance.now() - t0) / 1000)} s`);
    tick();
    let next = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(nWorkers, jobs.length) }, () =>
          new Promise<void>((resolve, reject) => {
            const w = new Worker(new URL('./batch-worker.ts', import.meta.url), { type: 'module' });
            run.workers.push(w);
            w.postMessage({ init: { data, scenario } });
            const feed = () => {
              if (run.cancelled) return resolve();
              if (next < jobs.length) w.postMessage(jobs[next++]);
              else {
                w.terminate();
                resolve();
              }
            };
            w.onmessage = (e: MessageEvent) => {
              const m = e.data as JobResult & { error?: string };
              if (m.error) return reject(new Error(m.error));
              results[m.point].push(...m.results);
              violations.push(...m.violations);
              done += m.results.length;
              this.progress.value = done;
              tick();
              feed();
            };
            w.onerror = (e) => reject(new Error(e.message || 'a worker failed to start'));
            feed();
          }),
        ),
      );
    } catch (e) {
      this.cancelRun();
      this.runStatus.textContent = `The batch failed: ${e instanceof Error ? e.message : e}`;
      this.runStatus.classList.add('res-warn');
    }
    start.disabled = false;
    cancel.disabled = true;
    this.progress.hidden = true;
    const cancelled = run.cancelled;
    this.running = null;
    if (cancelled || done < total) {
      if (cancelled) this.runStatus.textContent = `Cancelled after ${fmt(done)} of ${fmt(total)} runs.`;
      return;
    }
    // the same path as the command line: summarise, write the files, read them back
    for (const rs of results) rs.sort((a, b) => a.seed - b.seed);
    const summaries = results.map((rs, p) => summarisePoint(p, Object.fromEntries(points[p].map((o) => [o.path, o.value])), rs));
    const fileName = key === '@editor' ? 'editor (working copy)' : `scenarios/${key}.json`;
    const files = batchFiles(fileName, scenario, data, axes!, [], points, results, summaries, seeds);
    const v = buildBatchView(
      Object.entries(files).map(([name, text]) => ({ name, text })),
      this.host.scenarios,
      `Run here (${scenario.name})`,
    );
    this.runStatus.textContent = `Done: ${fmt(total)} runs in ${f1((performance.now() - t0) / 1000)} s.${violations.length ? ` Conservation failed in ${violations.length} runs, e.g. ${violations[0]}.` : ''}`;
    this.dl.replaceChildren(
      el('span', { class: 'muted' }, 'Download:'),
      ...Object.keys(files).map((name) => {
        const b = el('button', { class: 'btn sm', type: 'button' }, name);
        b.addEventListener('click', () => download(name, files[name]));
        return b;
      }),
    );
    this.load(v, files);
  }

  private cancelRun(): void {
    if (!this.running) return;
    this.running.cancelled = true;
    for (const w of this.running.workers) w.terminate();
  }

  // ---------------------------------------------------------------- the main area

  private current(): PointView | null {
    const v = this.view;
    if (!v || !v.points.length) return null;
    return findPoint(v, this.sel) ?? v.points[0];
  }

  private resize(): void {
    if (!this.active) return;
    for (const c of this.cards) {
      const w = c.el.clientWidth - 24;
      if (w > 0 && Math.abs(w - c.lastW) > 4) c.draw(w);
    }
    if (this.mapDraw) {
      const w = this.main.querySelector<HTMLElement>('.res-map')?.clientWidth ?? 0;
      if (w > 0 && Math.abs(w - this.mapW) > 4) this.mapDraw(w);
    }
  }

  renderMain(): void {
    this.cards = [];
    this.mapDraw = null;
    this.mapW = 0;
    const v = this.view;
    const pt = this.current();
    if (!v || !pt) {
      this.main.replaceChildren(el('div', { class: 'res-empty' }, el('strong', {}, 'No results loaded'), el('span', {}, 'Open a batch folder written by napsim batch or sweep with --out, or run a batch from the panel.')));
      return;
    }
    const sections: HTMLElement[] = [this.filters(v), this.headline(v, pt)];
    const sweep = this.sweep(v);
    if (sweep) sections.push(sweep);
    sections.push(this.distributions(v, pt));
    sections.push(this.mapSection(v, pt));
    sections.push(this.formations(v, pt));
    sections.push(this.runsTable(v, pt));
    this.main.replaceChildren(...sections);
    // draw at the real widths now that the cards are in the page
    requestAnimationFrame(() => {
      for (const c of this.cards) {
        const w = c.el.clientWidth - 24;
        if (w > 0) c.draw(w);
      }
      if (this.mapDraw) {
        const w = this.main.querySelector<HTMLElement>('.res-map')?.clientWidth ?? 0;
        if (w > 0) this.mapDraw(w);
      }
    });
  }

  private filters(v: BatchView): HTMLElement {
    const row = el('div', { class: 'res-filters', role: 'group' });
    row.setAttribute('aria-label', 'Choose what to show');
    for (const a of v.axes) {
      if (a.values.length < 2) continue;
      const s = el('select', { id: `res-ax-${a.key}` });
      a.values.forEach((val, i) => s.append(el('option', { value: String(i) }, fmtVal(val))));
      s.value = String(a.values.findIndex((x) => x === this.sel[a.key]));
      s.addEventListener('change', () => {
        this.sel[a.key] = a.values[Number(s.value)];
        this.selectedSeed = null;
        this.renderMain();
      });
      row.append(el('label', { class: 'res-filter' }, el('span', {}, a.label), s));
    }
    const multi = v.axes.filter((a) => a.values.length > 1);
    if (multi.length > 1) {
      const s = el('select', { id: 'res-xaxis' });
      for (const a of multi) s.append(el('option', { value: a.key }, a.label));
      s.value = this.xAxis;
      s.addEventListener('change', () => {
        this.xAxis = s.value;
        this.renderMain();
      });
      row.append(el('label', { class: 'res-filter' }, el('span', {}, 'Across'), s));
    }
    const side = el('select', { id: 'res-side' });
    v.sides.forEach((sd, i) => side.append(el('option', { value: String(i) }, sd.name)));
    side.value = String(this.mapSide);
    side.addEventListener('change', () => {
      this.mapSide = Number(side.value);
      this.causesOff.clear();
      this.renderMain();
    });
    row.append(el('label', { class: 'res-filter' }, el('span', {}, 'Side on the map'), side));
    if (!row.querySelector('select[id^="res-ax-"]') && v.axes.length) {
      row.prepend(el('span', { class: 'res-fixed' }, v.axes.map((a) => `${a.label} = ${fmtVal(this.sel[a.key])}`).join(' · ')));
    }
    return row;
  }

  private headline(v: BatchView, pt: PointView): HTMLElement {
    const w = winRates(pt, v.sides);
    const tiles = el('div', { class: 'res-tiles' });
    w.sides.forEach((r, i) => {
      const sw = el('i', { class: 'res-key-rect' });
      sw.style.background = RC.side[i] ?? RC.other;
      tiles.append(el('div', { class: 'res-tile' }, el('div', { class: 'res-tile-label' }, sw, `${v.sides[i].name} win`), el('div', { class: 'res-tile-value' }, pct(r.rate)), el('div', { class: 'res-tile-sub' }, `${pctRange(r.lo, r.hi)} (95%), ${fmt(r.n)} runs`)));
    });
    if (w.draw.k > 0) tiles.append(el('div', { class: 'res-tile' }, el('div', { class: 'res-tile-label' }, 'No decision'), el('div', { class: 'res-tile-value' }, pct(w.draw.rate)), el('div', { class: 'res-tile-sub' }, `${pctRange(w.draw.lo, w.draw.hi)} (95%)`)));
    const d = durationDist(pt);
    tiles.append(el('div', { class: 'res-tile' }, el('div', { class: 'res-tile-label' }, 'Duration, median'), el('div', { class: 'res-tile-value' }, `${f1(d.median)} min`), el('div', { class: 'res-tile-sub' }, `10th–90th percentile ${f1(d.p10)}–${f1(d.p90)} min`)));
    const split = decidedSplit(pt);
    const shades: Record<string, string> = { army_broken: RC.ink, objective: RC.other, none: RC.grid };
    const bar = el('div', { class: 'res-seg' });
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', split.map((s) => `${s.label}: ${s.n} runs`).join('; '));
    for (const s of split) {
      const part = el('i');
      part.style.flex = String(s.n);
      part.style.background = shades[s.key];
      part.title = `${s.label}: ${s.n} runs`;
      bar.append(part);
    }
    const legend = el('div', { class: 'res-seg-legend' });
    for (const s of split) {
      const sw = el('i', { class: 'res-key-rect' });
      sw.style.background = shades[s.key];
      legend.append(el('span', {}, sw, `${s.label} `, el('b', {}, String(s.n))));
    }
    tiles.append(el('div', { class: 'res-tile res-tile-wide' }, el('div', { class: 'res-tile-label' }, 'How it was decided'), bar, legend));
    return tiles;
  }

  private sweep(v: BatchView): HTMLElement | null {
    const ax = v.axes.find((a) => a.key === this.xAxis);
    if (!ax || ax.values.length < 2) return null;
    const others = v.axes.filter((a) => a.key !== ax.key);
    const numeric = ax.values.every((x) => typeof x === 'number');
    const xs = numeric ? ax.values.slice().sort((a, b) => (a as number) - (b as number)) : ax.values.slice();
    const pts = xs.map((x) => findPoint(v, { ...this.sel, [ax.key]: x }));
    const selected = xs.findIndex((x) => x === this.sel[ax.key]);
    const fixedNote = others.length ? `Other settings held at ${others.map((a) => `${a.label} = ${fmtVal(this.sel[a.key])}`).join(', ')}. ` : '';
    const n = pts.find((p) => p)?.runs.length ?? 0;
    const xLabel = ax.label;
    const sideLegend = v.sides.map((s, i) => ({ color: RC.side[i] ?? RC.other, label: s.name, kind: 'line' as const }));
    const wins = pts.map((p) => (p ? winRates(p, v.sides) : null));
    const winSeries = v.sides.map((s, i) => ({ name: s.name, color: RC.side[i] ?? RC.other, pts: wins.map((w) => (w ? { y: w.sides[i].rate, lo: w.sides[i].lo, hi: w.sides[i].hi } : { y: NaN, lo: NaN, hi: NaN })) }));
    const losses = pts.map((p) => (p ? v.sides.map((_, i) => lossDist(p, i)) : null));
    const lossSeries = v.sides.map((s, i) => ({ name: s.name, color: RC.side[i] ?? RC.other, pts: losses.map((l) => (l ? { y: l[i].median, lo: l[i].p10, hi: l[i].p90 } : { y: NaN, lo: NaN, hi: NaN })) }));
    const durs = pts.map((p) => (p ? durationDist(p) : null));
    const durMax = Math.max(1, ...durs.map((d) => (d ? d.p90 : 0)));
    const durSeries = [{ name: 'Duration', color: RC.ink, pts: durs.map((d) => (d ? { y: d.median, lo: d.p10, hi: d.p90 } : { y: NaN, lo: NaN, hi: NaN })) }];
    const xCell = (i: number) => fmtVal(xs[i]);
    const c1 = card(
      'Win rate',
      `${fixedNote}${n} runs per point; the wash is the 95% interval.`,
      sideLegend,
      (box, w) => lineChart(box, w, { xs, xLabel, yDomain: [0, 1], yFmt: pct, intervalName: '95% interval', series: winSeries, selected }),
      () => dataTable([xLabel, ...v.sides.flatMap((s) => [`${s.name} win`, '95% interval'])], xs.map((_, i) => [xCell(i), ...v.sides.flatMap((_, k) => [pct(winSeries[k].pts[i].y), pctRange(winSeries[k].pts[i].lo, winSeries[k].pts[i].hi)])])),
    );
    const c2 = card(
      'Total loss',
      'Killed and wounded, prisoners and dispersed, as a share of starting strength: median, with the 10th–90th percentile as the wash.',
      sideLegend,
      (box, w) => lineChart(box, w, { xs, xLabel, yDomain: [0, 1], yFmt: pct, intervalName: '10th–90th percentile', series: lossSeries, selected }),
      () => dataTable([xLabel, ...v.sides.flatMap((s) => [`${s.name} median`, '10th–90th'])], xs.map((_, i) => [xCell(i), ...v.sides.flatMap((_, k) => [pct(lossSeries[k].pts[i].y), pctRange(lossSeries[k].pts[i].lo, lossSeries[k].pts[i].hi)])])),
    );
    const c3 = card(
      'Duration',
      'Minutes from the start to the end of the run: median, with the 10th–90th percentile as the wash.',
      [],
      (box, w) => lineChart(box, w, { xs, xLabel, yDomain: [0, durMax * 1.05], yFmt: (x) => `${Math.round(x)}`, intervalName: '10th–90th percentile, minutes', series: durSeries, selected }),
      () => dataTable([xLabel, 'Median, min', '10th–90th, min'], xs.map((_, i) => [xCell(i), f1(durSeries[0].pts[i].y), `${f1(durSeries[0].pts[i].lo)}–${f1(durSeries[0].pts[i].hi)}`])),
    );
    this.cards.push(c1, c2, c3);
    return el('section', { class: 'res-section' }, el('h3', {}, `Across ${ax.label}`), el('div', { class: 'res-grid' }, c1.el, c2.el, c3.el));
  }

  private distributions(v: BatchView, pt: PointView): HTMLElement {
    const lossBins = v.sides.map((_, i) => bins(pt.runs.map((r) => r.sides[i].lossFraction), 0, 1, 0.05));
    const lossMax = Math.max(1, ...lossBins.flat().map((b) => b.count));
    const cards: Card[] = v.sides.map((s, i) =>
      card(
        `${s.name} total loss`,
        `${pt.runs.length} runs; median ${pct(lossDist(pt, i).median)}.`,
        [],
        (box, w) => histogram(box, w, { bins: lossBins[i], color: RC.side[i] ?? RC.other, xFmt: pct, xLabel: 'share of starting strength lost', yMax: lossMax, noun: 'runs' }),
        () => dataTable(['Loss', 'Runs'], lossBins[i].map((b) => [`${pct(b.lo)}–${pct(b.hi)}`, b.count])),
      ),
    );
    const dur = pt.runs.map((r) => r.duration / 60);
    const dmin = Math.min(...dur);
    const dmax = Math.max(...dur);
    const dw = niceWidth(Math.max(1, dmax - dmin), 16);
    const dlo = Math.floor(dmin / dw) * dw;
    const durBins = bins(dur, dlo, Math.max(dlo + dw, Math.ceil((dmax + 1e-9) / dw) * dw), dw);
    cards.push(
      card(
        'Duration',
        `Minutes, ${pt.runs.length} runs.`,
        [],
        (box, w) => histogram(box, w, { bins: durBins, color: RC.ink, xFmt: (x) => String(Number(x.toPrecision(4))), xLabel: 'minutes', yMax: Math.max(...durBins.map((b) => b.count)), noun: 'runs' }),
        () => dataTable(['Minutes', 'Runs'], durBins.map((b) => [`${f1(b.lo)}–${f1(b.hi)}`, b.count])),
      ),
    );
    const bt = v.sides.map((_, i) => breakTimes(pt, i));
    const all = bt.flat();
    if (all.length) {
      const bmax = Math.max(...all);
      const bw = niceWidth(Math.max(1, bmax), 16);
      const bb = bt.map((ts) => bins(ts, 0, Math.max(bw, Math.ceil((bmax + 1e-9) / bw) * bw), bw));
      const bm = Math.max(1, ...bb.flat().map((b) => b.count));
      v.sides.forEach((s, i) => {
        cards.push(
          card(
            `When the ${s.name} army broke`,
            bt[i].length ? `Minutes from the start, in the ${bt[i].length} of ${pt.runs.length} runs where it broke.` : `It did not break in any of the ${pt.runs.length} runs.`,
            [],
            (box, w) => (bt[i].length ? histogram(box, w, { bins: bb[i], color: RC.side[i] ?? RC.other, xFmt: (x) => String(Number(x.toPrecision(4))), xLabel: 'minutes', yMax: bm, noun: 'runs' }) : box.append(el('p', { class: 'res-none' }, 'Never broke.'))),
            bt[i].length ? () => dataTable(['Minutes', 'Runs'], bb[i].map((b) => [`${f1(b.lo)}–${f1(b.hi)}`, b.count])) : undefined,
          ),
        );
      });
    }
    this.cards.push(...cards);
    return el('section', { class: 'res-section' }, el('h3', {}, `This point: ${this.pointLabel(v, pt)}`), el('div', { class: 'res-grid' }, ...cards.map((c) => c.el)));
  }

  private pointLabel(v: BatchView, pt: PointView): string {
    return v.axes.length ? v.axes.map((a) => `${a.label} = ${fmtVal(pt.params[a.key])}`).join(', ') : `${pt.runs.length} runs`;
  }

  // ---------------------------------------------------------------- where they broke

  private mapSection(v: BatchView, pt: PointView): HTMLElement {
    const sec = el('section', { class: 'res-section' }, el('h3', {}, 'Where they broke'));
    if (!v.has.routs || !v.scenario) {
      sec.append(el('p', { class: 'muted' }, !v.has.routs ? 'Needs routs.csv in the batch folder.' : 'Needs the scenario: summary.json from a recent napsim, or a batch of a bundled scenario.'));
      return sec;
    }
    const sideIdx = Math.min(this.mapSide, v.sides.length - 1);
    const side = v.sides[sideIdx];
    const ranking = causeRanking(pt, side.id);
    const colourOf = new Map<string, string>(ranking.slice(0, 3).map((c, i) => [c.cause, RC.cause[i]]));
    const col = (cause: string) => colourOf.get(cause || '(none)') ?? RC.other;
    const keyOf = (cause: string) => (colourOf.has(cause || '(none)') ? cause || '(none)' : '@other');
    const tMin = this.tFrom * 60;
    const tMax = this.tTo * 60;
    const shown = pt.routs.filter((r) => r.side === side.id && (this.includeArmy || r.kind !== 'army_broken') && r.t >= tMin && r.t <= tMax && !this.causesOff.has(keyOf(r.rootCause)));
    const tips = pt.runs.filter((r) => r.sides[sideIdx]?.broke && r.sides[sideIdx].breakX !== null).map((r) => ({ seed: r.seed, x: r.sides[sideIdx].breakX!, y: r.sides[sideIdx].breakY!, t: r.sides[sideIdx].brokeAt ?? NaN, unit: r.sides[sideIdx].tipUnit }));

    // controls: the legend is the cause filter
    const legend = el('div', { class: 'res-legend res-legend-toggle' });
    const entries: { key: string; label: string; color: string; n: number }[] = ranking.slice(0, 3).map((c) => ({ key: c.cause, label: desnake(c.cause), color: col(c.cause), n: c.n }));
    const otherN = ranking.slice(3).reduce((a, c) => a + c.n, 0);
    if (otherN) entries.push({ key: '@other', label: `Other (${ranking.slice(3).map((c) => desnake(c.cause)).join(', ')})`, color: RC.other, n: otherN });
    for (const e of entries) {
      const b = el('button', { type: 'button', class: 'res-legend-item' });
      b.setAttribute('aria-pressed', String(!this.causesOff.has(e.key)));
      const dot = el('i', { class: 'res-key-dot' });
      dot.style.background = e.color;
      b.append(dot, `${e.label} `, el('b', {}, String(e.n)));
      b.addEventListener('click', () => {
        if (this.causesOff.has(e.key)) this.causesOff.delete(e.key);
        else this.causesOff.add(e.key);
        this.renderMain();
      });
      legend.append(b);
    }
    if (tips.length) legend.append(el('span', { class: 'res-legend-item static' }, el('i', { class: 'res-key-tip' }), `Unit whose rout broke the army `, el('b', {}, String(tips.length))));
    const army = el('input', { type: 'checkbox', checked: this.includeArmy });
    army.addEventListener('change', () => {
      this.includeArmy = army.checked;
      this.renderMain();
    });
    const from = el('input', { type: 'number', min: '0', step: '1', value: String(this.tFrom), class: 'res-num' });
    const to = el('input', { type: 'number', min: '0', step: '1', value: this.tTo === Infinity ? '' : String(this.tTo), placeholder: 'end', class: 'res-num' });
    from.setAttribute('aria-label', 'From minute');
    to.setAttribute('aria-label', 'To minute');
    const onTime = () => {
      this.tFrom = Math.max(0, Number(from.value) || 0);
      this.tTo = to.value === '' ? Infinity : Math.max(this.tFrom, Number(to.value));
      this.renderMain();
    };
    from.addEventListener('change', onTime);
    to.addEventListener('change', onTime);
    const controls = el('div', { class: 'res-map-controls' }, el('label', { class: 'check' }, army, el('span', {}, 'Include units swept away when the army broke')), el('span', { class: 'res-time' }, 'Minutes', from, 'to', to));

    const box = el('div', { class: 'res-map' });
    const canvas = el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Map of ${v.scenario.name} with ${shown.length} routs of ${side.name} units marked. The runs table below lists the same runs.`);
    box.append(canvas);
    const tip = makeTip(box);
    const sc = v.scenario;
    const key = JSON.stringify(sc.map);
    if (!this.groundCache || this.groundCache.key !== key) {
      const map = buildMap(sc.map, this.host.data);
      const ppm = Math.min(2, 2200 / Math.max(map.width, map.height));
      this.groundCache = { key, map, img: paintGround(sc, map, ppm) };
    }
    const { map, img } = this.groundCache;
    let starts: { x: number; y: number; f: number; w: number; d: number }[] = [];
    try {
      starts = expandUnits(sc, this.host.data)
        .filter((u) => u.side === sideIdx)
        .map((u) => {
          const ut = this.host.data.units[u.type];
          const fake = { arm: ut.arm, ut, doc: ut.doctrine ? this.host.data.doctrine[ut.doctrine] : null, men: u.men, form: u.formation, status: 'ok', w: 0, d: 0 } as unknown as Unit;
          setDims(fake);
          return { x: u.x, y: u.y, f: u.facing, w: fake.w, d: fake.d };
        });
    } catch {
      starts = [];
    }
    let place: { s: number; ox: number; oy: number } = { s: 1, ox: 0, oy: 0 };
    this.mapDraw = (w: number) => {
      this.mapW = w;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const maxH = Math.max(300, window.innerHeight * 0.75);
      let cw = w;
      let ch = (cw * map.height) / map.width;
      if (ch > maxH) {
        ch = maxH;
        cw = (ch * map.width) / map.height;
      }
      canvas.style.width = `${Math.round(cw)}px`;
      canvas.style.height = `${Math.round(ch)}px`;
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      const g = canvas.getContext('2d')!;
      const s = cw / map.width;
      place = { s, ox: 0, oy: 0 };
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.drawImage(img, 0, 0, cw, ch);
      g.save();
      g.scale(s, s);
      const sideCol = RC.side[sideIdx] ?? RC.other;
      for (const u of starts) {
        g.save();
        g.translate(u.x, u.y);
        g.rotate(u.f);
        g.globalAlpha = 0.22;
        g.fillStyle = sideCol;
        g.fillRect(-u.d / 2, -u.w / 2, u.d, u.w);
        g.globalAlpha = 0.45;
        g.strokeStyle = sideCol;
        g.lineWidth = 1 / s;
        g.strokeRect(-u.d / 2, -u.w / 2, u.d, u.w);
        g.restore();
      }
      g.restore();
      const px = (x: number) => x * s;
      for (const r of shown) {
        g.beginPath();
        g.arc(px(r.x), px(r.y), 4.5, 0, Math.PI * 2);
        g.fillStyle = RC.surface;
        g.fill();
        g.beginPath();
        g.arc(px(r.x), px(r.y), 2.8, 0, Math.PI * 2);
        g.fillStyle = col(r.rootCause);
        g.fill();
      }
      g.strokeStyle = RC.ink;
      g.lineWidth = 1.5;
      for (const t of tips) {
        const x = px(t.x);
        const y = px(t.y);
        g.beginPath();
        g.arc(x, y, 6.5, 0, Math.PI * 2);
        g.fillStyle = 'rgba(227,229,214,0.6)';
        g.fill();
        g.stroke();
        g.beginPath();
        g.moveTo(x - 3.5, y - 3.5);
        g.lineTo(x + 3.5, y + 3.5);
        g.moveTo(x + 3.5, y - 3.5);
        g.lineTo(x - 3.5, y + 3.5);
        g.stroke();
      }
    };
    const nearest = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const mx = e.clientX - r.left;
      const my = e.clientY - r.top;
      let best: { d: number; kind: 'rout'; i: number } | { d: number; kind: 'tip'; i: number } | null = null;
      shown.forEach((ro, i) => {
        const d = Math.hypot(ro.x * place.s - mx, ro.y * place.s - my);
        if (d <= 12 && (!best || d < best.d)) best = { d, kind: 'rout', i };
      });
      tips.forEach((t, i) => {
        const d = Math.hypot(t.x * place.s - mx, t.y * place.s - my);
        if (d <= 12 && (!best || d < best.d)) best = { d, kind: 'tip', i };
      });
      return { best: best as { d: number; kind: 'rout' | 'tip'; i: number } | null, mx, my };
    };
    // the click acts on the mark the tooltip shows (clicks carry whole-pixel coordinates, moves fractional ones)
    let hovered: { kind: 'rout' | 'tip'; i: number } | null = null;
    canvas.addEventListener('pointermove', (e) => {
      const { best, mx, my } = nearest(e);
      hovered = best;
      if (!best) {
        tip.hide();
        canvas.style.cursor = '';
        return;
      }
      canvas.style.cursor = 'pointer';
      if (best.kind === 'rout') {
        const r = shown[best.i];
        tip.show(mx, my, `Seed ${r.seed} · ${clock(r.t)}`, [
          { color: col(r.rootCause), value: r.name, label: r.kind === 'rout' ? 'routed' : desnake(r.kind) },
          { value: desnake(r.rootCause || '(none)'), label: 'root cause' },
          { value: desnake(r.topCause || '(none)'), label: 'top cause' },
        ]);
      } else {
        const t = tips[best.i];
        tip.show(mx, my, `Seed ${t.seed} · ${t.t === t.t ? clock(t.t) : ''}`, [{ value: t.unit || '–', label: `its rout broke the ${side.name} army` }]);
      }
    });
    canvas.addEventListener('pointerleave', () => {
      hovered = null;
      tip.hide();
    });
    canvas.addEventListener('click', (e) => {
      const best = hovered ?? nearest(e as PointerEvent).best;
      if (!best) return;
      this.selectedSeed = best.kind === 'rout' ? shown[best.i].seed : tips[best.i].seed;
      this.renderMain();
      requestAnimationFrame(() => this.main.querySelector('.res-runs tr.sel')?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    });
    sec.append(
      el('p', { class: 'res-sub' }, `${side.name} units at the moment they broke, ${pt.runs.length} runs (${shown.length} routs shown). Colour is the root cause: the first link in the chain of morale losses. Faint blocks are where the units started. Click a mark to find its run below.`),
      legend,
      controls,
      box,
    );
    return sec;
  }

  // ---------------------------------------------------------------- formations and units

  private formations(v: BatchView, pt: PointView): HTMLElement {
    const sec = el('section', { class: 'res-section' }, el('h3', {}, 'Formations and units'));
    if (!v.has.units) {
      sec.append(el('p', { class: 'muted' }, 'Needs units.csv in the batch folder.'));
      return sec;
    }
    const rows = formationRows(pt);
    // show formations by their commander's name where the scenario gives one
    const label = new Map<string, string>();
    const walk = (n: { id: string; name?: string; commander?: { name?: string }; children?: unknown[] }) => {
      const nm = n.name ?? n.commander?.name;
      if (nm) label.set(n.id, nm);
      for (const c of (n.children ?? []) as (typeof n)[]) walk(c);
    };
    for (const sd of v.scenario?.sides ?? []) if (sd.command) walk(sd.command);
    const formName = (f: string) => (label.has(f) ? `${label.get(f)} (${f})` : f);
    const cols: { key: string; label: string; get: (r: FormationRow | FormationRow['members'][number]) => number; show: (r: FormationRow | FormationRow['members'][number]) => string }[] = [
      { key: 'men', label: 'Men', get: (r) => r.men, show: (r) => fmt(r.men) },
      { key: 'kw', label: 'Killed and wounded', get: (r) => r.kw, show: (r) => pct(r.kw) },
      { key: 'prisoners', label: 'Prisoners', get: (r) => r.prisoners, show: (r) => pct(r.prisoners) },
      { key: 'dispersed', label: 'Dispersed', get: (r) => r.dispersed, show: (r) => pct(r.dispersed) },
      { key: 'total', label: 'Total loss', get: (r) => r.total.median, show: (r) => `${pct(r.total.median)} (${pctRange(r.total.p10, r.total.p90)})` },
      { key: 'units', label: 'Units', get: (r) => ('units' in r ? r.units : 1), show: (r) => ('units' in r ? String(r.units) : '') },
      { key: 'routed', label: 'Routed', get: (r) => ('routedMedian' in r ? r.routedMedian : r.routedShare), show: (r) => ('routedMedian' in r ? `${f1(r.routedMedian).replace(/\.0$/, '')} of ${r.units}` : `in ${pct(r.routedShare)} of runs`) },
    ];
    const t = el('table', { class: 'res-table res-forms' });
    const hr = el('tr');
    const th0 = el('th', {}, 'Formation');
    hr.append(th0);
    for (const c of cols) {
      const b = el('button', { type: 'button', class: 'res-sort' }, c.label);
      if (this.formSort.key === c.key) b.append(this.formSort.dir > 0 ? ' ▲' : ' ▼');
      b.addEventListener('click', () => {
        this.formSort = { key: c.key, dir: this.formSort.key === c.key ? -this.formSort.dir : -1 };
        this.renderMain();
      });
      const th = el('th', { class: 'num' }, b);
      th.setAttribute('aria-sort', this.formSort.key === c.key ? (this.formSort.dir > 0 ? 'ascending' : 'descending') : 'none');
      hr.append(th);
    }
    t.append(el('thead', {}, hr));
    const tb = el('tbody');
    const sortCol = cols.find((c) => c.key === this.formSort.key);
    v.sides.forEach((s, si) => {
      const mine = rows.filter((r) => r.side === s.id);
      if (!mine.length) return;
      if (sortCol) mine.sort((a, b) => (sortCol.get(a) - sortCol.get(b)) * this.formSort.dir);
      const sw = el('i', { class: 'res-key-rect' });
      sw.style.background = RC.side[si] ?? RC.other;
      const head = el('tr', { class: 'res-side-row' }, el('th', { colSpan: cols.length + 1 }, sw, s.name));
      tb.append(head);
      for (const r of mine) {
        const key = `${r.side}/${r.formation}`;
        const open = this.expanded.has(key);
        const b = el('button', { type: 'button', class: 'res-expand' }, `${open ? '▾' : '▸'} ${formName(r.formation)}`);
        b.setAttribute('aria-expanded', String(open));
        b.addEventListener('click', () => {
          if (open) this.expanded.delete(key);
          else this.expanded.add(key);
          this.renderMain();
        });
        const tr = el('tr', {}, el('td', {}, b));
        for (const c of cols) tr.append(el('td', { class: 'num' }, c.show(r)));
        tb.append(tr);
        if (open) {
          const ms = r.members.slice();
          if (sortCol) ms.sort((a, b) => (sortCol.get(a) - sortCol.get(b)) * this.formSort.dir);
          for (const u of ms) {
            const ur = el('tr', { class: 'res-unit-row' }, el('td', {}, u.name));
            for (const c of cols) ur.append(el('td', { class: 'num' }, c.show(u)));
            tb.append(ur);
          }
        }
      }
    });
    t.append(tb);
    sec.append(el('p', { class: 'res-sub' }, `Medians over ${pt.runs.length} runs, losses as a share of starting strength (10th–90th percentile of total loss in brackets). A formation's losses are summed over its units in each run before the median is taken. Click a formation for its units.`), el('div', { class: 'res-table-wrap res-card-flat' }, t));
    return sec;
  }

  // ---------------------------------------------------------------- runs

  private runsTable(v: BatchView, pt: PointView): HTMLElement {
    const sec = el('section', { class: 'res-section' }, el('h3', {}, 'Runs'));
    const name = (id: string) => (id === 'draw' ? 'No decision' : v.sides.find((s) => s.id === id)?.name ?? id);
    const unitName = new Map<string, string>();
    for (const u of pt.units) unitName.set(u.unit, u.name);
    for (const r of pt.routs) unitName.set(r.unit, r.name);
    const cols: { key: string; label: string; num: boolean; get: (r: RunRow) => number | string; show: (r: RunRow) => string }[] = [
      { key: 'seed', label: 'Seed', num: true, get: (r) => r.seed, show: (r) => String(r.seed) },
      { key: 'winner', label: 'Winner', num: false, get: (r) => name(r.winner), show: (r) => name(r.winner) },
      { key: 'decided', label: 'Decided by', num: false, get: (r) => r.decidedBy, show: (r) => desnake(r.decidedBy || '–') },
      { key: 'end', label: 'Ended', num: false, get: (r) => r.endReason, show: (r) => desnake(r.endReason || '–') },
      { key: 'duration', label: 'Duration', num: true, get: (r) => r.duration, show: (r) => clock(r.duration) },
      ...v.sides.map((s, i) => ({ key: `loss${i}`, label: `${s.name} loss`, num: true, get: (r: RunRow) => r.sides[i].lossFraction, show: (r: RunRow) => pct(r.sides[i].lossFraction) })),
      { key: 'first', label: 'First rout', num: false, get: (r) => r.firstRoutT ?? Infinity, show: (r) => (r.firstRoutT === null ? '–' : `${clock(r.firstRoutT)} ${unitName.get(r.firstRoutUnit) ?? r.firstRoutUnit}`) },
    ];
    const rows = pt.runs.slice();
    const sc = cols.find((c) => c.key === this.runSort.key) ?? cols[0];
    rows.sort((a, b) => {
      const x = sc.get(a);
      const y = sc.get(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * this.runSort.dir || a.seed - b.seed;
    });
    const t = el('table', { class: 'res-table res-runs' });
    const hr = el('tr');
    for (const c of cols) {
      const b = el('button', { type: 'button', class: 'res-sort' }, c.label);
      if (this.runSort.key === c.key) b.append(this.runSort.dir > 0 ? ' ▲' : ' ▼');
      b.addEventListener('click', () => {
        this.runSort = { key: c.key, dir: this.runSort.key === c.key ? -this.runSort.dir : 1 };
        this.renderMain();
      });
      const th = el('th', { class: c.num ? 'num' : '' }, b);
      th.setAttribute('aria-sort', this.runSort.key === c.key ? (this.runSort.dir > 0 ? 'ascending' : 'descending') : 'none');
      hr.append(th);
    }
    hr.append(el('th', {}, ''));
    t.append(el('thead', {}, hr));
    const tb = el('tbody');
    const canReplay = !!v.scenario;
    for (const r of rows) {
      const tr = el('tr', { class: r.seed === this.selectedSeed ? 'sel' : '' });
      for (const c of cols) tr.append(el('td', { class: c.num ? 'num' : '' }, c.show(r)));
      const b = el('button', { type: 'button', class: 'btn sm res-replay', disabled: !canReplay }, 'Replay');
      b.title = canReplay ? `Re-run seed ${r.seed} with this point's settings and open it in the Replay tab` : 'Needs the scenario (summary.json)';
      b.addEventListener('click', () => this.replay(v, pt, r, b));
      tr.append(el('td', {}, b));
      tb.append(tr);
    }
    t.append(tb);
    sec.append(el('p', { class: 'res-sub' }, `${rows.length} runs at ${this.pointLabel(v, pt)}. Replay re-runs a seed here with the same settings and opens it in the Replay tab, where any unit can be inspected.`), el('div', { class: 'res-table-wrap res-card-flat res-scroll' }, t));
    return sec;
  }

  private async replay(v: BatchView, pt: PointView, run: RunRow, btn: HTMLButtonElement): Promise<void> {
    if (!v.scenario) return;
    btn.disabled = true;
    btn.textContent = 'Recording…';
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    try {
      const data = clone(this.host.data);
      const sc = clone(v.scenario);
      applyOverrides(data, sc, pointOverrides(v, pt) as Override[]);
      const rep = recordRun(sc, data, run.seed);
      const same = rep.result.stateHash === run.stateHash;
      let note = same ? 'matches the batch' : 'differs from the batch';
      if (!same) {
        if (v.summary && v.summary.dataHash !== this.bundledHash) note += ': the data files have changed since it was run';
        else if (!v.summary) note += ': the batch has no summary.json, so any --set overrides could not be reapplied';
        else if (run.stateHash === '') note += ': the batch recorded no state hash';
      }
      this.host.openReplay(rep, `Batch run, seed ${run.seed}`, note);
    } catch (e) {
      btn.title = `Could not record: ${e instanceof Error ? e.message : e}`;
      btn.textContent = 'Failed';
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Replay';
  }
}
