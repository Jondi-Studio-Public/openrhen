# syntax=docker/dockerfile:1.28
FROM node:24.22.1-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY portal/package.json portal/package.json
COPY platform/contracts/package.json platform/contracts/package.json
COPY platform/database/package.json platform/database/package.json
COPY tools/cli/package.json tools/cli/package.json
COPY integrations/activity-importers/package.json integrations/activity-importers/package.json
COPY integrations/communication-readers/package.json integrations/communication-readers/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile
COPY portal portal
COPY platform/contracts platform/contracts
COPY platform/database platform/database
COPY tools/cli tools/cli
COPY integrations/activity-importers integrations/activity-importers
COPY integrations/communication-readers integrations/communication-readers

# The build takes no configuration: `vinext build` emits dist/standalone/, and the server reads
# DATABASE_URL and the rest from the environment at start (portal/server/runtime-env.ts). Nothing
# secret can land in an image layer because nothing secret is present while building.
RUN pnpm --filter @openrhen/portal build

# The agent CLI bundle the portal serves at /api/cli/bundle. The commit is a sentinel here (the image has
# no .git); the route stamps the real one at request time from OPENRHEN_BUILD_COMMIT.
RUN OPENRHEN_BUILD_COMMIT=__SERVER_COMMIT__ pnpm --filter @openrhen/cli build

FROM node:24.22.1-alpine
WORKDIR /app
# dist/standalone/ is self-contained: server.js, the built client and server output, the public
# assets, and only the runtime dependencies the server bundle actually imports. No install here.
COPY --from=build /app/portal/dist/standalone ./
COPY --from=build /app/tools/cli/dist/rhen.mjs /app/cli/rhen.mjs
ENV HOST=0.0.0.0
ENV PORT=8787
USER node
EXPOSE 8787
CMD ["node", "server.js"]
