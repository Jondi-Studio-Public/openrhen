import { describe, expect, it } from "vitest";
import { changesetCommandSchema, changesetFloor } from "./changeset.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (commandId: string) => ({ intent: 0, path: "/api/commands/action", payload: { commandId } });

describe("changesetCommandSchema", () => {
  it("takes commands with their own ids", () => {
    expect(
      changesetCommandSchema.safeParse({ commandId: id(1), mode: "apply", items: [item(id(2)), item(id(3))] }).success
    ).toBe(true);
  });

  it("refuses a command id used twice, or the changeset's own", () => {
    expect(
      changesetCommandSchema.safeParse({ commandId: id(1), mode: "apply", items: [item(id(2)), item(id(2))] }).success
    ).toBe(false);
    expect(changesetCommandSchema.safeParse({ commandId: id(1), mode: "apply", items: [item(id(1))] }).success).toBe(
      false
    );
  });

  it("needs a command unless it only asks what an apply kept", () => {
    expect(changesetCommandSchema.safeParse({ commandId: id(1), mode: "apply", items: [] }).success).toBe(false);
    expect(changesetCommandSchema.safeParse({ commandId: id(1), mode: "apply", replay: true, items: [] }).success).toBe(
      true
    );
  });
});

describe("changesetFloor", () => {
  const update = (intent: number, extra: object = {}) => ({ intent, path: "/api/commands/action", ...extra });
  const create = (intent: number) => ({ ...update(intent), creates: { kind: "action", id: `a${intent}` } });
  const updates = (count: number) => Array.from({ length: count }, (_, index) => update(index));

  it("lets twenty updates through and floors the twenty-first", () => {
    expect(changesetFloor(updates(20))).toBeNull();
    const floored = changesetFloor(updates(21));
    expect(floored).toMatchObject({ changes: 21, touchesPeople: false });
    expect(floored?.reason).toContain("21");
    expect(floored?.reason).toContain("whole set");
  });

  it("does not count creates, however many", () => {
    const items = [...updates(20), ...Array.from({ length: 40 }, (_, index) => create(100 + index))];
    expect(changesetFloor(items)).toBeNull();
  });

  it("floors the whole set when any item touches people, even a small one", () => {
    const floored = changesetFloor([update(0), update(1, { touchesPeople: true })]);
    expect(floored).toMatchObject({ touchesPeople: true });
    expect(floored?.reason).toContain("another person");
  });

  it("names the intents a proposal cannot hold, so the set is split", () => {
    const session = { intent: 7, path: "/api/commands/session" };
    const floored = changesetFloor([...updates(21), session]);
    expect(floored?.unfileable).toEqual([7]);
    expect(floored?.reason).toContain("split");
  });
});
