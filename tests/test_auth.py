import hashlib,hmac,json
from urllib.parse import urlencode
import pytest
from backend.auth import validate_max_init_data, AuthError, mint, verify


def signed_raw(bot_token):
    values={'auth_date':'1774100000','user':json.dumps({'id':1234567,'first_name':'Test'},separators=(',',':'))}
    message='\n'.join(k+'='+v for k,v in sorted(values.items()))
    secret=hmac.new(b'WebAppData',bot_token.encode(),hashlib.sha256).digest()
    values['hash']=hmac.new(secret,message.encode(),hashlib.sha256).hexdigest()
    return urlencode(values)


def test_max_signature_and_tampering():
    token='test-only-bot-token'
    raw=signed_raw(token)
    assert validate_max_init_data(raw,token,now=1774100010)['user_id']=='1234567'
    with pytest.raises(AuthError):
        validate_max_init_data(raw.replace('1234567','1234568'),token,now=1774100010)


def test_session_mint_and_verify(monkeypatch):
    monkeypatch.setenv('SESSION_SECRET','test-long-'+('secret'*12))
    signed=mint('1234567')
    assert verify(signed)=='1234567'
    with pytest.raises(AuthError):verify(signed[:-1]+('x' if signed[-1]!='x' else 'y'))
