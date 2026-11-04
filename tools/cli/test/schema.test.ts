import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

/** `schema` is offline, so this never needs a real route; the fake fetch is only here to prove it stays unused. */
async function runSchema(argv: readonly string[]): Promise<Run> {
  const calls: RecordedCall[] = [];
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdoutLines.push(text),
    stderr: (text) => stderrLines.push(text),
    env: {},
    readConfigFile: () => null,
    fetchImpl: fakeFetch({}, calls)
  });
  return { exitCode, stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n"), calls };
}

describe("schema", () => {
  it("prints the action entity's JSON schema, with title and id, in both table and json mode", async () => {
    for (const argv of [
      ["schema", "actions"],
      ["schema", "actions", "--json"]
    ]) {
      const { exitCode, stdout } = await runSchema(argv);
      expect(exitCode).toBe(EXIT.ok);
      const json = JSON.parse(stdout) as { properties: Record<string, unknown> };
      expect(json.properties.title).toBeDefined();
      expect(json.properties.id).toBeDefined();
    }
  });

  it("resolves the session command payload: a discriminated union whose every variant carries commandId and type", async () => {
    const { exitCode, stdout } = await runSchema(["schema", "session"]);
    expect(exitCode).toBe(EXIT.ok);
    const json = JSON.parse(stdout) as { oneOf: { properties: Record<string, unknown> }[] };
    expect(Array.isArray(json.oneOf)).toBe(true);
    expect(json.oneOf.length).toBeGreaterThan(0);
    for (const variant of json.oneOf) {
      expect(variant.properties.commandId).toBeDefined();
      expect(variant.properties.type).toBeDefined();
    }
  });

  it("resolves `action` to the save-action command payload, distinct from the `actions` entity", async () => {
    const command = JSON.parse((await runSchema(["schema", "action"])).stdout) as {
      properties: Record<string, unknown>;
    };
    expect(command.properties.commandId).toBeDefined();
    // The command payload nests the entity's own fields under `action`; it has no top-level `title`.
    expect(command.properties.title).toBeUndefined();

    const entity = JSON.parse((await runSchema(["schema", "actions"])).stdout) as {
      properties: Record<string, unknown>;
    };
    expect(entity.properties.title).toBeDefined();
    expect(entity.properties.id).toBeDefined();
    expect(entity.properties.commandId).toBeUndefined();
  });

  it("with no name lists both groups, and --list does the same", async () => {
    const table = await runSchema(["schema"]);
    expect(table.exitCode).toBe(EXIT.ok);
    expect(table.stdout).toContain("Entities:");
    expect(table.stdout).toContain("actions");
    expect(table.stdout).toContain("session");

    const json = JSON.parse((await runSchema(["schema", "--json"])).stdout) as {
      commands: string[];
      entities: string[];
    };
    expect(json.commands).toContain("session");
    expect(json.commands).toContain("state");
    expect(json.commands).toContain("planning");
    expect(json.entities).toContain("actions");

    const listed = JSON.parse((await runSchema(["schema", "--list", "--json"])).stdout) as { entities: string[] };
    expect(listed.entities).toContain("actions");
  });

  it("an unknown name is a usage error naming the valid command and entity names", async () => {
    const { exitCode, stderr } = await runSchema(["schema", "nope"]);
    expect(exitCode).toBe(EXIT.usage);
    expect(stderr).toContain("nope");
    expect(stderr).toContain("session");
    expect(stderr).toContain("actions");
  });

  it("resolves the whole state and planning documents", async () => {
    const state = JSON.parse((await runSchema(["schema", "state"])).stdout) as { properties: Record<string, unknown> };
    expect(state.properties.actions).toBeDefined();
    expect(state.properties.settings).toBeDefined();

    const planning = JSON.parse((await runSchema(["schema", "planning"])).stdout) as {
      properties: Record<string, unknown>;
    };
    expect(planning.properties.status).toBeDefined();
  });

  it("resolves settings, pulled out of the state document, with the disruption preset fields", async () => {
    const settings = JSON.parse((await runSchema(["schema", "settings"])).stdout) as {
      title: string;
      type: string;
      properties: Record<string, unknown>;
    };
    expect(settings.title).toBe("settings (portal settings)");
    expect(settings.type).toBe("object");
    expect(settings.properties.timezone).toBeDefined();
    expect(settings.properties.disruptionKindLabels).toBeDefined();
    expect(settings.properties.disruptionWhenPresets).toBeDefined();
    expect(settings.properties.disruptionDurationPresets).toBeDefined();
    // Distinct from the whole state document, which nests settings one level down.
    expect(settings.properties.actions).toBeUndefined();
  });

  it("--list and the bare listing both advertise settings", async () => {
    const json = JSON.parse((await runSchema(["schema", "--json"])).stdout) as { commands: string[] };
    expect(json.commands).toContain("settings");
    const table = await runSchema(["schema"]);
    expect(table.stdout).toContain("settings");
  });

  it("resolves the condition entity with the live kind's recurrenceRuleId/commitmentId fields", async () => {
    const condition = JSON.parse((await runSchema(["schema", "condition"])).stdout) as {
      properties: Record<string, unknown>;
    };
    expect(condition.properties.kind).toBeDefined();
    expect(condition.properties.recurrenceRuleId).toBeDefined();
    expect(condition.properties.commitmentId).toBeDefined();
    const kindSchema = condition.properties.kind as { enum?: string[] };
    expect(kindSchema.enum).toContain("live");
    // "conditions" (plural) resolves to the same entity.
    const plural = JSON.parse((await runSchema(["schema", "conditions"])).stdout) as {
      properties: Record<string, unknown>;
    };
    expect(plural.properties.recurrenceRuleId).toBeDefined();
  });

  it("never calls the portal, even when --url is passed", async () => {
    const { calls, exitCode } = await runSchema(["schema", "actions", "--url", "http://example.com"]);
    expect(exitCode).toBe(EXIT.ok);
    expect(calls).toHaveLength(0);
  });
});
