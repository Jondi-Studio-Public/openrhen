import { describe, expect, it } from "vitest";
import {
  agentCaptureRefusal,
  agentProposalTypeRefusal,
  contextInUseClauses,
  extensionSnapshotWatches,
  isTextlessSourceType,
  proposalOwner,
  registerEntityExtension
} from "./entity-extensions";

// With nothing registered (the OpenRhen export) every hook is a no-op; a registered extension adds to each.
describe("entity extensions", () => {
  it("does nothing until an extension registers", () => {
    expect(isTextlessSourceType("note")).toBe(false);
    expect(contextInUseClauses()).toBe("");
    expect(agentCaptureRefusal("note", "confirm")).toBeUndefined();
    expect(extensionSnapshotWatches({ kind: "commitment", id: "c" })).toEqual([]);
    expect(proposalOwner("email_change")).toBeUndefined();
    expect(agentProposalTypeRefusal("email_change", "action")).toBeUndefined();
  });

  it("merges what a registered extension adds, once per id", () => {
    const extension = {
      id: "example",
      textlessSourceTypes: ["example"],
      contextInUse: "EXISTS (SELECT 1)",
      agentCaptureRefusal: (type: string) => (type === "example" ? "no" : undefined)
    };
    registerEntityExtension(extension);
    registerEntityExtension(extension);
    expect(isTextlessSourceType("example")).toBe(true);
    expect(contextInUseClauses().match(/EXISTS/g)).toHaveLength(1);
    expect(agentCaptureRefusal("example", "decline")).toBe("no");
    expect(agentCaptureRefusal(undefined, "decline")).toBeUndefined();
  });

  it("routes a proposal type to the extension that owns it, and lets it refuse a mismatched agent body", () => {
    registerEntityExtension({
      id: "example-proposals",
      proposalTypes: ["example_change"],
      agentProposalTypeRefusal: (stored, requested) =>
        stored === "example_change" && requested !== "example_change"
          ? { forbidden: true, message: "Confirm it as an example change." }
          : undefined
    });
    expect(proposalOwner("example_change")?.id).toBe("example-proposals");
    expect(proposalOwner("action")).toBeUndefined();
    expect(agentProposalTypeRefusal("example_change", "action")).toEqual({
      forbidden: true,
      message: "Confirm it as an example change."
    });
    expect(agentProposalTypeRefusal("example_change", "example_change")).toBeUndefined();
  });
});
