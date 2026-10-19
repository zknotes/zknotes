<script lang="ts">
import { runWithToast } from "$lib/core/stores/toast.svelte";
import { Info, Shield } from "lucide-svelte";
import Button from "$lib/core/ui/Button.svelte";
import { fetchKdfParams } from "$lib/core/services/auth-service";

let kdfInfo = $state<{ m: number; t: number; p: number } | null>(null);

async function loadKdfInfo() {
    await runWithToast(async () => {
        kdfInfo = await fetchKdfParams();
    }, "Could not load the key-derivation parameters");
}
</script>

<section>
    <h2 class="text-2xl font-bold text-[var(--text)] mb-4">Security & Encryption</h2>
    <p class="text-[var(--text-muted)] text-sm mb-8">
        ZKnotes uses zero-knowledge, end-to-end encryption. Your notes are encrypted on your device
        before they reach our servers — we cannot read them.
    </p>

    <div class="space-y-8">
        <div class="bg-[var(--surface-panel)] border border-[var(--stroke-soft)] rounded-2xl p-6 shadow-sm">
            <div class="flex items-center gap-3 mb-4">
                <div class="p-2 bg-brand0/10 rounded-xl text-brand0">
                    <Shield class="w-5 h-5" />
                </div>
                <h3 class="text-lg font-medium text-[var(--text-sub)]">KDF Parameters</h3>
            </div>
            <p class="text-sm text-[var(--text-muted)] mb-4">
                Argon2id parameters used to derive your Master Key from your password.
            </p>
            {#if !kdfInfo}
                <Button variant="normal" size="lg" onclick={loadKdfInfo}>Show parameters</Button>
            {:else}
                <dl class="grid grid-cols-3 gap-4 text-center">
                    {#each [["Memory", `${kdfInfo.m / 1024} MiB`], ["Iterations", `${kdfInfo.t}`], ["Parallelism", `${kdfInfo.p}`]] as [label, value]}
                        <div class="bg-[var(--surface-raised)] rounded-2xl p-4">
                            <dt class="text-xs text-[var(--text-muted)] mb-1">{label}</dt>
                            <dd class="text-lg font-mono font-semibold text-[var(--text)]">{value}</dd>
                        </div>
                    {/each}
                </dl>
                <p class="text-xs text-[var(--text-muted)] mt-4">
                    These parameters were set at registration. Changing your password may update them to newer values.
                </p>
            {/if}
        </div>

        <div class="bg-[var(--surface-panel)] border border-[var(--stroke-soft)] rounded-2xl p-6 shadow-sm">
            <div class="flex items-center gap-3 mb-4">
                <div class="p-2 bg-brand0/10 rounded-xl text-brand0">
                    <Info class="w-5 h-5" />
                </div>
                <h3 class="text-lg font-medium text-[var(--text-sub)]">Security Model</h3>
            </div>
            <dl class="space-y-3 text-sm">
                {#each [
                    ["Encryption", "XChaCha20-Poly1305"],
                    ["Key derivation", "Argon2id"],
                    ["Sub-key derivation", "HKDF-SHA-256"],
                    ["Architecture", "Zero-knowledge — server never sees plaintext"],
                ] as [label, value]}
                    <div class="flex items-center justify-between py-2.5 border-b border-[var(--stroke-soft)] last:border-0">
                        <dt class="text-[var(--text-muted)]">{label}</dt>
                        <dd class="font-mono font-medium text-[var(--text-sub)] text-xs">{value}</dd>
                    </div>
                {/each}
            </dl>
        </div>
    </div>
</section>