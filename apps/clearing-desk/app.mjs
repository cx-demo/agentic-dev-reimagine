const $ = (selector) => document.querySelector(selector);
const money = (minor) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minor / 100);
const state = { merchants: [], transactions: [], selectedId: null, selected: null, busy: false, sequence: 0 };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function display(message, isError = false) {
  const target = isError ? $('#error') : $('#notice');
  const other = isError ? $('#notice') : $('#error');
  other.hidden = true;
  target.textContent = message;
  target.hidden = false;
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api/v1${path}`, { cache: 'no-store', ...options });
  } catch {
    throw new Error('Cannot reach local Clearing Desk. Check server and try Refresh.');
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('Server returned an unreadable response.');
  }
  if (!response.ok) throw new Error(body.error?.message ?? `Request failed (${response.status})`);
  return body;
}

function post(path, body, key) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Clearing-Action': '1', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
}

const merchantName = (id) => state.merchants.find((merchant) => merchant.id === id)?.name ?? id;

function renderMerchants() {
  const cards = state.merchants.map((merchant, index) => {
    const card = element('article', undefined, 'merchant-card');
    const top = element('div', undefined, 'card-top');
    top.append(element('span', `0${index + 1} / MERCHANT`), element('span', 'SIMULATED'));
    card.append(top, element('strong', merchant.name), element('span', money(merchant.balanceMinor), 'amount'), element('small', 'Available demo USD · no real funds'));
    return card;
  });
  $('#merchant-cards').replaceChildren(...cards);
}

function renderQueue() {
  const search = $('#search').value.trim().toLowerCase();
  const filtered = state.transactions.filter((transaction) =>
    [transaction.id, merchantName(transaction.fromMerchantId), merchantName(transaction.toMerchantId)]
      .some((value) => value.toLowerCase().includes(search)));
  $('#transaction-count').textContent = `(${filtered.length})`;
  const list = $('#queue-list');
  if (!filtered.length) {
    list.replaceChildren(element('p', search ? 'No matching simulated transfers.' : 'No transactions in this status. Try another filter or create a transfer.', 'empty'));
    return;
  }
  list.replaceChildren(...filtered.map((transaction) => {
    const button = element('button', undefined, 'queue-item');
    button.type = 'button';
    button.setAttribute('aria-current', String(state.selectedId === transaction.id));
    button.setAttribute('aria-label', `${merchantName(transaction.fromMerchantId)} to ${merchantName(transaction.toMerchantId)}, ${money(transaction.amountMinor)}, ${transaction.status}`);
    const row = element('div', undefined, 'queue-row');
    row.append(element('strong', `${merchantName(transaction.fromMerchantId)} → ${merchantName(transaction.toMerchantId)}`), element('span', money(transaction.amountMinor), 'sum'));
    const footer = element('div', undefined, 'queue-row');
    footer.append(element('small', transaction.id), element('span', transaction.status, `pill ${transaction.status}`));
    button.append(row, footer);
    button.addEventListener('click', () => select(transaction.id));
    return button;
  }));
}

function renderDetail() {
  const parent = $('#detail-content');
  const transaction = state.selected;
  if (!transaction) {
    parent.replaceChildren(element('p', state.selectedId ? 'Loading simulated transfer details…' : 'Select a transaction to review its status trail.', 'empty'));
    return;
  }
  const status = element('span', transaction.status, `pill ${transaction.status}`);
  const amount = element('div', money(transaction.amountMinor), 'detail-amount');
  const route = element('div', undefined, 'route');
  const from = element('div');
  from.append(element('small', 'FROM / SIMULATED'), element('strong', merchantName(transaction.fromMerchantId)));
  const to = element('div');
  to.append(element('small', 'TO / SIMULATED'), element('strong', merchantName(transaction.toMerchantId)));
  route.append(from, element('span', '→'), to);
  const history = element('ol', undefined, 'history');
  for (const event of transaction.events) {
    const item = element('li');
    const date = element('time', new Date(event.at).toLocaleString());
    date.dateTime = event.at;
    item.append(element('strong', event.status), date);
    if (event.reason) item.append(element('small', `Reason: ${event.reason}`));
    history.append(item);
  }
  parent.replaceChildren(status, amount, element('div', `ID: ${transaction.id}`, 'detail-id'), element('div', 'SIMULATED USD', 'detail-label'), route,
    element('h3', 'Status history'), history);
  if (transaction.entries.length) {
    parent.append(element('h3', 'Balanced ledger entries'));
    for (const entry of transaction.entries) {
      const row = element('div', undefined, 'entry');
      row.append(element('span', merchantName(entry.merchantId)), element('strong', `${entry.amountMinor < 0 ? '−' : '+'}${money(Math.abs(entry.amountMinor))}`));
      parent.append(row);
    }
  }
  if (transaction.status === 'pending') {
    const actions = element('div', undefined, 'actions');
    const clear = element('button', 'Clear transfer', 'primary');
    const reject = element('button', 'Reject', 'secondary');
    clear.type = reject.type = 'button';
    clear.disabled = reject.disabled = state.busy;
    clear.addEventListener('click', () => {
      $('#clear-description').textContent = `${money(transaction.amountMinor)} from ${merchantName(transaction.fromMerchantId)} to ${merchantName(transaction.toMerchantId)}.`;
      $('#clear-dialog').showModal();
    });
    reject.addEventListener('click', () => {
      $('#reject-form').reset();
      $('#reject-dialog').showModal();
      $('#reject-form textarea').focus();
    });
    actions.append(clear, reject);
    parent.append(actions);
  }
}

async function select(id, propagate = false) {
  state.selectedId = id;
  state.selected = null;
  renderQueue();
  renderDetail();
  const sequence = ++state.sequence;
  try {
    const { transaction } = await request(`/transactions/${encodeURIComponent(id)}`);
    if (sequence !== state.sequence) return;
    state.selected = transaction;
    renderDetail();
  } catch (cause) {
    if (sequence === state.sequence) {
      state.selectedId = null;
      renderDetail();
      display(cause.message, true);
    }
    if (propagate) throw cause;
  }
}

async function refresh(preferredId = state.selectedId, propagate = false) {
  const sequence = ++state.sequence;
  state.selected = null;
  $('#queue-list').replaceChildren(element('p', 'Loading simulated transactions…', 'empty'));
  renderDetail();
  try {
    const { merchants } = await request('/merchants');
    let offset = 0;
    const transactions = [];
    let total;
    do {
      const page = await request(`/transactions?limit=100&offset=${offset}${$('#status-filter').value ? `&status=${encodeURIComponent($('#status-filter').value)}` : ''}`);
      transactions.push(...page.transactions);
      total = page.total;
      offset += page.transactions.length;
    } while (offset < total && offset <= 100_000);
    if (offset < total) throw new Error('Too many transactions to display. Restart local demo to reset.');
    if (sequence !== state.sequence) return;
    if (!state.merchants.length) {
      state.merchants = merchants;
      populateMerchants();
    } else {
      state.merchants = merchants;
    }
    state.transactions = transactions.reverse();
    renderMerchants();
    renderQueue();
    if (preferredId && transactions.some((transaction) => transaction.id === preferredId)) await select(preferredId, propagate);
    else {
      state.selectedId = null;
      state.selected = null;
      renderDetail();
    }
  } catch (cause) {
    if (sequence === state.sequence) {
      $('#queue-list').replaceChildren(element('p', 'Could not load transfers. Use Refresh to retry.', 'empty'));
      display(cause.message, true);
    }
    if (propagate) throw cause;
  }
}

async function mutate(operation, success) {
  if (state.busy) return;
  state.busy = true;
  $('#create-form button').disabled = true;
  renderDetail();
  try {
    const preferredId = await operation();
    await refresh(preferredId, true);
    display(success);
  } catch (cause) {
    display(cause.message, true);
  } finally {
    state.busy = false;
    $('#create-form button').disabled = false;
    renderDetail();
  }
}

function populateMerchants() {
  for (const name of ['fromMerchantId', 'toMerchantId']) {
    const select = $(`#create-form select[name="${name}"]`);
    select.replaceChildren(element('option', name === 'fromMerchantId' ? 'Choose sender' : 'Choose recipient'));
    select.firstChild.value = '';
    for (const merchant of state.merchants) {
      const option = element('option', merchant.name);
      option.value = merchant.id;
      select.append(option);
    }
  }
}

