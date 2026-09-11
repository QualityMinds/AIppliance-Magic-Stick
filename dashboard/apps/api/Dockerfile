FROM python:3.13-alpine
LABEL org.opencontainers.image.licenses="MIT AND LicenseRef-MagicStick-Enterprise"
WORKDIR /opt/magicstick-api
COPY dashboard/apps/api/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY dashboard/apps/api/licensing.py dashboard/apps/api/instance_access.py dashboard/apps/api/federated_sso.py ./
COPY magic-host/roles/host-management/files/network_contract.py ./
COPY enterprise/magicstick_enterprise ./magicstick_enterprise
COPY LICENSE /licenses/MagicStick-MIT
COPY LICENSING.md /licenses/LICENSING.md
COPY enterprise/README.md /licenses/Enterprise-README.md
COPY enterprise/LICENSE /licenses/MagicStick-Enterprise
RUN python -c "import magicstick_enterprise; assert magicstick_enterprise.CAPABILITIES == frozenset({'resource-sharing', 'federated-sso'})"
ENV PYTHONPATH=/opt/magicstick-api PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
EXPOSE 8080
CMD ["python", "/app/server.py"]
