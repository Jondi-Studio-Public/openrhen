import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { InvalidCommandError } from "./command-errors";
import { fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * The contact messages design note: a contact's phone and email persist as typed, reach state, never
 * land on another kind, and are refused when they don't look like a phone number or an email.
 */
setupStateStoreSuite("openrhen_contact_messages");

const save = (entity: Record<string, unknown>, expectedVersion: number | null = null) =>
  store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion,
    type: "save_entity",
    entityType: "condition_definition",
    entity
  });

describe("contact phone and email", () => {
  it("round-trips a contact's phone and email, and clears them when emptied", async () => {
    await store.put(createSeedState(fixedNow));
    let state = await save({
      id: "sam",
      name: "Sam",
      kind: "contact",
      phone: "0400 123 456",
      email: "sam@example.com"
    });
    const sam = state.conditionDefinitions.find((entry) => entry.id === "sam");
    expect(sam?.phone).toBe("0400 123 456");
    expect(sam?.email).toBe("sam@example.com");
    state = await save({ id: "sam", name: "Sam", kind: "contact", phone: "", email: " " }, sam?.version ?? null);
    const cleared = state.conditionDefinitions.find((entry) => entry.id === "sam");
    expect(cleared?.phone).toBeUndefined();
    expect(cleared?.email).toBeUndefined();
  });

  it("never stores either on another kind", async () => {
    await store.put(createSeedState(fixedNow));
    await save({ id: "desk", name: "Desk", kind: "capability", phone: "0400123456", email: "x@example.com" });
    const rows = await sql<{ phone: string | null; email: string | null }[]>`
      SELECT phone, email FROM condition_definitions WHERE id = 'desk'
    `;
    expect(rows[0]).toEqual({ phone: null, email: null });
  });

  it("refuses a phone or email that doesn't look right", async () => {
    await store.put(createSeedState(fixedNow));
    await expect(save({ id: "sam", name: "Sam", kind: "contact", phone: "call me" })).rejects.toThrow(
      InvalidCommandError
    );
    await expect(save({ id: "sam", name: "Sam", kind: "contact", email: "sam@" })).rejects.toThrow(InvalidCommandError);
  });
});
