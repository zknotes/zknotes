# @zknotes/api

Fastify 5 backend. Drizzle ORM over PostgreSQL (`postgres-js` driver), `@node-rs/argon2` for
server-side Auth Key verification, HttpOnly session cookies (30d).

**Zero-knowledge:** item content, titles, names, files and the search index reach the server only
encrypted, and it never holds key material. What it does see: each item's place in the tree
(type, parent, order, version, timestamps, trash state, file sizes), account data (email address,
KDF salt and parameters, sessions), share-link metadata, and usage analytics (see
"Server-side analytics" in `.env.example`, `ANALYTICS_DISABLED`).

```bash
NODE_ENV=development bun --watch index.ts  # dev server on :3000
NODE_ENV=production bun run index.ts       # production-style run

bunx drizzle-kit migrate                   # apply migrations to the dev DB
```

DB connection via `DATABASE_URL`; copy `.env.example` → `.env`. The example file sets
`NODE_ENV=production`, so pass `NODE_ENV=development` on the command line for local work (`../dev.sh`
does). In production `COOKIE_SECRET` and `KDF_FAKE_SEED` must hold real values — startup throws while
either is unset or still the `REPLACE_WITH_…` placeholder.

Migrations are **hand-written SQL**: edit `src/db/schema.ts`, write `drizzle/00NN_<name>.sql` by hand
and add its entry to `drizzle/meta/_journal.json` (details in the
[repository README](../README.md#database-migrations-drizzle)). Never use `drizzle-kit generate` or
`drizzle-kit push`. Migrations apply on container startup in production (`../docker/entrypoint.sh`).

Key areas: `src/routes/` (auth, items, files), `src/db/schema.ts` (Drizzle schema), `src/plugins/`
(`authenticate`). New protected routes must use `{ preParsing: [fastify.authenticateBeforeBody] }`, which
authenticates before the request body is read (`preValidation` would run after parsing it).

> Conventions, commands and how to run the stack are in the [repository README](../README.md).
