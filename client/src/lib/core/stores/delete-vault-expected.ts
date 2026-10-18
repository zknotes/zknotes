/**
 * Which vault the caller expects Settings → Delete vault to delete.
 *
 * On a hosted instance the account area lives on another origin with its own session, so the
 * browser may be signed in to a different vault than the one the user has in mind. The account
 * area names the vault in the URL fragment (`#email=…`), which never reaches the server. A fragment
 * is one-shot, though: the sign-in redirect of a signed-out browser, signing out and back in, and
 * switching Settings tabs all drop it. So the address is kept in sessionStorage for the tab, and
 * the section reads it back whenever the fragment is gone. It is an address, not a secret; it is
 * deliberately not cleared on sign-out, because "sign out, sign in to the right vault, come back"
 * is the very case it has to survive.
 */

/** The fragment key the account area writes — a contract between the two origins; keep in sync. */
export const EXPECTED_VAULT_EMAIL_FRAGMENT_KEY = "email";

const STORAGE_KEY = "cn_delete_vault_expected_email";

/** The address named in a `#email=…` fragment, or undefined when the fragment does not name one. */
export function expectedVaultEmailFromFragment(hash: string): string | undefined {
    const raw = new URLSearchParams(hash.replace(/^#/, ""))
        .get(EXPECTED_VAULT_EMAIL_FRAGMENT_KEY)
        ?.trim();
    return raw || undefined;
}

export function loadExpectedVaultEmail(): string | undefined {
    try {
        return sessionStorage.getItem(STORAGE_KEY)?.trim() || undefined;
    } catch {
        // private mode / disabled storage / no window
        return undefined;
    }
}

export function clearExpectedVaultEmail(): void {
    try {
        sessionStorage.removeItem(STORAGE_KEY);
    } catch {
        // best-effort
    }
}

function rememberExpectedVaultEmail(email: string): void {
    try {
        sessionStorage.setItem(STORAGE_KEY, email);
    } catch {
        // best-effort
    }
}

/**
 * On arrival: a fragment wins and is remembered for the tab; without one, the remembered address
 * applies. Returns undefined when nobody named a vault (self-host, a direct visit).
 */
export function resolveExpectedVaultEmail(hash: string): string | undefined {
    const fromFragment = expectedVaultEmailFromFragment(hash);
    if (fromFragment) {
        rememberExpectedVaultEmail(fromFragment);
        return fromFragment;
    }
    return loadExpectedVaultEmail();
}

/** The Settings path whose fragment may name a vault. */
export const DELETE_VAULT_PATH = "/settings/delete-account";

/**
 * Capture the address the moment the app loads, before anything else happens to the URL.
 *
 * The app layout renders its pages only while the vault is unlocked and sends a signed-out browser
 * to sign in, which drops the fragment — so for exactly the user the check exists for (came from the
 * account area, not signed in here, or signed in to the wrong vault and about to sign out) the
 * section itself never gets to read it. The layout calls this on arrival instead; other paths are
 * ignored so an unrelated fragment is never mistaken for a vault address.
 */
export function captureExpectedVaultEmailOnArrival(location: {
    pathname: string;
    hash: string;
}): void {
    if (location.pathname !== DELETE_VAULT_PATH) return;
    resolveExpectedVaultEmail(location.hash);
}
