# @zknotes/web

SvelteKit 2 + **Svelte 5 (runes mode)** SPA — the ZKnotes client. Tailwind v4, TipTap editor,
`@tanstack/svelte-query`, IndexedDB (`idb`), `minisearch` for client-side full-text search.

All encryption happens here, never on the server. The **Vault Key lives in the crypto SharedWorker**
(`src/lib/core/workers/crypto.worker.ts`) — UI code encrypts and decrypts through the RPC wrapper
`src/lib/core/workers/crypto-rpc.ts` and never touches raw key material. The one exception is
deliberate: each signed-in tab keeps a copy of the Vault Key in `sessionStorage`
(`src/lib/core/crypto/session-key.ts`, the only module allowed to) so that a reload does not ask
for the password again — see "Where keys live" in [`SECURITY.md`](../SECURITY.md).

```bash
bun run dev      # dev server on :5173 (Vite)
bun run build    # production build
bun run preview  # look at the build locally on :4173 — not a deployment (no security headers)
```

Key areas:

- `src/lib/core/sync/` — IndexedDB ↔ server sync engine
- `src/lib/core/db/` — local IndexedDB store
- `src/lib/core/workers/` — crypto trust boundary (never add `localStorage`/`sessionStorage` here)
- `src/lib/modules/` — domain modules (editor, export, files, notes, share, sync)
- `e2e/` — Playwright end-to-end tests

Architecture details: `src/lib/README.md`.

> Conventions, commands and how to run the stack are in the [repository README](../README.md).