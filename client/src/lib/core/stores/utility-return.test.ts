import { describe, expect, it } from "vitest";
import {
    applyNavigation,
    classifyPath,
    isUtilityPath,
    normalizePath,
    popCloseTarget,
    resolveValidPath,
} from "./utility-return";

describe("normalizePath", () => {
    it("strips trailing slashes except root", () => {
        expect(normalizePath("/")).toBe("/");
        expect(normalizePath("/settings/")).toBe("/settings");
        expect(normalizePath("/note/abc/")).toBe("/note/abc");
    });

    it("drops query string", () => {
        expect(normalizePath("/files?file=x")).toBe("/files");
    });
});

describe("classifyPath", () => {
    it("classifies home, note, utilities", () => {
        expect(classifyPath("/")).toEqual({ kind: "home" });
        expect(classifyPath("/note/n1")).toEqual({ kind: "note", id: "n1" });
        expect(classifyPath("/starred")).toEqual({ kind: "utility", root: "starred" });
        expect(classifyPath("/settings/storage")).toEqual({
            kind: "utility",
            root: "settings",
        });
        expect(classifyPath("/help/security")).toEqual({ kind: "utility", root: "help" });
        expect(classifyPath("/login")).toEqual({ kind: "other" });
    });

    it("isUtilityPath matches utility roots only", () => {
        expect(isUtilityPath("/files")).toBe(true);
        expect(isUtilityPath("/note/x")).toBe(false);
        expect(isUtilityPath("/")).toBe(false);
    });
});

describe("applyNavigation", () => {
    it("resets stack on note and home", () => {
        expect(applyNavigation(["/note/old"], "/starred", "/note/a")).toEqual(["/note/a"]);
        expect(applyNavigation(["/note/a"], "/note/a", "/")).toEqual(["/"]);
    });

    it("base → utility sets return to base", () => {
        expect(applyNavigation(["/note/a"], "/note/a", "/settings")).toEqual(["/note/a"]);
        expect(applyNavigation(["/"], "/", "/starred")).toEqual(["/"]);
    });

    it("same utility root does not push (tab change)", () => {
        const stack = ["/note/a"];
        expect(applyNavigation(stack, "/settings", "/settings/storage")).toEqual(["/note/a"]);
        expect(applyNavigation(stack, "/help", "/help/security")).toEqual(["/note/a"]);
    });

    it("cross-root utility pushes previous utility path", () => {
        expect(applyNavigation(["/note/a"], "/settings/storage", "/help")).toEqual([
            "/note/a",
            "/settings/storage",
        ]);
    });

    it("cold enter utility keeps empty stack", () => {
        expect(applyNavigation([], null, "/settings")).toEqual([]);
    });

    it("other routes clear stack", () => {
        expect(applyNavigation(["/note/a"], "/note/a", "/login")).toEqual([]);
    });
});

describe("resolveValidPath / popCloseTarget", () => {
    const live = (id: string) => id === "alive";
    const cold = () => "/";

    it("invalid note falls back", () => {
        expect(resolveValidPath("/note/dead", { isLiveNote: live, coldFallback: cold })).toBe("/");
        expect(resolveValidPath("/note/alive", { isLiveNote: live, coldFallback: cold })).toBe(
            "/note/alive",
        );
    });

    it("pop from base-only stack returns note and resets base stack", () => {
        const r = popCloseTarget(["/note/alive"], {
            isLiveNote: live,
            coldFallback: cold,
        });
        expect(r.target).toBe("/note/alive");
        expect(r.nextStack).toEqual(["/note/alive"]);
    });

    it("pop intermediate utility leaves base on stack", () => {
        const r = popCloseTarget(["/note/alive", "/settings"], {
            isLiveNote: live,
            coldFallback: cold,
        });
        expect(r.target).toBe("/settings");
        expect(r.nextStack).toEqual(["/note/alive"]);
    });

    it("empty stack uses cold fallback", () => {
        const r = popCloseTarget([], {
            isLiveNote: live,
            coldFallback: () => "/note/alive",
        });
        expect(r.target).toBe("/note/alive");
        expect(r.nextStack).toEqual(["/note/alive"]);
    });

    it("home close target keeps home base", () => {
        const r = popCloseTarget(["/"], {
            isLiveNote: live,
            coldFallback: () => "/note/alive",
        });
        expect(r.target).toBe("/");
        expect(r.nextStack).toEqual(["/"]);
    });
});

describe("full flow scenarios (stack only)", () => {
    it("Note A → Settings → X lands on Note A", () => {
        let stack: string[] = [];
        stack = applyNavigation(stack, null, "/note/a");
        stack = applyNavigation(stack, "/note/a", "/settings");
        expect(stack).toEqual(["/note/a"]);
        const { target, nextStack } = popCloseTarget(stack, {
            isLiveNote: () => true,
            coldFallback: () => "/",
        });
        expect(target).toBe("/note/a");
        expect(nextStack).toEqual(["/note/a"]);
    });

    it("Home → Settings → X lands on Home (not recent)", () => {
        let stack: string[] = [];
        stack = applyNavigation(stack, null, "/note/a");
        stack = applyNavigation(stack, "/note/a", "/");
        stack = applyNavigation(stack, "/", "/settings");
        expect(stack).toEqual(["/"]);
        const { target } = popCloseTarget(stack, {
            isLiveNote: () => true,
            coldFallback: () => "/note/a", // recent would return a note — it must not be used
        });
        expect(target).toBe("/");
    });

    it("Note → Settings → Help → X → Settings → X → Note", () => {
        let stack: string[] = [];
        stack = applyNavigation(stack, null, "/note/a");
        stack = applyNavigation(stack, "/note/a", "/settings");
        stack = applyNavigation(stack, "/settings", "/help");
        expect(stack).toEqual(["/note/a", "/settings"]);

        let r = popCloseTarget(stack, {
            isLiveNote: () => true,
            coldFallback: () => "/",
        });
        expect(r.target).toBe("/settings");
        stack = r.nextStack;

        r = popCloseTarget(stack, {
            isLiveNote: () => true,
            coldFallback: () => "/",
        });
        expect(r.target).toBe("/note/a");
    });
});
