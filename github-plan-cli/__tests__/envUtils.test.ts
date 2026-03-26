import { describe, expect, it } from "vitest";
import { parseEnvBoolTrue } from "../src/config/parseGithubPlanEnv.js";

describe("parseEnvBoolTrue", () => {
    it("is true only for case-insensitive true", () => {
        expect(parseEnvBoolTrue(undefined)).toBe(false);
        expect(parseEnvBoolTrue("")).toBe(false);
        expect(parseEnvBoolTrue("false")).toBe(false);
        expect(parseEnvBoolTrue("TRUE")).toBe(true);
        expect(parseEnvBoolTrue(" true ")).toBe(true);
    });
});
