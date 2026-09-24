import { randomUUID } from 'node:crypto';

export const MAX_AMOUNT_MINOR = 100_000_000;

export class DomainError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const merchantSeeds = [
  { id: 'merchant-harbor', name: 'Harbor Supply', balanceMinor: 250_000 },
  { id: 'merchant-orchard', name: 'Orchard Market', balanceMinor: 180_000 },
  { id: 'merchant-summit', name: 'Summit Studio', balanceMinor: 120_000 },
];

const copy = (value) => structuredClone(value);

export function createLedger({ now = () => new Date().toISOString(), id = () => `tx_${randomUUID()}` } = {}) {
  const merchants = new Map(merchantSeeds.map((merchant) => [
    merchant.id, { ...merchant, currency: 'USD' },
  ]));
  const transactions = new Map();
  const entries = [];
  const keys = new Map();

  function requireTransaction(transactionId) {
    const transaction = transactions.get(transactionId);
    if (!transaction) throw new DomainError('transaction_not_found', 'Transaction not found', 404);
    return transaction;
  }

  function requireMerchant(merchantId) {
    const merchant = merchants.get(merchantId);
    if (!merchant) throw new DomainError('merchant_not_found', 'Merchant not found', 404);
    return merchant;
  }

  function validateCreate(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((field) => !['fromMerchantId', 'toMerchantId', 'amountMinor', 'currency'].includes(field))) {
      throw new DomainError('invalid_request', 'Provide only fromMerchantId, toMerchantId, amountMinor, and currency');
    }
    if (input.currency !== 'USD') {
      throw new DomainError('invalid_currency', 'Currency must be USD');
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor < 1 || input.amountMinor > MAX_AMOUNT_MINOR) {
      throw new DomainError('invalid_amount', `amountMinor must be an integer from 1 to ${MAX_AMOUNT_MINOR}`);
    }
    if (typeof input.fromMerchantId !== 'string' || typeof input.toMerchantId !== 'string') {
      throw new DomainError('invalid_merchant', 'Select two different merchants');
    }
    requireMerchant(input.fromMerchantId);
    requireMerchant(input.toMerchantId);
    if (input.fromMerchantId === input.toMerchantId) {
      throw new DomainError('invalid_merchant', 'Select two different merchants');
    }
    return {
      fromMerchantId: input.fromMerchantId,
      toMerchantId: input.toMerchantId,
      amountMinor: input.amountMinor,
      currency: input.currency,
    };
  }

  function create(input, key) {
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(key)) {
      throw new DomainError('invalid_idempotency_key', 'Idempotency-Key must be 1 to 128 printable ASCII characters');
    }
    const canonical = validateCreate(input);
    const serialized = JSON.stringify(canonical);
    const previous = keys.get(key);
    if (previous) {
      if (previous.serialized !== serialized) {
        throw new DomainError('idempotency_conflict', 'Idempotency-Key was used for a different transfer', 409);
      }
      return { transaction: copy(previous.original), replayed: true };
    }
    const transactionId = id();
    if (transactions.has(transactionId)) throw new Error('Duplicate transaction ID');
    const timestamp = now();
    const transaction = {
      id: transactionId, ...canonical, status: 'pending', createdAt: timestamp,
      events: [{ status: 'pending', at: timestamp }],
    };
    transactions.set(transaction.id, transaction);
    keys.set(key, { serialized, original: copy(transaction) });
    return { transaction: copy(transaction), replayed: false };
  }

  function clear(transactionId) {
    const transaction = requireTransaction(transactionId);
    if (transaction.status !== 'pending') {
      throw new DomainError('invalid_transition', 'Only pending transactions can be cleared', 409);
    }
    const sender = requireMerchant(transaction.fromMerchantId);
    const recipient = requireMerchant(transaction.toMerchantId);
    if (sender.balanceMinor < transaction.amountMinor) {
      throw new DomainError('insufficient_funds', 'Sender has insufficient simulated balance', 409);
    }
    const timestamp = now();
    sender.balanceMinor -= transaction.amountMinor;
    recipient.balanceMinor += transaction.amountMinor;
    entries.push(
      { transactionId, merchantId: sender.id, amountMinor: -transaction.amountMinor, at: timestamp },
      { transactionId, merchantId: recipient.id, amountMinor: transaction.amountMinor, at: timestamp },
    );
    transaction.status = 'cleared';
    transaction.events.push({ status: 'cleared', at: timestamp });
    return detail(transactionId);
  }

  function reject(transactionId, reason) {
    const transaction = requireTransaction(transactionId);
    if (transaction.status !== 'pending') {
      throw new DomainError('invalid_transition', 'Only pending transactions can be rejected', 409);
    }
    if (typeof reason !== 'string' || reason.trim().length < 1 || reason.trim().length > 240) {
      throw new DomainError('invalid_reason', 'Reason must be 1 to 240 characters');
    }
    transaction.status = 'rejected';
    transaction.events.push({ status: 'rejected', at: now(), reason: reason.trim() });
    return detail(transactionId);
  }

  function detail(transactionId) {
    const transaction = requireTransaction(transactionId);
    return {
      ...copy(transaction),
      entries: copy(entries.filter((entry) => entry.transactionId === transactionId)),
    };
  }

  function listTransactions({ status, merchantId, limit = 100, offset = 0 } = {}) {
    if (status !== undefined && !['pending', 'cleared', 'rejected'].includes(status)) {
      throw new DomainError('invalid_filter', 'Unknown status filter');
    }
    if (merchantId !== undefined) requireMerchant(merchantId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(offset) || offset < 0 || offset > 100_000) {
      throw new DomainError('invalid_filter', 'limit must be 1..100 and offset must be 0..100000');
    }
    const matching = [...transactions.values()].filter((transaction) =>
      (status === undefined || transaction.status === status) &&
      (merchantId === undefined || transaction.fromMerchantId === merchantId || transaction.toMerchantId === merchantId));
    return { transactions: copy(matching.slice(offset, offset + limit)), total: matching.length };
  }

  function seed(input, key, disposition, reason) {
    const transaction = create(input, key).transaction;
    if (disposition === 'cleared') clear(transaction.id);
    if (disposition === 'rejected') reject(transaction.id, reason);
  }

  seed({ fromMerchantId: 'merchant-harbor', toMerchantId: 'merchant-orchard', amountMinor: 12_000, currency: 'USD' }, 'seed-cleared', 'cleared');
  seed({ fromMerchantId: 'merchant-orchard', toMerchantId: 'merchant-summit', amountMinor: 4_200, currency: 'USD' }, 'seed-rejected', 'rejected', 'Sample: details did not match');
  seed({ fromMerchantId: 'merchant-harbor', toMerchantId: 'merchant-summit', amountMinor: 3_500, currency: 'USD' }, 'seed-pending', 'pending');

  return {
    listMerchants: () => copy([...merchants.values()]),
    merchant: (merchantId) => copy(requireMerchant(merchantId)),
    listTransactions, detail, create, clear, reject,
  };
}
