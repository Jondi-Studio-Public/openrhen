// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { StretchBlock, StretchOfferAnswer } from "@openrhen/contracts";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { StretchCard } from "./stretch-card";

const offer: StretchOfferAnswer = {
  actionId: "act-1",
  title: "Unit 3 reading",
  declaredEnergy: "low",
  requiredEnergy: "high",
  energyGap: 2,
  minutes: 45,
  cappedAtMinutes: 45,
  reason: "external_within_48h",
  externalDeadlineAt: "2026-11-05T23:00:00.000Z",
  latestSafeStartAt: null,
  text: "Unit 3 reading has an outside deadline on Fri 6 Nov, 09:00 and needs high energy; you said low. Both are reasonable.",
  endsAt: "2026-11-04T12:45:00.000Z",
  next: "Tell the person the text."
};
const TZ = "Australia/Brisbane";
const done = (outcome: "accepted" | "declined" | "declined_all") => ({
  state: null,
  revertible: "cmd-1",
  outcome
});

function setup(props: { offer?: StretchOfferAnswer | null; stretch?: StretchBlock | null } = {}) {
  const answer = vi.fn().mockResolvedValue(done("accepted"));
  const undo = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <StretchCard
      offer={props.offer === undefined ? offer : props.offer}
      stretch={props.stretch ?? null}
      timezone={TZ}
      answer={answer}
      undo={undo}
    />
  );
  return { answer, undo, ...view };
}

describe("StretchCard", () => {
  it("renders nothing without an offer, a stretch or a loan", () => {
    const { container } = setup({ offer: null });
    expect(container.textContent).toBe("");
  });

  it("shows the sentence and three equal choices", () => {
    setup();
    expect(screen.getByText(/needs high energy; you said low/)).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Work on it for up to 45 minutes",
      "Not this one",
      "No stretches tonight"
    ]);
    // Same look for all three: no primary emphasis on yes.
    expect(new Set(buttons.map((button) => button.className)).size).toBe(1);
    expect(document.body.textContent).not.toMatch(/anyway/i);
  });

  it("posts accept, decline and decline_all with the offered action", async () => {
    const { answer } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Work on it for up to 45 minutes" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ choice: "accept", actionId: "act-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Not this one" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ choice: "decline", actionId: "act-1" }));
    fireEvent.click(screen.getByRole("button", { name: "No stretches tonight" }));
    await waitFor(() => expect(answer).toHaveBeenCalledWith({ choice: "decline_all" }));
  });

  it("shows the running stretch with Undo after this tab accepted it, and undoes with the command id", async () => {
    const stretch: StretchBlock = {
      active: {
        actionId: "act-1",
        title: "Unit 3 reading",
        until: "2026-11-04T12:45:00.000Z",
        minutes: 45,
        by: "person"
      }
    };
    const answer = vi.fn().mockResolvedValue(done("accepted"));
    const undo = vi.fn().mockResolvedValue(undefined);
    const view = render(<StretchCard offer={offer} stretch={null} timezone={TZ} answer={answer} undo={undo} />);
    fireEvent.click(screen.getByRole("button", { name: /Work on it/ }));
    await waitFor(() => expect(answer).toHaveBeenCalled());
    view.rerender(<StretchCard offer={null} stretch={stretch} timezone={TZ} answer={answer} undo={undo} />);
    expect(screen.getByText(/Stretching on Unit 3 reading until 10:45 pm/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("cmd-1"));
  });

  it("shows a running stretch with no Undo when this tab does not hold the command id", () => {
    setup({
      offer: null,
      stretch: {
        active: { actionId: "a", title: "Unit 3 reading", until: "2026-11-04T12:45:00.000Z", minutes: 45, by: "agent" }
      }
    });
    expect(screen.getByText(/Stretching on Unit 3 reading until 10:45 pm/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("confirms a decline and lets it be undone", async () => {
    const answer = vi.fn().mockResolvedValue(done("declined_all"));
    const undo = vi.fn().mockResolvedValue(undefined);
    const view = render(<StretchCard offer={offer} stretch={null} timezone={TZ} answer={answer} undo={undo} />);
    fireEvent.click(screen.getByRole("button", { name: "No stretches tonight" }));
    await waitFor(() => expect(answer).toHaveBeenCalled());
    view.rerender(<StretchCard offer={null} stretch={null} timezone={TZ} answer={answer} undo={undo} />);
    expect(screen.getByText("No stretches tonight.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(undo).toHaveBeenCalledWith("cmd-1"));
    await waitFor(() => expect(screen.queryByText("No stretches tonight.")).toBeNull());
  });

  it("shows the second-stretch note with the offer and the loan line without one", () => {
    const note = "This would be your second stretch today; the earlier one began at 20:30.";
    const { unmount } = setup({
      stretch: { today: { count: 1, startedAt: ["20:30"], note } }
    });
    expect(screen.getByText(note)).toBeTruthy();
    unmount();
    setup({
      offer: null,
      stretch: {
        loan: {
          line: "Last night: 40 minutes of Unit 3, ended 23:10",
          actionId: "a",
          title: "Unit 3",
          minutes: 40,
          endedAt: "2026-11-04T13:10:00.000Z"
        }
      }
    });
    expect(screen.getByText("Last night: 40 minutes of Unit 3, ended 23:10.")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("says plainly when the answer was refused, and keeps the choices", async () => {
    const answer = vi.fn().mockRejectedValue(new Error("There is no stretch offer now."));
    render(<StretchCard offer={offer} stretch={null} timezone={TZ} answer={answer} undo={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Not this one" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("There is no stretch offer now.")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(3);
  });
});

describe("StretchCard refusals", () => {
  it("tells the person plainly, without tool names, and refreshes the stale offer", async () => {
    const { StretchRefusedError } = await import("@/features/now/stretch-client");
    const answer = vi.fn().mockRejectedValue(new StretchRefusedError());
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(<StretchCard offer={offer} stretch={null} timezone={TZ} answer={answer} undo={vi.fn()} refresh={refresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Not this one" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("That stretch is no longer on offer.");
    expect(document.body.textContent).not.toMatch(/rhen_|Next:/);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });
});
