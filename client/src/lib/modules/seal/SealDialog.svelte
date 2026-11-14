<script lang="ts">
// Sealing one file. The first seal on an account asks for an explicit acknowledgement that the
// record is permanent, before anything is sent.
import { Loader2, ShieldCheck } from "lucide-svelte";
import { Button, Callout, Checkbox, Dialog, DialogActions, ErrorText } from "$lib/core/ui";
import type { FilePanelFile } from "$lib/core/events/file-panel-extensions";
import { SealError, type SealView, sealFile } from "./seal-service";

interface Props {
    file: FilePanelFile;
    /** No seal exists on this account yet: the permanence acknowledgement is required. */
    firstSeal: boolean;
    onClose: () => void;
    onSealed: (view: SealView) => void;
}
const { file, firstSeal, onClose, onSealed }: Props = $props();

let acknowledged = $state(false);
let running = $state(false);
let phase = $state("");
let error = $state<string | null>(null);

const canSeal = $derived(!running && (!firstSeal || acknowledged));

async function onSeal() {
    if (!canSeal) return;
    running = true;
    error = null;
    try {
        const view = await sealFile(file.id, (p, done, total) => {
            if (p === "hashing") {
                phase =
                    total && total > 1
                        ? `Reading the file ${(done ?? 0) + 1}/${total}…`
                        : "Reading the file…";
            } else if (p === "stamping") {
                phase = "Asking the timestamp services…";
            } else {
                phase = "Saving the seal…";
            }
        });
        onSealed(view);
    } catch (e) {
        error =
            e instanceof SealError
                ? e.code === "limit" && e.limit !== undefined
                    ? `You have reached today's limit of ${e.limit} seals. Try again tomorrow.`
                    : e.message
                : e instanceof Error
                  ? e.message
                  : "Sealing failed";
    } finally {
        running = false;
        phase = "";
    }
}
</script>

<Dialog title="Seal this file" onBackdropClick={running ? undefined : onClose}>
    {#snippet children()}
        <div class="space-y-3 text-xs text-[var(--text-muted)]" data-testid="seal-dialog">
            <p>
                A seal is independent proof that <strong class="text-[var(--text)]">this exact file existed before</strong>
                a point in time. Anyone can check it later with free, standard tools, without this app.
            </p>
            <p>
                It does not prove who made the file, that its content is true, or when it was first
                created. Changing even one byte makes a different file, which the seal does not cover.
            </p>
            <p>
                Confirmation usually comes within a few hours. Keep ZKnotes open now and then until the
                seal shows as sealed.
            </p>
            {#if firstSeal}
                <Callout variant="warning" size="sm">
                    <label class="flex items-start gap-2 cursor-pointer">
                        <Checkbox bind:checked={acknowledged} class="mt-0.5" data-testid="seal-ack" />
                        <span>
                            <strong>I understand this action is permanent.</strong> A cryptographic
                            proof (hash) will be irreversibly recorded on the public Bitcoin network and
                            cannot be deleted. The contents of your file remain completely private and
                            are never sent anywhere.
                        </span>
                    </label>
                </Callout>
            {/if}
            {#if running}
                <p class="flex items-center gap-2 text-[var(--text-sub)]">
                    <Loader2 class="w-3.5 h-3.5 animate-spin" />
                    {phase}
                </p>
            {/if}
            {#if error}
                <ErrorText>{error}</ErrorText>
            {/if}
        </div>
    {/snippet}
    {#snippet footer()}
        <DialogActions>
            <Button onclick={onClose} disabled={running}>Cancel</Button>
            <Button
                variant="primary"
                onclick={onSeal}
                disabled={!canSeal}
                loading={running}
                data-testid="seal-confirm"
            >
                <ShieldCheck class="w-3 h-3" /> Seal
            </Button>
        </DialogActions>
    {/snippet}
</Dialog>
