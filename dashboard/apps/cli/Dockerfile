FROM node:24-alpine AS build

WORKDIR /workspace
RUN corepack enable

COPY dashboard/package.json dashboard/pnpm-workspace.yaml dashboard/pnpm-lock.yaml dashboard/tsconfig.base.json ./
COPY dashboard/packages/contracts/package.json packages/contracts/package.json
COPY dashboard/packages/api-client/package.json packages/api-client/package.json
COPY dashboard/packages/core/package.json packages/core/package.json
COPY dashboard/apps/cli/package.json apps/cli/package.json
RUN pnpm install --frozen-lockfile

COPY dashboard/packages packages
COPY dashboard/apps/cli apps/cli
RUN pnpm --filter @magicstick/dashboard-cli build

FROM node:24-alpine
LABEL org.opencontainers.image.licenses="MIT"

COPY --from=build /workspace/apps/cli/dist/magicstick.js /usr/local/bin/magicstick-dashboard
COPY LICENSE LICENSING.md /licenses/
COPY enterprise/LICENSE /licenses/MagicStick-Enterprise
RUN chmod 0755 /usr/local/bin/magicstick-dashboard

USER 65532:65532
WORKDIR /tmp
CMD ["/bin/sh", "-ec", "while true; do sleep 3600; done"]
