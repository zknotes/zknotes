// The diagnostics endpoints — fire-and-forget, they never throw (a logger or reporter must not bring
// the application down, nor set off a recursion of errors).
import type { LogLevel } from "@zknotes/shared";
import { API_BASE, apiFetch } from "./client";

/** POST /client-error — reports a client-side error into the server log. */
export function reportClientError(report: {
    message: string;
    fileId?: string;
    context?: string;
}): void {
    apiFetch("/client-error", { method: "POST", body: JSON.stringify(report) }).catch(() => {});
}

/**
 * POST /client-log — the dev-only forwarding of console logs (utils/dev-log.ts).
 * A raw fetch rather than apiFetch: no 401 redirect and no error handling.
 */
export function sendClientLog(level: string, tag: string, args: unknown[]): void {
    try {
        fetch(`${API_BASE}/client-log`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ level, tag, args }),
        }).catch(() => {});
    } catch {}
}

/** GET /dev-log-level — the current server log level (a dev-only route; null when unavailable). */
export async function getDevLogLevel(): Promise<LogLevel | null> {
    try {
        const res = await fetch(`${API_BASE}/dev-log-level`);
        if (!res.ok) return null;
        const data = (await res.json()) as { level: LogLevel };
        return data.level;
    } catch {
        return null;
    }
}

/** DELETE /dev-logs — deletes the server log file (debug.log; a dev-only route). */
export async function clearDevServerLogs(): Promise<boolean> {
    try {
        const res = await fetch(`${API_BASE}/dev-logs`, { method: "DELETE" });
        return res.ok;
    } catch {
        return false;
    }
}

/** PUT /dev-log-level — changes the server log level at runtime (a dev-only route). */
export async function setDevLogLevel(level: LogLevel): Promise<LogLevel | null> {
    try {
        const res = await fetch(`${API_BASE}/dev-log-level`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ level }),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { level: LogLevel };
        return data.level;
    } catch {
        return null;
    }
}
