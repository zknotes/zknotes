import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * docker/setup.sh: its helpers, sourced, and a whole non-interactive run with --no-start (which
 * writes docker/.env and the storage site but builds and starts nothing).
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SETUP = join(ROOT, "docker/setup.sh");
const EXAMPLE = join(ROOT, "server/.env.example");
const dirs: string[] = [];

afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workdir(): string {
    const d = mkdtempSync(join(tmpdir(), "zknotes-setup-"));
    dirs.push(d);
    return d;
}

/** Runs `snippet` with setup.sh sourced and ENV_FILE pointing into `dir`. */
function lib(dir: string, snippet: string) {
    const res = spawnSync("bash", ["-c", `source "${SETUP}" && ${snippet}`], {
        env: { ...process.env, ENV_FILE: join(dir, ".env"), SITES_DIR: join(dir, "sites") },
        encoding: "utf8",
    });
    return { status: res.status, out: res.stdout.trim(), err: res.stderr };
}

function run(dir: string, args: string[]) {
    const res = spawnSync("bash", [SETUP, ...args, "--no-start"], {
        env: {
            ...process.env,
            ENV_FILE: join(dir, ".env"),
            ENV_EXAMPLE: EXAMPLE,
            SITES_DIR: join(dir, "sites"),
        },
        encoding: "utf8",
        input: "",
    });
    return { status: res.status, out: res.stdout, err: res.stderr };
}

function envOf(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of readFileSync(join(dir, ".env"), "utf8").split("\n")) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (m?.[1] && !(m[1] in out)) out[m[1]] = m[2] ?? "";
    }
    return out;
}

describe("env editing", () => {
    it("replaces a set key, uncomments a commented one, appends a missing one, and keeps the rest", () => {
        const dir = workdir();
        writeFileSync(join(dir, ".env"), "# header\nA=1\n# B=example\nC=3\n");
        expect(lib(dir, "env_set A 10 && env_set B 20 && env_set D 40").status).toBe(0);
        expect(readFileSync(join(dir, ".env"), "utf8")).toBe("# header\nA=10\nB=20\nC=3\nD=40\n");
    });

    it("never overwrites a real value with env_ensure, and fills a placeholder", () => {
        const dir = workdir();
        writeFileSync(
            join(dir, ".env"),
            "KDF_FAKE_SEED=keep-this-seed\nCOOKIE_SECRET=REPLACE_WITH_LONG_RANDOM_STRING\nS3_ACCESS_KEY=minioadmin\n",
        );
        lib(
            dir,
            "env_ensure KDF_FAKE_SEED new && env_ensure COOKIE_SECRET new && env_ensure S3_ACCESS_KEY new",
        );
        expect(envOf(dir)).toEqual({
            KDF_FAKE_SEED: "keep-this-seed",
            COOKIE_SECRET: "new",
            S3_ACCESS_KEY: "new",
        });
    });

    it("keeps a value with characters awk would otherwise interpret", () => {
        const dir = workdir();
        writeFileSync(join(dir, ".env"), "X=old\n");
        lib(dir, `env_set X 'a&b\\c/d'`);
        expect(envOf(dir).X).toBe("a&b\\c/d");
    });
});

describe("helpers", () => {
    it("random_hex gives the asked number of bytes", () => {
        const out = lib(workdir(), "random_hex 32").out;
        expect(out).toMatch(/^[0-9a-f]{64}$/);
    });

    it("valid_domain accepts host names and refuses the rest", () => {
        const dir = workdir();
        for (const ok of ["notes.example.com", "a.b.co", "xn--d1acpjx3f.xn--p1ai"]) {
            expect(lib(dir, `valid_domain ${ok}`).status).toBe(0);
        }
        for (const bad of [
            "localhost",
            "https://notes.example.com",
            "notes example.com",
            "-a.com",
        ]) {
            expect(lib(dir, `valid_domain '${bad}'`).status).toBe(1);
        }
    });

    it("rootless_fix_plan follows Docker's rootless guide", () => {
        const dir = workdir();
        const plan = (args: string) => lib(dir, `rootless_fix_plan ${args}`).out;
        // rootlesskit, port driver, userland-proxy off, docker major, pasta, slirp4netns
        expect(plan("2.3.4 slirp4netns 0 27 0 0")).toBe("ok");
        expect(plan("2.3.4 implicit 0 27 1 0")).toBe("ok");
        expect(plan("3.0.1 builtin 1 28 0 0")).toBe("ok");
        expect(plan("3.0.1 builtin 0 28 0 0")).toBe("userland-proxy");
        expect(plan("2.3.4 builtin 0 27 1 1")).toBe("pasta");
        expect(plan("2.3.4 builtin 0 24 1 1")).toBe("slirp4netns");
        expect(plan("'' builtin 0 27 0 1")).toBe("slirp4netns");
        expect(plan("2.3.4 builtin 0 27 0 0")).toBe("manual");
    });
});

describe("a whole run (--no-start)", () => {
    it("writes a complete production .env with the built-in storage", () => {
        const dir = workdir();
        const res = run(dir, ["--domain", "notes.example.com"]);
        expect(res.status, res.err).toBe(0);
        const env = envOf(dir);
        expect(env.APP_DOMAIN).toBe("notes.example.com");
        expect(env.CORS_ORIGIN).toBe("https://notes.example.com");
        expect(env.COMPOSE_PROFILES).toBe("storage");
        expect(env.STORAGE_DOMAIN).toBe("s3.notes.example.com");
        expect(env.S3_ENDPOINT).toBe("https://s3.notes.example.com");
        for (const key of [
            "POSTGRES_PASSWORD",
            "COOKIE_SECRET",
            "KDF_FAKE_SEED",
            "GARAGE_RPC_SECRET",
        ]) {
            expect(env[key], key).toMatch(/^[0-9a-f]{64}$/);
        }
        expect(env.S3_ACCESS_KEY).toMatch(/^GK[0-9a-f]{24}$/);
        expect(env.S3_SECRET_KEY).toMatch(/^[0-9a-f]{64}$/);
        expect(readFileSync(join(dir, "sites/storage.caddy"), "utf8")).toContain(
            "reverse_proxy garage:3900",
        );
    });

    it("keeps every secret on a second run, also with another domain", () => {
        const dir = workdir();
        expect(run(dir, ["--domain", "notes.example.com"]).status).toBe(0);
        const first = envOf(dir);
        expect(run(dir, ["--domain", "vault.example.org"]).status).toBe(0);
        const second = envOf(dir);
        expect(second.APP_DOMAIN).toBe("vault.example.org");
        expect(second.S3_ENDPOINT).toBe("https://s3.vault.example.org");
        for (const key of [
            "POSTGRES_PASSWORD",
            "COOKIE_SECRET",
            "KDF_FAKE_SEED",
            "GARAGE_RPC_SECRET",
            "S3_ACCESS_KEY",
            "S3_SECRET_KEY",
        ]) {
            expect(second[key], key).toBe(first[key]);
        }
    });

    it("refuses external storage it cannot ask for, and a missing domain", () => {
        expect(
            run(workdir(), ["--domain", "notes.example.com", "--storage", "external"]).status,
        ).toBe(1);
        expect(run(workdir(), []).status).toBe(1);
    });

    it("refuses a storage domain equal to the vault's", () => {
        const res = run(workdir(), [
            "--domain",
            "notes.example.com",
            "--storage-domain",
            "notes.example.com",
        ]);
        expect(res.status).toBe(1);
    });
});
