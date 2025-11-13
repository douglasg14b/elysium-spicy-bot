#!/usr/bin/env sh
set -e
pnpm migrate:latest
exec pnpm tsx src/bot.ts