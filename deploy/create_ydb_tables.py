"""Create only igk_* tables in chosen YDB. Never DROP anything."""
import os
import re
from pathlib import Path
import ydb

def main():
    if os.getenv('IGK_CREATE_TABLES')!='YES':
        raise SystemExit('Запуск заблокирован. Для создания таблиц установите IGK_CREATE_TABLES=YES.')
    d=ydb.Driver(endpoint=os.environ['YDB_ENDPOINT'],database=os.environ['YDB_DATABASE'],
                 credentials=ydb.credentials_from_env_variables())
    d.wait(timeout=15,fail_fast=True)
    try:
        pool=ydb.QuerySessionPool(d)
        sql=Path(__file__).with_name('ydb_schema.sql').read_text(encoding='utf-8')
        for statement in sql.split(';'):
            statement=statement.strip()
            if not statement:continue
            statement=re.sub(r'(?m)^--.*\n','',statement).strip()
            if not statement:continue
            statement=statement.replace('CREATE TABLE ','CREATE TABLE IF NOT EXISTS ',1)
            print('Создаём:',statement.split('(',1)[0].strip())
            pool.execute_with_retries(statement)
        print('Все таблицы созданы или уже существуют.')
    finally:d.stop()

if __name__=='__main__':main()
