<script lang="ts">
import { ArrowRight, Eye, EyeOff, KeyRound, Loader2, Mail, WifiOff } from "lucide-svelte";
import { onMount } from "svelte";
import { Toggle } from "bits-ui";
import { goto } from "$app/navigation";
import { page } from "$app/state";
import { getRegistrationStatus } from "$lib/core/api/auth";
import { isServerUnreachableError } from "$lib/core/api/client";
import { ServerReachability } from "$lib/core/api/server-reachability.svelte";
import { authStore } from "$lib/core/stores/auth-store.svelte";
import Button from "$lib/core/ui/Button.svelte";
import LegalFooter from "$lib/core/ui/LegalFooter.svelte";
import {
    type LoginStage,
    performLogin,
    type PerformLoginResult,
} from "$lib/core/services/auth-service";
import { refreshInstancePublicConfig } from "$lib/core/constants/public-www";
import { SECOND_MS } from "$lib/core/utils/duration";
import { pageTitle } from "$lib/core/utils/page-title";
import { pushPendingMutations } from "$lib/core/sync/engine";

// `?error=` carries a code, never text, because anyone can link to `/login?error=…`.
const QUERY_ERRORS = new Map<string, string>([
    ["session_ended", "Your password was changed or session expired. Please log in again."],
]);
const rawQueryError = page.url.searchParams.get("error") || "";
let wwwUrl = $state<string | undefined>();
const contactUrl = $derived(wwwUrl ? `${wwwUrl}/contact` : undefined);
// The label is derived from the address rather than written by hand: an instance that is not ours has
// to see its own domain. The server has already validated `wwwUrl`; the `catch` is belt and
// braces.
const wwwLabel = $derived.by(() => {
    if (!wwwUrl) return undefined;
    try {
        return new URL(wwwUrl).host;
    } catch {
        return undefined;
    }
});

// ── Where "Create one" goes ──────────────────────────────────────────────────────────────────
// A **runtime** answer, not a build constant: one bundle serves both a self-host and an
// instance with an account layer. So nothing is hardcoded; `/instance-config` and
// `/auth/registration-status` are asked instead, which gives:
//
//   `account.manageUrl` set  → registration lives on the account origin (email, Terms, plan) → go there
//   unset, `open: true`      → self-host before its first vault → the core route `/create-vault`
//   unset, `open: false`     → a vault exists and registration is closed → the line is not rendered
//
// Nothing renders until both answers are in — better than flashing the wrong destination.
let accountManageUrl = $state<string | undefined>();
let instanceConfigLoaded = $state(false);
let registrationOpen = $state<boolean | undefined>();

const signupHref = $derived.by(() => {
    if (!instanceConfigLoaded || registrationOpen === undefined) return undefined;
    if (accountManageUrl) return accountManageUrl;
    return registrationOpen ? "/create-vault" : undefined;
});

/**
 * Loads what this screen needs from the server, and is the reachability probe at the same time: it
 * rejects only when the server cannot be reached. `/instance-config` goes first because it is cheap
 * and not rate limited, so it is the request repeated while the server is away; registration status
 * shares the sign-in rate limit and is asked only once the server has answered.
 */
async function loadPublicInfo(): Promise<void> {
    const cfg = await refreshInstancePublicConfig();
    wwwUrl = cfg.wwwUrl;
    accountManageUrl = cfg.account?.manageUrl;
    instanceConfigLoaded = true;
    try {
        registrationOpen = (await getRegistrationStatus()).open;
    } catch (err) {
        if (isServerUnreachableError(err)) throw err;
        // Any other failure (an older server, the rate limit) counts as closed: offering a route that
        // answers 403 is worse than showing no link at all.
        registrationOpen = false;
    }
}

// Set when the server answers again after an outage; cleared by the next sign-in attempt.
let serverBack = $state(false);

const reachability = new ServerReachability(loadPublicInfo, {
    onRecover: () => {
        serverBack = true;
    },
});

onMount(() => {
    reachability.start();
    return () => {
        reachability.stop();
        clearTimeout(slowTimer);
    };
});

