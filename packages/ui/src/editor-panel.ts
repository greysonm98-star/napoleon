// The editor's forms: file actions, validation, tools, the selection's properties,
// scenario settings, and each side's command structure and written orders.
import { FEATURE_KEYS } from '@napoleon/engine';
import type { CommandNode, Formation, OrderSpec, Posture, Scenario, ScenarioSide } from '@napoleon/engine';
import { Editor, blankScenario, sideOptions } from './editor.ts';
import type { Tool } from './editor.ts';
import { desnake } from './text.ts';
import { download, el } from './util.ts';

type Opt = [string, string];

const TOOLS: [Tool, string, string][] = [
  ['select', 'Select', 'Select, move and turn things'],
  ['unit', 'Unit', 'Place a unit'],
  ['elev', 'Height', 'Raise or lower the ground'],
  ['hill', 'Hill', 'Add a hill'],
  ['poly', 'Terrain', 'Draw a wood or a farm'],
  ['road', 'Road', 'Draw a road'],
  ['label', 'Name', 'Letter a place name'],
  ['objective', 'Objective', 'Set the ground to be taken'],
];
const POSTURES: Opt[] = [
  ['defend', 'Defend'],
  ['attack_line', 'Attack in line'],
  ['attack_column', 'Attack in column'],
];
const LEVELS: Opt[] = [
  ['army', 'Army'],
  ['corps', 'Corps'],
  ['division', 'Division'],
  ['brigade', 'Brigade'],
];
const ORDER_TYPES: Opt[] = ['attack', 'defend', 'hold', 'support', 'move', 'withdraw', 'reserve'].map((t) => [t, t[0].toUpperCase() + t.slice(1)]);
const FEATURE_LABEL: Record<string, string> = { commandControl: 'Command and control', fatigue: 'Fatigue', ammunition: 'Ammunition', skirmishers: 'Skirmishers', quality: 'Unit quality', elevationLos: 'Line of sight', smoke: 'Smoke', weatherGround: 'Weather and ground' };
const REARS: Record<string, [number, number]> = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
const numOr = (s: string): number | undefined => (s.trim() === '' || Number.isNaN(Number(s)) ? undefined : Number(s));

export class EditorPanel {
  private open = new Map<string, boolean>([['scenario', false]]);
  private seed = 1;
  private newSize = { w: 1200, h: 1600, cell: 25 };
  private bundled = '';

  constructor(private root: HTMLElement, private ed: Editor) {
    ed.onRender = () => this.render();
    this.bundled = ed.host.scenarios[0]?.key ?? '';
  }

  // ------------------------------------------------------------------ small builders

