import { describe, expect, it } from "vitest";
import { passwordStrength } from "./password-strength";

const level = (password: string) => passwordStrength(password).level;

describe("passwordStrength", () => {
    it("calls the advice's own example strong — four random words, lowercase and spaces", () => {
        expect(passwordStrength("lamp river cactus tuesday")).toEqual({
            level: "strong",
            weakness: null,
        });
    });

    it("keeps the E2E passwords strong, so the one-time warning never stops a spec", () => {
        expect(level("correct-horse-battery-staple")).toBe("strong");
        expect(level("brand-new-master-passphrase-9000")).toBe("strong");
    });

    it("is weak below eight characters, whatever the mix", () => {
        expect(passwordStrength("aB3$xY")).toEqual({ level: "weak", weakness: "short" });
        expect(passwordStrength("ok")).toEqual({ level: "weak", weakness: "short" });
    });

    it("needs three kinds of character between 8 and 11 characters", () => {
        expect(passwordStrength("tulipgarden")).toEqual({ level: "weak", weakness: "few-kinds" });
        expect(passwordStrength("Tulip-garden")).toEqual({ level: "strong", weakness: null });
        expect(passwordStrength("Tulip-gar")).toEqual({ level: "fair", weakness: "short" });
    });

    it("is fair from 12 characters with fewer kinds, strong with three", () => {
        expect(passwordStrength("tulipgardens")).toEqual({ level: "fair", weakness: "few-kinds" });
        expect(passwordStrength("Tulipgardens7")).toEqual({ level: "strong", weakness: null });
    });

    it("is strong from 16 characters even in one kind", () => {
        expect(level("tulipgardenriver")).toBe("strong");
    });

    it("counts characters, not UTF-16 units", () => {
        // Seven emoji are fourteen UTF-16 units but still seven characters — below eight.
        expect(passwordStrength("🔑🔒🔓🔐🔏🚪🧱")).toEqual({ level: "weak", weakness: "short" });
    });

    it("counts non-ASCII letters by case", () => {
        expect(level("Čevapi-i-ćuft")).toBe("strong");
    });

    it("rejects well-known passwords dressed up with digits, symbols and letter swaps", () => {
        for (const password of [
            "password",
            "Password1!",
            "P@ssw0rd2024",
            "qwerty123",
            "šifra!!",
            "Lozinka1",
        ]) {
            expect(passwordStrength(password), password).toEqual({
                level: "weak",
                weakness: "common",
            });
        }
    });

    it("does not reject a passphrase that merely contains a common word", () => {
        expect(level("my password is a long horse")).toBe("strong");
    });

    it("rejects repeats and typed runs at any length", () => {
        for (const password of [
            "aaaaaaaaaaaaaaaaaaaa",
            "abcabcabcabc",
            "Tulip-7Tulip-7",
            "1234567890",
            "abcdefghijklmnop",
            "asdfghjkl",
            "0987654321",
        ]) {
            expect(passwordStrength(password), password).toEqual({
                level: "weak",
                weakness: "pattern",
            });
        }
    });
});
