import { checkInCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface RunResult {
  exitCode: number;
  lines: string[];
  text: string;
  stderr: string;
  calls: RecordedCall[];
}

async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}): Promise<RunResult> {
  const calls: RecordedCall[] = [];
  const lines: string[] = [];
  let stderr = "";
  const exitCode = await runCli(["check-in", ...argv], {
    stdout: (text) => lines.push(text),
    stderr: (text) => {
      stderr += (stderr ? "\n" : "") + text;
    },
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls)
  });
  return { exitCode, lines, text: lines.join("\n"), stderr, calls };
}

describe("check-in", () => {
  it("posts on_track with the checkInId and version from a camelCase pending row", async () => {
    const result = await run(["on-track"], {
      "/api/check-ins/current": {
        body: { checkIn: { id: "e9f6ac30-f59f-4852-a65b-d3074da3b090", version: 3, status: "pending" } }
      },
      "/api/commands/check-in": (call) => {
        const parsed = checkInCommandSchema.safeParse(call.body);
        expect(parsed.success).toBe(true);
        const body = call.body as Record<string, unknown>;
        expect(body.checkInId).toBe("e9f6ac30-f59f-4852-a65b-d3074da3b090");
        expect(body.expectedVersion).toBe(3);
        expect(body.status).toBe("on_track");
        expect(body.answerSource).toBe("sheet");
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("also reads a row that carries only id and version, no other fields", async () => {
    const result = await run(["on-track"], {
      "/api/check-ins/current": { body: { checkIn: { id: "f227b5ca-3cbd-4378-aa9c-3ba1206daf6e", version: 5 } } },
      "/api/commands/check-in": (call) => {
        const body = call.body as Record<string, unknown>;
        expect(body.checkInId).toBe("f227b5ca-3cbd-4378-aa9c-3ba1206daf6e");
        expect(body.expectedVersion).toBe(5);
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("refuses a deviated answer without --category, and never calls the portal", async () => {
    const result = await run(["deviated"], {
      "/api/check-ins/current": {
        body: { checkIn: { id: "c06b0ed5-f844-4f5b-b0d3-23898a16267b", version: 1, status: "pending" } }
      }
    });
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("--category");
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("posts deviationCategory, deviationNote, and deviationTargetId for a deviated answer", async () => {
    const result = await run(
      ["deviated", "--category", "work", "--note", "Fixed a production incident", "--target", "action-draft"],
      {
        "/api/check-ins/current": {
          body: { checkIn: { id: "126b15ba-ff40-4a7f-8f3e-b824506a1fcc", version: 2, status: "pending" } }
        },
        "/api/commands/check-in": (call) => {
          const parsed = checkInCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          const body = call.body as Record<string, unknown>;
          expect(body.status).toBe("deviated");
          expect(body.deviationCategory).toBe("work");
          expect(body.deviationNote).toBe("Fixed a production incident");
          expect(body.deviationTargetId).toBe("action-draft");
          return { body: { state: fixtureRawState() } };
        }
      }
    );
    expect(result.exitCode).toBe(EXIT.ok);
  });

  it("records a voluntary check-in, with no id, when none is pending", async () => {
    const result = await run(["on-track"], {
      "/api/check-ins/current": { body: { checkIn: null } },
      "/api/commands/check-in": (call) => {
        expect(checkInCommandSchema.safeParse(call.body).success).toBe(true);
        const body = call.body as Record<string, unknown>;
        expect(body).toMatchObject({ type: "voluntary_check_in", status: "on_track", expectedVersion: null });
        expect(body).not.toHaveProperty("checkInId");
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.text).toContain("voluntary check-in recorded as on_track");
    expect(result.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  // "Not sure" in the portal UI, and the third answer a stale prompt offers:
  // recorded as its own status, neither on_track nor deviated, so it is not counted for or against
  // adherence (see `readCheckInSummary`).
  it("posts status unknown for the positional 'unknown', with no deviation fields", async () => {
    const result = await run(["unknown"], {
      "/api/check-ins/current": {
        body: { checkIn: { id: "a6f4a2d1-9b1e-4b3f-8a1a-2f6e6a1a2b3c", version: 7, status: "unknown" } }
      },
      "/api/commands/check-in": (call) => {
        const parsed = checkInCommandSchema.safeParse(call.body);
        expect(parsed.success).toBe(true);
        const body = call.body as Record<string, unknown>;
        expect(body.checkInId).toBe("a6f4a2d1-9b1e-4b3f-8a1a-2f6e6a1a2b3c");
        expect(body.status).toBe("unknown");
        expect(body.deviationCategory).toBeUndefined();
        expect(body.deviationNote).toBeUndefined();
        expect(body.deviationTargetId).toBeUndefined();
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("refuses an unknown status word", async () => {
    const result = await run(["sideways"], {
      "/api/check-ins/current": {
        body: { checkIn: { id: "d2116afa-ec7d-4e08-92c9-aed5af087998", version: 1, status: "pending" } }
      }
    });
    expect(result.exitCode).toBe(EXIT.usage);
  });

  it("prints the payload and sends nothing on --dry-run", async () => {
    const result = await run(["on-track", "--dry-run"], {
      "/api/check-ins/current": {
        body: { checkIn: { id: "e6b53640-7ec9-4ae0-b33d-9439162a68b2", version: 1, status: "pending" } }
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    const printed = JSON.parse(result.text) as { dryRun: boolean; payload: { checkInId: string } };
    expect(printed.dryRun).toBe(true);
    expect(printed.payload.checkInId).toBe("e6b53640-7ec9-4ae0-b33d-9439162a68b2");
  });
});

describe("check-in argument validation", () => {
  const pending = {
    "/api/check-ins/current": {
      body: { checkIn: { id: "126b15ba-ff40-4a7f-8f3e-b824506a1fcc", version: 2, status: "pending" } }
    }
  };
  const noPending = { "/api/check-ins/current": { body: { checkIn: null } } };

  it("reports a bad --category before it looks for a pending check-in", async () => {
    const result = await run(["deviated", "--category", "bogus"], noPending);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('Unknown --category "bogus"');
    expect(result.stderr).toContain("work, family, life_admin, other");
    expect(result.stderr).not.toContain("No check-in is pending");
    expect(result.calls.some((call) => call.url.includes("/api/check-ins/current"))).toBe(false);
  });

  it("reports a missing --category and an over-long --note before the pending lookup", async () => {
    const missing = await run(["deviated"], noPending);
    expect(missing.exitCode).toBe(EXIT.usage);
    expect(missing.stderr).toContain("--category");
    const long = await run(["deviated", "--category", "work", "--note", "x".repeat(1001)], noPending);
    expect(long.exitCode).toBe(EXIT.usage);
    expect(long.stderr).toContain("--note is limited to 1000 characters");
  });

  it("refuses --note, --target and --category on on-track and unknown, naming them", async () => {
    for (const word of ["on-track", "unknown"]) {
      const result = await run([word, "--note", "hi", "--target", "action-draft"], pending);
      expect(result.exitCode).toBe(EXIT.usage);
      expect(result.stderr).toContain("--note, --target only apply to a deviated answer");
      expect(result.calls.some((call) => call.method === "POST")).toBe(false);
    }
    const category = await run(["on-track", "--category", "work"], pending);
    expect(category.exitCode).toBe(EXIT.usage);
    expect(category.stderr).toContain("--category only applies to a deviated answer");
  });

  it("refuses a --target that is not an action id, without posting", async () => {
    const result = await run(["deviated", "--category", "work", "--target", "nonexistent-id"], pending);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain('--target "nonexistent-id" is not the id of any action');
    expect(result.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("validates --target before the pending lookup too", async () => {
    const result = await run(["deviated", "--category", "work", "--target", "nonexistent-id"], noPending);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).not.toContain("No check-in is pending");
  });

  it("accepts an exact action title for --target and sends the action's id", async () => {
    const state = fixtureRawState();
    const draft = (state.actions as Array<{ id: string; title: string }>).find(
      (action) => action.id === "action-draft"
    )!;
    const result = await run(["deviated", "--category", "work", "--target", draft.title.toUpperCase()], {
      ...pending,
      "/api/commands/check-in": (call) => {
        expect((call.body as Record<string, unknown>).deviationTargetId).toBe("action-draft");
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("records a voluntary deviated check-in for valid arguments when none is pending", async () => {
    const result = await run(["deviated", "--category", "work"], {
      ...noPending,
      "/api/commands/check-in": (call) => {
        expect(checkInCommandSchema.safeParse(call.body).success).toBe(true);
        expect(call.body).toMatchObject({ type: "voluntary_check_in", status: "deviated", deviationCategory: "work" });
        return { body: { state: fixtureRawState() } };
      }
    });
    expect(result.exitCode).toBe(EXIT.ok);
  });
});
