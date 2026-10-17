# ZKnotes

Zero-knowledge, end-to-end encrypted notes app. Notes, titles and files are encrypted on your device;
the server stores the ciphertext plus the structural metadata it needs to sync it, and
[`SECURITY.md`](SECURITY.md) lists what that metadata is.
A hosted instance is available at [zknotes.eu](https://zknotes.eu).

## Documentation

- **Running it** (Docker, environment variables, backups, TLS) → [`docker/README.md`](docker/README.md).
- **Contributing** → [`CONTRIBUTING.md`](CONTRIBUTING.md). **Reporting a vulnerability** → [`SECURITY.md`](SECURITY.md).
- **Bugs and feature requests** → [GitHub issues](https://github.com/zknotes/zknotes/issues).
- **Per-package notes** → [`server/README.md`](server/README.md), [`client/README.md`](client/README.md), [`shared/README.md`](shared/README.md).

## Prerequisites

- [Bun](https://bun.sh) — runtime and package manager (all commands use `bun`, not `npm`/`node`).
  CI and the Docker images use the exact version named by `packageManager` in `package.json`; use
  the same one locally to get the same results.
- [Docker](https://docs.docker.com/get-docker/) + Compose v2 — for the local PostgreSQL databases and
  the S3-compatible object store
- `curl`, `nc` (netcat) and `lsof` — used by `dev.sh` and `test.sh`
  (Debian/Ubuntu: `apt install curl netcat-openbsd lsof`)

## Install

```bash
git clone https://github.com/zknotes/zknotes.git && cd zknotes
bun install
```

---

## Development

### 1. Start local infrastructure

```bash
docker compose up -d          # dev DB :5434, test DB :5433, Garage dev :9000 (+ bucket init), Garage test :9002
```

Garage buckets (`zknotes` / `zknotes-test`) and their CORS rule are set up by `garage_init` / `garage_test_init`.
Without them, file upload PUTs fail with **404 NoSuchBucket** (browser shows “Upload failed: not found”)
or are blocked by the browser's CORS preflight. The API also auto-creates the dev bucket on startup
if it is missing.

### 2. Configure the API

```bash
cp server/.env.example server/.env
# The example .env already points to the dev database (localhost:5434) and the local Garage —
# no changes needed for local dev.
```

In development `COOKIE_SECRET` and `KDF_FAKE_SEED` can stay as they are (unset, they fall back to a
built-in dev default). Production refuses to start while either is unset, still the
`REPLACE_WITH_…` placeholder or the dev default — generate real values with `openssl rand -hex 32`.

### 3. Run

One command from the repo root, which also brings up the database, Garage and migrations:

```bash
./dev.sh          # API on :3000, web client on :5173
./dev.sh stop     # shut both down
```

Or two terminals, if you want them separate:

```bash
# Terminal 1 — migrations, then the API on :3000
# (server/.env says NODE_ENV=production; the variable on the command line wins)
cd server && bunx drizzle-kit migrate && NODE_ENV=development bun --watch index.ts

# Terminal 2 — Web on :5173
cd client && bun run dev
```

### 4. Something to look at (optional)

An empty vault is a poor thing to develop against. This generates one full of realistic notes,
folders, attachments and every editor feature, as an ordinary backup file:

```bash
bun scripts/make-demo-vault.ts        # writes demo-vault.zip
```

Import it in the app under **Settings → Backup & Export → Restore from backup**. Delete the content
whenever you like and import it again; edit `scripts/demo-vault/content.ts` to change what is in it.
Each run uses a new random seed, because an item id is a global primary key — import a given file
into one vault per instance, and pass `--seed <string>` if you need to rebuild the same file.

---

## Tests

Requires the **test DB** and **test Garage** (`db_test` :5433, `garage_test` :9002):

```bash
docker compose up -d db_test garage_test
```

Run all test suites:

```bash
./test.sh
```

Or individually:

```bash
# API tests (bun test — uses PostgreSQL test DB on :5433)
cd server && bun test --preload ./test/setup.ts --sequential

# Shared package tests (vitest — crypto, cycle detection, schemas)
cd shared && bunx vitest run

# Web unit tests (vitest)
cd client && bunx vitest run

# Single test file or test name:
cd server && bun test --preload ./test/setup.ts test/gc.test.ts
cd shared && bunx vitest run src/cryptography.test.ts
cd shared && bunx vitest run -t "decryptPayload"
```

End-to-end tests need a browser build and take longer:

```bash
./test.sh --e2e        # fast smoke
./test.sh --e2e-full   # everything, including the heavy specs — what CI runs
```

---

## Type checking & lint

Does **not** require a running database:

```bash
./check.sh
```

What it does, in order:

1. **Security gate** — fails if a persistent storage API (`sessionStorage`, `localStorage`,
   IndexedDB or the `idb` wrapper, the Cache API, OPFS, cookies) appears inside
   `client/src/lib/core/workers/` or `client/src/lib/core/crypto/` (the OPFS upload-staging worker
   excepted), if the crypto worker or `core/crypto/` imports the app's own storage helpers, or if
   the `vault_key` storage key appears, in any quoting, anywhere in `client/src` or `shared/src`
   outside `core/crypto/session-key.ts` — the one module that keeps the per-tab `sessionStorage` copy
   of the Vault Key, where every line naming it must name `sessionStorage` too
2. **Crypto primitives gate** — fails if the shared encrypt/decrypt/derive primitives are reached
   outside the crypto worker and its two allowlisted callers — through a named import, a namespace
   or star import, a deep or relative path into the package, or a runtime `import()` in any form but
   a destructuring of other exports — if any file, those three included, re-exports one, or if the
   crypto libraries themselves (`@noble/ciphers`, `@noble/hashes`, `hash-wasm`) are imported anywhere
   but the worker; everything else goes through the worker's RPC

   Both gates are text checks: they catch the ordinary ways around the boundary, not a determined
   one (a property name built at runtime, or a wrapper exported under another name, say).
   `scripts/security-gate.test.ts` runs each known bypass through them.
3. **Biome** — formats (`--write`) and lints the whole repo
4. **tsc** — type-checks the server (`server/tsconfig.json`, `--noEmit`)
5. **tsc** — type-checks the shared package
6. **svelte-check** — type-checks the web client
7. **Button UX gate** — no raw `<button>` outside the allowlist
8. **Form UX gate** — every bare `<input>`/`<select>`/`<textarea>` carries its canonical class
9. **Clean build gate** — no private dependency, registry or credential anywhere in the build graph,
   so the repository can be built by anyone who clones it

It **writes** Biome formatting fixes, so run it before committing rather than after. Individual
pieces, when you want to iterate on one:

```bash
bunx tsc --noEmit -p server/tsconfig.json
cd client && bunx svelte-check
bunx biome check .
```

---

## Database migrations (Drizzle)

Migrations are **hand-written SQL**. `server/drizzle/0000_baseline.sql` holds the whole initial
schema; every later change is a migration of its own. Do not use `drizzle-kit generate` (there are no
snapshots in `server/drizzle/meta/`, so it would emit the whole schema again) or `drizzle-kit push`
(it applies schema directly and leaves the journal out of sync with the database).

To add one:

1. Edit `server/src/db/schema.ts`.
2. Write `server/drizzle/00NN_<name>.sql` by hand — house style is `CREATE TABLE IF NOT EXISTS`,
   `--> statement-breakpoint` between statements, quoted `"bytea"`, and
   `bigint` time columns with `(extract(epoch from now()))::bigint` defaults (a 32-bit integer
   overflows in January 2038).
3. Add the entry to `server/drizzle/meta/_journal.json` (`idx`, `version: "7"`, `when`, `tag`,
   `breakpoints: true`). `when` must be later than every earlier entry: the migrator skips any
   migration whose `when` is not newer than the last one the database applied.
4. Apply it:

```bash
cd server && bunx drizzle-kit migrate    # dev DB on localhost:5434
```

Migration files live in `server/drizzle/`. In production they are applied automatically on container
startup (`docker/entrypoint.sh`).

---

## Docker environments

| File | Purpose |
|------|---------|
| `docker-compose.yml` (root) | **Local dev/test** — PostgreSQL (dev :5434, test :5433) + Garage (dev :9000, test :9002) |
| `docker/docker-compose.yml` | **Production** — PostgreSQL + API + Web + Caddy |

### Databases

| DB | Port | Used by |
|----|------|---------|
| `zknotes` (dev) | 5434 | `bun run index.ts` (dev server) |
| `zknotes_test` (test) | 5433 | `bun test` |
| `zknotes` (prod) | internal | API container in production |

The Compose project is pinned to `open-core`, so container and volume names stay the same wherever
the repository is cloned.

## Deployment

On a server with Docker: `git clone`, then `cd zknotes/docker && ./setup.sh` — it asks for the
domain, generates the secrets, sets up the built-in file storage, builds and starts everything.
Operational detail — the manual setup, environment variables, TLS, backups — is in
[`docker/README.md`](docker/README.md). That is
the only supported way to run it in production: the security headers the client relies on
(Content-Security-Policy, HSTS and the share-page policies) come from the nginx and Caddy
configuration there, which `bun run preview` and a bare API process do not have.

---

## License

Copyright (C) 2026 Janko Diminic

ZKnotes is free software: you can redistribute it and/or modify it under the terms of the **GNU
Affero General Public License, version 3 only**, as published by the Free Software Foundation — see
[`LICENSE`](LICENSE). It is distributed in the hope that it will be useful, but **without any
warranty**; without even the implied warranty of merchantability or fitness for a particular
purpose. Licenses of the code it depends on, and why each is compatible, are recorded in
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

If you modify ZKnotes — the client, the server or both — and let other people use it over a
network, AGPL-3.0 §13 requires you to offer them the Corresponding Source of your version. Set
`SOURCE_URL` in the API environment to a repository holding that source: the app then links to it,
with the licence, from the sign-in page, the account-creation page, every shared-note page (whose
readers never sign in) and Settings → About. `server/.env.example` sets it to
`https://github.com/zknotes/zknotes`, which is right for an unmodified instance only. Whether that
is all §13 asks of your modified version is for you to judge; this is not legal advice.

Support for self-hosting is **best effort**: the deployment files here are the ones actually used in
production, so they work, but there is no commitment to a response time on self-hosting issues.
