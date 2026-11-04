import { MCP_TOOL_MANIFEST, validateToolArguments, type McpToolInputSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

/**
 * What the manifest says an argument accepts and what the handler accepts must be the same set, and every refusal
 * must name the field, the accepted values and the exact next call (Follow-up from the agent e2e review, F11, F13, F14).
 * fixtureNow is 2026-09-03 in the seed zone (Australia/Sydney).
 */
async function run(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({
      "/api/state": { body: { state: fixtureRawState() } },
      "/api/commands/save": () => ({ status: 200, body: { ok: true } }),
      "/api/commands/activity": () => ({ status: 200, body: { ok: true } })
    })
  });
  const stdout = out.join("\n");
  const stderr = err.join("\n");
  const document = (() => {
    try {
      return JSON.parse(stdout || stderr) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  return { exitCode, stdout, stderr, document };
}

const tool = (name: string) => {
  const found = MCP_TOOL_MANIFEST.find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
const property = (name: string, arg: string) =>
  (
    tool(name).inputSchema.properties as Record<
      string,
      { description?: string; enum?: string[]; minimum?: number; maximum?: number }
    >
  )[arg]!;

describe("rhen_history from/to: the manifest text and the handler agree", () => {
  const forms = ["2026-09-01", "today", "yesterday", "-30d", "-1d"];

  it.each(forms)("%s is accepted for from and for to", async (form) => {
    const asFrom = await run(["history", "--from", form, "--to", "today", "--json"]);
    expect(asFrom.exitCode).toBe(EXIT.ok);
    const asTo = await run(["history", "--from", "-30d", "--to", form, "--json"]);
    expect(asTo.exitCode).toBe(EXIT.ok);
  });

  it("every form the handler accepts is listed in the argument text", () => {
    for (const arg of ["from", "to"]) {
      const text = property("rhen_history", arg).description!;
      for (const word of ["YYYY-MM-DD", "today", "yesterday", arg === "from" ? "-30d" : "-1d"])
        expect(text, `${arg}: ${word}`).toContain(word);
    }
  });

  it("an impossible day names the field, the accepted forms, today's date and the repeat instruction", async () => {
    const { exitCode, document } = await run(["history", "--from", "2026-02-30", "--json"]);
    expect(exitCode).toBe(EXIT.usage);
    const message = String(document.error);
    expect(message).toContain("from");
    expect(message).toContain("2026-02-30");
    expect(message).toContain("2026-09-03");
    expect(message).toContain("yesterday");
    expect(message).toContain("-7d");
    expect(message).toMatch(/Repeat the same rhen_history call/);
  });

  it("an end before the start names both days and the call that fixes it", async () => {
    const { exitCode, document } = await run(["history", "--from", "2026-09-03", "--to", "2026-09-01", "--json"]);
    expect(exitCode).toBe(EXIT.usage);
    const message = String(document.error);
    expect(message).toContain("2026-09-01");
    expect(message).toContain("2026-09-03");
    expect(message).toMatch(/Repeat the same rhen_history call/);
  });

  it("a start in the future is refused with the call that shows what is coming", async () => {
    const { exitCode, document } = await run(["history", "--from", "+1d", "--json"]);
    expect(exitCode).toBe(EXIT.usage);
    const message = String(document.error);
    expect(message).toContain("2026-09-04");
    expect(message).toContain("rhen_list");
    expect(message).toContain("commitments");
  });
});

describe("rhen_disruption source: the manifest enum and the handler agree", () => {
  const sources = property("rhen_disruption", "source").enum!;

  it("lists exactly the four values the handler accepts", async () => {
    expect(sources).toEqual(["work", "family", "life_admin", "other"]);
    for (const source of sources) {
      const { exitCode, stderr, stdout } = await run([
        "disruption",
        "start",
        "--title",
        "Visitor",
        "--source",
        source,
        "--duration",
        "30"
      ]);
      expect(stderr + stdout, source).not.toMatch(/source[^.]*must be one of/);
      expect(exitCode, source).not.toBe(EXIT.usage);
    }
  });

  it("a value outside the enum is refused naming the field, the values, the visitor mapping and the repeat call", async () => {
    const { exitCode, document } = await run([
      "disruption",
      "start",
      "--title",
      "Visitor",
      "--source",
      "visitor",
      "--json"
    ]);
    expect(exitCode).toBe(EXIT.usage);
    const message = String(document.error);
    expect(message).toContain("source");
    expect(message).toContain('"visitor"');
    for (const source of sources) expect(message).toContain(source);
    expect(message).toMatch(/visitor[^.]*family or other/);
    expect(message).toMatch(/Repeat the same rhen_disruption call/);
    expect(document.validValues).toEqual({ source: sources });
  });

  it("the remote argument check also tells the agent to repeat the call with one of the listed values", () => {
    const checked = validateToolArguments(
      tool("rhen_disruption").inputSchema as unknown as McpToolInputSchema,
      { subcommand: "start", title: "Visitor", source: "visitor" },
      "rhen_disruption"
    );
    expect(checked.ok).toBe(false);
    const error = (checked as { error: string }).error;
    expect(error).toContain('"source" must be one of work, family, life_admin, other');
    expect(error).toContain("Repeat the same rhen_disruption call");
  });
});

describe("rhen_activity minutes: the manifest text and the handlers agree", () => {
  const minutes = () => property("rhen_activity", "minutes");

  it("the schema carries the real range, 1 to 1440 (the portal refuses a longer session)", () => {
    expect(minutes().minimum).toBe(1);
    expect(minutes().maximum).toBe(1440);
    expect(property("rhen_session", "minutes").maximum).toBe(1440);
    expect(minutes().description).toContain("1440");
  });

  it("the text says minutes must equal the minutes the plan gives a routine step, sleep plan or deliverable step", () => {
    const text = minutes().description!;
    expect(text).toMatch(/routine_step[^.]*durationMinutes/);
    expect(text).toMatch(/sleep[^.]*allowedMinutes/);
    expect(text).toMatch(/deliverable[^.]*rhen_status/);
    expect(tool("rhen_activity").description).toMatch(/Minutes must equal/);
  });

  it("a value over the range is refused naming the field and the range", () => {
    const checked = validateToolArguments(
      tool("rhen_activity").inputSchema as unknown as McpToolInputSchema,
      { subcommand: "start", type: "routine_step", target: "x", minutes: 1441 },
      "rhen_activity"
    );
    expect(checked.ok).toBe(false);
    const error = (checked as { error: string }).error;
    expect(error).toContain('"minutes" must be at most 1440');
    expect(error).toContain("Repeat the same rhen_activity call");
  });

  it.each(["0", "-5", "1.5", "abc", "1441"])(
    "%s is refused by the handler naming the field, the range and an example",
    async (value) => {
      const { exitCode, document } = await run([
        "activity",
        "start",
        "--type",
        "routine_step",
        "--target",
        "x",
        "--minutes",
        value,
        "--json"
      ]);
      expect(exitCode).toBe(EXIT.usage);
      const message = String(document.error);
      expect(message).toContain("minutes");
      expect(message).toContain("1 to 1440");
      expect(message).toMatch(/for example 15/);
      expect(message).toMatch(/Repeat the same rhen_activity call/);
    }
  );

  it("a missing minutes says which values are valid and to repeat the call", async () => {
    const { exitCode, document } = await run([
      "activity",
      "start",
      "--type",
      "routine_step",
      "--target",
      "x",
      "--json"
    ]);
    expect(exitCode).toBe(EXIT.usage);
    expect(String(document.error)).toMatch(
      /minutes is required[\s\S]*1 to 1440[\s\S]*Repeat the same rhen_activity call/
    );
  });
});
