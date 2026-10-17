<script lang="ts">
/**
 * Internal gallery content. Only loaded in dev.
 * This file contains the heavy imports and markup so that
 * the /dev/ui route chunk stays tiny in production builds.
 */
import {
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    ErrorText,
    Input,
    SegmentedControl,
    SettingsCard,
    ThemePicker,
    SearchBar,
    ItemContextMenu,
    MetaText,
    Logo,
} from "$lib/core/ui";
import { themeStore, type Theme } from "$lib/core/stores/theme.svelte";
import { globalToasts } from "$lib/core/stores/toast.svelte";
import { Toggle } from "bits-ui";
import { Eye, EyeOff, Save, Trash2, X, Star } from "lucide-svelte";

// --- Theme switcher ---
const THEMES: { id: Theme; label: string; desc: string }[] = [
    { id: "light", label: "Light", desc: "Light theme" },
    { id: "dark", label: "Dark", desc: "Default dark" },
    { id: "warm", label: "Warm", desc: "Warm tones" },
    { id: "ocean", label: "Ocean", desc: "Cool blue" },
    { id: "midnight", label: "Midnight", desc: "Dark + brand" },
];

function setTheme(t: Theme) {
    themeStore.set(t);
}

// --- Dialog demo state ---
let showBasicDialog = $state(false);
let showDestructiveDialog = $state(false);
let showWithActionsDialog = $state(false);
let dialogResult = $state("");

// --- Toast demo ---
function triggerToast(variant: "success" | "info" | "error") {
    const messages = {
        success: "Saved successfully!",
        info: "Some information for the user.",
        error: "Something went wrong during the operation.",
    };
    globalToasts.add({
        variant,
        message: messages[variant],
        action:
            variant === "error"
                ? { label: "Retry", onClick: () => console.log("retry") }
                : undefined,
    });
}

// --- Context menu demo using the real ItemContextMenu ---
let showCtxDemo = $state(false);
let ctxDemoX = $state(0);
let ctxDemoY = $state(0);
let ctxDemoNode = $state({ id: "demo-note", type: "note", title: "Demo note" });

function openCtxDemo(e: MouseEvent) {
    e.preventDefault();
    ctxDemoX = e.clientX;
    ctxDemoY = e.clientY;
    showCtxDemo = true;
}

function closeCtxDemo() {
    showCtxDemo = false;
}

// --- Form demo state ---
let fText = $state("");
let fEmail = $state("ana@example.com");
let fPassword = $state("hunter2");
let fShowPassword = $state(false);
let fNumber = $state("3");
let fInvalid = $state("not-an-email");
let fSelect = $state("md");
let fTextarea = $state("");
let fCheckA = $state(true);
let fCheckB = $state(false);
let fNativeCheck = $state(true);
let fRadio = $state("24h");
let fCardRadio = $state("system");
let fSegment = $state("all");

// --- Text colours: the definitions plus a live contrast measurement ---
// The roles are read from `app.css` rather than assumed — an earlier version of this list claimed
// `--text` was a note's body, when in fact that is `--text-sub`.
const TEXT_TOKENS = [
    { token: "--text", use: "The h1–h3 headings, strong, hover states, typed field text" },
    { token: "--text-sub", use: "A NOTE'S BODY (.ProseMirror), sidebar rows, button text" },
    { token: "--text-muted", use: "Labels, helper text, blockquote, a table caption" },
    { token: "--text-dim", use: "MetaText, Eyebrow, EmptyState, placeholders, icons" },
];

const SEMANTIC_TOKENS = [
    { token: "--accent-color", use: "Brand / the primary action" },
    { token: "--danger", use: "Destructive actions, errors" },
    { token: "--warning", use: "Warnings" },
    { token: "--info", use: "Informational" },
    { token: "--success", use: "Success" },
];

const SURFACES = [
    { token: "--surface-app", label: "app" },
    { token: "--surface-panel", label: "panel" },
    { token: "--surface-raised", label: "raised" },
];

/** The threshold: 4.5 for normal text (WCAG 2.1 AA). */
const AA = 4.5;

class ContrastProbe {
    measurements = $state<
        Record<string, { hex: string; ratios: Record<string, number>; lstar: number }>
    >({});

