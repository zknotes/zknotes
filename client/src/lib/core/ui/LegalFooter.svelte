<script lang="ts">
// AGPL-3.0 §13: everyone who uses this instance over the network — share recipients and visitors of
// the sign-in page included, not only signed-in users — must be offered the source of what they are
// served. A runtime value from /instance-config, because a modified instance has to point at its own
// source; with SOURCE_URL unset the link is left out rather than pointing somewhere wrong.
import { onMount } from "svelte";
import { loadInstancePublicConfig } from "$lib/core/constants/public-www";

let { class: className = "" }: { class?: string } = $props();

let sourceUrl = $state<string | undefined>();

onMount(() => {
    void loadInstancePublicConfig().then((cfg) => {
        sourceUrl = cfg.sourceUrl;
    });
});
</script>

<footer class="text-2xs text-[var(--text-muted)] {className}" data-testid="legal-footer">
    ZKnotes v{__APP_VERSION__} · free software under the
    <a
        href="https://www.gnu.org/licenses/agpl-3.0.html"
        target="_blank"
        rel="noopener noreferrer"
        class="underline hover:text-[var(--text)]">GNU AGPL-3.0</a
    >, without any warranty
    {#if sourceUrl}
        ·
        <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="underline hover:text-[var(--text)]"
            data-testid="legal-footer-source">Source code</a
        >
    {/if}
</footer>
