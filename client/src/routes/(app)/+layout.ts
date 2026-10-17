// The vault zone is zero-knowledge and client-only: it needs an unlocked crypto SharedWorker +
// IndexedDB, neither of which exists in a Node SSR environment. We switch SSR off for the whole (app)
// layout — a hard guarantee that IDB or worker access cannot bring
// the server down. An app-wide decision for every (app) route, not only the file subsystem.
export const ssr = false;
