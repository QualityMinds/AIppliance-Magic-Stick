# syntax=docker/dockerfile:1
# Match dashboard/apps/web/package.json. The index pins both amd64 and arm64.
FROM mcr.microsoft.com/playwright:v1.63.0-resolute@sha256:b022639ae9197f864040f92eef7b57c6d4b47db2190f77c909d8a5d902dd4b7e
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.36.4
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="Magic Stick local regression harness" \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
ENV REGRESSION_SOURCE_REVISION=${SOURCE_REVISION}
WORKDIR /opt/magicstick/dashboard
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools python3 python3-yaml \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --location --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -o /usr/local/bin/kubectl \
    && curl --fail --location --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" -o /tmp/kubectl.sha256 \
    && printf '%s  /usr/local/bin/kubectl\n' "$(cat /tmp/kubectl.sha256)" | sha256sum --check \
    && chmod 755 /usr/local/bin/kubectl && rm /tmp/kubectl.sha256 \
    && npm install --global pnpm@11.19.0
COPY dashboard/ ./
COPY LICENSE LICENSING.md THIRD_PARTY_NOTICES.md /opt/magicstick/
COPY licenses/ /opt/magicstick/licenses/
COPY magic-cluster/apps/ai/private-mesh/client.html /opt/magicstick/magic-cluster/apps/ai/private-mesh/client.html
COPY magic-cluster/apps/dashboard/ /opt/magicstick/magic-cluster/apps/dashboard/
COPY magic-cluster/platform/magicstick-operator/ /opt/magicstick/magic-cluster/platform/magicstick-operator/
RUN pnpm install --frozen-lockfile --filter @magicstick/dashboard-web... \
    && pnpm --filter @magicstick/dashboard-web build \
    && node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)" \
    && chown -R pwuser:pwuser /opt/magicstick
WORKDIR /opt/magicstick/dashboard/apps/web
USER pwuser
ENTRYPOINT ["node", "regression/launch.mjs"]
CMD ["selftest"]
