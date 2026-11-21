'use strict';
const $=id=>document.getElementById(id);
const base=(window.APP_CONFIG?.API_BASE||'').replace(/\/$/,'');
let token='',active=false,referenceKey='',busy=false;
const escaped=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const credits=k=>(Number(k||0)/1000).toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' кредитов';
async function api(path,opts={}){
 const res=await fetch(base+path,{...opts,headers:{'X-App-Authorization':`Bearer ${token}`,...(opts.headers||{})}});
 let data;try{data=await res.json()}catch{throw Error(`HTTP ${res.status}`)}
 if(!res.ok)throw Error(typeof data.detail==='string'?data.detail:`HTTP ${res.status}`);
 return data;
}
function error(message){$('message').textContent=message;$('message').classList.add('error')}
function status(message){$('message').textContent=message;$('message').classList.remove('error')}
function check(){ $('generate').disabled=!active||busy||!$('rights').checked||$('prompt').value.trim().length<10||( $('mode').value==='reference'&&!referenceKey ); }
async function login(){
 $('retry').classList.add('hidden');$('gate-title').textContent='Проверяем доступ…';
 try{
   const raw=window.WebApp?.initData;
   if(!raw)throw Error('Откройте мини-приложение кнопкой внутри MAX, не прямой ссылкой.');
   const r=await fetch(base+'/api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({init_data:raw})});
   const data=await r.json();if(!r.ok)throw Error(data.detail||'Ошибка входа'); token=data.token;
   await refresh();$('gate').classList.add('hidden');$('workspace').classList.remove('hidden');
 }catch(e){ $('gate-title').textContent='Доступ не подтверждён';$('gate-message').textContent=e.message;$('retry').classList.remove('hidden'); }
}
async function refresh(){
 const data=await api('/api/profile');active=data.generation_enabled;
 const selector=$('provider-block');
 selector.classList.toggle('hidden',!data.provider_selector_visible);
 $('provider-audit-panel').classList.toggle('hidden',!data.admin);
 const allowed=data.available_providers||[];
 $('provider').querySelectorAll('option').forEach(o=>{o.disabled=!allowed.includes(o.value)});
 if(!data.provider_selector_visible || !allowed.includes($('provider').value)) $('provider').value= data.provider_default||'proxyapi';
 $('balance').textContent=credits(data.wallet.available);$('price').textContent=credits(data.price);
 if(!active)status('Генерация ещё не включена администратором.');
 check();const h=await api('/api/history');renderHistory(h);
}
function renderHistory(data){
 $('history').innerHTML=(!data.jobs.length)?'История пока пуста.':data.jobs.map(j=>`<div class="history-item"><div><strong>${escaped(j.prompt).slice(0,120)}</strong><div><span>${escaped(j.created_at)} · ${escaped(j.status)} · ${credits(j.price)}</span></div></div>${j.image_url?`<a target="_blank" rel="noopener noreferrer" href="${escaped(j.image_url)}">Открыть</a>`:''}</div>`).join('');
 $('movements').innerHTML=(!data.movements.length)?'Операций пока нет.':data.movements.map(m=>`<div class="history-item"><div>${escaped(m.note||m.kind)}<div><span>${escaped(m.created_at)}</span></div></div><strong>${m.amount>=0?'+':''}${credits(m.amount)}</strong></div>`).join('');
}
async function loadProviderAudit(){
 const el=$('provider-audit-list');el.textContent='Загрузка журнала…';
 try{
  const response=await api('/api/admin/provider-usage');
  el.innerHTML=(!response.items.length)?'Генераций пока нет.':response.items.map(x=>{
   const usage=x.usage||{};
   const reapiCredits=typeof usage.credits==='number'?` · ${usage.credits} кредитов reAPI ($${(usage.credits*.001).toFixed(3)})`:'';
   const usageText=Object.keys(usage).length?JSON.stringify(usage).slice(0,240):'Использование не указано в API';
   return `<div class="history-item"><div><strong>${escaped(x.provider)} · ${escaped(x.status)}</strong><div><span>${escaped(x.updated_at)} · ${escaped(x.model||'—')} · ${Number(x.seconds||0)/1000} с${reapiCredits}</span></div><div><span>${escaped(usageText)}</span></div><div><span>ID: ${escaped(x.job_id)} ${escaped(x.task_id||'')}</span></div></div></div>`;
  }).join('');
 }catch(e){el.textContent='Ошибка журнала: '+e.message;}
}
$('provider-audit-refresh').onclick=loadProviderAudit;
$('retry').onclick=login;
$('prompt').addEventListener('input',()=>{$('prompt-length').textContent=$('prompt').value.length+' / 1800';check()});
$('rights').onchange=check;
$('mode').onchange=()=>{referenceKey='';$('reference').value='';$('reference-panel').classList.toggle('hidden',$('mode').value!=='reference');check()};
$('reference').onchange=async()=>{
 referenceKey='';const file=$('reference').files[0];if(!file){check();return}
 if(file.size>8*1024*1024){error('Файл больше 8 МБ');check();return}
 $('reference-status').textContent='Загружаем референс…';const form=new FormData();form.append('file',file);
 try{const data=await api('/api/reference',{method:'POST',body:form});referenceKey=data.reference_key;$('reference-preview').src=data.preview_url;$('reference-preview').classList.remove('hidden');$('reference-status').textContent='Референс загружен';}catch(e){error(e.message)}check();
};
$('generate').onclick=async()=>{
 check();if($('generate').disabled)return;busy=true;check();status('Генерация выполняется. Не закрывайте приложение…');
 try{
  const p={request_id:crypto.randomUUID(),provider:$('provider').value,prompt:$('prompt').value.trim(),style:$('style').value,aspect:$('aspect').value,mode:$('mode').value,reference_key:referenceKey,confirm_rights:$('rights').checked};
  const data=await api('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
  if(data.status==='completed'&&data.image_url){$('result-image').src=data.image_url;$('download').href=data.image_url;$('result-panel').classList.remove('hidden');status('Изображение создано!');$('result-panel').scrollIntoView({behavior:'smooth'});}else{status('Задание принято. Статус: '+data.status+'; повторный запуск не требуется.');}
  await refresh();
 }catch(e){error(e.message);try{await refresh()}catch{}}finally{busy=false;check()}
};
$('new-image').onclick=()=>{$('result-panel').classList.add('hidden');$('rights').checked=false;check();window.scrollTo({top:0,behavior:'smooth'})};
document.querySelectorAll('[data-legal]').forEach(a=>a.addEventListener('click',e=>{
 e.preventDefault();$('legal-frame').src=a.getAttribute('href');$('legal-overlay').classList.remove('hidden');
}));
$('legal-close').onclick=()=>{$('legal-overlay').classList.add('hidden');$('legal-frame').removeAttribute('src')};
login();
