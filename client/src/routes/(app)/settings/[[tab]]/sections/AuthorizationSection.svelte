<script lang="ts">
import { CreditCard, ExternalLink, KeyRound, Loader2 } from "lucide-svelte";
import { onMount } from "svelte";
import { SettingsCard } from "$lib/core/ui";
import Button from "$lib/core/ui/Button.svelte";
import PasswordStrength from "$lib/core/ui/PasswordStrength.svelte";
import WeakPasswordWarning from "$lib/core/ui/WeakPasswordWarning.svelte";
import { getStorage } from "$lib/core/api/files";
import { loadInstancePublicConfig } from "$lib/core/constants/public-www";
import { performChangePassword } from "$lib/core/services/auth-service";
import { passwordStrength } from "$lib/core/utils/password-strength";

let currentPassword = $state("");
let newPassword = $state("");
let confirmPassword = $state("");

let error = $state("");
let success = $state(false);
let isWorking = $state(false);
let progressMessage = $state("");
let understandConsequences = $state(false);
let showDownloadPrompt = $state(false);
/** Set by the first attempt with a weak new password; the next attempt goes through. */
let weakPasswordWarned = $state(false);
const weakPassword = $derived(passwordStrength(newPassword).level === "weak");

const SUBMIT_LABEL = "Change password";

// The vault may show only the plan's label and a link to the account. A self-hosted instance has
// neither, so it shows no plan at all — not a loading state, not an error about a plan it never had.
type PlanView = {
    planLabel: string | null;
    manageUrl: string | undefined;
};
let planView = $state<PlanView | null>(null);
let hasPlan = $derived(planView !== null && (planView.planLabel !== null || !!planView.manageUrl));

onMount(() => {
    void (async () => {
        const [storageResult, configResult] = await Promise.allSettled([
            getStorage(),
            loadInstancePublicConfig(),
        ]);
        const manageUrl =
            configResult.status === "fulfilled" ? configResult.value.account?.manageUrl : undefined;
        if (storageResult.status !== "fulfilled") {
            planView = manageUrl ? { planLabel: null, manageUrl } : null;
            return;
        }
        const raw = storageResult.value.plan_label;
        const planLabel = typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
        planView = { planLabel, manageUrl };
    })();
});

async function changePassword() {
    if (!currentPassword || !newPassword || !confirmPassword) {
        error = "All fields are required";
        return;
    }
    if (!understandConsequences) {
        error = "You must confirm that you understand the consequences of changing your password.";
        return;
    }
    if (newPassword !== confirmPassword) {
        error = "New passwords do not match";
        return;
    }
    // One warning, never more: the first attempt with a weak password stops here to show it.
    if (weakPassword && !weakPasswordWarned) {
        weakPasswordWarned = true;
        error = "";
        return;
    }

    error = "";
    success = false;
    isWorking = true;

    try {
        await performChangePassword({
            currentPassword,
            newPassword,
            onProgress: (msg) => {
                progressMessage = msg;
            },
        });
        success = true;
        showDownloadPrompt = true;
        currentPassword = "";
        newPassword = "";
        confirmPassword = "";
        understandConsequences = false;
        weakPasswordWarned = false;
    } catch (e: unknown) {
        error = e instanceof Error ? e.message : "An error occurred";
    } finally {
        isWorking = false;
        progressMessage = "";
    }
}
</script>

<div class="mb-8">
    <h1 class="text-2xl font-bold text-[var(--text)]">Account</h1>
    <p class="text-[var(--text-muted)] mt-1 text-sm">
        {hasPlan ? "Your plan and account security" : "Your account security"}
    </p>
</div>

