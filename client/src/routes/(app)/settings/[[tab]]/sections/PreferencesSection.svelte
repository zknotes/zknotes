<script lang="ts">
import { Clock } from "lucide-svelte";
import { SectionHeader, SettingsCard } from "$lib/core/ui";
import { dateTimeSettings } from "$lib/core/stores/datetime-settings.svelte";
import { DEFAULT_CUSTOM_DATE_PATTERN } from "$lib/core/utils/date-pattern";
import { formatDate } from "$lib/core/utils/format";

const timeZones = Intl.supportedValuesOf("timeZone");
const previewTs = Math.floor(Date.now() / 1000);

const dateFormatOptions = [
    { value: "system" as const, label: "System" },
    { value: "dd-mm-yyyy" as const, label: "DD/MM/YYYY" },
    { value: "dd-mm-yyyy-dot" as const, label: "DD.MM.YYYY" },
    { value: "mm-dd-yyyy" as const, label: "MM/DD/YYYY" },
    { value: "yyyy-mm-dd" as const, label: "YYYY-MM-DD" },
    { value: "custom" as const, label: "Custom" },
];
</script>

<SectionHeader title="Preferences" description="Editor and display defaults" />

<div class="divide-y divide-[var(--stroke)] text-left">
<SettingsCard
    title="Date & time"
    description="How dates and times are displayed across the app. Saved locally — does not sync to other devices."
>
    {#snippet icon()}
        <Clock class="w-6 h-6" />
    {/snippet}
    <div class="space-y-6 text-left">
        <div>
            <p class="block text-sm font-medium text-[var(--text)] mb-2">Time format</p>
            <div class="space-y-2">
                {#each [
                    { value: "system" as const, label: "System" },
                    { value: "24h" as const, label: "24-hour" },
                    { value: "12h" as const, label: "12-hour" },
                ] as option}
                    <label class="flex items-center gap-3 p-3 rounded-xl border border-[var(--stroke)] hover:bg-[var(--surface-raised)]/50 cursor-pointer transition-colors text-left {dateTimeSettings.timeFormat === option.value ? 'bg-[var(--accent-color)]/5 border-[var(--accent-color)]/30' : ''}">
                        <input
                            type="radio"
                            name="time_format"
                            value={option.value}
                            checked={dateTimeSettings.timeFormat === option.value}
                            onchange={() => dateTimeSettings.setTimeFormat(option.value)}
                            class="radio"
                        />
                        <span class="text-sm font-medium text-[var(--text)]">{option.label}</span>
                    </label>
                {/each}
            </div>
        </div>

        <div>
            <p class="block text-sm font-medium text-[var(--text)] mb-2">Date format</p>
            <div class="space-y-2">
                {#each dateFormatOptions as option}
                    <label class="flex items-center gap-3 p-3 rounded-xl border border-[var(--stroke)] hover:bg-[var(--surface-raised)]/50 cursor-pointer transition-colors text-left {dateTimeSettings.dateFormat === option.value ? 'bg-[var(--accent-color)]/5 border-[var(--accent-color)]/30' : ''}">
                        <input
                            type="radio"
                            name="date_format"
                            value={option.value}
                            checked={dateTimeSettings.dateFormat === option.value}
                            onchange={() => dateTimeSettings.setDateFormat(option.value)}
                            class="radio"
                        />
                        <span class="text-sm font-medium text-[var(--text)]">{option.label}</span>
                    </label>
                {/each}
            </div>

            {#if dateTimeSettings.dateFormat === "custom"}
                <div class="mt-4 space-y-2">
                    <label for="custom-date-pattern" class="block text-sm font-medium text-[var(--text)]">
                        Custom format pattern
                    </label>
                    <input
                        id="custom-date-pattern"
                        type="text"
                        value={dateTimeSettings.customDatePattern}
                        oninput={(e) => dateTimeSettings.setCustomDatePattern(e.currentTarget.value)}
                        placeholder={DEFAULT_CUSTOM_DATE_PATTERN}
                        class="input w-full font-mono"
                    />
                    <p class="text-xs text-[var(--text-muted)]">
                        Tokens: YYYY, YY, MM, DD, HH (24h), hh (12h), mm, ss, A (AM/PM). Example: DD.MM.YYYY HH:mm
                    </p>
                </div>
            {/if}

            <p class="text-xs text-[var(--text-muted)] mt-3">
                Preview: <span class="font-mono text-[var(--text)]">{formatDate(previewTs)}</span>
            </p>
        </div>

        <div>
            <label for="timezone" class="block text-sm font-medium text-[var(--text)] mb-2">Timezone</label>
            <select
                id="timezone"
                value={dateTimeSettings.timezone}
                onchange={(e) => dateTimeSettings.setTimezone(e.currentTarget.value)}
                class="input w-full"
            >
                <option value="system">System</option>
                {#each timeZones as zone}
                    <option value={zone}>{zone}</option>
                {/each}
            </select>
        </div>
    </div>
</SettingsCard>
</div>