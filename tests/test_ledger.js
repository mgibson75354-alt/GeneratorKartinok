'use strict';
// Offline test of the real frontend movement formatter; does not call YDB, MAX or reAPI.
const fs=require('fs'), vm=require('vm'), assert=require('assert');
const src=fs.readFileSync(__dirname+'/frontend/app.js','utf8');
const runnable=src.slice(0,src.indexOf("$('provider-audit-refresh').onclick"));
class MockNode {
 constructor(tag){this.tag=tag;this.children=[];this.textContent='';this.className='';this.type='';this.classList={toggle:()=>{}};}
 append(...nodes){this.children.push(...nodes)}
 replaceChildren(){this.children=[];this.textContent=''}
 addEventListener(){}
 get innerText(){return this.textContent+' '+this.children.map(x=>x.innerText).join(' ')}
}
const nodes={};
const document={getElementById:id=>(nodes[id]||=(new MockNode(id))),createElement:tag=>new MockNode(tag)};
const context=vm.createContext({document,window:{APP_CONFIG:{}},URL,Number,String,Map,Math,Date,Intl,console});
vm.runInContext(runnable,context);
vm.runInContext(`
 currentWallet={available:2000,held:0};
 currentHistory={
 jobs:[{job_id:'A',kind:'text',aspect:'1:1',price:1000,status:'completed',prompt:'Тест'}],
 movements:[
 {kind:'payment',amount:0,reference:'A',created_at:'2026-11-22T10:06:26+00:00'},
 {kind:'reserve',amount:-1000,reference:'A',created_at:'2026-11-22T10:05:25+00:00'},
 {kind:'welcome',amount:3000,reference:'welcome-v1',created_at:'2026-11-21T09:00:00+00:00'}
 ]};
 renderHistory();
`,context);
const rendered=nodes.movements.children.map(x=>x.innerText);
assert.strictEqual(rendered.length,3);
assert.match(rendered[0],/Оплата из резерва/);
assert.match(rendered[0],/1,00 кредита/);
assert.match(rendered[0],/подтверждена/);
assert.doesNotMatch(rendered[0],/\+0,00/);
assert.match(rendered[1],/Резервирование средств/);
assert.match(rendered[1],/−1,00 кредита/);
assert.match(rendered[2],/Приветственные 3 кредита/);
assert.match(rendered[2],/\+3,00 кредита/);
assert.match(rendered[0],/Баланс — 2,00 кредита/);
assert.match(rendered[2],/Баланс — 3,00 кредита/);
vm.runInContext(`
 currentWallet={available:3000,held:0};
 currentHistory={jobs:[],movements:[
 {kind:'release',amount:1000,reference:'A',created_at:'2026-11-22T11:00:00+00:00'},
 {kind:'payment',amount:0,reference:'A',created_at:'2026-11-22T10:06:26+00:00'},
 {kind:'reserve',amount:-1000,reference:'A',created_at:'2026-11-22T10:05:25+00:00'},
 {kind:'topup',amount:10000,reference:'order1',created_at:'2026-11-21T09:00:00+00:00'}
 ]};
 renderHistory();
`,context);
const past=nodes.movements.children.map(x=>x.innerText);
assert.match(past[0],/Возврат резерва/);
assert.match(past[0],/\+1,00 кредита/);
assert.match(past[1],/Оплата из резерва/);
assert.match(past[1],/1,00 кредита/); // Price recovered from matching reserve, even after job deletion
assert.match(past[3],/Пополнение баланса/);
assert.match(past[3],/\+10,00 кредита/);
console.log('PASS: payment/hold/release/welcome/topup, balances, orphan payment price, zero-payment formatting.');
