import { describe, expect, it, vi } from "vitest";
import {
    commitAndPushIfStaged,
    pushBranchWithRecovery,
    remotePlanBranchExists,
    stageImplementWorktreeExcludingPrDraft,
} from "../src/plan/planImplementationGit.js";

describe("remotePlanBranchExists", () => {
    it("returns true when getBranch succeeds", async () => {
        const octokit = {
            rest: {
                repos: {
                    getBranch: vi.fn().mockResolvedValue({ data: {} }),
                },
            },
        } as never;
        await expect(
            remotePlanBranchExists(octokit, { owner: "o", repo: "r" }, "ai/issue-1"),
        ).resolves.toBe(true);
    });

    it("returns false on 404", async () => {
        const octokit = {
            rest: {
                repos: {
                    getBranch: vi.fn().mockRejectedValue({ status: 404 }),
                },
            },
        } as never;
        await expect(
            remotePlanBranchExists(octokit, { owner: "o", repo: "r" }, "missing"),
        ).resolves.toBe(false);
    });

    it("rethrows non-404 errors", async () => {
        const octokit = {
            rest: {
                repos: {
                    getBranch: vi.fn().mockRejectedValue({ status: 500 }),
                },
            },
        } as never;
        await expect(
            remotePlanBranchExists(octokit, { owner: "o", repo: "r" }, "b"),
        ).rejects.toEqual({ status: 500 });
    });
});

describe("pushBranchWithRecovery", () => {
    it("succeeds on first push without rebase", async () => {
        const push = vi.fn().mockResolvedValue(undefined);
        const fetch = vi.fn().mockResolvedValue(undefined);
        const raw = vi.fn().mockResolvedValue(undefined);
        await pushBranchWithRecovery({
            git: { push, fetch, raw } as never,
            remote: "origin",
            branch: "ai/issue-1",
        });
        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith("origin", "ai/issue-1");
        expect(raw).not.toHaveBeenCalled();
    });
});

describe("stageImplementWorktreeExcludingPrDraft", () => {
    it("stages all then resets pr-draft path and returns cached diff", async () => {
        const add = vi.fn().mockResolvedValue(undefined);
        const raw = vi.fn().mockResolvedValue(undefined);
        const diff = vi.fn().mockResolvedValue("M  src/foo.ts\n");
        const result = await stageImplementWorktreeExcludingPrDraft({
            add,
            raw,
            diff,
        } as never);
        expect(add).toHaveBeenCalledWith("-A");
        expect(raw).toHaveBeenCalledWith(["reset", "HEAD", "--", ".jarvis/pr-draft.json"]);
        expect(diff).toHaveBeenCalledWith(["--cached"]);
        expect(result).toContain("foo.ts");
    });
});

describe("commitAndPushIfStaged", () => {
    it("commits and pushes when staged diff is non-empty", async () => {
        const commit = vi.fn().mockResolvedValue(undefined);
        const push = vi.fn().mockResolvedValue(undefined);
        const git = {
            add: vi.fn(),
            raw: vi.fn().mockResolvedValue(undefined),
            diff: vi.fn().mockResolvedValue("M  src/a.ts\n"),
            commit,
            fetch: vi.fn().mockResolvedValue(undefined),
            push,
        } as never;
        const did = await commitAndPushIfStaged({
            git,
            branch: "ai/issue-1",
            remote: "origin",
            message: "wip",
        });
        expect(did).toBe(true);
        expect(commit).toHaveBeenCalledWith("wip");
        expect(push).toHaveBeenCalledWith("origin", "ai/issue-1");
    });

    it("returns false when nothing is staged", async () => {
        const commit = vi.fn().mockResolvedValue(undefined);
        const git = {
            add: vi.fn(),
            raw: vi.fn().mockResolvedValue(undefined),
            diff: vi.fn().mockResolvedValue(""),
            commit,
            push: vi.fn(),
        } as never;
        const did = await commitAndPushIfStaged({
            git,
            branch: "b",
            remote: "origin",
            message: "x",
        });
        expect(did).toBe(false);
        expect(commit).not.toHaveBeenCalled();
    });
});
