# syntax=docker/dockerfile:1
# Compile the same native AMD recovery tests without retaining fetch/patch layers.
FROM --platform=$BUILDPLATFORM golang:1.26.5-alpine3.24@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2 AS amd-recovery-tests
ARG TARGETARCH
ENV CGO_ENABLED=0
RUN --mount=type=bind,source=magic-cluster/platform/gpu/amd-gpu-operator/patches/reboot-cdi-recovery.patch,target=/tmp/recovery.patch \
    apk add --no-cache ca-certificates git \
    && mkdir /src && cd /src \
    && git init && git remote add origin https://github.com/ROCm/k8s-gpu-dra-driver.git \
    && git fetch --depth 1 origin 9eb4e2ea386e34581524b0110e24769654fcb8d2 \
    && git checkout --detach FETCH_HEAD && git apply /tmp/recovery.patch \
    && GOOS=linux GOARCH=${TARGETARCH} go test -c -o /amd-recovery.test ./cmd/gpu-kubeletplugin \
    && rm -rf /src /go/pkg /root/.cache/go-build

# Only Chromium headless shell is used by the registered browser workflows.
# Install its exact version from the workspace lock; no Firefox/WebKit or headed browser.
# The immutable official Node index supports both amd64 and arm64.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG TARGETARCH
ARG KUBECTL_VERSION=v1.36.4
ARG HELM_VERSION=v4.3.0
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.title="Magic Stick local regression harness" \
      org.opencontainers.image.licenses="BUSL-1.1" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
ENV REGRESSION_SOURCE_REVISION=${SOURCE_REVISION} \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PATH="/opt/magicstick/regression-runtime/python/bin:${PATH}"

# Read the .dockerignore-filtered context and native binary without a COPY layer
# per directory. Keep only the selected source tree, dependencies and runtime.
RUN --mount=type=bind,source=.,target=/source \
    --mount=type=bind,from=amd-recovery-tests,source=/amd-recovery.test,target=/tmp/amd-recovery.test \
    apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libnss3-tools python3 python3-yaml python3-venv \
    && npm install --global pnpm@11.19.0 \
    && curl --fail --location --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl" -o /usr/local/bin/kubectl \
    && curl --fail --location --retry 3 "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl.sha256" -o /tmp/kubectl.sha256 \
    && printf '%s  /usr/local/bin/kubectl\n' "$(cat /tmp/kubectl.sha256)" | sha256sum --check \
    && chmod 755 /usr/local/bin/kubectl && rm /tmp/kubectl.sha256 \
    && case "${TARGETARCH}" in \
      amd64) helm_sha256=86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb ;; \
      arm64) helm_sha256=31c5794dd55c66a51e6b7d2e2ac7a114ae8b1de41ff1d9ba51748ac973b06a08 ;; \
      *) printf 'Unsupported Helm architecture: %s\n' "${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --retry 3 "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" -o /tmp/helm.tar.gz \
    && printf '%s  /tmp/helm.tar.gz\n' "${helm_sha256}" | sha256sum --check \
    && tar -xzf /tmp/helm.tar.gz -C /usr/local/bin --strip-components=1 "linux-${TARGETARCH}/helm" \
    && chmod 755 /usr/local/bin/helm && rm /tmp/helm.tar.gz \
    && test "$(helm version --template '{{.Version}}')" = "${HELM_VERSION}" \
    && mkdir -p /opt/magicstick/regression-runtime /opt/magicstick/docs/development \
    && cd /source && cp -a --parents dashboard LICENSE LICENSING.md THIRD_PARTY_NOTICES.md LICENSE-RELEASE.json \
      CHANGELOG.md README.md .gitleaks.toml install-from-linux.sh licenses magic-installer core tools tests .github magic-host \
      docs/development/regression-test-catalog.md magic-cluster/apps/ai magic-cluster/apps/dashboard magic-cluster/apps/instances \
      magic-cluster/platform/magicstick-operator magic-cluster/platform/ai magic-cluster/platform/gpu magic-cluster/platform/identity \
      magic-cluster/flux /opt/magicstick/ \
    && cp /tmp/amd-recovery.test /opt/magicstick/regression-runtime/amd-recovery.test \
    && cd /opt/magicstick/dashboard \
    && python3 -m venv --system-site-packages /opt/magicstick/regression-runtime/python \
    && /opt/magicstick/regression-runtime/python/bin/pip install --no-cache-dir -r apps/api/requirements.txt \
    && pnpm install --frozen-lockfile --filter @magicstick/dashboard-web... \
    && pnpm --filter @magicstick/dashboard-web exec playwright install --with-deps --only-shell chromium \
    && pnpm --filter @magicstick/dashboard-web build \
    && node -e "if (Number(process.versions.node.split('.')[0]) < 24) process.exit(1)" \
    && chmod -R a+rX /ms-playwright /opt/magicstick \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.npm /root/.cache /root/.local/share/pnpm/store
WORKDIR /opt/magicstick/dashboard/apps/web
USER node
ENTRYPOINT ["node", "regression/launch.mjs"]
CMD ["selftest"]
