import { describe, expect, it } from "vitest";
import { childrenOpenRefusal, closeEntityCommandSchema, restoreCall } from "@openrhen/contracts";
import { CommandRefusal } from "@/shared/command-refusal";
import { resultFor } from "@/test/close-fixtures";
import {
  closeCommandFor,
  closeToastText,
  isChildrenRefusal,
  restoreCommandFor,
  restoreToastText,
  undoCommandFor
} from "./close-commands";

const ID = "5f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const target = { type: "project", id: "p1", title: "Quarterly report", version: 4 } as const;

describe("closeCommandFor", () => {
  it("builds a body the close route parses, with the shown id, the version and no reason", () => {
    const command = closeCommandFor(target, "archive", { commandId: ID });
    expect(closeEntityCommandSchema.parse(command)).toEqual({
      commandId: ID,
      type: "project",
      id: "p1",
      verb: "archive",
      do: "close",
      expectedVersion: 4
    });
  });

  it("adds includeChildren (camelCase, the route's spelling) only when asked", () => {
    expect(closeCommandFor(target, "cancel", { commandId: ID, includeChildren: true })).toMatchObject({
      includeChildren: true
    });
    expect("includeChildren" in closeCommandFor(target, "cancel", { commandId: ID })).toBe(false);
  });
});

describe("restoreCommandFor", () => {
  it("builds a restore from the row's own fields", () => {
    const command = restoreCommandFor({ type: "action", id: "a1", restoreVerb: "cancel", version: 7 }, { commandId: ID });
    expect(closeEntityCommandSchema.parse(command)).toMatchObject({ do: "restore", verb: "cancel", expectedVersion: 7 });
  });
  it("asks for the rows closed with it when told to", () => {
    const command = restoreCommandFor(
      { type: "outcome", id: "o1", restoreVerb: "cancel", version: 2 },
      { commandId: ID, includeChildren: true }
    );
    expect(closeEntityCommandSchema.parse(command).includeChildren).toBe(true);
  });
});

describe("undoCommandFor", () => {
  it("is built from the result's fields, not from the agent-tool call it carries", () => {
    const close = closeCommandFor(target, "archive", { commandId: ID });
    const closed = resultFor(close, { version: 4 });
    // the call the result carries is the tool's (kebab-case, no verb): posting it would fail the route's schema
    expect(closeEntityCommandSchema.safeParse(closed.restore?.arguments).success).toBe(false);
    const undo = undoCommandFor(closed, { commandId: ID });
    expect(closeEntityCommandSchema.parse(undo)).toMatchObject({
      type: "project",
      id: "p1",
      verb: "archive",
      do: "restore",
      expectedVersion: 5
    });
    expect(restoreCall("project", "p1", 5, "archived").tool).toBe("rhen_archive");
  });

  it("includes the children when the close took any with it (an area, outcome or project)", () => {
    const close = closeCommandFor({ ...target, type: "outcome" }, "cancel", { commandId: ID, includeChildren: true });
    const closed = resultFor(close, {
      version: 4,
      cascaded: [{ type: "project", id: "p9", from: "active", version: 3 }]
    });
    expect(undoCommandFor(closed, { commandId: ID }).includeChildren).toBe(true);
  });

  it("does not for a lone close, or for a commitment (whose restore always reopens its batch)", () => {
    const lone = resultFor(closeCommandFor(target, "cancel", { commandId: ID }), { version: 4 });
    expect("includeChildren" in undoCommandFor(lone, { commandId: ID })).toBe(false);
    const commitment = resultFor(closeCommandFor({ ...target, type: "commitment" }, "cancel", { commandId: ID }), {
      version: 4,
      cascaded: [{ type: "action", id: "a1", from: "planned", version: 2 }]
    });
    expect("includeChildren" in undoCommandFor(commitment, { commandId: ID })).toBe(false);
  });
});

describe("isChildrenRefusal", () => {
  it("recognises the server's own children refusal and nothing else", () => {
    const refusal = childrenOpenRefusal({
      type: "outcome",
      id: "o1",
      verb: "cancel",
      version: 3,
      count: 2,
      deadlined: []
    });
    const children = new CommandRefusal(refusal.message, { status: 400, nextCall: refusal.nextCall });
    expect(isChildrenRefusal(children)).toBe(true);
    expect(isChildrenRefusal(new CommandRefusal("Nope", { status: 400 }))).toBe(false);
    expect(
      isChildrenRefusal(new CommandRefusal(refusal.message, { status: 409, nextCall: refusal.nextCall }))
    ).toBe(false);
    expect(isChildrenRefusal(new Error("x"))).toBe(false);
  });
});

describe("closeToastText", () => {
  const close = (type: "project" | "action", verb: "archive" | "cancel", extra = {}) =>
    resultFor(closeCommandFor({ ...target, type }, verb, { commandId: ID }), { version: 4, ...extra });

  it("says what happened to the row", () => {
    expect(closeToastText("Quarterly report", close("project", "archive"))).toBe("Quarterly report archived.");
    expect(closeToastText("Draft", close("action", "cancel"))).toBe("Draft cancelled.");
  });
  it("counts what closed under it and what was left open", () => {
    const text = closeToastText(
      "Garden",
      close("project", "cancel", {
        cascaded: [
          { type: "action", id: "a1", from: "planned", version: 2 },
          { type: "action", id: "a2", from: "planned", version: 2 }
        ],
        skipped: [{ type: "action", id: "a3", reason: "Has a deadline.", call: null }]
      })
    );
    expect(text).toBe("Garden cancelled and 2 under it. 1 left open.");
  });
  it("lists a commitment's cascade by kind", () => {
    const result = resultFor(closeCommandFor({ ...target, type: "action" }, "cancel", { commandId: ID }), {
      version: 4,
      cascaded: [
        { type: "action", id: "a1", from: "planned", version: 2 },
        { type: "action", id: "a2", from: "planned", version: 2 },
        { type: "routine_step", id: "s1", from: "pending", version: 2 }
      ]
    });
    expect(closeToastText("Dentist", { ...result, type: "commitment" })).toBe(
      "Dentist cancelled, with 2 actions and 1 routine step."
    );
  });
  it("shortens a very long title", () => {
    expect(closeToastText("x".repeat(100), close("action", "cancel")).length).toBeLessThan(90);
  });
});

describe("restoreToastText", () => {
  it("says where it landed and notes an assumed landing", () => {
    const restore = (assumed: boolean, extra = {}) =>
      resultFor(restoreCommandFor({ type: "project", id: "p1", restoreVerb: "cancel", version: 4 }, { commandId: ID }), {
        version: 4,
        ...extra,
        ...(assumed ? {} : { closedFrom: "paused" })
      });
    expect(restoreToastText("Garden", restore(false))).toBe("Restored Garden as paused.");
    expect(restoreToastText("Garden", restore(true))).toBe(
      "Restored Garden as active; the old status was not recorded."
    );
  });
  it("mentions rows left as they were", () => {
    const base = resultFor(restoreCommandFor({ type: "outcome", id: "o1", restoreVerb: "cancel", version: 4 }, { commandId: ID }), {
      version: 4,
      closedFrom: "active",
      skipped: [{ type: "project", id: "p1", reason: "It was changed after it was closed, so it was left as it is.", call: null }]
    });
    expect(restoreToastText("Garden", base)).toBe("Restored Garden as active. 1 under it was left closed.");
  });
});
