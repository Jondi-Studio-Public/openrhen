import { describe, expect, it } from "vitest";
import { syncRunStatusLabel, syncTriggerLabel } from "./sync-run-labels";

describe("syncTriggerLabel", () => {
  it("names each known trigger", () => {
    expect(syncTriggerLabel("manual")).toBe("Run by hand");
    expect(syncTriggerLabel("scheduled")).toBe("Scheduled");
    expect(syncTriggerLabel("notify")).toBe("On a new submission");
  });
  it("reads an unknown trigger as plain words", () => {
    expect(syncTriggerLabel("on_restart")).toBe("On restart");
  });
});

describe("syncRunStatusLabel", () => {
  it("names each known status", () => {
    expect(syncRunStatusLabel("synced")).toBe("Synced");
    expect(syncRunStatusLabel("needs_review")).toBe("Needs your review");
    expect(syncRunStatusLabel("failed")).toBe("Failed");
    expect(syncRunStatusLabel("not_configured")).toBe("Not set up");
  });
  it("reads an unknown status as plain words", () => {
    expect(syncRunStatusLabel("in_progress")).toBe("In progress");
  });
});
