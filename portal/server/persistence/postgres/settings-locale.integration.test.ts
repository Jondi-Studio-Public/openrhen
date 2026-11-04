import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { InvalidCommandError } from "./command-errors";
import { ensureUser } from "./ensure-user";
import { setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * The date format (users.locale) and the reference-code pattern (user_preferences.plan_code_pattern): both save
 * through the settings command, a bad value is refused before any write, and a save naming neither leaves them alone.
 */
setupStateStoreSuite("openrhen_settings_locale");

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

async function stored(): Promise<{ locale: string; pattern: string | null }> {
  const userId = await ensureUser(sql);
  const rows = await sql<{ locale: string; plan_code_pattern: string | null }[]>`
    SELECT u.locale, p.plan_code_pattern FROM users u JOIN user_preferences p ON p.user_id = u.id WHERE u.id=${userId}`;
  return { locale: rows[0]!.locale, pattern: rows[0]!.plan_code_pattern };
}

describe("settings locale and code pattern", () => {
  it("stores a date format and reads it back in the state", async () => {
    await store.put(createSeedState(new Date()));
    await saveSettings({ locale: "en-US" });
    expect((await stored()).locale).toBe("en-US");
    expect((await store.get())!.settings.locale).toBe("en-US");
  });

  it("refuses another language or a pattern that repeats a group, and keeps what was stored", async () => {
    await store.put(createSeedState(new Date()));
    await saveSettings({ locale: "en-GB", planCodePattern: "[A-Z]{3}\\d{4}" });
    await expect(saveSettings({ locale: "fr-FR" })).rejects.toThrow(InvalidCommandError);
    await expect(saveSettings({ planCodePattern: "(a+)+" })).rejects.toThrow(InvalidCommandError);
    await expect(saveSettings({ locale: "en-US", planCodePattern: "(a+)+" })).rejects.toThrow(InvalidCommandError);
    expect(await stored()).toEqual({ locale: "en-GB", pattern: "[A-Z]{3}\\d{4}" });
  });

  it("clears the pattern on null, and a save naming neither field leaves both alone", async () => {
    await store.put(createSeedState(new Date()));
    await saveSettings({ locale: "en-NZ", planCodePattern: "[A-Z]{3}\\d{4}" });
    await saveSettings({ sharePrimaryEvents: true });
    expect(await stored()).toEqual({ locale: "en-NZ", pattern: "[A-Z]{3}\\d{4}" });
    await saveSettings({ planCodePattern: null });
    expect(await stored()).toEqual({ locale: "en-NZ", pattern: null });
    expect((await store.get())!.settings.planCodePattern).toBeUndefined();
  });
});
