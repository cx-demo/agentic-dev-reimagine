// Browser-only mock used by build-demo.mjs; never loaded by the real server.
const demoMerchants = globalThis.__clearingDemo.merchants;
const demoTransactions = globalThis.__clearingDemo.transactions;
const demoKeys = new Map();
let demoCounter = 0;
const demoCopy = (value) => structuredClone(value);

function demoReply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function demoFailure(code, message, status = 400) {
  return demoReply({ error: { code, message } }, status);
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input, globalThis.location.href);
  const path = url.pathname.replace(/^.*\/api\/v1/, '');
  const method = options.method ?? 'GET';
  if (method === 'GET' && path === '/merchants') return demoReply({ merchants: demoCopy(demoMerchants) });
  if (method === 'GET' && path === '/transactions') {
    const status = url.searchParams.get('status');
    const filtered = demoTransactions.filter((item) => !status || item.status === status);
    return demoReply({
      transactions: demoCopy(filtered.slice(Number(url.searchParams.get('offset') ?? 0), Number(url.searchParams.get('offset') ?? 0) + Number(url.searchParams.get('limit') ?? 100))),
      total: filtered.length,
    });
  }
  const detail = /^\/transactions\/([^/]+)$/.exec(path);
  if (method === 'GET' && detail) {
    const item = demoTransactions.find((transaction) => transaction.id === detail[1]);
    return item ? demoReply({ transaction: demoCopy(item) }) : demoFailure('transaction_not_found', 'Transaction not found', 404);
  }
  if (method !== 'POST') return demoFailure('not_found', 'Unknown preview route', 404);
  const body = JSON.parse(options.body);
  if (path === '/transactions') {
    const key = options.headers['Idempotency-Key'];
    const canonical = JSON.stringify(body);
    const old = demoKeys.get(key);
    if (old) return old.canonical === canonical
      ? demoReply({ transaction: demoCopy(old.original), replayed: true })
      : demoFailure('idempotency_conflict', 'Idempotency-Key was used for a different transfer', 409);
    const transaction = {
      id: `tx_preview_${++demoCounter}`, ...body, status: 'pending', createdAt: new Date().toISOString(),
      events: [{ status: 'pending', at: new Date().toISOString() }], entries: [],
    };
    demoTransactions.push(transaction);
    demoKeys.set(key, { canonical, original: demoCopy(transaction) });
    return demoReply({ transaction: demoCopy(transaction), replayed: false }, 201);
  }
  const action = /^\/transactions\/([^/]+)\/(clear|reject)$/.exec(path);
  if (!action) return demoFailure('not_found', 'Unknown preview route', 404);
  const item = demoTransactions.find((transaction) => transaction.id === action[1]);
  if (!item) return demoFailure('transaction_not_found', 'Transaction not found', 404);
  if (item.status !== 'pending') return demoFailure('invalid_transition', 'Only pending transactions can be changed', 409);
  const timestamp = new Date().toISOString();
  if (action[2] === 'clear') {
    const sender = demoMerchants.find((merchant) => merchant.id === item.fromMerchantId);
    const recipient = demoMerchants.find((merchant) => merchant.id === item.toMerchantId);
    if (sender.balanceMinor < item.amountMinor) return demoFailure('insufficient_funds', 'Sender has insufficient simulated balance', 409);
    sender.balanceMinor -= item.amountMinor;
    recipient.balanceMinor += item.amountMinor;
    item.entries.push(
      { transactionId: item.id, merchantId: sender.id, amountMinor: -item.amountMinor, at: timestamp },
      { transactionId: item.id, merchantId: recipient.id, amountMinor: item.amountMinor, at: timestamp },
    );
    item.status = 'cleared';
  } else {
    item.status = 'rejected';
  }
  item.events.push({ status: item.status, at: timestamp, ...(item.status === 'rejected' ? { reason: body.reason } : {}) });
  return demoReply({ transaction: demoCopy(item) });
};
