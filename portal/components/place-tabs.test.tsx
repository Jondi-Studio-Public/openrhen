// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { periodFor } from "@/features/review/planning-focus-period";
import { Tabs } from "./ui/tabs";
import { placeTabItems, placeTabMarks } from "./place-tabs";

/** A project with no deadline, so a week's focus can hold it while it is active. */
const undated = (seed: ReturnType<typeof createSeedState>, status: string) => {
  const { internalDeadlineAt: _internal, externalDeadlineAt: _external, ...project } = seed.projects[0]!;
  return { ...project, id: "p1", status } as (typeof seed.projects)[number];
};

describe("placeTabItems", () => {
  it("gives the week view Day and Week and marks Week", () => {
    const tabs = placeTabItems("/commitments/abc")!;
    expect(tabs.label).toBe("Day");
    expect(tabs.items.map((item) => [item.label, item.active])).toEqual([
      ["Day", false],
      ["Week", true]
    ]);
  });

  it("gives Plan its four tabs and carries the marks", () => {
    const tabs = placeTabItems("/review/focus", { "/deliverables": 4, "/review": "Due" })!;
    expect(tabs.items.map((item) => item.label)).toEqual(["Areas", "Deliverables", "Map", "Review"]);
    expect(tabs.items[1]).toMatchObject({ count: 4, active: false });
    expect(tabs.items[3]).toMatchObject({ badge: "Due", active: true });
  });

  it("is undefined outside Day and Plan", () => {
    expect(placeTabItems("/inbox")).toBeUndefined();
  });
});

describe("placeTabMarks", () => {
  const now = new Date("2026-10-28T09:00:00+11:00");

  it("counts open deliverables and says Review is due while the week has no focus", () => {
    const seed = createSeedState(now);
    const deliverable = {
      ...seed.deliverables[0]!,
      id: "d-open",
      status: "in_progress"
    } as (typeof seed.deliverables)[number];
    const marks = placeTabMarks({ ...seed, deliverables: [deliverable], planningFocus: [] }, now);
    expect(marks).toEqual({ "/deliverables": 1, "/review": "Due" });
  });

  it("drops both marks when nothing is open and this week's focus is chosen", () => {
    const seed = createSeedState(now);
    const week = periodFor("weekly", now, seed.settings.timezone);
    const marks = placeTabMarks(
      {
        ...seed,
        deliverables: [],
        projects: [undated(seed, "active")],
        planningFocus: [{ id: "w", kind: "weekly", periodStart: week.start, periodEnd: week.end, projectIds: ["p1"] }]
      },
      now
    );
    expect(marks).toEqual({ "/deliverables": undefined, "/review": undefined });
  });

  it("stays Due when the week's saved focus holds only a project that has since finished", () => {
    const seed = createSeedState(now);
    const week = periodFor("weekly", now, seed.settings.timezone);
    const other = { ...undated(seed, "active"), id: "p2" };
    const marks = placeTabMarks(
      {
        ...seed,
        projects: [undated(seed, "done"), other],
        planningFocus: [{ id: "w", kind: "weekly", periodStart: week.start, periodEnd: week.end, projectIds: ["p1"] }]
      },
      now
    );
    expect(marks["/review"]).toBe("Due");
  });

  it("drops Due once the week is marked reviewed, and when 'no focus' is saved", () => {
    const seed = createSeedState(now);
    const week = periodFor("weekly", now, seed.settings.timezone);
    const projects = [undated(seed, "active")].map((project) => ({ ...project, lastWorkedAt: now.toISOString() }));
    const focus = { id: "w", kind: "weekly" as const, periodStart: week.start, periodEnd: week.end };
    expect(
      placeTabMarks({ ...seed, projects, planningFocus: [{ ...focus, projectIds: [] }] }, now)["/review"]
    ).toBeUndefined();
    // Reviewed on a day when a step still shows: the week stays marked finished.
    expect(
      placeTabMarks(
        { ...seed, projects, planningFocus: [{ ...focus, projectIds: [], reviewedOn: "2026-10-27" }] },
        now
      )["/review"]
    ).toBeUndefined();
    const stale = [projects[0]!, { ...projects[0]!, id: "p2", lastWorkedAt: "2026-01-01T00:00:00.000Z" }];
    expect(
      placeTabMarks({ ...seed, projects: stale, planningFocus: [{ ...focus, projectIds: ["p1"] }] }, now)["/review"]
    ).toBe("Due");
    expect(
      placeTabMarks(
        { ...seed, projects: stale, planningFocus: [{ ...focus, projectIds: ["p1"], reviewedOn: "2026-10-27" }] },
        now
      )["/review"]
    ).toBeUndefined();
  });
});

describe("Tabs marks", () => {
  it("draws a count and a word beside their labels", () => {
    render(<Tabs label="Plan" items={placeTabItems("/plan", { "/deliverables": 4, "/review": "Due" })!.items} />);
    const nav = screen.getByRole("navigation", { name: "Plan" });
    expect(within(nav).getByRole("link", { name: /Deliverables/ }).textContent).toBe("Deliverables4");
    expect(within(nav).getByRole("link", { name: /Review/ }).textContent).toBe("ReviewDue");
    // The dot is drawn only where it is asked for: the Review tab has it.
    expect(
      within(nav)
        .getByRole("link", { name: /Review/ })
        .querySelector("[aria-hidden]")
    ).not.toBeNull();
    expect(within(nav).getByRole("link", { name: "Areas" }).getAttribute("aria-current")).toBe("page");
  });

  it("draws no dot on a badge that does not ask for one", () => {
    render(<Tabs label="Other" items={[{ href: "/x", label: "X", badge: "New", active: false }]} />);
    expect(
      within(screen.getByRole("navigation", { name: "Other" }))
        .getByRole("link")
        .querySelector("[aria-hidden]")
    ).toBeNull();
  });
});
