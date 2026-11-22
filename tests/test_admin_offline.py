"""Offline regression tests of admin flags and financial idempotency; NO live services."""
from pathlib import Path
from html.parser import HTMLParser
import importlib.util, sys, types, re
root=Path(__file__).resolve().parent
# Use original (non-runtime) Store module for Conflict and now, without connecting to YDB.
package=types.ModuleType('backend');package.__path__=[str(root/'backend')]
sys.modules['backend']=package
storage=types.ModuleType('backend.storage')
class Conflict(Exception):pass
storage.Conflict=Conflict
storage.now=lambda:'2026-11-22T00:00:00Z'
sys.modules['backend.storage']=storage
spec=importlib.util.spec_from_file_location('backend.admin_topups',root/'backend/admin_topups.py')
mod=importlib.util.module_from_spec(spec);sys.modules[spec.name]=mod;spec.loader.exec_module(mod)

class Fake:
    def __init__(self):
        self.orders={
          'a':dict(order_id='a',user_id='u',amount=10000,status='pending',proof_key='',receipt='',created_at='2026-11-22'),
          'b':dict(order_id='b',user_id='u',amount=5000,status='review',proof_key='p.jpg',receipt='',created_at='2026-11-22')}
        self.meta={};self.approvals={}
    def query(self,q,**args):
        if 'FROM igk_topup_admin_meta' in q:
            return ([dict(v) for v in self.meta.values()] if not args else ([dict(self.meta[args['id']])] if args['id'] in self.meta else []))
        if 'FROM igk_topups' in q:
            return [dict(self.orders[args['id']])] if args['id'] in self.orders else []
        raise AssertionError(q)
    def run(self,tx,q,**args):
        if 'SELECT' in q and 'igk_topup_admin_meta' in q:
            return self.query(q,**args)
        if 'SELECT' in q and 'igk_topups' in q:
            return [dict(self.orders[args['id']])] if args['id'] in self.orders else []
        if 'UPSERT INTO igk_topup_admin_meta' in q:
            self.meta[args['id']]=dict(order_id=args['id'],hidden=args['hidden'],archived=args['archived'],clarify_reason=args['reason'],
              bank_without_id=args['noid'],bank_received_at=args['when'],bank_description=args['description'],
              receipt_url=args['url'],receipt_number=args['number'],updated_at=args['time']);return []
        if 'UPDATE igk_topups' in q:
            self.orders[args['id']]['status']='cancelled';return []
        raise AssertionError(q)
    def transaction(self,fn):return fn(None)
    def admin_orders(self):return [dict(x) for x in self.orders.values()]
    def approve(self,order_id,ref,receipt,amount):
        o=self.orders[order_id]
        if o['status']=='paid':return False
        assert o['status']=='review'
        assert o['amount']==amount
        assert ref not in self.approvals
        self.approvals[ref]=order_id
        o['status']='paid';o['receipt']=receipt
        return True

s=Fake();adm=mod.AdminTopups(s)
assert len(adm.list())==2
assert adm.set_flag('a','hide')
assert [r['order_id'] for r in adm.list()] == ['b']
assert [r['order_id'] for r in adm.list(True)] == ['a']
assert adm.set_flag('a','restore')
assert len(adm.list())==2
assert adm.set_flag('a','cancel')
assert adm.detail('a')['status']=='cancelled'
try:adm.set_flag('a','cancel');assert False
except Conflict:pass
adm.clarify('b','Сумма подтверждения не совпадает')
assert adm.detail('b')['status']=='clarify'
try:adm.approve('b','VTB Operation 123456',5000,'receipt 42');assert False
except Conflict:pass
adm.clear_clarification('b')
assert adm.detail('b')['status']=='review'
assert adm.approve('b','VTB Operation 123456',5000,'receipt 42',receipt_url='https://example.org/receipt',receipt_number='receipt 42')
assert len(s.approvals)==1
try:adm.approve('b','VTB Operation 123456',5000,'receipt 42');assert False
except Conflict:pass
assert len(s.approvals)==1
assert adm.enrich_user_orders([dict(s.orders['b'])])[0]['receipt']=='https://example.org/receipt'
assert adm.set_flag('b','hide')
assert adm.set_flag('b','archive')
assert not adm.list(True)
try:adm.set_flag('b','restore');assert False
except Conflict:pass
assert '2026-11-22T10:20:00' in adm.reference_for_payment('Перевод по номеру телефона',True,'2026-11-22T10:20',5000)

class Ids(HTMLParser):
    def __init__(self):super().__init__();self.ids=set()
    def handle_starttag(self,tag,attrs):
        for k,v in attrs:
            if k=='id':self.ids.add(v)
for html,js in [('index.html','app.js'),('payment.html','payment.js')]:
    p=Ids();p.feed((root/'frontend'/html).read_text())
    refs=set(re.findall(r"\$\('([a-zA-Z0-9_-]+)'\)",(root/'frontend'/js).read_text()))
    assert refs <= p.ids, (html, refs-p.ids)

# Changes MUST be limited to the admin section and its support routes.
html=(root/'frontend/index.html').read_text()
assert '<h2>Заявки на пополнение</h2>' in html
assert 'provider-audit-panel' not in html
assert 'pay-admin' in html
assert 'id="admin-approve"' in html
assert 'igk_topup_admin_meta' in (root/'migration.sql').read_text()
print('Admin management offline tests: PASS')
