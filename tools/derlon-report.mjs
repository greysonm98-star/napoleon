// Summarises a batch of scenarios/derlon.json by formation, for CALIBRATION.md.
// Usage: napsim batch scenarios/derlon.json --runs 200 --out out/derlon && node tools/derlon-report.mjs out/derlon
import { readFileSync } from 'node:fs';
const dir = process.argv[2] ?? 'out/derlon';
const read = (f) => {
  const [head, ...rows] = readFileSync(`${dir}/${f}`, 'utf8').trim().split('\n').map((l) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')));
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
};
const units = read('units.csv'), runs = read('runs.csv'), routs = read('routs.csv');
const points = [...new Set(runs.map((r) => r.point))];
const q = (xs, p) => { const s = xs.slice().sort((a, b) => a - b); const i = (s.length - 1) * p; return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i)); };
const pct = (v) => (v * 100).toFixed(0) + '%';
const GROUPS = {
  'French infantry (Donzelot, Marcognet)': (u) => /^fr-(schmitz|aulard|nogues|grenier)$/.test(u.formation),
  'Bijlandt': (u) => u.formation === 'al-bijlandt',
  'Kempt and Pack (infantry)': (u) => /^al-(kempt|pack)$/.test(u.formation) && u.arm === 'inf',
  'Union Brigade': (u) => u.formation === 'al-union',
  'French cavalry': (u) => /^fr-(travers|jacquinot)$/.test(u.formation),
  'Grand battery crews': (u) => u.formation === 'fr-battery',
};
for (const p of points) {
  const rs = runs.filter((r) => r.point === p);
  const us = units.filter((u) => u.point === p);
  console.log(`\npoint ${p}: ${rs.length} runs`);
  console.log(`  ridge held by the Allies at the end: ${pct(rs.filter((r) => r.winner === 'allied').length / rs.length)}; duration median ${(q(rs.map((r) => +r.duration_s), 0.5) / 60).toFixed(0)} min`);
  for (const [name, f] of Object.entries(GROUPS)) {
    const per = new Map();
    for (const u of us.filter(f)) {
      const a = per.get(u.seed) ?? { start: 0, kw: 0, pris: 0, disp: 0, routed: 0, n: 0 };
      a.start += +u.men_start; a.kw += +u.killed_wounded; a.pris += +u.prisoners; a.disp += +u.dispersed; a.routed += +u.ever_routed; a.n++;
      per.set(u.seed, a);
    }
    const v = [...per.values()];
    if (!v.length) continue;
    const m = (f2) => q(v.map(f2), 0.5);
    console.log(`  ${name.padEnd(40)} ${String(v[0].start).padStart(5)} men  K/W ${pct(m((a) => a.kw / a.start)).padStart(4)}  prisoners ${pct(m((a) => a.pris / a.start)).padStart(4)}  dispersed ${pct(m((a) => a.disp / a.start)).padStart(4)}  total ${pct(m((a) => (a.kw + a.pris + a.disp) / a.start)).padStart(4)} (p10 ${pct(q(v.map((a) => (a.kw + a.pris + a.disp) / a.start), 0.1))}, p90 ${pct(q(v.map((a) => (a.kw + a.pris + a.disp) / a.start), 0.9))})  units routed ${m((a) => a.routed).toFixed(0)}/${v[0].n}`);
  }
  const rr = routs.filter((r) => r.point === p && r.kind !== 'army_broken');
  const firstFr = rs.map((r) => Math.min(...rr.filter((x) => x.seed === r.seed && x.side === 'french').map((x) => +x.t_s), Infinity)).filter(isFinite);
  const lastFr = rs.map((r) => Math.max(...rr.filter((x) => x.seed === r.seed && x.side === 'french' && /^fr-[dm]/.test(x.unit)).map((x) => +x.t_s), -Infinity)).filter(isFinite);
  const cav = rs.map((r) => rr.filter((x) => x.seed === r.seed && /^al-ub/.test(x.unit)).length);
  const byCause = {};
  for (const x of rr.filter((x) => /^fr-[dm]/.test(x.unit))) byCause[x.top_cause] = (byCause[x.top_cause] ?? 0) + 1;
  console.log(`  first French rout: median ${(q(firstFr, 0.5) / 60).toFixed(0)} min; last French infantry rout: median ${(q(lastFr, 0.5) / 60).toFixed(0)} min after 13:00`);
  console.log(`  Union Brigade squadrons routed per run: median ${q(cav, 0.5)}`);
  console.log('  French infantry routs by top cause: ' + Object.entries(byCause).sort((a, b) => b[1] - a[1]).map(([k, v2]) => `${k} ${(v2 / rs.length).toFixed(1)}/run`).join(', '));
}
