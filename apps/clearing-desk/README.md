# Clearing Desk — local simulation

Node 20+; no installation or external services. Start from repository root:

```sh
node apps/clearing-desk/server.mjs
```

Open `http://127.0.0.1:4173`. Set `PORT` to another local port if needed; occupied/invalid ports fail instead of choosing another. Run tests with `node --test apps/clearing-desk/test/*.test.mjs`. The UI and API use same origin; nothing is stored in browser storage, files, or a database. Restarting server **discards** all changes and restores synthetic sample merchants and one transfer each in pending, cleared, and rejected states. Initial cleared transfer debits/credits the same balances displayed in the UI.

**Simulation only.** No real money, card data, bank calls, settlement, login, multi-operator coordination, persistent audit trail, or compliance attestation. Server binds only to `127.0.0.1` and checks Host. Any local process can call the API; action header, matching Origin when supplied, strict static allowlist, and CSP reduce accidental browser cross-site access but **do not authenticate users**. Never publish this app to a network interface or use it for actual payments.

## API

All paths begin with `/api/v1`. Responses are JSON, non-cacheable, and use integer USD **cents** (`amountMinor` range **1–100000000**, $0.01–$1,000,000). Merchant IDs: `merchant-harbor`, `merchant-orchard`, `merchant-summit`. Transactions use generated opaque IDs. Read routes:

| Method | Path | Response |
| --- | --- | --- |
| GET | `/merchants` | `{ "merchants": [{ "id", "name", "balanceMinor", "currency" }] }` |
| GET | `/merchants/{id}` | `{ "merchant": { "id", "name", "balanceMinor", "currency" } }` |
| GET | `/transactions?status=pending&merchantId=merchant-harbor&limit=20&offset=0` | `{ "transactions": [...], "total": 1 }` |
| GET | `/transactions/{id}` | `{ "transaction": { ..., "events": [...], "entries": [...] } }` |

All query parameters are optional. `status` is `pending`, `cleared`, or `rejected`; `merchantId` filters transfers in either direction. `limit` is 1–100 (default 100), `offset` is 0–100000 (default 0). Lists retain creation order. UI pages through results and filters search text locally.

Mutations require `Content-Type: application/json`, `X-Clearing-Action: 1`, and, if an `Origin` header is present, exact same-origin `http://127.0.0.1:4173` (or `http://localhost:4173`, adjusted to actual port). Create also requires an `Idempotency-Key` of 1–128 printable ASCII characters. Reusing the key with identical request fields returns original creation snapshot (`200`, `replayed: true`) without another transaction, including if status has since changed. Reusing it for a different transfer gives `409 idempotency_conflict`. Keys reset on server restart.

```sh
curl -i http://127.0.0.1:4173/api/v1/transactions \
  -H 'Content-Type: application/json' -H 'X-Clearing-Action: 1' \
  -H 'Idempotency-Key: my-demo-001' \
  -d '{"fromMerchantId":"merchant-harbor","toMerchantId":"merchant-summit","amountMinor":500,"currency":"USD"}'
```

New create returns `201`:

```json
{"transaction":{"id":"tx_<generated>","fromMerchantId":"merchant-harbor","toMerchantId":"merchant-summit","amountMinor":500,"currency":"USD","status":"pending","createdAt":"<UTC ISO timestamp>","events":[{"status":"pending","at":"<UTC ISO timestamp>"}]},"replayed":false}
```

Set `TX_ID` to returned `id`, then run **one** of these commands to clear or reject (each responds `200` with `{ "transaction": { ... } }`):

```sh
TX_ID='tx_replace_with_returned_id'
curl -i "http://127.0.0.1:4173/api/v1/transactions/$TX_ID/clear" \
  -H 'Content-Type: application/json' -H 'X-Clearing-Action: 1' -d '{}'
curl -i "http://127.0.0.1:4173/api/v1/transactions/$TX_ID/reject" \
  -H 'Content-Type: application/json' -H 'X-Clearing-Action: 1' \
  -d '{"reason":"Mismatch in simulated request"}'
```

Clear checks sufficient sender balance synchronously before changing state, then posts paired debit/credit entries (`amountMinor: -500` and `+500`) with same transaction ID and timestamp and appends a cleared event. Reject appends an event with reason (1–240 trimmed characters), no entries or balance movement. Only pending transfers can change status. `409 insufficient_funds` leaves pending state intact; double-clear and other terminal transitions return `409 invalid_transition`.

Errors use `{ "error": { "code": "invalid_amount", "message": "..." } }`. Missing create key is distinct `400 missing_idempotency_key`; missing, null, or unsupported currency is `400 invalid_currency`. Other validation and invalid filters yield `400`; oversized JSON yields `413`, wrong content type `415`, missing resource `404`, unsupported method `405`, unexpected internal errors `500` (logged server-side). JSON body limit is 4096 bytes; unknown fields and repeated/unknown query parameters are rejected.

## Standalone Flow Loop preview

Generate a self-contained HTML preview with:

```sh
node apps/clearing-desk/build-demo.mjs /path/to/demo/index.html
```

Preview embeds CSS, UI JavaScript, synthetic seed, and a **browser-only mock** of the API; no network or actual server involved. Preview actions change its page-local simulated data and reset on reload, unlike live app's server-owned in-memory state (which resets on server restart). Use server above to exercise actual API.