let email = $state("");
let password = $state("");
// Sentinel from layout setUnauthorizedHandler("locked") — rendered with a real <a>, not as plain text.
let accountLocked = $state(rawQueryError === "account_locked");
let error = $state(QUERY_ERRORS.get(rawQueryError) ?? "");
let loading = $state(false);
let showPassword = $state(false);
let unsyncedGate = $state<Extract<PerformLoginResult, { status: "pending_unsynced" }> | null>(null);
let draining = $state(false);

// Sign-in requests normally come back well within a second. Past this, a request still waiting on
// the server is worth saying so — a paused or wedged server accepts the connection and never
// answers, and the button alone looked like the device was busy. Device-side hashing gets no such
// hint: it is slow on purpose.
const SLOW_SERVER_MS = 4 * SECOND_MS;

let stage = $state<LoginStage | null>(null);
let serverSlow = $state(false);
let slowTimer: ReturnType<typeof setTimeout> | undefined;

function setStage(next: LoginStage | null): void {
    stage = next;
    serverSlow = false;
    clearTimeout(slowTimer);
    if (next === "contacting" || next === "signing-in") {
        slowTimer = setTimeout(() => {
            serverSlow = true;
        }, SLOW_SERVER_MS);
    }
}

const busyLabel = $derived(
    stage === "contacting"
        ? "Contacting the server…"
        : stage === "signing-in"
          ? "Signing in…"
          : "Decrypting vault…",
);

function applyLoginError(err: unknown): void {
    if (isServerUnreachableError(err)) {
        // The banner says what happened and keeps retrying; "Bad Gateway" or "Failed to fetch" says
        // nothing a user can act on.
        accountLocked = false;
        error = "";
        reachability.markUnreachable();
        return;
    }
    const errorMessage = err instanceof Error ? err.message : "Login failed";
    if (errorMessage === "account_locked") {
        accountLocked = true;
        error = "";
    } else if (errorMessage === "Invalid credentials") {
        accountLocked = false;
        // The server answers a wrong password and a temporary sign-in pause identically — telling
        // them apart would confirm a guess — so the message has to cover both.
        error =
            "Wrong email or password. After several failed attempts, sign-in from this network " +
            "pauses for a few minutes.";
    } else {
        accountLocked = false;
        error = errorMessage;
    }
}

async function finishSuccessfulLogin(): Promise<void> {
    authStore.setAuthenticated(true);
    authStore.setUnlocked(true);
    goto("/");
}

async function handleLogin() {
    if (!email || !password) {
        accountLocked = false;
        error = "Please fill in all fields";
        return;
    }

    accountLocked = false;
    error = "";
    serverBack = false;
    loading = true;
    unsyncedGate = null;

    try {
        const result = await performLogin(email, password, { onStage: setStage });
        if (result.status === "pending_unsynced") {
            unsyncedGate = result;
            return;
        }
        await finishSuccessfulLogin();
    } catch (err: unknown) {
        applyLoginError(err);
    } finally {
        setStage(null);
        loading = false;
    }
}

async function syncThenContinue() {
    if (!unsyncedGate?.canDrain) return;
    draining = true;
    error = "";
    try {
        await pushPendingMutations({ force: true });
        const result = await performLogin(email, password, { onStage: setStage });
        if (result.status === "pending_unsynced") {
            unsyncedGate = result;
            return;
        }
        unsyncedGate = null;
        await finishSuccessfulLogin();
    } catch (err: unknown) {
        applyLoginError(err);
    } finally {
        setStage(null);
        draining = false;
    }
}

async function continueAnyway() {
    loading = true;
    error = "";
    try {
        const result = await performLogin(email, password, {
            discardUnsynced: true,
            onStage: setStage,
        });
        if (result.status !== "ok") return;
        unsyncedGate = null;
        await finishSuccessfulLogin();
    } catch (err: unknown) {
        applyLoginError(err);
    } finally {
        setStage(null);
        loading = false;
    }
}

function dismissGate() {
    unsyncedGate = null;
}

const unsyncedSummary = $derived.by(() => {
    if (!unsyncedGate) return "";
    const items = unsyncedGate.dirtyCount;
    const uploads = unsyncedGate.uploadsActive;
    const parts: string[] = [];
    if (items > 0) parts.push(`${items} ${items === 1 ? "item" : "items"}`);
    if (uploads > 0) parts.push(`${uploads} ${uploads === 1 ? "upload" : "uploads"}`);
    return parts.length > 0 ? parts.join(" and ") : "unsynced work";
});
</script>

