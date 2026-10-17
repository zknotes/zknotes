#!/usr/bin/env bash
# Sets up and starts a ZKnotes instance with one command, from a fresh clone:
#
#   cd zknotes/docker && ./setup.sh
#
# It asks for the vault's domain and does the rest: writes docker/.env (generating every secret, and
# never overwriting a value that is already there), sets up the built-in object storage (or takes
# your own S3 provider), checks that rootless Docker passes the visitors' addresses through and
# offers to fix it, builds the images, starts the stack and waits until the API answers.
#
# Run it again at any time — to change the domain, or after `git pull` to rebuild: it keeps what
# docker/.env already holds. Without a terminal, give it everything it would ask:
#
#   ./setup.sh --domain notes.example.com [--storage builtin|external] [--storage-domain s3.…] [--yes]
#
# --yes also agrees to changing Docker's settings when rootless Docker needs it (it restarts Docker).
# --no-start writes docker/.env and the storage site without building or starting anything.
#
# Needs bash, docker (with Compose v2), curl, and openssl or /dev/urandom. docker/README.md explains
# every step it takes, for a manual setup.

set -euo pipefail

SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${SETUP_DIR}/.env}"
ENV_EXAMPLE="${ENV_EXAMPLE:-${SETUP_DIR}/../server/.env.example}"
SITES_DIR="${SITES_DIR:-${SETUP_DIR}/sites}"

# ── Helpers (scripts/setup.test.ts sources this file and calls them directly) ────────────────────

say() { printf '%s\n' "$*"; }
step() { printf '\n▶ %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die() {
    printf '✗ %s\n' "$*" >&2
    exit 1
}

# N random bytes as hex.
random_hex() {
    local n="$1"
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$n"
    else
        od -An -tx1 -N"$n" /dev/urandom | tr -d ' \n'
    fi
}

# The value of the first uncommented KEY= line in the env file, or nothing.
env_get() {
    local key="$1"
    [[ -f "$ENV_FILE" ]] || return 0
    { grep -E "^${key}=" "$ENV_FILE" || true; } | head -n 1 | cut -d= -f2-
}

# A value that still has to be replaced: empty, the example file's placeholder, or a development value.
is_placeholder() {
    local v="$1"
    [[ -z "$v" || "$v" == REPLACE_WITH* || "$v" == minioadmin* || "$v" == *localhost* ]]
}

# Sets KEY=VALUE: replaces the first uncommented KEY= line, else uncomments the first "# KEY=" line,
# else appends. Everything else in the file stays as it is.
env_set() {
    local key="$1" value="$2" tmp
    tmp="$(mktemp)"
    if grep -qE "^${key}=" "$ENV_FILE"; then
        K="$key" V="$value" awk '!done && index($0, ENVIRON["K"] "=") == 1 { print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next } { print }' "$ENV_FILE" >"$tmp"
    elif grep -qE "^#[[:space:]]*${key}=" "$ENV_FILE"; then
        K="$key" V="$value" awk '!done && $0 ~ "^#[[:space:]]*" ENVIRON["K"] "=" { print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next } { print }' "$ENV_FILE" >"$tmp"
    else
        cp "$ENV_FILE" "$tmp"
        printf '%s=%s\n' "$key" "$value" >>"$tmp"
    fi
    cat "$tmp" >"$ENV_FILE"
    rm -f "$tmp"
}

# Sets KEY only while it holds no real value yet — the rule for every secret: KDF_FAKE_SEED must never
# change, and a new database password would lock the API out of the existing database.
env_ensure() {
    local key="$1" value="$2"
    if is_placeholder "$(env_get "$key")"; then env_set "$key" "$value"; fi
}

valid_domain() {
    [[ "$1" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9-]{2,63}$ ]]
}

