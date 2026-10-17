/** The dev log buffer + the note debug context for DevPanel (runes — formerly a writable). */
import type { LogLevel } from "@zknotes/shared";

// The server sends pino levels (trace..fatal); the client adds "log" (console.log) on top.
export type LogEntry = {
    id: string;
    source: "client" | "server";
    level: LogLevel | "log";
    message: string;
    stack?: string;
    timestamp: number;
};

/** The sync/concurrency debug info for the note currently open (DEV only). */
export type DevNoteContext = {
    noteId: string;
    version: number;
    localRev?: number;
    conflictOf?: string;
};

const MAX_LOGS = 500;

class DevLogsStore {
    logs = $state<LogEntry[]>([]);

    addLog(log: Omit<LogEntry, "id" | "timestamp">) {
        const next = [
            ...this.logs,
            { ...log, id: Math.random().toString(36).slice(2), timestamp: Date.now() },
        ];
        // Keep only last 500 logs to prevent memory leak
        this.logs = next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next;
    }

    clear() {
        this.logs = [];
    }
}

class DevNoteDebugStore {
    context = $state<DevNoteContext | null>(null);

    set(ctx: DevNoteContext) {
        this.context = ctx;
    }

    clear() {
        this.context = null;
    }
}

export const devLogsStore = new DevLogsStore();
export const devNoteDebugStore = new DevNoteDebugStore();
