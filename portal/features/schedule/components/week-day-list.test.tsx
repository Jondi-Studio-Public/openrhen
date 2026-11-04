// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import type { WeekPlan } from "@/features/schedule/week-plan";
import { WeekDayList } from "./week-day-list";

const item = (id: string, kind: string, title: string) => ({ id, kind, title });

function weekOf(daysItems: Array<Array<ReturnType<typeof item>>>): WeekPlan {
  return {
    anchorDayKey: "2026-08-19",
    days: daysItems.map((items, index) => {
      const startsAt = new Date(Date.UTC(2026, 7, 18 + index, 14));
      return {
        dayKey: `2026-08-${19 + index}`,
        plan: { nowAt: index === 0 ? 1 : null, items, bounds: { startsAt, endsAt: new Date(+startsAt + 864e5) } }
      };
    })
  } as unknown as WeekPlan;
}

function renderList(week: WeekPlan) {
  return render(
    <WeekDayList
      week={week}
      timezone="Australia/Sydney"
      todayKey="2026-08-19"
      free={week.days.map(() => 120)}
      due={week.days.map(() => [])}
    />
  );
}

describe("WeekDayList preview", () => {
  it("shows the first three non-routine items and skips routine steps", () => {
    renderList(
      weekOf([
        [
          item("r1", "routine_step", "Glass of water and meds"),
          item("a", "commitment", "Dentist"),
          item("r2", "routine_step", "Stretch"),
          item("b", "planned", "Write report"),
          item("c", "occurrence", "Call Sam"),
          item("d", "planned", "Tidy desk"),
          item("e", "planned", "Laundry")
        ]
      ])
    );
    expect(screen.getByText("Dentist · Write report · Call Sam · +2 more")).toBeTruthy();
    expect(screen.queryByText(/Glass of water/)).toBeNull();
    expect(screen.getByText(/7 items/)).toBeTruthy();
  });

  it("says so when a day holds only routine steps", () => {
    renderList(weekOf([[item("r1", "routine_step", "Glass of water and meds")]]));
    expect(screen.getByText("Routine only")).toBeTruthy();
  });
});
