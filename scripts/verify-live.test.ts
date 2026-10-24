import { spawn, spawnSync } from "node:child_process";
import {
    chmodSync,
    cpSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/verify-live.sh against a server that stands in for nginx, without Docker.
 *
 * The script is copied into a throwaway git repository next to a stub `lib-build-web.sh` whose
 * `build_web_root` copies a prepared web root instead of building an image, so the comparison
 * logic — what is fetched, how a difference, a missing file, a failed request or a compressed
 * answer is reported, and which exit code wins — is exercised with the real bash code. The server
 * answers like nginx does: a real 404 under /_app/immutable/, the SPA shell with a 200 everywhere
 * else, plus knobs for what a dishonest or misconfigured server would do.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** What the fake server does besides serving the web root. */
type Knobs = {
    /** Answer this route with a different document (everything else honest). */
    differentDocumentAt?: string;
    /** Append bytes to this file's answer. */
    tamper?: string;
    /** Close the connection without answering for this path. */
    dropRequestFor?: string;
    /** Serve this file gzip-compressed, with Content-Encoding: gzip. */
    gzip?: string;
    /** Serve this file as if it did not exist (SPA shell with a 200). */
    missing?: string;
    /** Answer this route with a redirect. */
    redirectRouteTo?: { route: string; location: string };
    /** Serve this exact body for /_app/version.json. */
    versionJson?: string;
};

let server: Server;
let port = 0;
let knobs: Knobs = {};
const requests: { path: string; headers: IncomingHttpHeaders }[] = [];

let work: string;
let repo: string;
let webroot: string;
let sha: string;

function git(dir: string, ...args: string[]): string {
    const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (res.status !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
}

/** The stub build: no docker, the prepared web root, version.json from the commit it is given. */
const STUB_LIB = `
check_build_tools() { return 0; }
build_web_root() {
    cp -r "$STUB_WEBROOT" "$4"
    printf '{"version":"%s"}' "$2" > "$4/_app/version.json"
}
`;

function makeRepo(dir: string): void {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(join(ROOT, "scripts/verify-live.sh"), join(dir, "scripts/verify-live.sh"));
    cpSync(join(ROOT, "scripts/tree-hash.sh"), join(dir, "scripts/tree-hash.sh"));
    writeFileSync(join(dir, "scripts/lib-build-web.sh"), STUB_LIB);
    chmodSync(join(dir, "scripts/verify-live.sh"), 0o755);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "add", "scripts");
    git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "scripts");
}

function makeWebroot(dir: string, commit: string): void {
    mkdirSync(join(dir, "_app/immutable/entry"), { recursive: true });
    writeFileSync(
        join(dir, "index.html"),
        '<!doctype html><html><head><title>ZKnotes</title></head><body><script type="module" src="/_app/immutable/entry/app.js"></script></body></html>\n',
    );
    writeFileSync(join(dir, "_app/immutable/entry/app.js"), 'console.log("app")\n');
    writeFileSync(join(dir, "robots.txt"), "User-agent: *\n");
    writeFileSync(join(dir, "service-worker.js"), "self.addEventListener('fetch',()=>{})\n");
    writeFileSync(join(dir, "_app/version.json"), `{"version":"${commit}"}`);
}

function shell(): Buffer {
    return readFileSync(join(webroot, "index.html"));
}

beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "zknotes-verify-live-"));
    repo = join(work, "repo");
    webroot = join(work, "webroot");
    makeRepo(repo);
    sha = git(repo, "rev-parse", "HEAD");
    makeWebroot(webroot, sha);

    server = createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0] ?? "/";
        const rel = path.replace(/^\/+/, "");
        requests.push({ path, headers: req.headers });
        const send = (
            code: number,
            body: Buffer | string,
            type: string,
            extra: Record<string, string> = {},
        ) => {
            res.writeHead(code, {
                "Content-Type": type,
                "Content-Length": Buffer.byteLength(body),
                ...extra,
            });
            res.end(body);
        };
        if (rel === knobs.dropRequestFor) {
            req.socket.destroy();
            return;
        }
        if (rel === "_app/version.json" && knobs.versionJson !== undefined) {
            send(200, knobs.versionJson, "application/json");
            return;
        }
        if (knobs.redirectRouteTo && rel === knobs.redirectRouteTo.route) {
            send(301, "", "text/html", { Location: knobs.redirectRouteTo.location });
            return;
        }
        if (rel === knobs.differentDocumentAt) {
            const body = shell()
                .toString()
                .replace("</body>", '<script src="/_app/immutable/entry/evil.js"></script></body>');
            send(200, body, "text/html");
            return;
        }
        const file = join(webroot, rel);
        let body: Buffer | undefined;
        try {
            if (rel !== "" && rel !== knobs.missing) body = readFileSync(file);
        } catch {
            body = undefined;
        }
        if (body) {
            if (rel === knobs.tamper) body = Buffer.concat([body, Buffer.from("\n// tampered\n")]);
            if (rel === knobs.gzip) {
                send(200, gzipSync(body), "application/javascript", {
                    "Content-Encoding": "gzip",
                });
                return;
            }
            send(200, body, "application/octet-stream");
            return;
        }
        if (rel.startsWith("_app/immutable/")) {
            send(404, "not found", "text/plain");
            return;
        }
        send(200, shell(), "text/html");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    port = address.port;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(work, { recursive: true, force: true });
});

afterEach(() => {
    knobs = {};
    requests.length = 0;
});

/**
 * Runs the script from `fromRepo` (default: the throwaway repository) against the fake server.
 * Asynchronous on purpose: the server lives in this same worker, and a synchronous spawn would
 * block the event loop and leave every request of the script unanswered.
 */
function run(args: string[] = [], fromRepo = repo, url = `http://127.0.0.1:${port}`) {
    return new Promise<{ status: number | null; out: string; err: string }>((resolve) => {
        const child = spawn("bash", [join(fromRepo, "scripts/verify-live.sh"), url, ...args], {
            env: { ...process.env, STUB_WEBROOT: webroot },
        });
        let out = "";
        let err = "";
        child.stdout.setEncoding("utf8").on("data", (d: string) => {
            out += d;
        });
        child.stderr.setEncoding("utf8").on("data", (d: string) => {
            err += d;
        });
        child.on("close", (status) => resolve({ status, out, err }));
    });
}

// 5 files + "/" + 7 routes (6 fixed, 1 random).
const CHECKED = 5 + 1 + 7;

describe("verify-live.sh — what is fetched", () => {
    it("an honest server: every file, / and every route match, exit 0", async () => {
        const r = await run();
        expect(r.status).toBe(0);
        expect(r.out).toContain(`match=${CHECKED}/${CHECKED}`);
        expect(r.out).toContain(`commit=${sha}`);
        const paths = requests.map((q) => q.path);
        for (const route of [
            "/login",
            "/create-vault",
            "/settings",
            "/s/x",
            "/note/x",
            "/login/",
        ]) {
            expect(paths).toContain(route);
        }
        expect(paths.some((p) => /^\/verify-[0-9a-f]{16}$/.test(p))).toBe(true);
    });

    it("a route that serves another document is a difference, even when / is honest", async () => {
        knobs = { differentDocumentAt: "login" };
        const r = await run();
        expect(r.status).toBe(1);
        expect(r.out).toContain("/login (route → index.html): differs");
        expect(r.out).toContain(`match=${CHECKED - 1}/${CHECKED}`);
    });

    it("a route that redirects is named as a redirect of the route", async () => {
        knobs = { redirectRouteTo: { route: "login/", location: "/login" } };
        const r = await run();
        expect(r.status).toBe(1);
        expect(r.out).toContain("/login/ (route → index.html): HTTP 301 — the route redirects");
    });

    it("asks for documents the way a browser does, and never as curl", async () => {
        await run();
        for (const q of requests) {
            expect(q.headers["user-agent"]).not.toMatch(/^curl/);
            expect(q.headers["accept-encoding"]).toBe("identity");
        }
        const doc = requests.find((q) => q.path === "/login");
        expect(doc?.headers.accept).toMatch(/^text\/html/);
        expect(doc?.headers["sec-fetch-mode"]).toBe("navigate");
        const asset = requests.find((q) => q.path === "/_app/immutable/entry/app.js");
        expect(asset?.headers["sec-fetch-mode"]).toBe("no-cors");
    });
});

