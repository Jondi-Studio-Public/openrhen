import { describe, expect, it } from "vitest";
import { OWNER_ONLY_SETTINGS_FIELDS } from "@openrhen/contracts";
import { runWithActor } from "@/server/agent-actor";
import { ForbiddenCommandError } from "./command-errors";
import { saveEntity } from "./entity-commands";
import type { PoolSql } from "./sql-pool";

/**
 * The refusal happens before the first query, so an agent's settings save is turned away without a database.
 * The positive cases (a person, or an agent writing another field) are in settings-owner-only.integration.test.ts.
 */
const sql = new Proxy(() => undefined, {
  apply: () => {
    throw new Error("no query should run");
  }
}) as unknown as PoolSql;

const save = (entity: Record<string, unknown>) =>
  saveEntity(sql, {
    commandId: "11111111-1111-4111-8111-111111111111",
    type: "save_entity",
    expectedVersion: 1,
    entityType: "settings",
    entity
  });

describe("owner-only settings fields", () => {
  it.each(OWNER_ONLY_SETTINGS_FIELDS)(
    "refuses an agent that names %s, even with a value that looks unchanged",
    async (field) => {
      await expect(
        runWithActor("scribe", () => save({ timezone: "Europe/London", [field]: false }))
      ).rejects.toBeInstanceOf(ForbiddenCommandError);
      await expect(runWithActor("scribe", () => save({ [field]: null }))).rejects.toThrow(field);
    }
  );

  it("says where the person changes the fields, once per place", async () => {
    await expect(
      runWithActor("scribe", () =>
        save({ sharePrimaryEvents: true, calendarShareEnabled: true, pulsePublishEnabled: true })
      )
    ).rejects.toThrow(
      "Only the owner can change calendarShareEnabled, sharePrimaryEvents, pulsePublishEnabled; an agent cannot. " +
        "The person changes them in Settings > Family calendar sharing, Settings > Pulse."
    );
    await expect(runWithActor("scribe", () => save({ deliverableChatModel: "gpt-5" }))).rejects.toThrow(
      "The person changes it in Settings > AI models."
    );
  });

  it("refuses an agent proposal the owner confirmed too: no proposal may carry a data-flow field", async () => {
    await expect(runWithActor("scribe", () => save({ sharePrimaryEvents: true }), "owner")).rejects.toThrow(
      ForbiddenCommandError
    );
  });
});
