'use strict';
// IGK v14: unified generation, safe model selection, restorer-style payments and ledger.
// The source of truth for money remains YDB; never infer a second debit on "payment".
const $ = id => document.getElementById(id);
const base = (window.APP_CONFIG?.API_BASE || '').replace(/\/$/, '');
const credits = kopeks => (Number(kopeks || 0) / 1000).toLocaleString('ru-RU', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
}) + ' кредитов';
const shortCredits = kopeks => (Number(kopeks || 0) / 1000).toLocaleString('ru-RU', {maximumFractionDigits: 2}) + ' кредитов';
const rubles = kopeks => (Number(kopeks || 0) / 100).toLocaleString('ru-RU', {
  style: 'currency', currency: 'RUB'
});
const formatDate = date => {
  const d = new Date(date);
  return !date || !Number.isFinite(d.getTime()) ? 'Дата неизвестна' : d.toLocaleDateString('ru-RU');
};
const formatTime = date => {
  const d = new Date(date);
  return !date || !Number.isFinite(d.getTime()) ? '—:—' : d.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'});
};
const statusName = s => ({completed:'Готово', failed:'Ошибка', unknown:'Требуется проверка',
  reserved:'В обработке', pending:'В обработке', cancelled:'Отменено'}[s] || 'В обработке');
const modelName = value => ({
  'grok-imagine-image-2-0':'Grok Imagine 2.0',
  'grok-imagine-image-2.0-official':'Grok Imagine 2.0 Official',
  'nano-banana-2.1':'Nano Banana 2.1 2K',
  'gpt-image-2.6-flare':'GPT Image 2.6 Flare',
  'gpt-image-2.6-sunburst':'GPT Image 2.6 Sunburst',
  'gemini-3-pro-image-preview':'Nano Banana Pro 2K'
}[value] || (value ? String(value) : ''));
const kindName = kind => ({text:'По тексту', reference:'По фотографии'}[kind] || 'Генерация');
const safeHttps = value => {
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; }
  catch { return ''; }
};
const el = (tag, className = '', content = '') => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = content;
  return node;
};

let token = '', active = false, referenceKey = '', busy = false, pendingRequestId = '';
let modelPrices = {grok:500, grok_detail:750, gpt_image_26_flare:500, gpt_image_26_sunburst:750, nano_banana_21:500, nano_banana_pro:750}, allowedModels=['grok'];
let currentHistory = {jobs:[], movements:[]};
let currentWallet = {available:0, held:0};
let paymentOrdersById = new Map();
const HISTORY_FIRST_PAGE = 10, MOVEMENT_FIRST_PAGE = 15;
let visibleJobs = HISTORY_FIRST_PAGE, visibleMovements = MOVEMENT_FIRST_PAGE;

