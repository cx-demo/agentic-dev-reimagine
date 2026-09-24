import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../server.mjs';

const transfer = { fromMerchantId: 'merchant-harbor', toMerchantId: 'merchant-summit', amountMinor: 500, currency: 'USD' };
const withServer = async (fn) => {
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};
const action = (body, extra = {}) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Clearing-Action': '1', ...extra },
  body: JSON.stringify(body),
});
async function response(base, path, options) {
  const res = await fetch(`${base}${path}`, options);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

test('API lists merchants, filters paginated transactions, and returns detailed ledger entries', () => withServer(async (base) => {
  const merchants = await response(base, '/api/v1/merchants');
  assert.equal(merchants.status, 200);
  assert.equal(merchants.body.merchants.length, 3);
  assert.equal(merchants.headers.get('cache-control'), 'no-store');
  const merchantId = merchants.body.merchants[0].id;
  assert.equal((await response(base, `/api/v1/merchants/${merchantId}`)).body.merchant.id, merchantId);
  const page = await response(base, '/api/v1/transactions?status=cleared&limit=1&offset=0');
  assert.equal(page.body.total, 1);
  assert.equal(page.body.transactions.length, 1);
  const detail = await response(base, `/api/v1/transactions/${page.body.transactions[0].id}`);
  assert.equal(detail.body.transaction.entries.length, 2);
  assert.equal((await response(base, '/api/v1/transactions?merchantId=merchant-summit')).body.total, 2);
}));

test('API lifecycle, original replay, conservation, and concurrent clears', () => withServer(async (base) => {
  const before = (await response(base, '/api/v1/merchants')).body.merchants;
  const created = await response(base, '/api/v1/transactions', action(transfer, { 'Idempotency-Key': 'test-create' }));
  assert.equal(created.status, 201);
  assert.equal(created.body.transaction.status, 'pending');
  const id = created.body.transaction.id;
  const attempts = await Promise.all([
    response(base, `/api/v1/transactions/${id}/clear`, action({})),
    response(base, `/api/v1/transactions/${id}/clear`, action({})),
  ]);
  assert.deepEqual(attempts.map((attempt) => attempt.status).sort(), [200, 409]);
  assert.equal((await response(base, `/api/v1/transactions/${id}`)).body.transaction.entries.length, 2);
  const after = (await response(base, '/api/v1/merchants')).body.merchants;
  assert.equal(after.reduce((sum, merchant) => sum + merchant.balanceMinor, 0), before.reduce((sum, merchant) => sum + merchant.balanceMinor, 0));
  assert.equal(after[0].balanceMinor, before[0].balanceMinor - 500);
  const replay = await response(base, '/api/v1/transactions', action(transfer, { 'Idempotency-Key': 'test-create' }));
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, { transaction: created.body.transaction, replayed: true });
  const conflict = await response(base, '/api/v1/transactions', action({ ...transfer, amountMinor: 501 }, { 'Idempotency-Key': 'test-create' }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'idempotency_conflict');
  const rejected = await response(base, '/api/v1/transactions', action(transfer, { 'Idempotency-Key': 'test-reject' }));
  assert.equal((await response(base, `/api/v1/transactions/${rejected.body.transaction.id}/reject`, action({ reason: 'Demo reason' }))).body.transaction.status, 'rejected');
}));

test('invalid input yields explicit bounded errors without mutations', () => withServer(async (base) => {
  const check = async (path, options, status, code) => {
    const result = await response(base, path, options);
    assert.equal(result.status, status);
    assert.equal(result.body.error.code, code);
  };
  const path = '/api/v1/transactions';
  await check(path, action(transfer), 400, 'missing_idempotency_key');
  for (const currency of [undefined, null, 'EUR']) {
    await check(path, action({ ...transfer, currency }, { 'Idempotency-Key': 'wrong' }), 400, 'invalid_currency');
  }
  for (const amountMinor of [0, 1.5, '100', 100_000_001]) {
    await check(path, action({ ...transfer, amountMinor }, { 'Idempotency-Key': 'wrong' }), 400, 'invalid_amount');
  }
  await check(path, action({ ...transfer, toMerchantId: 'merchant-harbor' }, { 'Idempotency-Key': 'wrong' }), 400, 'invalid_merchant');
  await check(path, action({ ...transfer, toMerchantId: 'unknown' }, { 'Idempotency-Key': 'wrong' }), 404, 'merchant_not_found');
  await check(path, { ...action(transfer, { 'Idempotency-Key': 'wrong' }), body: '{' }, 400, 'invalid_json');
  await check(path, { ...action(transfer, { 'Idempotency-Key': 'wrong' }), body: JSON.stringify({ ...transfer, extra: 'x'.repeat(4096) }) }, 413, 'invalid_body');
  await check(path, { ...action(transfer, { 'Idempotency-Key': 'wrong' }), headers: { 'X-Clearing-Action': '1', 'Idempotency-Key': 'wrong', 'Content-Type': 'text/plain' } }, 415, 'invalid_content_type');
  await check('/api/v1/transactions?status=pending&status=cleared', undefined, 400, 'invalid_query');
  await check('/api/v1/transactions?limit=101', undefined, 400, 'invalid_filter');
  await check('/api/v1/transactions?offset=-1', undefined, 400, 'invalid_filter');
  await check('/api/v1/transactions?unknown=1', undefined, 400, 'invalid_query');
  await check('/api/v1/transactions/missing', undefined, 404, 'transaction_not_found');
  await check('/api/v1/transactions', { method: 'PUT' }, 405, 'method_not_allowed');
  assert.equal((await response(base, path)).body.total, 3);
}));

test('loopback Host, Origin, action header, and static allowlist enforce local boundary', () => withServer(async (base) => {
  const check = async (path, options, status, code) => {
    const result = await response(base, path, options);
    assert.equal(result.status, status);
    assert.equal(result.body.error.code, code);
  };
  const hostileHost = await new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = http.get({ hostname: url.hostname, port: url.port, path: '/api/v1/transactions', headers: { Host: 'attacker.example' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { body += part; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
  });
  assert.equal(hostileHost.status, 403);
  assert.equal(hostileHost.body.error.code, 'invalid_host');
  await check('/api/v1/transactions', { ...action(transfer, { 'Idempotency-Key': 'bad-origin', Origin: 'http://attacker.example' }) }, 403, 'invalid_origin');
  await check('/api/v1/transactions', { ...action(transfer, { 'Idempotency-Key': 'no-action' }), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'no-action' } }, 403, 'missing_action_header');
  await check('/../package.json', undefined, 404, 'not_found');
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SIMULATION ONLY/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(page.headers.get('access-control-allow-origin'), null);
  assert.equal((await fetch(`${base}/app.mjs`)).status, 200);
}));

test('new server starts with disposable seed, no prior client keys', () => withServer(async (base) => {
  assert.equal((await response(base, '/api/v1/transactions', action(transfer, { 'Idempotency-Key': 'fresh' }))).status, 201);
  await withServer(async (fresh) => {
    assert.equal((await response(fresh, '/api/v1/transactions')).body.total, 3);
    assert.equal((await response(fresh, '/api/v1/transactions', action(transfer, { 'Idempotency-Key': 'fresh' }))).status, 201);
  });
}));
