// Packs the built interface (packages/ui/dist) into one page for publishing as a claude.ai Artifact.
// The Artifact viewer wraps the page in its own document and allows scripts and stylesheets only
// inline (or from a few CDNs), so the bundle's CSS and JS are inlined. The batch worker stays a
// separate file, published next to the page, because the viewer allows workers from its own files.
//
// Usage: npx vite build packages/ui && node tools/build-artifact.mjs <out dir>
// Writes <out dir>/napoleon.html and <out dir>/<worker file>.js, and prints the worker's name.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = new URL('../packages/ui/dist/', import.meta.url);
const out = process.argv[2];
if (!out) throw new Error('usage: node tools/build-artifact.mjs <out dir>');
mkdirSync(out, { recursive: true });

const html = readFileSync(new URL('index.html', dist), 'utf8');
const assets = readdirSync(new URL('assets/', dist));
const read = (name) => readFileSync(new URL(`assets/${name}`, dist), 'utf8');
const js = assets.find((f) => /^index-.*\.js$/.test(f));
const css = assets.find((f) => /^index-.*\.css$/.test(f));
const worker = assets.find((f) => /^batch-worker-.*\.js$/.test(f));
if (!js || !css || !worker) throw new Error(`dist is incomplete: ${assets.join(', ')}`);

const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
const fonts = html.match(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/)?.[0] ?? '';
const script = read(js).replace(/<\/script/gi, '<\\/script');
// The bundle finds its worker relative to its own URL; inlined, that is the page's URL, which is
// where the worker file is published.
if (!script.includes(`"${worker}"`)) throw new Error(`the bundle does not reference ${worker} as expected`);

const page = `<title>Napoleonic Battle Simulator</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
${fonts}
<style>
${read(css)}
/* Artifact viewer: clear a phone's side system bars as well as its top and bottom ones. */
.wrap{padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
</style>
${body.trim()}
<script type="module">
${script}
</script>
`;
writeFileSync(join(out, 'napoleon.html'), page);
writeFileSync(join(out, worker), read(worker));
console.log(worker);
