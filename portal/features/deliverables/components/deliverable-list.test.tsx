// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { DeliverableList, deliverablesAnswer } from "./deliverable-list";
import { deliverable, session, step } from "@/features/deliverables/test-fixtures";

const projects = [{ id: "networking", title: "Networking unit" }] as never;

describe("DeliverableList", () => {
  it("lists every deliverable, started or not, as a row that opens it", () => {
    const onOpen = vi.fn();
    render(
      <DeliverableList
        deliverables={[
          deliverable({ id: "shell", title: "Assessment 3", status: "needs_breakdown", contractApprovedAt: undefined }),
          deliverable({ steps: [step("a", { status: "done" }), step("b", { remainingMinutes: 25 })] })
        ]}
        projects={projects}
        activeSession={null}
        timezone="Australia/Sydney"
        onOpen={onOpen}
      />
    );
    expect(screen.getByRole("button", { name: /^Assessment 3/ })).toBeTruthy();
    expect(screen.getByText(/1 of 2 actions done · 25 min remaining/)).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    expect(onOpen.mock.calls[0]![0].id).toBe("assessment-2");
  });

  it('does not say "needs breakdown" over actions that are already drafted', () => {
    render(
      <DeliverableList
        deliverables={[
          deliverable({
            id: "drafted",
            title: "Drafted",
            status: "needs_breakdown",
            contractApprovedAt: undefined,
            planApprovedAt: undefined,
            steps: [step("a"), step("b"), step("c")]
          }),
          deliverable({
            id: "backup",
            title: "Backup",
            status: "ready",
            contractApprovedAt: undefined,
            planApprovedAt: undefined,
            steps: [step("d")]
          })
        ]}
        projects={projects}
        activeSession={null}
        timezone="Australia/Sydney"
        onOpen={() => {}}
      />
    );
    expect(screen.getByText(/breakdown awaiting approval · 0 of 3 actions done/)).toBeTruthy();
    expect(screen.getByText(/breakdown awaiting approval · 0 of 1 action done/)).toBeTruthy();
    expect(screen.queryByText(/needs breakdown/)).toBeNull();
    expect(screen.queryByText(/^ready/)).toBeNull();
  });

  it("puts the deliverable in session first and marks it live", () => {
    render(
      <DeliverableList
        deliverables={[deliverable({ id: "other", title: "Other" }), deliverable()]}
        projects={projects}
        activeSession={session()}
        timezone="Australia/Sydney"
        onOpen={() => {}}
      />
    );
    const rows = screen.getAllByRole("button").map((node) => node.textContent ?? "");
    expect(rows[0]).toMatch(/^Assessment 2/);
    expect(rows[1]).toMatch(/^Other/);
    expect(screen.getByText("In session")).toBeTruthy();
    expect(rows[0]).toMatch(/Open session/);
  });

  it("flags a step that overran its estimate", () => {
    render(
      <DeliverableList
        deliverables={[deliverable({ steps: [step("a", { estimateNeedsReview: true })] })]}
        projects={projects}
        activeSession={null}
        timezone="Australia/Sydney"
        onOpen={() => {}}
      />
    );
    expect(screen.getByText(/estimate needs review/)).toBeTruthy();
  });

  it("says where deliverables come from when there are none", () => {
    render(
      <DeliverableList deliverables={[]} projects={projects} activeSession={null} timezone="UTC" onOpen={() => {}} />
    );
    expect(screen.getByText(/Register one in Plan/)).toBeTruthy();
    expect(screen.queryByText(/BCR/)).toBeNull();
  });

  it("keeps finished deliverables behind a toggle", () => {
    const onOpen = vi.fn();
    render(
      <DeliverableList
        deliverables={[deliverable({ id: "done", title: "Old work", status: "completed" }), deliverable()]}
        projects={projects}
        activeSession={null}
        timezone="Australia/Sydney"
        onOpen={onOpen}
      />
    );
    expect(screen.queryByText("Old work")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "1 finished deliverable" }));
    fireEvent.click(screen.getByRole("button", { name: /^Old work/ }));
    expect(onOpen.mock.calls[0]![0].id).toBe("done");
  });

  it("says when a deliverable is overdue", () => {
    render(
      <DeliverableList
        deliverables={[deliverable({ externalDeadlineAt: "2020-01-01T00:00:00.000Z" })]}
        projects={projects}
        activeSession={null}
        timezone="Australia/Sydney"
        onOpen={() => {}}
      />
    );
    expect(screen.getByText(/Overdue/)).toBeTruthy();
  });
});

describe("deliverablesAnswer", () => {
  const now = new Date("2026-10-26T00:00:00.000Z").getTime();
  it("names the next deadline this week", () => {
    const item = deliverable({ externalDeadlineAt: "2026-10-27T10:00:00.000Z" });
    expect(deliverablesAnswer([item], now, "Australia/Sydney")).toBe("1 deliverable open; Assessment 2 is due Tue.");
  });
  it("says nothing is due when the deadline is far off or absent", () => {
    const item = deliverable({ externalDeadlineAt: "2026-12-27T10:00:00.000Z" });
    expect(deliverablesAnswer([item], now, "UTC")).toBe("1 deliverable open; nothing is due this week.");
    expect(deliverablesAnswer([], now, "UTC")).toBe("No open deliverables.");
  });
});