<div class="divide-y divide-[var(--stroke)]">
{#if planView && hasPlan}
<SettingsCard title="Plan" description="Your current plan.">
    {#snippet icon()}
        <CreditCard class="w-6 h-6" />
    {/snippet}
    <div class="flex flex-wrap items-center gap-3">
        {#if planView.planLabel}
            <span
                class="inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold bg-[var(--surface-raised)] text-[var(--text)] border border-[var(--stroke)]"
            >
                {planView.planLabel}
            </span>
        {/if}
        {#if planView.manageUrl}
            <a
                href={planView.manageUrl}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-1.5 text-sm text-[var(--accent-color)] hover:underline"
            >
                Manage account
                <ExternalLink class="w-3.5 h-3.5" />
                <span class="text-xs text-[var(--text-muted)]">(opens in a new tab)</span>
            </a>
        {/if}
    </div>
</SettingsCard>
{/if}

<SettingsCard
    title="Change Master Password"
    description="Changing your password re-encrypts only the Vault Key — your notes remain untouched."
>
    {#snippet icon()}
        <KeyRound class="w-6 h-6" />
    {/snippet}
    <form onsubmit={(e) => { e.preventDefault(); changePassword(); }} class="space-y-5">
        <!-- Hidden username field to satisfy browser accessibility warnings -->
        <input type="text" autocomplete="username" class="hidden" value="zknotes-user" aria-hidden="true" />
        {#if error}
            <div class="p-4 bg-[var(--danger)]/10 text-[var(--danger)] text-sm rounded-xl border border-[var(--danger)]/20 font-medium">
                {error}
            </div>
        {/if}
        {#if success}
            <div class="p-4 bg-brand0/10 text-brand0 text-sm rounded-xl border border-brand0/20 font-medium">
                <div class="flex items-center gap-2 mb-2">
                    <span class="text-xl">✅</span>
                    <span>Password changed successfully!</span>
                </div>
                {#if showDownloadPrompt}
                    <div class="mt-4 pt-4 border-t border-brand0/20">
                        <p class="mb-4">Your existing backups are unaffected — they use a separate passphrase. Want to create a fresh backup now?</p>
                        <div class="flex items-center gap-3">
                            <a
                                href="/settings/backup"
                                onclick={() => { showDownloadPrompt = false; }}
                                class="bg-brand0 hover:bg-brand0 text-white px-4 py-2 rounded-lg font-semibold transition-colors shadow-sm"
                            >
                                Go to Backup
                            </a>
                            <Button
                                variant="ghost"
                                onclick={() => { showDownloadPrompt = false; }}
                                class="!text-brand0 hover:!bg-brand0/10"
                            >
                                Later
                            </Button>
                        </div>
                    </div>
                {/if}
            </div>
        {/if}

        <div class="space-y-4">
            <div>
                <label for="currentPassword" class="block text-sm font-medium text-[var(--text)] mb-1.5 ml-1">Current password</label>
                <input
                    id="currentPassword"
                    type="password"
                    autocomplete="current-password"
                    bind:value={currentPassword}
                    disabled={isWorking}
                    class="input w-full"
                    placeholder="Enter your current password"
                />
            </div>
            <div>
                <label for="newPassword" class="block text-sm font-medium text-[var(--text)] mb-1.5 ml-1">New password</label>
                <input
                    id="newPassword"
                    type="password"
                    autocomplete="new-password"
                    aria-describedby="new-password-strength"
                    bind:value={newPassword}
                    disabled={isWorking}
                    class="input w-full"
                    placeholder="New password"
                />
                <PasswordStrength password={newPassword} id="new-password-strength" class="mt-2 ml-1" />
            </div>
            <div>
                <label for="confirmPassword" class="block text-sm font-medium text-[var(--text)] mb-1.5 ml-1">Confirm new password</label>
                <input
                    id="confirmPassword"
                    type="password"
                    autocomplete="new-password"
                    bind:value={confirmPassword}
                    disabled={isWorking}
                    class="input w-full"
                    placeholder="Repeat new password"
                />
            </div>

            <div class="flex items-start gap-3 p-4 bg-[var(--danger)]/5 rounded-xl border border-[var(--danger)]/20 mt-4">
                <input
                    type="checkbox"
                    id="understandConsequences"
                    bind:checked={understandConsequences}
                    disabled={isWorking}
                    class="checkbox mt-1 shrink-0"
                />
                <label for="understandConsequences" class="text-sm font-medium text-[var(--danger)] leading-tight cursor-pointer select-none">
                    <span class="block font-bold mb-1">If the new password is forgotten, the vault cannot be unlocked — there is no recovery.</span>
                    Backups use a separate passphrase and are not affected by this change.
                </label>
            </div>
            <p class="text-xs text-[var(--text-muted)] mt-2">
                Curious what happens to your keys? <a href="/help/security" class="text-[var(--accent-color)] hover:underline">Learn how key derivation works →</a>
            </p>
        </div>

        <div class="pt-4 space-y-4">
            {#if weakPasswordWarned && weakPassword}
                <WeakPasswordWarning actionLabel={SUBMIT_LABEL} />
            {/if}
            <Button
                variant="primary"
                type="submit"
                size="lg"
                disabled={isWorking}
                class="w-full rounded-xl font-semibold shadow-md hover:shadow-lg"
            >
                {#if isWorking}
                    <Loader2 class="w-5 h-5 animate-spin" />
                    <span>{progressMessage}</span>
                {:else}
                    {SUBMIT_LABEL}
                {/if}
            </Button>
        </div>
    </form>
</SettingsCard>
</div>
