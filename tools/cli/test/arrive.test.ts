import { planningEntityCommandSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

/** The fixture's settings row carries no `version`; most tests here want a real one, as the server row always has. */
function stateWithSettingsVersion(version: number): Record<string, unknown> {
  const raw = fixtureRawState();
  raw.settings = { ...(raw.settings as Record<string, unknown>), version };
  return raw;
}

async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  rawState: Record<string, unknown> = fixtureRawState()
): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCode = await runCli(["arrive", ...argv], {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes }, calls)
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

describe("arrive", () => {
  it("resolves a location by id and sends the same current_availability write the portal's ArrivalButton sends", async () => {
    const raw = stateWithSettingsVersion(7);
    let posted: Record<string, unknown> | undefined;
    const { exitCode, calls } = await run(
      ["ctx-gym", "--json"],
      {
        "/api/commands/entity": (call) => {
          posted = call.body as Record<string, unknown>;
          const parsed = planningEntityCommandSchema.safeParse(call.body);
          expect(parsed.success).toBe(true);
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(posted?.type).toBe("save_entity");
    expect(posted?.entityType).toBe("current_availability");
    expect(posted?.expectedVersion).toBe(7);
    const entity = posted?.entity as Record<string, unknown>;
    // The legacy pair travels alongside so a location-only write never trips the server's
    // "Current energy is required" check (report/finding: a bare currentSituation.locationId --set fails).
    expect(entity.currentEnergy).toBe("high");
    expect(entity.assertedConditions).toEqual(["home", "laptop"]);
    expect(entity.currentSituation).toEqual({ locationId: "ctx-gym" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("resolves a location by exact, case-insensitive name", async () => {
    const raw = stateWithSettingsVersion(1);
    let posted: Record<string, unknown> | undefined;
    const { exitCode } = await run(
      ["gym"],
      {
        "/api/commands/entity": (call) => {
          posted = call.body as Record<string, unknown>;
          return { body: { state: raw } };
        }
      },
      raw
    );
    expect(exitCode).toBe(EXIT.ok);
    expect((posted!.entity as Record<string, unknown>).currentSituation).toEqual({ locationId: "ctx-gym" });
  });

  it("does not match a same-named context of a different kind", async () => {
    // "ctx-laptop" is kind:"capability" named "Laptop"; arrive must never treat it as a place.
    const { exitCode, stderr, calls } = await run(["Laptop"]);
    expect(exitCode).toBe(EXIT.notFound);
    expect(stderr).toContain("No location");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("reports an unknown place as notFound and never posts", async () => {
    const { exitCode, calls } = await run(["nowhere"]);
    expect(exitCode).toBe(EXIT.notFound);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("is a no-op when already at that location", async () => {
    // Fixture's currentSituation.locationId is already "ctx-home".
    const { exitCode, stdout, calls } = await run(["ctx-home", "--json"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    const doc = JSON.parse(stdout) as { changed: boolean; locationId: string };
    expect(doc.changed).toBe(false);
    expect(doc.locationId).toBe("ctx-home");
  });

  it("prints the payload and sends nothing on --dry-run", async () => {
    const raw = stateWithSettingsVersion(2);
    const { exitCode, stdout, calls } = await run(["ctx-gym", "--dry-run"], {}, raw);
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
    const printed = JSON.parse(stdout) as { dryRun: boolean; payload: { entityType: string; expectedVersion: number } };
    expect(printed.dryRun).toBe(true);
    expect(printed.payload.entityType).toBe("current_availability");
    expect(printed.payload.expectedVersion).toBe(2);
  });

  it("requires the place argument", async () => {
    const { exitCode, stderr } = await run([]);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("place");
  });
});
