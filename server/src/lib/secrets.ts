/** The prefix of the placeholder values in `server/.env.example`. */
const PLACEHOLDER_PREFIX = "REPLACE_WITH";

/**
 * Whether a server secret is still unconfigured: unset, blank, the development default, or the
 * `REPLACE_WITH_…` placeholder from `.env.example`. A self-hoster who copies the example file and
 * forgets to edit a line must not start production with a publicly known secret.
 */
export function isUnconfiguredSecret(value: string | undefined, devDefault: string): boolean {
    const trimmed = value?.trim() ?? "";
    return trimmed === "" || trimmed === devDefault || trimmed.startsWith(PLACEHOLDER_PREFIX);
}

/** Production secrets are at least this long; `openssl rand -hex 32` gives 64 characters. */
export const MIN_SECRET_LENGTH = 32;

/**
 * Refuse to start production with a secret that is unconfigured or short enough to guess. For
 * KDF_FAKE_SEED a guessable seed is as bad as a public one: the fake salt is an HMAC over it, so
 * whoever has it can tell a real account's salt from a fake one.
 */
export function assertProductionSecret(
    name: string,
    value: string | undefined,
    devDefault: string,
): void {
    if (isUnconfiguredSecret(value, devDefault)) {
        throw new Error(`${name} must be securely configured in production.`);
    }
    if ((value?.trim().length ?? 0) < MIN_SECRET_LENGTH) {
        throw new Error(
            `${name} must be at least ${MIN_SECRET_LENGTH} characters in production ` +
                "(generate one with `openssl rand -hex 32`).",
        );
    }
}
