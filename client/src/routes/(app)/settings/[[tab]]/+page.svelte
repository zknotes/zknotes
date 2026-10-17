<script lang="ts">
import {
    Database,
    HardDriveDownload,
    Info,
    KeyRound,
    Palette,
    Link2,
    SlidersHorizontal,
    Smartphone,
    Trash2,
} from "lucide-svelte";
import { page } from "$app/state";
import { settingsLastTabStore } from "$lib/core/stores/settings-last-tab.svelte";
import type { LucideIcon } from "$lib/core/types/icons";
import { UtilityCloseButton } from "$lib/core/ui";
import AppearanceSection from "./sections/AppearanceSection.svelte";
import AppInfoSection from "./sections/AppInfoSection.svelte";
import AuthorizationSection from "./sections/AuthorizationSection.svelte";
import BackupSection from "./sections/BackupSection.svelte";
import DeleteAccountSection from "./sections/DeleteAccountSection.svelte";
import PreferencesSection from "./sections/PreferencesSection.svelte";
import SessionsSection from "./sections/SessionsSection.svelte";
import StorageSection from "./sections/StorageSection.svelte";
import SharedLinksSection from "./sections/SharedLinksSection.svelte";

type TabDef = { id: string; label: string; icon: LucideIcon };

const tabs = [
    { id: "authorization", label: "Account", icon: KeyRound },
    { id: "sessions", label: "Sessions", icon: Smartphone },
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "storage", label: "Storage", icon: Database },
    { id: "shared-links", label: "Shared links", icon: Link2 },
    { id: "backup", label: "Backup & Export", icon: HardDriveDownload },
    { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
    { id: "app-info", label: "About", icon: Info },
    { id: "delete-account", label: "Delete Account", icon: Trash2 },
] as const satisfies readonly TabDef[];

type TabId = (typeof tabs)[number]["id"];
const TAB_IDS = tabs.map((t) => t.id) as readonly string[];
// The active tab derived from the URL parameter — deep links, back/forward and refresh all work.
let activeTab = $derived<TabId>(
    (TAB_IDS.includes(page.params.tab ?? "") ? page.params.tab : "authorization") as TabId,
);
/** A section's URL; the default tab lives at a bare /settings. */
function tabHref(id: TabId): string {
    return id === "authorization" ? "/settings" : `/settings/${id}`;
}

// Remember the last tab for this browser session (the sidebar's gear opens the same one).
$effect(() => {
    settingsLastTabStore.remember(tabHref(activeTab));
});
</script>

<div class="h-full flex flex-col relative">
    <!-- The mobile header: close + the tabs in one shrink-0 block (the content does not scroll underneath) -->
    <header
        class="md:hidden shrink-0 z-20 border-b border-[var(--stroke)] bg-[var(--surface-app)]"
    >
        <div class="flex justify-end px-3 pt-3 pb-1">
            <UtilityCloseButton />
        </div>
        <nav class="px-2 py-2 flex gap-1 overflow-x-auto">
            {#each tabs as tab}
                {@const isActive = activeTab === tab.id}
                {@const Icon = tab.icon}
                <a
                    href={tabHref(tab.id)}
                    class="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium transition-all whitespace-nowrap shrink-0
                        {isActive
                            ? tab.id === 'delete-account'
                                ? 'bg-[var(--danger)]/10 text-[var(--danger)]'
                                : 'bg-[var(--accent-color)]/10 text-[var(--accent-color)]'
                            : 'text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]'}"
                >
                    <Icon class="w-4 h-4 shrink-0" />
                    {tab.label}
                </a>
            {/each}
        </nav>
    </header>

    <!-- Desktop close (utility return stack) -->
    <div class="hidden md:block absolute top-3 right-3 z-20">
        <UtilityCloseButton />
    </div>

    <div class="flex flex-1 min-h-0 overflow-hidden" data-testid="settings-layout">
        <!-- Desktop sidebar -->
        <nav
            class="hidden md:flex w-52 shrink-0 border-r border-[var(--stroke)] pt-10 pb-6 px-3 flex-col gap-1 overflow-y-auto"
        >
            <p class="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-widest px-3 mb-3">
                Settings
            </p>
            {#each tabs as tab}
                {@const isActive = activeTab === tab.id}
                {@const Icon = tab.icon}
                <a
                    href={tabHref(tab.id)}
                    class="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left w-full
                        {isActive
                            ? tab.id === 'delete-account'
                                ? 'bg-[var(--danger)]/10 text-[var(--danger)]'
                                : 'bg-[var(--accent-color)]/10 text-[var(--accent-color)]'
                            : 'text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text)]'}"
                >
                    <Icon class="w-4 h-4 shrink-0" />
                    {tab.label}
                </a>
            {/each}
        </nav>

        <!-- The content — its own scroll, and it does not run under the menu -->
        <div class="flex-1 overflow-y-auto min-h-0">
            <div
                class="w-full py-6 md:py-10 px-4 md:px-8 text-left {activeTab === 'shared-links'
                    ? 'max-w-6xl'
                    : 'max-w-3xl'}"
            >
                {#if activeTab === "authorization"}
                    <AuthorizationSection />
                {:else if activeTab === "sessions"}
                    <SessionsSection />
                {:else if activeTab === "appearance"}
                    <AppearanceSection />
                {:else if activeTab === "preferences"}
                    <PreferencesSection />
                {:else if activeTab === "storage"}
                    <StorageSection />
                {:else if activeTab === "shared-links"}
                    <SharedLinksSection />
                {:else if activeTab === "backup"}
                    <BackupSection />
                {:else if activeTab === "app-info"}
                    <AppInfoSection />
                {:else if activeTab === "delete-account"}
                    <DeleteAccountSection />
                {/if}
            </div>
        </div>
    </div>
</div>
