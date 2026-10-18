<script lang="ts">
// The advice and the strength meter under a new vault password. Advice only: it never blocks a
// password — the form warns once about a weak one (WeakPasswordWarning) and then lets it through.
import {
    type PasswordStrengthLevel,
    type PasswordWeakness,
    passwordStrength,
    RECOMMENDED_PASSWORD_LENGTH,
} from "$lib/core/utils/password-strength";

interface Props {
    password: string;
    /** Point the password input's `aria-describedby` at this. */
    id?: string;
    class?: string;
}

let { password, id, class: className = "" }: Props = $props();

const strength = $derived(passwordStrength(password));

const LABEL: Record<PasswordStrengthLevel, string> = {
    weak: "Weak",
    fair: "Fair",
    strong: "Strong",
};

const FILLED: Record<PasswordStrengthLevel, number> = { weak: 1, fair: 2, strong: 3 };

// Written out in full so Tailwind finds the classes.
const COLOR: Record<PasswordStrengthLevel, string> = {
    weak: "bg-[var(--danger)]",
    fair: "bg-[var(--warning)]",
    strong: "bg-[var(--success)]",
};

const ADVICE: Record<PasswordWeakness, string> = {
    common: "Well-known passwords are the first ones an attacker tries.",
    pattern: "Repeats and runs like aaaa or 1234 are the first ones an attacker tries.",
    short: `Longer is stronger — aim for ${RECOMMENDED_PASSWORD_LENGTH} characters or more.`,
    "few-kinds": "Make it longer, or mix in capitals, numbers and symbols.",
};
</script>

<div {id} class="space-y-1.5 {className}" data-testid="password-strength">
    <p class="text-xs text-[var(--text-muted)]">
        Use {RECOMMENDED_PASSWORD_LENGTH} or more characters. Four random words — like “lamp river
        cactus tuesday” — are easy to remember and hard to guess.
    </p>
    {#if password.length > 0}
        <div class="flex gap-1" aria-hidden="true">
            {#each [1, 2, 3] as segment (segment)}
                <div
                    class="h-1 flex-1 rounded-full {segment <= FILLED[strength.level]
                        ? COLOR[strength.level]
                        : 'bg-[var(--stroke)]'}"
                ></div>
            {/each}
        </div>
    {/if}
    <!-- Always rendered: a live region has to exist before its text changes to be announced. -->
    <p class="text-xs text-[var(--text-muted)]" aria-live="polite" data-strength={password.length > 0 ? strength.level : undefined}>
        {#if password.length > 0}
            <span class="font-medium text-[var(--text)]">{LABEL[strength.level]}</span>
            {#if strength.weakness}— {ADVICE[strength.weakness]}{/if}
        {/if}
    </p>
</div>