$('#search').addEventListener('input', renderQueue);
$('#status-filter').addEventListener('change', () => refresh(null));
$('#refresh').addEventListener('click', () => refresh());
$('#create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const amount = String(data.get('amount')).trim();
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(amount)) return display('Enter USD amount from 0.01 to 1,000,000.00 with at most two decimals.', true);
  const [dollars, cents = ''] = amount.split('.');
  const amountMinor = Number(dollars) * 100 + Number(cents.padEnd(2, '0'));
  if (amountMinor < 1 || amountMinor > 100_000_000) return display('Amount must be between USD 0.01 and 1,000,000.00.', true);
  const fromMerchantId = data.get('fromMerchantId');
  const toMerchantId = data.get('toMerchantId');
  if (fromMerchantId === toMerchantId) return display('Choose two different merchants.', true);
  mutate(async () => {
    const payload = { fromMerchantId, toMerchantId, amountMinor, currency: 'USD' };
    const serialized = JSON.stringify(payload);
    if (form.dataset.pendingRequest !== serialized) {
      form.dataset.pendingRequest = serialized;
      form.dataset.pendingKey = crypto.randomUUID();
    }
    const { transaction } = await post('/transactions', payload, form.dataset.pendingKey);
    delete form.dataset.pendingRequest;
    delete form.dataset.pendingKey;
    form.reset();
    $('#status-filter').value = '';
    $('#search').value = '';
    return transaction.id;
  }, 'Pending simulated transfer created.');
});
$('#clear-dialog').addEventListener('close', () => {
  if ($('#clear-dialog').returnValue !== 'confirm') return;
  const id = state.selectedId;
  mutate(async () => {
    await post(`/transactions/${encodeURIComponent(id)}/clear`, {});
    $('#status-filter').value = '';
    return id;
  }, 'Simulated transfer cleared; balances refreshed.');
});
$('#cancel-reject').addEventListener('click', () => $('#reject-dialog').close());
$('#reject-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = state.selectedId;
  const reason = new FormData(event.currentTarget).get('reason').trim();
  $('#reject-dialog').close();
  mutate(async () => {
    await post(`/transactions/${encodeURIComponent(id)}/reject`, { reason });
    $('#status-filter').value = '';
    return id;
  }, 'Simulated transfer rejected; no balance moved.');
});

await refresh();
