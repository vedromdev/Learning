# syntax=docker/dockerfile:1.7
#
# Simurgh Chat — production image for Railway (and any Docker host).
#
#   Build stage : install deps, generate Prisma client, build Next.js
#   Run stage   : slim runtime with only production node_modules
#
# Railway auto-detects this Dockerfile. The container listens on $PORT
# (injected by Railway) and stores uploads/backups/logs under $DATA_DIR
# (mount a Railway Volume at /data to persist them).

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# 1. Build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CI=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install ALL deps (dev deps are required for next build / prisma / typescript)
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --include=dev --no-audit --no-fund

COPY . .

# Prisma client must be generated before `next build` type-checks the code.
# DATABASE_URL is not needed for `prisma generate`.
RUN npx prisma generate \
 && NODE_OPTIONS="--max-old-space-size=2048" npm run build

# Drop dev dependencies for the runtime image
RUN npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------------------
# 2. Runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runner

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data

# openssl  -> required by the Prisma engine
# curl     -> used by the container healthcheck
# mongodb-database-tools -> mongodump/mongorestore for the admin Backup panel
#   (best-effort: the app works without it, the backup feature will just
#    report an error). Only amd64 builds are published for Debian 12, which
#    is what Railway uses.
ARG MONGO_TOOLS_VERSION=100.12.2
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && ARCH="$(dpkg --print-architecture)" \
 && if [ "$ARCH" = "amd64" ]; then \
      TOOLS_ARCH="x86_64"; \
      curl -fsSL -o /tmp/mongo-tools.deb \
        "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-debian12-${TOOLS_ARCH}-${MONGO_TOOLS_VERSION}.deb" \
      && apt-get install -y --no-install-recommends /tmp/mongo-tools.deb \
      && rm -f /tmp/mongo-tools.deb \
      || echo "WARN: mongodb-database-tools not installed; admin backups will be unavailable"; \
    else \
      echo "WARN: skipping mongodb-database-tools on ${ARCH}"; \
    fi \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Data dirs (a Railway Volume mounted at /data will shadow these at runtime).
# NOTE: Railway mounts volumes as root, so the container runs as root by
# default to guarantee /data is writable. If you prefer a non-root user, add
#   USER node
# below and set RAILWAY_RUN_UID=0 on the service (see docs/RAILWAY.md).
RUN mkdir -p /data/uploads /data/backups /data/logs

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/next.config.ts ./next.config.ts

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

# bootstrap.mjs: sync Prisma schema to MongoDB + create superadmin if missing,
# then hand off to the custom Next.js + Socket.IO server.
CMD ["sh", "-c", "node scripts/bootstrap.mjs && node server.mjs"]
