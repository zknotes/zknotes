<script lang="ts">
// The one warning about a weak vault password, shown right above the button that sets it. The form
// stops the first attempt to show it and lets the next one through — never a second warning.
import { TriangleAlert } from "lucide-svelte";

interface Props {
    /** The label of the button that sets the password, so the text can name it. */
    actionLabel: string;
}

let { actionLabel }: Props = $props();
</script>

<div
    class="p-3 rounded-md border border-[var(--warning)]/20 bg-[var(--warning)]/5 flex items-start gap-3"
    role="alert"
    data-testid="weak-password-warning"
>
    <TriangleAlert class="w-4 h-4 mt-0.5 flex-shrink-0 text-[var(--warning)]" />
    <div class="flex-1 space-y-1">
        <p class="text-sm font-medium text-[var(--text)]">This password is weak</p>
        <p class="text-xs text-[var(--text-muted)]">
            Anyone who gets hold of your encrypted data can keep guessing it, with no limit, and
            nobody can reset it for you. Choose a stronger one, or select {actionLabel} again to keep
            this one.
        </p>
    </div>
</div>