# "major.minor.patch" → 0 when $1 >= $2.
version_ge() {
    [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" == "$2" ]]
}

# What rootless Docker needs so the API sees each visitor's own address (Docker's rootless
# troubleshooting guide). Arguments: RootlessKit version, port driver, whether userland-proxy is
# already off (1/0), Docker's major version, whether pasta and slirp4netns are installed (1/0),
# whether the br_netfilter kernel module is loaded (1/0).
# Prints one of: ok, br-netfilter, userland-proxy, pasta, slirp4netns, manual.
rootless_fix_plan() {
    local rk="$1" port_driver="$2" proxy_off="$3" docker_major="$4" has_pasta="$5" has_slirp="$6"
    local has_brnf="$7"
    case "$port_driver" in
        slirp4netns | implicit) echo ok; return ;;
    esac
    if [[ -n "$rk" ]] && version_ge "$rk" "3.0.0"; then
        # Without br_netfilter, dockerd refuses userland-proxy: false and then does not start at all.
        if [[ "$proxy_off" == 1 ]]; then
            echo ok
        elif [[ "$has_brnf" == 1 ]]; then
            echo userland-proxy
        else
            echo br-netfilter
        fi
        return
    fi
    if [[ "$docker_major" -ge 25 && "$has_pasta" == 1 ]]; then
        echo pasta
    elif [[ "$has_slirp" == 1 ]]; then
        echo slirp4netns
    else
        echo manual
    fi
}

# Waits up to 30 seconds for the Docker daemon to answer.
docker_ready() {
    local _
    for _ in $(seq 1 30); do
        docker info >/dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}

# Restarts rootless Docker after setup.sh wrote the file $1. If Docker does not come back, the file
# is removed and Docker restarted as it was, so a refused setting never leaves the server without
# Docker. Returns 0 when the change took effect, 1 when it was taken back.
restart_docker_or_undo() {
    local written="$1"
    say "  Restarting Docker…"
    if systemctl --user restart docker && docker_ready; then
        return 0
    fi
    warn "Docker did not start with the change, so setup.sh is taking it back out (journalctl --user -u docker says why)."
    rm -f "$written"
    systemctl --user daemon-reload
    systemctl --user reset-failed docker 2>/dev/null || true
    systemctl --user restart docker || true
    docker_ready || die "Docker does not start any more — see: journalctl --user -u docker"
    warn "Docker runs as before, and visitors still share one address. docker/README.md, \"Security checklist\", explains the fix."
    warn "If containers then stop with \"network … does not exist\": docker compose down && docker compose up -d (never down -v)."
    return 1
}

# The Caddy site that publishes the built-in storage on STORAGE_DOMAIN.
write_storage_site() {
    mkdir -p "$SITES_DIR"
    cat >"${SITES_DIR}/storage.caddy" <<'EOF'
# Written by setup.sh: the built-in object storage (Garage) on its own domain. Browsers upload to it
# directly, so it is S3_ENDPOINT in docker/.env. Delete this file to stop serving it.
{$STORAGE_DOMAIN} {
    reverse_proxy garage:3900
    log {
        level INFO
    }
}
EOF
}

ask() {
    local prompt="$1" default="${2:-}" answer
    if [[ -n "$default" ]]; then prompt="${prompt} [${default}]"; fi
    read -r -p "${prompt}: " answer </dev/tty || true
    printf '%s' "${answer:-$default}"
}

ask_secret() {
    local answer
    read -r -s -p "$1: " answer </dev/tty || true
    printf '\n' >/dev/tty
    printf '%s' "$answer"
}

confirm() {
    local answer
    if [[ "$ASSUME_YES" == 1 ]]; then return 0; fi
    if [[ "$INTERACTIVE" != 1 ]]; then return 1; fi
    read -r -p "$1 [y/N]: " answer </dev/tty || true
    [[ "$answer" =~ ^[Yy] ]]
}

# ── The steps ─────────────────────────────────────────────────────────────────────────────────────

check_prerequisites() {
    step "Checking Docker"
    command -v docker >/dev/null 2>&1 || die "Docker is not installed (https://docs.docker.com/engine/install/)."
    docker info >/dev/null 2>&1 || die "Docker is installed but not reachable — is the daemon running, and may this user use it?"
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' plugin)."
    command -v curl >/dev/null 2>&1 || die "curl is missing."
    say "  Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), $(docker compose version --short 2>/dev/null)"
}

