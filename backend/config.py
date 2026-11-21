"""Public-safe settings only. Secrets always loaded from runtime environment / Lockbox."""
import os

def flag(name, default="0"):
    return os.getenv(name, default).strip().lower() in ("1", "true", "yes", "on")


def price():
    value = int(os.getenv("IMAGE_PRICE_KOPEKS", "1000"))
    if not 1 <= value <= 500000:
        raise ValueError("IMAGE_PRICE_KOPEKS должен быть в пределах 1..500000")
    return value


def admin_ids():
    return {x.strip() for x in os.getenv("MAX_PAYMENT_ADMIN_IDS", "").split(",") if x.strip()}


def ready():
    required = ["MAX_BOT_TOKEN", "SESSION_SECRET", "YDB_ENDPOINT", "YDB_DATABASE", "IMAGE_BUCKET"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise RuntimeError("Отсутствуют серверные настройки: " + ", ".join(missing))
    if flag('GENERATION_ENABLED') and not os.getenv('PROXY_API_KEY') and not os.getenv('REAPI_API_KEY'):
        raise RuntimeError('Для генерации нужен PROXY_API_KEY или REAPI_API_KEY')
    provider = os.getenv('PROVIDER_DEFAULT','proxyapi').lower()
    if provider not in ('proxyapi','reapi'):
        raise RuntimeError('PROVIDER_DEFAULT: используйте proxyapi или reapi')
    if flag('GENERATION_ENABLED') and not flag('PROVIDER_SELECTOR_VISIBLE') and not os.getenv('PROXY_API_KEY' if provider=='proxyapi' else 'REAPI_API_KEY'):
        raise RuntimeError('Ключ выбранного провайдера не настроен')


def selected_provider(requested=''):
    default=os.getenv('PROVIDER_DEFAULT','proxyapi').strip().lower()
    if default not in ('proxyapi','reapi'):raise ValueError('Неверный PROVIDER_DEFAULT')
    if flag('PROVIDER_SELECTOR_VISIBLE'):
        value=requested or default
        if value not in ('proxyapi','reapi'):raise ValueError('Неизвестный провайдер')
        return value
    return default

def available_providers():
    return [name for name,key in [('proxyapi','PROXY_API_KEY'),('reapi','REAPI_API_KEY')] if os.getenv(key)]
