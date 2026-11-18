# syntax=docker/dockerfile:1
FROM node:24-alpine AS build

WORKDIR /workspace
RUN corepack enable

COPY dashboard/package.json dashboard/pnpm-workspace.yaml dashboard/pnpm-lock.yaml dashboard/tsconfig.base.json ./
COPY dashboard/patches patches
COPY dashboard/packages/contracts/package.json packages/contracts/package.json
COPY dashboard/packages/api-client/package.json packages/api-client/package.json
COPY dashboard/packages/core/package.json packages/core/package.json
COPY dashboard/apps/cli/package.json apps/cli/package.json
RUN pnpm install --frozen-lockfile

COPY dashboard/packages packages
COPY dashboard/apps/cli apps/cli
RUN pnpm --filter @magicstick/dashboard-cli build \
    && node -e 'const {sources} = JSON.parse(require("node:fs").readFileSync("apps/cli/dist/magicstick.js.map", "utf8")); if (!Array.isArray(sources) || !sources.length || sources.some(path => /(^|\/)picomatch(@|\/|$)/.test(path))) throw new Error("Cannot verify the CLI bundle is free of Picomatch");'

# Alpine packages the Node runtime separately from npm. Start from a clean
# base so npm and its transitive packages are absent from all shipped layers.
FROM alpine:3.23@sha256:469c9ea410b9215eaee7976ba6c0639039b444be8e5d638f7abbada189971eb2
LABEL org.opencontainers.image.licenses="BUSL-1.1"

RUN apk add --no-cache 'nodejs~24' \
    && mkdir -p /usr/local/bin \
    && ln -s /usr/bin/node /usr/local/bin/node

COPY --from=build /workspace/apps/cli/dist/magicstick.js /usr/local/bin/magicstick-dashboard
COPY LICENSE LICENSING.md THIRD_PARTY_NOTICES.md /licenses/
COPY licenses /licenses/licenses
COPY LICENSE-RELEASE.json /licenses/
RUN chmod 0755 /usr/local/bin/magicstick-dashboard

USER 65532:65532
WORKDIR /tmp
RUN --network=none test "$(id -u)" = 65532 \
    && ! command -v npm \
    && ! command -v npx \
    && test ! -d /usr/local/lib/node_modules \
    && test ! -d /usr/lib/node_modules \
    && /usr/local/bin/node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) process.exit(1)' \
    && /usr/local/bin/magicstick-dashboard --version \
    && /usr/local/bin/magicstick-dashboard --help >/dev/null

CMD ["/bin/sh", "-ec", "while true; do sleep 3600; done"]
