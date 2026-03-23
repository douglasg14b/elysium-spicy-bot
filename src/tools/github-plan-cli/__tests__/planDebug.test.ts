import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlanCliDebugEnabled, planDebugLog } from "../planDebug.js";

describe("isPlanCliDebugEnabled", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("is false when unset", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "");
        expect(isPlanCliDebugEnabled()).toBe(false);
    });

    it("is true for 1, true, yes (case-insensitive)", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "1");
        expect(isPlanCliDebugEnabled()).toBe(true);
        vi.stubEnv("GITHUB_PLAN_DEBUG", "TRUE");
        expect(isPlanCliDebugEnabled()).toBe(true);
        vi.stubEnv("GITHUB_PLAN_DEBUG", " Yes ");
        expect(isPlanCliDebugEnabled()).toBe(true);
    });
});

describe("planDebugLog", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it("does not write when debug is off", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "");
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        planDebugLog("hello", { a: 1 });
        expect(spy).not.toHaveBeenCalled();
    });

    it("writes to stderr when debug is on", () => {
        vi.stubEnv("GITHUB_PLAN_DEBUG", "1");
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        planDebugLog("hello", { a: 1 });
        expect(spy).toHaveBeenCalledWith(expect.stringContaining("[github-plan:debug] hello"));
        expect(spy.mock.calls[0][0]).toContain('"a":1');
    });
});
