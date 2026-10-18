<script lang="ts">
import { Loader2, Trash2 } from "lucide-svelte";
import { goto } from "$app/navigation";
import { SettingsCard } from "$lib/core/ui";
import { performDeleteAccount } from "$lib/core/services/auth-service";
import Button from "$lib/core/ui/Button.svelte";

let deletePassword = $state("");
let deleteConfirmText = $state("");
let deleteError = $state("");
let deleteWorking = $state(false);
let showDeleteSection = $state(false);
const DELETE_CONFIRM = "DELETE";

async function deleteAccount() {
    deleteError = "";
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
        await performDeleteAccount(deletePassword);
        goto("/login");
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
    {#if !showDeleteSection}
        <Button
            variant="danger-ghost"
            size="lg"
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
                    disabled={deleteWorking || deleteConfirmText !== DELETE_CONFIRM || !deletePassword}
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
