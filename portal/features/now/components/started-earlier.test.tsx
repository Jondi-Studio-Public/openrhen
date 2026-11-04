// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import {
  StartedEarlier,
  startedAtFor,
  startedEarlierProblem,
  startLabel,
  type StartedEarlierChoice
} from "./started-earlier";

const now = new Date("2026-08-18T10:00:00.000Z");
const timezone = "Australia/Sydney";

describe("startedAtFor", () => {
  it("reads nothing as now, and a relative chip against the moment of asking", () => {
    expect(startedAtFor(null, now, timezone)).toBeUndefined();
    expect(startedAtFor({ kind: "ago", minutes: 10 }, now, timezone)).toBe("2026-08-18T09:50:00.000Z");
    expect(startedAtFor({ kind: "ago", minutes: 30 }, now, timezone)).toBe("2026-08-18T09:30:00.000Z");
  });

  it("reads a picked wall-clock time in the person's timezone, and nothing while the field is empty", () => {
    expect(startedAtFor({ kind: "at", value: "2026-08-18T19:15" }, now, timezone)).toBe("2026-08-18T09:15:00.000Z");
    expect(startedAtFor({ kind: "at", value: "" }, now, timezone)).toBeUndefined();
  });
});

describe("StartedEarlier", () => {
  function setup(choice: StartedEarlierChoice | null = null, before?: Date, floor?: Date) {
    const onChange = vi.fn();
    render(
      <StartedEarlier choice={choice} onChange={onChange} now={now} timezone={timezone} before={before} floor={floor} />
    );
    return onChange;
  }

  it("offers 10 min ago, 30 min ago and Pick a time", () => {
    const onChange = setup();
    fireEvent.click(screen.getByRole("button", { name: "10 min ago" }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "ago", minutes: 10 });
    fireEvent.click(screen.getByRole("button", { name: "30 min ago" }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "ago", minutes: 30 });
    fireEvent.click(screen.getByRole("button", { name: "Pick a time" }));
    expect(onChange).toHaveBeenLastCalledWith({ kind: "at", value: "" });
  });

  it("clears a chip that is pressed again", () => {
    const onChange = setup({ kind: "ago", minutes: 10 });
    const chip = screen.getByRole("button", { name: "10 min ago" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("shows a time field only once Pick a time is chosen, and passes what is typed", () => {
    const onChange = setup({ kind: "at", value: "" });
    fireEvent.change(screen.getByLabelText("It started at"), { target: { value: "2026-08-18T19:15" } });
    expect(onChange).toHaveBeenLastCalledWith({ kind: "at", value: "2026-08-18T19:15" });
  });

  it("hides the time field until it is asked for", () => {
    setup();
    expect(screen.queryByLabelText("It started at")).toBeNull();
  });

  it("offers only moments before the current start when moving a start already made", () => {
    setup(null, new Date("2026-08-18T09:45:00.000Z"));
    // Ten minutes ago is later than a 09:45 start; thirty is earlier.
    expect(screen.queryByRole("button", { name: "10 min ago" })).toBeNull();
    expect(screen.getByRole("button", { name: "30 min ago" })).toBeTruthy();
  });
});

describe("start floor", () => {
  it("disables a chip that would land before the floor, and keeps the others", () => {
    const onChange = vi.fn();
    render(
      <StartedEarlier
        choice={null}
        onChange={onChange}
        now={now}
        timezone={timezone}
        floor={new Date("2026-08-18T09:40:00.000Z")}
      />
    );
    // 09:50 is after the 09:40 floor; 09:30 is before it.
    expect((screen.getByRole("button", { name: "10 min ago" }) as HTMLButtonElement).disabled).toBe(false);
    const thirty = screen.getByRole("button", { name: "30 min ago" }) as HTMLButtonElement;
    expect(thirty.disabled).toBe(true);
    fireEvent.click(thirty);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("sets the picker's own minimum to the floor, or to 24 hours back when that is later", () => {
    const pick: StartedEarlierChoice = { kind: "at", value: "" };
    const { rerender } = render(
      <StartedEarlier
        choice={pick}
        onChange={vi.fn()}
        now={now}
        timezone={timezone}
        floor={new Date("2026-08-18T09:40:00.000Z")}
      />
    );
    const field = () => screen.getByLabelText("It started at") as HTMLInputElement;
    // 09:40Z is 19:40 in the seed zone.
    expect(field().min).toBe("2026-08-18T19:40");
    rerender(
      <StartedEarlier
        choice={pick}
        onChange={vi.fn()}
        now={now}
        timezone={timezone}
        floor={new Date("2026-08-10T09:40:00.000Z")}
      />
    );
    expect(field().min).toBe("2026-08-17T20:00");
  });

  it("rounds the picker's minimum up to the next minute and ignores an invalid floor", () => {
    const pick: StartedEarlierChoice = { kind: "at", value: "" };
    const { rerender } = render(
      <StartedEarlier
        choice={pick}
        onChange={vi.fn()}
        now={now}
        timezone={timezone}
        floor={new Date("2026-08-18T09:30:45.000Z")}
      />
    );
    const field = () => screen.getByLabelText("It started at") as HTMLInputElement;
    expect(field().min).toBe("2026-08-18T19:31");
    rerender(
      <StartedEarlier choice={pick} onChange={vi.fn()} now={now} timezone={timezone} floor={new Date("nope")} />
    );
    expect(field().min).toBe("2026-08-17T20:00");
  });

  it("says why a typed time cannot be used", () => {
    const floor = new Date("2026-08-18T09:40:00.000Z");
    // seed-zone is UTC+10 here, so 19:50 local is 09:50Z.
    expect(startedEarlierProblem({ kind: "at", value: "2026-08-18T19:50" }, now, timezone, floor)).toBeNull();
    expect(startedEarlierProblem({ kind: "at", value: "2026-08-18T19:30" }, now, timezone, floor)).toMatch(/before/);
    expect(startedEarlierProblem({ kind: "at", value: "2026-08-18T20:20" }, now, timezone, floor)).toBe(
      "That time is still ahead."
    );
    expect(startedEarlierProblem({ kind: "at", value: "2026-08-17T10:00" }, now, timezone)).toBe(
      "That is more than 24 hours ago."
    );
  });

  it("allows up to five minutes ahead, as the server does", () => {
    expect(startedEarlierProblem({ kind: "at", value: "2026-08-18T20:04" }, now, timezone)).toBeNull();
    expect(startedEarlierProblem({ kind: "at", value: "2026-08-18T20:06" }, now, timezone)).toBe(
      "That time is still ahead."
    );
  });

  it("shows the problem under the field", () => {
    render(
      <StartedEarlier
        choice={{ kind: "at", value: "2026-08-18T20:30" }}
        onChange={vi.fn()}
        now={now}
        timezone={timezone}
      />
    );
    expect(screen.getByRole("alert").textContent).toBe("That time is still ahead.");
  });
});

describe("startLabel", () => {
  it("names the chosen time on Start so a forgotten backdate is not silent", () => {
    expect(startLabel(undefined, timezone)).toBe("Start");
    expect(startLabel("2026-08-18T09:50:00.000Z", timezone)).toMatch(/^Start from 7:50 pm$/i);
  });
});

describe("moving a start already made", () => {
  it("accepts only a time earlier than the current start", () => {
    const before = new Date("2026-08-18T09:55:00.000Z");
    expect(startedEarlierProblem({ kind: "at", value: "2026-08-18T19:50" }, now, timezone, null, before)).toBeNull();
    expect(startedEarlierProblem({ kind: "at", value: "2026-08-18T19:55" }, now, timezone, null, before)).toMatch(
      /not earlier than the start/
    );
    expect(startedEarlierProblem({ kind: "at", value: "2026-08-18T19:58" }, now, timezone, null, before)).toMatch(
      /not earlier than the start/
    );
  });
});
