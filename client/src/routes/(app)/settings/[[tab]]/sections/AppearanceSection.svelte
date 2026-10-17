<script lang="ts">
import { Check, Palette } from "lucide-svelte";
import { SettingsCard } from "$lib/core/ui";
import { themeStore } from "$lib/core/stores/theme.svelte";
import { THEME_PRESETS } from "$lib/core/constants/theme-presets";
</script>

<div class="mb-8">
    <h1 class="text-2xl font-bold text-[var(--text)]">Appearance</h1>
    <p class="text-[var(--text-muted)] mt-1 text-sm">Theme and visual preferences</p>
</div>

<div class="divide-y divide-[var(--stroke)]">
    <SettingsCard title="Theme" description="Choose the color theme used across the app.">
        {#snippet icon()}
            <Palette class="w-6 h-6" />
        {/snippet}
        <div
            class="space-y-3"
            data-testid="theme-settings"
            role="radiogroup"
            aria-label="Color theme"
        >
            {#each THEME_PRESETS as t (t.id)}
                {@const selected = themeStore.current === t.id}
                <!-- UX: raw button — per-theme inline colors need full style control (v. ThemePicker) -->
                <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={t.label}
                    onclick={() => themeStore.set(t.id)}
                    class="flex w-full items-stretch gap-3 rounded-xl border-2 p-3 text-left transition-[border-color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-color)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-app)]"
                    style="
                        background: {t.preview.panel};
                        border-color: {selected ? t.preview.accent : t.preview.stroke};
                        color: {t.preview.text};
                        box-shadow: {selected ? `0 0 0 1px ${t.preview.accent}` : 'none'};
                    "
                >
                    <!-- Mini app chrome: sidebar + content + accent -->
                    <div
                        class="flex h-12 w-[4.5rem] shrink-0 overflow-hidden rounded-md border"
                        style="border-color: {t.preview.stroke}; background: {t.preview.app}"
                        aria-hidden="true"
                    >
                        <div
                            class="flex w-4 flex-col gap-1 border-r p-1"
                            style="background: {t.preview.panel}; border-color: {t.preview.stroke}"
                        >
                            <span
                                class="h-1 w-full rounded-sm"
                                style="background: {t.preview.raised}"
                            ></span>
                            <span
                                class="h-1 w-full rounded-sm"
                                style="background: {t.preview.raised}"
                            ></span>
                            <span
                                class="mt-auto h-1.5 w-1.5 rounded-sm"
                                style="background: {t.preview.accent}"
                            ></span>
                        </div>
                        <div class="flex flex-1 flex-col gap-1 p-1.5">
                            <span
                                class="h-1.5 rounded-sm"
                                style="width: 75%; background: {t.preview.raised}"
                            ></span>
                            <span
                                class="h-1.5 rounded-sm"
                                style="width: 50%; background: {t.preview.raised}"
                            ></span>
                            <span
                                class="mt-auto h-1.5 w-4 rounded-sm"
                                style="background: {t.preview.accent}"
                            ></span>
                        </div>
                    </div>

                    <div class="min-w-0 flex-1 self-center">
                        <div class="flex items-center gap-2 text-sm font-semibold">
                            {t.label}
                            {#if selected}
                                <Check class="h-3.5 w-3.5 shrink-0" style="color: {t.preview.accent}" />
                            {/if}
                        </div>
                        <div class="mt-0.5 text-xs" style="color: {t.preview.textMuted}">
                            {t.desc}
                        </div>
                    </div>
                </button>
            {/each}
        </div>
    </SettingsCard>
</div>
