// The CLA check behind .github/workflows/cla.yml.
//
// It runs from the DEFAULT branch's copy of this file and treats the pull request purely as data,
// read through the API — the workflow header explains why that is what makes `pull_request_target`
// safe here. Nothing from the pull request is executed, put into a shell, or trusted.
//
// Every run re-derives the whole state from GitHub instead of trusting the event that started it:
// it lists who authored the pull request's commits, collects signature comments from the whole
// thread, records the new ones, then sets the `CLA` commit status and keeps a single bot comment up
// to date. A run that was skipped or failed is therefore harmless; the next one catches up.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Bump together with the version line in .github/CLA.md whenever the agreement's text changes. */
export const CLA_VERSION = "1.1";
export const SIGN_PHRASE = `I have read the ZKnotes CLA version ${CLA_VERSION} and I hereby sign it.`;
export const STATUS_CONTEXT = "CLA";
export const SIGNATURES_BRANCH = "cla-signatures";
export const SIGNATURES_PATH = "signatures.json";
export const CLA_PATH = ".github/CLA.md";

const COMMENT_MARKER = "<!-- zknotes-cla-bot -->";
/** GET /pulls/:n/commits returns at most this many; past it, some authors would go unchecked. */
const MAX_PR_COMMITS = 250;
const WRITE_ATTEMPTS = 5;
/** GitHub's no-reply addresses: `123+login@…` (current) and `login@…` (accounts before 2017). */
const NOREPLY = /^(?:(\d+)\+)?([a-z0-9-]+)@users\.noreply\.github\.com$/i;
const CO_AUTHOR = /^co-authored-by:\s*(.*?)\s*<([^>]*)>\s*$/gim;

export interface ApiResponse {
    status: number;
    data: unknown;
}

export interface Api {
    /** One REST call. It resolves for every HTTP status; the caller decides what a status means. */
    request(method: string, path: string, body?: unknown): Promise<ApiResponse>;
    /** Every page of a list endpoint, concatenated. */
    paginate<T>(path: string): Promise<T[]>;
}

interface User {
    login: string;
    id: number;
    type?: string;
}

interface PullRequest {
    number: number;
    user: User;
    head: { sha: string };
}

interface PrCommit {
    sha: string;
    author: User | null;
    commit: { author: { name: string } | null; message: string };
}

interface IssueComment {
    id: number;
    html_url: string;
    created_at: string;
    updated_at?: string;
    body?: string;
    user: User | null;
}

export interface Signature {
    github_id: number;
    login: string;
    version: string;
    document_sha256: string;
    document_url: string;
    signed_at: string;
    pull_request: number;
    comment_url: string;
}

interface SignatureFile {
    signatures: Signature[];
}

/** Someone whose signature the pull request needs. `id` is unknown only for an old-style no-reply
 *  co-author address, which carries the login alone. */
interface Contributor {
    login: string;
    id: number | null;
}

export interface BotInput {
    api: Api;
    eventName: string;
    event: unknown;
    owner: string;
    repo: string;
    serverUrl: string;
    /** The commit of the default branch the workflow checked out — the CLA text being signed. */
    baseSha: string;
    claText: string;
    /** Logins that never need to sign (the maintainer); `…[bot]` accounts are always exempt. */
    allowlist: string[];
}

export interface BotResult {
    state: "success" | "failure";
    unsigned: string[];
    problems: string[];
    recorded: string[];
}

export function isSignatureComment(body: string | undefined): boolean {
    const normalise = (s: string) => s.trim().replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();
    return normalise(body ?? "") === normalise(SIGN_PHRASE);
}

function pullRequestNumber(eventName: string, event: unknown): number | null {
    const e = event as {
        pull_request?: { number?: number };
        issue?: { number?: number; pull_request?: unknown };
    };
    if (eventName === "pull_request_target") return e.pull_request?.number ?? null;
    if (eventName === "issue_comment" && e.issue?.pull_request) return e.issue.number ?? null;
    return null;
}

function expectStatus(res: ApiResponse, ok: number[], what: string): void {
    if (!ok.includes(res.status)) {
        throw new Error(`${what} failed with HTTP ${res.status}: ${JSON.stringify(res.data)}`);
    }
}