<svelte:head>
    <title>{pageTitle("ZKnotes — Login")}</title>
</svelte:head>

<div class="min-h-screen flex items-center justify-center relative overflow-hidden bg-[var(--surface-app)] bg-grid">
    <div class="absolute inset-0 bg-gradient-to-br from-brand0/10 to-transparent z-0"></div>
    <div class="absolute -top-[30%] -left-[10%] w-[70%] h-[70%] rounded-full bg-brand0/10 blur-[120px] pointer-events-none"></div>
    <div class="absolute -bottom-[30%] -right-[10%] w-[60%] h-[60%] rounded-full bg-brand0/10 blur-[120px] pointer-events-none"></div>

    <div class="relative z-10 w-full max-w-md p-8 rounded-2xl bg-[var(--float-bg)] backdrop-blur-md border border-[var(--stroke)] shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]">
        <div class="flex flex-col items-center mb-8">
            {#if wwwUrl && wwwLabel}
                <a
                    href={wwwUrl}
                    class="self-start mb-4 text-xs font-mono text-[var(--text-dim)] hover:text-brand-fg transition-colors flex items-center gap-1"
                >
                    ← {wwwLabel}
                </a>
            {/if}
            <img src="/zknotes-icon-v2.svg" width="56" height="56" alt="ZKnotes" class="mb-4">
            <div class="font-mono tracking-tight leading-none mb-2">
                <span class="text-title font-extrabold text-[var(--text)]">ZK</span><span class="text-title font-light" style="color:#22d3ee;">notes</span>
            </div>
            <div class="text-2xs font-mono uppercase tracking-[0.18em] text-brand-fg/80 mb-1">
                Zero-knowledge
            </div>
            <p class="text-[var(--text-dim)] mt-1 text-sm">Your notes, cryptographically secure.</p>
        </div>

        <form onsubmit={(e) => { e.preventDefault(); handleLogin(); }} class="space-y-6">
            {#if reachability.status === "unreachable"}
                <div
                    class="p-3 rounded-md border border-[var(--warning)]/20 bg-[var(--warning)]/5 flex items-start gap-3"
                    role="status"
                    data-testid="login-server-unreachable"
                >
                    <WifiOff class="w-4 h-4 mt-0.5 flex-shrink-0 text-[var(--warning)]" />
                    <div class="flex-1 space-y-2">
                        <p class="text-sm font-medium text-[var(--text)]">Can't reach the server</p>
                        <p class="text-xs text-[var(--text-muted)]">
                            Check your internet connection. This page keeps trying and lets you know
                            as soon as the server is back — no need to reload.
                        </p>
                        <Button
                            variant="normal"
                            size="sm"
                            loading={reachability.checking}
                            onclick={() => void reachability.checkNow()}
                        >
                            {reachability.checking ? "Checking…" : "Try now"}
                        </Button>
                    </div>
                </div>
            {:else if serverBack}
                <div
                    class="bg-[var(--success)]/10 text-sm p-3 rounded-md border border-[var(--success)]/20 flex items-center gap-2 text-[var(--text)]"
                    role="status"
                    data-testid="login-server-back"
                >
                    <div class="w-1.5 h-1.5 rounded-full bg-[var(--success)] flex-shrink-0"></div>
                    The server is back. You can unlock your vault now.
                </div>
            {/if}

            {#if accountLocked}
                <div class="bg-rose-500/10 text-rose-300 text-sm p-3 rounded-md border border-rose-500/20 flex items-start gap-2">
                    <div class="w-1.5 h-1.5 rounded-full bg-rose-400 flex-shrink-0 mt-1.5"></div>
                    <span>
                        Your account has been locked. Please
                        {#if contactUrl}
                            <a href={contactUrl} class="underline text-rose-200 hover:text-rose-100">contact support</a>.
                        {:else}
                            contact support.
                        {/if}
                    </span>
                </div>
            {:else if error}
                <div class="bg-rose-500/10 text-rose-300 text-sm p-3 rounded-md border border-rose-500/20 flex items-center gap-2">
                    <div class="w-1.5 h-1.5 rounded-full bg-rose-400 flex-shrink-0"></div>
                    {error}
                </div>
            {/if}

            {#if unsyncedGate}
                <div
                    class="p-4 border border-[var(--warning)]/20 bg-[var(--warning)]/5 rounded-md space-y-3"
                    data-testid="login-unsynced-gate"
                >
                    <h3 class="font-bold text-sm text-[var(--text)]">Unsynced work on this device</h3>
                    {#if unsyncedGate.canDrain}
                        <p class="text-sm text-[var(--text-muted)]">
                            This device still has {unsyncedSummary} that has not reached the server.
                            Signing in as a different account will discard it. Sync first, or continue
                            anyway to throw it away.
                        </p>
                    {:else}
                        <p class="text-sm text-[var(--text-muted)]">
                            This device still has {unsyncedSummary} that has not reached the server.
                            You are signed out, so it can no longer be sent. Continue anyway will
                            discard it.
                        </p>
                    {/if}
                    <div class="flex flex-col gap-2">
                        {#if unsyncedGate.canDrain}
                            <Button
                                variant="primary"
                                type="button"
                                disabled={draining || loading}
                                class="w-full"
                                onclick={() => void syncThenContinue()}
                            >
                                {#if draining}
                                    <Loader2 class="w-4 h-4 animate-spin" />
                                    Syncing…
                                {:else}
                                    Sync then continue
                                {/if}
                            </Button>
                        {/if}
                        <Button
                            variant="danger"
                            type="button"
                            disabled={draining || loading}
                            class="w-full"
                            onclick={() => void continueAnyway()}
                        >
                            Continue anyway
                        </Button>
                        <Button
                            variant="normal"
                            type="button"
                            disabled={draining || loading}
                            class="w-full"
                            onclick={dismissGate}
                        >
                            Cancel
                        </Button>
                    </div>
                </div>
            {/if}

            <div class="space-y-3">
                <div class="relative group">
                    <Mail class="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-dim)] group-focus-within:text-brand-fg transition-colors" />
                    <input
                        type="email"
                        placeholder="Email"
                        bind:value={email}
                        required
                        class="input w-full h-11 pl-10 pr-3 text-sm rounded-md"
                    />
                </div>

                <div class="relative group">
                    <KeyRound class="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-dim)] group-focus-within:text-brand-fg transition-colors" />
                    <input
                        type={showPassword ? "text" : "password"}
                        placeholder="Master password"
                        bind:value={password}
                        required
                        class="input w-full h-11 pl-10 pr-10 text-sm rounded-md"
                    />
                    <Toggle.Root
                        bind:pressed={showPassword}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-[var(--text-dim)] hover:text-[var(--text-sub)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand0/50 transition-colors"
                    >
                        {#if showPassword}
                            <EyeOff class="w-4 h-4" />
                        {:else}
                            <Eye class="w-4 h-4" />
                        {/if}
                    </Toggle.Root>
                </div>
            </div>

            {#if !unsyncedGate}
                <Button
                    variant="primary"
                    type="submit"
                    disabled={loading}
                    class="w-full h-11 text-sm font-semibold shadow-lg shadow-brand0/20 group active:scale-[0.98]"
                >
                    {#if loading}
                        <Loader2 class="w-4 h-4 animate-spin" />
                        {busyLabel}
                    {:else}
                        Unlock vault
                        <ArrowRight class="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                    {/if}
                </Button>
            {/if}

            {#if (loading || draining) && serverSlow}
                <p
                    class="-mt-3 text-xs text-center text-[var(--warning)]"
                    role="status"
                    data-testid="login-server-slow"
                >
                    The server is taking longer than usual to answer. Still waiting…
                </p>
            {/if}

            <div class="flex items-center justify-center gap-2 text-2xs font-mono uppercase tracking-wider text-[var(--text-dim)] pt-2">
                <div class="w-1.5 h-1.5 rounded-full bg-brand-fg pulse-dot"></div>
                Argon2id · m=64MiB · t=3
            </div>

            {#if signupHref}
                <p class="text-center text-sm text-[var(--text-dim)] pt-1">
                    Don't have an account?
                    <a href={signupHref} class="text-brand-fg hover:text-brand-fg hover:underline font-medium transition-colors" data-testid="login-signup-link">Create one</a>
                </p>
            {/if}
            
        </form>
        <LegalFooter class="mt-6 text-center" />
    </div>
</div>
