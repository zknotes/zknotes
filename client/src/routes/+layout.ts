// SPA mode (adapter-static + a fallback index.html): the whole app is zero-knowledge and client-only
// (an unlocked crypto SharedWorker and IndexedDB do not exist under Node SSR).
// We switch SSR off globally; (app)/+layout.ts already did the same for the vault zone, and this
// covers login/register too. No prerender — every route is served out of the SPA shell.
export const ssr = false;
export const prerender = false;
