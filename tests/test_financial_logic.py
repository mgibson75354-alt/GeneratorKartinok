from backend.storage import Store, Conflict
import pytest


def fake_store(query_handler):
    store=Store.__new__(Store)
    store.transaction=lambda fn:fn(None)
    store.run=lambda tx,query,**p:query_handler(query,p)
    store._movement=lambda *args,**kwargs:None
    return store


def test_welcome_credit_idempotence_on_repeat_login():
    state={'wallet':None,'bonus':False}
    def handle(q,p):
        if 'SELECT available,held FROM igk_wallets' in q:
            return [state['wallet']] if state['wallet'] else []
        if 'INSERT INTO igk_wallets' in q:
            state['wallet']={'available':0,'held':0};return []
        if 'SELECT bonus_id FROM igk_bonus_awards' in q:
            return [{'bonus_id':'welcome-v1'}] if state['bonus'] else []
        if 'UPSERT INTO igk_bonus_awards' in q:
            state['bonus']=True;return []
        if 'UPDATE igk_wallets SET available' in q:
            state['wallet']['available']=p['a'];return []
        raise AssertionError('Unexpected query '+q)
    store=fake_store(handle)
    store.register('1111',3000)
    store.register('1111',3000)
    assert state['wallet']['available']==3000


def test_refuse_duplicate_bank_transaction():
    store=fake_store(lambda q,p: [{'order_id':'other-order'}] if 'SELECT order_id FROM igk_bank_refs' in q else [])
    with pytest.raises(Conflict,match='привязана'):
        store.approve('current-order','перевод 21.11.2026 12:45','НПД123',5000)


def test_already_confirmed_payment_no_new_credit():
    seen=[]
    def handler(q,p):
        seen.append(q)
        if 'SELECT order_id FROM igk_bank_refs' in q:return [{'order_id':'same-order'}]
        if 'SELECT status FROM igk_topups' in q:return [{'status':'paid'}]
        raise AssertionError('Should not write again')
    store=fake_store(handler)
    assert store.approve('same-order','перевод 21.11.2026 12:45','НПД123',5000) is False
    assert len(seen)==2


def test_duplicate_request_id_returns_existing_job_without_reserve():
    def handler(q,p):
        if 'SELECT job_id FROM igk_idempotency' in q:return [{'job_id':'job1'}]
        if 'SELECT * FROM igk_jobs' in q:return [{'job_id':'job1','status':'completed','price':1000}]
        raise AssertionError('A duplicate request must not charge again')
    store=fake_store(handler)
    job,created=store.reserve('1111','some-old-id','text','landscape','4:5',1000)
    assert created is False and job['status']=='completed'


def test_capture_is_idempotent():
    store=fake_store(lambda q,p:[{'status':'completed','price':1000}] if 'SELECT status,price' in q else [])
    assert store.settle('1111','job1',True,'generator/v1/results/1111/job1.png') is False


def test_release_restores_credit_once():
    state={'status':'unknown','available':1000,'held':1000,'writes':[]}
    def handler(q,p):
        if 'SELECT status,price FROM igk_jobs' in q:return [{'status':state['status'],'price':1000}]
        if 'SELECT available,held FROM igk_wallets' in q:return [{'available':state['available'],'held':state['held']}]
        if 'UPDATE igk_wallets' in q:
            state['available']=p['a'];state['held']=p['h'];state['writes'].append(('wallet',p));return []
        if 'UPDATE igk_jobs' in q:
            state['status']=p['s'];return []
        raise AssertionError('Unexpected query: '+q)
    store=fake_store(handler)
    assert store.settle('1111','job1',False,reason='manual-check') is True
    assert store.settle('1111','job1',False,reason='manual-check') is False
    assert state['available']==2000 and state['held']==0
    assert len(state['writes'])==1
