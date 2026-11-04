import { MCP_TOOL_MANIFEST } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { guideTopics, guideTopicsFor } from "../src/guide-content.js";
import { fakeFetch } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

// fixtureNow is 2026-09-03 in the seed zone.
async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes })
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n") };
}

const tool = (name: string) => {
  const found = MCP_TOOL_MANIFEST.find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
const property = (name: string, arg: string) =>
  (tool(name).inputSchema.properties as Record<string, { description?: string; enum?: string[] }>)[arg]!;

describe("F11: history reads the offsets and today its schema advertises", () => {
  it("accepts -1d and today", async () => {
    const { exitCode, stdout } = await run(["history", "--from", "-1d", "--to", "today", "--json"]);
    expect(exitCode).toBe(EXIT.ok);
    const json = JSON.parse(stdout) as { from: string; to: string };
    expect([json.from, json.to]).toEqual(["2026-09-02", "2026-09-03"]);
  });

  it("an unreadable day names today's date as the example, in both history and summary", async () => {
    for (const command of ["history", "summary"]) {
      const bad = await run([command, "--from", "last week"]);
      expect(bad.exitCode).toBe(EXIT.usage);
      expect(bad.stderr).toContain("2026-09-03");
      expect(bad.stderr).toContain("-7d");
    }
  });
});

describe("F12: summary and history say they look backwards and where the week ahead is", () => {
  it.each(["rhen_summary", "rhen_history"])("%s", (name) => {
    const text = tool(name).description;
    expect(text).toMatch(/backwards|already happened/i);
    expect(text).toContain("rhen_list");
    expect(text).toContain("commitments");
    expect(text).toContain("rhen_forecast");
  });

  it("the guide's workflows have a week-ahead recipe", () => {
    const text = guideTopics.find((topic) => topic.name === "workflows")!.text;
    expect(text).toContain("week ahead");
    expect(text).toContain("deadlineAt<+7d");
    expect(text).toContain("forecast");
  });

  it("what falls due asks for the open statuses and warns that it includes overdue items, on both surfaces", () => {
    const recipeOf = (surface: "stdio" | "remote") => {
      const text = guideTopicsFor(surface).find((topic) => topic.name === "workflows")!.text;
      return text.slice(text.indexOf("7b."), text.indexOf("\n8. "));
    };
    expect(recipeOf("stdio")).not.toContain("--status active");
    expect(recipeOf("stdio")).toContain("--status inbox,planned,active,doing");
    expect(recipeOf("remote")).toContain('"status":"inbox,planned,active,doing"');
    for (const surface of ["stdio", "remote"] as const) expect(recipeOf(surface)).toMatch(/overdue/i);
  });

  it.each(["rhen_summary", "rhen_history"])("%s pointer names the status argument", (name) => {
    const text = tool(name).description;
    expect(text).toContain("inbox,planned,active,doing");
    expect(text).toMatch(/status/);
    expect(text).toMatch(/overdue/i);
  });
});

describe("activity minutes cap", () => {
  it("is the phase's whole length, not what is left of it", () => {
    const text = property("rhen_activity", "minutes").description!;
    expect(text).not.toMatch(/has left/);
    expect(text).toMatch(/whole length|full length/);
  });
});

describe("F13: disruption source and duration", () => {
  it("source is an enum and the description maps a visitor to family or other", () => {
    expect(property("rhen_disruption", "source").enum).toEqual(["work", "family", "life_admin", "other"]);
    expect(tool("rhen_disruption").description).toMatch(/visitor[^.]*family or other/);
  });

  it("duration says a bare number is minutes", () => {
    expect(property("rhen_disruption", "duration").description).toMatch(/minutes/);
  });
});

describe("F14/F26: activity", () => {
  const text = () => tool("rhen_activity").description;

  it("minutes is required on start, in the description and the argument", () => {
    expect(text()).not.toContain("minutes?");
    expect(text()).toMatch(/minutes \(required/);
    expect(property("rhen_activity", "minutes").description).toMatch(/required/i);
  });

  it("the description carries the phases, each type's precondition and the finish outcomes", () => {
    for (const word of [
      "setup",
      "travel",
      "arrival",
      "transition",
      "return",
      "completed",
      "stopped",
      "blocked",
      "did_not_start",
      "skipped"
    ])
      expect(text()).toContain(word);
    expect(text()).toMatch(/sleep[^.]*plan/i);
    expect(text()).toContain("rhen_status");
  });

  it("a start refused because the target is not in the plan points to the call that lists valid targets", async () => {
    const raw = fixtureRawState();
    const refused = await run(
      [
        "activity",
        "start",
        "--type",
        "sleep",
        "--target",
        (raw.sleepPlans as { id: string }[])[0]!.id,
        "--minutes",
        "30"
      ],
      {
        "/api/commands/activity": () => ({
          status: 400,
          body: { error: "That activity is not present in the current Plan and Forecast Engine result." }
        })
      }
    );
    expect(refused.exitCode).not.toBe(EXIT.ok);
    expect(refused.stderr + refused.stdout).toContain("not present in the current Plan");
    expect(refused.stderr + refused.stdout).toContain("status");
  });
});

describe("F15: session continue", () => {
  it("states its precondition", () => {
    expect(tool("rhen_session").description).toMatch(
      /continue \(minutes: extend; only after the planned end, when the session is awaiting_feedback/
    );
  });

  it("names the call that reaches the precondition and the call that ends the session instead", () => {
    const text = tool("rhen_session").description;
    expect(text).toMatch(/refused, so call feedback first/);
    expect(text).toMatch(/exactly one figure[^;]*refused naming it/);
    expect(text).toMatch(/to stop instead use finish/);
  });
});

describe("F18: energy", () => {
  it("lists recovery", () => {
    const all = JSON.stringify(MCP_TOOL_MANIFEST);
    expect(all).not.toContain("high, medium or low: the energy");
    expect(all).toContain("high, medium, low or recovery: the energy");
  });
});

describe("F27: propose says how to replace a pending proposal and who can reject", () => {
  it("coalesce-key and owner-only reject", () => {
    const text = tool("rhen_propose").description;
    expect(text).toMatch(/no withdraw/i);
    expect(text).toMatch(/coalesce-key/);
    expect(text).toMatch(/only the owner can (confirm or )?reject/i);
  });
});
