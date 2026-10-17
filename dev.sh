#!/bin/bash
# Run with:  ./dev.sh
# Stop with: ./dev.sh stop
#
# It brings up the whole of this repository's local development: the dev database and Garage (through
# compose, as needed), the migrations, the API on port 3000 and the web client on 5173. Nothing else —
# this is everything the repository holds.

# Kill the whole process tree (subshell → bun → vite/node). A plain `kill $(jobs -p)` only stops the
# subshells: on Ctrl+C the children are killed by the signal sent to the whole process group, but on an
# external TERM (a timeout, a kill, the IDE's stop button) bun and vite stay alive.
kill_tree() {
    local pid=$1
    local child
    for child in $(pgrep -P "$pid" 2>/dev/null); do
        kill_tree "$child"
    done
    kill "$pid" 2>/dev/null
}

# The dev ports this script brings up (it does not touch the docker DB/Garage).
DEV_PORTS=(
    "3000:API"
    "5173:Web"
)

ROOT="$(cd "$(dirname "$0")" && pwd)"

# The launcher's instance is remembered in a PID file rather than hunted down with `pgrep` by the
# script's name. `dev.sh` is not a unique name on a machine — the neighbouring repositories have their
# own `dev.sh` — so a `pgrep -f "dev\.sh"` would stop other people's servers too.
PID_FILE="$ROOT/.dev-launcher.pid"

kill_port_listeners() {
    local signal=$1
    local entry port name pids
    for entry in "${DEV_PORTS[@]}"; do
        port="${entry%%:*}"
        name="${entry#*:}"
        pids=$(lsof -ti ":${port}" 2>/dev/null || true)
        if [[ -n "$pids" ]]; then
            echo "  Port $port ($name)..."
            echo "$pids" | xargs kill "-$signal" 2>/dev/null || true
        fi
    done
}

stop_dev_servers() {
    echo "🛑 Stopping the dev servers..."

    # The port listeners first — bun/vite/php survive the launcher disappearing.
    kill_port_listeners TERM
    sleep 1
    kill_port_listeners 9

    # A launcher from another terminal (with no kill_tree — it shares the process group with this command).
    if [[ -f "$PID_FILE" ]]; then
        local pid
        pid=$(cat "$PID_FILE" 2>/dev/null || true)
        if [[ -n "$pid" && "$pid" -ne $$ && "$pid" -ne $PPID ]] && kill -0 "$pid" 2>/dev/null; then
            echo "  Launcher PID $pid..."
            kill "$pid" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
    fi

    local entry port name
    local any_left=0
    for entry in "${DEV_PORTS[@]}"; do
        port="${entry%%:*}"
        name="${entry#*:}"
        if nc -z localhost "$port" 2>/dev/null; then
            echo "⚠️  Port $port ($name) is still in use."
            any_left=1
        fi
    done

    if [[ "$any_left" -eq 0 ]]; then
        echo "✅ The dev servers are stopped."
    else
        echo "❌ Some ports are still in use. Check with: lsof -i :3000 -i :5173"
        exit 1
    fi
}

if [[ "${1:-}" == "stop" ]]; then
    stop_dev_servers
    exit 0
fi

cleanup() {
    trap - EXIT
    echo "Stopping the servers..."
    rm -f "$PID_FILE"
    local pid
    for pid in $(jobs -p); do
        kill_tree "$pid"
    done
}

trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

echo $$ >"$PID_FILE"

echo "🚀 Starting ZKnotes (development)..."

# ── A fresh copy of shared for the server ────────────────────────────────────
# The server depends on shared through `file:../shared`, a hard-linked copy that a new file, or one
# saved by replacing it, does not reach until the next install. --frozen-lockfile refreshes the copy and
# never rewrites bun.lock.
echo "📦 Refreshing the server's copy of shared (bun install --frozen-lockfile)..."
( cd "$ROOT" && bun install --frozen-lockfile ) || {
    echo "❌ bun install --frozen-lockfile failed — is bun.lock current? (Offline, the Bun cache has to hold every package.)"
    exit 1
}

# ── server/.env must exist ───────────────────────────────────────────────────
# Everything below this point reads it: drizzle-kit takes DATABASE_URL from it and the Garage probe
# greps S3_ENDPOINT / S3_BUCKET out of it. `.env` is gitignored, so a fresh clone never has one —
# and drizzle-kit then fails with "DATABASE_URL must be set", which reads like a wrong value rather
# than a missing file. Fail here instead, before the database and Garage are started for nothing.
ENV_FILE="$ROOT/server/.env"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "❌ server/.env is missing — without it neither the migrations nor the API will run."
    echo "   Create it from the template:"
    echo "     cp server/.env.example server/.env"
    echo "   The template's defaults already point at the local dev setup (the DB on 5434, Garage on 9000)."
    echo "   COOKIE_SECRET and KDF_FAKE_SEED are placeholders — fine in dev; for production"
    echo "   generate them with: openssl rand -hex 32"
    exit 1
