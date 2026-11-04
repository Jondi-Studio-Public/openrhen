import { describe, expect, it } from "vitest";
import { formatConnectionDateTime } from "./connection-date-time";

describe("formatConnectionDateTime", () => {
  it("joins the time to its am/pm with a no-break space and keeps the date readable", () => {
    const text = formatConnectionDateTime("2026-10-27T03:32:00.000Z", "Australia/Sydney");
    expect(text).toBe("27 Oct 2026, 2:32 pm");
  });

  it("accepts a Date and leaves no ordinary space before the meridiem", () => {
    const text = formatConnectionDateTime(new Date("2026-10-26T21:05:00.000Z"), "Australia/Sydney");
    expect(text).toBe("27 Oct 2026, 8:05 am");
    expect(text).not.toMatch(/\d [ap]m$/);
  });
});