async function api(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: {'X-App-Authorization': `Bearer ${token}`, ...(opts.headers || {})}
  });
  let data;
  try { data = await res.json(); } catch { throw Error(`HTTP ${res.status}`); }
  if (!res.ok) throw Error(typeof data.detail === 'string' ? data.detail : `HTTP ${res.status}`);
  return data;
}
function message(value, isError = false) {
  $('message').textContent = value;
  $('message').classList.toggle('error', isError);
}
function check() {
  $('generate').disabled = !active || !token || busy || !$('rights').checked ||
    $('prompt').value.trim().length < 10 || ($('reference-toggle').checked && !referenceKey) ||
    !allowedModels.includes($('model').value);
}
async function login() {
  $('retry').classList.add('hidden');
  $('gate-title').textContent = 'Проверяем подключение…';
  try {
    const init = window.WebApp?.initData;
    if (!init) throw Error('Откройте мини-приложение кнопкой внутри MAX, не прямой ссылкой.');
    const response = await fetch(base + '/api/auth', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({init_data:init})
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.detail || 'Ошибка входа');
    token = data.token;
    await refresh();
    $('gate').classList.add('hidden');
    $('workspace').classList.remove('hidden');
  } catch (err) {
    $('gate-title').textContent = 'Доступ не подтверждён';
    $('gate-message').textContent = err.message;
    $('retry').classList.remove('hidden');
  }
}
async function refresh() {
  const profile = await api('/api/profile');
  currentWallet = profile.wallet || {available:0, held:0};
  // With PROVIDER_SELECTOR_VISIBLE=0 the backend enforces PROVIDER_DEFAULT=reapi.
  active = profile.generation_enabled === true && (profile.available_providers || []).includes('reapi') &&
    (profile.provider_selector_visible === true || profile.provider_default === 'reapi');
  const isAdmin = profile.admin === true;
  $('pay-admin').classList.toggle('hidden', !isAdmin);
  if (isAdmin) void loadAdminOrders();
  allowedModels = Array.isArray(profile.available_models) && profile.available_models.length ? profile.available_models : ['grok'];
  modelPrices = profile.model_prices || {grok:profile.price};
  $('model').querySelectorAll('option').forEach(opt => opt.disabled = !allowedModels.includes(opt.value));
  if (!allowedModels.includes($('model').value)) $('model').value = 'grok';
  $('balance').textContent = credits(currentWallet.available);
  updateModelPrice();
  if (!active) message('Генерация через reAPI не включена в настройках сервера.', true);
  check();
  const history = await api('/api/history');
  currentHistory = {jobs:Array.isArray(history.jobs) ? history.jobs : [],
    movements:Array.isArray(history.movements) ? history.movements : []};
  // Optional: a paid topup can include a number or HTTPS link to the NPD receipt.
  if (profile.payments_enabled === true) {
    try {
      const orders = await api('/api/payments/orders');
      paymentOrdersById = new Map((orders.orders || []).map(order => [order.order_id, order]));
    } catch { paymentOrdersById = new Map(); }
  } else {
    paymentOrdersById = new Map();
  }
  renderHistory();
}

async function openHistoryJob(job) {
  if (job.status !== 'completed') {
    message('Задание: ' + statusName(job.status) + '. Результат пока недоступен.', job.status === 'failed');
    return;
  }
  try {
    // A fresh API call renews the ten-minute signed Object Storage URL.
    const response = await api('/api/history');
    const fresh = (response.jobs || []).find(j => j.job_id === job.job_id);
    const image = safeHttps(fresh?.image_url);
    if (!image) throw Error('Ссылка на изображение недоступна. Обновите историю.');
    $('result-image').src = image;
    $('download').href = image;
    $('result-panel').classList.remove('hidden');
    message('Сохранённое изображение открыто из архива.');
    $('result-panel').scrollIntoView({behavior:'smooth'});
  } catch (err) { message(err.message, true); }
}

function renderJobs() {
  const container = $('history');
  container.replaceChildren();
  for (const job of currentHistory.jobs.slice(0, visibleJobs)) {
    const row = el('button', 'history-item history-job');
    row.type = 'button';
    const left = el('span', 'history-job-body');
    left.append(el('strong', 'history-job-title', `${modelName(job.model) || kindName(job.kind)} · ${job.aspect || '—'}`));
    left.append(el('span', 'history-job-meta', `${formatTime(job.created_at)} · ${formatDate(job.created_at)} · ${statusName(job.status)} · ${credits(job.price)}`));
    left.append(el('span', 'history-job-prompt', String(job.prompt || '').slice(0, 150)));
    row.append(left);
    row.addEventListener('click', () => { void openHistoryJob(job); });
    container.append(row);
  }
  if (!currentHistory.jobs.length) container.textContent = 'История пока пуста.';
  const remainder = Math.max(0, currentHistory.jobs.length - visibleJobs);
  $('history-more').classList.toggle('hidden', remainder === 0);
  $('history-more').textContent = `Показать ещё генерации (${remainder})`;
}

