'use strict';
// IGK v13: unified generation, safe model selection, restorer-style payments and ledger.
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
  'grok-imagine-image-2.0-official':'Grok Imagine 2.0 1K',
  'nano-banana-2.1':'Nano Banana 2.1 2K'
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
let modelPrices = {grok:1000}, allowedModels=['grok'];
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
  $('gate-title').textContent = 'Проверяем доступ…';
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
  $('provider-audit-panel').classList.toggle('hidden', profile.admin !== true);
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

async function loadProviderAudit() {
  const list = $('provider-audit-list');
  list.textContent = 'Загрузка журнала…';
  try {
    const data = await api('/api/admin/provider-usage');
    list.replaceChildren();
    for (const x of data.items || []) {
      const usage = x.usage || {};
      const caption = typeof usage.credits === 'number' ?
        ` · ${usage.credits} кредитов reAPI ($${(usage.credits * .001).toFixed(3)})` : '';
      const row = el('div', 'history-item admin-audit-item');
      row.append(el('strong', '', `${x.provider || '—'} · ${x.status || '—'}`));
      row.append(el('span', '', `${formatDate(x.updated_at)} ${formatTime(x.updated_at)} · ${x.model || '—'} · ${Number(x.seconds || 0) / 1000} с${caption}`));
      row.append(el('span', '', `Задание: ${x.job_id || '—'} · ${x.task_id || '—'}`));
      list.append(row);
    }
    if (!(data.items || []).length) list.textContent = 'Генераций пока нет.';
  } catch (err) { list.textContent = 'Ошибка журнала: ' + err.message; }
}

$('provider-audit-refresh').onclick = loadProviderAudit;
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
  $('reference-status').textContent = 'Файл будет загружен в закрытое хранилище.';
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
      $('result-image').src = data.image_url;
      $('download').href = data.image_url;
      $('result-panel').classList.remove('hidden');
      message('Изображение создано!');
      $('result-panel').scrollIntoView({behavior:'smooth'});
    } else {
      message('Задание: ' + statusName(data.status) + '. Не создавайте повторную генерацию до проверки.');
    }
    await refresh();
  } catch (err) {
    message(err.message + ' Повторная попытка с этой формой использует тот же номер запроса.', true);
    try { await refresh(); } catch { /* preserve original error */ }
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
$('legal-close').onclick = () => {
  $('legal-overlay').classList.add('hidden');
  $('legal-frame').removeAttribute('src');
};
login();
