#!/usr/bin/env sh
set -e
pnpm tsx src/features/data-persistence/migrate.ts
exec pnpm tsx src/bot.ts