function renderMovements() {
  const container = $('movements');
  container.replaceChildren();
  const byJob = new Map(currentHistory.jobs.map(j => [j.job_id, j]));
  const reservedByReference = new Map();
  for (const m of currentHistory.movements) {
    if (m.kind === 'reserve' && m.reference) reservedByReference.set(m.reference, Math.abs(Number(m.amount || 0)));
  }
  // YDB 'payment' has amount 0: funds were taken from available at 'reserve'.
  // Reconstruct displayed available-after in reverse chronological order.
  let availableAfter = Number(currentWallet.available || 0);
  const rows = currentHistory.movements.map(m => {
    const after = availableAfter;
    if (['welcome', 'topup', 'reserve', 'release'].includes(m.kind)) {
      availableAfter -= Number(m.amount || 0);
    }
    return {m, after};
  });
  for (const {m, after} of rows.slice(0, visibleMovements)) {
    const job = byJob.get(m.reference);
    const price = job && Number.isFinite(Number(job.price)) ? Number(job.price) : reservedByReference.get(m.reference);
    const label = job ? (modelName(job.model) || `${kindName(job.kind)} ${job.aspect || ''}`) : '';
    let operation = '';
    switch (m.kind) {
      case 'payment':
        operation = 'Оплата из резерва' + (Number.isFinite(price) ? ` - ${shortCredits(price)}` : '');
        break;
      case 'reserve':
        operation = `Резервирование средств - ${shortCredits(Math.abs(Number(m.amount || 0)))}`;
        break;
      case 'release':
        operation = `Возврат резерва + ${shortCredits(Math.abs(Number(m.amount || 0)))}`;
        break;
      case 'welcome':
        operation = `Приветственный бонус + ${shortCredits(Math.abs(Number(m.amount || 0)))}`;
        break;
      case 'topup':
        operation = `Пополнение баланса + ${shortCredits(Math.abs(Number(m.amount || 0)))}`;
        break;
      default:
        operation = String(m.note || m.kind || 'Операция') +
          (Number(m.amount || 0) ? ` ${Number(m.amount) > 0 ? '+' : '-'} ${shortCredits(Math.abs(Number(m.amount)))}` : '');
    }
    const parts = [`${formatDate(m.created_at)} ${formatTime(m.created_at)}`];
    if (label) parts.push(label);
    parts.push(operation, `Баланс — ${shortCredits(after)}`);
    const row = el('div', 'history-item movement-item');
    row.append(el('span', 'movement-single-line', parts.join(' · ')));
    if (m.kind === 'topup') {
      const receipt = safeHttps(paymentOrdersById.get(m.reference)?.receipt);
      if (receipt) {
        const link = el('a', 'receipt-link', 'Открыть чек НПД');
        link.href = receipt;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        row.append(link);
      }
    }
    container.append(row);
  }
  if (!currentHistory.movements.length) container.textContent = 'Операций пока нет.';
  const remaining = Math.max(0, currentHistory.movements.length - visibleMovements);
  $('movements-more').classList.toggle('hidden', remaining === 0);
  $('movements-more').textContent = `Показать ещё операции (${remaining})`;
}

function renderHistory() { renderJobs(); renderMovements(); }

