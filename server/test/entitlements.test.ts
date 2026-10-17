// The self-host quota defaults decide how much a new account gets when there is no plan behind the
// question, and they are read from the environment at call time. Two things here are easy to break
// without noticing, so they are pinned: the per-file limit a fresh self-host user gets, and the
// clamp that keeps an ops override inside what the upload format can actually carry — an override
// above `MAX_FILE_SIZE_CAP` would be refused by the Zod schema on POST /uploads anyway, and would
// only make a 413 report a limit that does not exist.
import { FILE_LIMITS } from "@zknotes/shared";
import { afterEach, describe, expect, test } from "bun:test";
import { permissiveEntitlementsProvider } from "../src/entitlements";

const KEY = "SELF_HOST_MAX_FILE_SIZE";
const previous = process.env[KEY];

const maxFileSize = () => permissiveEntitlementsProvider.quotaForNewUser().maxFileSize;

afterEach(() => {
    if (previous === undefined) delete process.env[KEY];
    else process.env[KEY] = previous;
});

describe("the self-host per-file size limit", () => {
    test("defaults to the format's own ceiling — a self-host is bounded by its disk, not by a plan", () => {
        delete process.env[KEY];
        expect(maxFileSize()).toBe(FILE_LIMITS.MAX_FILE_SIZE_CAP);
    });

    test("an override below the ceiling is honoured", () => {
        process.env[KEY] = String(256 * 1024 * 1024);
        expect(maxFileSize()).toBe(256 * 1024 * 1024);
    });

    test("an override above the ceiling is clamped to it", () => {
        process.env[KEY] = String(FILE_LIMITS.MAX_FILE_SIZE_CAP * 4);
        expect(maxFileSize()).toBe(FILE_LIMITS.MAX_FILE_SIZE_CAP);
    });

    test("an unusable value falls back to the default rather than to zero", () => {
        process.env[KEY] = "banana";
        expect(maxFileSize()).toBe(FILE_LIMITS.MAX_FILE_SIZE_CAP);
        process.env[KEY] = "-1";
        expect(maxFileSize()).toBe(FILE_LIMITS.MAX_FILE_SIZE_CAP);
    });
});

describe("the self-host storage quota", () => {
    test("stays a plain env number — it is the quota, not the per-file limit, that bounds the disk", () => {
        const key = "SELF_HOST_STORAGE_QUOTA";
        const prev = process.env[key];
        try {
            delete process.env[key];
            expect(permissiveEntitlementsProvider.quotaForNewUser().storageQuota).toBe(
                100 * 1024 * 1024 * 1024,
            );
            process.env[key] = String(2 * 1024 * 1024 * 1024 * 1024);
            expect(permissiveEntitlementsProvider.quotaForNewUser().storageQuota).toBe(
                2 * 1024 * 1024 * 1024 * 1024,
            );
        } finally {
            if (prev === undefined) delete process.env[key];
            else process.env[key] = prev;
        }
    });
});
