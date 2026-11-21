import base64
from types import SimpleNamespace
from unittest.mock import patch
import pytest
from backend import provider,config
from backend.app import Generate

PNG=b'\x89PNG\r\n\x1a\n'+b'x'*80

class Response:
    def __init__(self, data, code=200):self.data=data;self.status_code=code;self.ok=code==200
    def json(self):return self.data

def test_selector_hidden_overrides_client_value(monkeypatch):
    monkeypatch.setenv('PROVIDER_DEFAULT','reapi');monkeypatch.setenv('PROVIDER_SELECTOR_VISIBLE','0')
    assert config.selected_provider('proxyapi')=='reapi'
    monkeypatch.setenv('PROVIDER_SELECTOR_VISIBLE','1')
    assert config.selected_provider('proxyapi')=='proxyapi'

def test_reapi_standard_text_api(monkeypatch):
    monkeypatch.setenv('REAPI_API_KEY','test-secret')
    seen={}
    def post(url,**kw):seen.update(kw['json']);return Response({'data':[{'task_id':'task_1','status':'submitted'}]})
    def get(url,**kw):
        if '/tasks/' in url:return Response({'data':{'status':'completed','result':{'images':[{'url':'https://cdn.reapi.ai/test.png'}]},'usage':{'credits':18}}})
        return None
    monkeypatch.setattr(provider.requests,'post',post)
    monkeypatch.setattr(provider.requests,'get',get)
    monkeypatch.setattr(provider.time,'sleep',lambda x:None)
    monkeypatch.setattr(provider,'_download_reapi_image',lambda url,task_id:PNG)
    result=provider.generate('draw a city',selected='reapi',aspect='1:1')
    assert seen['model']==provider.REAPI_STANDARD
    assert seen['size']=='1:1'
    assert result.reported_usage['credits']==18
    assert result.image==PNG

def test_reapi_reference_official_and_45_mapping(monkeypatch):
    monkeypatch.setenv('REAPI_API_KEY','test-secret');seen={}
    def post(url,**kw):seen.update(kw['json']);return Response({'id':'task_2','status':'processing'})
    def get(url,**kw):return Response({'status':'completed','output':{'image_urls':['https://cdn.reapi.ai/test.png']}})
    monkeypatch.setattr(provider.requests,'post',post)
    monkeypatch.setattr(provider.requests,'get',get)
    monkeypatch.setattr(provider.time,'sleep',lambda x:None)
    monkeypatch.setattr(provider,'_download_reapi_image',lambda url,task_id:PNG)
    result=provider.generate('edit this',mode='reference',reference_url='https://storage.yandexcloud.net/a?sig=x',selected='reapi',aspect='4:5')
    assert seen['model']==provider.REAPI_OFFICIAL
    assert seen['aspect_ratio']=='3:4'
    assert 'image_urls' in seen and len(seen['image_urls'])==1
    assert 'size' not in seen
    assert result.task_id=='task_2'

def test_invalid_download_domain():
    with pytest.raises(provider.ProviderError):provider._download_reapi_image('http://localhost/secret','t')
    with pytest.raises(provider.ProviderError):provider._download_reapi_image('https://evil.com/a','t')

def test_proxy_original_payload_without_unconfirmed_size(monkeypatch):
    monkeypatch.setenv('PROXY_API_KEY','test-secret');seen={}
    def post(url,**kw):seen.update(kw['json']);return Response({'data':[{'b64_json':base64.b64encode(PNG).decode()}],'usage':{'total_tokens':150}})
    monkeypatch.setattr(provider.requests,'post',post)
    r=provider.generate('test',selected='proxyapi',aspect='4:5')
    assert 'size' not in seen
    assert r.image==PNG and r.reported_usage['total_tokens']==150

def test_reapi_timeout_keeps_unknown(monkeypatch):
    monkeypatch.setenv('REAPI_API_KEY','test-secret')
    monkeypatch.setattr(provider.requests,'post',lambda url,**kw:Response({'id':'task_pending'}))
    monkeypatch.setattr(provider.requests,'get',lambda url,**kw:Response({'status':'processing'}))
    monkeypatch.setattr(provider.time,'sleep',lambda sec:None)
    calls=[0]
    def mono():calls[0]+=1;return calls[0]*100
    monkeypatch.setattr(provider.time,'monotonic',mono)
    with pytest.raises(provider.ProviderError) as exc:
        provider.generate('test',selected='reapi')
    assert exc.value.task_id=='task_pending' and not exc.value.definite