/** Who has to sign, and what cannot be checked at all. Exempt accounts are left out. */
function collectContributors(
    pr: PullRequest,
    commits: PrCommit[],
    isExempt: (login: string) => boolean,
): { required: Map<string, Contributor>; problems: string[] } {
    const required = new Map<string, Contributor>();
    const problems: string[] = [];
    const add = (c: Contributor) => {
        const key = c.login.toLowerCase();
        if (isExempt(c.login)) return;
        const known = required.get(key);
        if (!known || (known.id === null && c.id !== null)) required.set(key, c);
    };

    add({ login: pr.user.login, id: pr.user.id });
    if (commits.length >= MAX_PR_COMMITS) {
        problems.push(
            `The pull request has ${MAX_PR_COMMITS} or more commits, more than can be checked. ` +
                "Please squash it into fewer commits.",
        );
    }
    for (const c of commits) {
        const short = c.sha.slice(0, 7);
        if (c.author) {
            add({ login: c.author.login, id: c.author.id });
        } else {
            const name = c.commit.author?.name ?? "an unknown author";
            problems.push(
                `Commit ${short} is authored by "${name}" with an email address that is not ` +
                    "linked to any GitHub account.",
            );
        }
        for (const m of c.commit.message.matchAll(CO_AUTHOR)) {
            const [, name = "", email = ""] = m;
            const noreply = NOREPLY.exec(email.trim());
            if (noreply?.[2]) {
                add({ login: noreply[2], id: noreply[1] ? Number(noreply[1]) : null });
            } else {
                problems.push(
                    `Commit ${short} names the co-author "${name}" with an address that cannot ` +
                        "be matched to a GitHub account. Use their GitHub no-reply address instead.",
                );
            }
        }
    }
    return { required, problems };
}

function hasSigned(signatures: Signature[], c: Contributor): boolean {
    return signatures.some(
        (s) =>
            s.version === CLA_VERSION &&
            (c.id !== null
                ? s.github_id === c.id
                : s.login.toLowerCase() === c.login.toLowerCase()),
    );
}

async function loadSignatures(
    api: Api,
    base: string,
): Promise<{ file: SignatureFile; sha: string | null; branchExists: boolean }> {
    const res = await api.request(
        "GET",
        `${base}/contents/${SIGNATURES_PATH}?ref=${SIGNATURES_BRANCH}`,
    );
    if (res.status === 404) {
        const ref = await api.request("GET", `${base}/git/ref/heads/${SIGNATURES_BRANCH}`);
        return { file: { signatures: [] }, sha: null, branchExists: ref.status === 200 };
    }
    expectStatus(res, [200], "Reading the signatures");
    const data = res.data as { content?: string; sha: string };
    if (!data.content) throw new Error("The signatures file is too large for the contents API");
    const file = JSON.parse(Buffer.from(data.content, "base64").toString("utf8")) as SignatureFile;
    return { file, sha: data.sha, branchExists: true };
}

/** Writes the file; `false` means someone else wrote first and the caller should reload. */
async function writeSignatures(
    api: Api,
    base: string,
    current: { sha: string | null; branchExists: boolean },
    file: SignatureFile,
    message: string,
): Promise<boolean> {
    const content = `${JSON.stringify(file, null, 2)}\n`;
    if (!current.branchExists) {
        // An orphan branch: the signatures share no history with the code.
        const tree = await api.request("POST", `${base}/git/trees`, {
            tree: [{ path: SIGNATURES_PATH, mode: "100644", type: "blob", content }],
        });
        expectStatus(tree, [201], "Creating the signatures tree");
        const commit = await api.request("POST", `${base}/git/commits`, {
            message,
            tree: (tree.data as { sha: string }).sha,
            parents: [],
        });
        expectStatus(commit, [201], "Creating the signatures commit");
        const ref = await api.request("POST", `${base}/git/refs`, {
            ref: `refs/heads/${SIGNATURES_BRANCH}`,
            sha: (commit.data as { sha: string }).sha,
        });
        if (ref.status === 422) return false; // the branch appeared meanwhile
        expectStatus(ref, [201], "Creating the signatures branch");
        return true;
    }
    const res = await api.request("PUT", `${base}/contents/${SIGNATURES_PATH}`, {
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: SIGNATURES_BRANCH,
        ...(current.sha ? { sha: current.sha } : {}),
    });
    if (res.status === 409 || res.status === 422) return false;
    expectStatus(res, [200, 201], "Writing the signatures");
    return true;
}

