"""Server-only adapters for ProxyAPI and reAPI / Grok Imagine Image 2.0.

No fallback on ambiguous results: a second provider call could cause double billing.
"""
from __future__ import annotations
import base64
from dataclasses import dataclass, field
import os
import time
from urllib.parse import urlparse
import requests
from .images import image_type

PROXY_MODEL='x-ai/grok-imagine-image-2.0'
PROXY_ENDPOINT='https://api.proxyapi.ru/v1/images/'
REAPI_BASE='https://reapi.ai/api/v1'
REAPI_STANDARD='grok-imagine-image-2-0'
REAPI_OFFICIAL='grok-imagine-image-2.0-official'
REAPI_NANO_21='nano-banana-2.1'
STANDARD_RATIOS={'1:1','2:3','3:2','9:16','16:9'}

class ProviderError(RuntimeError):
    def __init__(self,message,definite=False,task_id=''):
        super().__init__(message);self.definite=definite;self.task_id=task_id

@dataclass
class GenerationResult:
    image: bytes
    provider: str
    model: str
    task_id: str = ''
    reported_usage: dict = field(default_factory=dict)
    elapsed_seconds: float = 0.0


def decode_result(body):
    try:
        encoded=body['data'][0]['b64_json']
        content=base64.b64decode(encoded,validate=True)
    except (KeyError,IndexError,TypeError,ValueError) as exc:
        raise ProviderError('Провайдер не вернул изображение в ожидаемом формате. Проверьте кабинет до повтора.') from exc
    return _checked_image(content)


def _checked_image(content):
    if not 0<len(content)<=15*1024*1024: raise ProviderError('Изображение превышает допустимый размер')
    try:image_type(content)
    except ValueError as exc:raise ProviderError('Провайдер вернул неизвестный формат изображения') from exc
    return content


def _body(response,task_id=''):
    try: return response.json()
    except ValueError as exc:raise ProviderError('Неверный JSON в ответе провайдера',task_id=task_id) from exc


def _proxy(prompt,mode,reference,aspect):
    key=os.getenv('PROXY_API_KEY','')
    if not key:raise ProviderError('PROXY_API_KEY не настроен',definite=True)
    headers={'Authorization':f'Bearer {key}'}
    start=time.monotonic()
    try:
        if mode=='reference':
            if not reference:raise ProviderError('Не загружен референс',definite=True)
            mime,ext=image_type(reference)
            resp=requests.post(PROXY_ENDPOINT+'edits',headers=headers,
                    data={'model':PROXY_MODEL,'prompt':prompt},
                    files={'image':('reference'+ext,reference,mime)},timeout=(10,150))
        else:
            resp=requests.post(PROXY_ENDPOINT+'generations',headers=headers,
                    json={'model':PROXY_MODEL,'prompt':prompt},timeout=(10,150))
    except requests.RequestException as exc:
        raise ProviderError('Ответ ProxyAPI неизвестен: проверьте кабинет перед повтором.') from exc
    if not resp.ok:
        raise ProviderError(f'ProxyAPI ответил HTTP {resp.status_code}',definite=resp.status_code in (400,401,403,404,422))
    data=_body(resp)
    raw=decode_result(data)
    usage=data.get('usage') if isinstance(data,dict) else None
    return GenerationResult(raw,'proxyapi',PROXY_MODEL,reported_usage=usage if isinstance(usage,dict) else {},elapsed_seconds=round(time.monotonic()-start,2))


def _task_payload(data):
    """Support both documented reAPI task envelopes: top-level and {data: {...}}."""
    if not isinstance(data,dict):return {}
    nested=data.get('data')
    if isinstance(nested,dict):return nested
    if isinstance(nested,list) and nested and isinstance(nested[0],dict):return nested[0]
    return data


def _task_id(data):
    value=_task_payload(data)
    return str(value.get('task_id') or value.get('id') or data.get('id') or '') if isinstance(data,dict) else ''


def _image_url(task):
    """Two response versions documented by reAPI."""
    data=_task_payload(task)
    result=data.get('result') if isinstance(data,dict) else None
    if isinstance(result,dict):
        items=result.get('images')
        if isinstance(items,list) and items:
            return items[0].get('url','') if isinstance(items[0],dict) else ''
    output=data.get('output') if isinstance(data,dict) else None
    if isinstance(output,dict):
        items=output.get('image_urls')
        if isinstance(items,list) and items:return items[0]
    return ''


