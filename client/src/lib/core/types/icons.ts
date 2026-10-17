import type { IconProps } from "lucide-svelte";
import type { ComponentConstructorOptions, SvelteComponent } from "svelte";

/**
 * A Lucide icon from `lucide-svelte`.
 *
 * In its `.d.ts`, lucide-svelte v1 still exports Svelte 4 classes (`SvelteComponentTyped`) rather than
 * Svelte 5 `Component` functions — which is why we use a constructor signature here instead of
 * `Component<IconProps>`. Once lucide moves to function-component types, narrow this to
 * `Component<IconProps>`.
 */
export type LucideIcon = new (
    options: ComponentConstructorOptions<IconProps>,
) => SvelteComponent<IconProps>;
