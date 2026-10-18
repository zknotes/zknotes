/**
 * The fragment key is a contract with the account area, which writes `#email=…` on the link to
 * Settings → Delete vault. Renaming it on either side would silently switch the wrong-vault check
 * off (no fragment means "nobody named a vault"), so the key is pinned here.
 */
import { describe, expect, it } from "vitest";
import {
    EXPECTED_VAULT_EMAIL_FRAGMENT_KEY,
    expectedVaultEmailFromFragment,
} from "./delete-vault-expected";

describe("expected vault address in the URL fragment", () => {
    it("the key the account area writes is `email`", () => {
        expect(EXPECTED_VAULT_EMAIL_FRAGMENT_KEY).toBe("email");
    });

    it("reads the percent-encoded address the account area produces", () => {
        expect(expectedVaultEmailFromFragment("#email=a%2Bb%40x.y")).toBe("a+b@x.y");
    });

    it("is undefined without a fragment or without the key", () => {
        expect(expectedVaultEmailFromFragment("")).toBeUndefined();
        expect(expectedVaultEmailFromFragment("#token=abc")).toBeUndefined();
        expect(expectedVaultEmailFromFragment("#email=")).toBeUndefined();
    });
});
