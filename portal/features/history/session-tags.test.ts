import { describe, expect, it } from "vitest";
import { sessionTags } from "./session-tags";

describe("sessionTags", () => {
  it("tags a session whose start was recorded after the fact", () => {
    expect(sessionTags({ startedRecordedAt: "2026-09-03T10:00:00+10:00" })).toEqual(["Start time entered later"]);
  });

  it("adds nothing for a session started now", () => {
    expect(sessionTags({})).toEqual([]);
    expect(sessionTags({ startedRecordedAt: null })).toEqual([]);
  });
});
