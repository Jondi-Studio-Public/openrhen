# syntax=docker/dockerfile:1.28
#
# A separate service from the portal deliberately: this is where the third-party credentials live.
# every provider credential (GOOGLE_MAPS_API_KEY, OPENAI_API_KEY and the rest) is
# set only on this container, which is never published on the LAN, while the portal - which is -
# holds nothing but this service's URL and a bearer token. Every outbound HTTPS call the portal
# needs goes here.
FROM node:24.22.2-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY integrations/outbound-proxy/package.json integrations/outbound-proxy/package.json
COPY platform/contracts/package.json platform/contracts/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile
COPY integrations/outbound-proxy integrations/outbound-proxy
COPY platform/contracts platform/contracts
RUN pnpm --filter @openrhen/outbound-proxy build

FROM node:24.22.2-alpine
WORKDIR /app
# main.js, plus any one-time tool a drop-in ships (drop-ins/<name>/bin).
COPY --from=build /app/integrations/outbound-proxy/dist ./
# A fresh named volume copies this directory's owner, so node can write a connection's token there.
RUN mkdir -p /var/lib/openrhen-proxy && chown node:node /var/lib/openrhen-proxy && chmod 700 /var/lib/openrhen-proxy
USER node
EXPOSE 4200
CMD ["node", "main.js"]
