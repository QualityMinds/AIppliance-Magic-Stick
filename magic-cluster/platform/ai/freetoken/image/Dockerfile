# syntax=docker/dockerfile:1.7
#
# FreeToken v0.1.3 ships CUDA 13 wheels.  Use a CUDA 13 *devel* image rather
# than a runtime-only image because the upstream accelerated extras may compile
# CUDA extensions on first installation and require nvcc to be present.
ARG FREETOKEN_VERSION=0.1.3
# NVIDIA's published linux/amd64 manifest for CUDA 13.0.2 devel on Ubuntu 24.04.
FROM nvidia/cuda:13.0.2-devel-ubuntu24.04@sha256:0eee3094c71518ad31d011a594ae6ed6de72959ee07e318cb31cffe71690e90c

ARG FREETOKEN_VERSION
ARG TARGETARCH

LABEL org.opencontainers.image.title="MagicStick FreeToken runtime" \
      org.opencontainers.image.description="Bounded Kubernetes runtime adapter for FreeToken" \
      org.opencontainers.image.source="https://github.com/QualityMinds/AIppliance-Magic-Stick" \
      org.opencontainers.image.licenses="Apache-2.0 AND BUSL-1.1" \
      org.opencontainers.image.version="${FREETOKEN_VERSION}"

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH=/opt/freetoken/bin:${PATH} \
    FREETOKEN_HOME=/var/lib/freetoken \
    HF_HOME=/var/lib/freetoken/huggingface \
    XDG_CACHE_HOME=/var/lib/freetoken/.cache \
    HOME=/var/lib/freetoken \
    MAGICSTICK_FREETOKEN_RUNTIME_VERSION=${FREETOKEN_VERSION} \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility

RUN test -z "${TARGETARCH}" || test "${TARGETARCH}" = "amd64"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      build-essential \
      git \
      python3 \
      python3-dev \
      python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/freetoken \
    && /opt/freetoken/bin/pip install --no-cache-dir --upgrade pip setuptools wheel \
    && /opt/freetoken/bin/pip install --no-cache-dir "freetoken[accel]==${FREETOKEN_VERSION}" \
    && /opt/freetoken/bin/pip check \
    && /opt/freetoken/bin/ft --version \
    && nvcc --version

RUN groupadd --gid 10001 freetoken \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /var/lib/freetoken --shell /usr/sbin/nologin freetoken \
    && mkdir -p /var/lib/freetoken/huggingface /var/lib/freetoken/.cache /usr/local/share/licenses \
    && chown -R 10001:10001 /var/lib/freetoken \
    && chmod 0750 /var/lib/freetoken

COPY LICENSE LICENSING.md THIRD_PARTY_NOTICES.md /usr/local/share/licenses/magicstick/
COPY LICENSE-RELEASE.json /usr/local/share/licenses/magicstick/
COPY licenses/ /usr/local/share/licenses/magicstick/licenses/
COPY --chmod=0755 magic-cluster/platform/ai/freetoken/image/entrypoint.sh /usr/local/bin/magicstick-freetoken

USER 10001:10001
WORKDIR /var/lib/freetoken
EXPOSE 1919

# The Kubernetes probes and this image-level probe share the same adapter.  A
# bare HTTP 200 is insufficient because FreeToken may return `status:error`
# in its JSON body while its listener is still alive.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=3 \
  CMD /usr/local/bin/magicstick-freetoken health-live || exit 1

ENTRYPOINT ["/usr/local/bin/magicstick-freetoken"]
