<script lang="ts">
import { Loader2, Trash2 } from "lucide-svelte";
import { onMount } from "svelte";
import { goto } from "$app/navigation";
import { getMe } from "$lib/core/api/auth";
import { SettingsCard } from "$lib/core/ui";
import { loadInstancePublicConfig } from "$lib/core/constants/public-www";
import { performDeleteAccount } from "$lib/core/services/auth-service";
import Button from "$lib/core/ui/Button.svelte";

let deletePassword = $state("");
let deleteConfirmText = $state("");
let deleteError = $state("");
let deleteWorking = $state(false);
let showDeleteSection = $state(false);
const DELETE_CONFIRM = "DELETE";

// Which vault this screen deletes. The browser may be signed in to a different vault than the one
// the user has in mind — on a hosted instance the account origin and this origin keep separate
// sessions — so the address is shown, and when the caller says which vault it expects
// (`#email=…` in the fragment, which never reaches the server) a mismatch blocks the deletion.
let vaultEmail = $state<string | undefined>();
let expectedEmail = $state<string | undefined>();
const wrongVault = $derived(
    !!expectedEmail && !!vaultEmail && expectedEmail.toLowerCase() !== vaultEmail.toLowerCase(),
);

onMount(() => {
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    expectedEmail = fragment.get("email")?.trim() || undefined;
    getMe()
        .then((me) => {
            vaultEmail = me.email;
        })
        .catch(() => {
            vaultEmail = undefined;
        });
});

async function deleteAccount() {
    deleteError = "";
    if (wrongVault) {
        deleteError = `This browser is signed in to the vault for ${vaultEmail}, not ${expectedEmail}.`;
        return;
    }
    if (deleteConfirmText !== DELETE_CONFIRM) {
        deleteError = `Type "${DELETE_CONFIRM}" to confirm.`;
        return;
    }
    if (!deletePassword) {
        deleteError = "Password is required.";
        return;
    }
    deleteWorking = true;
    try {
        // Where to go afterwards is decided before the vault is gone, while the server is still
        // certainly reachable. On a hosted instance the vault lived under an account that is still
        // there — the user goes back to it (to create a new vault, or to close the account), because
        // the sign-in screen would have nothing left to sign in to. A self-hosted instance has no
        // account layer, so it goes to the sign-in screen as before.
        const manageUrl = (await loadInstancePublicConfig()).account?.manageUrl;
        await performDeleteAccount(deletePassword);
        if (manageUrl) {
            window.location.assign(manageUrl);
        } else {
            goto("/login");
        }
    } catch (e: unknown) {
        deleteError = e instanceof Error ? e.message : "An error occurred.";
    } finally {
        deleteWorking = false;
    }
}
</script>

<div class="mb-8">
    <h1 class="text-2xl font-bold text-[var(--text)]">Delete vault</h1>
    <p class="text-[var(--text-muted)] mt-1 text-sm">Permanently remove this vault and everything in it</p>
</div>

<div class="divide-y divide-[var(--stroke)]">
<SettingsCard
    tone="destructive"
    title="This is permanent"
    description="Deletes all your notes, files and settings in this vault. There is no way to undo this."
>
    {#snippet icon()}
        <Trash2 class="w-6 h-6" />
    {/snippet}
    {#if vaultEmail}
        <p class="text-sm text-[var(--text-muted)] mb-3">
            Signed in as <strong class="text-[var(--text)]">{vaultEmail}</strong> — this deletes that vault.
        </p>
    {/if}
    {#if wrongVault}
        <div class="p-3 bg-[var(--danger)]/10 text-[var(--danger)] text-sm rounded-xl border border-[var(--danger)]/20 mb-3">
            You came here to delete the vault for <strong>{expectedEmail}</strong>, but this browser is
            signed in to the vault for <strong>{vaultEmail}</strong>. Sign out, sign in to
            {expectedEmail}, then come back.
        </div>
    {/if}
    {#if !showDeleteSection}
        <Button
            variant="danger-ghost"
            size="lg"
            disabled={wrongVault}
            onclick={() => (showDeleteSection = true)}
        >Delete vault…</Button>
    {:else}
        <div class="space-y-4 mt-4">
            {#if deleteError}
                <div class="p-3 bg-[var(--danger)]/10 text-[var(--danger)] text-sm rounded-xl border border-[var(--danger)]/20">{deleteError}</div>
            {/if}
            <div>
                <label for="delete-password" class="block text-sm font-medium text-[var(--text)] mb-1.5">Current password</label>
                <input
                    id="delete-password"
                    type="password"
                    bind:value={deletePassword}
                    placeholder="Enter your password to confirm"
                    class="input input-danger w-full"
                />
            </div>
            <div>
                <label for="delete-confirm" class="block text-sm font-medium text-[var(--text)] mb-1.5">
                    Type <code class="font-mono text-[var(--danger)]">{DELETE_CONFIRM}</code> to confirm
                </label>
                <input
                    id="delete-confirm"
                    type="text"
                    bind:value={deleteConfirmText}
                    placeholder={DELETE_CONFIRM}
                    class="input input-danger w-full"
                />
            </div>
            <div class="flex gap-3">
                <Button
                    variant="danger"
                    size="lg"
                    onclick={deleteAccount}
                    disabled={wrongVault || deleteWorking || deleteConfirmText !== DELETE_CONFIRM || !deletePassword}
                >
                    {#if deleteWorking}
                        <Loader2 class="w-4 h-4 animate-spin" /> Deleting…
                    {:else}
                        <Trash2 class="w-4 h-4" /> Permanently delete vault
                    {/if}
                </Button>
                <Button
                    variant="normal"
                    size="lg"
                    onclick={() => { showDeleteSection = false; deletePassword = ""; deleteConfirmText = ""; deleteError = ""; }}
                >Cancel</Button>
            </div>
        </div>
    {/if}
</SettingsCard>
</div>
