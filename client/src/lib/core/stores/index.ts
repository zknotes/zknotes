/**
 * The stores module's public API — the global Svelte $state (all of it on runes).
 * The domain sync store is colocated with the sync engine: syncStore → $lib/core/sync.
 */
export * from "./active-sidebar-id.svelte";
export * from "./auth-store.svelte";
export * from "./pending-expand.svelte";
export * from "./pending-rename.svelte";
export * from "./pwa.svelte";
export * from "./recent-notes.svelte";
export * from "./search-index.svelte";
export * from "./search-list-state.svelte";
export * from "./search-open.svelte";
export * from "./settings-last-tab.svelte";
export * from "./theme.svelte";
export * from "./toast.svelte";
export * from "./utility-return.svelte";
