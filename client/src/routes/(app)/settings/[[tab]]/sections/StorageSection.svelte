<script lang="ts">
import type { StorageInfo } from "$lib/core/api/files";
import { onMount } from "svelte";
import {
    CircleHelp,
    Cloud,
    Database,
    Download,
    Loader2,
    ShieldAlert,
    ShieldCheck,
    Trash2,
} from "lucide-svelte";
import { SettingsCard } from "$lib/core/ui";
import type { LucideIcon } from "$lib/core/types/icons";
import { humanSize, humanSizeShort } from "$lib/core/utils/format";
import { loadPersistOutcome, type PersistOutcome } from "$lib/core/utils/persistent-storage";
import Button from "$lib/core/ui/Button.svelte";
import {
    type AutoDownloadPolicy,
    getSyncSettings,
    setSyncSettings,
    SMALL_FILE_LIMIT_BYTES,
} from "$lib/modules/files/sync-settings";

// The remembered outcome of the anti-eviction request — Settings only reads it, it never calls persist().
let persistOutcome = $state<PersistOutcome>(loadPersistOutcome());

const persistStatus: Record<
    PersistOutcome,
    { title: string; body: string; rowClass: string; icon: LucideIcon }
> = {
    persisted: {
        title: "Persistent storage is active",
        body: "Your browser has reserved this data — it won't be cleared automatically under storage pressure.",
        rowClass: "bg-[var(--success)]/10 border border-[var(--success)]/20 text-[var(--success)]",
        icon: ShieldCheck,
    },
    denied: {
        title: "Offline storage is not persistent",
        body: "Your browser may clear locally stored notes under storage pressure. Install the app (Add to Home Screen / Install) to keep your data reliably available offline.",
        rowClass: "bg-amber-500/10 border border-amber-500/20 text-amber-500",
        icon: ShieldAlert,
    },
    unsupported: {
        title: "Persistent storage isn't supported by this browser",
        body: "Your browser may clear locally stored notes under storage pressure without warning. Installing the app may help on browsers that support it.",
        rowClass: "bg-[var(--surface-raised)]/50 border border-[var(--stroke)] text-[var(--text)]",
        icon: CircleHelp,
    },
};

const persistRow = $derived(persistStatus[persistOutcome]);
const PersistIcon = $derived(persistRow.icon);

let storageUsage = $state<number>(0);
let storageEstimate = $state<StorageEstimate | null>(null);
let isClearingStorage = $state(false);
let clearStorageMessage = $state("");

// The auto-download policy, per device (localStorage, never to the server).
let autoDownloadPolicy = $state<AutoDownloadPolicy>(getSyncSettings().autoDownload);

function setAutoDownloadPolicy(policy: AutoDownloadPolicy) {
    autoDownloadPolicy = policy;
    setSyncSettings({ autoDownload: policy });
}

let cloudStorage = $state<StorageInfo | "loading" | "error">("loading");

async function loadStorageInfo() {
    const { getLocalChunkBytes } = await import("$lib/core/db/file-chunks");
    storageUsage = await getLocalChunkBytes();
    if (navigator.storage?.estimate) {
        storageEstimate = await navigator.storage.estimate();
    }
    try {
        const { getStorage } = await import("$lib/core/api/files");
        cloudStorage = await getStorage();
    } catch {
        cloudStorage = "error";
    }
}

let clearMessageTimer: ReturnType<typeof setTimeout> | undefined;
$effect(() => () => clearTimeout(clearMessageTimer));

async function handleClearStorage() {
    if (isClearingStorage) return;
    isClearingStorage = true;
    clearStorageMessage = "Clearing unpinned files...";
    try {
        const { clearUnpinnedCache } = await import("$lib/modules/files/storage-manager");
        const freed = await clearUnpinnedCache();
        await loadStorageInfo();
        clearStorageMessage = `Freed ${humanSize(freed)}.`;
    } catch (e) {
        clearStorageMessage = e instanceof Error ? e.message : "Error clearing storage.";
    } finally {
        isClearingStorage = false;
        clearTimeout(clearMessageTimer);
        clearMessageTimer = setTimeout(() => {
            if (!isClearingStorage) clearStorageMessage = "";
        }, 5000);
    }
}

onMount(loadStorageInfo);
</script>

<div class="mb-8">
    <h1 class="text-2xl font-bold text-[var(--text)]">Storage Management</h1>
    <p class="text-[var(--text-muted)] mt-1 text-sm">Manage local offline cache</p>
</div>

<div
    class="mb-6 p-4 rounded-xl flex items-start gap-3 {persistRow.rowClass}"
    data-testid="persist-status"
    data-outcome={persistOutcome}