prepare_env_file() {
    if [[ ! -f "$ENV_FILE" ]]; then
        [[ -f "$ENV_EXAMPLE" ]] || die "Cannot find $ENV_EXAMPLE to start docker/.env from."
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        say "  Created docker/.env from server/.env.example"
    fi
    chmod 600 "$ENV_FILE"
}

choose_domain() {
    step "Domain"
    local current
    current="$(env_get APP_DOMAIN)"
    if [[ -z "$DOMAIN" ]]; then
        if [[ "$INTERACTIVE" == 1 ]]; then
            DOMAIN="$(ask "The vault's domain, pointing at this server (e.g. notes.example.com)" "${current}")"
        else
            DOMAIN="$current"
        fi
    fi
    valid_domain "$DOMAIN" || die "\"${DOMAIN}\" is not a domain name. Pass --domain notes.example.com."
    env_set APP_DOMAIN "$DOMAIN"
    env_set CORS_ORIGIN "https://${DOMAIN}"
    say "  https://${DOMAIN}"
}

choose_storage() {
    step "File storage"
    if [[ -z "$STORAGE" ]]; then
        if [[ "$INTERACTIVE" == 1 ]]; then
            say "  builtin  — stored on this server, on its own domain (s3.${DOMAIN} unless you choose another)"
            say "  external — your own S3-compatible provider (AWS S3, R2, Hetzner, …)"
            STORAGE="$(ask "Storage" "builtin")"
        else
            STORAGE=builtin
        fi
    fi
    case "$STORAGE" in
        builtin) setup_builtin_storage ;;
        external) setup_external_storage ;;
        *) die "--storage is builtin or external, not \"${STORAGE}\"." ;;
    esac
}

setup_builtin_storage() {
    if [[ -z "$STORAGE_DOMAIN_ARG" ]]; then
        STORAGE_DOMAIN_ARG="s3.${DOMAIN}"
        if [[ "$INTERACTIVE" == 1 ]]; then
            STORAGE_DOMAIN_ARG="$(ask "The storage's domain, also pointing at this server" "$STORAGE_DOMAIN_ARG")"
        fi
    fi
    valid_domain "$STORAGE_DOMAIN_ARG" || die "\"${STORAGE_DOMAIN_ARG}\" is not a domain name."
    [[ "$STORAGE_DOMAIN_ARG" != "$DOMAIN" ]] || die "The storage needs a domain of its own, not the vault's."
    env_set COMPOSE_PROFILES storage
    env_set STORAGE_DOMAIN "$STORAGE_DOMAIN_ARG"
    env_set S3_ENDPOINT "https://${STORAGE_DOMAIN_ARG}"
    env_set S3_REGION us-east-1
    env_ensure S3_BUCKET zknotes
    env_ensure S3_ACCESS_KEY "GK$(random_hex 12)"
    env_ensure S3_SECRET_KEY "$(random_hex 32)"
    env_ensure GARAGE_RPC_SECRET "$(random_hex 32)"
    write_storage_site
    say "  Built-in storage at https://${STORAGE_DOMAIN_ARG}"
}

