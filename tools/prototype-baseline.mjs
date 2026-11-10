// Runs the original prototype's simulation headless to get reference outcome rates per preset.
// Usage: node tools/prototype-baseline.mjs [runs]
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../prototype/index.html', import.meta.url), 'utf8');
const src = html.slice(html.indexOf('/*SIM-START*/'), html.indexOf('/*SIM-END*/'));
const Sim = new Function(src + '\nreturn Sim;')();
const PRESETS = {
  pitched: [{ stance: 'line', inf: 6, cav: 2, art: 2 }, { stance: 'defend', inf: 7, cav: 2, art: 2 }],
  column: [{ stance: 'column', inf: 4, cav: 0, art: 0 }, { stance: 'defend', inf: 4, cav: 0, art: 0 }],
  squares: [{ stance: 'line', inf: 0, cav: 4, art: 2 }, { stance: 'defend', inf: 4, cav: 0, art: 0 }],
  battery: [{ stance: 'line', inf: 3, cav: 1, art: 4 }, { stance: 'defend', inf: 5, cav: 1, art: 1 }],
  counter: [{ stance: 'defend', inf: 7, cav: 2, art: 3 }, { stance: 'line', inf: 6, cav: 2, art: 2 }],
};
const runs = Number(process.argv[2] ?? 200);
const out = {};
for (const [name, sides] of Object.entries(PRESETS)) {
  let fw = 0, aw = 0, none = 0, dur = 0, lf = 0, la = 0;
  for (let seed = 1; seed <= runs; seed++) {
    const s = Sim.create({ seed, frenchAI: true, sides: sides.map((o) => ({ ...o })) });
    while (!s.over && s.t < 900) Sim.step(s, 1 / 30);
    if (!s.over) none++; else if (s.over.loser === 0) aw++; else fw++;
    dur += s.over ? s.over.t : s.t;
    lf += s.lost[0] / s.initMen[0]; la += s.lost[1] / s.initMen[1];
  }
  out[name] = { frenchWin: fw / runs, alliedWin: aw / runs, noDecision: none / runs, meanDurationProtoSec: +(dur / runs).toFixed(1), meanDurationRealMin: +((dur / runs) * 7 / 60).toFixed(1), frenchLoss: +(lf / runs).toFixed(3), alliedLoss: +(la / runs).toFixed(3) };
}
console.log(JSON.stringify(out, null, 1));