  /** A text or number input that commits on change or on losing focus. */
  private input(key: string, value: string, commit: (v: string) => void, o: { type?: 'text' | 'number'; step?: number; min?: number; max?: number; placeholder?: string; label?: string } = {}): HTMLInputElement {
    const e = el('input', { type: o.type ?? 'text', value });
    e.dataset.k = key;
    if (o.step !== undefined) e.step = String(o.step);
    if (o.min !== undefined) e.min = String(o.min);
    if (o.max !== undefined) e.max = String(o.max);
    if (o.placeholder) e.placeholder = o.placeholder;
    if (o.label) e.setAttribute('aria-label', o.label);
    let last = value;
    const go = () => {
      if (e.value === last) return;
      last = e.value;
      commit(e.value);
    };
    e.addEventListener('change', go);
    e.addEventListener('blur', go);
    return e;
  }
  private select(key: string, value: string, options: Opt[], commit: (v: string) => void, label?: string): HTMLSelectElement {
    const s = el('select');
    s.dataset.k = key;
    if (label) s.setAttribute('aria-label', label);
    if (!options.some(([v]) => v === value)) s.append(el('option', { value }, value ? `${value} (unknown)` : '—'));
    for (const [v, t] of options) s.append(el('option', { value: v }, t));
    s.value = value;
    s.addEventListener('change', () => commit(s.value));
    return s;
  }
  private check(key: string, label: string, checked: boolean, commit: (v: boolean) => void): HTMLLabelElement {
    const c = el('input', { type: 'checkbox', checked });
    c.dataset.k = key;
    c.addEventListener('change', () => commit(c.checked));
    return el('label', { class: 'check' }, c, el('span', {}, label));
  }
  private button(key: string, text: string, onClick: () => void, o: { cls?: string; title?: string; disabled?: boolean; pressed?: boolean } = {}): HTMLButtonElement {
    const b = el('button', { type: 'button', class: 'btn ' + (o.cls ?? '') }, text);
    b.dataset.k = key;
    if (o.title) (b.title = o.title), b.setAttribute('aria-label', o.title);
    if (o.disabled) b.disabled = true;
    if (o.pressed !== undefined) b.setAttribute('aria-pressed', String(o.pressed));
    b.addEventListener('click', onClick);
    return b;
  }
  /** A two-column grid of labelled controls. */
  private grid(rows: [string, HTMLElement | (HTMLElement | string)[]][]): HTMLElement {
    const g = el('div', { class: 'grid2 ed-grid' });
    for (const [label, ctl] of rows) {
      const first = Array.isArray(ctl) ? ctl.find((c): c is HTMLElement => typeof c !== 'string') : ctl;
      const l = el('label', {}, label);
      if (first && (first.tagName === 'INPUT' || first.tagName === 'SELECT' || first.tagName === 'TEXTAREA')) {
        first.id ||= 'ed-' + (first.dataset.k ?? Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9_-]/g, '_');
        l.htmlFor = first.id;
      }
      g.append(l, Array.isArray(ctl) ? el('div', { class: 'ed-inline' }, ...ctl) : ctl);
    }
    return g;
  }
  private details(key: string, summary: string, ...kids: (Node | string)[]): HTMLDetailsElement {
    const d = el('details', { class: 'ed-details' }, el('summary', {}, summary), ...kids);
    d.open = this.open.get(key) ?? false;
    d.addEventListener('toggle', () => this.open.set(key, d.open));
    return d;
  }
  private xy(key: string, at: [number, number] | undefined, commit: (v: [number, number] | undefined) => void, hint: string, placeholder = 'x, y'): HTMLElement[] {
    const text = at ? `${Math.round(at[0])}, ${Math.round(at[1])}` : '';
    return [
      this.input(key, text, (v) => {
        const m = /^\s*(-?[\d.]+)\s*[,; ]\s*(-?[\d.]+)\s*$/.exec(v);
        commit(m ? [Number(m[1]), Number(m[2])] : undefined);
      }, { placeholder, label: hint }),
      this.button(key + '-pick', 'Pick', () => {
        this.ed.pickPoint(hint, (x, y) => commit([x, y]));
        this.render();
        // on a narrow screen the map may be off the page: bring it back for the click
        document.getElementById('mapbox')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, { cls: 'sm', title: `${hint} Pick on the map.` }),
    ];
  }

  // ------------------------------------------------------------------ render

  render(): void {
    const ed = this.ed;
    if (!ed.active) return;
    // keep the user's place: the focused control, anything typed but not yet committed, and the scroll position
    const act = document.activeElement as HTMLInputElement | null;
    const key = act && this.root.contains(act) ? act.dataset?.k : undefined;
    const pending = key && act && (act.tagName === 'INPUT' || act.tagName === 'TEXTAREA') && act.type !== 'checkbox' ? { v: act.value, a: act.selectionStart, b: act.selectionEnd } : null;
    const scrollY = window.scrollY;

    const kids: Node[] = [el('h2', {}, 'Editor'), this.fileSection(), this.validation()];
    const notice = this.generatedNotice();
    if (notice) kids.push(notice);
    kids.push(this.toolSection(), this.selectionSection(), this.scenarioSection());
    ed.sc.sides.forEach((_, i) => kids.push(this.sideSection(i)));
    this.root.replaceChildren(...kids);

    if (key) {
      const again = this.root.querySelector<HTMLInputElement>(`[data-k="${CSS.escape(key)}"]`);
      if (again) {
        again.focus({ preventScroll: true });
        if (pending && again.value !== pending.v && again.type !== 'checkbox') {
          again.value = pending.v;
          try {
            if (pending.a !== null) again.setSelectionRange(pending.a, pending.b);
          } catch {
            /* number inputs have no selection range */
          }
        }
      }
    }
    window.scrollTo({ top: scrollY });
  }

  // ------------------------------------------------------------------ file, undo, test run

  private fileSection(): HTMLElement {
    const ed = this.ed;
    const file = el('input', { type: 'file', accept: '.json,application/json', class: 'visually-hidden', id: 'ed-file' });
    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      try {
        const o = JSON.parse(await f.text());
        const sc: Scenario | undefined = o?.format === 'napsim-replay' ? o.scenario : o;
        if (!sc || sc.format !== 'napsim-scenario' || !sc.map || !Array.isArray(sc.sides)) throw new Error('not a napsim scenario file');
        ed.load(sc, `Opened ${f.name}.`);
      } catch (e) {
        ed.status = `Could not open ${f.name}: ${e instanceof Error ? e.message : e}`;
        this.render();
      }
    });
    const bundled = this.select('bundled', this.bundled, ed.host.scenarios.map((s) => [s.key, s.sc.name]), (v) => (this.bundled = v), 'Bundled scenario');
    const save = this.button('save', 'Save', () => {
      try {
        const text = JSON.stringify(ed.sc, null, 2) + '\n';
        download(`${(ed.sc.name || 'scenario').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario'}.json`, text);
        ed.status = ed.problems.length ? 'Saved, though the scenario still has problems (listed below).' : 'Saved.';
      } catch (e) {
        ed.status = `Could not save: ${e instanceof Error ? e.message : e}`;
      }
      this.render();
    }, { cls: 'primary', title: 'Download the scenario as a JSON file' });
    const fromReplay = ed.host.replayScenario();
    const box = el('div', {},
      el('div', { class: 'row' },
        save,
        el('label', { class: 'btn', htmlFor: 'ed-file' }, 'Open file…'),
        file,
        this.button('undo', 'Undo', () => ed.undo(), { disabled: !ed.canUndo(), title: 'Undo (Ctrl+Z)' }),
        this.button('redo', 'Redo', () => ed.redo(), { disabled: !ed.canRedo(), title: 'Redo (Ctrl+Shift+Z)' }),
      ),
      el('div', { class: 'row ed-gap' }, bundled, this.button('load-bundled', 'Load', () => {
        const s = ed.host.scenarios.find((x) => x.key === this.bundled);
        if (s) ed.load(s.sc, `Loaded “${s.sc.name}”.`);
      })),
      this.details('new', 'New blank scenario, or take one from a replay',
        this.grid([
          ['Width, m', this.input('new-w', String(this.newSize.w), (v) => (this.newSize.w = Math.max(200, Number(v) || 1200)), { type: 'number', step: 100, min: 200 })],
          ['Height, m', this.input('new-h', String(this.newSize.h), (v) => (this.newSize.h = Math.max(200, Number(v) || 1600)), { type: 'number', step: 100, min: 200 })],
          ['Grid cell, m', this.input('new-c', String(this.newSize.cell), (v) => (this.newSize.cell = Math.max(5, Number(v) || 25)), { type: 'number', step: 5, min: 5 })],
        ]),
        el('div', { class: 'row' },
          this.button('new-go', 'New blank scenario', () => ed.load(blankScenario(this.newSize.w, this.newSize.h, this.newSize.cell), 'New blank scenario. Place units for both sides.')),
          this.button('from-replay', 'Edit the loaded replay’s scenario', () => fromReplay && ed.load(fromReplay, 'Took the scenario from the loaded replay.'), { disabled: !fromReplay }),
        ),
      ),
      el('div', { class: 'row ed-gap' },
        this.button('test', 'Test run', () => {
          ed.status = 'Running…';
          this.render();
          setTimeout(() => ed.testRun(this.seed), 20);
        }, { cls: 'primary', disabled: ed.problems.length > 0, title: 'Run the scenario once and open the recording in the Replay tab' }),
        el('label', { htmlFor: 'ed-seed' }, 'Seed'),
        Object.assign(this.input('seed', String(this.seed), (v) => (this.seed = Number(v) | 0), { type: 'number', step: 1, min: 0 }), { id: 'ed-seed', className: 'ed-narrow' }),
      ),
    );
    if (ed.status) box.append(el('p', { class: 'muted' }, ed.status));
    return box;
  }

  private validation(): HTMLElement {
    const ed = this.ed;
    const box = el('div', { class: 'ed-valid ' + (ed.problems.length ? 'bad' : ed.warnings.length ? 'warn' : 'ok') });
    box.setAttribute('role', 'status');
    if (!ed.problems.length) box.append(el('strong', {}, ed.warnings.length ? 'Valid, with notes' : 'Valid'));
    else box.append(el('strong', {}, `${ed.problems.length} problem${ed.problems.length > 1 ? 's' : ''} to fix before it will run`));
    const list = el('ul');
    for (const p of ed.problems.slice(0, 12)) list.append(el('li', {}, p));
    if (ed.problems.length > 12) list.append(el('li', {}, `…and ${ed.problems.length - 12} more.`));
    for (const w of ed.warnings.slice(0, 6)) list.append(el('li', { class: 'note' }, w));
    if (list.children.length) box.append(list);
    return box;
  }

  private generatedNotice(): HTMLElement | null {
    const ed = this.ed;
    if (!ed.hasGenerated()) return null;
    const parts = ed.sc.sides.filter((s) => s.deploy || s.groups?.length).map((s) => `${s.name}: ${s.deploy ? `standard deployment of ${s.deploy.inf} battalions, ${s.deploy.cav} squadrons, ${s.deploy.art} batteries` : ''}${s.deploy && s.groups?.length ? ' and ' : ''}${s.groups?.length ? `${s.groups.length} group${s.groups.length > 1 ? 's' : ''}` : ''}`);
    return el('div', { class: 'ed-notice' },
      el('p', {}, `Some units here are generated from a deployment block (${parts.join('; ')}). They are drawn on the map but cannot be moved one by one.`),
      this.button('convert', 'Convert to explicit units', () => {
        ed.convertToExplicit();
        ed.status = 'Every unit is now listed in the scenario and can be edited.';
      }),
    );
  }

  // ------------------------------------------------------------------ tools

  private toolSection(): HTMLElement {
    const ed = this.ed;
    const o = ed.opts;
    const bar = el('div', { class: 'ed-tools', role: 'group' });
    bar.setAttribute('aria-label', 'Map tool');
    for (const [t, label, title] of TOOLS) bar.append(this.button('tool-' + t, label, () => ed.setTool(t), { title, pressed: ed.tool === t }));
    const box = el('div', {}, el('h3', {}, 'Tool'), bar);
    const types: Opt[] = Object.entries(ed.data.units).map(([k, u]) => [k, u.label]);
    const qualities: Opt[] = Object.entries(ed.data.quality.classes).map(([k, q]) => [k, q.label]);
    const set = <K extends keyof typeof o>(k: K, v: (typeof o)[K]) => {
      o[k] = v;
      this.render();
    };
    if (ed.tool === 'unit') {
      const arm = ed.data.units[o.type]?.arm;
      box.append(this.grid([
        ['Side', this.select('t-side', String(o.side), sideOptions(ed.sc), (v) => set('side', Number(v)))],
        ['Type', this.select('t-type', o.type, types, (v) => set('type', v))],
        ...(arm === 'inf' ? [['Formation', this.select('t-form', o.formation, [['line', 'Line'], ['column', 'Column'], ['square', 'Square']], (v) => set('formation', v as Formation))] as [string, HTMLElement]] : []),
        ['Quality', this.select('t-qual', o.quality, qualities, (v) => set('quality', v))],
      ]));
    } else if (ed.tool === 'elev') {
      const range = (key: string, value: number, min: number, max: number, step: number, commit: (v: number) => void) => {
        const r = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
        r.dataset.k = key;
        const out = el('output', {}, String(value));
        r.addEventListener('input', () => {
          commit(Number(r.value));
          out.textContent = r.value;
        });
        return [r, out];
      };
      box.append(this.grid([
        ['Radius, m', range('t-br', o.brushR, 50, 500, 10, (v) => (o.brushR = v))],
        ['Strength, m', range('t-bs', o.brushS, 0.5, 10, 0.5, (v) => (o.brushS = v))],
      ]), this.check('t-lower', 'Lower instead of raise (Shift does the same)', o.lower, (v) => set('lower', v)));
    } else if (ed.tool === 'poly') {
      box.append(this.grid([
        ['Terrain', this.select('t-terr', o.terrain, Object.entries(ed.data.terrain.types).map(([k, t]) => [k, t.label]), (v) => set('terrain', v))],
        ['Name', this.input('t-fname', o.featureName, (v) => (o.featureName = v), { placeholder: 'optional' })],
      ]));
    } else if (ed.tool === 'hill') {
      box.append(this.grid([['Height, m', this.input('t-hh', String(o.hillHeight), (v) => (o.hillHeight = Number(v) || 20), { type: 'number', step: 1 })]]));
    } else if (ed.tool === 'label') {
      box.append(this.grid([['Text', this.input('t-label', o.label, (v) => (o.label = v))]]));
    }
    box.append(el('p', { class: 'muted' }, ed.hint()));
    return box;
  }

  // ------------------------------------------------------------------ selection

  private selectionSection(): HTMLElement {
    const ed = this.ed;
    const s = ed.sel;
    const box = el('div', {}, el('h3', {}, 'Selection'));
    const del = (what: string) => this.button('sel-del', `Delete ${what}`, () => ed.deleteSelection());
    const m = ed.sc.map;
    if (!s) {
      box.append(el('p', { class: 'muted' }, 'Nothing selected. With the Select tool, click a unit, commander, wood, farm, hill summit, road, name or the objective.'));
      return box;
    }
    if (s.kind === 'unit') {
      const hit = ed.findUnit(s.id);
      const ex = ed.expanded().find((u) => u.id === s.id);
      if (!hit) {
        box.append(el('p', {}, ex ? `${ex.name} (${s.id})` : s.id), el('p', { class: 'muted' }, 'This unit comes from a deployment block. Convert to explicit units (above) to edit it.'));
        return box;
      }
      const u = hit.unit;
      const ut = ed.data.units[u.type];
      const set = (fn: () => void) => ed.mutate(fn);
      const forms: Opt[] = [['', 'By posture'], ['line', 'Line'], ['column', 'Column'], ['square', 'Square']];
      const parents: Opt[] = [['', '— none —'], ...ed.nodes(hit.side).map((n): Opt => [n.node.id, `${'· '.repeat(n.depth)}${n.node.commander?.name || n.node.id}`])];
      box.append(this.grid([
        ['Name', this.input('u-name', u.name ?? '', (v) => set(() => (v ? (u.name = v) : delete u.name)))],
        ['Id', this.input('u-id', u.id, (v) => set(() => {
          if (!ed.renameUnit(u.id, v.trim())) ed.status = `Id “${v}” is empty or already in use.`;
        }))],
        ['Side', el('span', {}, ed.sc.sides[hit.side].name)],
        ['Type', this.select('u-type', u.type, Object.entries(ed.data.units).map(([k, t]) => [k, t.label]), (v) => set(() => {
          u.type = v;
          u.men = ed.data.units[v].men;
          if (ed.data.units[v].arm !== 'inf') delete u.formation;
        }))],
        ['Men', this.input('u-men', String(u.men ?? ut?.men ?? ''), (v) => set(() => {
          const n = numOr(v);
          if (n === undefined) delete u.men;
          else u.men = Math.max(1, Math.round(n));
        }), { type: 'number', step: 10, min: 1 })],
        ...(ut?.arm === 'inf' ? [['Formation', this.select('u-form', u.formation ?? '', forms, (v) => set(() => (v ? (u.formation = v as Formation) : delete u.formation)))] as [string, HTMLElement]] : []),
        ['Facing, °', [this.input('u-face', u.facing === undefined ? '' : String(u.facing), (v) => set(() => {
          const n = numOr(v);
          if (n === undefined) delete u.facing;
          else u.facing = ((n % 360) + 360) % 360;
        }), { type: 'number', step: 5, placeholder: `${ed.defaultFacing(hit.side)} (toward the enemy)` }), el('span', { class: 'muted' }, '0 north, 90 east')]],
        ['Position', this.xy('u-at', u.at, (v) => v && set(() => (u.at = v)), `Place ${u.name ?? u.id}.`)],
        ['Quality', this.select('u-qual', u.quality ?? 'line', Object.entries(ed.data.quality.classes).map(([k, q]) => [k, q.label]), (v) => set(() => (u.quality = v)))],
        ['Formation it belongs to', this.select('u-parent', ed.parentOf(u.id, hit.side), parents, (v) => set(() => ed.setUnitParent(u, hit.side, v)))],
        ...(ut?.arm === 'inf' ? [['Skirmishers', this.input('u-skirm', u.skirmishers === undefined ? '' : String(u.skirmishers), (v) => set(() => {
          const n = numOr(v);
          if (n === undefined) delete u.skirmishers;
          else u.skirmishers = Math.max(0, Math.round(n));
        }), { type: 'number', step: 10, min: 0, placeholder: 'by type' })] as [string, HTMLElement]] : []),
      ]), el('div', { class: 'row' }, del('unit'), this.button('u-dup', 'Duplicate', () => ed.mutate(() => {
        const side = ed.sc.sides[hit.side];
        const id = ed.uniqueUnitId(side, ut?.arm ?? 'unit');
        side.units!.push({ ...structuredClone(u), id, name: `${u.name ?? u.id} (copy)`, at: [u.at[0] + 60, u.at[1] + 40] });
        ed.sel = { kind: 'unit', id };
      }))));
      return box;
    }
    if (s.kind === 'commander') {
      const hit = ed.findNode(s.id);
      if (hit) box.append(this.nodeFields(hit.node, hit.side, 'sel-'), el('div', { class: 'row' }, del('formation')));
      return box;
    }
    if (s.kind === 'feature') {
      const f = m.features![s.i];
      box.append(this.grid([
        ['Terrain', this.select('f-type', f.type, Object.entries(ed.data.terrain.types).map(([k, t]) => [k, t.label]), (v) => ed.mutate(() => (f.type = v), true))],
        ['Name', this.input('f-name', f.name ?? '', (v) => ed.mutate(() => (v ? (f.name = v) : delete f.name), true))],
        ['Corners', el('span', { class: 'muted' }, `${f.polygon.length}; drag a corner to reshape, drag inside to move`)],
      ]), del('terrain'));
    } else if (s.kind === 'hill') {
      const h = m.hills![s.i];
      const n = (k: 'x' | 'y' | 'rx' | 'ry' | 'height', label: string): [string, HTMLElement] => [label, this.input('h-' + k, String(h[k]), (v) => ed.mutate(() => (h[k] = Number(v) || h[k]), true), { type: 'number', step: k === 'height' ? 1 : 10 })];
      box.append(this.grid([n('height', 'Height, m'), n('rx', 'Half-width east–west, m'), n('ry', 'Half-width north–south, m'), n('x', 'Summit x'), n('y', 'Summit y')]), el('p', { class: 'muted' }, 'A negative height makes a hollow.'), del('hill'));
    } else if (s.kind === 'road') {
      box.append(el('p', { class: 'muted' }, `Road of ${m.roads![s.i].length} points. Drag a point to reshape.`), del('road'));
    } else if (s.kind === 'label') {
      const l = m.labels![s.i];
      box.append(this.grid([
        ['Text', this.input('l-text', l.text, (v) => ed.mutate(() => (l.text = v || l.text), true))],
        ['Size', this.input('l-size', String(l.size ?? 25), (v) => ed.mutate(() => (l.size = Math.max(8, Number(v) || 25)), true), { type: 'number', step: 1, min: 8 })],
      ]), del('name'));
    } else if (s.kind === 'objective') {
      box.append(this.objectiveFields(), del('objective'));
    }
    return box;
  }

  private objectiveFields(pre = ''): HTMLElement {
    const ed = this.ed;
    const ob = ed.sc.objective!;
    return this.grid([
      ['Name', this.input(pre + 'ob-name', ob.name ?? '', (v) => ed.mutate(() => (v ? (ob.name = v) : delete ob.name)), { placeholder: 'the ridge' })],
      ['Position', this.xy(pre + 'ob-at', ob.at, (v) => v && ed.mutate(() => (ob.at = v)), 'Set the objective.')],
      ['Radius, m', this.input(pre + 'ob-r', String(ob.radius), (v) => ed.mutate(() => (ob.radius = Math.max(20, Number(v) || ob.radius))), { type: 'number', step: 10, min: 20 })],
      ['Defended by', this.select(pre + 'ob-def', ob.defender, ed.sc.sides.map((s) => [s.id, s.name]), (v) => ed.mutate(() => (ob.defender = v)))],
    ]);
  }

  // ------------------------------------------------------------------ scenario

  private scenarioSection(): HTMLElement {
    const ed = this.ed;
    const sc = ed.sc;
    const w = (sc.weather ??= { sky: 'clear', ground: 'firm', windFrom: 270, windSpeed: 3 });
    const wd = ed.data.weather as { sky?: Record<string, unknown>; ground?: Record<string, unknown> } | undefined;
    const skies: Opt[] = Object.keys(wd?.sky ?? { clear: 1, rain: 1, heavy_rain: 1, fog: 1 }).map((k) => [k, desnake(k)]);
    const grounds: Opt[] = Object.keys(wd?.ground ?? { firm: 1, soft: 1, mud: 1, frozen: 1 }).map((k) => [k, k]);
    const desc = el('textarea', { rows: 3, value: sc.description ?? '' });
    desc.dataset.k = 'sc-desc';
    const d0 = sc.description ?? '';
    const commitDesc = () => {
      if (desc.value !== d0) ed.mutate(() => (desc.value ? (sc.description = desc.value) : delete sc.description));
    };
    desc.addEventListener('change', commitDesc);
    desc.addEventListener('blur', commitDesc);
    const feats = el('fieldset', { class: 'features' }, el('legend', {}, 'Model features'));
    for (const k of FEATURE_KEYS) feats.append(this.check('feat-' + k, FEATURE_LABEL[k] ?? k, !!sc.features?.[k], (v) => ed.mutate(() => (sc.features = { ...sc.features, [k]: v }))));
    const size = { w: sc.map.width, h: sc.map.height, c: sc.map.cellSize };
    const dim = (key: 'w' | 'h' | 'c', step: number) => this.input('map-' + key, String(size[key]), (v) => {
      size[key] = Number(v) || size[key];
      ed.resizeMap(size.w, size.h, size.c);
    }, { type: 'number', step, min: key === 'c' ? 5 : 200 });
    const body: Node[] = [
      this.grid([
        ['Name', this.input('sc-name', sc.name, (v) => ed.mutate(() => (sc.name = v || 'Untitled')))],
        ['Description', desc],
        ['Time limit, min', this.input('sc-time', String(Math.round(sc.timeLimit / 60)), (v) => ed.mutate(() => (sc.timeLimit = Math.max(1, Number(v) || 120) * 60)), { type: 'number', step: 10, min: 1 })],
        ['Sky', this.select('w-sky', w.sky, skies, (v) => ed.mutate(() => (w.sky = v as typeof w.sky)))],
        ['Ground', this.select('w-ground', w.ground, grounds, (v) => ed.mutate(() => (w.ground = v as typeof w.ground)))],
        ['Wind from, °', this.input('w-from', String(w.windFrom), (v) => ed.mutate(() => (w.windFrom = (((Number(v) || 0) % 360) + 360) % 360)), { type: 'number', step: 15 })],
        ['Wind, m/s', this.input('w-speed', String(w.windSpeed), (v) => ed.mutate(() => (w.windSpeed = Math.max(0, Number(v) || 0))), { type: 'number', step: 1, min: 0 })],
      ]),
      feats,
      el('h3', {}, 'Map'),
      this.grid([
        ['Width, m', dim('w', 100)],
        ['Height, m', dim('h', 100)],
        ['Grid cell, m', dim('c', 5)],
      ]),
      el('p', { class: 'muted' }, 'Changing the size keeps everything on the map; painted heights are resampled.'),
      el('h3', {}, 'Objective'),
    ];
    if (sc.objective) body.push(this.objectiveFields('sc-'), this.button('ob-remove', 'Remove objective', () => ed.mutate(() => {
      delete sc.objective;
      if (ed.sel?.kind === 'objective') ed.sel = null;
    })));
    else body.push(el('p', { class: 'muted' }, 'None. Without one, a battle in which neither army breaks is a draw. Use the Objective tool to place one.'));
    return this.details('scenario', `Scenario: ${sc.name}`, ...body);
  }

  // ------------------------------------------------------------------ sides, command, orders

  private nodeFields(n: CommandNode, side: number, prefix: string): HTMLElement {
    const ed = this.ed;
    const c = (n.commander ??= { name: n.id });
    const k = prefix + 'n-' + n.id + '-';
    const cmd = (ed.data.command ?? {}) as Record<string, number>;
    const lv = n.level === 'army' ? 'Army' : n.level === 'corps' ? 'Corps' : n.level === 'division' ? 'Division' : 'Brigade';
    const optNum = (key: 'radius' | 'initiative' | 'staffDelay', label: string, def: number | undefined, step: number): [string, HTMLElement] => [label, this.input(k + key, c[key] === undefined ? '' : String(c[key]), (v) => ed.mutate(() => {
      const x = numOr(v);
      if (x === undefined) delete c[key];
      else c[key] = x;
    }), { type: 'number', step, min: 0, placeholder: def === undefined ? 'default' : `${def} (default)` })];
    const members = ed.expanded().filter((u) => u.side === side && ed.parentOf(u.id, side) === n.id).length;
    return this.grid([
      ['Commander', this.input(k + 'name', c.name ?? '', (v) => ed.mutate(() => (c.name = v || n.id)))],
      ['Id', this.input(k + 'id', n.id, (v) => ed.mutate(() => ed.renameNode(n.id, v.trim())))],
      ['Level', this.select(k + 'level', n.level, LEVELS, (v) => ed.mutate(() => (n.level = v as CommandNode['level'])))],
      optNum('radius', 'Command radius, m', cmd['radius' + lv], 50),
      optNum('initiative', 'Initiative, 0–1', cmd.initiativeDefault, 0.1),
      optNum('staffDelay', 'Staff delay, s', cmd['staffDelay' + lv], 10),
      ['Position', [...this.xy(k + 'at', c.at, (v) => ed.mutate(() => (v ? (c.at = v) : delete c.at)), `Place ${c.name || n.id}.`, 'behind his troops'), ...(c.at ? [this.button(k + 'at-clear', 'Auto', () => ed.mutate(() => delete c.at), { cls: 'sm', title: 'Let him take station behind his troops' })] : [])]],
      ['Units', el('span', { class: 'muted' }, `${members} directly under him. Assign a unit by selecting it and choosing this formation.`)],
    ]);
  }

  private commandSection(side: number): HTMLElement {
    const ed = this.ed;
    const s = ed.sc.sides[side];
    const box = el('div', {}, el('h3', {}, 'Command structure'));
    if (!s.command) {
      box.append(
        el('p', { class: 'muted' }, 'None. With command and control on, the engine then makes one itself: a headquarters, brigades of four battalions and a cavalry brigade on each wing.'),
        this.button(`cmd-add-${side}`, 'Add a headquarters', () => ed.mutate(() => {
          s.command = { id: ed.uniqueNodeId(s, 'corps'), level: 'corps', commander: { name: `${s.name} commander` }, children: [] };
        })),
      );
      return box;
    }
    for (const { node, depth, parent } of ed.nodes(side)) {
      const key = `node-${node.id}`;
      const d = this.details(key, `${node.commander?.name || node.id} · ${node.level}`,
        this.nodeFields(node, side, ''),
        el('div', { class: 'row' },
          this.button(key + '-child', 'Add a formation under him', () => ed.mutate(() => {
            const level = node.level === 'army' ? 'corps' : node.level === 'corps' ? 'division' : 'brigade';
            (node.children ??= []).push({ id: ed.uniqueNodeId(s, level), level, commander: { name: `${level[0].toUpperCase()}${level.slice(1)} commander` } });
            this.open.set(key, true);
          })),
          this.button(key + '-sel', 'Show on map', () => {
            ed.sel = { kind: 'commander', id: node.id };
            this.render();
          }),
          this.button(key + '-del', parent ? 'Remove' : 'Remove the whole structure', () => ed.mutate(() => ed.removeNode(node.id))),
        ),
      );
      d.style.marginLeft = `${depth * 14}px`;
      if (ed.sel?.kind === 'commander' && ed.sel.id === node.id) d.classList.add('sel');
      box.append(d);
    }
    return box;
  }

  private ordersSection(side: number): HTMLElement {
    const ed = this.ed;
    const s = ed.sc.sides[side];
    const box = el('div', {}, el('h3', {}, 'Written orders'));
    const nodes = ed.nodes(side);
    if (!nodes.length) {
      box.append(el('p', { class: 'muted' }, 'Orders are addressed to formations. Add a command structure first. Without orders, the side’s posture is its standing order.'));
      return box;
    }
    const mine: Opt[] = nodes.map((n) => [n.node.id, `${'· '.repeat(n.depth)}${n.node.commander?.name || n.node.id}`]);
    const all: Opt[] = ed.sc.sides.flatMap((x, i) => ed.nodes(i).map((n): Opt => [n.node.id, `${x.name}: ${n.node.commander?.name || n.node.id}`]));
    const units: Opt[] = ed.expanded().map((u) => [u.id, `${ed.sc.sides[u.side].name}: ${u.name}`]);
    const orders = s.orders ?? [];
    orders.forEach((o, i) => {
      const k = `o${side}-${i}-`;
      const kind = o.when ? (o.when.unitRouted !== undefined ? 'unitRouted' : o.when.formationBroken !== undefined ? 'formationBroken' : 'enemyWithin') : 'at';
      const set = (fn: () => void) => ed.mutate(fn);
      let arg: (HTMLElement | string)[];
      if (kind === 'at') arg = [this.input(k + 'at', String(o.at ?? 0), (v) => set(() => (o.at = Math.max(0, Number(v) || 0))), { type: 'number', step: 60, min: 0, label: 'Seconds after the start' }), el('span', { class: 'muted' }, o.at ? `s (${(o.at / 60).toFixed(1)} min)` : 's: in hand at the start')];
      else if (kind === 'unitRouted') arg = [this.select(k + 'unit', o.when!.unitRouted ?? '', units, (v) => set(() => (o.when = { unitRouted: v })), 'Unit')];
      else if (kind === 'formationBroken') arg = [this.select(k + 'fb', o.when!.formationBroken ?? '', all, (v) => set(() => (o.when = { formationBroken: v })), 'Formation')];
      else arg = [this.input(k + 'ew', String(o.when!.enemyWithin ?? 300), (v) => set(() => (o.when = { ...o.when, enemyWithin: Math.max(1, Number(v) || 300) })), { type: 'number', step: 50, min: 1, label: 'Metres' }), 'm of', this.select(k + 'of', o.when!.of ?? o.to, mine, (v) => set(() => (o.when = { ...o.when, of: v })), 'Formation')];
      const rows: [string, HTMLElement | (HTMLElement | string)[]][] = [
        ['When', this.select(k + 'kind', kind, [['at', 'At a time'], ['unitRouted', 'A unit has routed'], ['formationBroken', 'Half a formation has broken'], ['enemyWithin', 'Enemy comes within']], (v) => set(() => {
          delete o.at;
          delete o.when;
          if (v === 'at') o.at = 0;
          else if (v === 'unitRouted') o.when = { unitRouted: units[0]?.[0] ?? '' };
          else if (v === 'formationBroken') o.when = { formationBroken: all[0]?.[0] ?? '' };
          else o.when = { enemyWithin: 300, of: o.to };
        }))],
        ['', arg],
        ['To', this.select(k + 'to', o.to, mine, (v) => set(() => (o.to = v)))],
        ['Order', [this.select(k + 'type', o.type, ORDER_TYPES, (v) => set(() => {
          o.type = v as OrderSpec['type'];
          if (o.type !== 'attack') delete o.formation;
          if (o.type !== 'support') delete o.target;
        }), 'Order type'), ...(o.type === 'attack' ? [this.select(k + 'form', o.formation ?? '', [['', 'in line (default)'], ['line', 'in line'], ['column', 'in column']], (v) => set(() => (v ? (o.formation = v as Formation) : delete o.formation)), 'Formation for the attack')] : [])]],
      ];
      if (o.type === 'support') rows.push(['Supporting', this.select(k + 'target', o.target ?? '', [['', '— choose —'], ...mine.filter(([id]) => id !== o.to)], (v) => set(() => (v ? (o.target = v) : delete o.target)))]);
      if (o.type !== 'hold' && o.type !== 'reserve' && o.type !== 'support') rows.push(['Objective', [...this.xy(k + 'obj', o.objective, (v) => set(() => (v ? (o.objective = v) : delete o.objective)), `Objective of order ${i + 1}.`, 'none'), ...(o.objective ? [this.button(k + 'obj-clear', '×', () => set(() => delete o.objective), { cls: 'sm', title: 'Remove the objective' })] : [])]]);
      const move = (d: number) => set(() => {
        const j = i + d;
        if (j < 0 || j >= orders.length) return;
        [orders[i], orders[j]] = [orders[j], orders[i]];
      });
      box.append(el('div', { class: 'ed-card' },
        el('div', { class: 'ed-card-head' },
          el('strong', {}, `${i + 1}.`),
          el('span', { class: 'ed-spacer' }),
          this.button(k + 'up', '↑', () => move(-1), { cls: 'sm', title: 'Move up', disabled: i === 0 }),
          this.button(k + 'down', '↓', () => move(1), { cls: 'sm', title: 'Move down', disabled: i === orders.length - 1 }),
          this.button(k + 'del', '×', () => set(() => orders.splice(i, 1)), { cls: 'sm', title: 'Remove this order' }),
        ),
        this.grid(rows),
      ));
    });
    if (!orders.length) box.append(el('p', { class: 'muted' }, 'None: the side’s posture is its standing order to the whole army.'));
    box.append(this.button(`o-add-${side}`, 'Add an order', () => ed.mutate(() => {
      (s.orders ??= []).push({ at: orders.length ? 600 : 0, to: nodes[0].node.id, type: s.posture === 'defend' ? 'defend' : 'attack' });
    })));
    return box;
  }

  private sideSection(i: number): HTMLElement {
    const ed = this.ed;
    const s: ScenarioSide = ed.sc.sides[i];
    const rl = Math.hypot(s.rear[0], s.rear[1]) || 1;
    const rearKey = Object.entries(REARS).find(([, v]) => Math.abs(v[0] - s.rear[0] / rl) < 1e-6 && Math.abs(v[1] - s.rear[1] / rl) < 1e-6)?.[0] ?? 'custom';
    const k = `s${i}-`;
    const rows: [string, HTMLElement | (HTMLElement | string)[]][] = [
      ['Name', this.input(k + 'name', s.name, (v) => ed.mutate(() => (s.name = v || s.id)))],
      ['Posture', this.select(k + 'posture', s.posture, POSTURES, (v) => ed.mutate(() => (s.posture = v as Posture)))],
      ['Rear lies to the', this.select(k + 'rear', rearKey, [['N', 'North'], ['S', 'South'], ['E', 'East'], ['W', 'West'], ['custom', 'Custom direction']], (v) => ed.mutate(() => {
        if (REARS[v]) s.rear = [...REARS[v]] as [number, number];
        else s.rear = [0.7, 0.7];
      }))],
    ];
    if (rearKey === 'custom') rows.push(['Rear vector', [
      this.input(k + 'rx', String(s.rear[0]), (v) => ed.mutate(() => (s.rear = [Number(v) || 0, s.rear[1]])), { type: 'number', step: 0.1, label: 'East component' }),
      this.input(k + 'ry', String(s.rear[1]), (v) => ed.mutate(() => (s.rear = [s.rear[0], Number(v) || 0])), { type: 'number', step: 0.1, label: 'South component' }),
    ]]);
    const d = s.deploy;
    if (d) {
      const n = (key: 'inf' | 'cav' | 'art', label: string): [string, HTMLElement] => [label, this.input(k + 'dep-' + key, String(d[key]), (v) => ed.mutate(() => (d[key] = Math.max(0, Math.round(Number(v) || 0)))), { type: 'number', step: 1, min: 0 })];
      rows.push(n('inf', 'Battalions (deployed)'), n('cav', 'Squadrons (deployed)'), n('art', 'Batteries (deployed)'), ['Centre of the line', this.xy(k + 'dep-c', d.centre, (v) => v && ed.mutate(() => (d.centre = v)), `Centre of the ${s.name} line.`)]);
    }
    const count = ed.expanded().filter((u) => u.side === i).length;
    const men = ed.expanded().filter((u) => u.side === i).reduce((a, u) => a + u.men, 0);
    return this.details(`side-${i}`, `${s.name}: ${count} units, ${men.toLocaleString('en-US')} men`,
      this.grid(rows),
      el('p', { class: 'muted' }, 'Routed units run toward the rear; units face away from it unless given a facing.'),
      this.commandSection(i),
      this.ordersSection(i),
    );
  }
}
