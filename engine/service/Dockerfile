# syntax=docker/dockerfile:1.28
FROM node:24.22.2-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY engine/service/package.json engine/service/package.json
COPY platform/contracts/package.json platform/contracts/package.json
COPY engine/core/package.json engine/core/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile
COPY engine/service engine/service
COPY platform/contracts platform/contracts
COPY engine/core engine/core
RUN pnpm --filter @openrhen/engine-service build

FROM node:24.22.2-alpine
WORKDIR /app
COPY --from=build /app/engine/service/dist/main.js ./main.js
USER node
EXPOSE 4100
CMD ["node", "main.js"]
