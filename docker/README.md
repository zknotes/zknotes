# ZKnotes — Production Deployment

Single-server setup: **Bun API + PostgreSQL + Caddy + Docker Compose**, with file contents in
S3-compatible object storage — built in, or your own provider. A small VPS with 2 vCPU / 4 GB RAM is
enough for a personal or small-team instance.

## Quick start

On a server with Docker, and two DNS names pointing at it — the vault (`notes.example.com`) and its
file storage (`s3.notes.example.com`):

```bash
git clone https://github.com/zknotes/zknotes.git
cd zknotes/docker
./setup.sh
```

It asks for the domain and does the rest: writes `docker/.env` with freshly generated secrets, sets
up the built-in file storage on `s3.<domain>`, checks that rootless Docker lets the API see visitors'
addresses (and offers the fix), builds, starts, and tells you to open `https://<domain>/create-vault`
— do that right away. Run it again whenever you like: it never overwrites a value `docker/.env`
already holds. `./setup.sh --help` lists the options for running it without questions, or with your
own S3 provider (`--storage external`).

The rest of this guide is what `setup.sh` does, step by step — for a manual setup, another proxy, or
your own storage — and how to run the instance afterwards: updates (§3), backups (§4), monitoring (§5)
and the checklist before going live (§6).

---

## Prerequisites

- Server with Docker + Docker Compose v2 installed
  - **If Docker is installed rootless** (`dockerd-rootless-setuptool.sh`, i.e. `docker.service` is a
    `systemctl --user` unit, not a system service): run `sudo loginctl enable-linger <user>` once. Without
    linger, systemd tears down the whole `user@<uid>.service` manager — and therefore rootless dockerd and
    every container, cleanly, `ExitCode=0` — the moment the last SSH session for that user closes. The
    stack silently stays down until someone logs back in; `restart: unless-stopped` on the compose services
    doesn't help because dockerd itself isn't running to restart them. Verify with
    `loginctl show-user <user> | grep Linger` (expect `Linger=yes`).
- One domain name pointing at the server IP — the vault origin, e.g. `notes.example.com`. SPA **and**
  API are served from it: Caddy routes the API path prefixes to the `api` container and everything
  else to the `web` container, the same model as the Vite dev proxy.
