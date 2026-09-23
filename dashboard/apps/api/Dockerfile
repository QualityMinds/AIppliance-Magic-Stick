FROM python:3.13-alpine
LABEL org.opencontainers.image.licenses="BUSL-1.1"
WORKDIR /opt/magicstick-api
COPY dashboard/apps/api/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY dashboard/apps/api/licensing.py dashboard/apps/api/instance_access.py dashboard/apps/api/federated_sso.py ./
COPY magic-host/roles/host-management/files/network_contract.py ./
COPY magic-host/roles/host-management/files/updates_contract.py ./
COPY magic-host/roles/host-management/files/model_cache.py ./
COPY core/magicstick_core ./magicstick_core
COPY LICENSE LICENSING.md THIRD_PARTY_NOTICES.md /licenses/
COPY licenses /licenses/licenses
COPY LICENSE-RELEASE.json /licenses/
COPY tools/collect_python_notices.py /tmp/collect_python_notices.py
RUN python /tmp/collect_python_notices.py --all-installed --output /licenses/runtime-python.txt && rm /tmp/collect_python_notices.py
RUN python -c "import magicstick_core.sharing, magicstick_core.federated_sso"
ENV PYTHONPATH=/opt/magicstick-api PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
EXPOSE 8080
CMD ["python", "/app/server.py"]
