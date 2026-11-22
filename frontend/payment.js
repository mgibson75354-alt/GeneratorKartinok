'use strict';
// IGK: server-side balance & manual VTB-confirmed topups, styled after the Restorer.
const $ = id => document.getElementById(id);
const base = (window.APP_CONFIG?.API_BASE || '').replace(/\/$/, '');
const credits = k => (Number(k||0)/1000).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' кредитов';
const rubles = k => (Number(k||0)/100).toLocaleString('ru-RU',{style:'currency',currency:'RUB'});
const dt = x => x ? new Date(x).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}) : 'Дата неизвестна';
const safeHttps = u => {try {const a=new URL(u);return a.protocol==='https:' ? a.href : '';}catch{return '';}};
const statusName = x => ({pending:'Ожидает оплаты',review:'На проверке',clarify:'Требуется уточнение',paid:'Кредиты начислены',cancelled:'Отменена'}[x]||x||'—');
let token='',currentOrder=null,paymentQr='',paymentLink='',orders=[];
let ordersRequestSequence=0;
async function api(path,{method='GET',body=null}={}) {
  const isForm=body instanceof FormData;
  const response=await fetch(base+path,{method,cache:method==='GET'?'no-store':'default',headers:{...(token?{'X-App-Authorization':'Bearer '+token}:{}),...(!isForm&&body?{'Content-Type':'application/json'}:{})},body:isForm?body:body?JSON.stringify(body):undefined});
  let result={};try {result=await response.json();}catch{}
  if(!response.ok) throw Error(typeof result.detail==='string'?result.detail:'Ошибка сервера HTTP '+response.status);
  return result;
}
function info(id,text,isError=false) {const n=$(id);n.textContent=text;n.classList.toggle('error',isError);}
async function login() {
  $('retry').classList.add('hidden');
  try {
    const init=window.WebApp?.initData;
    if(!init) throw Error('Откройте пополнение из приложения внутри MAX.');
    const response=await fetch(base+'/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:init})});
    const data=await response.json();if(!response.ok) throw Error(data.detail||'Ошибка авторизации');
    token=data.token;
    const profile=await api('/api/profile');
    if(!profile.payments_enabled) throw Error('Пополнение баланса временно выключено.');
    $('balance').textContent=credits(profile.wallet.available);
    paymentQr=safeHttps(profile.payment_qr_url);
    paymentLink=safeHttps(profile.payment_sbp_link);
    $('gate').classList.add('hidden');$('workspace').classList.remove('hidden');
    await loadOrders();
  } catch(err){$('gate-title').textContent='Доступ не подтверждён';$('gate-message').textContent=err.message;$('retry').classList.remove('hidden');}
}
async function refreshBalance() {
  const profile=await api('/api/profile');
  $('balance').textContent=credits(profile.wallet.available);
}
function clearSelectedOrder() {
  currentOrder=null;
  $('pay-order').classList.add('hidden');
  $('pay-start').classList.remove('hidden');
  $('pay-proof-file').value='';
  info('pay-message','');
}
async function loadOrders(){
  const sequence=++ordersRequestSequence;
  const payload=await api('/api/payments/orders');
  if(sequence!==ordersRequestSequence)return;
  // Cancelled applications remain in YDB for accounting, but must not be
  // presented as selectable, payable applications in the client screen.
  orders=(Array.isArray(payload.orders)?payload.orders:[]).filter(o=>o.status!=='cancelled'&&o.status!=='canceled');
  if(currentOrder){
    const updated=orders.find(o=>o.order_id===currentOrder.order_id);
    if(!updated){
      // The administrator cancelled the previously selected order.
      clearSelectedOrder();
    }else if(updated.status!==currentOrder.status){
      currentOrder=updated;
      $('pay-order-summary').textContent=`Заявка ${updated.order_id.slice(0,12)} · ${rubles(updated.amount)} · ${statusName(updated.status)}`;
      const actionable=['pending','review','clarify'].includes(updated.status);
      $('pay-proof').classList.toggle('hidden',!actionable);
      $('pay-qr-button').classList.toggle('hidden',!actionable||(!paymentQr&&!paymentLink));
      $('pay-start').classList.toggle('hidden',actionable);
      if(!actionable)$('pay-proof-file').value='';
      info('pay-message',updated.status==='clarify'?('Требуется уточнение: '+(updated.clarify_reason||'Загрузите новое подтверждение.')):'');
    }else{
      currentOrder=updated;
    }
  }
  const list=$('pay-my-orders');list.replaceChildren();
  for(const o of orders){
    const button=document.createElement('div');button.className='history-item payment-order-card';
    button.dataset.orderId=o.order_id;
    button.setAttribute('role','button');button.setAttribute('tabindex','0');
    button.classList.toggle('selected',o.order_id===currentOrder?.order_id);
    button.textContent=`${dt(o.created_at)} · ${rubles(o.amount)} · ${statusName(o.status)}`;
    const receipt=safeHttps(o.receipt);
    if(receipt){const a=document.createElement('a');a.href=receipt;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Открыть чек НПД';a.className='receipt-link';a.onclick=e=>e.stopPropagation();button.append(a);}
    button.onclick=()=>showOrder(o);
    button.onkeydown=e=>{if(e.target===button&&(e.key==='Enter'||e.key===' ')){e.preventDefault();showOrder(o);}};
    list.append(button);
  }
  if(!orders.length)list.textContent='Заявок пока нет.';
}
function showOrder(o){
  if(o.status==='cancelled'||o.status==='canceled'){clearSelectedOrder();return;}
  currentOrder=o;
  $('pay-order').classList.remove('hidden');
  $('pay-order-summary').textContent=`Заявка ${o.order_id.slice(0,12)} · ${rubles(o.amount)} · ${statusName(o.status)}`;
  const actionable=['pending','review','clarify'].includes(o.status);
  $('pay-proof').classList.toggle('hidden',!actionable);
  $('pay-qr-button').classList.toggle('hidden',!actionable||(!paymentQr&&!paymentLink));
  $('pay-start').classList.toggle('hidden',actionable);
  $('pay-proof-file').value='';
  info('pay-message',o.status === 'clarify' ? ('Требуется уточнение: '+(o.clarify_reason||'Загрузите новое подтверждение.')) : '');
  $('pay-my-orders').querySelectorAll('.payment-order-card').forEach(b=>b.classList.toggle('selected',b.dataset.orderId===o.order_id));
}
$('pay-amount').onchange=()=>{currentOrder=null;$('pay-order').classList.add('hidden');$('pay-start').classList.remove('hidden');};
$('pay-start').onclick=async()=>{
  const b=$('pay-start');b.disabled=true;info('pay-message','Создаём заявку…');
  try{
    const o=await api('/api/payments/orders',{method:'POST',body:{amount:Number($('pay-amount').value)}});
    currentOrder=o;await loadOrders();showOrder(o);info('pay-message','Заявка создана. Оплатите по СБП, затем приложите банковский чек.');
  }catch(err){info('pay-message',err.message,true);}finally{b.disabled=false;}
};
$('pay-submit').onclick=async()=>{
  if(!currentOrder)return;
  const file=$('pay-proof-file').files?.[0];
  if(!file || !['image/jpeg','image/png','application/pdf'].includes(file.type) || file.size<1 || file.size>8*1024*1024){
    info('pay-message','Выберите JPG, PNG или PDF размером до 8 МБ.',true);return;
  }
  const b=$('pay-submit');b.disabled=true;
  try{
    const form=new FormData();form.append('file',file);
    await api(`/api/payments/orders/${encodeURIComponent(currentOrder.order_id)}/proof`,{method:'POST',body:form});
    currentOrder=null;$('pay-order').classList.add('hidden');$('pay-start').classList.remove('hidden');
    info('pay-message','Подтверждение отправлено на проверку по выписке ВТБ.');await loadOrders();await refreshBalance();
  }catch(err){info('pay-message',err.message,true);}finally{b.disabled=false;}
};
$('pay-qr-button').onclick=async()=>{
  if(!currentOrder || (!paymentQr&&!paymentLink))return;
  const button=$('pay-qr-button');button.disabled=true;
  try{await loadOrders();}catch(err){info('pay-message','Не удалось проверить заявку: '+err.message,true);button.disabled=false;return;}
  button.disabled=false;
  if(!currentOrder || !['pending','review','clarify'].includes(currentOrder.status))return;
  $('sbp-modal-sum').textContent=rubles(currentOrder.amount);
  $('sbp-modal-credits').textContent=credits(currentOrder.amount);
  $('sbp-modal-order-id').textContent='Заявка: '+currentOrder.order_id.slice(0,12);
  $('pay-qr').classList.toggle('hidden',!paymentQr);
  if(paymentQr)$('pay-qr').src=paymentQr;else $('pay-qr').removeAttribute('src');
  $('pay-link').classList.toggle('hidden',!paymentLink);if(paymentLink)$('pay-link').href=paymentLink;
  $('pay-qr-error').classList.add('hidden');
  $('pay-qr-modal').classList.remove('hidden');$('pay-qr-back').focus();
};
$('pay-qr').onerror=()=>{$('pay-qr').classList.add('hidden');$('pay-qr-error').classList.remove('hidden');};
$('pay-qr').onload=()=>{$('pay-qr').classList.remove('hidden');$('pay-qr-error').classList.add('hidden');};
function closeQr(){$('pay-qr-modal').classList.add('hidden');$('pay-qr-button').focus();}
$('pay-qr-back').onclick=closeQr;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('pay-qr-modal').classList.contains('hidden'))closeQr();});
// Refresh when returning from MAX administrator moderation or another tab.
// Do not clear an uploaded proof when an order's status has not changed.
async function refreshOrdersOnReturn(){
  if(!token || document.hidden)return;
  try{await loadOrders();}catch(err){info('pay-message','Не удалось обновить заявки: '+err.message,true);}
}
window.addEventListener('focus',()=>{void refreshOrdersOnReturn();});
window.addEventListener('pageshow',()=>{void refreshOrdersOnReturn();});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshOrdersOnReturn();});
$('retry').onclick=login;
document.querySelectorAll('[data-legal]').forEach(link=>link.onclick=e=>{e.preventDefault();$('legal-frame').src=link.getAttribute('href');$('legal-overlay').classList.remove('hidden');});
$('legal-close').onclick=()=>{$('legal-overlay').classList.add('hidden');$('legal-frame').removeAttribute('src');};
// Hide the legal document's own back link so the modal has only one return control.
// Legal pages are same-origin documents loaded from /legal/*.html.
$('legal-frame').addEventListener('load', () => {
  try {
    const doc = $('legal-frame').contentDocument;
    if (!doc) return;
    doc.querySelectorAll('a, button').forEach(el => {
      if (/вернуться/i.test(el.textContent || '')) {
        el.hidden = true;
        el.style.setProperty('display', 'none', 'important');
      }
    });
  } catch (_) { /* No access to cross-origin frames; do not affect navigation. */ }
});

login();
