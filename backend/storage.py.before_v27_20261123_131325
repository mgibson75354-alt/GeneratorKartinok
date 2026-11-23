"""YDB Query Service adapter; supports atomic multi-table mutations.

No network calls when imported. YDB credentials are resolved via SDK environment
or the Serverless Container's attached service account.
"""
from __future__ import annotations
import os
import json
import uuid
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def rows(result):
    out = []
    for rs in result:
        out.extend(dict(row.items()) if hasattr(row, 'items') else dict(row) for row in rs.rows)
    return out


class Conflict(Exception):
    pass


class Store:
    def __init__(self):
        import ydb
        self.ydb = ydb
        self.driver = ydb.Driver(
            endpoint=os.environ['YDB_ENDPOINT'],
            database=os.environ['YDB_DATABASE'],
            credentials=ydb.credentials_from_env_variables(),
        )
        self.driver.wait(timeout=12, fail_fast=True)
        self.pool = ydb.QuerySessionPool(self.driver)

    def close(self):
        self.pool.stop()
        self.driver.stop()

    def query(self, query, **params):
        prepared = {
            "$" + key.lstrip("$"): value
            for key, value in params.items()
        }
        return rows(self.pool.execute_with_retries(
            query,
            prepared,
            retry_settings=self.ydb.RetrySettings(idempotent=True)
        ))

    @staticmethod
    def run(tx, query, **params):
        prepared = {
            "$" + key.lstrip("$"): value
            for key, value in params.items()
        }
        with tx.execute(query, prepared) as response:
            return rows(response)

    def transaction(self, fn):
        def operation(session):
            with session.transaction(self.ydb.QuerySerializableReadWrite()) as tx:
                value = fn(tx)
                tx.commit()
                return value
        return self.pool.retry_operation_sync(
            operation,
            retry_settings=self.ydb.RetrySettings(max_retries=5, idempotent=True),
        )

    def _movement(self, tx, user, kind, amount, note, reference):
        self.run(tx,
            'INSERT INTO igk_movements (user_id,created_at,movement_id,kind,amount,note,reference) '
            'VALUES ($u,$t,$id,$k,$a,$n,$r)',
            u=user,t=now(),id=uuid.uuid4().hex,k=kind,a=amount,n=note,r=reference)

    def audit_provider(self,user,job_id,provider_name,status,task_id='',model='',usage=None,seconds=0,note=''):
        """One upsertable audit row per job; no impact on credit calculation."""
        data=json.dumps(usage or {},ensure_ascii=False,default=str)[:12000]
        self.query('UPSERT INTO igk_provider_audit '
                   '(user_id,job_id,provider,status,task_id,model,usage_json,seconds,note,updated_at) '
                   'VALUES ($u,$j,$p,$s,$t,$m,$usage,$secs,$note,$time)',
                   u=user,j=job_id,p=provider_name,s=status,t=task_id,m=model,
                   usage=data,secs=int(float(seconds)*1000),note=str(note)[:250],time=now())

    def provider_usage(self):
        records=self.query('SELECT user_id,job_id,provider,status,task_id,model,usage_json,seconds,note,updated_at '
                           'FROM igk_provider_audit ORDER BY updated_at DESC LIMIT 100')
        for row in records:
            try:row['usage']=json.loads(row.pop('usage_json','{}') or '{}')
            except (TypeError,ValueError):row['usage']={}
        return records

    def register(self, user, bonus_kopeks):
        """Exactly-once welcome credit, even with simultaneous sign-in calls."""
        def operation(tx):
            wallet = self.run(tx,'SELECT available,held FROM igk_wallets WHERE user_id=$u',u=user)
            if not wallet:
                self.run(tx,'INSERT INTO igk_wallets (user_id,available,held,created_at) '
                         'VALUES ($u,0,0,$t)',u=user,t=now())
            awarded = self.run(tx,'SELECT bonus_id FROM igk_bonus_awards '
                               'WHERE user_id=$u AND bonus_id=$b',u=user,b='welcome-v1')
            if not awarded and bonus_kopeks:
                self.run(tx,'UPSERT INTO igk_bonus_awards (user_id,bonus_id,created_at) '
                         'VALUES ($u,$b,$t)',u=user,b='welcome-v1',t=now())
                amount = int(wallet[0]['available']) if wallet else 0
                self.run(tx,'UPDATE igk_wallets SET available=$a WHERE user_id=$u',
                         a=amount+bonus_kopeks,u=user)
                self._movement(tx,user,'welcome',bonus_kopeks,'Приветственные кредиты','welcome-v1')
        self.transaction(operation)

    def wallet(self,user):
        result=self.query('SELECT available,held FROM igk_wallets WHERE user_id=$u',u=user)
        if not result: raise Conflict('Кошелёк не найден')
        return result[0]

    def history(self,user):
        jobs=self.query('SELECT job_id,status,kind,prompt,aspect,price,output_key,created_at '
                        'FROM igk_jobs WHERE user_id=$u ORDER BY created_at DESC LIMIT 30',u=user)
        moves=self.query('SELECT kind,amount,note,reference,created_at FROM igk_movements '
                         'WHERE user_id=$u ORDER BY created_at DESC LIMIT 50',u=user)
        return {'jobs':jobs,'movements':moves}

    def reserve(self,user,request_id,kind,prompt,aspect,price,source_key=''):
        if not request_id or len(request_id)>120: raise Conflict('Некорректный request_id')
        def operation(tx):
            prior=self.run(tx,'SELECT job_id FROM igk_idempotency WHERE user_id=$u AND request_id=$r',u=user,r=request_id)
            if prior:
                job=self.run(tx,'SELECT * FROM igk_jobs WHERE user_id=$u AND job_id=$id',u=user,id=prior[0]['job_id'])
                if not job: raise Conflict('Идентификатор задания занят; обратитесь к администратору')
                return job[0],False
            busy=self.run(tx,"SELECT job_id FROM igk_jobs WHERE user_id=$u "
                               "AND status IN ('reserved','unknown') LIMIT 1",u=user)
            if busy: raise Conflict('Предыдущее задание ещё выполняется или требует проверки')
            balances=self.run(tx,'SELECT available,held FROM igk_wallets WHERE user_id=$u',u=user)
            if not balances or int(balances[0]['available'])<price: raise Conflict('Недостаточно кредитов')
            jid=uuid.uuid4().hex
            self.run(tx,'UPDATE igk_wallets SET available=$a,held=$h WHERE user_id=$u',
                 a=int(balances[0]['available'])-price,h=int(balances[0]['held'])+price,u=user)
            self.run(tx,'INSERT INTO igk_jobs (user_id,job_id,request_id,created_at,status,kind,prompt,aspect,price,source_key,output_key,error) '
                 "VALUES ($u,$id,$r,$t,'reserved',$k,$p,$a,$pr,$s,'','')",
                 u=user,id=jid,r=request_id,t=now(),k=kind,p=prompt,a=aspect,pr=price,s=source_key)
            self.run(tx,'INSERT INTO igk_idempotency (user_id,request_id,job_id) VALUES ($u,$r,$j)',
                 u=user,r=request_id,j=jid)
            self._movement(tx,user,'reserve',-price,'Резервирование генерации',jid)
            return {'user_id':user,'job_id':jid,'status':'reserved','price':price},True
        return self.transaction(operation)

    def mark_unknown(self,user,job_id,reason):
        """Provider response ambiguous: hold funds, no automatic refund or resubmit."""
        reason=str(reason)[:250]
        def operation(tx):
            job=self.run(tx,'SELECT status FROM igk_jobs WHERE user_id=$u AND job_id=$j',u=user,j=job_id)
            if job and job[0]['status']=='reserved':
                self.run(tx,"UPDATE igk_jobs SET status='unknown',error=$e WHERE user_id=$u AND job_id=$j",u=user,j=job_id,e=reason)
        self.transaction(operation)

    def settle(self,user,job_id,success,output_key='',reason=''):
        def operation(tx):
            job=self.run(tx,'SELECT status,price FROM igk_jobs WHERE user_id=$u AND job_id=$j',u=user,j=job_id)
            if not job: raise Conflict('Задание не найдено')
            if job[0]['status'] in ('completed','failed'):
                return False
            if job[0]['status'] not in ('reserved','unknown'): raise Conflict('Неверное состояние задания')
            if success and not output_key: raise Conflict('Нет сохранённого результата')
            wallet=self.run(tx,'SELECT available,held FROM igk_wallets WHERE user_id=$u',u=user)[0]
            price=int(job[0]['price']); held=int(wallet['held'])-price
            if held<0: raise Conflict('Некорректный резерв')
            available=int(wallet['available'])+(0 if success else price)
            self.run(tx,'UPDATE igk_wallets SET available=$a,held=$h WHERE user_id=$u',u=user,a=available,h=held)
            self.run(tx,'UPDATE igk_jobs SET status=$s,output_key=$o,error=$e WHERE user_id=$u AND job_id=$j',
                     s='completed' if success else 'failed',o=output_key,e=str(reason)[:250],u=user,j=job_id)
            self._movement(tx,user,'payment' if success else 'release',0 if success else price,
                           'Оплата генерации' if success else 'Возврат резерва',job_id)
            return True
        return self.transaction(operation)

    def admin_pending_jobs(self):
        return self.query("SELECT user_id,job_id,status,created_at,price,kind,prompt,error FROM igk_jobs "
                          "WHERE status IN ('reserved','unknown') ORDER BY created_at DESC LIMIT 100")

    def create_order(self,user,kopeks):
        if kopeks not in (5000,10000,20000,50000): raise Conflict('Недопустимая сумма пополнения')
        order=uuid.uuid4().hex;t=now()
        def operation(tx):
            self.run(tx,'INSERT INTO igk_topups (order_id,user_id,created_at,amount,status,proof_key,bank_reference,receipt,confirmed_at) '
                 "VALUES ($id,$u,$t,$a,'pending','','','','')",id=order,u=user,t=t,a=kopeks)
        self.transaction(operation)
        return {'order_id':order,'amount':kopeks,'status':'pending','created_at':t}

    def user_orders(self,user):
        return self.query('SELECT order_id,amount,status,created_at,receipt FROM igk_topups '
                          'WHERE user_id=$u ORDER BY created_at DESC LIMIT 30',u=user)

    def admin_orders(self):
        return self.query('SELECT order_id,user_id,amount,status,created_at,proof_key,receipt FROM igk_topups '
                          'ORDER BY created_at DESC LIMIT 100')

    def order(self,user,order_id):
        rows=self.query('SELECT * FROM igk_topups WHERE order_id=$id',id=order_id)
        if not rows or rows[0]['user_id']!=user: raise Conflict('Заявка не найдена')
        return rows[0]

    def proof(self,user,order_id,key):
        def operation(tx):
            rows=self.run(tx,'SELECT user_id,status,proof_key FROM igk_topups WHERE order_id=$id',id=order_id)
            if not rows or rows[0]['user_id']!=user: raise Conflict('Заявка не найдена')
            if rows[0]['status'] not in ('pending','review'): raise Conflict('Заявку нельзя изменить')
            self.run(tx,"UPDATE igk_topups SET status='review',proof_key=$p WHERE order_id=$id",p=key,id=order_id)
        self.transaction(operation)

    @staticmethod
    def bank_reference(value):
        """Admin supplies unique *actual* VTB reference; no generic reused labels."""
        import re
        cleaned=' '.join(value.strip().split()).casefold()
        if not 8<=len(cleaned)<=140: raise Conflict('Укажите уникальные реквизиты операции ВТБ (не общую фразу)')
        if not re.search(r'\d',cleaned): raise Conflict('Укажите дату/время или номер из выписки ВТБ')
        return cleaned

    def approve(self,order_id,reference,receipt,amount):
        reference=self.bank_reference(reference)
        if not receipt or len(receipt)>300: raise Conflict('Укажите номер или ссылку чека НПД')
        def operation(tx):
            bank=self.run(tx,'SELECT order_id FROM igk_bank_refs WHERE reference=$r',r=reference)
            if bank:
                if bank[0]['order_id']==order_id:
                    current=self.run(tx,'SELECT status FROM igk_topups WHERE order_id=$id',id=order_id)
                    if current and current[0]['status']=='paid':return False
                raise Conflict('Банковская операция уже привязана к другой заявке')
            rows=self.run(tx,'SELECT user_id,amount,status FROM igk_topups WHERE order_id=$id',id=order_id)
            if not rows: raise Conflict('Заявка не найдена')
            order=rows[0]
            if order['status']!='review': raise Conflict('Подтверждение клиента не получено или заявка завершена')
            if int(order['amount'])!=int(amount): raise Conflict('Фактическая сумма ВТБ не совпадает с заявкой')
            wallet=self.run(tx,'SELECT available FROM igk_wallets WHERE user_id=$u',u=order['user_id'])
            if not wallet: raise Conflict('Кошелёк клиента не найден')
            self.run(tx,'INSERT INTO igk_bank_refs (reference,order_id,created_at) VALUES ($r,$id,$t)',r=reference,id=order_id,t=now())
            self.run(tx,'UPDATE igk_wallets SET available=$a WHERE user_id=$u',
                     a=int(wallet[0]['available'])+int(amount),u=order['user_id'])
            self.run(tx,"UPDATE igk_topups SET status='paid',bank_reference=$r,receipt=$c,confirmed_at=$t WHERE order_id=$id",
                     r=reference,c=receipt,t=now(),id=order_id)
            self._movement(tx,order['user_id'],'topup',int(amount),'Подтверждённое пополнение',order_id)
            return True
        return self.transaction(operation)
