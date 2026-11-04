import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { fakeFetch } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

/**
 * Recall benchmark for `list --search` as the email reasoner uses it: a thread-shaped query and the
 * record it should surface. `legacy` is the old rule (whole query as one substring), kept here so the
 * gain stays measurable. Add cases from real reasoner misses.
 */
const cases: Array<{ entity: string; query: string; expected: string }> = [
  { entity: "actions", query: "fix citations", expected: "action-cite" },
  { entity: "actions", query: "citations fix", expected: "action-cite" },
  { entity: "actions", query: "please fix the citation list before Friday", expected: "action-cite" },
  { entity: "actions", query: "draft chapter 3 feedback", expected: "action-draft" },
  { entity: "actions", query: "email the supervisor about chapter 3", expected: "action-done" },
  { entity: "projects", query: "thesis chapter feedback", expected: "project-thesis" },
  { entity: "commitments", query: "gym session tomorrow", expected: "commitment-gym" },
  { entity: "commitments", query: "dentist appointment", expected: "commitment-dentist" }
];

async function search(entity: string, query: string): Promise<string[]> {
  const lines: string[] = [];
  await runCli(["list", entity, "--search", query, "--json"], {
    stdout: (text) => lines.push(text),
    stderr: () => undefined,
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } } }, [])
  });
  return (JSON.parse(lines.join("\n")) as Array<{ id: string }>).map((row) => row.id);
}

describe("list --search recall", () => {
  it("surfaces the expected record in the top three for every benchmark query", async () => {
    const misses: string[] = [];
    for (const { entity, query, expected } of cases) {
      const top = (await search(entity, query)).slice(0, 3);
      if (!top.includes(expected)) misses.push(`${entity}: "${query}" -> ${top.join(",") || "nothing"}`);
    }
    expect(misses).toEqual([]);
  });
});
