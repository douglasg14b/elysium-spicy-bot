# ---- Build with pnpm (Node has corepack) ----
FROM node:20-alpine AS builder
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

WORKDIR /app

# Install deps using lockfile for caching
COPY pnpm-lock.yaml package.json ./
RUN pnpm fetch

# Bring in the rest and install offline, then build
COPY . .
RUN pnpm install -r --offline
RUN pnpm run build

# ---- Minimal Bun runtime ----
FROM oven/bun:latest AS runner
WORKDIR /app

# Copy only what you need to run
COPY package.json ./
COPY --from=builder /app .

CMD ["bun", "src/bot.ts"]