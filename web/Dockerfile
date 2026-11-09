# BrandPilot container image (ADR-008). One image, three roles, chosen by the command:
#   web      (default)  Next.js server on $PORT (default 3000)
#   worker              background jobs (WORKER_QUEUES=jobs,ai)
#   migrate             apply database migrations, then exit
# e.g. `docker run … brandpilot worker`. The entrypoint execs the process directly (no npm
# wrapper), so SIGTERM reaches it and shutdowns are graceful.
#
# Build:  docker build -t brandpilot:$(git rev-parse --short HEAD) web
# Runs as an unprivileged user. Contains no secrets: configuration comes from the environment at
# run time (see docs/DEPLOYMENT.md). Pass --build-arg BASE_IMAGE=<mirror>/node:22-bookworm-slim to
# build from a registry mirror.
ARG BASE_IMAGE=node:22-bookworm-slim

FROM ${BASE_IMAGE} AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${BASE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000
RUN groupadd --system app && useradd --system --gid app --home-dir /app app
COPY --from=build --chown=app:app /app/package.json /app/package-lock.json /app/next.config.mjs /app/tsconfig.json ./
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/.next ./.next
COPY --from=build --chown=app:app /app/drizzle ./drizzle
# Server source for the tsx-run roles (worker, migrate), and the entrypoint.
COPY --from=build --chown=app:app /app/src ./src
COPY --from=build --chown=app:app /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["./scripts/docker-entrypoint.sh"]
CMD ["web"]
