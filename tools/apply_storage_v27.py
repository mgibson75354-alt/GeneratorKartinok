#!/usr/bin/env python3
"""IGK v27: apply minimal change to user's CURRENT backend/storage.py.
Makes a dated backup and refuses to change unexpected source. No YDB queries made.
Run in repo root: python tools/apply_storage_v27.py
"""
from pathlib import Path
import shutil,sys,datetime
path=Path('backend/storage.py')
if not path.is_file():sys.exit('ERROR: Run from repo root; backend/storage.py not found.')
s=path.read_text(encoding='utf-8')
if "'UPDATE igk_topups SET status='paid',amount=$actual" in s:
    print('Already patched (v27).');sys.exit(0)
start=s.find('    def approve(self,order_id,reference,receipt,amount):')
if start<0:sys.exit('STOP: Store.approve signature is different; no changes made. Send actual backend/storage.py for review.')
end=s.find('\n    def ',start+8)
if end<0:end=len(s)
old=s[start:end]
need=["if int(order['amount'])!=int(amount):", "UPDATE igk_topups SET status='paid'", "self._movement(tx,order['user_id'],'topup',int(amount)", "self.transaction(operation)", "igk_bank_refs", "if order['status']!='review'", "wallet"]
if not all(x in old for x in need):sys.exit('STOP: Store.approve layout differs from tested version; no changes made. Send backend/storage.py for review.')
new=old.replace("        reference=self.bank_reference(reference)","        amount=int(amount)\n        if amount <= 0: raise Conflict('Фактическая сумма поступления должна быть положительной')\n        reference=self.bank_reference(reference)",1)
new=new.replace("            if int(order['amount'])!=int(amount): raise Conflict('Фактическая сумма ВТБ не совпадает с заявкой')", "            original_amount=int(order['amount'])",1)
if new==old or 'original_amount=int(order' not in new:sys.exit('STOP: failed to match amount guard; no changes made.')
new=new.replace('UPDATE igk_topups SET status=\'paid\',bank_reference=$r,receipt=$c,confirmed_at=$t WHERE order_id=$id', "UPDATE igk_topups SET status='paid',amount=$actual,bank_reference=$r,receipt=$c,confirmed_at=$t WHERE order_id=$id",1)
new=new.replace('r=reference,c=receipt,t=now(),id=order_id)', 'actual=amount,r=reference,c=receipt,t=now(),id=order_id)',1)
new=new.replace("self._movement(tx,order['user_id'],'topup',int(amount),'Подтверждённое пополнение',order_id)", "self._movement(tx,order['user_id'],'topup',amount,\n                'Подтверждённое пополнение' if original_amount==amount else\n                f'Подтверждённое пополнение; исходная заявка {original_amount/100:.2f} ₽; поступило {amount/100:.2f} ₽',\n                order_id)",1)
if 'amount=$actual' not in new or 'actual=amount' not in new or 'исходная заявка' not in new:sys.exit('STOP: patch validation failed; no changes made.')
backup=path.with_name('storage.py.before_v27_'+datetime.datetime.now().strftime('%Y%m%d_%H%M%S'))
shutil.copy2(path,backup)
path.write_text(s[:start]+new+s[end:],encoding='utf-8')
print('Patched:',path,'Backup:',backup)
