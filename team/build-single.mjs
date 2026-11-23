// Builds one self-contained HTML file for the shared-folder version: node build-single.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const dir = new URL('.', import.meta.url);
const read = p => readFileSync(new URL(p, dir), 'utf8');
const safe = js => js.replace(/<\/script/gi, '<\\/script');
let html = read('index.html');
// fonts: keep Google Fonts link (falls back to system fonts when offline)
// the worker is loaded as a plain script so pdf.js runs it on the main thread (file:// cannot start workers)
html = html.replace('<script src="lib/pdf.min.js"></script>', m => m + '\n<script src="lib/pdf.worker.min.js"></script>');
for (const f of ['lib/pdf.min.js', 'lib/pdf.worker.min.js', 'store-folder.js', 'engine.js', 'adapters.js', 'program.js', 'app.js']) {
  const tag = `<script src="${f}"></script>`;
  if (!html.includes(tag)) throw new Error('missing tag ' + tag);
  html = html.replace(tag, () => `<script>/* ${f} */\n${safe(read(f))}\n</script>`);
}
html = html.replace('<title>בדיקת רתמות — צוות</title>', '<title>בדיקת רתמות — צוות (תיקייה משותפת)</title>');
mkdirSync(new URL('dist/', dir), { recursive: true });
writeFileSync(new URL('dist/harness-qa-team.html', dir), html);
console.log('dist/harness-qa-team.html', (html.length / 1024 / 1024).toFixed(2), 'MB');
