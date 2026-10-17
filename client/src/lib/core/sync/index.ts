/**
 * The sync module's public API — the offline-first push/pull engine.
 * The internal modules: engine (the public face of outbox, push, push-result and pull), wire (pure
 * item helpers), conflict (the copy helpers), scheduler (the background orchestration), store (the
 * UI sync state).
 */
export * from "./conflict";
export * from "./engine";
export { createSyncScheduler, type SyncScheduler } from "./scheduler";
export { syncStore } from "./store.svelte";
