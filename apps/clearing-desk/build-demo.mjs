import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger } from './ledger.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const output = resolve(process.argv[2] ?? 'demo/index.html');
const [html, styles, app, mock] = await Promise.all([
  'index.html', 'styles.css', 'app.mjs', 'demo-mock.mjs',
].map((name) => readFile(resolve(directory, name), 'utf8')));
const ledger = createLedger();
const seed = JSON.stringify({
  merchants: ledger.listMerchants(),
  transactions: ledger.listTransactions().transactions.map((transaction) => ledger.detail(transaction.id)),
}).replaceAll('<', '\\u003c');

const document = html
  .replace('<link rel="stylesheet" href="/styles.css">', `<style>${styles}</style>`)
  .replace('<script type="module" src="/app.mjs"></script>',
    `<script>globalThis.__clearingDemo=${seed};</script><script>${mock}</script><script type="module">${app.replaceAll('crypto.randomUUID()', '`preview-${Date.now()}-${Math.random()}`')}</script>`)
  .replace('<main>', '<main><p class="notice" role="status">Standalone preview · browser-only simulated data. Actions reset on reload; run Node server for actual API and in-memory ledger.</p>');

await mkdir(dirname(output), { recursive: true });
await writeFile(output, document, 'utf8');
console.log(`Wrote self-contained preview: ${output}`);
