#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { checkConservation, createSim, recordRun, runToEnd } from '@napoleon/engine';
import type { RunResult } from '@napoleon/engine';
import { loadData, loadScenario } from './load.ts';

function parseArgs(argv: string[]): { pos: string[]; opt: Record<string, string[]> } {
  const pos: string[] = [];
  const opt: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const val = next !== undefined && !next.startsWith('--') ? argv[++i] : 'true';
      (opt[key] ??= []).push(val);
    } else pos.push(a);
  }
  return { pos, opt };
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const pct = (v: number) => (v * 100).toFixed(1) + '%';

export function printResult(r: RunResult): void {
  console.log(`${r.scenario}  seed ${r.seed}`);
  console.log(`Result: ${r.winner === 'draw' ? 'no decision' : r.winner + ' win'} (${r.endReason}${r.decidedBy === 'objective' ? ', decided by the objective' : ''}) after ${clock(r.duration)}`);
  for (const s of r.sides) {
    console.log(`  ${s.name.padEnd(8)} ${s.posture.padEnd(13)} ${String(s.startMen).padStart(6)} men  K/W ${String(s.casualties).padStart(5)} (${pct(s.casualtyFraction)})  prisoners ${String(s.captured).padStart(4)}  dispersed ${String(s.dispersed).padStart(5)}  units routed ${s.unitsEverRouted}/${s.units}${s.broke ? `  BROKE at ${clock(s.brokeAt!)} near (${s.breakX}, ${s.breakY})` : ''}`);
  }
}

function cmdRun(pos: string[], opt: Record<string, string[]>): void {
  const scenarioPath = pos[0];
  if (!scenarioPath) throw new Error('usage: napsim run <scenario.json> [--seed N] [--replay out.json] [--log] [--json]');
  const { data } = loadData(opt.data?.[0]);
  const scenario = loadScenario(scenarioPath);
  const seed = Number(opt.seed?.[0] ?? 1);
  if (opt.replay) {
    const rep = recordRun(scenario, data, seed);
    writeFileSync(opt.replay[0], JSON.stringify(rep));
    if (opt.json) console.log(JSON.stringify(rep.result, null, 2));
    else printResult(rep.result);
    console.log(`replay written to ${opt.replay[0]} (${rep.times.length} samples, ${rep.events.length} events)`);
    return;
  }
  const sim = createSim(scenario, data, seed, { events: opt.log ? 'full' : 'summary' });
  const t0 = performance.now();
  const result = runToEnd(sim);
  const ms = performance.now() - t0;
  const bad = checkConservation(sim);
  if (opt.json) console.log(JSON.stringify(result, null, 2));
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

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  switch (cmd) {
    case 'run':
      cmdRun(pos, opt);
      break;
    case 'batch':
    case 'sweep':
    case 'params':
    case 'verify': {
      const mod = await import('./batch.ts');
      await mod.dispatch(cmd, pos, opt);
      break;
    }
    default:
      console.log(`napsim - Napoleonic battalion-level battle simulator

  napsim run <scenario.json> [--seed N] [--log] [--json] [--replay out.json]
  napsim batch <scenario.json> [--runs N] [--seed0 N] [--out dir] [--jobs N] [--set path=value ...]
  napsim sweep <scenario.json> --param path=v1,v2,... [--param ...] [--runs N] [--out dir]
  napsim params [--confidence assumption] [--csv]
  napsim verify <replay.json>

Paths for --param and --set start with data: or scenario:, e.g.
  data:morale.rippleFriend=4,7,10      scenario:sides.0.deploy.cav=0..8..2`);
  }
}

process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
});

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
