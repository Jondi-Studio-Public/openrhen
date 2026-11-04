// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setDisplayLocale } from "@/shared/locale";
import { connectionWhen } from "./connection-summaries";

const now = new Date("2026-11-03T22:00:00.000Z"); // 9:00 am on the 4th in the seed zone
const timeZone = "Australia/Sydney";

describe("connectionWhen display locale", () => {
  afterEach(() => setDisplayLocale(null));

  it("formats the same moments in the default locale", () => {
    expect(connectionWhen("2026-11-03T22:33:00.000Z", timeZone, now)).toBe("9:33 am");
    expect(connectionWhen("2026-11-15T01:00:00.000Z", timeZone, now)).toBe("15 Nov");
  });

  it("formats in en-US when that is the display locale", () => {
    setDisplayLocale("en-US");
    expect(connectionWhen("2026-11-03T22:33:00.000Z", timeZone, now)).toBe("9:33 am");
    expect(connectionWhen("2026-11-15T01:00:00.000Z", timeZone, now)).toBe("Nov 15");
  });
});
