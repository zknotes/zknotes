/**
 * How hard a vault password is to guess — advice only, it never blocks a password.
 *
 * The vault password is the key: whoever holds the encrypted vault can try guesses offline, as fast
 * as Argon2id allows and with no lockout. So length counts the most, a mix of character kinds helps a
 * shorter password, and a well-known password or a simple pattern is weak at any length — `Password1!`
 * has all four kinds and is still among the first guesses.
 *
 * The forms show the level as the user types and warn once about a weak password before they act.
 */

export type PasswordStrengthLevel = "weak" | "fair" | "strong";

/** Why a password is not strong — the forms turn it into one line of advice. */
export type PasswordWeakness = "common" | "pattern" | "short" | "few-kinds";

export type PasswordStrength = {
    level: PasswordStrengthLevel;
    weakness: PasswordWeakness | null;
};

/** Below this a password is weak whatever it is made of. */
const MIN_FAIR_LENGTH = 8;
/** The length the advice asks for; from here three kinds of character make a password strong. */
export const RECOMMENDED_PASSWORD_LENGTH = 12;
/** From this length on a password is strong whatever it is made of — a few random words. */
const PASSPHRASE_LENGTH = 16;
/** How many kinds of character (lower, upper, digit, symbol) a shorter password needs. */
const MIN_KINDS = 3;

const KINDS = [/\p{Ll}/u, /\p{Lu}/u, /\p{N}/u, /[^\p{L}\p{N}]/u];

/**
 * The passwords tried first, after stripping the digits and symbols around them and undoing the
 * usual letter swaps (`P@ssw0rd!` → `password`). A short list on purpose: it catches the obvious
 * cases without shipping a dictionary to every client.
 */
const COMMON = new Set([
    "password",
    "qwerty",
    "qwertz",
    "letmein",
    "welcome",
    "iloveyou",
    "admin",
    "administrator",
    "login",
    "secret",
    "monkey",
    "dragon",
    "football",
    "baseball",
    "sunshine",
    "princess",
    "master",
    "shadow",
    "superman",
    "trustno",
    "abc",
    "zknotes",
    "notes",
    "lozinka",
    "sifra",
    "zaporka",
]);

const LEET: Record<string, string> = {
    "0": "o",
    "1": "i",
    "3": "e",
    "4": "a",
    "5": "s",
    "7": "t",
    "@": "a",
    $: "s",
    "!": "i",
};

/** Runs that are typed rather than chosen: the alphabet, the digits and the keyboard rows. */
const SEQUENCES = [
    "abcdefghijklmnopqrstuvwxyz",
    "0123456789",
    "1234567890",
    "qwertyuiop",
    "qwertzuiop",
    "asdfghjkl",
    "zxcvbnm",
    "yxcvbnm",
].flatMap((s) => [s, [...s].reverse().join("")]);

function isCommon(password: string): boolean {
    const core = password
        .toLowerCase()
        .replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "")
        .replace(/[013457@$!]/g, (c) => LEET[c] ?? c)
        .normalize("NFD")
        .replace(/\p{M}/gu, "");
    return COMMON.has(core);
}

function isPattern(password: string): boolean {
    // The whole password is one unit repeated: `aaaaaaaa`, `abab`, `passwordpassword`.
    if (/^(.+?)\1+$/su.test(password)) return true;
    const lower = password.toLowerCase();
    return lower.length >= 3 && SEQUENCES.some((s) => s.includes(lower));
}

function countKinds(password: string): number {
    return KINDS.filter((kind) => kind.test(password)).length;
}

export function passwordStrength(password: string): PasswordStrength {
    if (isCommon(password)) return { level: "weak", weakness: "common" };
    if (isPattern(password)) return { level: "weak", weakness: "pattern" };

    const length = [...password].length;
    if (length < MIN_FAIR_LENGTH) return { level: "weak", weakness: "short" };
    if (length >= PASSPHRASE_LENGTH) return { level: "strong", weakness: null };

    const enoughKinds = countKinds(password) >= MIN_KINDS;
    if (length >= RECOMMENDED_PASSWORD_LENGTH) {
        return enoughKinds
            ? { level: "strong", weakness: null }
            : { level: "fair", weakness: "few-kinds" };
    }
    return enoughKinds
        ? { level: "fair", weakness: "short" }
        : { level: "weak", weakness: "few-kinds" };
}
