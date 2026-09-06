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
COPY LICENSE LICENSING.md /workspace/
COPY enterprise/LICENSE /workspace/enterprise/LICENSE
RUN pnpm --filter @magicstick/dashboard-web build

FROM nginx:1.27.5-alpine
LABEL org.opencontainers.image.licenses="MIT"

COPY dashboard/apps/web/nginx.conf /etc/nginx/nginx.conf
COPY --from=build /workspace/dashboard/apps/web/dist /usr/share/nginx/html
COPY LICENSE LICENSING.md /licenses/
COPY enterprise/LICENSE /licenses/MagicStick-Enterprise

EXPOSE 8080
USER 101:101
CMD ["nginx", "-g", "daemon off;"]
