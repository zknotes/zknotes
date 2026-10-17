# client/src/lib — the architecture

The frontend `$lib` is organised into two clearly separated layers, following a **domain-driven /
modular** architecture.

## The structure

```
src/lib/
├── core/          ← the infrastructure (the engine)
│   ├── api/
│   ├── constants/
│   ├── crypto/
│   ├── data/
│   ├── db/
│   ├── events/
│   ├── files/
│   ├── search/
│   ├── services/
│   ├── stores/
│   ├── streaming/
│   ├── sync/
│   ├── types/
│   ├── ui/
│   ├── utils/
│   └── workers/
└── modules/       ← the domain logic (the feature modules)
    ├── editor/
    ├── export/
    ├── files/
    ├── notes/
    ├── share/
    └── sync/
```

## `core/` — the infrastructure

The application's technical foundation, independent of any domain logic.
It can be used in a desktop, mobile or browser-extension build without changes.

| Directory       | Contents |
|-----------------|---------|
| `api/`          | The HTTP client for the server (auth, items, files...) |
| `constants/`    | The constants: colours, fonts, APP_EVENTS, QUERY_KEYS |
| `crypto/`       | The item payload codec (encrypting/decrypting through the worker RPC) |
| `data/`         | Decrypted item metadata for the tree and Trash (`getTreeItems`, `getDeletedItems`) |
| `db/`           | IndexedDB access (`idb`), the schema, the migrations |
| `events/`       | Bridges that invert the dependency direction (`fileBridge`: modules/files registers, core calls) |
| `files/`        | Only what file streaming must share with core; new file-domain logic goes to `modules/files/` |
| `search/`       | Minisearch indexing, searching, and flush/persist |
| `services/`     | ItemService (CRUD), auth, the session lifecycle, the import/export orchestration |
| `stores/`       | The global Svelte `$state` (theme, toasts, sidebar, the search index, search-list-state) |
| `streaming/`    | The Service Worker bridge for streaming encrypted files |
| `sync/`         | The sync engine: push/pull/conflict, the scheduler, history |
| `types/`        | Shared client types |
| `ui/`           | Generic UI components (`Dialog`, `Toast`, `FolderTree`…) |
| `utils/`        | Pure helper functions (base64, format, tree, fractional-index, file-lifecycle, expanded-folders...) |
| `workers/`      | The crypto SharedWorker + the postMessage RPC client |

## `modules/` — the domain logic

Each module is self-contained within its domain.

| Directory       | Contents |
|-----------------|---------|
| `editor/`       | The TipTap editor: components, popovers, TipTap extensions, state classes |
| `export/`       | The full backup (ZIP, optionally sealed with a passphrase), the HTML export, the restore wizard |
| `files/`        | The file lifecycle, upload/download, the blob cache, the file UI components |
| `notes/`        | Note autosave, the history panel and its preview |
| `share/`        | Share links: creating them, the recipient page's decryption and downloads |
| `sync/`         | The conflict inbox |

## The golden rules of importing

```
✅ Allowed:    modules/editor  →  core/utils
✅ Allowed:    modules/files   →  core/api
✅ Allowed:    modules/files   →  modules/files/file-service  (within the module)
✅ Allowed:    routes/         →  modules/* or core/*

❌ Forbidden:  modules/editor  →  modules/files   (a direct cross-module import)
❌ Forbidden:  core/services   →  modules/files/invalidation  (core must not depend on the modules)
```

### Cross-module communication

When modules have to talk to each other, they use the **event bus** in `core/events`:

```ts
// modules/files/file-service.ts — it emits the event
import { APP_EVENTS } from "$lib/core/constants/events";
window.dispatchEvent(new CustomEvent(APP_EVENTS.vaultItemsChanged));

// modules/notes/… — subscribes to the event
import { APP_EVENTS } from "$lib/core/constants/events";
window.addEventListener(APP_EVENTS.vaultItemsChanged, onVaultItemsChanged);
```

### When `core/` needs behaviour from `modules/` (inverting the dependency)

The direction `core → modules` is forbidden, but sometimes core (the sync engine, the SW bridge, the
teardown, drag-and-drop) has to call feature code. The solution is a **provider-registry bridge** in
`core/events`: `core` defines the interface and calls `fileBridge.*`, while `modules/files` registers
its implementation at bootstrap (`registerFilesBridge()` from `(app)/+layout.svelte`). That reverses
the direction into the permitted `modules → core`, and the heavy modules stay lazy (loaded only on the
first call).

```ts
// core/* — it calls the bridge and does NOT import modules
import { fileBridge } from "$lib/core/events/file-bridge";
void fileBridge.invalidateFile(fileId);

// modules/files/register-bridge.ts — it registers the lazy implementation
registerFileBridge({
    async invalidateFile(id) {
        const { invalidateFile } = await import("./invalidation");
        await invalidateFile(id);
    },
    // ...
});
```

## Why this way?

This architecture gives us:
- **Readability**: you always know where to find what (infrastructure vs. domain)
- **Testability**: `core/` is testable without the UI, `modules/` with a mocked `core/`
- **Portability**: `core/` can be reused in a desktop build (Tauri/Electron), on mobile, or in a browser extension
- **Security**: encryption stays strictly inside `core/workers/` — the UI modules have no access to raw keys

## File-naming conventions

- `.svelte` → PascalCase (components)
- `.svelte.ts` → kebab-case (stores), PascalCase (state classes)
- `.ts` (modules) → kebab-case
- `.ts` (classes) → kebab-case with a suffix (`file-service.ts`, say) or PascalCase (controllers/models inside a module)
- `.test.ts` → the same name as the source + `.test.ts`
- `*.worker.ts` → kebab-case + `.worker.ts`
- directories → kebab-case
