'use strict';
const $=id=>document.getElementById(id);
const base=(window.APP_CONFIG?.API_BASE||'').replace(/\/$/,'');
const escaped=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&quot;'}[c]));
const credits=k=>(Number(k||0)/1000).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' кредитов';
let token='',profile={},orderId='',selected='',busy=false;
async function api(path,opts={}){
 const res=await fetch(base+path,{...opts,headers:{'X-App-Authorization':`Bearer ${token}`,...(opts.headers||{})}});
 let data;try{data=await res.json()}catch{throw Error('HTTP '+res.status)}
 if(!res.ok)throw Error(data.detail||'HTTP '+res.status);return data;
}
const status=s=>$('payment-message').textContent=s;
async function login(){
 try{
  const raw=window.WebApp?.initData;if(!raw)throw Error('Откройте приложение через MAX');
  const r=await fetch(base+'/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:raw})});
  const data=await r.json();if(!r.ok)throw Error(data.detail||'Авторизация не удалась');token=data.token;
  $('workspace').classList.remove('hidden');$('gate').classList.add('hidden');await refresh();
 }catch(e){$('gate-title').textContent='Доступ не подтверждён';$('gate-message').textContent=e.message;$('retry').classList.remove('hidden')}
}
async function refresh(){
 profile=await api('/api/profile');$('balance').textContent=credits(profile.wallet.available);
 $('create-order').disabled=!profile.payments_enabled;
 if(!profile.payments_enabled)status('Пополнение пока отключено администратором.');
 const orders=(await api('/api/payments/orders')).orders;
 $('orders').innerHTML=orders.length?orders.map(o=>`<div class="history-item"><div><strong>${escaped(o.order_id.slice(0,12))} · ${(o.amount/100).toFixed(2)} ₽</strong><div><span>${escaped(o.status)} · ${escaped(o.created_at)}</span></div>${o.receipt?`<span>Чек НПД: ${escaped(o.receipt)}</span>`:''}</div></div>`).join(''):'Заявок пока нет.';
 $('admin-box').classList.toggle('hidden',!profile.admin);
 if(profile.admin){$('admin-jobs-box').classList.remove('hidden');await loadAdmin();await loadJobs();}
}
$('retry').onclick=login;
$('create-order').onclick=async()=>{
 if(busy)return;busy=true;$('create-order').disabled=true;
 try{
 const o=await api('/api/payments/orders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount:Number($('amount').value)})});
 orderId=o.order_id;$('active-order').classList.remove('hidden');$('order-summary').textContent=`Заявка №${o.order_id.slice(0,12)} · ${(o.amount/100).toFixed(2)} ₽ · Ожидает оплаты`;
 status('Заявка создана. Оплатите переводом и прикрепите банковский чек.');await refresh();
 }catch(e){status(e.message)}finally{busy=false;$('create-order').disabled=!profile.payments_enabled}
};
$('pay-button').onclick=()=>{
 $('qr-modal').classList.remove('hidden');$('qr-caption').textContent=`Заявка ${orderId.slice(0,12)}. Переведите точную сумму. Сохраните чек из ВТБ.`;
 if(profile.payment_qr_url){$('qr-image').src=profile.payment_qr_url;$('qr-image').classList.remove('hidden')}else{$('qr-image').removeAttribute('src')}
 $('sbp-link').classList.toggle('hidden',!profile.payment_sbp_link);if(profile.payment_sbp_link)$('sbp-link').href=profile.payment_sbp_link;
};
$('qr-close').onclick=()=>$('qr-modal').classList.add('hidden');
$('submit-proof').onclick=async()=>{
 if(!orderId){status('Сначала создайте заявку');return}
 const file=$('proof').files[0];if(!file){status('Прикрепите чек');return}if(file.size>8*1024*1024){status('Файл больше 8 МБ');return}
 $('submit-proof').disabled=true;const form=new FormData();form.append('file',file);
 try{await api('/api/payments/orders/'+encodeURIComponent(orderId)+'/proof',{method:'POST',body:form});status('Чек получен. Ожидайте проверки поступления администратором ВТБ.');await refresh()}
 catch(e){status(e.message)}finally{$('submit-proof').disabled=false}
};
async function loadAdmin(){
 const data=await api('/api/admin/orders');$('admin-orders').innerHTML=data.orders.map(o=>`<button type="button" class="history-item button outline wide" data-order="${escaped(o.order_id)}"><span>${escaped(o.order_id.slice(0,12))} · ${(o.amount/100).toFixed(2)} ₽ · ${escaped(o.status)} · MAX ${escaped(o.user_id)}</span></button>`).join('');
 $('admin-orders').querySelectorAll('button').forEach((button,i)=>button.onclick=()=>choose(data.orders[i]));
}
function choose(o){selected=o.order_id;$('admin-detail').classList.remove('hidden');$('admin-selected').textContent=`Заявка ${o.order_id.slice(0,12)} · MAX ${o.user_id}`;$('bank-amount').value=(o.amount/100).toFixed(2);$('admin-proof').href=o.proof_url||'#';$('admin-proof').classList.toggle('hidden',!o.proof_url);$('admin-message').textContent=o.status==='review'?'Сверьте перевод в банке перед подтверждением.':'Нельзя начислять до получения подтверждения клиента.';}
$('admin-refresh').onclick=loadAdmin;
async function loadJobs(){
 const data=await api('/api/admin/jobs');
 $('admin-jobs').innerHTML=data.jobs.length?data.jobs.map(j=>`<div class="history-item"><div><strong>${escaped(j.job_id.slice(0,12))} · ${escaped(j.status)}</strong><div><span>MAX ${escaped(j.user_id)} · ${credits(j.price)}</span></div><p class="fine">${escaped(j.error||j.prompt.slice(0,110))}</p></div><button class="button outline" type="button" data-job="${escaped(j.job_id)}">Вернуть резерв</button></div>`).join(''):'Нет незавершённых заданий.';
 $('admin-jobs').querySelectorAll('button').forEach((btn,i)=>btn.onclick=async()=>{
 const j=data.jobs[i];if(!confirm(`Подтверждаете, что в ProxyAPI не было выполненной платной генерации №${j.job_id.slice(0,12)}? Вернуть резерв?`))return;
 btn.disabled=true;
 try{await api('/api/admin/jobs/'+encodeURIComponent(j.user_id)+'/'+encodeURIComponent(j.job_id)+'/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({success:false,note:'Ручная сверка с провайдером: генерация не выполнена'})});await loadJobs();await refresh();}
 catch(e){alert(e.message)}finally{btn.disabled=false}
 });
}
$('jobs-refresh').onclick=loadJobs;
$('approve').onclick=async()=>{
 if(!selected)return;$('approve').disabled=true;
 try{const p={bank_reference:$('bank-reference').value,amount:Math.round(Number($('bank-amount').value)*100),receipt:$('npd-receipt').value};
 const result=await api('/api/admin/orders/'+encodeURIComponent(selected)+'/approve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
 $('admin-message').textContent=result.credited?'Кредиты начислены однократно.':'Заявка уже подтверждена.';await refresh();}
 catch(e){$('admin-message').textContent=e.message}finally{$('approve').disabled=false}
};
document.querySelectorAll('[data-legal]').forEach(a=>a.addEventListener('click',e=>{
 e.preventDefault();$('legal-frame').src=a.getAttribute('href');$('legal-overlay').classList.remove('hidden');
}));
$('legal-close').onclick=()=>{$('legal-overlay').classList.add('hidden');$('legal-frame').removeAttribute('src')};
login();
