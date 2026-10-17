<script lang="ts">
import { Info, Shield } from "lucide-svelte";
import { onMount } from "svelte";
import { SettingsCard } from "$lib/core/ui";
import Button from "$lib/core/ui/Button.svelte";
import { loadInstancePublicConfig } from "$lib/core/constants/public-www";
import { pwaStore } from "$lib/core/stores";

let wwwUrl = $state<string | undefined>();
// AGPL: shipping the client is *conveying*, so the user must be able to reach the source of what is
// being served to them. A runtime value, because a modified instance has to point at
// its own source.
let sourceUrl = $state<string | undefined>();

onMount(() => {
    void loadInstancePublicConfig().then((cfg) => {
        wwwUrl = cfg.wwwUrl;
        sourceUrl = cfg.sourceUrl;
    });
});
</script>

<div class="mb-8">
    <h1 class="text-2xl font-bold text-[var(--text)]">About</h1>
    <p class="text-[var(--text-muted)] mt-1 text-sm">Version, links, and account details</p>
</div>

<div class="space-y-6">
    {#if typeof window !== "undefined" && !window.SharedWorker}
        <div class="p-4 bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-xl flex items-start gap-3">
            <span class="text-xl">⚠️</span>
            <div class="text-sm">
                <strong class="block mb-1">Browser compatibility notice</strong>
                Your browser does not support background processes (SharedWorker). Due to the zero-knowledge architecture,
                <strong>you will need to log in again after every page refresh.</strong>
            </div>
        </div>
    {/if}

    <div class="divide-y divide-[var(--stroke)]">
    <SettingsCard title="About ZKnotes" description="v{__APP_VERSION__}">
        {#snippet icon()}
            <Info class="w-6 h-6" />
        {/snippet}
        <div class="space-y-4">
            <div>
                <p class="text-xs text-[var(--text-muted)]">
                    Free software under the
                    <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer" class="underline hover:text-[var(--text)]">GNU AGPL-3.0</a>,
                    provided without any warranty.
                </p>
                <p class="text-xs text-[var(--text-muted)] mt-1">Build date: {new Date(__BUILD_DATE__).toLocaleString()}</p>
                <p class="text-2xs font-mono text-[var(--text-muted)] opacity-50 mt-1">commit: {__COMMIT_HASH__}</p>
            </div>
            <div class="flex gap-4 text-sm text-[var(--accent-color)]">
                <a href="/help/changelog" class="hover:underline" id="about-changelog-btn">Changelog</a>
                {#if wwwUrl}
                    <a href="{wwwUrl}/about" target="_blank" rel="noopener noreferrer" class="hover:underline">How it works</a>
                    <a href="{wwwUrl}/privacy" target="_blank" rel="noopener noreferrer" class="hover:underline">Privacy</a>
                    <a href="{wwwUrl}/terms" target="_blank" rel="noopener noreferrer" class="hover:underline">Terms</a>
                {/if}
                {#if sourceUrl}
                    <a href={sourceUrl} target="_blank" rel="noopener noreferrer" class="hover:underline" id="about-source-btn">Source</a>
                {/if}
            </div>
        </div>
    </SettingsCard>

    <SettingsCard title="Security" description="Zero-knowledge, end-to-end encrypted.">
        {#snippet icon()}
            <Shield class="w-6 h-6" />
        {/snippet}
        <p class="text-sm text-[var(--text-muted)] mb-3">
            Your notes are encrypted on your device before they ever reach our servers — we cannot read them.
        </p>
        <a href="/help/security" class="text-sm text-[var(--accent-color)] hover:underline">Security details →</a>
    </SettingsCard>
    </div>

    {#if pwaStore.deferredPrompt}
        <div class="p-3 bg-[var(--accent-color)]/5 border border-[var(--accent-color)]/15 text-[var(--text-muted)] rounded-xl flex items-center justify-between gap-3 text-sm">
            <span>Install ZKnotes for a better offline experience.</span>
            <Button
                variant="normal"
                size="sm"
                onclick={() => pwaStore.promptInstall()}
                class="whitespace-nowrap shrink-0"
            >
                Install
            </Button>
        </div>
    {/if}
</div>