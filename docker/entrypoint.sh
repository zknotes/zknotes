#!/bin/sh
set -e

echo "[entrypoint] Running database migrations…"
bun run /app/server/migrate.ts

echo "[entrypoint] Starting API…"
exec bun run /app/server/index.ts