>
    <PersistIcon class="w-5 h-5 shrink-0 mt-0.5" />
    <div class="text-sm flex-1">
        <strong class="block mb-1">{persistRow.title}</strong>
        {persistRow.body}
    </div>
</div>

<div class="divide-y divide-[var(--stroke)]">
<SettingsCard title="Cloud Storage" description="Your remote account storage quota.">
    {#snippet icon()}
        <Cloud class="w-6 h-6" />
    {/snippet}
    <div class="space-y-4">
        <div class="p-4 bg-[var(--surface-raised)]/50 rounded-xl">
            {#if cloudStorage === "loading"}
                <div class="flex justify-center p-4"><Loader2 class="w-5 h-5 animate-spin" /></div>
            {:else if cloudStorage === "error"}
                <div class="text-[var(--danger)] text-sm">Failed to load cloud storage info.</div>
            {:else}
                <div class="flex items-center justify-between mb-4">
                    <span class="font-semibold text-[var(--text)]">Total Usage</span>
                    <span class="font-mono text-sm">{humanSize(cloudStorage.breakdown.total_used)} / {humanSize(cloudStorage.storage_quota)}</span>
                </div>
                
                {@const filesPct = cloudStorage.storage_quota > 0 ? (cloudStorage.breakdown.files_bytes / cloudStorage.storage_quota) * 100 : 0}
                {@const itemsPct = cloudStorage.storage_quota > 0 ? (cloudStorage.breakdown.items_bytes / cloudStorage.storage_quota) * 100 : 0}
                {@const historyPct = cloudStorage.storage_quota > 0 ? (cloudStorage.breakdown.history_bytes / cloudStorage.storage_quota) * 100 : 0}
                {@const trashPct = cloudStorage.storage_quota > 0 ? (cloudStorage.breakdown.trashed_bytes / cloudStorage.storage_quota) * 100 : 0}
                {@const isOverLimit = cloudStorage.breakdown.total_used > cloudStorage.storage_quota}

                <div class="w-full bg-[var(--stroke)] rounded-full h-3 mb-4 flex overflow-hidden">
                    <div class="h-full transition-all {isOverLimit ? 'bg-red-500' : 'bg-blue-500'}" style="width: {filesPct}%"></div>
                    <div class="h-full transition-all {isOverLimit ? 'bg-red-500' : 'bg-brand0'}" style="width: {itemsPct}%"></div>
                    <div class="h-full transition-all {isOverLimit ? 'bg-red-500' : 'bg-purple-500'}" style="width: {historyPct}%"></div>
                    <div class="h-full transition-all bg-amber-500/60" style="width: {trashPct}%"></div>
                </div>
                
                <div class="grid grid-cols-2 gap-y-3 gap-x-4 text-sm">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <div class="w-3 h-3 rounded-full bg-blue-500"></div>
                            <span class="text-[var(--text-muted)]">Files</span>
                        </div>
                        <span class="font-mono">{humanSizeShort(cloudStorage.breakdown.files_bytes)}</span>
                    </div>
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <div class="w-3 h-3 rounded-full bg-brand0"></div>
                            <span class="text-[var(--text-muted)]">Notes</span>
                        </div>
                        <span class="font-mono">{humanSizeShort(cloudStorage.breakdown.items_bytes)}</span>
                    </div>
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <div class="w-3 h-3 rounded-full bg-purple-500"></div>
                            <span class="text-[var(--text-muted)]">History</span>
                        </div>
                        <span class="font-mono">{humanSizeShort(cloudStorage.breakdown.history_bytes)}</span>
                    </div>
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <div class="w-3 h-3 rounded-full bg-amber-500/60"></div>
                            <span class="text-[var(--text-muted)]">Trash</span>
                        </div>
                        <span class="font-mono">{humanSizeShort(cloudStorage.breakdown.trashed_bytes)}</span>
                    </div>
                </div>
                
                {#if isOverLimit}
                    <div class="mt-4 p-3 bg-red-500/10 border border-red-500/20 text-red-500 rounded-xl text-sm">
                        <strong class="block mb-1">Storage limit exceeded</strong> 
                        Uploads and modifications are blocked. Empty your trash to free up space.
                    </div>
                {/if}
            {/if}
        </div>
    </div>
</SettingsCard>

<SettingsCard
    title="Local Storage"
    description="Files downloaded for offline use take up space on this device."
>
    {#snippet icon()}
        <Database class="w-6 h-6" />
    {/snippet}
    <div class="space-y-4">
        <div class="p-4 bg-[var(--surface-raised)]/50 rounded-xl">
            {#if storageEstimate?.quota}
                <div class="flex items-center justify-between mb-1 gap-3">
                    <span class="font-semibold text-[var(--text)]">Local Usage</span>
                    <span class="font-mono text-sm shrink-0">{humanSize(storageEstimate.usage || 0)} / {humanSize(storageEstimate.quota)}</span>
                </div>
                <p class="text-xs text-[var(--text-muted)] mb-4 leading-snug">
                    The total is a browser limit for this site on this device — not your cloud plan.
                    It varies by browser, free disk space, and whether storage is persistent.
                </p>
                
                {@const filesPct = storageEstimate.quota > 0 ? (storageUsage / storageEstimate.quota) * 100 : 0}
                {@const otherPct = storageEstimate.quota > 0 ? (((storageEstimate.usage || 0) - storageUsage) / storageEstimate.quota) * 100 : 0}
                {@const isOverLimit = (storageEstimate.usage || 0) > storageEstimate.quota * 0.9}

                <div class="w-full bg-[var(--stroke)] rounded-full h-3 mb-4 flex overflow-hidden">
                    <div class="h-full transition-all {isOverLimit ? 'bg-red-500' : 'bg-blue-500'}" style="width: {filesPct}%"></div>
                    <div class="h-full transition-all {isOverLimit ? 'bg-red-500/60' : 'bg-gray-400'}" style="width: {otherPct}%"></div>
                </div>
                
                <div class="grid grid-cols-2 gap-y-3 gap-x-4 text-sm">
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <div class="w-3 h-3 rounded-full bg-blue-500"></div>
                            <span class="text-[var(--text-muted)]">Files</span>
                        </div>
                        <span class="font-mono">{humanSizeShort(storageUsage)}</span>
                    </div>
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-2">
                            <div class="w-3 h-3 rounded-full bg-gray-400"></div>
                            <span class="text-[var(--text-muted)]">Other Data</span>
                        </div>
                        <span class="font-mono">{humanSizeShort(Math.max(0, (storageEstimate.usage || 0) - storageUsage))}</span>
                    </div>
                </div>
            {:else}
                <div class="flex items-center justify-between">
                    <span class="font-semibold text-[var(--text)]">Local files usage</span>
                    <span class="font-mono">{humanSize(storageUsage)}</span>
                </div>
            {/if}
        </div>

        <div class="p-4 bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-xl text-sm">
            <strong class="block mb-1">Free up space</strong>
            Clears cached files that aren't kept on this device. Files you keep on this device and pending uploads are not affected.
        </div>

        <div class="pt-2 flex flex-col items-start gap-3">
            <Button
                variant="primary"
                size="lg"
                onclick={handleClearStorage}
                disabled={isClearingStorage || storageUsage === 0}
            >
                {#if isClearingStorage}
                    <Loader2 class="w-4 h-4 animate-spin" />
                    <span>Clearing...</span>
                {:else}
                    <Trash2 class="w-4 h-4" />
                    <span>Free up space</span>
                {/if}
            </Button>
            {#if clearStorageMessage}
                <span class="text-sm font-medium {clearStorageMessage.startsWith('Error') ? 'text-[var(--danger)]' : 'text-brand0'}">{clearStorageMessage}</span>
            {/if}
        </div>
    </div>
</SettingsCard>

<SettingsCard
    title="Automatically keep files on this device"
    description="Default for new attachments on this device. You can still change any single file. Saved locally — does not sync to other devices."
>
    {#snippet icon()}
        <Download class="w-6 h-6" />
    {/snippet}
    <div class="space-y-3" data-testid="auto-download-settings">
        {#each [
            {
                value: "always" as const,
                label: "All files",
                desc: "New attachments are kept on this device so they open without internet. Best for desktops and Wi-Fi connections.",
            },
            {
                value: "never" as const,
                label: "None (cloud only)",
                desc: "New attachments stay in the cloud. You can still keep individual files on this device. Best for mobile to save data and storage.",
            },
            {
                value: "small-only" as const,
                label: `Only small files (< ${Math.round(SMALL_FILE_LIMIT_BYTES / 1024 / 1024)} MB)`,
                desc: "Small files are kept on this device automatically; larger files stay in the cloud until you keep them. A good compromise.",
            },
        ] as option}
            <label class="flex items-start gap-3 p-4 rounded-xl border border-[var(--stroke)] hover:bg-[var(--surface-raised)]/50 cursor-pointer transition-colors {autoDownloadPolicy === option.value ? 'bg-[var(--accent-color)]/5 border-[var(--accent-color)]/30' : ''}">
                <input
                    type="radio"
                    name="auto_download"
                    value={option.value}
                    checked={autoDownloadPolicy === option.value}
                    onchange={() => setAutoDownloadPolicy(option.value)}
                    class="radio mt-1"
                />
                <div>
                    <div class="font-semibold text-sm text-[var(--text)]">{option.label}</div>
                    <div class="text-xs text-[var(--text-muted)] mt-0.5">{option.desc}</div>
                </div>
            </label>
        {/each}
    </div>
</SettingsCard>
</div>