$('retry').onclick = login;
$('history-more').onclick = () => { visibleJobs += HISTORY_FIRST_PAGE; renderJobs(); };
$('movements-more').onclick = () => { visibleMovements += MOVEMENT_FIRST_PAGE; renderMovements(); };
$('prompt').addEventListener('input', () => {
  $('prompt-length').textContent = $('prompt').value.length + ' / 1800';
  check();
});
$('rights').onchange = check;
$('reference-toggle').onchange = () => {
  referenceKey = '';
  // Keep request_id after uncertain network outcomes: avoids a second paid task.
  $('reference').value = '';
  $('reference-preview').removeAttribute('src');
  $('reference-preview').classList.add('hidden');
  $('reference-status').textContent = '';
  $('rights').checked = false;
  $('reference-panel').classList.toggle('hidden', !$('reference-toggle').checked);
  check();
};
$('model').onchange = () => { updateModelPrice(); check(); };
function updateModelPrice() {
  const cost = modelPrices[$('model').value];
  $('price').textContent = Number.isFinite(Number(cost)) ? credits(cost) : '— кредитов';
}
$('reference').onchange = async () => {
  referenceKey = '';
  $('rights').checked = false; // A new uploaded photo requires new consent.
  const file = $('reference').files[0];
  if (!file) { check(); return; }
  if (file.size > 8 * 1024 * 1024) { message('Файл больше 8 МБ', true); check(); return; }
  $('reference-status').textContent = 'Загружаем референс…';
  const form = new FormData(); form.append('file', file);
  try {
    const data = await api('/api/reference', {method:'POST', body:form});
    referenceKey = data.reference_key;
    $('reference-preview').src = data.preview_url;
    $('reference-preview').classList.remove('hidden');
    $('reference-status').textContent = 'Референс загружен. Подтвердите права на его обработку.';
  } catch (err) { message(err.message, true); }
  check();
};
$('generate').onclick = async () => {
  check(); if ($('generate').disabled) return;
  busy = true; check(); message('Генерация выполняется. Не закрывайте приложение…');
  // Reuse request_id after an uncertain network result: the server's idempotency
  // ledger will return the original job instead of launching a second paid call.
  if (!pendingRequestId) pendingRequestId = crypto.randomUUID();
  try {
    const payload = {
      request_id:pendingRequestId, provider:'reapi', model:$('model').value,
      prompt:$('prompt').value.trim(), style:$('style').value, aspect:$('aspect').value,
      mode:$('reference-toggle').checked ? 'reference' : 'text', reference_key:$('reference-toggle').checked ? referenceKey : '', confirm_rights:$('rights').checked
    };
    const data = await api('/api/generate', {method:'POST',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if (data.status === 'completed' && safeHttps(data.image_url)) {
      pendingRequestId = ''; // Completed jobs never need an idempotent retry.
      $('result-image').src = data.image_url;
      $('download').href = data.image_url;
      $('result-panel').classList.remove('hidden');
      message('Изображение создано!');
      $('result-panel').scrollIntoView({behavior:'smooth'});
    } else if (data.status === 'failed') {
      pendingRequestId = ''; // YDB confirms this job failed and its hold was released.
      message('Генерация не удалась. Резерв возвращён. Можно попробовать ещё раз.', true);
    } else {
      message('Задание: ' + statusName(data.status) + '. Не создавайте повторную генерацию до проверки.');
    }
    await refresh();
  } catch (err) {
    // Never create a second paid task after a mere HTTP/network error.
    // The server confirms a refund by returning status=failed for THIS request_id.
    let matchingJob = null;
    try {
      await refresh();
      matchingJob = currentHistory.jobs.find(job => job.request_id === pendingRequestId);
    } catch { /* If the status cannot be verified, retain the idempotency key. */ }
    if (matchingJob?.status === 'failed') {
      pendingRequestId = '';
      message('Генерация не удалась. Резерв возвращён. Можно попробовать ещё раз.', true);
    } else if (matchingJob?.status === 'completed') {
      pendingRequestId = '';
      message('Изображение создано. Откройте результат в архиве.');
    } else if (matchingJob?.status === 'reserved' || matchingJob?.status === 'unknown') {
      message('Задание ещё выполняется или требует проверки. Не отправляйте новую генерацию.', true);
    } else {
      message(err.message + ' Статус задания не подтверждён. Повторная попытка использует тот же номер запроса.', true);
    }
  } finally { busy = false; check(); }
};
$('new-image').onclick = () => {
  $('result-panel').classList.add('hidden');
  $('rights').checked = false;
  pendingRequestId = '';
  check();
  window.scrollTo({top:0, behavior:'smooth'});
};
document.querySelectorAll('[data-legal]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  $('legal-frame').src = link.getAttribute('href');
  $('legal-overlay').classList.remove('hidden');
}));
// The embedded legal pages have their own back link (sometimes to the restorer).
// Keep only the return button in the main application's document dialog.
$('legal-frame').addEventListener('load', () => {
  try {
    const documentInside = $('legal-frame').contentDocument;
    if (!documentInside) return;
    for (const control of documentInside.querySelectorAll('a, button')) {
      const caption = (control.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^(?:←\s*)?Вернуться\s+(?:в|к)\s+/iu.test(caption)) control.remove();
    }
  } catch (_) {
    // A different-origin document cannot be modified by the parent page.
  }
});
$('legal-close').onclick = () => {
  $('legal-overlay').classList.add('hidden');
  $('legal-frame').removeAttribute('src');
};

