<script lang="ts">
import { LOG_LEVELS, type LogLevel } from "@zknotes/shared";
import { onMount } from "svelte";
import { API_BASE } from "$lib/core/api/client";
import { clearDevServerLogs, getDevLogLevel, setDevLogLevel } from "$lib/core/api/diagnostics";
import { devWarn } from "$lib/core/utils/dev-log";
import type { Snippet } from "svelte";
import type { LogEntry } from "./dev-store.svelte";
import ThemePicker from "$lib/core/ui/ThemePicker.svelte";
import { devLogsStore, devNoteDebugStore } from "./dev-store.svelte";
import { loadInstancePublicConfig } from "$lib/core/constants/public-www";

let noteCtx = $derived(devNoteDebugStore.context);

// One build serves both a self-host instance and one with an account layer — the only way to
// tell them apart at a glance in dev is this same runtime signal the login page already uses.
let accountManageUrl = $state<string | undefined>();
let instanceConfigLoaded = $state(false);

let { storageInspector }: { storageInspector?: Snippet } = $props();

let isOpen = $state(false);
let activeTab = $state<"logs" | "storage">("logs");
let eventSource: EventSource | null = null;
let logsContainer: HTMLElement | undefined = $state(undefined);

let showClient = $state(true);
let showServer = $state(true);
let serverLogLevel = $state<LogLevel | null>(null);

let logs = $derived(
    devLogsStore.logs.filter((log) => {
        if (log.source === "client" && !showClient) return false;
        if (log.source === "server" && !showServer) return false;
        return true;
    }),
);

onMount(() => {
    if (import.meta.env.DEV) {
        connectSSE();
    }

    void loadInstancePublicConfig().then((cfg) => {
        accountManageUrl = cfg.account?.manageUrl;
        instanceConfigLoaded = true;
    });

    const onBeforeUnload = () => {
        if (eventSource) eventSource.close();
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
        window.removeEventListener("beforeunload", onBeforeUnload);
        if (eventSource) eventSource.close();
    };
});

function connectSSE() {
    if (eventSource) eventSource.close();
    // Same origin through the Vite proxy, like every other API call (API_BASE is "" in dev).
    eventSource = new EventSource(`${API_BASE}/dev-logs-stream`);

    eventSource.onmessage = (event) => {
        try {
            const log = JSON.parse(event.data);
            devLogsStore.addLog(log);
            setTimeout(() => {
                if (logsContainer) {
                    logsContainer.scrollTop = logsContainer.scrollHeight;
                }
            }, 10);
        } catch (e) {
            devWarn("DevPanel: unreadable log event", e);
        }
    };

    eventSource.onerror = () => {
        eventSource?.close();
        setTimeout(connectSSE, 3000);
    };
}

function toggle() {
    isOpen = !isOpen;
    // A fresh level on every open — a server restart puts it back to LOG_LEVEL from .env
    if (isOpen) refreshLogLevel();
}

async function refreshLogLevel() {
    serverLogLevel = await getDevLogLevel();
}

async function changeLogLevel(event: Event) {
    const level = (event.currentTarget as HTMLSelectElement).value as LogLevel;
    serverLogLevel = await setDevLogLevel(level);
}

function clearLogs() {
    devLogsStore.clear();
    // The panel exists only in dev, and the route only while NODE_ENV !== "production".
    void clearDevServerLogs();
}

function openInEditor(stack?: string) {
    if (!stack) return;
    // Vite provides __open-in-editor endpoint
    fetch(`/__open-in-editor?file=${encodeURIComponent(stack)}`).catch(console.error);
}
</script>

