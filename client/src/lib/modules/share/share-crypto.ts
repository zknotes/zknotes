import { type KdfParams, PRODUCTION_KDF_PARAMS, toPlainKdfParams } from "@zknotes/shared";

/** The one KDF context for a share password — the auth and the unwrap have to use the same values. */
export function resolveSharePasswordKdf(meta: { kdfSalt?: string | null; kdfParams?: KdfParams }): {
    kdfSaltB64: string | undefined;
    kdfParams: KdfParams;
} {
    return {
        kdfSaltB64: meta.kdfSalt ?? undefined,
        kdfParams: toPlainKdfParams(meta.kdfParams ?? PRODUCTION_KDF_PARAMS),
    };
}

/**
 * Reads the #k= fragment key out of the URL.
 * window.location.hash is more dependable than page.url.hash (a SvelteKit hash triggers no reroute).
 */
export function readShareFragmentKey(): string | null {
    if (typeof window === "undefined") return null;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return null;
    return new URLSearchParams(hash).get("k");
}
