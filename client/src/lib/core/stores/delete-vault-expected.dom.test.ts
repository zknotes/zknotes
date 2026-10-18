/**
 * The expected vault address has to survive a signed-out arrival: the app layout sends such a
 * browser to sign in (dropping the fragment) and never mounts the Delete vault section, so the
 * layout captures the address on arrival. These tests pin that capture and the per-tab memory.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
    captureExpectedVaultEmailOnArrival,
    clearExpectedVaultEmail,
    DELETE_VAULT_PATH,
    loadExpectedVaultEmail,
    resolveExpectedVaultEmail,
} from "./delete-vault-expected";

beforeEach(() => sessionStorage.clear());

describe("expected vault address — per-tab memory", () => {
    it("a fragment on the Delete vault path is remembered on arrival, before any sign-in redirect", () => {
        captureExpectedVaultEmailOnArrival({ pathname: DELETE_VAULT_PATH, hash: "#email=a%40x" });
        expect(loadExpectedVaultEmail()).toBe("a@x");
    });

    it("a fragment on any other path is ignored", () => {
        captureExpectedVaultEmailOnArrival({ pathname: "/settings", hash: "#email=a%40x" });
        captureExpectedVaultEmailOnArrival({ pathname: "/create-vault", hash: "#token=abc" });
        expect(loadExpectedVaultEmail()).toBeUndefined();
    });

    it("without a fragment the remembered address applies; a new fragment replaces it", () => {
        captureExpectedVaultEmailOnArrival({ pathname: DELETE_VAULT_PATH, hash: "#email=a%40x" });
        expect(resolveExpectedVaultEmail("")).toBe("a@x");
        expect(resolveExpectedVaultEmail("#email=b%40x")).toBe("b@x");
        expect(loadExpectedVaultEmail()).toBe("b@x");
    });

    it("clearing forgets it for the tab", () => {
        resolveExpectedVaultEmail("#email=a%40x");
        clearExpectedVaultEmail();
        expect(resolveExpectedVaultEmail("")).toBeUndefined();
    });
});
