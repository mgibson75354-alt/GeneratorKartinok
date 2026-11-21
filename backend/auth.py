"""MAX signed initData and stateless short-lived first-party tokens."""
import base64, hashlib, hmac, json, os, time
from urllib.parse import parse_qsl
import requests

class AuthError(Exception): pass

def validate_max_init_data(raw: str, bot_token: str, now=None):
    if not raw or not bot_token or len(raw)>20000: raise AuthError('Авторизация MAX недоступна')
    pairs=parse_qsl(raw,keep_blank_values=True,strict_parsing=True)
    params=dict(pairs)
    if len(pairs)!=len(params) or not params.get('hash'): raise AuthError('Ошибка подписи MAX')
    try:
        issued=int(params['auth_date'])
        now=int(now if now is not None else time.time())
        if issued>now+60 or now-issued>3600: raise AuthError('Срок авторизации истёк')
        user=json.loads(params['user'])
        user_id=int(user['id'])
        if user_id<=0: raise ValueError()
    except (KeyError, ValueError, TypeError, json.JSONDecodeError) as exc:
        raise AuthError('Неверные данные MAX') from exc
    signed='\n'.join(f'{k}={v}' for k,v in sorted(params.items()) if k!='hash')
    secret=hmac.new(b'WebAppData',bot_token.encode(),hashlib.sha256).digest()
    digest=hmac.new(secret,signed.encode(),hashlib.sha256).hexdigest()
    if not hmac.compare_digest(digest,params['hash']): raise AuthError('Ошибка подписи MAX')
    return {'user_id':str(user_id),'name':str(user.get('first_name',''))[:80]}

def is_subscriber(user_id, bot_token, chat_id):
    """Verify MAX channel membership. Report a SAFE failure class, never tokens or response bodies."""
    if not chat_id:
        raise AuthError('Канал MAX не настроен (CHANNEL_ID_MISSING)')
    try:
        channel_id = int(chat_id)
        member_id = int(user_id)
    except (ValueError, TypeError) as exc:
        raise AuthError('Некорректный ID канала или пользователя (INVALID_ID)') from exc
    try:
        r = requests.get(
            f'https://platform-api2.max.ru/chats/{channel_id}/members',
            params={'user_ids': str(member_id)},
            headers={'Authorization': bot_token},
            timeout=(5, 12),
            allow_redirects=False,
            verify=os.getenv('MAX_CA_BUNDLE') or True,
        )
        if r.status_code != 200:
            # Never return the upstream response or request URL; both may contain personal data.
            raise AuthError(f'Не удалось проверить подписку (MAX_HTTP_{r.status_code})')
        data = r.json()
        if not isinstance(data, dict) or not isinstance(data.get('members'), list):
            raise AuthError('Неожиданный ответ MAX (MAX_RESPONSE_FORMAT)')
    except requests.exceptions.SSLError as exc:
        raise AuthError('Сертификат MAX не прошёл проверку (MAX_SSL)') from exc
    except requests.exceptions.ConnectTimeout as exc:
        raise AuthError('Тайм-аут подключения к MAX (MAX_CONNECT_TIMEOUT)') from exc
    except requests.exceptions.ReadTimeout as exc:
        raise AuthError('Тайм-аут ответа MAX (MAX_READ_TIMEOUT)') from exc
    except requests.exceptions.ConnectionError as exc:
        raise AuthError('Соединение с MAX недоступно (MAX_CONNECTION)') from exc
    except requests.exceptions.RequestException as exc:
        raise AuthError('Ошибка соединения с MAX (MAX_REQUEST_ERROR)') from exc
    except (ValueError, TypeError) as exc:
        raise AuthError('Неверный JSON MAX (MAX_INVALID_JSON)') from exc
    return any(
        str(m.get('user_id') or m.get('id')) == str(member_id)
        for m in data['members'] if isinstance(m, dict)
    )

def _b64(raw): return base64.urlsafe_b64encode(raw).decode().rstrip('=')
def mint(user_id):
    secret=os.environ['SESSION_SECRET'].encode()
    payload={'sub':str(user_id),'exp':int(time.time())+1800}
    body=_b64(json.dumps(payload,separators=(',',':')).encode())
    tag=_b64(hmac.new(secret,body.encode(),hashlib.sha256).digest())
    return body+'.'+tag

def verify(token):
    try:
        body,tag=token.split('.',1)
        correct=_b64(hmac.new(os.environ['SESSION_SECRET'].encode(),body.encode(),hashlib.sha256).digest())
        if not hmac.compare_digest(correct,tag): raise ValueError()
        data=json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4)))
        if int(data['exp'])<time.time(): raise ValueError()
        return str(int(data['sub']))
    except (ValueError,KeyError,TypeError,UnicodeError,json.JSONDecodeError) as exc:
        raise AuthError('Необходимо снова войти через MAX') from exc
