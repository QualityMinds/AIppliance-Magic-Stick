FROM node:24-alpine AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/api-client/package.json packages/api-client/package.json
COPY packages/core/package.json packages/core/package.json
COPY apps/cli/package.json apps/cli/package.json
RUN pnpm install --frozen-lockfile

COPY packages packages
COPY apps/cli apps/cli
RUN pnpm --filter @magicstick/dashboard-cli build

FROM node:24-alpine

COPY --from=build /workspace/apps/cli/dist/magicstick.js /usr/local/bin/magicstick-dashboard
RUN chmod 0755 /usr/local/bin/magicstick-dashboard

USER 65532:65532
WORKDIR /tmp
CMD ["/bin/sh", "-ec", "while true; do sleep 3600; done"]
