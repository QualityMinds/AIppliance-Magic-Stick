FROM python:3.13-alpine AS community
LABEL org.opencontainers.image.licenses="MIT"
WORKDIR /opt/magicstick-api
COPY dashboard/apps/api/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY dashboard/apps/api/licensing.py dashboard/apps/api/instance_access.py ./
COPY LICENSE /licenses/MagicStick-MIT
COPY LICENSING.md /licenses/LICENSING.md
ENV PYTHONPATH=/opt/magicstick-api PYTHONDONTWRITEBYTECODE=1
USER 65532:65532
EXPOSE 8080
CMD ["python", "/app/server.py"]

FROM community AS enterprise
COPY enterprise/magicstick_enterprise ./magicstick_enterprise
COPY enterprise/README.md /licenses/Enterprise-README.md
COPY enterprise/LICENSE /licenses/MagicStick-Enterprise
LABEL org.opencontainers.image.licenses="MIT AND LicenseRef-MagicStick-Enterprise"

# Publication of the optional commercial package requires approved terms.
# Keep the default distributable Community-only until that release gate is met.
FROM community AS default
