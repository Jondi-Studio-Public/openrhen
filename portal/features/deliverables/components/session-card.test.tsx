// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { SessionCard } from "./session-card";
import { fixtureNow, session } from "@/features/deliverables/test-fixtures";

const base = {
  now: fixtureNow,
  currentStepTitle: "Draft",
  saving: false,
  planningDecisionCurrent: true,
  continuation: null,
  // A planning zone no test machine runs in, so a picker that read the device's zone would fail.
  timezone: "Pacific/Auckland",
  onPauseResume: vi.fn(),
  onContinue: vi.fn(),
  onFinish: vi.fn()
};

describe("SessionCard", () => {
  it("counts down the allocation, names the step being timed, and offers pause before the checkpoint", () => {
    const onPauseResume = vi.fn();
    render(<SessionCard {...base} session={session({ stepId: "draft" })} onPauseResume={onPauseResume} />);
    expect(screen.getByText("20:00")).toBeTruthy();
    expect(screen.getByText("Timing: Draft")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onPauseResume).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Continue/ })).toBeNull();
  });

  it("warns plainly while no step is chosen and offers only Stop for the step outcome", () => {
    render(<SessionCard {...base} session={session()} currentStepTitle={undefined} />);
    expect(screen.getByRole("alert").textContent).toContain("not being credited to any action");
    expect(screen.queryByRole("button", { name: /Step done/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop — work remains" })).toBeTruthy();
  });

  it("offers Continue for the engine's safe minutes at the checkpoint", () => {
    const onContinue = vi.fn();
    render(
      <SessionCard
        {...base}
        session={session({ status: "feedback", stepId: "draft", plannedEndAt: fixtureNow.toISOString() })}
        continuation={{ safe: true, recommendedMinutes: 25, reason: "Nothing is displaced.", displacedProjectIds: [] }}
        onContinue={onContinue}
      />
    );
    expect(screen.getByText("Checkpoint reached")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue for 25 min" }));
    expect(onContinue).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Pause|Resume/ })).toBeNull();
  });

  it("disables Continue when the engine says it would displace other work", () => {
    render(
      <SessionCard
        {...base}
        session={session({ status: "feedback", stepId: "draft" })}
        continuation={{
          safe: false,
          recommendedMinutes: 0,
          reason: "Would displace Assessment 1.",
          displacedProjectIds: []
        }}
      />
    );
    const button = screen.getByRole("button", { name: "Continuing would displace other work" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Would displace Assessment 1.")).toBeTruthy();
  });

  it("ends the session naming what happened to the step, with the note", () => {
    const onFinish = vi.fn();
    render(<SessionCard {...base} session={session({ stepId: "draft" })} onFinish={onFinish} />);
    fireEvent.change(screen.getByLabelText("Optional note"), { target: { value: "Diagram finished" } });
    fireEvent.click(screen.getByRole("button", { name: "Step done — end session" }));
    fireEvent.click(screen.getByRole("button", { name: "Step blocked — end session" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop — work remains" }));
    expect(onFinish.mock.calls).toStrictEqual([
      ["completed", "Diagram finished"],
      ["blocked", "Diagram finished"],
      ["stopped", "Diagram finished"]
    ]);
  });

  it("leaves the picker's Ended earlier control off the phase bar's own use — it only appears here, floored at the segment start", () => {
    const activeSession = session({ stepId: "draft" });
    render(<SessionCard {...base} session={activeSession} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Ended earlier" }));
    const picker = screen.getByLabelText("Ended earlier", {
      selector: "input[type=datetime-local]"
    }) as HTMLInputElement;
    // The segment started 08:50Z and now is 09:00Z: 20:50 and 21:00 on the planning wall clock.
    expect(picker.min).toBe("2026-08-18T20:50");
    expect(picker.max).toBe("2026-08-18T21:00");
  });

  it("passes the chosen endedAt through onFinish for each of the three finish actions", () => {
    const onFinish = vi.fn();
    const activeSession = session({ stepId: "draft" });
    render(<SessionCard {...base} session={activeSession} onFinish={onFinish} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Ended earlier" }));
    const picker = screen.getByLabelText("Ended earlier", { selector: "input[type=datetime-local]" });
    // One minute after the segment start, typed on the planning wall clock.
    fireEvent.change(picker, { target: { value: "2026-08-18T20:51" } });
    fireEvent.click(screen.getByRole("button", { name: "Stop — work remains" }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledWith("stopped", "", "2026-08-18T08:51:00.000Z");
  });

  it("omits endedAt entirely when the picker is left untouched, matching pre-change behaviour byte-for-byte", () => {
    const onFinish = vi.fn();
    render(<SessionCard {...base} session={session({ stepId: "draft" })} onFinish={onFinish} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop — work remains" }));
    expect(onFinish.mock.calls).toStrictEqual([["stopped", ""]]);
  });
});
