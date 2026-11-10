// Writes the five prototype presets as scenario files. Run: node tools/gen-presets.mjs
import { writeFileSync } from 'node:fs';

const ellipse = (cx, cy, rx, ry, n = 14) => Array.from({ length: n }, (_, i) => {
  const a = (i / n) * Math.PI * 2;
  return [Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry)];
});

const map = () => ({
  width: 1200, height: 1700, cellSize: 25,
  hills: [{ x: 600, y: 380, rx: 580, ry: 170, height: 22 }],
  features: [
    { type: 'wood', name: 'Bois du Loup', polygon: ellipse(250, 850, 110, 150) },
    { type: 'farm', name: 'Ferme de la Haie', polygon: [[720, 760], [840, 760], [840, 855], [720, 855]] },
  ],
  labels: [{ text: 'Hauteur de Belle-Vue', at: [850, 290] }],
  roads: [[[530, 1700], [500, 1300], [590, 800], [565, 0]]],
});

const side = (id, name, color, posture, rear, centre, roster, inf, cav, art) => ({
  id, name, color, posture, rear,
  deploy: { centre, inf, cav, art, roster, types: { inf: id === 'french' ? 'fr_line_battalion' : 'br_line_battalion', cav: 'cavalry_squadron', art: 'foot_battery' } },
});

const presets = {
  pitched: ['Pitched battle', 'French attack in line against an Allied army defending a ridge. Prototype preset "Pitched battle".', ['attack_line', 6, 4, 2], ['defend', 7, 4, 2]],
  column: ['Column against line', 'Four French battalions attack in column against four Allied battalions in line on the ridge. Prototype preset "Column against line".', ['attack_column', 4, 0, 0], ['defend', 4, 0, 0]],
  squares: ['Cavalry against squares', 'French cavalry and guns against Allied infantry alone. Prototype preset "Cavalry against squares".', ['attack_line', 0, 8, 2], ['defend', 4, 0, 0]],
  battery: ['The grand battery', 'A French force strong in guns attacks a ridge. Prototype preset "The grand battery".', ['attack_line', 3, 2, 4], ['defend', 5, 2, 1]],
  counter: ['Allied counterattack', 'The Allies come down off the ridge against a French defence. Prototype preset "Allied counterattack".', ['defend', 7, 4, 3], ['attack_line', 6, 4, 2]],
};

for (const [key, [name, description, f, a]] of Object.entries(presets)) {
  const sc = {
    format: 'napsim-scenario', version: 1, name, description,
    map: map(),
    weather: { sky: 'clear', ground: 'firm', windFrom: 270, windSpeed: 3 },
    features: { commandControl: false, fatigue: false, ammunition: false, skirmishers: false, quality: false, elevationLos: false, smoke: false, weatherGround: false },
    timeLimit: 7200,
    objective: key === 'counter' ? { at: [600, 1300], radius: 350, defender: 'french', name: 'the French position' } : { at: [600, 400], radius: 350, defender: 'allied', name: 'the ridge' },
    sides: [
      side('french', 'French', 'blue', f[0], [0, 1], [600, 1300], 'french', f[1], f[2], f[3]),
      side('allied', 'Allied', 'red', a[0], [0, -1], [600, 400], 'allied', a[1], a[2], a[3]),
    ],
  };
  writeFileSync(new URL(`../scenarios/${key}.json`, import.meta.url), JSON.stringify(sc, null, 2) + '\n');
}
// The pitched battle again, but run from written orders through a chain of command.
{
  const f = side('french', 'French', 'blue', 'attack_column', [0, 1], [600, 1300], 'french', 6, 4, 2);
  f.command = {
    id: 'fr-corps', level: 'corps', commander: { name: 'Général de corps', at: [600, 1560], initiative: 0.5 },
    children: [
      { id: 'fr-div', level: 'division', commander: { name: 'Général de division', initiative: 0.5 }, children: [
        { id: 'fr-bde-1', level: 'brigade', commander: { name: 'Brigade A', initiative: 0.6 }, units: ['french-inf-1', 'french-inf-2', 'french-inf-3'] },
        { id: 'fr-bde-2', level: 'brigade', commander: { name: 'Brigade B', initiative: 0.4 }, units: ['french-inf-4', 'french-inf-5', 'french-inf-6'] },
      ] },
      { id: 'fr-cav', level: 'brigade', commander: { name: 'Cavalerie', initiative: 0.7 }, units: ['french-cav-1', 'french-cav-2', 'french-cav-3', 'french-cav-4'] },
      { id: 'fr-guns', level: 'brigade', commander: { name: 'Artillerie', initiative: 0.3 }, units: ['french-art-1', 'french-art-2'] },
    ],
  };
  f.orders = [
    { at: 0, to: 'fr-div', type: 'hold' },
    { at: 0, to: 'fr-cav', type: 'reserve' },
    { at: 0, to: 'fr-guns', type: 'attack' },
    { at: 600, to: 'fr-div', type: 'attack', formation: 'column', objective: [600, 420] },
    { when: { formationBroken: 'al-bde-1' }, to: 'fr-cav', type: 'attack' },
  ];
  const a = side('allied', 'Allied', 'red', 'defend', [0, -1], [600, 400], 'allied', 7, 4, 2);
  a.command = {
    id: 'al-hq', level: 'corps', commander: { name: 'Lieutenant-General', at: [600, 150], initiative: 0.5 },
    children: [
      { id: 'al-bde-1', level: 'brigade', commander: { name: 'First Brigade', initiative: 0.6 }, units: ['allied-inf-1', 'allied-inf-2', 'allied-inf-3', 'allied-art-1'] },
      { id: 'al-bde-2', level: 'brigade', commander: { name: 'Second Brigade', initiative: 0.5 }, units: ['allied-inf-4', 'allied-inf-5', 'allied-art-2'] },
      { id: 'al-bde-3', level: 'brigade', commander: { name: 'Reserve Brigade', initiative: 0.5 }, units: ['allied-inf-6', 'allied-inf-7'] },
      { id: 'al-cav', level: 'brigade', commander: { name: 'Cavalry', initiative: 0.8 }, units: ['allied-cav-1', 'allied-cav-2', 'allied-cav-3', 'allied-cav-4'] },
    ],
  };
  a.orders = [
    { at: 0, to: 'al-hq', type: 'defend' },
    { at: 0, to: 'al-cav', type: 'reserve' },
    { at: 0, to: 'al-bde-3', type: 'reserve' },
    { when: { formationBroken: 'al-bde-1' }, to: 'al-bde-3', type: 'attack', formation: 'line', objective: [420, 420] },
  ];
  const sc = {
    format: 'napsim-scenario', version: 1, name: 'Pitched battle from written orders',
    description: 'The pitched battle run through a chain of command. The French guns bombard for ten minutes, then the infantry division is ordered to attack in column; the cavalry is held until the Allied first brigade breaks. The Allies defend with a brigade and their cavalry in reserve.',
    map: map(), weather: { sky: 'clear', ground: 'firm', windFrom: 270, windSpeed: 3 },
    features: { commandControl: true, fatigue: false, ammunition: false, skirmishers: false, quality: false, elevationLos: false, smoke: false, weatherGround: false },
    timeLimit: 7200, objective: { at: [600, 400], radius: 350, defender: 'allied', name: 'the ridge' }, sides: [f, a],
  };
  writeFileSync(new URL('../scenarios/pitched-orders.json', import.meta.url), JSON.stringify(sc, null, 2) + '\n');
}
console.log('wrote', Object.keys(presets).join(', '), 'and pitched-orders');
