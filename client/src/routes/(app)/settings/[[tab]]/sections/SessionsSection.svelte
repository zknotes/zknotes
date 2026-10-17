<script lang="ts">
import { onMount } from "svelte";
import { Loader2, Monitor, Smartphone, Tablet, Trash2 } from "lucide-svelte";
import { deleteSession, getSessions, type SessionInfo } from "$lib/core/api/auth";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import Button from "$lib/core/ui/Button.svelte";
import { formatDate, relativeTime } from "$lib/core/utils/format";
import { parseUserAgent, type DeviceType } from "$lib/core/utils/user-agent";

let sessionsList = $state<SessionInfo[]>([]);
let isLoadingSessions = $state(false);
let sessionsError = $state("");

const DEVICE_ICONS: Record<DeviceType, typeof Monitor> = {
    desktop: Monitor,
    mobile: Smartphone,
    tablet: Tablet,
    unknown: Monitor,
};

async function loadSessions() {
    if (isLoadingSessions) return;
    isLoadingSessions = true;
    sessionsError = "";
    try {
        const res = await getSessions();
        sessionsList = res.sessions;
    } catch (e) {
        sessionsError = e instanceof Error ? e.message : "Failed to load sessions";
    } finally {
        isLoadingSessions = false;
    }
}

async function handleRevokeSession(id: string) {
    try {
        await deleteSession(id);
        sessionsList = sessionsList.filter((s) => s.id !== id);
        globalToasts.add({ message: "Session revoked", variant: "success" });
    } catch {
        globalToasts.add({ message: "Failed to revoke session", variant: "error" });
    }
}

onMount(loadSessions);
</script>

<div class="mb-8">
    <h1 class="text-2xl font-bold text-[var(--text)]">Sessions</h1>
    <p class="text-[var(--text-muted)] mt-1 text-sm">Manage devices that are currently logged in to your account</p>
</div>

<div class="space-y-3">
    {#if isLoadingSessions}
        <div class="flex items-center justify-center p-8 text-[var(--text-muted)]">
            <Loader2 class="w-6 h-6 animate-spin mr-2" />
            <span>Loading sessions...</span>
        </div>
    {:else if sessionsError}
        <div class="p-4 bg-[var(--danger)]/10 text-[var(--danger)] rounded-xl border border-[var(--danger)]/20 font-medium">
            {sessionsError}
        </div>
    {:else if sessionsList.length === 0}
        <p class="text-sm text-[var(--text-muted)]">No active sessions found.</p>
    {:else}
        {#each sessionsList as session}
            {@const parsed = parseUserAgent(session.user_agent)}
            {@const DeviceIcon = DEVICE_ICONS[parsed.deviceType]}
            <div class="bg-[var(--surface-panel)]/50 border border-[var(--stroke)] rounded-xl p-4 flex items-start justify-between gap-4">
                <div class="flex items-start gap-3 min-w-0">
                    <div class="p-2.5 rounded-lg bg-[var(--accent-color)]/10 text-[var(--accent-color)] shrink-0 mt-0.5">
                        <DeviceIcon class="w-5 h-5" />
                    </div>
                    <div class="min-w-0">
                        <div class="flex flex-wrap items-center gap-2 mb-1">
                            <p class="font-semibold text-[var(--text)]">{parsed.label}</p>
                            {#if session.is_current}
                                <span
                                    class="px-2 py-0.5 rounded-full bg-brand0/10 text-brand0 dark:text-brand-fg text-xs font-bold uppercase tracking-wide"
                                >
                                    This device
                                </span>
                            {/if}
                        </div>
                        <p class="text-sm text-[var(--text-muted)]">
                            {#if session.ip_address}
                                <span>{session.ip_address}</span>
                                <span class="mx-1.5 text-[var(--stroke)]">·</span>
                            {/if}
                            <span title={formatDate(session.last_used_at)}>Last active {relativeTime(session.last_used_at)}</span>
                        </p>
                        <p class="text-xs text-[var(--text-muted)]/80 mt-1" title={formatDate(session.created_at)}>
                            Signed in {relativeTime(session.created_at)}
                        </p>
                    </div>
                </div>

                {#if !session.is_current}
                    <Button
                        variant="danger-ghost"
                        size="icon"
                        onclick={() => handleRevokeSession(session.id)}
                        title="Revoke session"
                        class="flex-shrink-0"
                    >
                        <Trash2 class="w-5 h-5" />
                    </Button>
                {/if}
            </div>
        {/each}
    {/if}
</div>