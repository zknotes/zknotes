<script lang="ts">
// Creating the vault. This is where **the vault password is chosen** — and so this
// is where, and nowhere else, the tick box about irrecoverable loss sits.
//
// There are NO terms of service here: those are a legal contract with the operator and live on the
// account origin of an extended deployment. Anyone installing this themselves sees this screen as
// the first registration and carries no pass at all.
import { goto } from "$app/navigation";
import { isServerUnreachableError } from "$lib/core/api/client";
import Button from "$lib/core/ui/Button.svelte";
import LegalFooter from "$lib/core/ui/LegalFooter.svelte";
import { performCreateVault } from "$lib/core/services/auth-service";
import { onMount } from "svelte";

let email = $state("");
let password = $state("");
let confirmPassword = $state("");
let dataLossAcknowledged = $state(false);
let submitting = $state(false);
let error = $state<string | null>(null);

/**
 * The pass arrives in the **fragment** (`#token=…`), not in the query string: a fragment never
 * reaches the server, so it ends up neither in the access logs nor in a `Referer` header.
 */
let token = $state<string | undefined>(undefined);

onMount(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    token = fragment.get("token") ?? undefined;
    const prefill = fragment.get("email");
    if (prefill) email = prefill;

    // Strip the pass out of the address as soon as it is read — so it does not linger in the browser history.
    if (token) history.replaceState(null, "", window.location.pathname);
});

const passwordsMatch = $derived(password.length > 0 && password === confirmPassword);
const canSubmit = $derived(
    !submitting &&
        email.trim().length > 3 &&
        // A deliberately low floor — the form refuses an empty-ish entry and leaves the rest to
        // whoever creates the vault. This line is the whole rule: the server never sees the password
        // (it receives only the derived auth key), so nothing else can enforce a length. Worth
        // knowing before raising or lowering it: the password IS the key (Argon2id → master key),
        // and there is no reset and no recovery, so a short one is a weak vault.
        password.length >= 2 &&
        passwordsMatch &&
        dataLossAcknowledged,
);

async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    submitting = true;
    error = null;
    try {
        await performCreateVault(email.trim(), password, token);
        await goto("/login?created=1");
    } catch (err) {
        if (isServerUnreachableError(err)) {
            error = "Can't reach the server. Check your internet connection and try again.";
        } else {
            error = err instanceof Error ? err.message : "Could not create the vault.";
        }
    } finally {
        submitting = false;
    }
}
</script>

<svelte:head><title>Create your vault</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 p-6">
    <header class="space-y-2">
        <h1 class="text-2xl font-semibold text-[var(--text)]">Create your vault</h1>
        <p class="text-sm text-[var(--text-muted)]">
            Your master password never leaves this device. It is what encrypts your notes.
        </p>
    </header>

    <form class="space-y-4" onsubmit={submit}>
        <input
            class="input w-full"
            type="email"
            placeholder="Email Address"
            autocomplete="username"
            bind:value={email}
            required
        />
        <input
            class="input w-full"
            type="password"
            placeholder="Master Password"
            autocomplete="new-password"
            bind:value={password}
            required
        />
        <input
            class="input w-full"
            type="password"
            placeholder="Confirm Master Password"
            autocomplete="new-password"
            bind:value={confirmPassword}
            required
        />

        {#if confirmPassword.length > 0 && !passwordsMatch}
            <p class="text-xs text-[var(--danger)]">The two passwords do not match.</p>
        {/if}

        <!-- This is NOT a legal acceptance but a fact about the encryption — it holds for
             self-hosting too. -->
        <label
            class="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--stroke)]/50 bg-[var(--surface-raised)]/50 p-3"
        >
            <input
                type="checkbox"
                bind:checked={dataLossAcknowledged}
                required
                data-testid="accept-dataloss"
                class="checkbox mt-0.5"
            />
            <span class="text-xs leading-relaxed text-[var(--text-muted)]">
                <span class="font-medium text-[var(--text)]">I understand:</span>
                if I lose my Master Password, my encrypted data cannot be recovered. There is no
                password reset and no account recovery — this is what zero-knowledge encryption means.
            </span>
        </label>

        {#if error}
            <p class="text-sm text-[var(--danger)]" data-testid="create-vault-error">{error}</p>
        {/if}

        <Button variant="primary" type="submit" disabled={!canSubmit} class="w-full">
            {submitting ? "Creating your vault…" : "Create Secure Vault"}
        </Button>
    </form>
    <LegalFooter class="text-center" />
</main>
