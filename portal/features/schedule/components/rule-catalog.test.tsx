// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { StoredCommitment, StoredCommitmentRecurrenceRule, StoredProject } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { RuleCatalog } from "./rule-catalog";

const TZ = "Australia/Sydney";
const now = new Date("2026-08-19T00:00:00.000Z");

const occurrence = (overrides: Partial<StoredCommitment>): StoredCommitment =>
  ({
    id: "occ-1",
    title: "Weekly class",
    startsAt: "2026-08-25T23:00:00.000Z",
    endsAt: "2026-08-26T01:00:00.000Z",
    status: "confirmed",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    recurrenceRuleId: "weekly-class",
    ...overrides
  }) as unknown as StoredCommitment;

const rule = (
  overrides: Partial<StoredCommitmentRecurrenceRule> & { intervalDays?: number } = {}
): StoredCommitmentRecurrenceRule => {
  const { intervalDays, ...rest } = overrides;
  return {
    id: "weekly-class",
    title: "Weekly class",
    timezone: "Australia/Sydney",
    startDate: "2026-08-18",
    repeat: { unit: "days" as const, intervalDays: intervalDays ?? 7 },
    localStartTime: "09:00",
    localEndTime: "11:00",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    status: "active",
    ...rest
  } as unknown as StoredCommitmentRecurrenceRule;
};

const projects = [{ id: "study", title: "Semester two" }] as unknown as StoredProject[];