def _download_reapi_image(url,task_id):
    parsed=urlparse(url)
    # Only allow confirmed image hosts, never arbitrary provider-supplied URLs (SSRF).
    # reAPI Grok Imagine may return image URLs hosted at file.deepytb.com.
    allowed_hosts = {'cdn.reapi.ai', 'file.deepytb.com'}
    if (parsed.scheme != 'https' or parsed.hostname not in allowed_hosts
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise ProviderError('Неизвестный адрес результата reAPI: требуется проверка',task_id=task_id)
    try:
        r=requests.get(url,timeout=(10,40),stream=True,allow_redirects=False)
        if r.status_code!=200:raise ProviderError(f'Результат reAPI HTTP {r.status_code}',task_id=task_id)
        b=bytearray()
        for part in r.iter_content(chunk_size=65536):
            b.extend(part)
            if len(b)>15*1024*1024:raise ProviderError('Результат больше 15 МБ',task_id=task_id)
        return _checked_image(bytes(b))
    except requests.RequestException as exc:
        raise ProviderError('Результат reAPI не получен: нужен контроль задания',task_id=task_id) from exc


def reapi_model(choice,mode,aspect):
    if choice == 'nano_banana_21':
        return REAPI_NANO_21
    if choice != 'grok':
        raise ValueError('Недопустимая модель reAPI')
    return REAPI_STANDARD if mode == 'text' and aspect in STANDARD_RATIOS else REAPI_OFFICIAL


def _reapi(prompt,mode,reference_url,aspect,model_choice='grok'):
    key=os.getenv('REAPI_API_KEY','')
    if not key:raise ProviderError('REAPI_API_KEY не настроен',definite=True)
    if mode=='reference' and not reference_url:raise ProviderError('Не загружен референс',definite=True)
    headers={'Authorization':f'Bearer {key}','Content-Type':'application/json'}
    model = reapi_model(model_choice,mode,aspect)
    if model_choice == 'nano_banana_21':
        # Nano Banana 2.1 accepts 4:5 and does not accept 'n'.
        body={'model':model,'prompt':prompt,'aspect_ratio':aspect,'resolution':'2k'}
        if mode=='reference':body['image_urls']=[reference_url]
    else:
        standard = model == REAPI_STANDARD
        body={'model':model,'prompt':prompt,'n':1}
        # Grok's standard/official channels do not accept 4:5; map to 3:4.
        requested_aspect='3:4' if aspect=='4:5' else aspect
        if standard:body['size']=requested_aspect
        else:
            body.update({'aspect_ratio':requested_aspect,'resolution':'1k','quality':'medium'})
            if mode=='reference':body['image_urls']=[reference_url]
    start=time.monotonic()
    try:r=requests.post(REAPI_BASE+'/images/generations',headers=headers,json=body,timeout=(10,35))
    except requests.RequestException as exc:raise ProviderError('Неизвестно, принял ли reAPI запрос: нужна сверка.') from exc
    if not r.ok:raise ProviderError(f'reAPI ответил HTTP {r.status_code}',definite=r.status_code in (400,401,403,404,422))
    submitted=_body(r);task_id=_task_id(submitted)
    if not task_id:raise ProviderError('reAPI не вернул идентификатор задачи. Требуется сверка.')
    max_wait=max(10,min(115,int(os.getenv('REAPI_MAX_POLL_SECONDS','95'))))
    deadline=time.monotonic()+max_wait
    while time.monotonic()<deadline:
        time.sleep(1.5)
        try:r=requests.get(REAPI_BASE+'/tasks/'+task_id,headers=headers,timeout=(10,20))
        except requests.RequestException as exc:raise ProviderError('Ошибка проверки задания reAPI',task_id=task_id) from exc
        if not r.ok:raise ProviderError(f'reAPI проверка HTTP {r.status_code}',task_id=task_id)
        task=_body(r,task_id);data=_task_payload(task)
        status=data.get('status','')
        if status in ('failed','cancelled','canceled'):
            raise ProviderError('Задача reAPI завершилась ошибкой; проверьте списание в кабинете',task_id=task_id)
        if status=='completed':
            url=_image_url(task)
            if not url:raise ProviderError('reAPI завершил задачу без изображения',task_id=task_id)
            raw=_download_reapi_image(url,task_id)
            usage=data.get('usage') or task.get('usage') or {}
            return GenerationResult(raw,'reapi',model,task_id=task_id,reported_usage=usage if isinstance(usage,dict) else {},elapsed_seconds=round(time.monotonic()-start,2))
    raise ProviderError('reAPI продолжает обработку: резерв сохранён. Требуется проверка',task_id=task_id)


def generate(prompt,mode='text',reference=None,*,selected='proxyapi',aspect='1:1',reference_url='',model_choice='grok'):
    if selected=='proxyapi':return _proxy(prompt,mode,reference,aspect)
    if selected=='reapi':return _reapi(prompt,mode,reference_url,aspect,model_choice)
    raise ProviderError('Неизвестный провайдер',definite=True)
