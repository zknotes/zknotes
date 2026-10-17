import type { db } from "./index";

/** The Drizzle transaction callback's argument — the same query API as `db`. */
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** `db`, or an active transaction — the services work inside and outside transactions alike. */
export type DbExecutor = typeof db | DbTransaction;
