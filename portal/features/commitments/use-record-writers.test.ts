import { describe, expect, it } from "vitest";
import { writersFrom } from "./use-record-writers";

const T = "commitments";

describe("writersFrom", () => {
  it("calls a record no agent ever wrote the person's", () => {
    expect(writersFrom([], T, 1)).toEqual({ createdBy: "person", lastChangedBy: null });
    expect(writersFrom([{ actor: null }, { actor: "system" }], T, 3)).toEqual({
      createdBy: "person",
      lastChangedBy: null
    });
  });

  it("names the agent whose write inserted the record, not the capture that shares its id", () => {
    const rows = [
      { actor: "openclaw", imageTable: T, inserted: true, afterVersion: 1 },
      { actor: null, imageTable: "captures", inserted: true, afterVersion: 1 }
    ];
    expect(writersFrom(rows, T, 1)).toEqual({ createdBy: { agent: "openclaw" }, lastChangedBy: "openclaw" });
  });

  it("names the last writer only when its write left the record at the current version", () => {
    const rows = [
      { actor: "lane-d-agent", imageTable: T, inserted: false, afterVersion: 2 },
      { actor: null, imageTable: T, inserted: true, afterVersion: 1 }
    ];
    expect(writersFrom(rows, T, 2)).toEqual({ createdBy: "person", lastChangedBy: "lane-d-agent" });
    // An import or a later edit with no image moved the version on: no one is named.
    expect(writersFrom(rows, T, 3).lastChangedBy).toBeNull();
  });

  it("leaves the creator unknown when an agent wrote the record but no insert image was kept", () => {
    expect(writersFrom([{ actor: "openclaw" }], T, 4)).toEqual({ createdBy: null, lastChangedBy: null });
  });
});
