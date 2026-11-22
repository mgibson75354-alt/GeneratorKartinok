"""MAX Image Generator. Private YDB financial ledger, S3 media, ProxyAPI images."""
from __future__ import annotations
import os
import json
import uuid
from functools import lru_cache
from io import BytesIO
from typing import Literal
from fastapi import FastAPI, Depends, Header, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from . import auth, config, provider
from .storage import Store,Conflict
from .images import Images,image_type

app=FastAPI(title='ИИ-ГенераторКартинок API',docs_url=None,redoc_url=None)
origin=os.getenv('FRONTEND_ORIGIN','').rstrip('/')
app.add_middleware(CORSMiddleware,allow_origins=[origin] if origin else [],
                   allow_methods=['GET','POST','OPTIONS'],allow_headers=['Content-Type','X-App-Authorization'],
                   allow_credentials=False,max_age=600)

@lru_cache(maxsize=1)
def db():return Store()
@lru_cache(maxsize=1)
def images():return Images()


def user(x_app_authorization: str | None=Header(None,alias='X-App-Authorization')):
    if not x_app_authorization or not x_app_authorization.startswith('Bearer '):
        raise HTTPException(401,'Необходим вход через MAX')
    try:return auth.verify(x_app_authorization[7:])
    except auth.AuthError as exc: raise HTTPException(401,str(exc)) from exc


def admin(uid: str=Depends(user)):
    if uid not in config.admin_ids():raise HTTPException(403,'Только администратор')
    return uid

class SignIn(BaseModel):
    init_data: str = Field(min_length=20,max_length=20000)

class Generate(BaseModel):
    request_id: str=Field(min_length=8,max_length=120)
    provider: Literal['reapi','proxyapi']='proxyapi'
    prompt: str=Field(min_length=10,max_length=1800)
    style: Literal['realistic','advertising','illustration','cinematic','art']='realistic'
    aspect: Literal['1:1','4:5','3:2','2:3','16:9','9:16']='4:5'
    mode: Literal['text','reference']='text'
    reference_key: str=''
    confirm_rights: bool=False

class NewOrder(BaseModel):
    amount: int

class Approve(BaseModel):
    bank_reference: str=Field(min_length=8,max_length=140)
    amount: int
    receipt: str=Field(min_length=1,max_length=300)

class Resolve(BaseModel):
    success: bool
    output_key: str=''
    note: str=''

@app.get('/api/health')
def health():return {'status':'ok','project':'image-generator','database':'ydb'}

@app.post('/api/auth')
def signin(payload:SignIn):
    try:
        identity=auth.validate_max_init_data(payload.init_data,os.environ['MAX_BOT_TOKEN'])
        uid=identity['user_id']
        if config.flag('REQUIRE_CHANNEL_SUBSCRIPTION','1'):
            if not auth.is_subscriber(uid,os.environ['MAX_BOT_TOKEN'],os.getenv('MAX_CHANNEL_ID')):
                raise HTTPException(403,'Подпишитесь на канал MAX для доступа')
        try:
            db().register(
                uid,
                3000 if config.flag('WELCOME_BONUS_ENABLED', '1') else 0
            )
        except Exception as exc:
            import logging
            logging.getLogger(__name__).exception(
                "YDB registration failed"
            )
            raise HTTPException(
                status_code=503,
                detail="YDB_REGISTER_FAILED"
            ) from exc

        try:
            token = auth.mint(uid)
        except Exception as exc:
            import logging
            logging.getLogger(__name__).exception(
                "Session creation failed"
            )
            raise HTTPException(
                status_code=503,
                detail="SESSION_CREATE_FAILED"
            ) from exc

        return {
            'token': token,
            'user_id': uid,
            'admin': uid in config.admin_ids()
        }

    except auth.AuthError as exc:raise HTTPException(401,str(exc)) from exc