/** Adds `fresh` to the stored signatures, merging with whatever another run wrote meanwhile. */
async function recordSignatures(api: Api, base: string, fresh: Signature[]): Promise<Signature[]> {
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
        const current = await loadSignatures(api, base);
        const missing = fresh.filter(
            (s) => !hasSigned(current.file.signatures, { login: s.login, id: s.github_id }),
        );
        if (missing.length === 0) return current.file.signatures;
        const next = { signatures: [...current.file.signatures, ...missing] };
        const message = `Record CLA ${CLA_VERSION}: ${missing.map((s) => s.login).join(", ")}`;
        if (await writeSignatures(api, base, current, next, message)) return next.signatures;
    }
    throw new Error(`Could not record the signatures after ${WRITE_ATTEMPTS} attempts`);
}

function failureComment(documentUrl: string, unsigned: string[], problems: string[]): string {
    const parts = [
        COMMENT_MARKER,
        "Thank you for the pull request. Before it can be merged, everyone who authored a commit " +
            `in it has to sign the ZKnotes [Contributor License Agreement](${documentUrl}) — ` +
            "once; it covers later contributions too. `CONTRIBUTING.md` explains why the project " +
            "needs it.",
    ];
    if (unsigned.length > 0) {
        parts.push(
            `**Still to sign:** ${unsigned.map((l) => `@${l}`).join(", ")}`,
            "To sign, read the agreement and post this sentence as a new comment on this pull " +
                `request:\n\n\`\`\`\n${SIGN_PHRASE}\n\`\`\``,
        );
    }
    if (problems.length > 0) {
        parts.push(
            "**Commits that cannot be checked:**",
            problems.map((p) => `- ${p}`).join("\n"),
            "Link the address to your GitHub account (Settings → Emails), or rewrite the commits " +
                "with an address that is linked.",
        );
    }
    parts.push("If this check does not update, comment `recheck`.");
    return parts.join("\n\n");
}

function successComment(documentUrl: string): string {
    return (
        `${COMMENT_MARKER}\nEveryone who contributed to this pull request has signed the ZKnotes ` +
        `[Contributor License Agreement](${documentUrl}). Thank you.`
    );
}

export async function runClaBot(input: BotInput): Promise<BotResult | null> {
    const prNumber = pullRequestNumber(input.eventName, input.event);
    if (prNumber === null) return null;
    const { api } = input;
    const base = `/repos/${input.owner}/${input.repo}`;
    const documentUrl = `${input.serverUrl}/${input.owner}/${input.repo}/blob/${input.baseSha}/${CLA_PATH}`;
    const documentSha = createHash("sha256").update(input.claText).digest("hex");
    const exempt = new Set(input.allowlist.map((l) => l.toLowerCase()));
    const isExempt = (login: string) => login.endsWith("[bot]") || exempt.has(login.toLowerCase());

    const prRes = await api.request("GET", `${base}/pulls/${prNumber}`);
    expectStatus(prRes, [200], "Reading the pull request");
    const pr = prRes.data as PullRequest;
    const commits = await api.paginate<PrCommit>(`${base}/pulls/${prNumber}/commits?per_page=100`);
    const comments = await api.paginate<IssueComment>(
        `${base}/issues/${prNumber}/comments?per_page=100`,
    );
    const { required, problems } = collectContributors(pr, commits, isExempt);

    let signatures = (await loadSignatures(api, base)).file.signatures;
    const fresh: Signature[] = [];
    for (const c of comments) {
        const user = c.user;
        if (!user || !isSignatureComment(c.body)) continue;
        const contributor = required.get(user.login.toLowerCase());
        if (!contributor || (contributor.id !== null && contributor.id !== user.id)) continue;
        const candidate = { login: user.login, id: user.id };
        if (hasSigned(signatures, candidate) || fresh.some((s) => s.github_id === user.id))
            continue;
        fresh.push({
            github_id: user.id,
            login: user.login,
            version: CLA_VERSION,
            document_sha256: documentSha,
            document_url: documentUrl,
            // An edited comment counts from the edit that made it a signature.
            signed_at: c.updated_at ?? c.created_at,
            pull_request: prNumber,
            comment_url: c.html_url,
        });
    }
    if (fresh.length > 0) signatures = await recordSignatures(api, base, fresh);

    const unsigned = [...required.values()]
        .filter((c) => !hasSigned(signatures, c))
        .map((c) => c.login);
    const state = unsigned.length === 0 && problems.length === 0 ? "success" : "failure";
    const description =
        state === "success"
            ? "Every contributor has signed the CLA"
            : unsigned.length > 0
              ? `Waiting for a CLA signature from ${unsigned.length} contributor(s)`
              : "Some commits cannot be matched to a GitHub account";
    const status = await api.request("POST", `${base}/statuses/${pr.head.sha}`, {
        state,
        context: STATUS_CONTEXT,
        description,
        target_url: documentUrl,
    });
    expectStatus(status, [201], "Setting the CLA status");

    const existing = comments.find(
        (c) => c.user?.type === "Bot" && c.body?.includes(COMMENT_MARKER),
    );
    const body =
        state === "success"
            ? successComment(documentUrl)
            : failureComment(documentUrl, unsigned, problems);
    // A pull request whose contributors had all signed already gets no comment at all.
    if (existing && existing.body !== body) {
        const res = await api.request("PATCH", `${base}/issues/comments/${existing.id}`, { body });
        expectStatus(res, [200], "Updating the CLA comment");
    } else if (!existing && state === "failure") {
        const res = await api.request("POST", `${base}/issues/${prNumber}/comments`, { body });
        expectStatus(res, [201], "Posting the CLA comment");
    }

    return { state, unsigned, problems, recorded: fresh.map((s) => s.login) };
}

