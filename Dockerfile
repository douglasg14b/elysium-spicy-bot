# ---- Build with pnpm (Node has corepack) ----
FROM node:20-alpine AS runner
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY . /app
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN chmod +x /app/scripts/dockerEntrypoint.sh

ENTRYPOINT ["src/scripts/dockerEntrypoint.sh"]