# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Build stage: compile the shared package, the server and the web interface.
# ---------------------------------------------------------------------------
FROM node:22-bookworm AS build

WORKDIR /app

# Build tooling for better-sqlite3. A prebuilt binary is used when one matches the
# platform; these are here so an unusual architecture still builds rather than failing.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy manifests first so `npm ci` is cached independently of the source.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/

RUN npm ci

COPY packages/ packages/

RUN npm run build

# Drop development dependencies so they are not carried into the runtime image.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Kopia: used read-only, to list what is in the backup repository.
# Set INSTALL_KOPIA=false to build an image without backup verification.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS kopia

ARG INSTALL_KOPIA=true
ARG KOPIA_VERSION=0.18.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    mkdir -p /out; \
    if [ "$INSTALL_KOPIA" = "true" ]; then \
      case "$(dpkg --print-architecture)" in \
        amd64) arch=x64 ;; \
        arm64) arch=arm64 ;; \
        *) echo "Unsupported architecture for Kopia: $(dpkg --print-architecture)" >&2; exit 1 ;; \
      esac; \
      curl -fsSL -o /tmp/kopia.tar.gz \
        "https://github.com/kopia/kopia/releases/download/v${KOPIA_VERSION}/kopia-${KOPIA_VERSION}-linux-${arch}.tar.gz"; \
      tar -xzf /tmp/kopia.tar.gz -C /tmp; \
      cp "/tmp/kopia-${KOPIA_VERSION}-linux-${arch}/kopia" /out/kopia; \
      chmod +x /out/kopia; \
    fi

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

LABEL org.opencontainers.image.title="SakuraDrive" \
      org.opencontainers.image.description="NAS monitoring, cataloguing and disaster-recovery tooling for StableBit DrivePool" \
      org.opencontainers.image.source="https://github.com/dsdude123/sakuradrive"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./public

# Present only when the image was built with INSTALL_KOPIA=true.
COPY --from=kopia /out/ /usr/local/bin/

ENV NODE_ENV=production \
    SAKURADRIVE_DATA_DIR=/data \
    SAKURADRIVE_WEB_ROOT=/app/public \
    PORT=8080 \
    TZ=UTC

# The database, generated exports and the Kopia cache all live here.
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps the short-lived kopia processes the backup workflow spawns.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/dist/main.js"]