    #resolve(el: HTMLElement, value: string): [number, number, number] {
        el.style.backgroundColor = "rgb(0,0,0)";
        el.style.backgroundColor = value;
        const resolved = getComputedStyle(el).backgroundColor;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d");
        if (!ctx) return [0, 0, 0];
        ctx.fillStyle = resolved;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0];
    }

    #luminance([r, g, b]: [number, number, number]): number {
        const f = (c: number) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    }

    #ratio(a: [number, number, number], b: [number, number, number]): number {
        const [l1, l2] = [this.#luminance(a), this.#luminance(b)];
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    #hex([r, g, b]: [number, number, number]): string {
        return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
    }

    /** CIE L* — perceptual lightness. Contrast does not reveal when two levels merge. */
    #lstar(rgb: [number, number, number]): number {
        const y = this.#luminance(rgb);
        return y <= 0.008856 ? y * 903.3 : 116 * Math.cbrt(y) - 16;
    }

    run() {
        const el = document.createElement("div");
        el.style.cssText = "position:fixed;left:-9999px;width:1px;height:1px";
        document.body.appendChild(el);

        const surfaces = SURFACES.map(
            (s) => [s.label, this.#resolve(el, `var(${s.token})`)] as const,
        );
        const next: Record<string, { hex: string; ratios: Record<string, number>; lstar: number }> =
            {};

        for (const { token } of [...TEXT_TOKENS, ...SEMANTIC_TOKENS]) {
            const fg = this.#resolve(el, `var(${token})`);
            const ratios: Record<string, number> = {};
            for (const [label, bg] of surfaces) {
                ratios[label] = Math.round(this.#ratio(fg, bg) * 100) / 100;
            }
            next[token] = { hex: this.#hex(fg), ratios, lstar: this.#lstar(fg) };
        }

        el.remove();
        this.measurements = next;
    }
}

const contrast = new ContrastProbe();

$effect(() => {
    // It depends on the theme — measure again when that changes.
    void themeStore.current;
    contrast.run();
});

const RADIO_OPTIONS = [
    { value: "system", label: "System" },
    { value: "24h", label: "24-hour" },
    { value: "12h", label: "12-hour" },
];
</script>

<!-- Fixed static top menu -->
<header
	class="fixed top-0 left-0 right-0 z-[999] bg-[var(--surface-panel)] border-b border-[var(--stroke)] h-12 flex items-center px-4 shadow-sm"
>
	<div class="flex items-center gap-3 flex-1 min-w-0">
		<div class="font-mono text-xs uppercase tracking-[1px] text-[var(--text-dim)]">
			DEV • UI GALLERY
		</div>
		<div class="text-sm text-[var(--text-sub)]">ZKnotes Component Showcase</div>
	</div>

	<!-- Theme switcher -->
	<div class="flex items-center gap-1.5 text-xs">
		<span class="text-[var(--text-dim)] mr-1 hidden sm:inline">Theme:</span>
		{#each THEMES as t (t.id)}
			<Button
				variant={themeStore.current === t.id ? "primary" : "ghost"}
				size="sm"
				onclick={() => setTheme(t.id)}
				title={t.desc}
			>
				{t.label}
			</Button>
		{/each}
		<div class="ml-2 text-2xs text-[var(--text-muted)] hidden md:block">
			Current: <span class="font-mono">{themeStore.current}</span>
		</div>
	</div>

	<div class="ml-4 text-2xs text-[var(--text-dim)]">Test Tab / focus here</div>
</header>

<div class="pt-12 min-h-screen bg-[var(--surface-app)] text-[var(--text)]">
	<div class="max-w-5xl mx-auto px-6 py-8">
		<div class="mb-8">
			<h1 class="text-3xl font-bold tracking-tight">UI elements &amp; components</h1>
			<p class="text-[var(--text-dim)] mt-1">
				A live visual reference. Use it to check consistency across themes, focus-visible, hierarchy and variants.
				The canonical classes and the button variants are checked by the <code>./check.sh</code> gates.
			</p>
		</div>

		<!-- LOGO -->
		<section class="mb-12">
			<h2 class="text-xl font-semibold mb-1">Logo</h2>
			<p class="text-sm text-[var(--text-dim)] mb-4 max-w-prose">
				The official ZKnotes logo and typography lockup. It adapts to the theme automatically (light/dark).
			</p>
			<div class="p-6 rounded-xl bg-[var(--surface-panel)] border border-[var(--stroke)] inline-flex flex-col gap-6">
				<div class="flex flex-col gap-2">
					<span class="text-2xs text-[var(--text-muted)] uppercase tracking-wider">On panel background</span>
					<div class="p-4 rounded border border-[var(--stroke)]">
						<Logo />
					</div>
				</div>
			</div>
		</section>

		<!-- BUTTON -->
		<section class="mb-12">
			<h2 class="text-xl font-semibold mb-1">Button</h2>
			<p class="text-sm text-[var(--text-dim)] mb-4 max-w-prose">
				<strong>The only component for actions.</strong> Use it <strong>always</strong>, except for very specialised small elements.
			</p>

			<!-- Visual examples, without duplicating the rules -->
			<div class="mb-6">
				<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-2">Variants (md size)</div>
				<div class="flex flex-wrap gap-3 items-end">
					<div class="flex flex-col items-start gap-1">
						<span class="text-2xs text-[var(--text-muted)]">primary</span>
						<Button variant="primary">Save changes</Button>
					</div>
					<div class="flex flex-col items-start gap-1">
						<span class="text-2xs text-[var(--text-muted)]">normal</span>
						<Button variant="normal">Cancel</Button>
					</div>
					<div class="flex flex-col items-start gap-1">
						<span class="text-2xs text-[var(--text-muted)]">danger</span>
						<Button variant="danger">Delete forever</Button>
					</div>
					<div class="flex flex-col items-start gap-1">
						<span class="text-2xs text-[var(--text-muted)]">danger-ghost</span>
						<Button variant="danger-ghost">Empty trash</Button>
					</div>
					<div class="flex flex-col items-start gap-1">
						<span class="text-2xs text-[var(--text-muted)]">ghost</span>
						<Button variant="ghost">Settings</Button>
					</div>
					<div class="flex flex-col items-start gap-1">
						<span class="text-2xs text-[var(--text-muted)]">ghost active</span>
						<Button variant="ghost" active={true}>Active tab</Button>
					</div>
				</div>
			</div>

			<div class="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-8">
				<div>
					<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-2">Sizes</div>
					<div class="flex flex-wrap items-end gap-3">
						<Button size="sm" variant="normal">sm</Button>
						<Button size="md" variant="normal">md (default)</Button>
						<Button size="lg" variant="normal">lg</Button>
						<Button size="icon" variant="ghost" title="Close"><X class="w-4 h-4" /></Button>
					</div>
				</div>

				<div>
					<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-2">With icon + disabled</div>
					<div class="flex flex-wrap items-end gap-3">
						<Button variant="primary">
							<Save class="w-4 h-4" /> Save (enabled)
						</Button>
						<Button variant="primary" disabled>
							<Save class="w-4 h-4" /> Save (disabled with icon)
						</Button>
						<Button variant="danger" disabled>
							<Trash2 class="w-4 h-4" /> Deleting…
						</Button>
						<Button variant="normal" disabled>Disabled normal</Button>
					</div>
				</div>

				<div class="md:col-span-2">
					<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-2">Long text (a whitespace-nowrap check)</div>
					<div class="flex flex-wrap gap-3 max-w-md">
						<Button variant="normal" class="flex-1">This is a very long button label that should not wrap</Button>
						<Button variant="ghost">Another longish label example</Button>
					</div>
				</div>
			</div>
		</section>

		<!-- DIALOG -->
		<section class="mb-12">
			<h2 class="text-xl font-semibold mb-1">Dialog + DialogActions</h2>
			<p class="text-sm text-[var(--text-dim)] mb-4">
				Use <code>DialogActions</code> inside the <code>footer</code> snippet, for the standard order.
			</p>

			<div class="flex flex-wrap gap-3 mb-4">
				<Button onclick={() => (showBasicDialog = true)}>Open basic dialog</Button>
				<Button variant="danger" onclick={() => (showDestructiveDialog = true)}>Open destructive</Button>
				<Button onclick={() => (showWithActionsDialog = true)}>Open with DialogActions</Button>
			</div>

			{#if dialogResult}
				<div class="text-xs text-[var(--text-muted)] mb-2">Last result: <span class="font-mono">{dialogResult}</span></div>
			{/if}

			{#if showBasicDialog}
				<Dialog title="Basic dialog" onBackdropClick={() => (showBasicDialog = false)}>
					{#snippet children()}
						<p class="text-sm">This is an ordinary dialog.</p>
					{/snippet}
					{#snippet footer()}
						<Button onclick={() => (showBasicDialog = false)}>Close</Button>
					{/snippet}
				</Dialog>
			{/if}

			{#if showDestructiveDialog}
				<Dialog title="Delete item?" onBackdropClick={() => (showDestructiveDialog = false)}>
					{#snippet children()}
						<p class="text-sm">This action cannot be undone.</p>
					{/snippet}
					{#snippet footer()}
						<DialogActions>
							<Button onclick={() => (showDestructiveDialog = false)}>Cancel</Button>
							<Button variant="danger" onclick={() => { dialogResult = 'deleted'; showDestructiveDialog = false; }}>Delete</Button>
						</DialogActions>
					{/snippet}
				</Dialog>
			{/if}

			{#if showWithActionsDialog}
				<Dialog title="Confirm action" onBackdropClick={() => (showWithActionsDialog = false)}>
					{#snippet children()}
						<p>Here we use <code>&lt;DialogActions&gt;</code> for the right layout.</p>
					{/snippet}
					{#snippet footer()}
						<DialogActions>
							<Button onclick={() => (showWithActionsDialog = false)}>Cancel</Button>
							<Button variant="primary" onclick={() => { dialogResult = 'confirmed'; showWithActionsDialog = false; }}>Confirm</Button>
						</DialogActions>
					{/snippet}
				</Dialog>
			{/if}
		</section>

		<!-- THE TEXT COLOURS -->
		<section class="mb-12">
			<h2 class="text-xl font-semibold mb-1">The text colours</h2>
			<p class="text-sm text-[var(--text-dim)] mb-4 max-w-prose">
				All four text levels side by side, on all three surfaces. The numbers are
				<strong>measured live</strong> in the browser and change with the theme —
				green means it passes the WCAG AA threshold for normal text.
			</p>

			<div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-8">
				{#each SURFACES as surface (surface.token)}
					<div
						class="rounded-xl border border-[var(--stroke)] p-4"
						style="background: var({surface.token})"
					>
						<div class="text-2xs font-mono uppercase tracking-wider text-[var(--text-dim)] mb-3">
							{surface.label}
						</div>
						<div class="space-y-3">
							{#each TEXT_TOKENS as t (t.token)}
								{@const m = contrast.measurements[t.token]}
								<div>
									<div class="flex items-baseline justify-between gap-2">
										<span class="text-sm" style="color: var({t.token})">
											This is {t.token.replace("--", "")}
										</span>
										<span
											class="text-2xs font-mono shrink-0"
											style="color: var({m && (m.ratios[surface.label] ?? 0) >= AA ? '--success' : '--danger'})"
										>
											{m ? (m.ratios[surface.label] ?? 0).toFixed(2) : "…"}
										</span>
									</div>
									<div class="text-2xs font-mono text-[var(--text-dim)]">
										var({t.token}){#if m} · {m.hex}{/if}
									</div>
								</div>
							{/each}
						</div>
					</div>
				{/each}
			</div>

			<div class="mb-8 overflow-x-auto">
				<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-2">
					Measured contrast — theme <span class="font-mono">{themeStore.current}</span>
				</div>
				<table class="w-full text-sm border border-[var(--stroke)] rounded-lg overflow-hidden">
					<thead class="bg-[var(--surface-panel)]">
						<tr class="text-left">
							<th class="px-3 py-2 font-medium">Token</th>
							<th class="px-3 py-2 font-medium">Hex</th>
							{#each SURFACES as s (s.token)}
								<th class="px-3 py-2 font-medium font-mono text-2xs">{s.label}</th>
							{/each}
							<th class="px-3 py-2 font-medium font-mono text-2xs" title="The difference in perceptual lightness from the level above. Healthy: 13–22.">ΔL</th>
							<th class="px-3 py-2 font-medium">Where it is used</th>
						</tr>
					</thead>
					<tbody>
						{#each TEXT_TOKENS as t, i (t.token)}
							{@const m = contrast.measurements[t.token]}
							{@const prev = i > 0 ? contrast.measurements[TEXT_TOKENS[i - 1]?.token ?? ""] : undefined}
							{@const dL = m && prev ? Math.abs(m.lstar - prev.lstar) : null}
							<tr class="border-t border-[var(--stroke)]">
								<td class="px-3 py-2 font-mono text-2xs" style="color: var({t.token})">
									{t.token}
								</td>
								<td class="px-3 py-2 font-mono text-2xs text-[var(--text-muted)]">{m ? m.hex : "…"}</td>
								{#each SURFACES as s (s.token)}
									<td
										class="px-3 py-2 font-mono text-2xs"
										style="color: var({m && (m.ratios[s.label] ?? 0) >= AA ? '--success' : '--danger'})"
									>
										{m ? (m.ratios[s.label] ?? 0).toFixed(2) : "…"}
									</td>
								{/each}
								<td
									class="px-3 py-2 font-mono text-2xs"
									style="color: var({dL === null ? '--text-dim' : dL >= 13 ? '--success' : '--danger'})"
									title={dL === null ? "the first level" : "the gap from the level above"}
								>
									{dL === null ? "—" : dL.toFixed(1)}
								</td>
								<td class="px-3 py-2 text-2xs text-[var(--text-muted)]">{t.use}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="text-2xs text-[var(--text-muted)] mt-2">
					<strong>ΔL</strong> is the difference in perceptual lightness from the level above. Below ~13
					two levels stop being distinguishable, and <em>contrast does not show that</em> — which is how a problem
					in the Ocean theme once slipped past a contrast-only check.
				</p>
				<p class="text-2xs text-[var(--text-muted)] mt-2">
					⚠️ <code>--text-dim</code> is below the threshold in every theme. It carries the placeholders,
					but also <code>MetaText</code> / <code>Eyebrow</code> — so the dates and sizes in the Files list
					are currently not AA.
				</p>
			</div>

			<div class="mb-8">
				<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-2">
					sub against muted — are they still two steps apart?
				</div>
				<div class="grid grid-cols-1 md:grid-cols-3 gap-4">
					{#each SURFACES as surface (surface.token)}
						<div
							class="rounded-xl border border-[var(--stroke)] p-4 space-y-2"
							style="background: var({surface.token})"
						>
							<div class="text-2xs font-mono uppercase tracking-wider text-[var(--text-dim)]">
								{surface.label}
							</div>
							<p class="text-sm" style="color: var(--text-sub)">
								Sub — secondary text, a description in a dialog.
							</p>
							<p class="text-sm" style="color: var(--text-muted)">
								Muted — a label, the helper text under a field.
							</p>
							<p class="text-xs" style="color: var(--text-muted)">
								Muted at 12px — this is how it looks in most chrome.
							</p>
							<p class="text-2xs" style="color: var(--text-muted)">
								Muted at 11px — the smallest size in the app.
							</p>
						</div>
					{/each}
				</div>
			</div>

			<div>
				<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-2">
					Semantic colours (on the app surface)
				</div>
				<div class="rounded-xl border border-[var(--stroke)] bg-[var(--surface-app)] p-4 space-y-2">
					{#each SEMANTIC_TOKENS as t (t.token)}
						{@const m = contrast.measurements[t.token]}
						<div class="flex items-baseline gap-3">
							<span class="text-sm w-40 shrink-0" style="color: var({t.token})">
								{t.token.replace("--", "")}
							</span>
							<span
								class="text-2xs font-mono w-16 shrink-0"
								style="color: var({m && (m.ratios.app ?? 0) >= AA ? '--success' : '--danger'})"
							>
								{m ? (m.ratios.app ?? 0).toFixed(2) : "…"}
							</span>
							<span class="text-2xs text-[var(--text-muted)]">{t.use}</span>
						</div>
					{/each}
				</div>
			</div>
		</section>

		<!-- FORM ELEMENTS -->
		<section class="mb-12">
			<h2 class="text-xl font-semibold mb-1">Form elements</h2>
			<p class="text-sm text-[var(--text-dim)] mb-4 max-w-prose">
				The canonical form is <code>&lt;Input&gt;</code> / the <code>.input</code> class from <code>app.css</code>.
				The same <code>.input</code> class applies to <code>select</code> and <code>textarea</code>.
				Check every theme + <code>Tab</code> focus.
			</p>

			<!-- Field group -->
			<div class="mb-8">
				<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-3">Field group (label + input + helper + error)</div>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-3xl">
					<div class="space-y-1.5">
						<label for="fg-ok" class="block text-sm font-medium">Display name</label>
						<Input
							id="fg-ok"
							class="w-full"
							value={fText}
							oninput={(e) => (fText = e.currentTarget.value)}
							placeholder="Jane Doe"
						/>
						<p class="text-xs text-[var(--text-dim)]">Visible only to you — it is not synchronised.</p>
					</div>
					<div class="space-y-1.5">
						<label for="fg-err" class="block text-sm font-medium">Email</label>
						<Input
							id="fg-err"
							class="w-full"
							value={fInvalid}
							oninput={(e) => (fInvalid = e.currentTarget.value)}
							aria-invalid="true"
							aria-describedby="fg-err-msg"
						/>
						<ErrorText id="fg-err-msg">Invalid email address format.</ErrorText>
					</div>
				</div>
				<p class="text-2xs text-[var(--text-muted)] mt-2">
					The canonical error pattern: <code>aria-invalid="true"</code> on the field,
					an <code>id</code> on the <code>ErrorText</code>, an <code>aria-describedby</code> on the input.
					Focus on an invalid field keeps the danger ring, not the accent.
				</p>
			</div>

			<!-- Input types -->
			<div class="mb-8">
				<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-3">Input types</div>
				<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 max-w-4xl">
					<div class="flex flex-col gap-1">
						<span class="text-2xs text-[var(--text-muted)]">text</span>
						<Input class="w-full" placeholder="Placeholder" />
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-2xs text-[var(--text-muted)]">email (filled)</span>
						<Input
							class="w-full"
							type="email"
							value={fEmail}
							oninput={(e) => (fEmail = e.currentTarget.value)}
						/>
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-2xs text-[var(--text-muted)]">password + reveal toggle</span>
						<div class="relative">
							<Input
								class="w-full pr-10"
								type={fShowPassword ? "text" : "password"}
								value={fPassword}
								oninput={(e) => (fPassword = e.currentTarget.value)}
								autocomplete="new-password"
							/>
							<Toggle.Root
								bind:pressed={fShowPassword}
								aria-label={fShowPassword ? "Hide password" : "Show password"}
								class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded cursor-pointer text-[var(--text-dim)] hover:text-[var(--text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand0/50 transition-colors"
							>
								{#if fShowPassword}
									<EyeOff class="w-4 h-4" />
								{:else}
									<Eye class="w-4 h-4" />
								{/if}
							</Toggle.Root>
						</div>
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-2xs text-[var(--text-muted)]">number</span>
						<Input
							class="w-full"
							type="number"
							min="0"
							max="10"
							value={fNumber}
							oninput={(e) => (fNumber = e.currentTarget.value)}
						/>
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-2xs text-[var(--text-muted)]">date</span>
						<Input class="w-full" type="date" value="2026-08-22" />
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-2xs text-[var(--text-muted)]">search</span>
						<Input class="w-full" type="search" placeholder="Search…" />
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-2xs text-[var(--text-muted)]">disabled</span>
						<Input class="w-full" value="disabled" disabled />
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-2xs text-[var(--text-muted)]">readonly</span>
						<Input class="w-full" value="readonly" readonly />
					</div>
					<div class="flex flex-col gap-1">
						<span class="text-2xs text-[var(--text-muted)]">color (native)</span>
						<input type="color" value="#10b981" class="h-8 w-14 cursor-pointer rounded border border-[var(--stroke)] bg-transparent p-0.5" />
					</div>
				</div>
			</div>

			<!-- Scale sm / md -->
			<div class="mb-8">
				<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-3">
					Scale — <code>sm</code> / <code>md</code>
				</div>
				<p class="text-2xs text-[var(--text-muted)] mb-3 max-w-prose">
					<code>.input</code> on its own is <code>md</code> — there is no <code>.input-md</code> class.
					The call site adds the width; the class owns the radius, border, background and focus.
				</p>
				<div class="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-4xl">
					<div class="space-y-2">
						<span class="text-2xs font-mono text-[var(--text-muted)]">.input.input-sm</span>
						<input class="input input-sm w-full" placeholder="Compact — Share TTL, sidebar" />
						<select class="input input-sm w-full" aria-label="sm select">
							<option>24 hours</option>
							<option>7 days</option>
						</select>
					</div>
					<div class="space-y-2">
						<span class="text-2xs font-mono text-[var(--text-muted)]">.input (md)</span>
						<input class="input w-full" placeholder="Default density" />
						<select class="input w-full" aria-label="md select">
							<option>24 hours</option>
							<option>7 days</option>
						</select>
					</div>
					<div class="space-y-2">
						<span class="text-2xs font-mono text-[var(--text-muted)]">.input-sm.input-on-panel</span>
						<div class="rounded-lg bg-[var(--surface-panel)] border border-[var(--stroke)] p-3">
							<input class="input input-sm input-on-panel w-full" placeholder="File detail panel" />
						</div>
					</div>
					<div class="space-y-2">
						<span class="text-2xs font-mono text-[var(--text-muted)]">.input-danger</span>
						<input class="input input-danger w-full" placeholder="Delete confirmation" />
					</div>
				</div>
			</div>

			<!-- Select + textarea -->
			<div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8 max-w-4xl">
				<div>
					<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-3">Select</div>
					<div class="space-y-3">
						<select class="input w-full" bind:value={fSelect} aria-label="Size">
							<option value="sm">Small</option>
							<option value="md">Medium</option>
							<option value="lg">Large</option>
						</select>
						<select class="input w-full" disabled aria-label="Disabled select">
							<option>Disabled select</option>
						</select>
						<select class="input w-full" size="4" aria-label="List select">
							<option>First option</option>
							<option>A second option with very long text that must not overflow the container</option>
							<option>A third option</option>
							<option>A fourth option</option>
						</select>
					</div>
					<p class="text-2xs text-[var(--text-muted)] mt-2">
						<code>select.input</code> (without <code>size</code>) shares bg/border/radius/height with
						<code>input.input</code>. Listbox (<code>size="4"</code>) shares color, not height.
					</p>
				</div>

				<div>
					<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-3">Textarea</div>
					<div class="space-y-3">
						<textarea
							class="input w-full resize-y"
							rows="3"
							placeholder="Write something…"
							bind:value={fTextarea}
						></textarea>
						<textarea class="input w-full font-mono" rows="2" readonly>readonly + font-mono</textarea>
						<textarea class="input w-full" rows="2" disabled>disabled</textarea>
					</div>
					<p class="text-2xs text-[var(--text-muted)] mt-2">
						<code>.input</code> works on a <code>textarea</code> too (the font inherits correctly).
					</p>
				</div>
			</div>

			<!-- Checkbox + radio -->
			<div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8 max-w-4xl">
				<div>
					<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-3">
						Checkbox — <code>Checkbox.svelte</code>
					</div>
					<div class="space-y-3">
						<label class="flex items-center gap-2.5 text-sm cursor-pointer select-none">
							<Checkbox bind:checked={fCheckA} />
							Checked
						</label>
						<label class="flex items-center gap-2.5 text-sm cursor-pointer select-none">
							<Checkbox bind:checked={fCheckB} />
							Unchecked
						</label>
						<label class="flex items-center gap-2.5 text-sm select-none">
							<Checkbox checked={true} disabled />
							Disabled checked
						</label>
						<label class="flex items-start gap-2.5 text-sm select-none">
							<Checkbox checked={false} disabled />
							<span>
								Disabled unchecked
								<span class="block text-xs text-[var(--text-dim)] mt-0.5">
									With a two-line description — checking alignment.
								</span>
							</span>
						</label>
					</div>
					<p class="text-2xs text-[var(--text-muted)] mt-2">
						Native <code>&lt;input type="checkbox"&gt;</code> behind the <code>.checkbox</code> class —
						<code>&lt;label&gt;</code> binds a click on the text with no handler at all, and <code>bind:checked</code>
						works directly.
					</p>
				</div>

				<div>
					<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-3">Radio (native)</div>
					<div class="space-y-2">
						{#each RADIO_OPTIONS as option (option.value)}
							<label class="flex items-center gap-2.5 text-sm cursor-pointer select-none">
								<input
									type="radio"
									name="gallery_time_format"
									value={option.value}
									bind:group={fRadio}
									class="radio"
								/>
								{option.label}
							</label>
						{/each}
						<label class="flex items-center gap-2.5 text-sm select-none opacity-60">
							<input type="radio" name="gallery_time_format_disabled" disabled class="radio" />
							Disabled
						</label>
					</div>
				</div>
			</div>

			<!-- Card radio + segmented -->
			<div class="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8 max-w-4xl">
				<div>
					<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-3">
						Card radio (pattern from Settings)
					</div>
					<div class="space-y-2">
						{#each RADIO_OPTIONS as option (option.value)}
							<label
								class="flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-colors text-left
									{fCardRadio === option.value
										? 'border-brand0/40 bg-brand0/5'
										: 'border-[var(--stroke)] hover:bg-[var(--row-hover)]'}"
							>
								<input
									type="radio"
									name="gallery_card_radio"
									value={option.value}
									bind:group={fCardRadio}
									class="radio"
								/>
								<span class="text-sm font-medium">{option.label}</span>
							</label>
						{/each}
					</div>
				</div>

				<div>
					<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-3">SegmentedControl</div>
					<SegmentedControl
						options={[
							{ id: "all", label: "All" },
							{ id: "notes", label: "Notes" },
							{ id: "files", label: "Files" },
						]}
						value={fSegment}
						onChange={(id) => (fSegment = id)}
					/>
					<p class="text-2xs text-[var(--text-muted)] mt-2">
						Active: <span class="font-mono">{fSegment}</span>
					</p>

					<div class="text-xs uppercase tracking-wider text-[var(--text-dim)] mb-3 mt-6">Fieldset + legend</div>
					<fieldset class="border border-[var(--stroke)] rounded-lg p-3">
						<legend class="px-1.5 text-xs text-[var(--text-dim)]">Option group</legend>
						<label class="flex items-center gap-2.5 text-sm cursor-pointer select-none">
							<input type="checkbox" class="checkbox" bind:checked={fNativeCheck} />
							Native checkbox in a fieldset
						</label>
					</fieldset>
				</div>
			</div>
		</section>

		<!-- TOAST, SettingsCard, ThemePicker, SearchBar -->
		<section class="mb-12">
			<h2 class="text-xl font-semibold mb-1">Toast, Cards, ThemePicker, Search</h2>

			<div class="grid grid-cols-1 sm:grid-cols-2 gap-8">
				<div>
					<h3 class="text-sm font-medium mb-2">Toast</h3>
					<div class="flex flex-wrap gap-3">
						<Button variant="normal" onclick={() => triggerToast('success')}>Success</Button>
						<Button variant="normal" onclick={() => triggerToast('info')}>Info</Button>
						<Button variant="danger" onclick={() => triggerToast('error')}>Error</Button>
					</div>
				</div>

				<div>
					<h3 class="text-sm font-medium mb-2">ThemePicker</h3>
					<ThemePicker />
				</div>

				<div>
					<h3 class="text-sm font-medium mb-2">SearchBar</h3>
					<SearchBar />
				</div>
			</div>

			<div class="mt-8">
				<h3 class="text-sm font-medium mb-2">SettingsCard</h3>
				<div class="max-w-2xl border border-[var(--stroke)] rounded-xl overflow-hidden bg-[var(--surface-panel)]">
					<SettingsCard title="Example card" description="Description here." tone="brand">
						{#snippet icon()}
							<Star class="w-6 h-6" />
						{/snippet}
						<div class="px-4 pb-4 text-sm">Content inside card.</div>
						<div class="px-4 pb-6">
							<Button variant="primary" size="sm">Action</Button>
						</div>
					</SettingsCard>
				</div>
			</div>
		</section>

		<!-- Context Menu -->
		<section class="mb-12">
			<h2 class="text-xl font-semibold mb-1">Context Menu (ctx-item)</h2>
			<p class="text-sm text-[var(--text-dim)] mb-3">
				Right-click the area below. It uses the real .ctx-menu / .ctx-item classes (as in ItemContextMenu.svelte and VirtualFiles).
			</p>

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="border-2 border-dashed border-[var(--stroke)] rounded-2xl bg-[var(--surface-raised)] p-10 text-center select-none cursor-context-menu"
				oncontextmenu={openCtxDemo}
			>
				<div class="text-[var(--text-dim)] text-sm">Right-click anywhere in this box</div>
			</div>

			{#if showCtxDemo}
				<!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
				<div class="fixed inset-0 z-[1000]" onclick={closeCtxDemo}></div>
				<ItemContextMenu
					node={ctxDemoNode}
					x={ctxDemoX}
					y={ctxDemoY}
					onClose={closeCtxDemo}
					onRename={() => closeCtxDemo()}
					onDelete={() => closeCtxDemo()}
					onCreateItem={() => closeCtxDemo()}
				/>
			{/if}
		</section>

		<!-- Additional components coverage -->
		<section class="mb-12">
			<h2 class="text-xl font-semibold mb-1">Additional UI Elements (demo)</h2>
			<p class="text-sm text-[var(--text-dim)] mb-3">
				Examples for wider coverage. For a full test, use the real parts of the application (the editor, files, the sidebar).
			</p>

			<div class="space-y-6">
				<div>
					<h3 class="text-sm font-medium mb-2">Bulk action bar (example)</h3>
					<div class="flex items-center gap-3 p-2 bg-[var(--surface-panel)] border border-[var(--stroke)] rounded">
						<span class="text-sm">3 selected</span>
						<Button size="sm" variant="ghost">Clear</Button>
						<Button size="sm" variant="danger">Delete</Button>
					</div>
				</div>

				<div>
					<h3 class="text-sm font-medium mb-2">SyncStatus example (simplified)</h3>
					<MetaText as="div">Online • 2 pending changes (see real SyncStatus.svelte in app)</MetaText>
				</div>
			</div>
		</section>

		<section>
			<h2 class="text-xl font-semibold mb-2">Notes</h2>
			<ul class="text-sm space-y-1 text-[var(--text-sub)]">
				<li>• This page is for a quick visual check. It is not a substitute for the real parts of the application.</li>
				<li>• For the context menu, submenus and keyboard navigation — use the real components in the application (FolderItem, VirtualFiles...).</li>
				<li>• Use this page plus DevTools to test across themes and focus states.</li>
			</ul>
		</section>
	</div>
</div>
