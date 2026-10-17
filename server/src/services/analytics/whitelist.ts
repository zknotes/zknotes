/**
 * The whitelist of normalised routes for the server-side analytics.
 */
export const ANALYTICS_ROUTE_WHITELIST = new Set([
    // Sync/items
    "/items",
    "/items/batch",
    "/items/:id",
    "/items/:id/purge",
    "/items/:id/history",
    "/items/:id/history/:snapshotId",
    // Files
    "/uploads",
    "/uploads/:chunkSetId",
    "/uploads/:chunkSetId/chunks/:index",
    "/uploads/:chunkSetId/finalize",
    "/uploads/:chunkSetId/urls",
    "/uploads/:chunkSetId/status",
    "/uploads/:chunkSetId/ping",
    "/me/storage",
    // Restore
    "/restore/sessions",
    "/restore/sessions/:id",
    "/restore/sessions/:id/items",
    "/restore/sessions/:id/ping",
    "/restore/sessions/:id/verify",
    "/restore/sessions/:id/commit",
    "/restore/sessions/:id/abort",
    // Vault creation — this is the registration now (`/auth/register` no longer exists)
    "/vault",
    // Auth
    "/auth/login",
    "/auth/logout",
    "/auth/me",
    "/auth/kdf-params",
    "/auth/change-password",
    "/auth/sessions",
    "/auth/sessions/:id",
    "/auth/account",
]);

export function isAnalyticsRoute(route: string | undefined): route is string {
    return route !== undefined && ANALYTICS_ROUTE_WHITELIST.has(route);
}

export function statusClass(statusCode: number): "2xx" | "4xx" | "5xx" | null {
    if (statusCode >= 200 && statusCode < 300) return "2xx";
    if (statusCode >= 400 && statusCode < 500) return "4xx";
    if (statusCode >= 500) return "5xx";
    return null;
}
