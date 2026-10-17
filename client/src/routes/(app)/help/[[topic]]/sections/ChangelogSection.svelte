<script lang="ts">
// @ts-expect-error
import changelog from "virtual:changelog";
import { formatDate } from "$lib/core/utils/format";
</script>

<div class="max-w-none">
    <h2 class="text-2xl font-semibold mb-6 text-[var(--text)] border-b border-[var(--stroke)] pb-4">
        Changelog
    </h2>

    {#if changelog.length === 0}
        <p class="text-[var(--text-muted)] text-sm">No entries.</p>
    {:else}
        <div class="space-y-10">
            {#each changelog as entry}
                <div>
                    <h3 class="text-lg font-bold mb-4 flex items-baseline gap-2 text-[var(--text)]">
                        {entry.version}
                        {#if entry.date}
                            <span class="text-xs font-normal opacity-50">— {formatDate(Math.floor(new Date(entry.date).getTime() / 1000))}</span>
                        {/if}
                    </h3>
                    <div class="space-y-6">
                        {#each entry.sections as section}
                            <div>
                                <h4 class="text-2xs font-semibold uppercase tracking-wider opacity-60 mb-2 mt-0 text-[var(--text)]">
                                    {section.category}
                                </h4>
                                <ul class="list-disc list-outside ml-4 space-y-1 text-sm text-[var(--text-sub)] m-0">
                                    {#each section.items as item}
                                        <li class="pl-1">{item}</li>
                                    {/each}
                                </ul>
                            </div>
                        {/each}
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</div>
