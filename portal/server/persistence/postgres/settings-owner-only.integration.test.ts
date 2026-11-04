import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { runWithActor } from "@/server/agent-actor";
import { ForbiddenCommandError } from "./command-errors";
import { setupStateStoreSuite, store } from "./state-store-harness";

/**
 * An agent cannot change the data-flow settings (who sees the plan, which model reads it), whatever value it
 * sends; it can still save the settings that are not on that list, and a person can save either.
 */
setupStateStoreSuite("openrhen_settings_owner_only");

async function saveSettings(entity: Record<string, unknown>) {
  const state = (await store.get())!;
  return store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: state.settings.version ?? null,
    type: "save_entity",
    entityType: "settings",
    entity
  });
}

describe("owner-only settings fields", () => {
  it("refuses an agent naming one, leaves the stored value, and still lets it save another field", async () => {
    await store.put(createSeedState(new Date()));
    await saveSettings({ sharePrimaryEvents: true });

    await expect(runWithActor("scribe", () => saveSettings({ sharePrimaryEvents: true }))).rejects.toBeInstanceOf(
      ForbiddenCommandError
    );
    await expect(runWithActor("scribe", () => saveSettings({ sharePrimaryEvents: false }))).rejects.toBeInstanceOf(
      ForbiddenCommandError
    );
    expect((await store.get())!.settings.sharePrimaryEvents).toBe(true);

    await runWithActor("scribe", () => saveSettings({ sessionBreakMinutes: 7 }));
    expect((await store.get())!.settings.sessionBreakMinutes).toBe(7);
  });

  it("lets a person (no agent identity) change one", async () => {
    await store.put(createSeedState(new Date()));
    await saveSettings({ sharePrimaryEvents: true });
    expect((await store.get())!.settings.sharePrimaryEvents).toBe(true);
  });
});
