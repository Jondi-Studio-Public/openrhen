import { checkInCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

const id = "126b15ba-ff40-4a7f-8f3e-b824506a1fcc";

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}) {
  const calls: RecordedCall[] = [];
  let stderr = "";
  const exitCode = await runCli(["check-in-tag", ...argv], {
    stdout: () => undefined,
    stderr: (text) => {
      stderr += text;
    },
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls)
  });
  return { exitCode, stderr, calls };
}

describe("check-in-tag", () => {
  it("posts a tag_check_in with inferred tags by default", async () => {
    const result = await run(["--check-in", id, "--add", "Family, school-run"], {
      "/api/commands/check-in": (call) => {
        expect(checkInCommandSchema.safeParse(call.body).success).toBe(true);
        expect(call.body).toMatchObject({
          type: "tag_check_in",
          checkInId: id,
          add: [
            { tag: "Family", mark: "inferred" },
            { tag: "school-run", mark: "inferred" }
          ]
        });
        expect(call.body).not.toHaveProperty("status");
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("sends removals and a stated mark", async () => {
    const result = await run(["--check-in", id, "--add", "errand", "--mark", "stated", "--remove", "family"], {
      "/api/commands/check-in": (call) => {
        expect(call.body).toMatchObject({ add: [{ tag: "errand", mark: "stated" }], remove: ["family"] });
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("refuses a missing id, no tags, a bad mark and a tag in both lists, without posting", async () => {
    const cases: string[][] = [
      ["--add", "a"],
      ["--check-in", id],
      ["--check-in", id, "--add", "a", "--mark", "guessed"],
      ["--check-in", id, "--add", "a", "--remove", "A"]
    ];
    for (const argv of cases) {
      const result = await run(argv);
      expect(result.exitCode, argv.join(" ")).not.toBe(EXIT.ok);
      expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    }
  });
});
