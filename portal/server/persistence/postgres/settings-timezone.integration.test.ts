import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * An invalid IANA zone saved as the timezone setting makes every plan run throw in the engine and no
 * retry can fix it, so the save is refused (a 400 at the route) and the stored zone is left alone.
 */
setupStateStoreSuite("openrhen_settings_timezone");

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

async function storedTimezone(): Promise<string> {
  const userId = await ensureUser(sql);
  const rows = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
  return rows[0]!.timezone;
}

describe("settings timezone", () => {
  it("refuses a mistyped zone and keeps the stored one", async () => {
    await store.put(createSeedState(new Date()));
    await saveSettings({ timezone: "Australia/Sydney" });
    await expect(saveSettings({ timezone: "Australia/Sydeny" })).rejects.toThrow(InvalidCommandError);
    expect(await storedTimezone()).toBe("Australia/Sydney");
  });

  it("accepts a valid zone, including UTC", async () => {
    await store.put(createSeedState(new Date()));
    await saveSettings({ timezone: "Australia/Sydney" });
    expect(await storedTimezone()).toBe("Australia/Sydney");
    await saveSettings({ timezone: "UTC" });
    expect(await storedTimezone()).toBe("UTC");
  });

  it("leaves the zone alone when a page saves other settings only", async () => {
    await store.put(createSeedState(new Date()));
    await saveSettings({ timezone: "Australia/Sydney" });
    await saveSettings({ sharePrimaryEvents: true });
    expect(await storedTimezone()).toBe("Australia/Sydney");
  });

  it("stores the trimmed zone when a whole-state replacement carries a padded one", async () => {
    const seed = createSeedState(new Date());
    await store.put({ ...seed, settings: { ...seed.settings, timezone: "  Australia/Sydney \n" } });
    expect(await storedTimezone()).toBe("Australia/Sydney");
    expect((await store.get())!.settings.timezone).toBe("Australia/Sydney");
  });
});
