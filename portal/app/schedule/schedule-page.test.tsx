// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { freezeClock } from "@/shared/clock";

// 10:00 am Wednesday 19 August 2026 in the seed zone.
const NOW = new Date("2026-08-19T00:00:00.000Z");
const TZ = "Australia/Sydney";

const rule = {
  id: "weekly-class",
  title: "Weekly class",
  timezone: TZ,
  startDate: "2026-08-18",
  repeat: { unit: "days" as const, intervalDays: 7 },
  localStartTime: "09:00",
  localEndTime: "11:00",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  status: "active" as const,
  version: 3
};
const occurrence = {
  id: "class-26",
  title: "Weekly class",
  startsAt: "2026-08-25T23:00:00.000Z",
  endsAt: "2026-08-26T01:00:00.000Z",
  status: "confirmed" as const,
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  recurrenceRuleId: "weekly-class"
};

let context: Record<string, unknown>;
const saveCommitmentRecurrenceRuleCommand = vi.fn();
const saveEntityCommand = vi.fn();
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));
vi.mock("@/shared/navigate", () => ({ navigateTo: vi.fn() }));
freezeClock(NOW);

let matches = false;
function pageWith(overrides: Partial<PortalState> = {}) {
  const seed = createSeedState(NOW);
  const state = {
    ...seed,
    commitments: [occurrence],
    commitmentRecurrenceRules: [rule],
    routineSteps: [],
    sleepPlans: [],
    occurrences: [],
    completedToday: [],
    activeSession: null,
    planning: { status: "current" as const },
    ...overrides
  } as unknown as PortalState;
  context = {
    state,
    ready: true,
    saving: false,
    slots: [],
    allocations: [],
    recommendation: null,
    currentDirective: null,
    upcomingDirectives: [],
    saveEntityCommand,
    saveCommitmentRecurrenceRuleCommand
  };
  return state;
}

beforeEach(() => {
  window.matchMedia = ((query: string) =>
    ({
      // `matches` means "a desk": a width ceiling (the week's phone list) is then not met.
      matches: matches && !query.includes("max-width"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  window.localStorage.clear();
  saveCommitmentRecurrenceRuleCommand.mockReset().mockResolvedValue(undefined);
  saveEntityCommand.mockReset().mockResolvedValue(undefined);
});

/**
 * Editing a recurring commitment lives here now. It used to mean going to Today and finding the rule
 * in a panel that has since been deleted, which left the catalog's Edit button wired to nothing.
 */
describe("Schedule page", () => {
  it("shows the week grid over the catalog of rules", async () => {
    matches = true;
    pageWith();
    const { default: SchedulePage } = await import("./page");
    const { container } = render(<SchedulePage />);
    expect(container.querySelector(".week-timeline")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Recurring commitments" })).toBeTruthy();
    // The catalog is the target of Today's "Recurring commitments" link.
    expect(container.querySelector("section#recurring")).not.toBeNull();
  });

  it("has the week's heading as its only h1, with no heading of its own", async () => {
    matches = true;
    pageWith();
    const { default: SchedulePage } = await import("./page");
    render(<SchedulePage />);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((heading) => heading.textContent)).toEqual(["This week"]);
  });

  it("opens the rule in the one commitment editor, pre-filled from the rule", async () => {
    matches = true;
    pageWith();
    const { default: SchedulePage } = await import("./page");
    render(<SchedulePage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Weekly class" }));
    const form = screen.getByText("Edit recurring commitment").closest("details")!;
    expect((within(form).getByLabelText("Title") as HTMLInputElement).value).toBe("Weekly class");
    // The repeating half of the editor, because the draft came from a rule rather than a commitment.
    expect((within(form).getByLabelText("Repeats every (days)") as HTMLInputElement).value).toBe("7");
    expect((within(form).getByLabelText("First occurrence date") as HTMLInputElement).value).toBe("2026-08-18");
  });

  it("rises in a sheet on a phone rather than sitting inline", async () => {
    matches = false;
    pageWith();
    const { default: SchedulePage } = await import("./page");
    render(<SchedulePage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Weekly class" }));
    expect(screen.getByRole("dialog", { name: "Edit recurring commitment" })).toBeTruthy();
  });

  it("saves through the commitment-recurrence command, at the rule's expected version", async () => {
    matches = true;
    pageWith();
    const { default: SchedulePage } = await import("./page");
    render(<SchedulePage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Weekly class" }));
    const form = screen.getByText("Edit recurring commitment").closest("details")!;
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Weekly seminar" } });
    fireEvent.submit(form.querySelector("form")!);
    await vi.waitFor(() => expect(saveCommitmentRecurrenceRuleCommand).toHaveBeenCalledTimes(1));
    // A rule is not an entity command: the two routes write different tables.
    expect(saveEntityCommand).not.toHaveBeenCalled();
    expect(saveCommitmentRecurrenceRuleCommand.mock.calls[0]![0]).toMatchObject({
      expectedVersion: 3,
      rule: {
        id: "weekly-class",
        title: "Weekly seminar",
        timezone: TZ,
        repeat: { unit: "days", intervalDays: 7 },
        localStartTime: "09:00",
        localEndTime: "11:00",
        status: "active"
      }
    });
    // Saved means done: the editor closes rather than leaving a stale draft over the catalog.
    await vi.waitFor(() => expect(screen.queryByText("Edit recurring commitment")).toBeNull());
  });

  it("keeps the editor open and says why when the save is refused", async () => {
    matches = true;
    pageWith();
    saveCommitmentRecurrenceRuleCommand.mockRejectedValue(new Error("That rule changed. Reload before editing."));
    const { default: SchedulePage } = await import("./page");
    render(<SchedulePage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Weekly class" }));
    fireEvent.submit(screen.getByText("Edit recurring commitment").closest("details")!.querySelector("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That rule changed. Reload before editing.");
    expect(screen.getByText("Edit recurring commitment")).toBeTruthy();
  });

  it("refuses a stale save when the rule changed underneath an open editor", async () => {
    matches = true;
    const state = pageWith();
    const { default: SchedulePage } = await import("./page");
    const { rerender } = render(<SchedulePage />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Weekly class" }));
    expect(screen.getByText("Edit recurring commitment")).toBeTruthy();
    // A concurrent edit lands while the sheet is still open — the rule is now at version 4.
    context = { ...context, state: { ...state, commitmentRecurrenceRules: [{ ...rule, version: 4 }] } };
    rerender(<SchedulePage />);
    // The mock behaves like the server's optimistic-concurrency check: it only accepts the version
    // that is actually current.
    saveCommitmentRecurrenceRuleCommand.mockImplementation((command) =>
      command.expectedVersion === 4
        ? Promise.resolve()
        : Promise.reject(new Error("That rule changed. Reload before editing."))
    );
    fireEvent.submit(screen.getByText("Edit recurring commitment").closest("details")!.querySelector("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That rule changed. Reload before editing.");
    expect(screen.getByText("Edit recurring commitment")).toBeTruthy();
  });

  it("points each rule at the next occurrence it has actually materialized", async () => {
    matches = true;
    pageWith();
    const { default: SchedulePage } = await import("./page");
    render(<SchedulePage />);
    expect(screen.getByRole("link", { name: /^Next:/ }).getAttribute("href")).toBe("/commitments/class-26");
  });
});
