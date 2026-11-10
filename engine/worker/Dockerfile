# syntax=docker/dockerfile:1.28
FROM node:24.22.2-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY engine/worker/package.json engine/worker/package.json
COPY platform/database/package.json platform/database/package.json
COPY platform/contracts/package.json platform/contracts/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile
COPY engine/worker engine/worker
COPY platform/database platform/database
COPY platform/contracts platform/contracts
RUN pnpm --filter @openrhen/engine-worker build

FROM node:24.22.2-alpine
WORKDIR /app
COPY --from=build /app/engine/worker/dist/main.js ./main.js
USER node
CMD ["node", "main.js"]