{#if import.meta.env.DEV}
    <div class="dev-panel" class:open={isOpen}>
        {#if !isOpen}
            <button
                class="toggle-btn"
                onclick={toggle}
                title={noteCtx
                    ? `Note version ${noteCtx.version}`
                    : instanceConfigLoaded
                      ? accountManageUrl
                          ? `Debug panel — hosted instance (account: ${accountManageUrl})`
                          : "Debug panel — self-host instance"
                      : "Debug panel"}
            >
                D
            </button>
        {:else}
            <div class="panel-content">
                <div class="panel-header">
                    <div class="tabs">
                        <button class:active={activeTab === "logs"} onclick={() => activeTab = "logs"}>Logs</button>
                        <button class:active={activeTab === "storage"} onclick={() => activeTab = "storage"}>Storage</button>
                    </div>
                    {#if activeTab === "logs"}
                    <div class="filters">
                        <label>
                            <input type="checkbox" bind:checked={showClient} /> Client
                        </label>
                        <label>
                            <input type="checkbox" bind:checked={showServer} /> Server
                        </label>
                        <label class="level-label">
                            Server level
                            <select
                                class="level-select"
                                value={serverLogLevel ?? ""}
                                disabled={serverLogLevel === null}
                                onchange={changeLogLevel}
                            >
                                {#if serverLogLevel === null}
                                    <option value="">n/a</option>
                                {/if}
                                {#each LOG_LEVELS as level (level)}
                                    <option value={level}>{level}</option>
                                {/each}
                            </select>
                        </label>
                    </div>
                    {/if}
                    <div class="actions">
                        {#if instanceConfigLoaded}
                            <span
                                class="instance-badge"
                                class:hosted={!!accountManageUrl}
                                title={accountManageUrl
                                    ? `/instance-config returned account.manageUrl = ${accountManageUrl}`
                                    : "/instance-config returned no account.manageUrl"}
                            >
                                {accountManageUrl ? "Hosted" : "Self-host"}
                            </span>
                        {/if}
                        <ThemePicker />
                        <button onclick={() => window.open('/dev/ui', '_blank')}>UI Gallery</button>
                        <button onclick={clearLogs}>Clear Logs</button>
                        <button onclick={toggle}>Close</button>
                    </div>
                </div>

                {#if noteCtx}
                    <div class="note-debug" title="Server optimistic-concurrency version + local revision (sync debug)">
                        <span class="note-debug-label">Note</span>
                        <span class="note-debug-id" title={noteCtx.noteId}>{noteCtx.noteId}</span>
                        <span>version <strong>v{noteCtx.version}</strong></span>
                        <span>localRev <strong>{noteCtx.localRev ?? "—"}</strong></span>
                        {#if noteCtx.conflictOf}
                            <span class="note-debug-conflict" title="Conflict copy of {noteCtx.conflictOf}">
                                ⚠ conflict of {noteCtx.conflictOf}
                            </span>
                        {/if}
                    </div>
                {/if}

                {#if activeTab === "logs"}
                <div class="logs-container" bind:this={logsContainer}>
                    {#each logs as log (log.id)}
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div
                            class="log-entry {log.level} {log.source}"
                            class:clickable={!!log.stack}
                            onclick={() => openInEditor(log.stack)}
                        >
                            <span class="time">{new Date(log.timestamp).toLocaleTimeString()}</span>
                            <span class="badge {log.source}">{log.source}</span>
                            <span class="level {log.level}">{log.level}</span>
                            <span class="message">{log.message}</span>
                        </div>
                    {/each}
                    {#if logs.length === 0}
                        <div class="empty">No logs to display</div>
                    {/if}
                </div>
                {:else if activeTab === "storage" && storageInspector}
                    {@render storageInspector()}
                {/if}
            </div>
        {/if}
    </div>
{/if}

<style>
    .dev-panel {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 999999;
        font-family: monospace;
    }

    .dev-panel.open {
        bottom: 0;
        right: 0;
        width: 100vw;
        height: 40vh;
        background: #1e1e1e;
        color: #ddd;
        border-top: 1px solid #444;
        display: flex;
        flex-direction: column;
    }

    .toggle-btn {
        background: #ff2a5f;
        color: white;
        border: none;
        width: 22px;
        height: 22px;
        padding: 0;
        border-radius: 50%;
        cursor: pointer;
        font-weight: bold;
        font-size: 10px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 2px 8px rgba(255, 42, 95, 0.4);
    }

    .note-debug {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px 14px;
        padding: 6px 16px;
        background: #1a2332;
        border-bottom: 1px solid #334;
        font-size: 11px;
        color: #9ab;
        font-variant-numeric: tabular-nums;
    }

    .note-debug-label {
        font-weight: bold;
        color: #ff2a5f;
        text-transform: uppercase;
        letter-spacing: 0.06em;
    }

    .note-debug-id {
        max-width: 18rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        user-select: all;
        color: #8cf;
    }

    .note-debug strong {
        color: #e8e8e8;
        font-weight: 700;
    }

    .note-debug-conflict {
        color: #fbbf24;
    }

    .panel-content {
        display: flex;
        flex-direction: column;
        height: 100%;
    }

    .panel-header {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        align-items: center;
        gap: 6px 0;
        padding: 8px 16px;
        background: #252526;
        border-bottom: 1px solid #444;
    }

    .panel-header h3 {
        margin: 0;
        font-size: var(--text-sm);
        color: #fff;
    }

    .tabs button {
        background: none;
        border: none;
        color: #888;
        cursor: pointer;
        font-weight: bold;
        padding: 4px 12px;
        font-size: var(--text-sm);
    }
    
    .tabs button.active {
        color: #fff;
        border-bottom: 2px solid #ff2a5f;
    }

    .filters {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
    }

    .filters label {
        margin-right: 12px;
        cursor: pointer;
        font-size: var(--text-xs);
    }

    .level-select {
        background: #333;
        color: #fff;
        border: 1px solid #555;
        border-radius: 4px;
        padding: 2px 4px;
        font-size: var(--text-xs);
        font-family: inherit;
        margin-left: 4px;
    }

    .level-select:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
    }

    .actions button {
        background: #333;
        color: #fff;
        border: 1px solid #555;
        padding: 4px 12px;
        cursor: pointer;
        border-radius: 4px;
        font-size: var(--text-xs);
    }

    .actions button:hover {
        background: #444;
    }

    .logs-container {
        flex: 1;
        overflow-y: auto;
        padding: 8px;
    }

    .log-entry {
        padding: 4px 8px;
        border-bottom: 1px solid #333;
        font-size: var(--text-xs);
        line-height: 1.4;
        word-break: break-all;
    }

    .log-entry.clickable {
        cursor: pointer;
    }
    
    .log-entry.clickable:hover {
        background: #2a2d33;
    }

    .log-entry.fatal { color: #ff5f5f; }
    .log-entry.error { color: #f48771; }
    .log-entry.warn { color: #cca700; }
    .log-entry.info { color: #75beff; }
    .log-entry.log { color: #cccccc; }
    .log-entry.debug { color: #999999; }
    .log-entry.trace { color: #777777; }

    .level {
        display: inline-block;
        min-width: 5ch; /* "debug"/"trace"/"fatal" are the longest — it lines the messages up */
        margin-right: 8px;
        font-size: var(--text-2xs);
        font-weight: bold;
        text-transform: uppercase;
    }

    .time {
        color: #888;
        margin-right: 8px;
    }

    .badge {
        display: inline-block;
        padding: 2px 6px;
        border-radius: 4px;
        font-size: var(--text-2xs);
        font-weight: bold;
        margin-right: 8px;
        text-transform: uppercase;
    }

    .badge.client { background: #005f3b; color: #fff; }
    .badge.server { background: #5f002b; color: #fff; }

    .instance-badge {
        display: inline-block;
        padding: 3px 8px;
        border-radius: 4px;
        font-size: var(--text-2xs);
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: #444;
        color: #ccc;
        cursor: help;
    }

    .instance-badge.hosted {
        background: #0e4f6b;
        color: #8cf;
    }

    .empty {
        text-align: center;
        padding: 20px;
        color: #666;
    }
</style>
