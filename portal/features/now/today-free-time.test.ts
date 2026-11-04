import { describe, expect, it } from "vitest";
import type { ClientSlot } from "@/state/portal-provider";
import { todayFreeTime } from "./today-free-time";

const slot = (startsAt: string, minutes: number, availability: ClientSlot["availability"]): ClientSlot => ({
  id: startsAt,
  startsAt: new Date(startsAt),
  endsAt: new Date(new Date(startsAt).getTime() + minutes * 60_000),
  availability,
  energy: "medium",
  capacityMinutes: minutes
});

describe("todayFreeTime", () => {
  const now = new Date("2026-10-28T01:10:00Z"); // 12:10 pm in the seed zone
  it("counts the rest of today's awake slots, from now, and how many are free", () => {
    const result = todayFreeTime(
      [
        slot("2026-10-28T01:00:00Z", 15, "free"), // 5 minutes left of it
        slot("2026-10-28T01:15:00Z", 15, "fixed"),
        slot("2026-10-28T01:30:00Z", 15, "free"),
        slot("2026-10-28T12:00:00Z", 60, "unavailable"), // 11 pm: asleep
        slot("2026-10-28T14:00:00Z", 15, "free") // 1 am tomorrow
      ],
      now,
      "Australia/Sydney"
    );
    expect(result).toEqual({ freeMinutes: 20, awakeMinutes: 35 });
  });
  it("is null when nothing is left today", () => {
    expect(todayFreeTime([slot("2026-10-28T00:00:00Z", 15, "free")], now, "Australia/Sydney")).toBeNull();
  });
});