/** The REST client the workflow uses: `fetch` and the job's GITHUB_TOKEN, nothing else. */
export function fetchApi(apiUrl: string, token: string): Api {
    const call = async (method: string, pathOrUrl: string, body?: unknown) => {
        const res = await fetch(
            pathOrUrl.startsWith("http") ? pathOrUrl : `${apiUrl}${pathOrUrl}`,
            {
                method,
                headers: {
                    Accept: "application/vnd.github+json",
                    Authorization: `Bearer ${token}`,
                    "X-GitHub-Api-Version": "2022-11-28",
                    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
                },
                body: body === undefined ? undefined : JSON.stringify(body),
            },
        );
        const text = await res.text();
        let data: unknown = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = text;
        }
        return { status: res.status, data, link: res.headers.get("link") };
    };
    return {
        request: async (method, path, body) => {
            const { status, data } = await call(method, path, body);
            return { status, data };
        },
        paginate: async <T>(path: string) => {
            const out: T[] = [];
            let next: string | null = path;
            while (next) {
                const res = await call("GET", next);
                expectStatus(res, [200], `Listing ${path}`);
                out.push(...(res.data as T[]));
                next = /<([^>]+)>;\s*rel="next"/.exec(res.link ?? "")?.[1] ?? null;
            }
            return out;
        },
    };
}

async function main(): Promise<void> {
    const env = (name: string) => {
        const value = process.env[name];
        if (!value) throw new Error(`${name} is not set`);
        return value;
    };
    const event = JSON.parse(readFileSync(env("GITHUB_EVENT_PATH"), "utf8")) as {
        repository?: { owner?: { login?: string } };
    };
    const [owner = "", repo = ""] = env("GITHUB_REPOSITORY").split("/");
    const allowlist = [
        event.repository?.owner?.login ?? owner,
        ...(process.env.CLA_ALLOWLIST ?? "").split(","),
    ]
        .map((l) => l.trim())
        .filter(Boolean);
    const result = await runClaBot({
        api: fetchApi(process.env.GITHUB_API_URL ?? "https://api.github.com", env("GITHUB_TOKEN")),
        eventName: env("GITHUB_EVENT_NAME"),
        event,
        owner,
        repo,
        serverUrl: process.env.GITHUB_SERVER_URL ?? "https://github.com",
        baseSha: env("BASE_SHA"),
        claText: readFileSync(CLA_PATH, "utf8"),
        allowlist,
    });
    if (result === null) {
        console.log("Not a pull request event — nothing to check.");
        return;
    }
    console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
