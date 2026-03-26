import { describe, expect, it } from "vitest";
import { envValueIsExplicitlyOff, envValueIsTruthy, normalizeEnvTrimLower } from "../src/config/envTruthy.js";

describe("envTruthy", () => {
    it("normalizeEnvTrimLower trims and lowercases", () => {
        expect(normalizeEnvTrimLower("  OFF  ")).toBe("off");
        expect(normalizeEnvTrimLower(undefined)).toBe("");
    });

    it("envValueIsTruthy recognizes common true tokens", () => {
        expect(envValueIsTruthy("1")).toBe(true);
        expect(envValueIsTruthy("YES")).toBe(true);
        expect(envValueIsTruthy("")).toBe(false);
    });

    it("envValueIsExplicitlyOff recognizes opt-out tokens", () => {
        expect(envValueIsExplicitlyOff("0")).toBe(true);
        expect(envValueIsExplicitlyOff("false")).toBe(true);
        expect(envValueIsExplicitlyOff("1")).toBe(false);
    });
});
