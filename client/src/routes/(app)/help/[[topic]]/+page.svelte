<script lang="ts">
import { HardDriveDownload, Link2, Shield, ScrollText } from "lucide-svelte";
import { page } from "$app/state";
import type { LucideIcon } from "$lib/core/types/icons";
import { UtilityCloseButton } from "$lib/core/ui";
import LinkingSection from "./sections/LinkingSection.svelte";
import OfflineSection from "./sections/OfflineSection.svelte";
import SecuritySection from "./sections/SecuritySection.svelte";
import ChangelogSection from "./sections/ChangelogSection.svelte";

type TopicDef = { id: string; label: string; icon: LucideIcon };

const topics = [
    { id: "offline", label: "Offline & PWA", icon: HardDriveDownload },
    { id: "linking", label: "Linking Notes", icon: Link2 },
    { id: "security", label: "Security", icon: Shield },
    { id: "changelog", label: "Changelog", icon: ScrollText },
] as const satisfies readonly TopicDef[];

type TopicId = (typeof topics)[number]["id"];
const TOPIC_IDS = topics.map((t) => t.id) as readonly string[];

let activeTopic = $derived<TopicId>(
    (TOPIC_IDS.includes(page.params.topic ?? "") ? page.params.topic : "offline") as TopicId,
);

function topicHref(id: TopicId): string {
    return id === "offline" ? "/help" : `/help/${id}`;
}
</script>

{#snippet topicLink(topic: (typeof topics)[number], compact: boolean)}
    {@const Icon = topic.icon}
    <a
        href={topicHref(topic.id)}
        class="flex items-center rounded-lg font-medium transition-colors
            {compact ? 'gap-2 px-3 py-1.5 text-xs whitespace-nowrap shrink-0' : 'gap-2.5 px-3 py-2 text-sm text-left w-full'}
            {activeTopic === topic.id
                ? 'bg-brand0/10 text-brand-fg'
                : 'text-[var(--text-muted)] hover:bg-[var(--surface-raised)] hover:text-[var(--text-sub)]'}"
    >
        <Icon class="{compact ? 'w-3.5 h-3.5' : 'w-4 h-4'} shrink-0" />
        {topic.label}
    </a>
{/snippet}

<div class="h-full flex flex-col bg-[var(--surface-panel)]">
    <header class="border-b border-[var(--stroke)] bg-[var(--float-bg)] backdrop-blur-sm sticky top-0 z-20 shrink-0">
        <div class="max-w-5xl mx-auto px-4 sm:px-6 h-12 flex items-center justify-between">
            <h1 class="text-sm font-medium text-[var(--text-sub)]">ZKnotes Help</h1>
            <UtilityCloseButton title="Close help" />
        </div>

        <!-- The mobile navigation — the topics visible without an extra click (better than a dropdown for 2–6 articles) -->
        <nav class="md:hidden border-t border-[var(--stroke)] px-2 py-2 flex gap-1 overflow-x-auto">
            {#each topics as topic}
                {@render topicLink(topic, true)}
            {/each}
        </nav>
    </header>

    <div class="flex flex-1 min-h-0 overflow-hidden">
        <!-- The desktop sidebar — the TOC is always visible -->
        <nav class="hidden md:flex w-52 shrink-0 border-r border-[var(--stroke)] pt-8 pb-6 px-3 flex-col gap-1 overflow-y-auto">
            <p class="text-2xs font-mono uppercase tracking-[0.18em] text-[var(--text-dim)] px-3 mb-3">Topics</p>
            {#each topics as topic}
                {@render topicLink(topic, false)}
            {/each}
        </nav>

        <main class="flex-1 overflow-y-auto pb-20">
            <div class="max-w-3xl mx-auto px-4 sm:px-6 py-8 md:py-10">
                {#if activeTopic === "offline"}
                    <OfflineSection />
                {:else if activeTopic === "linking"}
                    <LinkingSection />
                {:else if activeTopic === "security"}
                    <SecuritySection />
                {:else if activeTopic === "changelog"}
                    <ChangelogSection />
                {/if}
            </div>
        </main>
    </div>
</div>