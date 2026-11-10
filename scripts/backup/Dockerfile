# syntax=docker/dockerfile:1.28
#
# The server's scheduled backup (compose.yaml, service `backup`): scripts/backup/scheduled.mjs waits for
# BACKUP_TIME and runs the same backup-and-copy.mjs the Windows task runs, which calls `pnpm db:backup` and
# `pnpm db:restore:verify`, so the workspace and its dependencies ship in the image. Runs as root because
# /app/var/backups is a host bind mount that Docker creates root-owned; it serves no requests.
FROM node:24.22.2-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY platform/database/package.json platform/database/package.json
COPY platform/contracts/package.json platform/contracts/package.json
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm config set store-dir /pnpm-store && \
    pnpm install --frozen-lockfile --filter @openrhen/database...
COPY platform/database platform/database
COPY platform/contracts platform/contracts
COPY scripts/backup scripts/backup
CMD ["node", "scripts/backup/scheduled.mjs"]