fi

if ! grep -qE '^[[:space:]]*DATABASE_URL=.' "$ENV_FILE"; then
    echo "❌ server/.env exists, but it has no DATABASE_URL."
    echo "   For local dev: DATABASE_URL=postgresql://zknotes:zknotes@localhost:5434/zknotes"
    exit 1
fi

# ── Checking the ports are free ──────────────────────────────────────────────
check_port() {
    local port=$1
    local name=$2
    if nc -z localhost "$port" 2>/dev/null; then
        echo "❌ Error: port $port is already in use ($name). Stop whatever is using it before starting."
        exit 1
    fi
}

check_port 3000 "API"
check_port 5173 "Web client"

# ── The dev DB check (port 5434) ─────────────────────────────────────────────
is_db_ready() {
    nc -z localhost 5434 2>/dev/null && docker compose exec -T db pg_isready -U zknotes >/dev/null 2>&1
}

if ! is_db_ready; then
    echo "🗄️  The dev database is not reachable/ready on port 5434 — starting: docker compose up -d db"
    ( cd "$ROOT" && docker compose up -d db ) || {
        echo "❌ Starting the database failed. Check docker compose."
        exit 1
    }
    for _ in $(seq 1 15); do
        is_db_ready && break
        sleep 1
    done
    if ! is_db_ready; then
        echo "❌ The database did not come up and become ready on port 5434 within 15s."
        exit 1
    fi
fi

# ── The Garage check (the S3 storage for file chunks) ────────────────────────
# The port is read from S3_ENDPOINT in server/.env (9000 by default); it is started as needed.
# Garage's image has no shell (scratch-based), so unlike the old MinIO image there is nothing to
# `docker compose exec` a curl into — the health check below hits the admin API's /health from the
# host instead, on the port docker-compose.yml maps it to (9001).
S3_ENDPOINT=$(grep -E '^S3_ENDPOINT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
GARAGE_PORT=$(echo "$S3_ENDPOINT" | sed -nE 's#.*:([0-9]+)/?$#\1#p')
GARAGE_PORT=${GARAGE_PORT:-9000}
GARAGE_ADMIN_PORT=9001

is_garage_ready() {
    nc -z localhost "$GARAGE_PORT" 2>/dev/null && curl -sf "http://localhost:${GARAGE_ADMIN_PORT}/health" >/dev/null 2>&1
}

if ! is_garage_ready; then
    echo "📦 Garage is not reachable/ready on port $GARAGE_PORT — starting: docker compose up -d garage"
    ( cd "$ROOT" && docker compose up -d garage ) || {
        echo "❌ Starting Garage failed. Check docker compose."
        exit 1
    }
    for _ in $(seq 1 15); do
        is_garage_ready && break
        sleep 1
    done
    if ! is_garage_ready; then
        echo "❌ Garage did not come up on port $GARAGE_PORT within 15s."
        exit 1
    fi
fi

# The bucket has to exist before the first file upload (a fresh Garage volume is empty), and the
# CORS rule has to be set before the browser can PUT/GET it directly (Garage has no
# MINIO_API_CORS_ALLOW_ORIGIN-style env var). The API's ensureS3Bucket() creates the bucket at
# startup too; this is belt and braces through the compose init, and the only place CORS gets set.
S3_BUCKET=$(grep -E '^S3_BUCKET=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)
S3_BUCKET=${S3_BUCKET:-zknotes}
echo "📦 Checking the Garage bucket '${S3_BUCKET}'..."
( cd "$ROOT" && docker compose up -d garage_init ) >/dev/null 2>&1 || true

# ── Migrations (idempotent — fast when there are none new) ───────────────────
echo "🗄️  Applying the migrations..."
( cd "$ROOT/server" && bunx drizzle-kit migrate --config drizzle.config.ts ) || {
    echo "❌ The migrations failed. Check DATABASE_URL in server/.env"
    exit 1
}

# ── API server (with --watch for hot reload) ─────────────────────────────────────
echo "📦 Starting the API server (port 3000)..."
( cd "$ROOT/server" && NODE_ENV=development bun --watch index.ts ) &
API_PID=$!

# ── The web client ────────────────────────────────────────────────────────────
echo "🖥️  Starting the web client (port 5173)..."
( cd "$ROOT/client" && bun run dev ) &
WEB_PID=$!

echo ""
echo "✅ Everything is up!"
echo "   API   → http://localhost:3000"
echo "   Web   → http://localhost:5173  (and http://app.zknotes.localhost:5173)"
echo "   Press Ctrl+C to stop."
echo "------------------------------------------------"

wait $API_PID $WEB_PID
