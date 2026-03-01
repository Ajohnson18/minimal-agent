# ── Build stage ──────────────────────────────────────────────
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json pnpm-lock.yaml ./
COPY patches/ patches/
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

# ── Production stage ─────────────────────────────────────────
FROM node:22-slim AS production

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      docker.io \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Use /tmp/kai so process.cwd()-based sandbox bind mounts land on a
# Docker-for-Mac / Linux shared path (/tmp is always shared).
WORKDIR /tmp/kai

COPY package.json pnpm-lock.yaml ./
COPY patches/ patches/
RUN pnpm install --frozen-lockfile

# Copy compiled output from build stage
COPY --from=build /app/dist/ dist/

# Copy runtime assets
COPY drizzle/ drizzle/
COPY skills/ skills/
COPY powers/ powers/
COPY config.example.json config.example.json
COPY config.deploy.json config.deploy.json

# Sandbox Dockerfiles — used to auto-build sandbox images via Docker socket
COPY Dockerfile.sandbox-exec Dockerfile.sandbox-exec

ENV NODE_ENV=production
ENV AVA_CONFIG_PATH=/tmp/kai/config.deploy.json

EXPOSE 3001 18789

CMD ["npx", "tsx", "dist/index.js"]
