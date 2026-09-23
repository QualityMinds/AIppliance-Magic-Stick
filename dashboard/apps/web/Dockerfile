FROM node:24-alpine AS build

WORKDIR /workspace/dashboard
RUN corepack enable

COPY dashboard/package.json dashboard/pnpm-workspace.yaml dashboard/pnpm-lock.yaml dashboard/tsconfig.base.json ./
COPY dashboard/packages/contracts/package.json packages/contracts/package.json
COPY dashboard/packages/api-client/package.json packages/api-client/package.json
COPY dashboard/packages/core/package.json packages/core/package.json
COPY dashboard/apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY dashboard/packages packages
COPY dashboard/apps/web apps/web
COPY LICENSE LICENSING.md THIRD_PARTY_NOTICES.md /workspace/
COPY licenses /workspace/licenses
COPY LICENSE-RELEASE.json /workspace/
RUN pnpm --filter @magicstick/dashboard-web build

FROM nginx:1.27.5-alpine
LABEL org.opencontainers.image.licenses="BUSL-1.1"

COPY dashboard/apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /workspace/dashboard/apps/web/dist /usr/share/nginx/html
COPY LICENSE LICENSING.md THIRD_PARTY_NOTICES.md /licenses/
COPY licenses /licenses/licenses
COPY LICENSE-RELEASE.json /licenses/

EXPOSE 8080
USER 101:101
CMD ["nginx", "-g", "daemon off;"]
