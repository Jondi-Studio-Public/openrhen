// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { LetSomeoneKnow } from "./let-someone-know";

const openCaptureSheetMock = vi.fn();
vi.mock("@/shared/use-capture-sheet", () => ({
  openCaptureSheet: (...args: unknown[]) => openCaptureSheetMock(...args)
}));

let context: Record<string, unknown>;
vi.mock("@/state/portal-provider", async () => {
  const actual = await vi.importActual<object>("@/state/portal-provider");
  return { ...actual, usePortal: () => context };
});

const now = new Date("2026-09-04T00:00:00.000Z");
const baseState = createSeedState(now);

const commitment = {
  id: "commitment-dentist",
  title: "Dentist",
  startsAt: "2026-09-04T00:00:00.000Z", // 10:00 local
  endsAt: "2026-09-04T00:30:00.000Z",
  status: "confirmed"
};

function stateWith(overrides: Record<string, unknown> = {}, definitionOverrides: unknown[] = []) {
  return {
    ...baseState,
    settings: { ...baseState.settings, timezone: "Australia/Sydney" },
    commitments: [{ ...commitment, ...overrides }],
    conditionDefinitions: [
      { id: "sam", name: "Sam", kind: "contact", status: "active", channels: [] },
      ...definitionOverrides
    ]
  };
}

describe("LetSomeoneKnow", () => {
  it("names the resolved contact and opens the sheet with the contact and the about line", () => {
    context = { state: stateWith({ contactId: "sam" }) };
    render(<LetSomeoneKnow commitmentId="commitment-dentist" />);
    fireEvent.click(screen.getByRole("button", { name: "Let Sam know?" }));
    expect(openCaptureSheetMock).toHaveBeenCalledWith("disruption", {
      contactId: "sam",
      about: "Dentist at 10:00 am"
    });
  });

  it("passes why the offer was made, so the sheet can draft the message", () => {
    context = { state: stateWith({ contactId: "sam" }) };
    render(<LetSomeoneKnow commitmentId="commitment-dentist" reason="late" lateMinutes={6} />);
    fireEvent.click(screen.getByRole("button", { name: "Let Sam know?" }));
    expect(openCaptureSheetMock).toHaveBeenLastCalledWith("disruption", {
      contactId: "sam",
      about: "Dentist at 10:00 am",
      reason: "late",
      lateMinutes: 6
    });
  });

  it("falls back to generic wording and no contactId when the contact does not resolve", () => {
    context = { state: stateWith({ contactId: "" }) };
    render(<LetSomeoneKnow commitmentId="commitment-dentist" />);
    fireEvent.click(screen.getByRole("button", { name: "Let someone know?" }));
    expect(openCaptureSheetMock).toHaveBeenCalledWith("disruption", { about: "Dentist at 10:00 am" });
  });

  it("falls back to generic wording for an archived contact", () => {
    context = {
      state: stateWith({ contactId: "old" }, [{ id: "old", name: "Old", kind: "contact", status: "archived" }])
    };
    render(<LetSomeoneKnow commitmentId="commitment-dentist" />);
    expect(screen.getByRole("button", { name: "Let someone know?" })).toBeTruthy();
  });

  it("renders nothing when the commitment id is not found in state", () => {
    context = { state: stateWith({ contactId: "sam" }) };
    const { container } = render(<LetSomeoneKnow commitmentId="not-here" />);
    expect(container.innerHTML).toBe("");
  });
});
