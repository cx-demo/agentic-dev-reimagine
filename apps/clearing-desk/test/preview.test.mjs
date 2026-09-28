import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { createLedger } from '../ledger.mjs';

const run = promisify(execFile);
test('builder produces self-contained, visibly labeled HTML at exact requested destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clearing-preview-'));
  const output = join(directory, 'index.html');
  try {
    await run(process.execPath, [new URL('../build-demo.mjs', import.meta.url).pathname, output]);
    const html = await readFile(output, 'utf8');
    assert.match(html, /<!doctype html>/i);
    assert.match(html, /Standalone preview · browser-only simulated data/);
    assert.match(html, /SIMULATION ONLY/);
    assert.match(html, /merchant-harbor/);
    assert.match(html, /<style>[\s\S]+<\/style>/);
    assert.match(html, /<script type="module">[\s\S]+<\/script>/);
    assert.doesNotMatch(html, /(?:src|href)="(?:https?:|\/)/);
  } finally {
    await rm(directory, { recursive: true });
  }
});

test('preview mock responds without network and clears with balanced entries', async () => {
  const ledger = createLedger();
  const sandbox = {
    __clearingDemo: {
      merchants: ledger.listMerchants(),
      transactions: ledger.listTransactions().transactions.map((transaction) => ledger.detail(transaction.id)),
    },
    Response, URL, structuredClone,
    location: { href: 'file:///preview/index.html' },
    Date, Map, JSON, Number,
  };
  runInNewContext(await readFile(new URL('../demo-mock.mjs', import.meta.url), 'utf8'), sandbox);
  const listed = await (await sandbox.fetch('/api/v1/transactions')).json();
  assert.equal(listed.total, 3);
  const pending = listed.transactions.find((transaction) => transaction.status === 'pending');
  const result = await sandbox.fetch(`/api/v1/transactions/${pending.id}/clear`, {
    method: 'POST', body: '{}',
  });
  assert.equal(result.status, 200);
  const { transaction } = await result.json();
  assert.equal(transaction.status, 'cleared');
  assert.equal(transaction.entries.reduce((sum, entry) => sum + entry.amountMinor, 0), 0);
  assert.equal((await (await sandbox.fetch('/api/v1/transactions?status=pending')).json()).total, 0);
});