@app.get('/api/profile')
def profile(uid:str=Depends(user)):
    wallet=db().wallet(uid)
    return {'wallet':wallet,'price':config.price(),'credits_per_ruble':0.1,
            'generation_enabled':config.flag('GENERATION_ENABLED'),
            'payments_enabled':config.flag('PAYMENTS_ENABLED'),
            'admin':uid in config.admin_ids(),
            'payment_qr_url':os.getenv('PAYMENT_QR_URL',''),
            'payment_sbp_link':os.getenv('PAYMENT_SBP_LINK',''),
            'provider_selector_visible':config.flag('PROVIDER_SELECTOR_VISIBLE'),
            'provider_default':config.selected_provider(),
            'available_providers':config.available_providers()}

@app.get('/api/history')
def history(uid:str=Depends(user)):
    result=db().history(uid)
    for job in result['jobs']:
        job['image_url']=images().url(job['output_key']) if job.get('output_key') and job.get('status')=='completed' else None
    return result

@app.post('/api/reference')
def reference(file:UploadFile=File(...),uid:str=Depends(user)):
    if not config.flag('GENERATION_ENABLED'):raise HTTPException(503,'Генерация пока закрыта')
    raw=file.file.read(8*1024*1024+1)
    try:
        ctype,ext=image_type(raw)
        if len(raw)>8*1024*1024:raise ValueError('Референс более 8 МБ')
        key=images().key(uid,'reference',uuid.uuid4().hex,ext)
        images().put_image(key,raw)
    except ValueError as exc:raise HTTPException(400,str(exc)) from exc
    return {'reference_key':key,'preview_url':images().url(key)}


def composed_prompt(p):
    styles={'realistic':'Фотореалистичное изображение, естественные фактуры.',
            'advertising':'Премиальная предметная рекламная фотография, коммерческая композиция.',
            'illustration':'Профессиональная художественная иллюстрация.',
            'cinematic':'Кинематографичный свет, выразительная композиция.',
            'art':'Авторская художественная стилистика.'}
    return p.prompt.strip()+'\n'+styles[p.style]+f'\nСоотношение сторон композиции: {p.aspect}.'

@app.post('/api/generate')
def generate(p:Generate,uid:str=Depends(user)):
    if not config.flag('GENERATION_ENABLED'):raise HTTPException(503,'Генерация пока выключена')
    if not p.confirm_rights:raise HTTPException(400,'Подтвердите права на материалы')
    try:selected=config.selected_provider(p.provider)
    except ValueError as exc:raise HTTPException(400,str(exc)) from exc
    if selected not in config.available_providers():raise HTTPException(503,'Ключ выбранного провайдера пока не настроен')
    reference_key=''
    if p.mode=='reference':
        prefix=images().key(uid,'reference','','')
        if not p.reference_key.startswith(prefix):raise HTTPException(400,'Референс не принадлежит пользователю')
        reference_key=p.reference_key
    prompt=composed_prompt(p)
    try:
        job,created=db().reserve(uid,p.request_id,p.mode,prompt,p.aspect,config.price(),reference_key)
    except Conflict as exc:raise HTTPException(409,str(exc)) from exc
    if not created:
        return {'job_id':job['job_id'],'status':job['status'],'reused':True,
                'image_url':images().url(job['output_key']) if job.get('output_key') else None}
    jid=job['job_id']
    try:
        # Persist provider choice BEFORE contacting it, to support manual reconciliation.
        db().audit_provider(uid,jid,selected,'reserved')
    except Exception:
        db().settle(uid,jid,False,reason='Не удалось сохранить выбор провайдера до генерации')
        raise HTTPException(503,'Ошибка сохранения задания провайдера. Резерв возвращён.')
    try:
        source=images().get(reference_key) if reference_key else None
        url=images().url(reference_key) if reference_key and selected=='reapi' else ''
        result=provider.generate(prompt,p.mode,source,selected=selected,aspect=p.aspect,reference_url=url)
        raw=result.image
        ctype,ext=image_type(raw)
        output=images().key(uid,'results',jid,ext)
        images().put_image(output,raw)
        db().settle(uid,jid,True,output)
        try:db().audit_provider(uid,jid,selected,'completed',result.task_id,result.model,result.reported_usage,result.elapsed_seconds)
        except Exception:pass  # settlement already committed; do not mark completed job as failed
        return {'job_id':jid,'status':'completed','reused':False,'image_url':images().url(output),'provider':selected}
    except provider.ProviderError as exc:
        try:db().audit_provider(uid,jid,selected,'failed' if exc.definite else 'unknown',exc.task_id,note=str(exc))
        except Exception:pass
        if exc.definite:
            db().settle(uid,jid,False,reason=str(exc))
        else:
            db().mark_unknown(uid,jid,(str(exc)+' '+exc.task_id).strip())
        raise HTTPException(502,str(exc)) from exc
    except Exception:
        try:db().audit_provider(uid,jid,selected,'unknown',note='Ошибка выполнения или хранения результата')
        except Exception:pass
        db().mark_unknown(uid,jid,'Ошибка выполнения или хранения результата. Нужна проверка администратора.')
        raise HTTPException(502,'Результат требует проверки. Не отправляйте задание повторно.')

