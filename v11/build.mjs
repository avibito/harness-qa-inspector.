// Builds a single self-contained HTML file: node v11/build.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const read = p => readFileSync(new URL(p, dir), 'utf8');
const html = read('index.html');
const engine = read('engine.js').replace(/<\/script/gi, '<\\/script');
const demo = JSON.stringify(JSON.parse(read('samples/demo.json'))).replace(/<\//g, '<\\/');
const tag = '<script src="engine.js"></script>';
if (!html.includes(tag)) throw new Error('engine script tag not found');
const out = html.replace(tag, () => `<script>\n${engine}\n</script>\n<script>window.DEMO=${demo};</script>`);
mkdirSync(new URL('dist/', dir), { recursive: true });
writeFileSync(new URL('dist/harness_qa_v11_standalone.html', dir), out);
console.log('built dist/harness_qa_v11_standalone.html', out.length, 'bytes');