setup_external_storage() {
    env_set COMPOSE_PROFILES ""
    rm -f "${SITES_DIR}/storage.caddy"
    local key prompt value
    for key in S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY; do
        value="$(env_get "$key")"
        if is_placeholder "$value" && [[ "$INTERACTIVE" == 1 ]]; then
            prompt="$key"
            [[ "$key" == S3_ENDPOINT ]] && prompt="S3_ENDPOINT (the provider's https:// address, as browsers reach it)"
            if [[ "$key" == S3_SECRET_KEY ]]; then value="$(ask_secret "$prompt")"; else value="$(ask "$prompt")"; fi
            env_set "$key" "$value"
        fi
        is_placeholder "$(env_get "$key")" && die "$key is not set — put it in docker/.env or run setup.sh in a terminal."
    done
    [[ "$(env_get S3_ENDPOINT)" == https://* ]] || die "S3_ENDPOINT has to be an https:// address browsers can reach."
    say "  External storage at $(env_get S3_ENDPOINT) — remember its bucket must be private, with a CORS rule for https://${DOMAIN} (docker/README.md, \"Object storage\")."
}

generate_secrets() {
    step "Secrets"
    env_ensure POSTGRES_PASSWORD "$(random_hex 32)"
    env_ensure COOKIE_SECRET "$(random_hex 32)"
    env_ensure KDF_FAKE_SEED "$(random_hex 32)"
    say "  Every secret is set in docker/.env — keep a copy of that file with your backups."
}

check_rootless() {
    docker info --format '{{join .SecurityOptions ","}}' 2>/dev/null | grep -q rootless || return 0
    step "Rootless Docker"

    # Ports below 1024 need a kernel setting under rootless Docker.
    local start
    start="$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)"
    if [[ "$start" -gt 80 ]]; then
        warn "Rootless Docker cannot listen on ports 80 and 443 yet. Run once, as root:"
        warn "  echo 'net.ipv4.ip_unprivileged_port_start=80' | sudo tee /etc/sysctl.d/99-zknotes.conf && sudo sysctl --system"
        die "Then run setup.sh again."
    fi

    local rk port_driver proxy_off docker_major has_pasta has_slirp has_brnf plan daemon_json override
    local env_line written
    rk="$(rootlesskit --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
    env_line="$(systemctl --user show docker -p Environment 2>/dev/null || true)"
    port_driver="$(grep -oE 'DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=[^ ]+' <<<"$env_line" | cut -d= -f2 || true)"
    port_driver="${port_driver:-builtin}"
    daemon_json="${HOME}/.config/docker/daemon.json"
    proxy_off=0
    if [[ -f "$daemon_json" ]] && grep -qE '"userland-proxy"[[:space:]]*:[[:space:]]*false' "$daemon_json"; then proxy_off=1; fi
    docker_major="$(docker version --format '{{.Server.Version}}' 2>/dev/null | cut -d. -f1)"
    has_pasta=0
    command -v pasta >/dev/null 2>&1 && has_pasta=1
    has_slirp=0
    command -v slirp4netns >/dev/null 2>&1 && has_slirp=1
    # What dockerd itself checks before it runs without the userland proxy.
    has_brnf=0
    [[ -e /proc/sys/net/bridge/bridge-nf-call-iptables ]] && has_brnf=1
    plan="$(rootless_fix_plan "$rk" "$port_driver" "$proxy_off" "${docker_major:-0}" "$has_pasta" "$has_slirp" "$has_brnf")"
    say "  RootlessKit ${rk:-unknown}, port driver ${port_driver}"

    if [[ "$plan" == ok ]]; then
        say "  Visitors' addresses reach the API."
        return 0
    fi
    say "  As it is set up now, rootless Docker hands every visitor to the API under one internal"
    say "  address, so every per-address limit — the sign-in pause among them — would be shared by all."
    override="${HOME}/.config/systemd/user/docker.service.d/override.conf"
    case "$plan" in
        br-netfilter)
            warn "The fix needs the br_netfilter kernel module first; without it Docker would not start. Run once, as root:"
            warn "  echo br_netfilter | sudo tee /etc/modules-load.d/docker.conf && sudo modprobe br_netfilter"
            warn "Then run setup.sh again to finish."
            return 0
            ;;
        userland-proxy)
            if [[ -f "$daemon_json" ]]; then
                warn "Add \"userland-proxy\": false to ${daemon_json}, then: systemctl --user restart docker"
                return 0
            fi
            confirm "Turn off Docker's userland-proxy (writes ${daemon_json} and restarts Docker)?" || {
                warn "Not changed. docker/README.md, \"Security checklist\", explains the fix."
                return 0
            }
            mkdir -p "$(dirname "$daemon_json")"
            printf '{\n  "userland-proxy": false\n}\n' >"$daemon_json"
            written="$daemon_json"
            ;;
        pasta | slirp4netns)
            if [[ -f "$override" ]]; then
                warn "Set the ${plan} network and port driver in ${override}, then restart Docker (docker/README.md)."
                return 0
            fi
            confirm "Switch rootless Docker to the ${plan} network driver (writes ${override} and restarts Docker)?" || {
                warn "Not changed. docker/README.md, \"Security checklist\", explains the fix."
                return 0
            }
            mkdir -p "$(dirname "$override")"
            if [[ "$plan" == pasta ]]; then
                printf '[Service]\nEnvironment="DOCKERD_ROOTLESS_ROOTLESSKIT_NET=pasta"\nEnvironment="DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=implicit"\n' >"$override"
            else
                printf '[Service]\nEnvironment="DOCKERD_ROOTLESS_ROOTLESSKIT_NET=slirp4netns"\nEnvironment="DOCKERD_ROOTLESS_ROOTLESSKIT_PORT_DRIVER=slirp4netns"\n' >"$override"
            fi
            written="$override"
            systemctl --user daemon-reload
            ;;
        manual)
            warn "Install pasta (Docker 25+) or slirp4netns, then run setup.sh again — or see docker/README.md."
            return 0
            ;;
    esac
    restart_docker_or_undo "$written" || return 0
    if [[ "$plan" == userland-proxy ]]; then
        say "  Done."
    else
        say "  Done. If the API still sees one address, load the br_netfilter kernel module (docker/README.md)."
    fi
}

