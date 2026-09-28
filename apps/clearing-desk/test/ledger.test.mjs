import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger, DomainError, MAX_AMOUNT_MINOR } from '../ledger.mjs';

const transfer = { fromMerchantId: 'merchant-harbor', toMerchantId: 'merchant-summit', amountMinor: 500, currency: 'USD' };
const fails = (code, status = 400) => (error) =>
  error instanceof DomainError && error.code === code && error.status === status;

test('synthetic funding agrees with cleared sample and every status is represented', () => {
  const ledger = createLedger();
  assert.equal(ledger.listMerchants().length, 3);
  const { transactions } = ledger.listTransactions();
  assert.deepEqual(new Set(transactions.map((item) => item.status)), new Set(['pending', 'cleared', 'rejected']));
  const cleared = transactions.find((item) => item.status === 'cleared');
  const entries = ledger.detail(cleared.id).entries;
  assert.equal(entries.length, 2);
  assert.equal(entries.reduce((sum, entry) => sum + entry.amountMinor, 0), 0);
  assert.deepEqual(ledger.listMerchants().map((merchant) => merchant.balanceMinor), [238_000, 192_000, 120_000]);
});

test('creation validates money, USD and distinct existing merchants without state changes', () => {
  const ledger = createLedger();
  for (const amountMinor of [0, -1, 1.2, '100', MAX_AMOUNT_MINOR + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => ledger.create({ ...transfer, amountMinor }, `bad-${amountMinor}`), fails('invalid_amount'));
  }
  for (const currency of [undefined, null, 'EUR']) {
    assert.throws(() => ledger.create({ ...transfer, currency }, 'bad-currency'), fails('invalid_currency'));
  }
  assert.throws(() => ledger.create({ ...transfer, toMerchantId: 'merchant-harbor' }, 'same'), fails('invalid_merchant'));
  assert.throws(() => ledger.create({ ...transfer, toMerchantId: 'unknown' }, 'missing'), fails('merchant_not_found', 404));
  assert.equal(ledger.listTransactions().total, 3);
});

test('idempotent replay returns original creation, even after clearance; conflict never creates another', () => {
  const ledger = createLedger();
  const first = ledger.create(transfer, 'client-key');
  assert.equal(first.replayed, false);
  assert.equal(ledger.listTransactions().total, 4);
  const cleared = ledger.clear(first.transaction.id);
  assert.equal(cleared.status, 'cleared');
  assert.deepEqual(ledger.create({ currency: 'USD', amountMinor: 500, toMerchantId: 'merchant-summit', fromMerchantId: 'merchant-harbor' }, 'client-key'), {
    transaction: first.transaction, replayed: true,
  });
  assert.throws(() => ledger.create({ ...transfer, amountMinor: 600 }, 'client-key'), fails('idempotency_conflict', 409));
  assert.equal(ledger.listTransactions().total, 4);
});

test('clear writes paired balanced entries once; rejection moves no funds', () => {
  const ledger = createLedger();
  const initial = ledger.listMerchants().map((merchant) => merchant.balanceMinor);
  const a = ledger.create(transfer, 'clear').transaction;
  const b = ledger.create(transfer, 'reject').transaction;
  const cleared = ledger.clear(a.id);
  assert.equal(cleared.events.length, 2);
  assert.equal(cleared.entries.length, 2);
  assert.equal(cleared.entries.reduce((sum, entry) => sum + entry.amountMinor, 0), 0);
  assert.throws(() => ledger.clear(a.id), fails('invalid_transition', 409));
  assert.throws(() => ledger.reject(a.id, 'too late'), fails('invalid_transition', 409));
  const rejected = ledger.reject(b.id, 'Invalid destination');
  assert.equal(rejected.entries.length, 0);
  assert.equal(rejected.events[1].reason, 'Invalid destination');
  assert.throws(() => ledger.clear(b.id), fails('invalid_transition', 409));
  assert.deepEqual(ledger.listMerchants().map((merchant) => merchant.balanceMinor), [initial[0] - 500, initial[1], initial[2] + 500]);
});

test('insufficient funds leaves balances, entries, and pending history untouched', () => {
  const ledger = createLedger();
  const pending = ledger.create({ ...transfer, amountMinor: MAX_AMOUNT_MINOR }, 'large').transaction;
  const balances = ledger.listMerchants();
  assert.throws(() => ledger.clear(pending.id), fails('insufficient_funds', 409));
  assert.deepEqual(ledger.listMerchants(), balances);
  assert.deepEqual(ledger.detail(pending.id).events, pending.events);
  assert.equal(ledger.detail(pending.id).entries.length, 0);
});

test('filters, copies, and reset-on-new-instance isolate state', () => {
  const ledger = createLedger();
  const result = ledger.listTransactions({ status: 'pending', merchantId: 'merchant-harbor', limit: 1 });
  assert.equal(result.total, 1);
  result.transactions[0].status = 'cleared';
  assert.equal(ledger.listTransactions({ status: 'pending' }).total, 1);
  assert.throws(() => ledger.listTransactions({ status: 'made-up' }), fails('invalid_filter'));
  assert.throws(() => ledger.reject(ledger.listTransactions({ status: 'pending' }).transactions[0].id, ' '), fails('invalid_reason'));
  ledger.create(transfer, 'ephemeral');
  assert.equal(createLedger().listTransactions().total, 3);
});
