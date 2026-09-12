# ---- Build with pnpm (Node has corepack) ----
FROM node:20-alpine AS runner
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable pnpm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY . /app
WORKDIR /app
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
# Build the web dashboard's static assets into web/dist. The entrypoint runs the bot
# from source via tsx, and the in-process web server serves web/dist when present.
# (No-op at runtime if the web env vars are unset — the server simply doesn't start.)
RUN pnpm build:web
RUN chmod +x src/scripts/dockerEntrypoint.sh

ENTRYPOINT ["src/scripts/dockerEntrypoint.sh"]