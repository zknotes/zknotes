<script lang="ts">
import Button from "./Button.svelte";

let {
    variant,
    message,
    action,
    onDismiss,
}: {
    variant: "error" | "info" | "success";
    message: string;
    action?: { label: string; onClick: () => void };
    onDismiss: () => void;
} = $props();
</script>

<div class="toast toast-{variant} pointer-events-auto items-start">
    <span class="toast-icon text-lg leading-none flex-shrink-0 mt-0.5">
        {variant === "error" ? "⚠" : variant === "success" ? "✓" : "ℹ"}
    </span>
    <span class="text-sm flex-1 min-w-0 break-all">{message}</span>
    {#if action}
        <Button
            variant="ghost"
            class="toast-action !h-auto !p-0 text-sm font-medium uppercase tracking-wider shrink-0 mt-0.5"
            onclick={() => {
                action!.onClick();
                onDismiss();
            }}
        >
            {action.label}
        </Button>
    {/if}
    <Button
        variant="ghost"
        onclick={onDismiss}
        class="toast-dismiss !h-auto !p-0 text-lg leading-none flex-shrink-0 mt-0.5"
        aria-label="Dismiss"
    >×</Button>
</div>