check_dns() {
    local name
    for name in "$DOMAIN" ${STORAGE_DOMAIN_ARG:+"$STORAGE_DOMAIN_ARG"}; do
        if ! getent ahosts "$name" >/dev/null 2>&1; then
            warn "${name} does not resolve yet. Point it at this server (A and AAAA records): Caddy needs it to get a certificate."
        fi
    done
}

start_stack() {
    step "Building and starting (the first build takes a few minutes)"
    local commit
    commit="$(git -C "$SETUP_DIR/.." rev-parse --short HEAD 2>/dev/null || echo dev)"
    (cd "$SETUP_DIR" && APP_COMMIT="$commit" docker compose build && docker compose up -d)
    say "  Waiting for the API…"
    for _ in $(seq 1 120); do
        if curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
            say "  The API is up."
            return 0
        fi
        sleep 1
    done
    die "The API did not come up in two minutes — see: docker compose logs api"
}

print_next_steps() {
    say ""
    say "✔ ZKnotes is set up."
    say ""
    say "  1. DNS: ${DOMAIN}${STORAGE_DOMAIN_ARG:+ and ${STORAGE_DOMAIN_ARG}} must point at this server."
    say "  2. Open https://${DOMAIN}/create-vault now and create your vault. Until a vault exists, anyone"
    say "     who finds the address can create the first one."
    say "  3. Backups: docker/README.md, §4 — and keep a copy of docker/.env with them."
    say ""
}

main() {
    DOMAIN=""
    STORAGE=""
    STORAGE_DOMAIN_ARG=""
    ASSUME_YES=0
    START=1
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --domain) DOMAIN="${2:-}"; shift 2 ;;
            --storage) STORAGE="${2:-}"; shift 2 ;;
            --storage-domain) STORAGE_DOMAIN_ARG="${2:-}"; shift 2 ;;
            --yes | -y) ASSUME_YES=1; shift ;;
            --no-start) START=0; shift ;;
            -h | --help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
            *) die "Unknown option: $1 (see ./setup.sh --help)" ;;
        esac
    done
    INTERACTIVE=0
    if [[ -t 0 && -r /dev/tty ]]; then INTERACTIVE=1; fi

    say "ZKnotes setup"
    if [[ "$START" == 1 ]]; then check_prerequisites; fi
    prepare_env_file
    choose_domain
    choose_storage
    generate_secrets
    if [[ "$START" == 1 ]]; then
        check_rootless
        check_dns
        start_stack
        print_next_steps
    else
        say ""
        say "✔ docker/.env is written; start with: docker compose build && docker compose up -d"
    fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    main "$@"
fi
