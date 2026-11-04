import { describe, expect, it } from "vitest";
import { MCP_TOOL_MANIFEST, mcpManifestTool, validateToolArguments, type AgentCall } from "@openrhen/contracts";
import {
  CommandConflictError,
  InvalidCommandError,
  alreadyClosed,
  badValue,
  outOfRange,
  requiredValue,
  invalidChoice,
  notFound,
  notFoundConflict,
  openSessionConflict,
  revertConflict,
  versionConflict,
  wrongSessionState,
  wrongState
} from "./command-errors";

/** The call is one an agent can send as it stands: a real tool, real arguments, accepted by the tool's own schema. */
function expectRealCall(call: AgentCall | undefined, label: string) {
  expect(call, `${label}: a next call`).toBeDefined();
  const tool = mcpManifestTool(call!.tool);
  expect(tool, `${label}: ${call!.tool} is a tool`).toBeDefined();
  const checked = validateToolArguments(tool!.inputSchema, call!.arguments, tool!.name);
  expect(checked.ok, `${label}: ${JSON.stringify(call)} (${checked.ok ? "" : checked.error})`).toBe(true);
}

describe("refusals a handler throws", () => {
  it("notFound keeps the class (400), names the id and carries the list call", () => {
    const error = notFound("project", "p-9");
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect(error.message).toContain('"p-9"');
    expectRealCall(error.nextCall, "notFound");
    expect(error.nextCall?.arguments).toMatchObject({ entity: "projects" });
  });

  it("notFoundConflict stays a 409-class error", () => {
    const error = notFoundConflict("action", "a-1");
    expect(error).toBeInstanceOf(CommandConflictError);
    expect(error.message).toContain('"a-1"');
    expectRealCall(error.nextCall, "notFoundConflict");
  });

  it("invalidChoice carries every accepted value as text and as validValues", () => {
    const error = invalidChoice("attendance", "zoom", ["in_person", "remote"], { label: "Commitment attendance" });
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect(error.message).toBe('Commitment attendance "zoom" is not valid. Use one of: in_person, remote.');
    expect(error.validValues).toEqual({ attendance: ["in_person", "remote"] });
  });

  it("wrongState names the state and what is accepted", () => {
    const error = wrongState({ kind: "routine step", id: "s1", state: "skipped", allowed: ["pending"] });
    expect(error.message).toContain('"s1" is skipped now');
    expect(error.message).toContain("needs it to be pending");
    expect(error.validValues).toEqual({ state: ["pending"] });
  });

  it("alreadyClosed and wrongSessionState end in a real call", () => {
    const closed = alreadyClosed("routine step", "s1", "skipped", {
      tool: "rhen_activity",
      arguments: { subcommand: "unskip-step", step: "s1" }
    });
    expectRealCall(closed.nextCall, "alreadyClosed");
    for (const fix of [undefined, "resume"]) {
      const error = wrongSessionState("rhen_session", "sess-1", "paused", ["running"], fix);
      expect(error.message).toContain('"sess-1" is paused now');
      expectRealCall(error.nextCall, `wrongSessionState ${fix}`);
    }
    expectRealCall(wrongSessionState("rhen_activity", "a", "running", ["paused"], "resume").nextCall, "activity");
  });

  it("openSessionConflict names the open session and the call that ends it, per tool", () => {
    const action = openSessionConflict({ id: "s-1", status: "running", target_type: "action" });
    expect(action).toBeInstanceOf(CommandConflictError);
    expect(action.message).toContain("id s-1, running");
    expect(action.nextCall?.tool).toBe("rhen_session");
    expectRealCall(action.nextCall, "action session");
    const step = openSessionConflict({ id: "s-2", status: "paused", target_type: "routine_step" });
    expect(step.message).toContain("on a routine step");
    expect(step.nextCall?.tool).toBe("rhen_activity");
    expectRealCall(step.nextCall, "activity session");
  });

  it("versionConflict gives the version when known, else the read call", () => {
    const known = versionConflict("project", "p1", 3, 5);
    expect(known.currentVersion).toBe(5);
    expect(known.message).toBe('Project "p1" is at version 5 now, not the 3 you sent: it changed after you read it.');
    expect(known.nextCall).toBeUndefined();
    const unknown = versionConflict("routine step", "s1", 2);
    expect(unknown.currentVersion).toBeUndefined();
    expect(unknown.message).toContain("you sent version 2");
    expectRealCall(unknown.nextCall, "versionConflict");
  });

  it("every tool a refusal can name is in the manifest", () => {
    const tools = new Set(MCP_TOOL_MANIFEST.map((tool) => tool.name));
    for (const name of ["rhen_list", "rhen_show", "rhen_status", "rhen_session", "rhen_activity", "rhen_inbox"])
      expect(tools.has(name), name).toBe(true);
  });

  it("range, shape and required refusals name the value sent and what is accepted", () => {
    const range = outOfRange("Arrival margin", 90, 0, 60, "minutes");
    expect(range).toBeInstanceOf(InvalidCommandError);
    expect(range.message).toContain("Arrival margin 90 is out of range: send a whole number from 0 to 60 minutes");
    expect(
      badValue("Wake time", "2026-11-04", "it must be a full ISO time with a UTC offset", "2026-11-04T09:00:00+10:00")
        .message
    ).toContain('Wake time "2026-11-04" is not valid');
    expect(requiredValue("Project").message).toContain("Project is required but was empty or not sent");
  });

  it("the undo refusals of the write log name the exact call", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(join(__dirname, "write-revert.ts"), "utf8");
    for (const call of ["arguments: { list: true }", "arguments: { id: command.target, redo: true }"])
      expect(source, call).toContain(call);
    expectRealCall({ tool: "rhen_undo", arguments: { list: true } }, "undo list");
    expectRealCall({ tool: "rhen_undo", arguments: { id: "abc", redo: true } }, "undo redo");
  });

  it("revertConflict keeps the message and names the write-log listing as the next call", () => {
    const error = revertConflict("This save cannot be undone: something newer took its place.", "shows the writes");
    expect(error).toBeInstanceOf(CommandConflictError);
    expect(error.message).toContain("something newer");
    expect(error.nextCall).toEqual({ tool: "rhen_undo", arguments: { list: true }, note: "shows the writes" });
    expectRealCall(error.nextCall, "revertConflict");
  });
});
