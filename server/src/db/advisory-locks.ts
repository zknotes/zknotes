// Postgres advisory lock keys, in one place so the namespace is visible: three callers used to carry
// their own literals (872014 three times, 872_015_00x twice).
export const ADVISORY_LOCKS = {
    /** Per user (`hashtext(userId)` as the second key): serialises folder moves so no cycle forms. */
    folderMutation: 872014,
    /** Session-level: two API replicas must not race `drizzle migrate()` on a shared database. */
    migrate: 872_015_001,
    /** Transaction-level: vault creation. */
    vaultCreate: 872_015_002,
} as const;
