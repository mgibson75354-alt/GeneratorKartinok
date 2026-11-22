"""Admin-only top-up moderation, isolated from existing wallet/credit settlement.

Requires additive igk_topup_admin_meta table (migration.sql). This module never
credits wallets directly; that remains Store.approve, with bank-reference
idempotency and serializable transactions.
"""
from __future__ import annotations
from datetime import datetime
from urllib.parse import urlparse
from .storage import Conflict, now


class AdminTopups:
    def __init__(self, store):
        self.store = store

    @staticmethod
    def default(order_id):
        return dict(order_id=order_id, hidden=False, archived=False,
                    clarify_reason='', bank_without_id=False, bank_received_at='',
                    bank_description='', receipt_url='', receipt_number='', updated_at='')

    def metadata(self, order_id):
        rs = self.store.query('SELECT * FROM igk_topup_admin_meta WHERE order_id=$id', id=order_id)
        return (dict(self.default(order_id), **rs[0]) if rs else self.default(order_id))

    def _lookup(self, tx, order_id):
        rs = self.store.run(tx, 'SELECT order_id,user_id,status,amount FROM igk_topups WHERE order_id=$id', id=order_id)
        if not rs:
            raise Conflict('Заявка не найдена')
        return rs[0]

    def _read_meta(self, tx, order_id):
        rs = self.store.run(tx, 'SELECT * FROM igk_topup_admin_meta WHERE order_id=$id', id=order_id)
        return dict(self.default(order_id), **rs[0]) if rs else self.default(order_id)

    def _save_meta(self, tx, meta):
        self.store.run(tx,
            'UPSERT INTO igk_topup_admin_meta '
            '(order_id,hidden,archived,clarify_reason,bank_without_id,bank_received_at,bank_description,receipt_url,receipt_number,updated_at) '
            'VALUES ($id,$hidden,$archived,$reason,$noid,$when,$description,$url,$number,$time)',
            id=meta['order_id'], hidden=bool(meta['hidden']), archived=bool(meta['archived']),
            reason=meta['clarify_reason'], noid=bool(meta['bank_without_id']),
            when=meta['bank_received_at'], description=meta['bank_description'],
            url=meta['receipt_url'], number=meta['receipt_number'], time=now())

    @staticmethod
    def decorate(row, meta):
        data = dict(row)
        data.update({key: meta[key] for key in ('hidden','archived','clarify_reason','bank_without_id',
                                                 'bank_received_at','bank_description','receipt_url','receipt_number')})
        if data['status'] == 'review' and meta['clarify_reason']:
            data['status'] = 'clarify'
        return data

    def list(self, include_hidden=False):
        # Query only the last 100 applications, like the existing admin endpoint.
        orders = self.store.admin_orders()
        # Metadata table stores only administrative flags/receipt details.
        # Keep this a simple supported Query Service read; do not complicate
        # the finance-critical top-up queries with additional JOINs.
        metas = self.store.query('SELECT * FROM igk_topup_admin_meta')
        by_id = {m['order_id']: m for m in metas}
        out = []
        for row in orders:
            m = dict(self.default(row['order_id']), **by_id.get(row['order_id'], {}))
            if bool(m['hidden']) != bool(include_hidden):
                continue
            # 'archive' means an archived record leaves all normal admin lists,
            # but remains securely retained in the accounting tables.
            if m['archived']:
                continue
            out.append(self.decorate(row, m))
        return out

    def detail(self, order_id):
        rs = self.store.query('SELECT * FROM igk_topups WHERE order_id=$id', id=order_id)
        if not rs: raise Conflict('Заявка не найдена')
        return self.decorate(rs[0], self.metadata(order_id))

    def set_flag(self, order_id, action):
        if action not in ('hide', 'restore', 'archive', 'cancel'):
            raise Conflict('Недопустимое действие')
        def operation(tx):
            order = self._lookup(tx, order_id)
            meta = self._read_meta(tx, order_id)
            if action == 'cancel':
                if order['status'] != 'pending':
                    raise Conflict('Отменить можно только неоплаченную заявку')
                self.store.run(tx, "UPDATE igk_topups SET status='cancelled' WHERE order_id=$id", id=order_id)
            elif action == 'hide':
                meta['hidden'] = True
            elif action == 'restore':
                if meta['archived']: raise Conflict('Архивированная заявка не восстанавливается через интерфейс')
                meta['hidden'] = False
            elif action == 'archive':
                if not meta['hidden']: raise Conflict('Архивировать можно только скрытую заявку')
                meta['archived'] = True
                meta['hidden'] = True
            self._save_meta(tx, meta)
            return True
        return self.store.transaction(operation)

    def clarify(self, order_id, reason):
        reason = reason.strip()
        if not 3 <= len(reason) <= 300:
            raise Conflict('Укажите причину уточнения (3–300 символов)')
        def operation(tx):
            order = self._lookup(tx, order_id)
            if order['status'] != 'review':
                raise Conflict('Уточнение доступно только для заявки на проверке')
            meta = self._read_meta(tx, order_id)
            meta['clarify_reason'] = reason
            self._save_meta(tx, meta)
            return True
        return self.store.transaction(operation)

    def clear_clarification(self, order_id):
        def operation(tx):
            meta = self._read_meta(tx, order_id)
            if meta['clarify_reason']:
                meta['clarify_reason'] = ''
                self._save_meta(tx, meta)
        self.store.transaction(operation)

    @staticmethod
    def reference_for_payment(reference, without_id, received_at, amount):
        value = ' '.join(reference.strip().split())
        if without_id:
            # Unique across all users; two same-second same-amount bank receipts
            # are intentionally blocked until an operator can disambiguate.
            try:
                stamp = datetime.fromisoformat(received_at)
                if stamp.tzinfo is not None: raise ValueError('offset')
                stamp = stamp.isoformat(timespec='seconds')
            except (TypeError, ValueError):
                raise Conflict('Укажите дату и время поступления по выписке ВТБ (МСК)')
            if not 6 <= len(value) <= 85:
                raise Conflict('Укажите описание банковского перевода')
            # Do not include editable bank description in the uniqueness key:
            # different descriptions of the same real transfer must collide.
            return f'Без номера по СБП | {stamp} | {amount}'
        if 'перевод по номеру телефона' in value.casefold():
            raise Conflict('Для перевода без номера установите соответствующую галочку')
        return value

    @staticmethod
    def check_receipt(url, number, legacy):
        url = (url or '').strip()
        number = (number or '').strip()
        legacy = (legacy or '').strip()
        if url:
            parsed = urlparse(url)
            if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password
                    or any(c.isspace() for c in url) or len(url) > 1500):
                raise Conflict('Ссылка на чек НПД должна быть действительным адресом HTTPS')
        if not (url or number or legacy): raise Conflict('Введите номер или ссылку чека НПД')
        if len(number)>100: raise Conflict('Номер чека НПД слишком длинный')
        if len(legacy)>300: raise Conflict('Поле чека НПД слишком длинное')
        # The existing Store stores only 300 characters in receipt: use a short
        # human-readable number if the full URL cannot fit. The original full
        # HTTPS receipt URL is retained separately in admin metadata.
        return (url if len(url)<=300 else (number or 'Ссылка на чек НПД в метаданных заявки')) if url else (number or legacy)

    def approve(self, order_id, reference, amount, receipt, without_id=False,
                received_at='', receipt_url='', receipt_number=''):
        meta = self.metadata(order_id)
        if meta['clarify_reason']: raise Conflict('Запрошено уточнение; дождитесь нового подтверждения')
        order = self.detail(order_id)
        if order['status'] != 'review':
            raise Conflict('Заявка не находится на банковской проверке')
        if int(order['amount']) != int(amount): raise Conflict('Сумма поступления не соответствует заявке')
        actual_ref = self.reference_for_payment(reference, without_id, received_at, amount)
        text = self.check_receipt(receipt_url, receipt_number, receipt)
        # CRITICAL: financial idempotency and credit remain exclusively in
        # existing Store.approve() serializable transaction.
        changed = self.store.approve(order_id, actual_ref, text, amount)
        def save_metadata(tx):
            m = self._read_meta(tx, order_id)
            m['bank_without_id'] = bool(without_id)
            m['bank_received_at'] = received_at if without_id else ''
            m['bank_description'] = reference.strip()
            m['receipt_url'] = receipt_url.strip()
            m['receipt_number'] = receipt_number.strip()
            self._save_meta(tx, m)
        self.store.transaction(save_metadata)
        return changed

    def enrich_user_orders(self, orders):
        # Only paid orders may publish an NPD receipt link to the paying client.
        for order in orders:
            if order.get('status') == 'paid':
                m = self.metadata(order['order_id'])
                if m['receipt_url']:
                    order['receipt'] = m['receipt_url']
            elif order.get('status') == 'review':
                m = self.metadata(order['order_id'])
                if m['clarify_reason']:
                    order['status'] = 'clarify'
                    order['clarify_reason'] = m['clarify_reason']
        return orders
