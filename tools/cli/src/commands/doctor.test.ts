import { describe, expect, it, vi } from "vitest";
import type { PortalClient } from "../client.js";
import type { CommandContext } from "../command.js";
import { doctorCommand } from "./doctor.js";

const report = (extra: object = {}) => ({
  generatedAt: "2026-11-09T12:00:00.000Z",
  healthy: false,
  counts: { blocking: 1, degrading: 0, tidy: 0 },
  byArea: { integrations: 1 },
  items: [
    {
      id: "source_late:inbox",
      check: "source_late",
      tier: "blocking",
      area: "integrations",
      title: "Demo inbox is read up to 2026-11-07 20:00 UTC, 40 h behind",
      why: "x",
      handles: ["source:inbox"],
      fix: { who: "person", question: "Run `rhen sources inbox`.", cli: "rhen sources inbox" }
    }
  ],
  notChecked: [],
  ...extra
});

function run(body: object) {
  const out: string[] = [];
  const client = {
    baseUrl: "http://localhost:8787",
    getState: vi.fn().mockResolvedValue({ settings: { timezone: "UTC" } }),
    get: vi.fn().mockResolvedValue(body),
    post: vi.fn()
  } as unknown as PortalClient;
  const context: CommandContext = {
    client,
    mode: "table",
    now: () => new Date("2026-11-09T12:00:00Z"),
    stdout: (text) => out.push(text),
    stderr: () => {},
    setExitCode: () => {}
  };
  return doctorCommand.run(context, { positionals: [], values: {} } as never).then(() => out.join("\n"));
}

describe("rhen doctor and what the plan is built from", () => {
  it("prints the plan-inputs sentence and the messages-collected line under the summary", async () => {
    const text = await run(
      report({
        planInputs: {
          complete: false,
          behind: [],
          sentence:
            "This plan is built from messages read up to 2026-11-07 20:00 UTC (1 source behind: Demo inbox). Anything newer is not in it. Run `rhen sources inbox` for each source that is behind (`rhen sources --problems` lists them)."
        },
        processing: [
          {
            source: "inbox",
            name: "Demo inbox",
            windowDays: 30,
            collected: 234,
            runs: 70,
            unreadableRuns: 0,
            processed: 70,
            gap: 164,
            byEndState: { applied: 10, duplicate: 0, asked: 5, no_effect: 50, unresolved: 5 },
            noEffectReasons: [],
            unresolvedKeys: [],
            lastRunAt: "2026-11-09T10:00:00.000Z"
          }
        ]
      })
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe("1 to fix: 1 blocking, 0 degrading, 0 tidy.");
    expect(lines[1]).toContain("This plan is built from messages read up to 2026-11-07 20:00 UTC");
    expect(lines[2]).toBe(
      "Demo inbox: 234 messages collected in 30 days, 70 decided (applied 10, asked 5, no effect 50, unresolved 5), 164 not yet decided."
    );
  });

  it("prints nothing extra when every input is read up to date and no message source reports", async () => {
    const text = await run(report({ planInputs: { complete: true, behind: [], sentence: null } }));
    expect(text.split("\n")[1]).toMatch(/^tier\s+area/);
  });
});
