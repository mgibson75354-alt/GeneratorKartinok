FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# Official Russian Trusted Root CA certificate for platform-api2.max.ru.
# Obtain the PEM certificate from the official source before building.
COPY deploy/certs/russian_trusted_root_ca_pem.crt /app/certs/russian_trusted_root_ca_pem.crt
RUN python -c "from pathlib import Path; import certifi, ssl; root=Path('/app/certs/russian_trusted_root_ca_pem.crt'); ssl.PEM_cert_to_DER_cert(root.read_text()); bundle=Path('/app/certs/max-ca-bundle.pem'); bundle.write_bytes(Path(certifi.where()).read_bytes()+b'\n'+root.read_bytes()+b'\n')"
ENV MAX_CA_BUNDLE=/app/certs/max-ca-bundle.pem

COPY backend /app/backend
COPY main.py /app/main.py
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
CMD ["uvicorn","main:app","--host","0.0.0.0","--port","8080"]
