"""Offline smoke tests. Never calls reAPI, YDB or payment services."""
from html.parser import HTMLParser
from pathlib import Path
import re, sys, types, importlib.util
root=Path(__file__).resolve().parent
class IDs(HTMLParser):
    def __init__(self): super().__init__(); self.ids=set()
    def handle_starttag(self,tag,attrs):
        for name,value in attrs:
            if name=='id': self.ids.add(value)
for page,script in [('index.html','app.js'),('payment.html','payment.js')]:
    markup=(root/'frontend'/page).read_text()
    js=(root/'frontend'/script).read_text()
    html=IDs();html.feed(markup)
    refs=set(re.findall(r"\$\('([a-zA-Z0-9_-]+)'\)",js))
    missing=refs-html.ids
    assert not missing, f'{page}: JS refers to absent HTML IDs {sorted(missing)}'
    assert 'MAX подключён' not in markup
    assert not re.search(r'\bкредита\b', markup, re.I)
    assert not re.search(r'\bкредита\b', js, re.I)
    print(f'{page}: {len(refs)} JS references valid')
html=(root/'frontend'/'index.html').read_text()
js=(root/'frontend'/'app.js').read_text()
assert '01 / ГЕНЕРАЦИЯ ИЗОБРАЖЕНИЯ' in html
assert '02 / НАСТРОЙКИ ГЕНЕРАЦИИ' not in html
assert html.index('id="prompt"') < html.index('id="reference-toggle"') < html.index('id="model"') < html.index('id="style"')
assert 'MAX подключён' not in html and 'Доступ подтверждён' in html
assert 'history-job-action' not in js
assert 'movement-amount' not in js and 'movement-head' not in js
assert 'Оплата из резерва' in js and 'Баланс — ' in js
assert 'payment' in js
assert "profile.admin !== true" in js
app=(root/'backend/app.py').read_text()
provider=(root/'backend/provider.py').read_text()
assert "selected='reapi'" in app
assert "model: Literal['grok','nano_banana_21','gpt_image_26']='grok'" in app
assert 'GENERATION_PRICE_KOPEKS = 750' in app
assert "'price':GENERATION_PRICE_KOPEKS" in app
assert "'gpt_image_26': GENERATION_PRICE_KOPEKS" in app
assert "'nano-banana-2.1'" in provider
assert "'gpt-image-2.6-flare'" in provider
assert "'image_urls'" in provider
assert 'file.deepytb.com' in provider
assert 'def reapi_model(' in provider
# Model request construction verified with offline mocked reAPI responses.
import io, os
sys.path.insert(0,str(root))
package=types.ModuleType('backend');package.__path__=[str(root/'backend')]
sys.modules['backend']=package
fakeimg=types.ModuleType('backend.images');fakeimg.image_type=lambda _: ('image/png','.png')
sys.modules['backend.images']=fakeimg
spec=importlib.util.spec_from_file_location('backend.provider',root/'backend/provider.py')
module=importlib.util.module_from_spec(spec);sys.modules[spec.name]=module;spec.loader.exec_module(module)
assert module.reapi_model('grok','text','1:1')=='grok-imagine-image-2-0'
assert module.reapi_model('grok','reference','1:1')=='grok-imagine-image-2.0-official'
assert module.reapi_model('nano_banana_21','text','4:5')=='nano-banana-2.1'
assert module.reapi_model('gpt_image_26','text','1:1')=='gpt-image-2.6-flare'
class Response:
    status_code=200;ok=True
    def json(self): return {'id':'task_test','status':'completed','output':{'image_urls':['https://cdn.reapi.ai/x.jpg']},'usage':{'credits':30}}
requests=[]
def post(url,headers,json,timeout): requests.append((url,json));return Response()
module.requests.post=post;module.requests.get=lambda *args,**kw: Response()
module.time.sleep=lambda *_:None
module._download_reapi_image=lambda url,task:b'\x89PNG\r\n\x1a\nmock'
os.environ['REAPI_API_KEY']='local-test-key-not-real'
for choice,mode,aspect,ref in [('grok','text','1:1',''),('grok','reference','4:5','https://s3.test/r.png'),('nano_banana_21','text','4:5',''),('nano_banana_21','reference','16:9','https://s3.test/r.png'),('gpt_image_26','text','4:5',''),('gpt_image_26','reference','16:9','https://s3.test/r.png')]:
    module._reapi('An image',mode,ref,aspect,choice)
    body=requests[-1][1]
    if choice=='nano_banana_21':
        assert 'n' not in body and body['model']=='nano-banana-2.1' and body['aspect_ratio']==aspect
        assert body['resolution']=='2k'
    if choice=='gpt_image_26':
        assert body['model']=='gpt-image-2.6-flare' and body['n']==1
        assert body['output_format']=='png' and body['quality']=='medium'
        assert body['size'] == module.GPT_IMAGE_26_SIZES[aspect]
    if mode=='reference':assert body['image_urls']==[ref]
    else:assert 'image_urls' not in body
print('provider requests: grok, nano, GPT Image 2.6; text and reference validated offline')
print('All offline checks passed.')

# v14: exact requested copy, payment administration removed from payment screen.
assert 'Опишите нейросети свою идею' in html
assert 'Приветственный бонус 3 кредитов' not in html
assert 'Файл будет загружен в закрытое хранилище.' not in html
assert 'Модели работают через reAPI. Стоимость в кредитах указана ниже.' not in html
assert 'ЦИФРОВАЯ СТУДИЯ ДИЗАЙНА · MAX' not in html
assert 'Стоимость одной генерации' not in html and 'Стоимость генерации' in html
assert '03 / АРХИВ' in html and '04 / БАЛАНС' in html
assert 'id="pay-admin"' not in (root/'frontend/payment.html').read_text()
assert 'loadAdminOrders' not in (root/'frontend/payment.js').read_text()
assert 'gpt_image_26' in html and 'gpt_image_26' in js
print('v14 copy, price, and payment page verified')
