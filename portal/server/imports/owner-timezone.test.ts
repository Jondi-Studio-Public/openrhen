import { beforeEach, describe, expect, it, vi } from "vitest";

const state = { stored: undefined as string | undefined, hasDb: true };

vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({
  sqlPool: () => async () => (state.stored === undefined ? [] : [{ timezone: state.stored }])
}));
vi.mock("@/server/runtime-env", () => ({
  databaseUrl: () => (state.hasDb ? "postgres://test" : undefined),
  runtimeEnv: () => ({})
}));

const { ownerTimezone } = await import("./calendar-sync");

describe("ownerTimezone", () => {
  beforeEach(() => {
    state.stored = undefined;
    state.hasDb = true;
  });

  it("prefers the stored zone, then APP_TIMEZONE, then the default", async () => {
    state.stored = "Europe/London";
    expect(await ownerTimezone({ APP_TIMEZONE: "America/New_York" })).toBe("Europe/London");
    state.stored = "  ";
    expect(await ownerTimezone({ APP_TIMEZONE: "America/New_York" })).toBe("America/New_York");
    state.hasDb = false;
    const { DEFAULT_TIMEZONE } = await vi.importActual<typeof import("@openrhen/contracts")>("@openrhen/contracts");
    expect(await ownerTimezone({ APP_TIMEZONE: " " })).toBe(DEFAULT_TIMEZONE);
  });
});
