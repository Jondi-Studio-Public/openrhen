# syntax=docker/dockerfile:1.28
# The example service's own image. A real add-on that ships packages of its own overrides the build of the
# core services it extends in the same way, with a Dockerfile that builds core plus its packages.
FROM node:24.22.2-alpine
WORKDIR /app
COPY addons/example/service.mjs ./service.mjs
USER node
CMD ["node", "service.mjs"]
