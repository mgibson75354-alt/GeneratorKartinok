import base64
from types import SimpleNamespace
import pytest
from backend.config import flag,price
from backend.storage import Store,Conflict
from backend.provider import decode_result,ProviderError
from backend.app import Generate,composed_prompt
from backend.images import image_type

PNG=b'\x89PNG\r\n\x1a\n'+b'fakeimage'

def test_models_both_text_and_reference():
    a=Generate(request_id='abcdefgh',prompt='Красивое кафе на рассвете',confirm_rights=True)
    b=Generate(request_id='abcdefgh',prompt='Красивое кафе на рассвете',style='advertising',mode='reference',confirm_rights=True)
    assert 'Фотореалистичное' in composed_prompt(a)
    assert 'рекламная' in composed_prompt(b)

def test_prompt_min_length():
    with pytest.raises(Exception): Generate(request_id='abcdefgh',prompt='short')

def test_price_validation(monkeypatch):
    monkeypatch.setenv('IMAGE_PRICE_KOPEKS','-1')
    with pytest.raises(ValueError):price()
    monkeypatch.setenv('IMAGE_PRICE_KOPEKS','1000')
    assert price()==1000

def test_bank_reference_must_be_distinguishable():
    with pytest.raises(Conflict):Store.bank_reference('Перевод по номеру телефона')
    assert Store.bank_reference('Перевод по телефону 21.11.2026 12:45')=='перевод по телефону 21.11.2026 12:45'

def test_decode_result_and_limit():
    assert decode_result({'data':[{'b64_json':base64.b64encode(PNG).decode()}]})==PNG
    with pytest.raises(ProviderError):decode_result({'data':[{'url':'https://example.com'}]})

def test_binary_type_detection():
    assert image_type(PNG)[0]=='image/png'
    assert image_type(b'\xff\xd8\xffabc')[0]=='image/jpeg'
    with pytest.raises(ValueError):image_type(b'<script>')
