import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createLedger, DomainError } from './ledger.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
]);
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const idPattern = /^[a-z0-9_-]{1,64}$/;

function error(code, message, status = 400) {
  throw new DomainError(code, message, status);
}

function respond(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    error('invalid_request', `Expected object with only: ${allowed.join(', ')}`);
  }
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) {
    error('invalid_content_type', 'Content-Type must be application/json', 415);
  }
  const length = Number(req.headers['content-length']);
  if (req.headers['content-length'] && (!Number.isSafeInteger(length) || length < 0 || length > 4096)) {
    error('invalid_body', 'JSON body must be at most 4096 bytes', 413);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) error('invalid_body', 'JSON body must be at most 4096 bytes', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    error('invalid_json', 'Malformed JSON body');
  }
}

function query(url, allowed = []) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) {
      error('invalid_query', 'Unknown or repeated query parameter');
    }
  }
}

function readId(segment) {
  if (!idPattern.test(segment)) error('invalid_id', 'Invalid resource ID');
  return segment;
}

function authorizeMutation(req, host) {
  if (req.headers['x-clearing-action'] !== '1') {
    error('missing_action_header', 'X-Clearing-Action: 1 is required', 403);
  }
  if (req.headers.origin !== undefined && req.headers.origin !== `http://${host}`) {
    error('invalid_origin', 'Origin must match this local server', 403);
  }
}

async function api(req, res, url, ledger, host) {
  const path = url.pathname;
  if (req.method === 'GET') {
    if (path === '/api/v1/merchants') {
      query(url);
      return respond(res, 200, { merchants: ledger.listMerchants() });
    }
    const merchant = /^\/api\/v1\/merchants\/([^/]+)$/.exec(path);
    if (merchant) {
      query(url);
      return respond(res, 200, { merchant: ledger.merchant(readId(merchant[1])) });
    }
    if (path === '/api/v1/transactions') {
      query(url, ['status', 'merchantId', 'limit', 'offset']);
      const parseBound = (name, fallback) => {
        const raw = url.searchParams.get(name);
        if (raw === null) return fallback;
        if (!/^(0|[1-9]\d{0,5})$/.test(raw)) error('invalid_filter', `Invalid ${name}`);
        return Number(raw);
      };
      return respond(res, 200, ledger.listTransactions({
        status: url.searchParams.get('status') ?? undefined,
        merchantId: url.searchParams.get('merchantId') ?? undefined,
        limit: parseBound('limit', 100),
        offset: parseBound('offset', 0),
      }));
    }
    const transaction = /^\/api\/v1\/transactions\/([^/]+)$/.exec(path);
    if (transaction) {
      query(url);
      return respond(res, 200, { transaction: ledger.detail(readId(transaction[1])) });
    }
  }
  if (req.method === 'POST') {
    if (path === '/api/v1/transactions') {
      query(url);
      authorizeMutation(req, host);
      if (!req.headers['idempotency-key']) {
        error('missing_idempotency_key', 'Idempotency-Key is required');
      }
      const { transaction, replayed } = ledger.create(await jsonBody(req), req.headers['idempotency-key']);
      return respond(res, replayed ? 200 : 201, { transaction, replayed });
    }
    const disposition = /^\/api\/v1\/transactions\/([^/]+)\/(clear|reject)$/.exec(path);
    if (disposition) {
      query(url);
      authorizeMutation(req, host);
      const transactionId = readId(disposition[1]);
      const body = await jsonBody(req);
      fields(body, disposition[2] === 'clear' ? [] : ['reason']);
      return respond(res, 200, { transaction: disposition[2] === 'clear'
        ? ledger.clear(transactionId) : ledger.reject(transactionId, body.reason) });
    }
  }
  if (path === '/api/v1/merchants' || path === '/api/v1/transactions' ||
      /^\/api\/v1\/(?:merchants|transactions)\/[^/]+(?:\/(?:clear|reject))?$/.test(path)) {
    res.setHeader('Allow', path.endsWith('/clear') || path.endsWith('/reject') ? 'POST' :
      path === '/api/v1/transactions' ? 'GET, POST' : 'GET');
    error('method_not_allowed', 'Method not allowed', 405);
  }
  error('not_found', 'Route not found', 404);
}

export async function startServer({ port = 4173, ledger = createLedger(), logger = console } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid port');
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    try {
      const host = req.headers.host;
      const actualPort = server.address().port;
      if (host !== `127.0.0.1:${actualPort}` && host !== `localhost:${actualPort}`) {
        error('invalid_host', 'Host must be this local server', 403);
      }
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname.startsWith('/api/')) return await api(req, res, url, ledger, host);
      if (req.method !== 'GET') error('method_not_allowed', 'Method not allowed', 405);
      query(url);
      const asset = assets.get(url.pathname);
      if (!asset) error('not_found', 'Asset not found', 404);
      const data = await readFile(fileURLToPath(new URL(asset[0], import.meta.url)));
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(data);
    } catch (cause) {
      if (res.headersSent) {
        res.destroy(cause);
      } else if (cause instanceof DomainError) {
        respond(res, cause.status, { error: { code: cause.code, message: cause.message } });
      } else {
        logger.error('Clearing Desk request failed', cause);
        respond(res, 500, { error: { code: 'internal_error', message: 'Internal server error' } });
      }
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (cause) {
    server.close();
    throw cause;
  }
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startServer({ port: Number(process.env.PORT ?? 4173) }).then((server) => {
    console.log(`Simulated Clearing Desk: http://127.0.0.1:${server.address().port}`);
  }).catch((cause) => {
    console.error('Could not start Clearing Desk:', cause);
    process.exitCode = 1;
  });
}
