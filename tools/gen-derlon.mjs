// Writes scenarios/derlon.json: the centre of d'Erlon's attack at Waterloo, 18 June 1815.
// Strengths and positions are approximate and from memory unless CALIBRATION.md says otherwise.
import { writeFileSync } from 'node:fs';

const W = 1400, H = 2400;
// 'massed' gives the French battalions the divisional-column doctrine that could not form square; 'ordinary' is the counterfactual.
for (const variant of ['massed', 'ordinary']) {
const INF = variant === 'massed' ? 'fr_battalion_massed' : 'fr_line_battalion';
const LIGHT = variant === 'massed' ? 'fr_battalion_massed' : 'fr_light_battalion';
const CREST = 600;

const fr = { units: [], brigades: {} };
const al = { units: [], brigades: {} };
const add = (side, bde, id, name, type, x, y, men, quality, formation, extra = {}) => {
  side.units.push({ id, name, type, at: [x, y], men, quality, ...(formation ? { formation } : {}), ...extra });
  (side.brigades[bde] ??= []).push(id);
};
const spread = (n, x0, x1) => Array.from({ length: n }, (_, i) => (n === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (n - 1)));

// ---- French I Corps, centre: Donzelot (2nd Division, 9 battalions) and Marcognet (3rd Division, 8 battalions)
const D = 570, M = 510;
[['13e Léger', 3, 'veteran', LIGHT], ['17e de Ligne', 2, 'line', INF]].flatMap(([r, n, q, t]) => Array.from({ length: n }, (_, i) => [r, i + 1, q, t]))
  .forEach(([r, b, q, t], i, a) => add(fr, 'fr-schmitz', `fr-d1-${i + 1}`, `${b}/${r}`, t, spread(a.length, 180, 640)[i], 1450, D, q, 'column'));
[['19e de Ligne', 2], ['51e de Ligne', 2]].flatMap(([r, n]) => Array.from({ length: n }, (_, i) => [r, i + 1]))
  .forEach(([r, b], i, a) => add(fr, 'fr-aulard', `fr-d2-${i + 1}`, `${b}/${r}`, INF, spread(a.length, 220, 600)[i], 1610, D, 'line', 'column'));
[['21e de Ligne', 2], ['46e de Ligne', 2]].flatMap(([r, n]) => Array.from({ length: n }, (_, i) => [r, i + 1]))
  .forEach(([r, b], i, a) => add(fr, 'fr-nogues', `fr-m1-${i + 1}`, `${b}/${r}`, INF, spread(a.length, 780, 1200)[i], 1450, M, 'line', 'column'));
[['25e de Ligne', 2], ['45e de Ligne', 2]].flatMap(([r, n]) => Array.from({ length: n }, (_, i) => [r, i + 1]))
  .forEach(([r, b], i, a) => add(fr, 'fr-grenier', `fr-m2-${i + 1}`, `${b}/${r}`, INF, spread(a.length, 780, 1200)[i], 1610, M, 'line', 'column'));
// part of the grand battery: two 12-pounder and three field batteries
[['heavy_battery', '12-pdr battery, I Corps reserve'], ['foot_battery', 'Battery, 2nd Division'], ['heavy_battery', '12-pdr battery, Guard'], ['foot_battery', 'Battery, 3rd Division'], ['foot_battery', 'Battery, 4th Division']]
  .forEach(([t, name], i) => add(fr, 'fr-battery', `fr-art-${i + 1}`, name, t, spread(5, 200, 1200)[i], 1250, undefined, 'line', null));
// cavalry held back on either flank
spread(4, 60, 60).forEach((x, i) => add(fr, 'fr-travers', `fr-cuir-${i + 1}`, `${['7e', '7e', '12e', '12e'][i]} Cuirassiers, ${i % 2 + 1}${i % 2 ? 'e' : 'er'} esc.`, 'cavalry_squadron', 90 + (i % 2) * 90, 1560 + Math.floor(i / 2) * 70, 135, 'elite', null));
spread(5, 0, 0).forEach((x, i) => add(fr, 'fr-jacquinot', `fr-lanc-${i + 1}`, `${i < 3 ? '3e' : '4e'} Lanciers, ${i < 3 ? i + 1 : i - 2}e esc.`, 'cavalry_squadron', 1230 + (i % 2) * 90, 1540 + Math.floor(i / 2) * 70, 140, 'line', null));

// ---- Allied left centre: Bijlandt on the crest, Picton's two British brigades behind it, the Union Brigade in rear
[['27th Jagers', 'conscript'], ['7th Line (Netherlands)', 'conscript'], ['5th Militia', 'militia'], ['7th Militia', 'militia'], ['8th Militia', 'militia']]
  .forEach(([name, q], i) => add(al, 'al-bijlandt', `al-nl-${i + 1}`, name, 'br_line_battalion', spread(5, 260, 1140)[i], CREST + 15, 480, q, 'line'));
[['1/28th Foot', 557, 'veteran', 'br_line_battalion'], ['1/32nd Foot', 503, 'veteran', 'br_line_battalion'], ['1/79th Highlanders', 445, 'veteran', 'br_line_battalion'], ['1/95th Rifles', 418, 'elite', 'br_rifle_battalion']]
  .forEach(([name, men, q, t], i) => add(al, 'al-kempt', `al-k-${i + 1}`, name, t, spread(4, 620, 200)[i], CREST - 130, men, q, 'line'));
[['3/1st Royal Scots', 453, 'veteran'], ['1/42nd Highlanders', 338, 'veteran'], ['2/44th Foot', 494, 'veteran'], ['1/92nd Highlanders', 422, 'veteran']]
  .forEach(([name, men, q], i) => add(al, 'al-pack', `al-p-${i + 1}`, name, 'br_line_battalion', spread(4, 780, 1200)[i], CREST - 130, men, q, 'line'));
[["Rogers's battery", 480], ["Bijleveld's horse battery", 920]].forEach(([name, x], i) => add(al, i ? 'al-pack' : 'al-kempt', `al-art-${i + 1}`, name, 'foot_battery', x, CREST - 10, undefined, 'line', null));
[['1st Royal Dragoons', 300], ['6th Inniskilling Dragoons', 610], ['2nd Dragoons (Scots Greys)', 920]]
  .forEach(([name, x], r) => [0, 1, 2].forEach((s) => add(al, 'al-union', `al-ub-${r * 3 + s + 1}`, `${name}, ${['1st', '2nd', '3rd'][s]} sqn`, 'cavalry_squadron', x + s * 90, 250, 140, 'elite', null)));

const node = (id, level, name, o = {}) => ({ id, level, commander: { name, ...o } });
const sc = {
  format: 'napsim-scenario', version: 1,
  name: variant === 'massed' ? "D'Erlon's attack, Waterloo, 18 June 1815 (centre)" : "D'Erlon's attack, counterfactual: ordinary battalion columns",
  description: "Donzelot's and Marcognet's divisions of d'Erlon's I Corps attack Wellington's left centre after a bombardment by part of the grand battery. Bijlandt's Netherlands brigade stands on the crest; Kempt's and Pack's brigades of Picton's division lie behind it; the Union Brigade is in reserve. La Haye Sainte and the Papelotte flank are outside the map. The clock starts at 13:00. See CALIBRATION.md.",
  map: {
    width: W, height: H, cellSize: 25,
    hills: [
      { x: 700, y: CREST - 60, rx: 1100, ry: 330, height: 18 },
      { x: 700, y: 1330, rx: 1100, ry: 260, height: 10 },
      { x: 700, y: 2100, rx: 1100, ry: 420, height: 14 },
    ],
    features: [{ type: 'farm', name: 'La Haye Sainte', polygon: [[20, 700], [110, 700], [110, 820], [20, 820]] }],
    labels: [{ text: 'Chemin d’Ohain', at: [1100, CREST - 40] }, { text: 'Mont-Saint-Jean', at: [330, 90] }, { text: 'La Belle Alliance', at: [330, 2290] }],
    roads: [[[70, 0], [60, 700], [75, 1400], [60, H]], [[0, CREST - 20], [500, CREST - 5], [1000, CREST - 15], [W, CREST - 30]]],
  },
  weather: { sky: 'clear', ground: 'mud', windFrom: 250, windSpeed: 3 },
  features: { commandControl: true, fatigue: true, ammunition: true, skirmishers: true, quality: true, elevationLos: true, smoke: true, weatherGround: true },
  timeLimit: 9000,
  objective: { at: [700, CREST], radius: 450, defender: 'allied', name: 'the crest of the Ohain road' },
  sides: [
    {
      id: 'french', name: 'French', color: 'blue', posture: 'attack_column', rear: [0, 1],
      units: fr.units,
      command: {
        ...node('fr-corps', 'corps', "Comte d'Erlon", { at: [700, 1900], initiative: 0.4 }),
        children: [
          { ...node('fr-donzelot', 'division', 'Donzelot', { initiative: 0.5 }), children: [{ ...node('fr-schmitz', 'brigade', 'Schmitz'), units: fr.brigades['fr-schmitz'] }, { ...node('fr-aulard', 'brigade', 'Aulard'), units: fr.brigades['fr-aulard'] }] },
          { ...node('fr-marcognet', 'division', 'Marcognet', { initiative: 0.5 }), children: [{ ...node('fr-nogues', 'brigade', 'Noguès'), units: fr.brigades['fr-nogues'] }, { ...node('fr-grenier', 'brigade', 'Grenier'), units: fr.brigades['fr-grenier'] }] },
          { ...node('fr-battery', 'brigade', 'Grand battery (part)', { radius: 700, initiative: 0.2 }), units: fr.brigades['fr-battery'] },
          { ...node('fr-travers', 'brigade', 'Travers (cuirassiers)', { initiative: 0.6 }), units: fr.brigades['fr-travers'] },
          { ...node('fr-jacquinot', 'brigade', 'Jacquinot (lancers)', { initiative: 0.7 }), units: fr.brigades['fr-jacquinot'] },
        ],
      },
      orders: [
        { at: 0, to: 'fr-donzelot', type: 'hold' },
        { at: 0, to: 'fr-marcognet', type: 'hold' },
        { at: 0, to: 'fr-battery', type: 'defend' },
        { at: 0, to: 'fr-travers', type: 'reserve' },
        { at: 0, to: 'fr-jacquinot', type: 'reserve' },
        { at: 1500, to: 'fr-donzelot', type: 'attack', formation: 'column', objective: [410, CREST] },
        { at: 1500, to: 'fr-marcognet', type: 'attack', formation: 'column', objective: [990, CREST] },
      ],
    },
    {
      id: 'allied', name: 'Allied', color: 'red', posture: 'defend', rear: [0, -1],
      units: al.units,
      command: {
        ...node('al-picton', 'division', 'Sir Thomas Picton', { at: [700, CREST - 220], initiative: 0.8, radius: 900 }),
        children: [
          { ...node('al-bijlandt', 'brigade', 'Bijlandt', { initiative: 0.3, radius: 500 }), units: al.brigades['al-bijlandt'] },
          { ...node('al-kempt', 'brigade', 'Kempt', { initiative: 0.7 }), units: al.brigades['al-kempt'] },
          { ...node('al-pack', 'brigade', 'Pack', { initiative: 0.7 }), units: al.brigades['al-pack'] },
          { ...node('al-union', 'brigade', 'Ponsonby (Union Brigade)', { initiative: 0.9 }), units: al.brigades['al-union'] },
        ],
      },
      orders: [
        { at: 0, to: 'al-picton', type: 'defend' },
        { at: 0, to: 'al-union', type: 'reserve' },
        // Uxbridge's order: the heavy cavalry charges when the French reach the crest
        { when: { enemyWithin: 120, of: 'al-bijlandt' }, to: 'al-union', type: 'attack', formation: 'line', objective: [700, CREST + 120] },
      ],
    },
  ],
};
writeFileSync(new URL(`../scenarios/${variant === 'massed' ? 'derlon' : 'derlon-ordinary-columns'}.json`, import.meta.url), JSON.stringify(sc, null, 2) + '\n');
console.log('wrote derlon:', fr.units.length, 'French units', fr.units.reduce((a, u) => a + (u.men ?? 0), 0), 'men (excl. guns);', al.units.length, 'Allied units', al.units.reduce((a, u) => a + (u.men ?? 0), 0));
}
