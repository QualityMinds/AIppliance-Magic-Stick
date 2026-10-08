# syntax=docker/dockerfile:1
# Reuse the exact upstream revision and local patch from build-amd-dra-image.yml.
# Compile owning recovery tests natively; they use isolated sysfs/checkpoint/CDI
# fixtures, not a host GPU, privileged container or a live kubelet checkpoint.
FROM --platform=$BUILDPLATFORM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS amd-recovery-tests
ARG TARGETARCH
WORKDIR /src
ENV CGO_ENABLED=0
RUN git init && git remote add origin https://github.com/ROCm/k8s-gpu-dra-driver.git \
    && git fetch --depth 1 origin 9eb4e2ea386e34581524b0110e24769654fcb8d2 \
    && git checkout --detach FETCH_HEAD
COPY magic-cluster/platform/gpu/amd-gpu-operator/patches/reboot-cdi-recovery.patch /tmp/recovery.patch
RUN git apply /tmp/recovery.patch \
    && GOOS=linux GOARCH=${TARGETARCH} go test -c -o /amd-recovery.test ./cmd/gpu-kubeletplugin

# Match dashboard/apps/web/package.json. The index pins both amd64 and arm64.
FROM mcr.microsoft.com/playwright:v1.63.0-resolute@sha256:b022639ae9197f864040f92eef7b57c6d4b47db2190f77c909d8a5d902dd4b7e
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.36.4
ARG HELM_VERSION=v4.3.0
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="Magic Stick local regression harness" \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
ENV REGRESSION_SOURCE_REVISION=${SOURCE_REVISION}
WORKDIR /opt/magicstick/dashboard
USER root
RUN apt-get update && apt-get install -y --no-install-recommends libnss3-tools python3 python3-yaml python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && curl --fail --location --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -o /usr/local/bin/kubectl \
    && curl --fail --location --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" -o /tmp/kubectl.sha256 \
    && printf '%s  /usr/local/bin/kubectl\n' "$(cat /tmp/kubectl.sha256)" | sha256sum --check \
    && chmod 755 /usr/local/bin/kubectl && rm /tmp/kubectl.sha256 \
    && npm install --global pnpm@11.19.0
# SEC-03 renders the owning chart and rejects skipped native tests. Pin the
# release and both published checksums: https://github.com/helm/helm/releases/tag/v4.3.0
RUN case "${TARGETARCH}" in \
      amd64) helm_sha256=86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb ;; \
      arm64) helm_sha256=31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08 ;; \
      *) printf 'Unsupported Helm architecture: %s\n' "${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --retry 3 "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" -o /tmp/helm.tar.gz \
    && printf '%s  /tmp/helm.tar.gz\n' "${helm_sha256}" | sha256sum --check \
    && tar -xzf /tmp/helm.tar.gz -C /usr/local/bin --strip-components=1 "linux-${TARGETARCH}/helm" \
    && chmod 755 /usr/local/bin/helm && rm /tmp/helm.tar.gz \
    && test "$(helm version --template '{{.Version}}')" = "${HELM_VERSION}"
COPY dashboard/ ./
COPY LICENSE LICENSING.md THIRD_PARTY_NOTICES.md /opt/magicstick/
COPY LICENSE-RELEASE.json CHANGELOG.md README.md .gitleaks.toml install-from-linux.sh /opt/magicstick/
COPY licenses/ /opt/magicstick/licenses/
COPY magic-installer/ /opt/magicstick/magic-installer/
COPY core/ /opt/magicstick/core/
COPY tools/ /opt/magicstick/tools/
COPY tests/ /opt/magicstick/tests/
COPY docs/development/regression-test-catalog.md /opt/magicstick/docs/development/regression-test-catalog.md
COPY .github/ /opt/magicstick/.github/
COPY magic-host/ /opt/magicstick/magic-host/
COPY magic-cluster/apps/ai/ /opt/magicstick/magic-cluster/apps/ai/
COPY magic-cluster/apps/dashboard/ /opt/magicstick/magic-cluster/apps/dashboard/
COPY magic-cluster/apps/instances/ /opt/magicstick/magic-cluster/apps/instances/
COPY magic-cluster/platform/magicstick-operator/ /opt/magicstick/magic-cluster/platform/magicstick-operator/
COPY magic-cluster/platform/ai/ /opt/magicstick/magic-cluster/platform/ai/
COPY magic-cluster/platform/gpu/ /opt/magicstick/magic-cluster/platform/gpu/
COPY magic-cluster/platform/identity/ /opt/magicstick/magic-cluster/platform/identity/
COPY magic-cluster/flux/ /opt/magicstick/magic-cluster/flux/
COPY --from=amd-recovery-tests /amd-recovery.test /opt/magicstick/regression-runtime/amd-recovery.test
RUN python3 -m venv --system-site-packages /opt/magicstick/regression-runtime/python \
    && /opt/magicstick/regression-runtime/python/bin/pip install --no-cache-dir -r apps/api/requirements.txt \
    && pnpm install --frozen-lockfile --filter @magicstick/dashboard-web... \
    && pnpm --filter @magicstick/dashboard-web build \
    && node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)" \
    && chown -R pwuser:pwuser /opt/magicstick
WORKDIR /opt/magicstick/dashboard/apps/web
ENV PATH="/opt/magicstick/regression-runtime/python/bin:${PATH}"
USER pwuser
ENTRYPOINT ["node", "regression/launch.mjs"]
CMD ["selftest"]
