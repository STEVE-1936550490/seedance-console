FROM python:3.12-slim

ARG PYPI_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV LOG_LEVEL=ERROR
ENV PYTHONPATH=/app

WORKDIR /app

COPY pythonSDK-0515.zip /tmp/pythonSDK-0515.zip
RUN python -c "import hashlib,zipfile; source=zipfile.ZipFile('/tmp/pythonSDK-0515.zip'); data=source.read('pythonSDK-0515/maas_seedance_sdk-1.0.0-py3-none-any.whl'); assert hashlib.sha256(data).hexdigest() == '36f86be4d97400c1964eba0a0f9b845e047e8430499ae42990cb98cb9d961039'; open('/tmp/maas_seedance_sdk-1.0.0-py3-none-any.whl','wb').write(data)" \
    && pip install --no-cache-dir --index-url "${PYPI_INDEX_URL}" /tmp/maas_seedance_sdk-1.0.0-py3-none-any.whl socksio==1.0.0 \
    && rm -f /tmp/pythonSDK-0515.zip /tmp/maas_seedance_sdk-1.0.0-py3-none-any.whl

COPY services/provider-bridge/provider_bridge /app/provider_bridge

RUN useradd --system --uid 10001 --create-home bridge \
    && mkdir -p /var/lib/seedance-bridge/keys /var/lib/seedance-bridge/registry /var/lib/seedance-bridge/tmp \
    && chown -R bridge:bridge /var/lib/seedance-bridge

USER bridge

WORKDIR /var/lib/seedance-bridge

EXPOSE 43173

CMD ["python", "-m", "provider_bridge"]
