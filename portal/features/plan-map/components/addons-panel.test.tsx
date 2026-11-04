// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { planMap } from "@/features/plan-map/test-fixtures";
import { AddonsPanel } from "./addons-panel";

const optionValues = (label: string) =>
  Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((option) => option.value);

describe("Add-ons panel", () => {
  it("lists the five switches (no navigator and no always-on add-ons), all off by default", () => {
    render(<AddonsPanel map={planMap()} busy={false} error="" onChange={vi.fn()} />);
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    expect(selects).toHaveLength(5);
    expect(selects.every((select) => select.value === "off")).toBe(true);
    expect(screen.queryByLabelText("Navigator mode")).toBeNull();
    expect(screen.queryByLabelText("Proposers mode")).toBeNull();
    expect(screen.queryByText(/Shadow records what it would do and changes nothing/)).toBeNull();
    expect(screen.queryByText(/records what an add-on would do without changing anything/)).toBeNull();
  });

  it("offers only Off and On to the off/on-only add-ons and all three to the rest", () => {
    render(<AddonsPanel map={planMap()} busy={false} error="" onChange={vi.fn()} />);
    for (const label of ["Suggest subjects (AI)", "Needs-reply list"])
      expect(optionValues(`${label} mode`)).toEqual(["off", "on"]);
    for (const label of ["Suggest links automatically", "Deadline nudge (test only)", "Suggest a project for captures"])
      expect(optionValues(`${label} mode`)).toEqual(["off", "shadow", "on"]);
  });

  it("shows a stored shadow of an off/on-only add-on as its effective mode", () => {
    render(
      <AddonsPanel
        map={planMap({
          switches: [
            { addon: "jev_subjects", mode: "shadow" },
            { addon: "email_needs_reply", mode: "shadow" }
          ]
        })}
        busy={false}
        error=""
        onChange={vi.fn()}
      />
    );
    expect((screen.getByLabelText("Suggest subjects (AI) mode") as HTMLSelectElement).value).toBe("on");
    expect((screen.getByLabelText("Needs-reply list mode") as HTMLSelectElement).value).toBe("off");
  });

  it("reports a mode change and shows a configured switch", () => {
    const onChange = vi.fn();
    render(
      <AddonsPanel
        map={planMap({ switches: [{ addon: "nudge", mode: "shadow" }] })}
        busy={false}
        error=""
        onChange={onChange}
      />
    );
    const nudge = screen.getByLabelText("Deadline nudge (test only) mode") as HTMLSelectElement;
    expect(nudge.value).toBe("shadow");
    fireEvent.change(nudge, { target: { value: "on" } });
    expect(onChange).toHaveBeenCalledWith("nudge", "on");
  });

  it("disables the switches until the map has loaded and shows a save failure", () => {
    render(<AddonsPanel map={null} busy={false} error="The switch was not saved." onChange={vi.fn()} />);
    expect((screen.getAllByRole("combobox")[0] as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe("The switch was not saved.");
  });
});
