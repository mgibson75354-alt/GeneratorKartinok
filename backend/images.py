"""Private Yandex Object Storage image and receipt persistence."""
import io
import os
from urllib.parse import urlsplit
import boto3
from botocore.config import Config


def image_type(raw):
    if raw.startswith(b'\x89PNG\r\n\x1a\n'): return 'image/png', '.png'
    if raw.startswith(b'\xff\xd8\xff'): return 'image/jpeg', '.jpg'
    if raw.startswith(b'RIFF') and raw[8:12]==b'WEBP': return 'image/webp', '.webp'
    raise ValueError('Поддерживаются только JPG, PNG, WEBP')


class Images:
    def __init__(self):
        endpoint=os.getenv('S3_ENDPOINT','https://storage.yandexcloud.net')
        args={'endpoint_url':endpoint,'region_name':'ru-central1',
              'config':Config(signature_version='s3v4')}
        key=os.getenv('AWS_ACCESS_KEY_ID'); secret=os.getenv('AWS_SECRET_ACCESS_KEY')
        if key and secret: args.update(aws_access_key_id=key,aws_secret_access_key=secret)
        self.client=boto3.client('s3',**args)
        self.bucket=os.environ['IMAGE_BUCKET']
        self.prefix=os.getenv('IMAGE_PREFIX','generator/v1').strip('/')

    def key(self, user,category,ident,extension):
        return f'{self.prefix}/{category}/{user}/{ident}{extension}'

    def put_image(self,key,raw):
        ctype,_=image_type(raw)
        if not 0<len(raw)<=15*1024*1024: raise ValueError('Изображение превышает 15 МБ')
        self.client.put_object(Bucket=self.bucket,Key=key,Body=raw,ContentType=ctype,
                               CacheControl='private, no-store')

    def put_proof(self,key,raw):
        if not 0<len(raw)<=8*1024*1024:raise ValueError('Файл подтверждения превышает 8 МБ')
        if raw.startswith(b'%PDF-'):ctype='application/pdf'
        else:ctype,_=image_type(raw)
        self.client.put_object(Bucket=self.bucket,Key=key,Body=raw,ContentType=ctype,
                               CacheControl='private, no-store')

    def get(self,key):
        return self.client.get_object(Bucket=self.bucket,Key=key)['Body'].read()

    def url(self,key):
        return self.client.generate_presigned_url('get_object',Params={'Bucket':self.bucket,'Key':key},ExpiresIn=600)
