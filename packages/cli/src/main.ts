#!/usr/bin/env node
import { writeFileSync, writeSync } from 'node:fs';
import { checkConservation, createSim, recordRun, runToEnd } from '@napoleon/engine';
import type { RunResult } from '@napoleon/engine';
import { intOpt, parseArgs } from './args.ts';
import type { OptKind, Opts } from './args.ts';
import { loadData, loadScenario } from './load.ts';
import { applyOverrides, parseAxis } from './overrides.ts';
import type { Override } from './overrides.ts';

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const pct = (v: number) => (v * 100).toFixed(1) + '%';

export function printResult(r: RunResult): void {
  console.log(`${r.scenario}  seed ${r.seed}`);
  console.log(`Result: ${r.winner === 'draw' ? 'no decision' : r.winner + ' win'} (${r.endReason}${r.decidedBy === 'objective' ? ', decided by the objective' : ''}) after ${clock(r.duration)}`);
  for (const s of r.sides) {
    console.log(`  ${s.name.padEnd(8)} ${s.posture.padEnd(13)} ${String(s.startMen).padStart(6)} men  K/W ${String(s.casualties).padStart(5)} (${pct(s.casualtyFraction)})  prisoners ${String(s.captured).padStart(4)}  dispersed ${String(s.dispersed).padStart(5)}  units routed ${s.unitsEverRouted}/${s.units}${s.broke ? `  BROKE at ${clock(s.brokeAt!)} near (${s.breakX}, ${s.breakY})` : ''}`);
  }
}

function cmdRun(pos: string[], opt: Opts): void {
  const scenarioPath = pos[0];
  if (!scenarioPath) throw new Error('usage: napsim run <scenario.json> [--seed N] [--set scope:path=value ...] [--replay out.json] [--log] [--json] [--out result.json]');
  const { data } = loadData(opt.data?.[0]);
  const scenario = loadScenario(scenarioPath);
  const seed = intOpt(opt, 'seed', 1, -2147483648);
  const overrides: Override[] = (opt.set ?? []).map((s) => {
    const a = parseAxis(s);
    if (a.values.length !== 1) throw new Error(`--set takes one value: ${s}`);
    return { scope: a.scope, path: a.path, value: a.values[0] };
  });
  applyOverrides(data, scenario, overrides);
  const emitJson = (r: RunResult) => {
    const text = JSON.stringify(r, null, 2);
    if (opt.out) writeFileSync(opt.out[0], text + '\n');
    else console.log(text);
  };
  if (opt.replay) {
    const rep = recordRun(scenario, data, seed);
    const dataOverrides = overrides.filter((o) => o.scope === 'data').map((o) => ({ path: o.path, value: o.value }));
    if (dataOverrides.length) rep.dataOverrides = dataOverrides;
    writeFileSync(opt.replay[0], JSON.stringify(rep));
    if (opt.json) emitJson(rep.result);
    else printResult(rep.result);
    console.error(`replay written to ${opt.replay[0]} (${rep.times.length} samples, ${rep.events.length} events)`);
    return;
  }
  const sim = createSim(scenario, data, seed, { events: opt.log ? 'full' : 'summary' });
  const t0 = performance.now();
  const result = runToEnd(sim);
  const ms = performance.now() - t0;
  const bad = checkConservation(sim);
  if (opt.json) emitJson(result);
  else {
    printResult(result);
    if (opt.log) {
      const name = (id: unknown) => (typeof id === 'string' ? sim.byId.get(id)?.name ?? id : '');
      for (const e of sim.events) {
        if (e.type === 'fire' || e.type === 'morale' || e.type === 'skirmishers') continue;
        const who = e.unit ? name(e.unit) : e.side !== undefined ? sim.sides[e.side].name : '';
        let what = e.type;
        if (e.type === 'rout') what = `ROUT (${e.topCause}${e.rootUnit && e.rootUnit !== e.unit ? `, root: ${e.rootCause} on ${name(e.rootUnit)}` : ''})`;
        else if (e.type === 'contact') what = `${e.kind} -> ${name(e.target)}`;
        else if (e.type === 'formation') what = `forms ${e.to} (${e.time}s)`;
        else if (e.type === 'gone') what = `gone (${e.reason})`;
        else if (e.type === 'army_broken') what = 'ARMY BREAKS';
        else if (e.type === 'ammunition') what = String(e.state);
        else if (e.type === 'initiative') what = `${e.commander} acts on his own: ${e.action} (${e.why})`;
        else if (e.type.startsWith('order_') || e.type === 'courier_lost') what = `${e.type.replace('_', ' ')}: ${e.order} -> ${e.formation}${e.own ? ' (own initiative)' : ''}`;
        else if (e.type.startsWith('commander_')) what = `${e.commander} ${e.type === 'commander_down' ? 'is hit' : 'takes command'} (${e.formation})`;
        console.log(`${clock(e.t).padStart(7)}  ${String(who).padEnd(30)} ${what}`);
      }
    }
    console.log(`(${sim.tick} ticks in ${ms.toFixed(0)} ms, state ${result.stateHash})`);
  }
  if (bad.length) {
    console.error('CONSERVATION VIOLATED:\n  ' + bad.join('\n  '));
    process.exitCode = 2;
  }
}

const COMMON: Record<string, OptKind> = { data: 'value' };
const SPECS: Record<string, { opts: Record<string, OptKind>; positionals: number }> = {
  run: { opts: { ...COMMON, seed: 'value', set: 'multi', replay: 'value', log: 'flag', json: 'flag', out: 'value' }, positionals: 1 },
  batch: { opts: { ...COMMON, runs: 'value', seed0: 'value', out: 'value', jobs: 'value', set: 'multi' }, positionals: 1 },
  sweep: { opts: { ...COMMON, runs: 'value', seed0: 'value', out: 'value', jobs: 'value', set: 'multi', param: 'multi' }, positionals: 1 },
  params: { opts: { ...COMMON, confidence: 'value', csv: 'flag', out: 'value' }, positionals: 0 },
  verify: { opts: { ...COMMON }, positionals: 1 },
};

const HELP = `napsim - Napoleonic battalion-level battle simulator

  napsim run <scenario.json> [--seed N] [--set path=value ...] [--log] [--json] [--out result.json] [--replay out.json]
  napsim batch <scenario.json> [--runs N] [--seed0 N] [--out dir] [--jobs N] [--set path=value ...]
  napsim sweep <scenario.json> --param path=v1,v2,... [--param ...] [--runs N] [--out dir]
  napsim params [--confidence assumption] [--csv] [--out file]
  napsim verify <replay.json>

Paths for --param and --set start with data: or scenario:, e.g.
  'data:morale.rippleFriend=4,7,10'      'scenario:sides.french.deploy.cav=0..8..2'
In PowerShell keep the single quotes: unquoted commas are split before napsim sees them.`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }
  const spec = SPECS[cmd];
  if (!spec) throw new Error(`unknown command '${cmd}'\n\n${HELP}`);
  const { pos, opt } = parseArgs(cmd, rest, spec.opts, spec.positionals);
  if (cmd === 'run') cmdRun(pos, opt);
  else {
    const mod = await import('./batch.ts');
    await mod.dispatch(cmd, pos, opt);
  }
}

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

main().catch((e) => {
  // written synchronously so the message is not lost when the process exits (Windows pipes are asynchronous)
  writeSync(2, (e instanceof Error ? e.message : String(e)) + '\n');
  process.exit(1);
});
