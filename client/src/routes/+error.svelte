<script lang="ts">
import { page } from "$app/state";
import { pageTitle } from "$lib/core/utils/page-title";
import Button from "$lib/core/ui/Button.svelte";

const status = $derived(page.status);
const message = $derived(page.error?.message ?? "Something went wrong");

const isClientBug = $derived(status === 500 || status >= 500);
const headline = $derived(
    status === 404 ? "Page not found" : isClientBug ? "Something went wrong" : "Request failed",
);
const body = $derived(
    status === 404
        ? "That page does not exist or was moved."
        : isClientBug
          ? "The app hit an unexpected error while loading. Try reloading — if it keeps happening, clear site data for this origin or contact support."
          : message,
);
</script>

<svelte:head>
    <title>{pageTitle(headline)}</title>
</svelte:head>

<div
    class="min-h-screen flex items-center justify-center relative overflow-hidden bg-[var(--surface-app)] bg-grid px-4"
>
    <div class="absolute inset-0 bg-gradient-to-br from-brand0/10 to-transparent z-0"></div>
    <div
        class="relative z-10 w-full max-w-md p-8 rounded-2xl bg-[var(--float-bg)] backdrop-blur-md border border-[var(--stroke)] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)] text-center"
    >
        <p class="text-2xs font-mono uppercase tracking-[0.18em] text-brand-fg/80 mb-3">
            Error {status}
        </p>
        <h1 class="text-xl font-semibold text-[var(--text)] mb-2">{headline}</h1>
        <p class="text-sm text-[var(--text-dim)] mb-6 leading-relaxed">{body}</p>

        {#if import.meta.env.DEV && message && isClientBug}
            <pre
                class="mb-6 text-left text-2xs font-mono text-rose-300/90 bg-rose-500/10 border border-rose-500/20 rounded-md p-3 overflow-x-auto max-h-40"
            >{message}</pre>
        {/if}

        <div class="flex flex-col sm:flex-row gap-2 justify-center">
            <Button variant="primary" class="min-w-[8rem]" onclick={() => location.reload()}>
                Reload
            </Button>
            <Button variant="normal" class="min-w-[8rem]" href="/">
                Home
            </Button>
            <Button variant="ghost" class="min-w-[8rem]" href="/login">
                Sign in
            </Button>
        </div>
    </div>
</div>
