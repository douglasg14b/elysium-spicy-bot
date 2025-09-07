FROM oven/bun:latest AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

FROM base AS builder

WORKDIR /app
COPY . .

FROM base AS runner

WORKDIR /app
COPY --from=builder /app/ .
RUN pnpm install --frozen-lockfile --prefer-offline
RUN bun install

CMD ["bun", "src/bot.ts"]