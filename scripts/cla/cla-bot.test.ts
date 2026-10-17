import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    type Api,
    type ApiResponse,
    type BotInput,
    CLA_VERSION,
    isSignatureComment,
    runClaBot,
    SIGN_PHRASE,
    SIGNATURES_BRANCH,
    type Signature,
    STATUS_CONTEXT,
} from "./cla-bot";

/**
 * The CLA bot decides whether external code may be merged into a core whose licensing depends on
 * every contributor having signed. Both directions matter: an unsigned contributor must never turn
 * the check green, and a signature must never be lost or recorded for the wrong person.
 */

const OWNER = "maintainer";
const BASE = `/repos/${OWNER}/zknotes`;
const CLA_TEXT = "# The agreement\n";
const HEAD = "a".repeat(40);

type User = { login: string; id: number; type?: string };
const alice: User = { login: "alice", id: 101 };
const bob: User = { login: "bob", id: 102 };
const mallory: User = { login: "mallory", id: 666 };
const maintainer: User = { login: OWNER, id: 1 };
const botUser: User = { login: "github-actions[bot]", id: 41898282, type: "Bot" };

type Comment = { id: number; html_url: string; created_at: string; body: string; user: User };

/** An in-memory GitHub with just the endpoints the bot calls. */
class FakeGitHub implements Api {
    prAuthor: User = alice;
    commits: Array<{
        sha: string;
        author: User | null;
        commit: { author: { name: string } | null; message: string };
    }> = [];
    comments: Comment[] = [];
    statuses: Array<{ sha: string; state: string; context: string }> = [];
    file: { signatures: Signature[] } | null = null;
    fileSha = 0;
    branchExists = false;
    orphanCommitParents: unknown[] | null = null;
    treeContent: string | null = null;
    /** Called before a PUT is applied; returning a status rejects it, as GitHub does on a conflict. */
    beforePut: (() => number | undefined) | null = null;
    private nextCommentId = 1000;

    commitBy(author: User | null, message = "change", name = "Someone"): this {
        this.commits.push({
            sha: `${this.commits.length}`.padStart(40, "c"),
            author,
            commit: { author: { name }, message },
        });
        return this;
    }

    comment(user: User, body: string): this {
        const id = this.nextCommentId++;
        this.comments.push({
            id,
            html_url: `https://github.com/${OWNER}/zknotes/pull/7#issuecomment-${id}`,
            created_at: `2026-10-0${(this.comments.length % 9) + 1}T12:00:00Z`,
            body,
            user,
        });
        return this;
    }

    botComments(): Comment[] {
        return this.comments.filter((c) => c.user.type === "Bot");
    }

    async paginate<T>(path: string): Promise<T[]> {
        if (path.startsWith(`${BASE}/pulls/7/commits`)) return structuredClone(this.commits) as T[];
        if (path.startsWith(`${BASE}/issues/7/comments`))
            return structuredClone(this.comments) as T[];
        throw new Error(`unexpected list ${path}`);
    }

    async request(method: string, path: string, body?: unknown): Promise<ApiResponse> {
        const b = body as Record<string, unknown>;
        const route = `${method} ${path}`;
        if (route === `GET ${BASE}/pulls/7`) {
            return { status: 200, data: { number: 7, user: this.prAuthor, head: { sha: HEAD } } };
        }
        if (route === `GET ${BASE}/contents/signatures.json?ref=${SIGNATURES_BRANCH}`) {
            if (!this.file) return { status: 404, data: null };
            const content = Buffer.from(JSON.stringify(this.file)).toString("base64");
            return { status: 200, data: { content, sha: `sha-${this.fileSha}` } };
        }
        if (route === `GET ${BASE}/git/ref/heads/${SIGNATURES_BRANCH}`) {
            return { status: this.branchExists ? 200 : 404, data: null };
        }
        if (route === `POST ${BASE}/git/trees`) {
            this.treeContent = (b.tree as Array<{ content: string }>)[0]?.content ?? null;
            return { status: 201, data: { sha: "tree-1" } };
        }
        if (route === `POST ${BASE}/git/commits`) {
            this.orphanCommitParents = b.parents as unknown[];
            return { status: 201, data: { sha: "commit-1" } };
        }
        if (route === `POST ${BASE}/git/refs`) {
            // The branch becomes visible, with the tree's file, only once its ref exists.
            if (this.branchExists)
                return { status: 422, data: { message: "Reference already exists" } };
            this.branchExists = true;
            this.file = JSON.parse(this.treeContent ?? "{}");
            this.fileSha++;
            return { status: 201, data: {} };
        }
        if (route === `PUT ${BASE}/contents/signatures.json`) {
            const rejected = this.beforePut?.();
            if (rejected) return { status: rejected, data: { message: "conflict" } };
            if (b.sha !== `sha-${this.fileSha}`) return { status: 409, data: { message: "sha" } };
            this.file = JSON.parse(Buffer.from(b.content as string, "base64").toString("utf8"));
            this.fileSha++;
            return { status: 200, data: {} };
        }
        const status = /^POST \/repos\/maintainer\/zknotes\/statuses\/(\w+)$/.exec(route);
        if (status) {
            this.statuses.push({
                sha: status[1]!,
                state: b.state as string,
                context: b.context as string,
            });
            return { status: 201, data: {} };
        }
        if (route === `POST ${BASE}/issues/7/comments`) {
            this.comment(botUser, b.body as string);
            return { status: 201, data: {} };
        }
        const patch = /^PATCH \/repos\/maintainer\/zknotes\/issues\/comments\/(\d+)$/.exec(route);
        if (patch) {
            const c = this.comments.find((x) => x.id === Number(patch[1]));
            if (!c) return { status: 404, data: null };
            c.body = b.body as string;
            return { status: 200, data: {} };
        }
        throw new Error(`unexpected request ${route}`);
    }
}

