import { describe, expect, it } from "vitest";
import {
  AGENT_ERROR_CODES,
  agentErrorCodeForExit,
  agentErrorResult,
  closestNames,
  missingRecordMessage,
  saysRecordMissing,
  conflictMessage,
  doubtfulWriteMessage,
  formatAgentCall,
  rateLimitMessage,
  selfContainedMessage,
  toAgentError,
  unknownToolMessage
} from "./agent-error";
import { hardFloorInstead, hardFloorReason } from "./agent-scopes";

describe("agent error mapping", () => {
  it("maps the CLI exit codes", () => {
    expect([1, 2, 3, 4, 5, 6].map(agentErrorCodeForExit)).toEqual([
      "usage",
      "validation",
      "conflict",
      "not_found",
      "unavailable",
      "reentry_required"
    ]);
    expect(agentErrorCodeForExit(99)).toBe("usage");
    expect(AGENT_ERROR_CODES).toHaveLength(9);
    expect(AGENT_ERROR_CODES).toContain("auth");
  });

  it("an explicit code wins over the exit code, and an unknown one is ignored", () => {
    expect(toAgentError({ message: "m", exitCode: 1, code: "guarded" }).code).toBe("guarded");
    expect(toAgentError({ message: "m", exitCode: 3, code: "bogus" }).code).toBe("conflict");
  });

  it("carries suggestedPath, currentVersion and commandId only when well formed", () => {
    expect(toAgentError({ message: "m", exitCode: 3, currentVersion: 5, suggestedPath: "", commandId: 4 })).toEqual({
      code: "conflict",
      message: "m",
      retryable: false,
      currentVersion: 5
    });
  });

  it("is retryable only when unavailable and a repeat is safe", () => {
    expect(toAgentError({ message: "m", exitCode: 5 }).retryable).toBe(false);
    expect(toAgentError({ message: "m", exitCode: 5, safeToRepeat: true }).retryable).toBe(true);
    expect(toAgentError({ message: "m", exitCode: 5, commandId: "abc" })).toMatchObject({
      retryable: true,
      commandId: "abc"
    });
    expect(toAgentError({ message: "m", exitCode: 2, safeToRepeat: true }).retryable).toBe(false);
  });

  it("a guarded refusal takes its path and text from the hard floor", () => {
    const call = { tool: "span", action: "remove" } as const;
    const reason = hardFloorReason(call);
    const path = hardFloorInstead(call);
    expect(reason).toContain("deleting a span");
    const error = toAgentError({ message: reason ?? "", code: "guarded", suggestedPath: path });
    expect(error).toEqual({ code: "guarded", message: reason, retryable: false, suggestedPath: path });
  });

  it("builds the tool result and tells a doubtful write to retry only with its id", () => {
    const doubtful = doubtfulWriteMessage("timed out.", "id-1", "rhen_save");
    expect(doubtful).toContain("repeat the SAME rhen_save call");
    expect(doubtful).toContain('"command-id":"id-1"');
    expect(doubtful).toContain("Wait 2 seconds");
    expect(doubtful).toContain("3 attempts");
    expect(doubtful).toContain("new command-id");
    expect(doubtful).not.toMatch(/--[a-z]/);
    const error = toAgentError({ message: "m", exitCode: 4 });
    expect(agentErrorResult(error)).toEqual({
      content: [{ type: "text", text: "m" }],
      isError: true,
      structuredContent: { error }
    });
  });

  it("carries the next call, valid values, what to tell the person and the wait", () => {
    const nextCall = { tool: "rhen_span", arguments: { subcommand: "set", span: "<id>" } };
    const error = toAgentError({
      message: "m",
      code: "guarded",
      nextCall,
      validValues: { energy: ["high", "low"] },
      tellThePerson: "Please do X.",
      retryAfterSeconds: 12
    });
    expect(error).toMatchObject({ nextCall, validValues: { energy: ["high", "low"] }, tellThePerson: "Please do X." });
    expect(error.retryAfterSeconds).toBe(12);
    // Malformed extras are dropped, never passed on.
    expect(toAgentError({ message: "m", nextCall: { tool: 3 }, validValues: "x", retryAfterSeconds: -1 })).toEqual({
      code: "usage",
      message: "m",
      retryable: false
    });
  });

  it("formats a call as the exact MCP invocation", () => {
    expect(formatAgentCall({ tool: "rhen_span", arguments: { subcommand: "set", end: "2026-11-10" } })).toBe(
      'rhen_span {"subcommand":"set","end":"2026-11-10"}'
    );
  });

  it("makes the message self-contained: the first issue and the missing lines", () => {
    const message = selfContainedMessage("Re-entry validation failed.", {
      issues: [
        { path: ["energy"], message: "Invalid option: expected one of high|medium|low|recovery" },
        { path: ["contexts"], message: "Required" }
      ],
      missing: ["location", "energy"]
    });
    expect(message).toContain("energy: Invalid option");
    expect(message).toContain("1 more problem");
    expect(message).toContain("Still needed: location; energy");
    expect(selfContainedMessage("Plain.", null)).toBe("Plain.");
    // Not repeated when the message already says it.
    expect(selfContainedMessage("Still needed: location; energy.", { missing: ["location", "energy"] })).toBe(
      "Still needed: location; energy."
    );
  });

  it("names the closest valid names", () => {
    expect(closestNames("rhen_sav", ["rhen_save", "rhen_span", "rhen_status"])[0]).toBe("rhen_save");
    expect(closestNames("dryRun", ["dry-run", "command-id"])).toEqual(["dry-run"]);
    expect(closestNames("zzzzzz", ["dry-run"])).toEqual([]);
  });

  it("a refusal for rate limiting puts the wait in the message", () => {
    expect(rateLimitMessage(37)).toContain("Wait 37 seconds");
  });

  it("an unknown tool lists the closest valid names and where the list is", () => {
    const message = unknownToolMessage("rhen_sav", ["rhen_save", "rhen_span", "rhen_status"]);
    expect(message).toContain('Unknown tool "rhen_sav"');
    expect(message).toContain("Closest valid names: rhen_save");
    expect(message).toContain("tools/list");
    expect(unknownToolMessage(undefined, [])).toContain("no name given");
  });

  it("a conflict says to re-read, the new version and a NEW command-id", () => {
    const message = conflictMessage("This action changed.", "rhen_save", 8);
    expect(message).toContain("rhen_show");
    expect(message).toContain('"expected-version":8');
    expect(message).toContain('new "command-id"');
    expect(message).not.toMatch(/--[a-z]/);
  });

  it("a record that no longer exists says how to find the right id", () => {
    expect(saysRecordMissing("This project no longer exists. Check the id.")).toBe(true);
    expect(saysRecordMissing("Another session is already open.")).toBe(false);
    expect(missingRecordMessage("This project no longer exists.")).toContain("rhen_search or rhen_list");
  });
});
