import { describe, expect, it } from "vitest";
import { runImplementPlanStub } from "../src/plan/implementPlanStub.js";

describe("runImplementPlanStub", () => {
    it("throws and references future doc", async () => {
        await expect(runImplementPlanStub()).rejects.toThrow(/FUTURE-IMPLEMENT/);
    });
});