describe("Recurring commitments catalog", () => {
  it("says so when there are no active rules, and shows no ended group at all", () => {
    render(<RuleCatalog rules={[]} projects={projects} />);
    expect(screen.getByText("No recurring commitments")).toBeTruthy();
    expect(screen.getByText("0 active")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("is the section other pages link to, headed with how many rules are active", () => {
    const { container } = render(<RuleCatalog rules={[rule({ id: "a" }), rule({ id: "b" })]} projects={projects} />);
    expect(container.querySelector("section#recurring")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recurring commitments" })).toBeTruthy();
    expect(screen.getByText("2 active")).toBeTruthy();
  });

  it("lists active rules first and puts ended ones under their own counted heading", () => {
    render(
      <RuleCatalog
        rules={[rule({ id: "ended-one", title: "Old class", status: "ended" }), rule({ id: "active-one" })]}
        projects={projects}
      />
    );
    expect(screen.getByText("1 active")).toBeTruthy();
    const heading = screen.getByRole("heading", { level: 3, name: "Ended · 1" });
    const active = screen.getByText("Weekly class");
    const ended = screen.getByText("Old class");
    expect(active.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(ended) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still lists ended rules when none is active", () => {
    render(<RuleCatalog rules={[rule({ id: "old", title: "Old class", status: "ended" })]} projects={projects} />);
    expect(screen.getByText("No recurring commitments")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 3, name: "Ended · 1" })).toBeTruthy();
    expect(screen.getByText("Old class")).toBeTruthy();
  });

  it("describes a daily rule and a weekly one through the shared cadence renderer", () => {
    render(
      <RuleCatalog rules={[rule({ id: "daily", intervalDays: 1 }), rule({ id: "weekly" })]} projects={projects} />
    );
    expect(screen.getByText(/every day ·/)).toBeTruthy();
    expect(screen.getByText(/every week ·/)).toBeTruthy();
  });

  it("gives the rule's hours on the same 12-hour clock as the week above it", () => {
    render(<RuleCatalog rules={[rule({ id: "weekly" })]} projects={projects} />);
    expect(screen.getByText(/· 9:00 am–\d{1,2}:\d{2} (am|pm)/)).toBeTruthy();
  });

  it("names the rule's project on the summary line", () => {
    render(<RuleCatalog rules={[rule({ projectId: "study" })]} projects={projects} />);
    expect(screen.getByText(/Semester two/)).toBeTruthy();
  });

  // A rule is not a thing on the calendar and has no page of its own; the row used to link to one
  // that was never built. Only a materialized occurrence has an id worth opening.
  it("links to no rule page at all — every link on a row goes to a real commitment", () => {
    render(
      <RuleCatalog
        rules={[rule({ projectId: "study" })]}
        projects={projects}
        commitments={[occurrence({})]}
        timezone={TZ}
        now={now}
      />
    );
    for (const link of screen.getAllByRole("link")) expect(link.getAttribute("href")).toMatch(/^\/commitments\//);
  });

  it("has no Edit affordance when onEdit is not supplied", () => {
    render(<RuleCatalog rules={[rule({})]} projects={projects} />);
    expect(screen.queryByRole("button", { name: /^Edit/ })).toBeNull();
  });

  describe("the next occurrence", () => {
    it("links the soonest one the rule has materialized, by the date it falls on", () => {
      render(
        <RuleCatalog
          rules={[rule({})]}
          projects={projects}
          commitments={[
            occurrence({ id: "far", startsAt: "2026-09-01T23:00:00.000Z" }),
            occurrence({ id: "near", startsAt: "2026-08-25T23:00:00.000Z" })
          ]}
          timezone={TZ}
          now={now}
        />
      );
      const link = screen.getByRole("link", { name: /^Next:/ });
      expect(link.getAttribute("href")).toBe("/commitments/near");
      // seed-zone is ahead of UTC: 11 pm on the 25th is already the 26th where the day is lived.
      expect(link.textContent).toBe("Next: Wednesday, 26 August");
    });

    it("ignores occurrences that have started, been cancelled, or belong to another rule", () => {
      render(
        <RuleCatalog
          rules={[rule({})]}
          projects={projects}
          commitments={[
            occurrence({ id: "past", startsAt: "2026-08-11T23:00:00.000Z" }),
            occurrence({ id: "dropped", startsAt: "2026-08-20T23:00:00.000Z", status: "cancelled" }),
            occurrence({ id: "other", startsAt: "2026-08-21T23:00:00.000Z", recurrenceRuleId: "something-else" }),
            occurrence({ id: "keeper", startsAt: "2026-08-25T23:00:00.000Z" })
          ]}
          timezone={TZ}
          now={now}
        />
      );
      expect(screen.getByRole("link", { name: /^Next:/ }).getAttribute("href")).toBe("/commitments/keeper");
    });

    it("says nothing when the rule has materialized nothing ahead, as an ended one has not", () => {
      render(
        <RuleCatalog
          rules={[rule({ id: "old", status: "ended" })]}
          projects={projects}
          commitments={[occurrence({ id: "past", recurrenceRuleId: "old", startsAt: "2026-08-11T23:00:00.000Z" })]}
          timezone={TZ}
          now={now}
        />
      );
      expect(screen.queryByRole("link", { name: /^Next:/ })).toBeNull();
    });
  });

  it("hands the whole rule back when Edit is pressed", () => {
    const onEdit = vi.fn();
    const item = rule({ projectId: "study" });
    render(<RuleCatalog rules={[item]} projects={projects} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Weekly class" }));
    expect(onEdit).toHaveBeenCalledWith(item);
  });

  it("shows a shared marker when the rule is marked for family calendar sharing", () => {
    render(<RuleCatalog rules={[rule({ shareToCalendar: true })]} projects={projects} />);
    expect(screen.getByText("Shared")).toBeTruthy();
  });

  it("does not show a shared marker when the rule is not marked for sharing", () => {
    render(<RuleCatalog rules={[rule({ shareToCalendar: false })]} projects={projects} />);
    expect(screen.queryByText("Shared")).toBeNull();
  });

  it("shows a private marker when the rule is marked private", () => {
    render(<RuleCatalog rules={[rule({ private: true })]} projects={projects} />);
    expect(screen.getByText("Private")).toBeTruthy();
  });

  it("does not show a private marker when the rule is not private", () => {
    render(<RuleCatalog rules={[rule({ private: false })]} projects={projects} />);
    expect(screen.queryByText("Private")).toBeNull();
  });
});
