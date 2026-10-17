// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    clearVaultKey,
    getStoredVaultKey,
    invalidateSessionGeneration,
    isVaultSessionCurrent,
    storeVaultKey,
} from "./session-key";

describe("session-key", () => {
    beforeEach(() => {
        sessionStorage.clear();
        localStorage.clear();
    });

    afterEach(() => {
        sessionStorage.clear();
        localStorage.clear();
    });

    it("storeVaultKey persists under vault_key in sessionStorage only", () => {
        storeVaultKey("dGVzdC1rZXk=");
        expect(sessionStorage.getItem("vault_key")).toBe("dGVzdC1rZXk=");
        expect(localStorage.getItem("vault_key")).toBeNull();
    });

    it("getStoredVaultKey returns stored key", () => {
        sessionStorage.setItem("vault_key", "YWJj");
        expect(getStoredVaultKey()).toBe("YWJj");
    });

    it("getStoredVaultKey returns null when empty", () => {
        expect(getStoredVaultKey()).toBeNull();
    });

    it("clearVaultKey removes vault_key from sessionStorage", () => {
        sessionStorage.setItem("vault_key", "YWJj");
        clearVaultKey();
        expect(sessionStorage.getItem("vault_key")).toBeNull();
    });

    it("storeVaultKey binds session generation so restore is valid", () => {
        storeVaultKey("dGVzdC1rZXk=");
        expect(isVaultSessionCurrent()).toBe(true);
    });

    it("invalidateSessionGeneration makes prior tab vault_key stale", () => {
        storeVaultKey("dGVzdC1rZXk=");
        expect(isVaultSessionCurrent()).toBe(true);
        invalidateSessionGeneration();
        expect(isVaultSessionCurrent()).toBe(false);
    });
});
