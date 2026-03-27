import { describe, expect, it } from "vitest";
import { githubActionsRunUrlFromEnv } from "../src/github/actionsRunUrl.js";

describe("githubActionsRunUrlFromEnv", () => {
    it("builds run URL and strips server trailing slash", () => {
        expect(
            githubActionsRunUrlFromEnv({
                GITHUB_SERVER_URL: "https://github.com/",
                GITHUB_REPOSITORY: "acme/bot",
                GITHUB_RUN_ID: "99",
            }),
        ).toBe("https://github.com/acme/bot/actions/runs/99");
    });

    it("throws when env incomplete", () => {
        expect(() => githubActionsRunUrlFromEnv({ GITHUB_RUN_ID: "1" })).toThrow(
            /GITHUB_SERVER_URL/,
        );
    });
});