describe("verify-live.sh — how a difference is reported", () => {
    it("a tampered chunk is named with both hashes", async () => {
        knobs = { tamper: "_app/immutable/entry/app.js" };
        const r = await run();
        expect(r.status).toBe(1);
        expect(r.out).toMatch(
            /\/_app\/immutable\/entry\/app\.js: differs\n\s+expected [0-9a-f]{64}\n\s+served {3}[0-9a-f]{64}/,
        );
    });

    it("a static file the server lacks is reported as missing, not as different", async () => {
        knobs = { missing: "robots.txt" };
        const r = await run();
        expect(r.status).toBe(1);
        expect(r.out).toContain("/robots.txt: missing — the server answered with the SPA shell");
    });

    it("a difference wins over a failed request: exit 1, both listed", async () => {
        knobs = { tamper: "robots.txt", dropRequestFor: "service-worker.js" };
        const r = await run();
        expect(r.status).toBe(1);
        expect(r.out).toContain("/robots.txt: differs");
        expect(r.out).toContain("/service-worker.js: request failed");
        expect(r.err).toContain("1 request(s) failed — repeat the run for those");
    });

    it("a failed request alone is an environment error: exit 2", async () => {
        knobs = { dropRequestFor: "service-worker.js" };
        const r = await run();
        expect(r.status).toBe(2);
        expect(r.err).toContain("1 request(s) failed and nothing else differs");
    });

    it("a compressed answer says so instead of sending the reader to diffoscope", async () => {
        knobs = { gzip: "_app/immutable/entry/app.js" };
        const r = await run();
        expect(r.status).toBe(1);
        expect(r.out).toContain("the server compressed the answer (Content-Encoding: gzip)");
    });
});

describe("verify-live.sh — the version the instance reports", () => {
    it("a url inside the app gets the SPA shell as version.json and is told so", async () => {
        const r = await run([], repo, `http://127.0.0.1:${port}/login`);
        expect(r.status).toBe(2);
        expect(r.err).toContain("is not a ZKnotes version file");
        expect(r.err).not.toContain("built without APP_COMMIT");
    });

    it("a version that is not a commit cannot be verified, and --commit is offered", async () => {
        knobs = { versionJson: '{"version":"1761300000000"}' };
        const r = await run();
        expect(r.status).toBe(2);
        expect(r.err).toContain("which is not a commit hash");
        expect(r.err).toContain("--commit <sha> forces the comparison");
    });

    it("--commit builds the given commit and still compares version.json as a file", async () => {
        knobs = { versionJson: '{"version":"1761300000000"}' };
        const r = await run(["--commit", sha]);
        expect(r.status).toBe(1);
        expect(r.out).toContain("/_app/version.json: differs");
    });
});

describe("verify-live.sh — the clone it runs from", () => {
    it("a commit the clone lacks, with no origin to fetch from, is an environment error", async () => {
        const r = await run(["--commit", "0123456789abcdef0123456789abcdef01234567"]);
        expect(r.status).toBe(2);
        expect(r.err).toContain("has no remote named origin");
    });

    it("a shallow clone says it cannot tell whether the commit is on origin/main", async () => {
        const shallow = join(work, "shallow");
        const res = spawnSync("git", ["clone", "-q", "--depth", "1", `file://${repo}`, shallow], {
            encoding: "utf8",
        });
        expect(res.status).toBe(0);
        const r = await run([], shallow);
        expect(r.status).toBe(0);
        expect(r.out).toContain("on_origin_main=unknown (shallow clone");
    });

    it("a full clone with origin reports where the commit sits", async () => {
        const full = join(work, "full");
        spawnSync("git", ["clone", "-q", `file://${repo}`, full], { encoding: "utf8" });
        const r = await run([], full);
        expect(r.status).toBe(0);
        expect(r.out).toContain("on_origin_main=yes, 0 commit(s) behind origin/main");
    });
});