// Управление пополнениями — только для администратора, по образцу фотореставратора.
const adminStatus = s => ({pending:'Ожидает оплаты',review:'На проверке',clarify:'Требуется уточнение',
  paid:'Кредиты начислены',cancelled:'Отменена'}[s] || s || '—');
let adminListSequence = 0, adminSelectionSequence = 0, selectedAdminOrder = null;
async function loadAdminOrders() {
  const seq = ++adminListSequence;
  const hidden = $('admin-show-hidden').checked;
  const list = $('admin-orders');
  list.setAttribute('aria-busy', 'true');
  if (!list.querySelector('[data-admin-order-id]')) list.textContent = 'Загружаем заявки…';
  try {
    const response = await api('/api/admin/orders' + (hidden ? '?include_hidden=true' : ''));
    if (seq !== adminListSequence) return;
    if (!Array.isArray(response.orders)) throw Error('Неверный формат списка заявок');
    const fragment = document.createDocumentFragment();
    for (const order of response.orders) {
      const card = el('div', 'history-item admin-order-card');
      card.dataset.adminOrderId = order.order_id;
      card.classList.toggle('admin-order-selected', selectedAdminOrder?.order_id === order.order_id);
      const select = el('button', 'admin-order-select', `${order.order_id.slice(0,12)} · ${rubles(order.amount)} · ${adminStatus(order.status)} · MAX ID ${order.user_id} · ${formatDate(order.created_at)} ${formatTime(order.created_at)}`);
      select.type = 'button';
      select.setAttribute('aria-pressed', String(selectedAdminOrder?.order_id === order.order_id));
      select.addEventListener('click', () => { void selectAdminOrder(order); });
      card.append(select);
      const actions = el('div', 'admin-order-actions');
      if (hidden) {
        const restore = el('button', 'admin-order-action', 'Восстановить в списке');
        restore.type = 'button';
        restore.onclick = () => { void adminChangeOrder(order, 'restore', 'Вернуть заявку в рабочий список?'); };
        actions.append(restore);
        const archive = el('button', 'admin-order-action', 'Убрать из архива');
        archive.type = 'button';
        archive.onclick = () => { void adminChangeOrder(order, 'archive', 'Убрать заявку из всех рабочих списков? Запись останется в YDB.'); };
        actions.append(archive);
      } else {
        if (order.status === 'pending') {
          const cancel = el('button', 'admin-order-action', 'Отменить');
          cancel.type = 'button';
          cancel.onclick = () => { void adminChangeOrder(order, 'cancel', 'Проверьте, что деньги не поступили в ВТБ. Отменить неоплаченную заявку?'); };
          actions.append(cancel);
        }
        const hide = el('button', 'admin-order-action', 'Скрыть заявку');
        hide.type = 'button';
        hide.onclick = () => { void adminChangeOrder(order, 'hide', 'Скрыть заявку? Финансовые записи и чеки сохранятся.'); };
        actions.append(hide);
      }
      card.append(actions); fragment.append(card);
    }
    list.replaceChildren(fragment);
    if (!response.orders.length) list.textContent = hidden ? 'Скрытых заявок пока нет.' : 'Заявок пока нет.';
  } catch (error) {
    if (seq === adminListSequence) list.replaceChildren(el('div', 'admin-list-error',
      'Не удалось загрузить заявки: ' + error.message + '. Нажмите «Обновить список заявок».'));
  } finally {
    if (seq === adminListSequence) list.setAttribute('aria-busy', 'false');
  }
}
function clearAdminSelection() {
  adminSelectionSequence++;
  selectedAdminOrder = null;
  $('admin-order-detail').classList.add('hidden');
  $('admin-orders').querySelectorAll('.admin-order-card').forEach(card => {
    card.classList.remove('admin-order-selected');
    card.querySelector('.admin-order-select')?.setAttribute('aria-pressed', 'false');
  });
}
async function adminChangeOrder(order, action, confirmation) {
  if (!window.confirm(confirmation)) return;
  try {
    await api(`/api/admin/orders/${encodeURIComponent(order.order_id)}/${action}`,
      {method:'POST'});
    if (selectedAdminOrder?.order_id === order.order_id) clearAdminSelection();
    await loadAdminOrders();
    $('admin-pay-message').textContent = ({cancel:'Заявка отменена.',hide:'Заявка скрыта.',
      archive:'Заявка убрана из списков.',restore:'Заявка восстановлена.'})[action] || '';
  } catch (error) { $('admin-pay-message').textContent = error.message; }
}
async function selectAdminOrder(order) {
  const seq = ++adminSelectionSequence;
  selectedAdminOrder = order;
  $('admin-order-detail').classList.remove('hidden');
  $('admin-order-title').textContent = 'Заявка ' + order.order_id.slice(0,12);
  $('admin-order-description').textContent = `MAX ID ${order.user_id} · ${rubles(order.amount)} · ${adminStatus(order.status)} · ${formatDate(order.created_at)} ${formatTime(order.created_at)}`;
  $('admin-pay-message').textContent = 'Загружаем заявку…';
  $('admin-approve').disabled = true;
  $('admin-clarify').disabled = true;
  $('admin-proof-image').classList.add('hidden');
  $('admin-proof-link').classList.add('hidden');
  $('admin-orders').querySelectorAll('.admin-order-card').forEach(card => {
    const active = card.dataset.adminOrderId === order.order_id;
    card.classList.toggle('admin-order-selected', active);
    card.querySelector('.admin-order-select')?.setAttribute('aria-pressed', String(active));
  });
  try {
    const detailed = await api('/api/admin/orders/' + encodeURIComponent(order.order_id));
    if (seq !== adminSelectionSequence) return;
    selectedAdminOrder = detailed;
    $('admin-order-description').textContent = `MAX ID ${detailed.user_id} · ${rubles(detailed.amount)} · ${adminStatus(detailed.status)} · ${formatDate(detailed.created_at)} ${formatTime(detailed.created_at)}`;
    const url = safeHttps(detailed.proof_url);
    $('admin-proof-link').classList.toggle('hidden', !url);
    $('admin-proof-image').classList.toggle('hidden', !url || !/\.(jpg|jpeg|png|webp)$/i.test((new URL(url || 'https://example.invalid')).pathname));
    if (url) {
      $('admin-proof-link').href = url;
      if (!$('admin-proof-image').classList.contains('hidden')) $('admin-proof-image').src = url;
    }
    $('admin-bank-amount').value = (Number(detailed.amount)/100).toFixed(2);
    $('admin-bank-no-number').checked = Boolean(detailed.bank_without_id);
    $('admin-bank-no-number-fields').classList.toggle('hidden', !detailed.bank_without_id);
    $('admin-bank-received-at').value = detailed.bank_received_at || '';
    $('admin-bank-reference').value = detailed.bank_description || detailed.bank_reference || '';
    $('admin-receipt-url').value = detailed.receipt_url || '';
    $('admin-receipt-number').value = detailed.receipt_number || '';
    $('admin-clarify-reason').value = detailed.clarify_reason || '';
    $('admin-pay-message').textContent = 'Перед начислением проверьте платёж в выписке ВТБ и выдайте чек НПД.';
    $('admin-approve').disabled = detailed.status !== 'review';
    $('admin-clarify').disabled = detailed.status !== 'review';
  } catch (error) {
    if (seq === adminSelectionSequence) $('admin-pay-message').textContent = 'Не удалось загрузить заявку: ' + error.message;
  }
}
$('admin-close-detail').onclick = clearAdminSelection;
$('admin-reload').onclick = () => { void loadAdminOrders(); };
$('admin-show-hidden').onchange = () => { clearAdminSelection(); void loadAdminOrders(); };
$('admin-bank-no-number').onchange = () => {
  const on = $('admin-bank-no-number').checked;
  $('admin-bank-no-number-fields').classList.toggle('hidden', !on);
  if (on && !$('admin-bank-reference').value.trim()) $('admin-bank-reference').value = 'Перевод по номеру телефона';
};
$('admin-approve').onclick = async () => {
  if (!selectedAdminOrder || selectedAdminOrder.status !== 'review') return;
  const reference = $('admin-bank-reference').value.trim();
  const noId = $('admin-bank-no-number').checked;
  const receivedAt = noId ? $('admin-bank-received-at').value : '';
  const amount = Math.round(Number($('admin-bank-amount').value) * 100);
  const receiptNumber = $('admin-receipt-number').value.trim();
  const receiptUrl = $('admin-receipt-url').value.trim();
  const warn = text => { $('admin-pay-message').textContent = text; };
  if (reference.length < 6) return warn('Укажите номер или описание перевода из выписки ВТБ.');
  if (noId && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(receivedAt))
    return warn('Укажите дату и время фактического поступления из выписки ВТБ.');
  if (!Number.isSafeInteger(amount) || amount <= 0)
    return warn('Укажите положительную фактически поступившую сумму по выписке ВТБ.');
  if (!receiptNumber && !receiptUrl) return warn('Перед начислением оформите чек НПД и укажите его номер или ссылку.');
  if (receiptUrl && !safeHttps(receiptUrl)) return warn('Ссылка на чек должна начинаться с https://');
  const difference = amount !== Number(selectedAdminOrder.amount);
  const question = difference
    ? `Сумма заявки: ${rubles(selectedAdminOrder.amount)}. Фактически в ВТБ: ${rubles(amount)}. Начислить только ${credits(amount)} по фактическому поступлению? Чек НПД оформлен на ${rubles(amount)}?`
    : `Поступление ${rubles(amount)} подтверждено в ВТБ, чек НПД оформлен? Начислить ${credits(amount)}?`;
  if (!window.confirm(question)) return;
  const b = $('admin-approve'); b.disabled = true;
  try {
    await api('/api/admin/orders/' + encodeURIComponent(selectedAdminOrder.order_id) + '/approve', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
        bank_reference:reference, amount, receipt_number:receiptNumber,
        receipt_url:receiptUrl, bank_without_id:noId, bank_received_at:receivedAt
      })
    });
    $('admin-pay-message').textContent = 'Кредиты начислены. Повторное начисление заблокировано.';
    selectedAdminOrder.status = 'paid';
    await loadAdminOrders(); await refresh();
  } catch (error) { $('admin-pay-message').textContent = 'Не удалось подтвердить начисление: ' + error.message; }
  finally { b.disabled = selectedAdminOrder?.status !== 'review'; }
};
$('admin-clarify').onclick = async () => {
  if (!selectedAdminOrder) return;
  const reason = $('admin-clarify-reason').value.trim();
  if (reason.length < 3) { $('admin-pay-message').textContent = 'Укажите причину уточнения.'; return; }
  const b = $('admin-clarify'); b.disabled = true;
  try {
    await api('/api/admin/orders/' + encodeURIComponent(selectedAdminOrder.order_id) + '/clarify', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({reason})
    });
    $('admin-pay-message').textContent = 'Запрошено уточнение';
    selectedAdminOrder.status = 'clarify';
    $('admin-approve').disabled = true;
    await loadAdminOrders();
  } catch (error) { $('admin-pay-message').textContent = error.message; }
  finally { b.disabled = selectedAdminOrder?.status !== 'review'; }
};

login();
