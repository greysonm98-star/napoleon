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
    sides: [
      side('french', 'French', 'blue', f[0], [0, 1], [600, 1300], 'french', f[1], f[2], f[3]),
      side('allied', 'Allied', 'red', a[0], [0, -1], [600, 400], 'allied', a[1], a[2], a[3]),
    ],
  };
  writeFileSync(new URL(`../scenarios/${key}.json`, import.meta.url), JSON.stringify(sc, null, 2) + '\n');
}
console.log('wrote', Object.keys(presets).join(', '));
