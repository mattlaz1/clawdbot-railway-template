# Build openclaw from source to avoid npm packaging gaps (some dist files are not shipped).
FROM node:22-bookworm AS openclaw-build

# Dependencies needed for openclaw build
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    curl \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Install Bun (openclaw build uses it)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

RUN corepack enable

WORKDIR /openclaw

# Pin to a known-good ref (tag/branch). Override in Railway template settings if needed.
# Using a released tag avoids build breakage when `main` temporarily references unpublished packages.
ARG OPENCLAW_GIT_REF=v2026.5.18
RUN git clone --depth 1 --branch "${OPENCLAW_GIT_REF}" https://github.com/openclaw/openclaw.git .

# Patch: relax version requirements for packages that may reference unpublished versions.
# Apply to all extension package.json files to handle workspace protocol (workspace:*).
RUN set -eux; \
  find ./extensions -name 'package.json' -type f | while read -r f; do \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g' "$f"; \
    sed -i -E 's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g' "$f"; \
  done

# Workaround: OpenClaw v2026.5.18's pnpm-workspace.yaml sets
# `minimumReleaseAge: 2880` (48h) for supply-chain hardening. pnpm enforces
# this by reading the npm registry's `time` field for each package. A handful
# of packages (express, @google/genai, observed 2026-05-19) have stripped/
# missing `time` metadata in the registry, which crashes the install with
# ERR_PNPM_MISSING_TIME. Disabling minimum-release-age for the build lets the
# install proceed; we're cloning a tagged release so version-pinning is
# already deterministic via the lockfile.
RUN sed -i -E 's/^minimumReleaseAge:.*$/minimumReleaseAge: 0/' pnpm-workspace.yaml && \
    grep -E '^minimumReleaseAge' pnpm-workspace.yaml
RUN pnpm install --no-frozen-lockfile
# tsdown OOMs at the default ~1 GB Node heap when building v2026.5.18 (observed 2026-05-19).
# 8 GB is well under Railway's build memory; keeps headroom for ui:build too.
RUN NODE_OPTIONS=--max-old-space-size=8192 pnpm build
ENV OPENCLAW_PREFER_PNPM=1
RUN NODE_OPTIONS=--max-old-space-size=8192 pnpm ui:install && NODE_OPTIONS=--max-old-space-size=8192 pnpm ui:build


# Runtime image
FROM node:22-bookworm
ENV NODE_ENV=production

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    python3 \
    python3-venv \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

# `openclaw update` expects pnpm. Provide it in the runtime image.
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

# postgres-mcp — read+write Postgres MCP server (crystaldba/postgres-mcp).
# Bakes into the image so the gateway can spawn it without network on cold start.
# Configured via openclaw.json mcpServers.postgres; reads DATABASE_URL at runtime.
#
# DISABLED 2026-05-20: postgres-mcp requires Python >= 3.12 but Debian Bookworm
# ships python3 3.11. Re-enable once we either upgrade the base image to Trixie
# or install Python 3.12 from deadsnakes. Phase 2 task — not needed for current
# chat UI work which uses Mission Control's own Postgres pool.
# RUN python3 -m pip install --break-system-packages --no-cache-dir postgres-mcp

# Persist user-installed tools by default by targeting the Railway volume.
# - npm global installs -> /data/npm
# - pnpm global installs -> /data/pnpm (binaries) + /data/pnpm-store (store)
ENV NPM_CONFIG_PREFIX=/data/npm
ENV NPM_CONFIG_CACHE=/data/npm-cache
ENV PNPM_HOME=/data/pnpm
ENV PNPM_STORE_DIR=/data/pnpm-store
ENV PATH="/data/npm/bin:/data/pnpm:${PATH}"

WORKDIR /app

# Wrapper deps
COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

# Copy built openclaw
COPY --from=openclaw-build /openclaw /openclaw

# Provide an openclaw executable
RUN printf '%s\n' '#!/usr/bin/env bash' 'exec node /openclaw/dist/entry.js "$@"' > /usr/local/bin/openclaw \
  && chmod +x /usr/local/bin/openclaw

COPY src ./src

# --- Mission Control ---
# MC is a co-located Node app started by the wrapper as a child process.
# It binds 127.0.0.1:3700 inside the container; the wrapper proxies /mc/* to it.
# MC connects to the OpenClaw gateway via ws://127.0.0.1:18789/ (loopback)
# which is the whole point of co-location — loopback clients get operator scopes.
COPY mission-control/package.json mission-control/package-lock.json* ./mission-control/
RUN cd mission-control && npm install --omit=dev && npm cache clean --force
COPY mission-control ./mission-control

# The wrapper listens on $PORT.
# IMPORTANT: Do not set a default PORT here.
# Railway injects PORT at runtime and routes traffic to that port.
# If we force a different port, deployments can come up but the domain will route elsewhere.
EXPOSE 8080

# Ensure PID 1 reaps zombies and forwards signals.
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