- File storage: the built-in one needs a second domain name pointing at the server (e.g.
  `s3.notes.example.com`); or an S3-compatible bucket of your own (see [Object storage](#object-storage)).
- **Rootless Docker** also needs, once, as root: `net.ipv4.ip_unprivileged_port_start=80` (so Caddy
  can listen on 80 and 443), and on RootlessKit 3 or newer the `br_netfilter` kernel module (so
  Docker can run without its userland proxy and pass visitors' addresses through) — `setup.sh`
  checks both and prints the commands.

---

## 1. Clone and configure (what `setup.sh` does)

```bash
git clone https://github.com/zknotes/zknotes.git
cd zknotes/docker
cp ../server/.env.example .env
```

This stack reads **`docker/.env`** — both as the API's environment (`env_file: .env`) and for the
`${…}` substitutions in `docker-compose.yml`. `server/.env` is only for local development and is not
read here.

Edit `.env` and set at least:

| Key | Value |
|---|---|
| `POSTGRES_PASSWORD` | `openssl rand -hex 32`. Compose passes it to the `db` service and builds the API's `DATABASE_URL` from it. |
| `COOKIE_SECRET` | `openssl rand -hex 32` |
| `KDF_FAKE_SEED` | `openssl rand -hex 32` — generate it **once** and never change it. |
| `APP_DOMAIN` | Your vault domain, e.g. `notes.example.com`. Caddy serves it and obtains its certificate. |
| `CORS_ORIGIN` | `https://notes.example.com` (the same domain, with the scheme). |
| `S3_ENDPOINT` | The **public `https://` address** of your object storage, e.g. `https://s3.example.com` — the browser uploads to it directly. Never a Docker service name or `localhost` (see [Object storage](#object-storage)). |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | From your storage provider. |
| `SOURCE_URL` | Where the source of what this instance serves can be fetched. The example file sets it to `https://github.com/zknotes/zknotes`, which is right only while you run the code unmodified. If you change the client or the server, publish your version and put its address here (AGPL-3.0 §13). The app links to it from the sign-in, account-creation and shared-note pages and from Settings → About. |
| `VERIFY_URL` | Optional. A page that tells your users how to check that this instance serves the published code (`../docs/verifying-the-build.md` explains the check). When set, Settings → About shows a *Verify this build* link next to the commit; unset, no link. Like every link here it is used as scheme, host and path; a query string or fragment is dropped. |

Leave `DATABASE_URL` and `NODE_ENV` as they are: `docker-compose.yml` sets both for the API container
(`DATABASE_URL=postgresql://zknotes:${POSTGRES_PASSWORD}@db:5432/zknotes`, `NODE_ENV=production`),
and those values override whatever `.env` holds. The API refuses to start in production while
`COOKIE_SECRET` or `KDF_FAKE_SEED` still holds the `REPLACE_WITH_…` placeholder, or while the `S3_*`
values are still the development ones.

Both `Caddyfile` and `docker-compose.yml` take the domain from `APP_DOMAIN`, so deploying under a
different domain means editing one line in `.env` and nothing else.

### Object storage

File uploads require **S3-compatible object storage**.

**The built-in storage** is a single [Garage](https://garagehq.deuxfleurs.fr/) node in this compose
file, started by the `storage` profile. `setup.sh` turns it on; by hand it is:

- in `.env`: `COMPOSE_PROFILES=storage`, `STORAGE_DOMAIN=s3.notes.example.com`,
  `S3_ENDPOINT=https://s3.notes.example.com`, `S3_REGION=us-east-1`, `S3_BUCKET=zknotes`, and freshly
  generated `S3_ACCESS_KEY` (`GK` + 24 hex characters), `S3_SECRET_KEY` (64 hex) and
  `GARAGE_RPC_SECRET` (64 hex);
- a Caddy site for the storage domain in `docker/sites/storage.caddy` (`setup.sh` writes it; see
  `docker/sites/README.md`).

Garage creates the bucket and the key on start, `garage_init` gives the bucket its CORS rule for
your vault's origin, and Caddy serves it on its own domain with its own certificate — browsers
upload to it directly, so it cannot share the vault's address. The files live in the `garage_data`
volume (back it up with the database, §4).

**Your own provider** works too — AWS S3, Cloudflare R2, Hetzner Object Storage, MinIO, or a Garage
elsewhere. The browser uploads and downloads the encrypted chunks
directly, through presigned URLs the API signs for `S3_ENDPOINT`, so before the first start:

- **Create the bucket, and keep it private** — no public read and no public listing. Every access
  goes through a presigned URL; a public bucket would hand anyone the ciphertext of every account
  and the layout of its objects. In production the API does not create the bucket for you.
- **Give the bucket a CORS rule** that allows your app origin (`https://notes.example.com`) to `GET`
  and `PUT` with any request header. Without it, uploads fail the browser's CORS preflight.
  `../garage-cors.dev.json` is the development rule; in production name your origin instead of `*`.
- **Set `S3_ENDPOINT` to the address browsers use**: a public `https://` origin they can reach,
  even for AWS S3 (`https://s3.<region>.amazonaws.com`). The presigned URLs are built from it, and
  the web container adds it to the Content-Security-Policy `connect-src`. An internal address — a
  Docker service name such as `http://garage:3900`, or `localhost` — lets the API start and then
  fails every upload in the browser, so in production the API refuses to start with a loopback or a
  plain `http://` endpoint.
- **Give the API a key limited to that bucket.** It needs `s3:GetObject`, `s3:PutObject`,
  `s3:DeleteObject` and `s3:ListBucket` on the bucket and nothing else (`s3:CreateBucket` only if
  you set `S3_AUTO_CREATE_BUCKET=1`). The key's id is part of every presigned URL a browser sees.

Without `COMPOSE_PROFILES=storage` the compose file starts no storage of its own.

### Storage quota and disk

`SELF_HOST_STORAGE_QUOTA` is what each **new** account gets (default 100 GiB), and it counts the
encrypted size of everything the account keeps: the file chunks in the bucket, trashed files
included, and its notes and note history in PostgreSQL. It is enforced with headroom — a save or
upload is refused only once it would take the account past **1.2 ×** its quota, and the files a
restore from backup stages may take it to **2 ×** until the restore finishes. Size the storage
behind `S3_BUCKET` for at least twice the sum of the quotas you give out, and leave the database
volume room for the notes; a full disk under MinIO or Garage on the same server takes the instance
down with it.

---

## 2. First deploy

```bash
# Build images (takes ~2 min on first run). The two variables make the web build reproducible —
# see "Reproducing the web build" below; /health and Settings → About show the commit next to the
# version, which comes from package.json.
export APP_COMMIT=$(git rev-parse HEAD) SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)
docker compose build

# Start all services. Caddy will obtain TLS certificates on first request.
docker compose up -d

# Tail logs to confirm startup.
docker compose logs -f
```

Expected startup sequence:
1. `db` container initialises PostgreSQL (healthy check passes)
2. `api` container runs `migrate.ts` — applies Drizzle migrations automatically
3. API starts on port 3000
4. Caddy obtains Let's Encrypt certificates and starts proxying

### Create the first vault

There is no admin account to log in with and no password in any config file: the master password
never leaves the browser, so the server cannot create an account for you. You create it yourself,
once, from the browser:

> **https://notes.example.com/create-vault**

While the database holds no user that page is open to anyone who can reach the instance, so do
this immediately after the first deploy. Keeping the address to yourself is not enough: the moment
Caddy obtains its certificate, the domain appears in the public Certificate Transparency logs, which
bots watch. The moment the first vault exists the route closes (`403 registration_closed`) and the
login page stops offering "Create one".

If `/create-vault` already says registration is closed and you did not create a vault, someone else
did. Nobody's data is at risk yet, but their account lives on your server: start over with an empty
database (`docker compose down -v` deletes the volumes, then `docker compose up -d`).

For more accounts afterwards (family, a team), set `SELF_HOST_REGISTRATION_OPEN=true` in
`docker/.env` and run `docker compose up -d` (a plain `docker compose restart` does not re-read
`.env`); unset it again the same way when everyone is in.

**Write the password down somewhere safe before you type it.** It is the only thing that decrypts
your notes — nobody, including you with database access, can recover the data without it.

---

## 3. Updating

`git pull && ./setup.sh` rebuilds and restarts, keeping everything in `docker/.env`. By hand:

```bash
git pull
export APP_COMMIT=$(git rev-parse HEAD) SOURCE_DATE_EPOCH=$(git show -s --format=%ct HEAD)
docker compose build
docker compose up -d   # migrations run automatically on next API startup
```

The API applies Drizzle migrations on startup, so no separate step is needed. Check the result with
`docker compose logs -f api`.

If the API keeps restarting with `relation "…" already exists` from `migrate.ts`, the database
already has tables but no migration journal (the `drizzle.__drizzle_migrations` table) that records
them — typically a dump restored without the `drizzle` schema, or tables created by hand. Restore a
dump of the whole database instead (the `pg_dump` in §4 includes the journal). Do not insert journal
rows by hand: a database whose schema is older than the journal claims would then skip migrations it
still needs.

### Reproducing the web build

The web image builds reproducibly: the same commit with the same two inputs gives a byte-identical
web root, so anyone can check that your instance serves the client this repository contains. What
that check is, what it proves and what it does not is in
[`../docs/verifying-the-build.md`](../docs/verifying-the-build.md); this section is only what you, as
the operator, do about it.

- Build with both inputs, as the commands above do: `APP_COMMIT` must be the **full** hash (a short
  one's length depends on the clone, and the value ends up in the bundle), `SOURCE_DATE_EPOCH` the
  commit's timestamp. `setup.sh` sets both. Leave them unset and the image still builds, from the
  clock — but then nobody, you included, can reproduce it, and `scripts/verify-live.sh` reports the
  instance as unverifiable.
- To print the hash of what your running image serves (the **treeHash**, the same number CI
  publishes for the commit):

  ```bash
  docker compose run --rm --no-deps -T --entrypoint sh web -s /usr/share/nginx/html < ../scripts/tree-hash.sh
  ```

- To check your own instance from the outside, as a user would: `scripts/verify-live.sh
  https://notes.example.com` from the repository root.
- `VERIFY_URL` (§1) puts a *Verify this build* link into Settings → About.

---

## 4. Backup & restore

PostgreSQL data lives in the `zknotes_pgdata` Docker volume. File contents live in the object storage
bucket — with the built-in storage, the `zknotes_garage_data` volume (copy it while the stack is
stopped, or sync the bucket with an S3 tool such as `rclone sync`); with your own provider, back it
up with the provider's tools (versioning, or `rclone sync`).

A backup is three things taken together:

- **the database dump** below;
- **the bucket, copied right after the dump.** The two must match: the weekly repair job deletes
  objects the database does not know and forgets objects the bucket does not have, so a bucket older
  than the dump means attachments that no longer open;
- **`docker/.env`.** `KDF_FAKE_SEED` must never change, and the passwords and keys in it are what the
  restored stack needs to reach its data. Keep it as safe as the dump: it holds secrets.

### Manual backup (pg_dump)

```bash
# Dump to a compressed SQL file. --clean --if-exists lets the same dump also load over a database
# that already has the schema.
docker compose exec -T db pg_dump -U zknotes --clean --if-exists zknotes | gzip > backup_$(date +%Y%m%d).sql.gz
```

### Restore

Load the dump into a new database next to the current one, in a single transaction, and swap the
two only once it has loaded. If anything fails on the way — a truncated file, a full disk — the
current database has not changed.

```bash
docker compose stop api
docker compose exec -T db createdb -U zknotes zknotes_restore
gunzip -c backup_20250101.sql.gz | docker compose exec -T db psql -1 -v ON_ERROR_STOP=1 -U zknotes zknotes_restore
docker compose exec -T db psql -U zknotes -d postgres \
  -c "ALTER DATABASE zknotes RENAME TO zknotes_old" \
  -c "ALTER DATABASE zknotes_restore RENAME TO zknotes"
docker compose start api
```

If the load fails, drop the half-made copy (`docker compose exec -T db dropdb -U zknotes
zknotes_restore`) and start the API again: nothing else changed. Once the restored instance works,
drop the old data with `docker compose exec -T db dropdb -U zknotes zknotes_old`. A dump taken by an
older version of ZKnotes restores the same way; the API applies the newer migrations when it
starts. Loading a dump straight into the live database is what this avoids: a dump from before a
migration cannot drop tables that a newer table now references, and without a single transaction
the half that ran stays.

**Upgrading PostgreSQL to a new major version** goes the same way. The image pins PostgreSQL 18, and a
new major version cannot open the old one's data directory: take a dump, start the new version on a
new, empty volume, and restore the dump into it. Changing the image tag over the existing volume
does not work.

### Other automated backup options

- **Managed PostgreSQL** — offload backups to the provider. Point the `DATABASE_URL` in the `api`
  service of `docker-compose.yml` at the managed instance (that value overrides `.env`), and remove
  the `db` service and the `api` service's `depends_on` on it.
- **pgBackRest / barman** — continuous WAL archiving, point-in-time recovery.

---

## 5. Monitoring

### `/health` endpoint

The API exposes a public `GET /health` endpoint (no auth, no PII), reachable through the
app domain (Caddy routes `/health` to the api container):

```
GET https://notes.example.com/health

200 OK
{
  "status": "ok",
  "uptime_seconds": 86400,
  "version": "0.2.0",
  "commit": "abc1234"
}
```

Returns `503` with `{"status":"error","detail":"db_unreachable"}` if the database is unreachable.
It is rate-limited per IP (`HEALTH_RATELIMIT_*`) and caches the database probe for a few seconds
(`HEALTH_DB_CACHE_MS`). Used by the Docker healthcheck; point an external uptime monitor at it too
(an HTTP(s) check every few minutes, with an alert contact).

### Usage analytics

The API keeps usage counts for you as the operator: which accounts were active on which day (an
account id per day, kept 38 days), and daily totals of requests per route, sign-ins, registrations
and storage use (kept two years). No note content, IP address or user agent goes into them. Set
`ANALYTICS_DISABLED=1` in `.env` to stop collecting; what was collected before still expires on
schedule. The tables and settings are listed under "Server-side analytics" in
`server/.env.example`.

### Local status

```bash
docker compose ps
docker compose logs api --tail=100 -f
docker compose exec db psql -U zknotes -c "SELECT count(*) FROM users;"
```

---

## 5b. Public share routes (`/s/*`)

Recipient share pages are served by the SPA at `/s/:id` (no login). They need two response headers:

- `Referrer-Policy: no-referrer` — avoids leaking the share URL via `Referer`
- `X-Robots-Tag: noindex` — shared links must not be indexed

The bundled `Caddyfile` sends both. The web container itself sends `Referrer-Policy: no-referrer`
on every page, because the address of an app page names the open note. If you put a different
proxy in front of it, replicate the two share headers — and make the proxy **replace** any
`Referrer-Policy` it receives rather than add a second one: with two, the browser applies the
last. In Caddy the `>` prefix does that:

```
@share path /s /s/*
header @share >Referrer-Policy "no-referrer"
header @share >X-Robots-Tag "noindex"
```

`../scripts/smoke-headers.sh https://your-domain` checks that every page sends `no-referrer` and
that a share page gets exactly one.

The API JSON routes (`GET/POST /shares/:id`) are separate; rate limits are configured via `SHARE_*` env vars in `server/.env.example`.

---

## 6. Security checklist before going live

- [ ] `KDF_FAKE_SEED` generated with `openssl rand -hex 32` and kept somewhere safe — it must never change
- [ ] `COOKIE_SECRET` generated with `openssl rand -hex 32`
- [ ] Caddy sees real client addresses (`setup.sh` checks rootless Docker, and the API warns in its
      log when every visitor arrives from one private address): after visiting the site from your own connection, the
      `remote_ip` in `docker compose logs caddy` is your public IPv4 or IPv6 address, not a
      `172.x` Docker address. Rootless Docker does not pass the client address through by default
      (and never for HTTP/3 over UDP), and IPv6 clients of an IPv4-only Docker network arrive from
      the bridge gateway; if every client shares one address, every per-IP limit and the sign-in
      pause become one shared bucket that anyone can exhaust. On RootlessKit 3 or newer the fix is
      `{"userland-proxy": false}` in `~/.config/docker/daemon.json` and `systemctl --user restart
      docker` — but load `br_netfilter` **first**
      (`echo br_netfilter | sudo tee /etc/modules-load.d/docker.conf && sudo modprobe br_netfilter`):
      without it Docker refuses that setting and does not start at all. If a failed restart leaves
      the containers stopped with `network … does not exist`, `docker compose down` and
      `docker compose up -d` recreate the networks (never `down -v`, which deletes the data)
- [ ] Per-IP rate limits see real client addresses: the API trusts `X-Forwarded-For` only from
      `TRUST_PROXY` (compose default: the `edge` subnet, which only Caddy shares with the API). If
      you put another proxy in front, list its address there; anything that reaches `api:3000`
      directly from a trusted address can choose the client address the API records
- [ ] `POSTGRES_PASSWORD` generated with `openssl rand -hex 32`
- [ ] `CORS_ORIGIN` set to exact frontend URL (no wildcard)
- [ ] `S3_*` variables set for your object storage: `S3_ENDPOINT` a public `https://` address, the
      bucket private and given a CORS rule for your origin, the key limited to that bucket
- [ ] `SOURCE_URL` set — and pointing at **your** repository if you changed anything
- [ ] `SELF_HOST_STORAGE_QUOTA` set to what you actually want new accounts to get (default 100 GiB),
      and the storage behind the bucket sized for at least twice the sum of those quotas
      ([Storage quota and disk](#storage-quota-and-disk)). `SELF_HOST_MAX_FILE_SIZE` only if you
      want a per-file ceiling *below* the format's own — the default is 12 GiB, which is as large as
      one file can be, so what really bounds a file is the storage quota and the disk under it
- [ ] First vault created at `/create-vault`, and `SELF_HOST_REGISTRATION_OPEN` left unset — verify
      registration is shut with `curl https://notes.example.com/auth/registration-status`
      (expect `{"open":false}`)
- [ ] Firewall: only SSH, 80 and 443 (TCP, plus UDP for HTTP/3) open; port 3000 and 5432 NOT exposed
      to the internet
- [ ] Security headers confirmed — `../scripts/smoke-headers.sh https://notes.example.com` checks them,
      HSTS included
- [ ] A backup taken — dump, bucket and `docker/.env` — and a restore tested

Verify the values the stack actually uses, not just what is in `server/.env.example` —
`docker compose config` prints the resolved environment for a quick sanity check:

```bash
docker compose config | grep -E "KDF_FAKE_SEED|COOKIE_SECRET|POSTGRES_PASSWORD|APP_DOMAIN|SOURCE_URL|S3_ENDPOINT"
```

---

## 7. What is not here

The hosted instance at [app.zknotes.eu](https://app.zknotes.eu) adds a separate account and
administration layer that is not part of this repository; a self-hosted instance is complete without
it. Deployment automation (CI/CD, off-site backups, rollbacks) is left to the operator — section 3 is
the update path.