function fake(): FakeGitHub {
    return new FakeGitHub();
}

function input(gh: FakeGitHub, overrides: Partial<BotInput> = {}): BotInput {
    return {
        api: gh,
        eventName: "pull_request_target",
        event: { pull_request: { number: 7 } },
        owner: OWNER,
        repo: "zknotes",
        serverUrl: "https://github.com",
        baseSha: "b".repeat(40),
        claText: CLA_TEXT,
        allowlist: [OWNER],
        ...overrides,
    };
}

function signature(user: User, version = CLA_VERSION): Signature {
    return {
        github_id: user.id,
        login: user.login,
        version,
        document_sha256: "x",
        document_url: "u",
        signed_at: "2026-01-01T00:00:00Z",
        pull_request: 1,
        comment_url: "c",
    };
}

describe("isSignatureComment", () => {
    it("accepts the sentence exactly, and forgives case, spacing and the full stop", () => {
        expect(isSignatureComment(SIGN_PHRASE)).toBe(true);
        expect(isSignatureComment(`  ${SIGN_PHRASE.toUpperCase().replace(/\.$/, "")}\n`)).toBe(
            true,
        );
        expect(isSignatureComment(SIGN_PHRASE.replaceAll(" ", "  "))).toBe(true);
    });

    it("rejects the sentence quoted inside a longer comment, or for another version", () => {
        expect(isSignatureComment(`> ${SIGN_PHRASE}`)).toBe(false);
        expect(isSignatureComment(`Should I post "${SIGN_PHRASE}"?`)).toBe(false);
        expect(isSignatureComment(SIGN_PHRASE.replace(CLA_VERSION, "0.9"))).toBe(false);
        expect(isSignatureComment(undefined)).toBe(false);
    });
});

