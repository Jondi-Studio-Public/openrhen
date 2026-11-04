import { describe, expect, it } from "vitest";
import { openPrepFor } from "./commitment-prep.js";

describe("openPrepFor", () => {
  const actions = [
    { id: "a", title: "Book the room", status: "planned", prepForCommitmentId: "c1" },
    { id: "b", title: "Print handouts", status: "doing", prepForCommitmentId: "c1" },
    { id: "c", title: "Done already", status: "done", prepForCommitmentId: "c1" },
    { id: "d", title: "Cancelled already", status: "cancelled", prepForCommitmentId: "c1" },
    { id: "e", title: "Other commitment", status: "planned", prepForCommitmentId: "c2" },
    { id: "f", title: "Not prep", status: "planned" }
  ];

  it("lists only the open prep attached to that commitment", () => {
    expect(openPrepFor(actions, "c1").map((action) => action.id)).toEqual(["a", "b"]);
  });

  it("is empty for a commitment with no prep", () => {
    expect(openPrepFor(actions, "c3")).toEqual([]);
  });
});
