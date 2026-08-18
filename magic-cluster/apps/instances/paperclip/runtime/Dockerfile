ARG UPSTREAM_IMAGE=ghcr.io/paperclipai/agent-runtime-opencode:git-b18cbb0dd3d524d3d332f54143c84f00c694636c
FROM ${UPSTREAM_IMAGE}

USER 0

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ripgrep \
    && rm -rf /var/lib/apt/lists/*

USER 1000:1000