describe("runClaBot", () => {
    it("asks an unsigned contributor to sign and fails the check", async () => {
        const gh = fake().commitBy(alice);
        const result = await runClaBot(input(gh));

        expect(result?.state).toBe("failure");
        expect(result?.unsigned).toEqual(["alice"]);
        expect(gh.statuses).toEqual([{ sha: HEAD, state: "failure", context: STATUS_CONTEXT }]);
        const [botComment] = gh.botComments();
        expect(botComment?.body).toContain("@alice");
        expect(botComment?.body).toContain(SIGN_PHRASE);
        expect(botComment?.body).toContain(`/blob/${"b".repeat(40)}/.github/CLA.md`);
        expect(gh.file).toBeNull();
    });

    it("records the signature on an orphan branch and turns the check green", async () => {
        const gh = fake().commitBy(alice);
        await runClaBot(input(gh));
        gh.comment(alice, SIGN_PHRASE);
        const result = await runClaBot(
            input(gh, {
                eventName: "issue_comment",
                event: { issue: { number: 7, pull_request: {} } },
            }),
        );

        expect(result).toMatchObject({ state: "success", unsigned: [], recorded: ["alice"] });
        expect(gh.orphanCommitParents).toEqual([]);
        const [recorded] = gh.file?.signatures ?? [];
        expect(recorded).toMatchObject({
            github_id: alice.id,
            login: "alice",
            version: CLA_VERSION,
            pull_request: 7,
            document_sha256: createHash("sha256").update(CLA_TEXT).digest("hex"),
        });
        expect(recorded?.comment_url).toContain("#issuecomment-");
        expect(gh.statuses.at(-1)?.state).toBe("success");
        expect(gh.botComments()).toHaveLength(1);
        expect(gh.botComments()[0]?.body).toContain("has signed");
    });

    it("does not let one person sign for another, or a quoted sentence count", async () => {
        const gh = fake().commitBy(alice);
        gh.comment(mallory, SIGN_PHRASE).comment(alice, `> ${SIGN_PHRASE}`);
        const result = await runClaBot(input(gh));

        expect(result?.state).toBe("failure");
        expect(result?.recorded).toEqual([]);
        expect(gh.file).toBeNull();
    });

    it("needs no signature from the maintainer or from bots", async () => {
        const gh = fake();
        gh.prAuthor = maintainer;
        gh.commitBy(maintainer).commitBy({ login: "dependabot[bot]", id: 49699333, type: "Bot" });
        const result = await runClaBot(input(gh));

        expect(result?.state).toBe("success");
        expect(gh.botComments()).toHaveLength(0);
    });

    it("fails when a commit cannot be matched to a GitHub account, even if everyone signed", async () => {
        const gh = fake().commitBy(alice).commitBy(null, "fix", "Anonymous Coder");
        gh.file = { signatures: [signature(alice)] };
        gh.branchExists = true;
        const result = await runClaBot(input(gh));

        expect(result?.state).toBe("failure");
        expect(result?.unsigned).toEqual([]);
        expect(result?.problems[0]).toContain("Anonymous Coder");
        expect(gh.botComments()[0]?.body).toContain("Commits that cannot be checked");
    });

    it("requires co-authors to sign, and reports one that cannot be identified", async () => {
        const message =
            "change\n\nCo-authored-by: Bob <102+bob@users.noreply.github.com>\n" +
            "Co-authored-by: Carol <carol@example.com>";
        const gh = fake().commitBy(alice, message);
        gh.file = { signatures: [signature(alice)] };
        gh.branchExists = true;
        const result = await runClaBot(input(gh));

        expect(result?.unsigned).toEqual(["bob"]);
        expect(result?.problems).toHaveLength(1);
        expect(result?.problems[0]).toContain("Carol");

        gh.commits[0]!.commit.message =
            "change\n\nCo-authored-by: Bob <102+bob@users.noreply.github.com>";
        gh.comment(bob, SIGN_PHRASE);
        expect((await runClaBot(input(gh)))?.state).toBe("success");
    });

    it("does not count a signature of an earlier version of the agreement", async () => {
        const gh = fake().commitBy(alice);
        gh.file = { signatures: [signature(alice, "0.9")] };
        gh.branchExists = true;
        const result = await runClaBot(input(gh));

        expect(result?.unsigned).toEqual(["alice"]);
    });

    it("merges with a signature another run wrote meanwhile instead of overwriting it", async () => {
        const gh = fake().commitBy(alice);
        gh.file = { signatures: [] };
        gh.branchExists = true;
        gh.beforePut = () => {
            gh.beforePut = null;
            gh.file = { signatures: [signature(bob)] };
            gh.fileSha++;
            return 409;
        };
        gh.comment(alice, SIGN_PHRASE);
        const result = await runClaBot(input(gh));

        expect(result?.state).toBe("success");
        expect(gh.file?.signatures.map((s) => s.login)).toEqual(["bob", "alice"]);
    });

    it("changes nothing when it runs again", async () => {
        const gh = fake().commitBy(alice).commitBy(bob);
        gh.comment(alice, SIGN_PHRASE);
        await runClaBot(input(gh));
        const after = structuredClone(gh.file);
        const commentsAfter = structuredClone(gh.comments);
        await runClaBot(input(gh));

        expect(gh.file).toEqual(after);
        expect(gh.comments).toEqual(commentsAfter);
        expect(gh.botComments()).toHaveLength(1);
        expect(gh.botComments()[0]?.body).toContain("@bob");
        expect(gh.botComments()[0]?.body).not.toContain("@alice");
    });

    it("ignores comments on issues that are not pull requests", async () => {
        const gh = fake();
        const result = await runClaBot(
            input(gh, { eventName: "issue_comment", event: { issue: { number: 7 } } }),
        );

        expect(result).toBeNull();
        expect(gh.statuses).toEqual([]);
    });
});

describe(".github/CLA.md", () => {
    it("declares the version the bot asks people to sign", () => {
        const text = readFileSync(join(import.meta.dirname, "../../.github/CLA.md"), "utf8");
        expect(text).toContain(`Version ${CLA_VERSION}`);
        expect(text).toContain(SIGN_PHRASE);
    });
});
