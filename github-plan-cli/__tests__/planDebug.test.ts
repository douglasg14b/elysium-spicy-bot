import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlanCliDebugEnabled, planDebugLog, truncateForPlanDebug } from "../src/plan/planDebug.js";

describe("isPlanCliDebugEnabled", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("is true when GITHUB_PLAN_DEBUG is unset (local or Actions)", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "");
        vi.stubEnv("GITHUB_ACTIONS", "");
        expect(isPlanCliDebugEnabled()).toBe(true);
        vi.stubEnv("GITHUB_ACTIONS", "true");
        expect(isPlanCliDebugEnabled()).toBe(true);
    });

    it("is false when GITHUB_PLAN_DEBUG opts out", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "0");
        vi.stubEnv("GITHUB_ACTIONS", "true");
        expect(isPlanCliDebugEnabled()).toBe(false);
        vi.stubEnv("GITHUB_PLAN_DEBUG", "OFF");
        vi.stubEnv("GITHUB_ACTIONS", "");
        expect(isPlanCliDebugEnabled()).toBe(false);
    });

    it("stays true for explicit on values (redundant but harmless)", () => {
        vi.stubEnv("GITHUB_ACTIONS", "");
        vi.stubEnv("GITHUB_PLAN_DEBUG", "1");
        expect(isPlanCliDebugEnabled()).toBe(true);
        vi.stubEnv("GITHUB_PLAN_DEBUG", "TRUE");
        expect(isPlanCliDebugEnabled()).toBe(true);
        vi.stubEnv("GITHUB_PLAN_DEBUG", " Yes ");
        expect(isPlanCliDebugEnabled()).toBe(true);
    });
});

describe("truncateForPlanDebug", () => {
    it("returns input when under max", () => {
        expect(truncateForPlanDebug("hi", 10)).toBe("hi");
    });

    it("truncates and appends summary when over max", () => {
        expect(truncateForPlanDebug("abcd", 2)).toBe("ab… [truncated, 4 chars total]");
    });
});

describe("planDebugLog", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("does not write when debug is explicitly off", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "0");
        vi.stubEnv("GITHUB_ACTIONS", "");
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        planDebugLog("hello", { a: 1 });
        expect(spy).not.toHaveBeenCalled();
    });

    it("writes to stderr when GITHUB_PLAN_DEBUG=1", () => {
        vi.stubEnv("GITHUB_ACTIONS", "");
        vi.stubEnv("GITHUB_PLAN_DEBUG", "1");
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        planDebugLog("hello", { a: 1 });
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("[github-plan:debug] hello"));
        expect(spy.mock.calls[0][0]).toContain('"a":1');
    });

    it("writes when GITHUB_PLAN_DEBUG is unset (local or Actions)", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "");
        vi.stubEnv("GITHUB_ACTIONS", "");
        const spyLocal = vi.spyOn(console, "error").mockImplementation(() => {});
        planDebugLog("local");
        expect(spyLocal).toHaveBeenCalledWith(expect.stringContaining("[github-plan:debug] local"));
        spyLocal.mockRestore();

        vi.stubEnv("GITHUB_ACTIONS", "true");
        const spyCi = vi.spyOn(console, "error").mockImplementation(() => {});
        planDebugLog("ci");
        expect(spyCi).toHaveBeenCalledWith(expect.stringContaining("[github-plan:debug] ci"));
    });
});
