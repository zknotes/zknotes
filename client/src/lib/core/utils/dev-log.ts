// A tree-shakeable dev-only logger. Every call disappears from a production build.

const DEV = import.meta.env.DEV;

function getStackLine() {
    try {
        const stack = new Error().stack?.split("\n") || [];
        for (let i = 2; i < stack.length; i++) {
            if (!stack[i].includes("dev-log.ts")) {
                const match = stack[i].match(
                    /(http:\/\/[^/]+)(\/src\/[^?)]+)(?:\?[^:]+)?(:[0-9]+:[0-9]+)/,
                );
                if (match) return match[2] + match[3];
                // Try the Safari/Firefox fallback
                const match2 = stack[i].match(/(http:\/\/[^/]+)(\/src\/[^:]+)(:[0-9]+:[0-9]+)/);
                if (match2) return match2[2] + match2[3];
            }
        }
    } catch {}
    return undefined;
}

async function recordDevLog(level: string, tag: string, args: unknown[]) {
    if (!DEV) return;
    // Into the local store the dev panel reads.
    try {
        const { devLogsStore } = await import("$lib/core/ui/dev/dev-store.svelte");
        devLogsStore.addLog({
            source: "client",
            level: level as "log" | "warn" | "error" | "info",
            message:
                `[${tag}] ` +
                args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "),
            stack: getStackLine(),
        });
    } catch {}
}

export function devLog(tag: string, ...args: unknown[]): void {
    if (DEV) {
        // The Dev Panel only — no console.log in the browser or the terminal (far too noisy during an upload, and so on).
        void recordDevLog("log", tag, args);
    }
}

export function devWarn(tag: string, ...args: unknown[]): void {
    if (DEV) {
        void recordDevLog("warn", tag, args);
    }
}