@app.get('/api/admin/provider-usage')
def admin_provider_usage(uid:str=Depends(admin)):
    """Audit records. Actual billed cost must be verified in providers' dashboards."""
    return {'items':db().provider_usage(), 'note':'reAPI usage may include USD credits; ProxyAPI billing is confirmed in its dashboard.'}

@app.post('/api/payments/orders')
def create_order(p:NewOrder,uid:str=Depends(user)):
    if not config.flag('PAYMENTS_ENABLED'):raise HTTPException(503,'Пополнения пока отключены')
    try:return db().create_order(uid,p.amount)
    except Conflict as exc:raise HTTPException(400,str(exc)) from exc

@app.get('/api/payments/orders')
def orders(uid:str=Depends(user)):
    return {'orders':db().user_orders(uid)}

@app.post('/api/payments/orders/{order_id}/proof')
def proof(order_id:str,file:UploadFile=File(...),uid:str=Depends(user)):
    try:
        db().order(uid,order_id)
        raw=file.file.read(8*1024*1024+1)
        if raw.startswith(b'%PDF-'):ext='.pdf'
        else:_,ext=image_type(raw)
        key=images().key(uid,'proofs',order_id+'-'+uuid.uuid4().hex,ext)
        images().put_proof(key,raw)
        db().proof(uid,order_id,key)
        return {'status':'review'}
    except (Conflict,ValueError) as exc:raise HTTPException(400,str(exc)) from exc

@app.get('/api/admin/orders')
def admin_orders(uid:str=Depends(admin)):
    result=db().admin_orders()
    for order in result:
        order['proof_url']=images().url(order['proof_key']) if order.get('proof_key') else ''
    return {'orders':result}

@app.post('/api/admin/orders/{order_id}/approve')
def admin_approve(order_id:str,p:Approve,uid:str=Depends(admin)):
    if not config.flag('PAYMENTS_ENABLED'):raise HTTPException(503,'Пополнения отключены')
    try:
        changed=db().approve(order_id,p.bank_reference,p.receipt,p.amount)
        return {'status':'paid','credited':changed}
    except Conflict as exc:raise HTTPException(409,str(exc)) from exc

@app.get('/api/admin/jobs')
def pending_jobs(uid:str=Depends(admin)):
    return {'jobs':db().admin_pending_jobs()}

@app.post('/api/admin/jobs/{user_id}/{job_id}/resolve')
def resolve_job(user_id:str,job_id:str,p:Resolve,uid:str=Depends(admin)):
    try:
        if p.success:
            expected=images().key(user_id,'results',job_id,'')
            if not p.output_key.startswith(expected) or not p.output_key.endswith(('.png','.jpg','.webp')):
                raise Conflict('Результат не соответствует заданию и пользователю')
            images().client.head_object(Bucket=images().bucket,Key=p.output_key)
        # Manual release only after bank/provider reconciliation.
        changed=db().settle(user_id,job_id,p.success,p.output_key,reason=p.note)
        return {'changed':changed}
    except Conflict as exc:raise HTTPException(409,str(exc)) from exc