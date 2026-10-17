/**
 * $lib — organised into two layers (core/ and modules/).
 * Deliberately without re-exports: a $lib root barrel would create circular dependencies and pull
 * the whole application into every chunk. Always import straight from the layer you need.
 *
 * CORE — infrastructure (independent of the domain logic):
 *   core/api/        — the apiFetch transport + the domain API clients
 *   core/constants/  — APP_EVENTS, QUERY_KEYS, colours, fonts, folder presets
 *   core/crypto/     — item-codec + session-key (trust boundary: core/workers/)
 *   core/data/       — decrypted item metadata (getTreeItems, getDeletedItems)
 *   core/db/         — the IndexedDB schema and access (idb)
 *   core/events/     — bridges that invert the dependency direction (fileBridge: modules/files → core)
 *   core/files/      — only what file streaming must share with core
 *   core/search/     — Minisearch indexing and search
 *   core/services/   — ItemService, auth, session, import-export orchestration
 *   core/stores/     — global Svelte $state (theme, toasts, sidebar, search-list-state...)
 *   core/streaming/  — the Service Worker bridge for file streaming
 *   core/sync/       — the offline-first engine + scheduler + conflict
 *   core/ui/         — generic components (Dialog, Toast, FolderTree...)
 *   core/utils/      — pure helpers (base64, format, tree, fractional-index, file-lifecycle, expanded-folders...)
 *   core/workers/    — the Crypto SharedWorker + the postMessage RPC client
 *
 * MODULES — domain logic (feature modules):
 *   modules/editor/   — the TipTap editor (components, extensions, state)
 *   modules/export/   — the full backup, the HTML export, the restore wizard
 *   modules/files/    — file lifecycle, upload/download, blob cache, UI
 *   modules/notes/    — note autosave, the history panel
 *   modules/share/    — share links (creation, the recipient page)
 *   modules/sync/     — the conflict inbox
 *
 * THE RULES:
 *   ✅ modules/X → core/*         (allowed)
 *   ✅ modules/X → modules/X/*    (within the same module, allowed)
 *   ❌ modules/A → modules/B      (forbidden — go through core/events)
 *   ❌ core/*   → modules/*       (forbidden)
 */
