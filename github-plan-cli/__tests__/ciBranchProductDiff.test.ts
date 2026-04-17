import { afterEach, describe, expect, it, vi } from "vitest";
import {
    parseGitNumstatForProductMetrics,
    resolveCiSkipImplementMinFiles,
    resolveCiSkipImplementMinLines,
    shouldSkipFirstCiImplementPass,
} from "../src/plan/ciBranchProductDiff.js";

describe("ciBranchProductDiff", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("parseGitNumstatForProductMetrics counts only allowlisted product paths", () => {
        const stdout = [
            "10\t5\tsrc/foo.ts",
            "99\t1\tREADME.md",
            "0\t0\t.jarvis/ci/x.json",
            "2\t3\tmigrations/001_x.ts",
            "1\t1\tgithub-plan-cli/src/x.ts",
        ].join("\n");
        const m = parseGitNumstatForProductMetrics(stdout);
        expect(m.productFileCount).toBe(2);
        expect(m.productLineChurn).toBe(10 + 5 + 2 + 3);
        expect(m.productPaths).toContain("src/foo.ts");
        expect(m.productPaths).toContain("migrations/001_x.ts");
    });

    it("shouldSkipFirstCiImplementPass is true when file count meets threshold", () => {
        vi.stubEnv("CI_SKIP_IMPLEMENT_MIN_FILES", "3");
        vi.stubEnv("CI_SKIP_IMPLEMENT_MIN_LINES", "99999");
        const m = parseGitNumstatForProductMetrics(
            ["1\t1\tsrc/a.ts", "1\t1\tsrc/b.ts", "1\t1\tsrc/c.ts"].join("\n"),
        );
        expect(shouldSkipFirstCiImplementPass(m)).toBe(true);
    });

    it("shouldSkipFirstCiImplementPass is true when line churn meets threshold", () => {
        vi.stubEnv("CI_SKIP_IMPLEMENT_MIN_FILES", "999");
        vi.stubEnv("CI_SKIP_IMPLEMENT_MIN_LINES", "80");
        const m = parseGitNumstatForProductMetrics(
            ["40\t40\tsrc/only.ts"].join("\n"),
        );
        expect(shouldSkipFirstCiImplementPass(m)).toBe(true);
    });

    it("shouldSkipFirstCiImplementPass is false below both thresholds", () => {
        vi.stubEnv("CI_SKIP_IMPLEMENT_MIN_FILES", "3");
        vi.stubEnv("CI_SKIP_IMPLEMENT_MIN_LINES", "80");
        const m = parseGitNumstatForProductMetrics(
            ["10\t10\tsrc/a.ts", "5\t5\tsrc/b.ts"].join("\n"),
        );
        expect(shouldSkipFirstCiImplementPass(m)).toBe(false);
    });

    it("resolveCiSkipImplementMinFiles falls back on invalid env", () => {
        vi.stubEnv("CI_SKIP_IMPLEMENT_MIN_FILES", "not-a-number");
        expect(resolveCiSkipImplementMinFiles()).toBe(3);
    });

    it("resolveCiSkipImplementMinLines falls back on invalid env", () => {
        vi.stubEnv("CI_SKIP_IMPLEMENT_MIN_LINES", "-1");
        expect(resolveCiSkipImplementMinLines()).toBe(80);
    });
});
