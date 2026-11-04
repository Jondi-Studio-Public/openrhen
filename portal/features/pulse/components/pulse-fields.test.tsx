// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { fireEvent, render, screen, waitFor } from "@/test/render";
import { PulseThresholdsSection } from "@/features/settings/components/pulse-thresholds-section";
import { CheckInAllowanceField } from "./check-in-allowance-field";
import { PulseBadge } from "./pulse-badge";

const saveEntityCommand = vi.fn();
let settings: Record<string, unknown> = {};
vi.mock("@/state/portal-provider", async () => {
  const actual = await vi.importActual<object>("@/state/portal-provider");
  return {
    ...actual,
    usePortal: () => {
      const state = createSeedState(new Date("2026-10-28T00:00:00.000Z"));
      return {
        state: { ...state, settings: { ...state.settings, ...settings } },
        ready: true,
        saving: false,
        saveEntityCommand
      };
    }
  };
});

describe("PulseThresholdsSection", () => {
  it("shows each default and sends blank boxes as null", async () => {
    settings = {};
    saveEntityCommand.mockReset().mockResolvedValue(undefined);
    render(<PulseThresholdsSection />);
    expect(screen.getByText(/Default 30 minutes\./)).toBeTruthy();
    expect(screen.getByText(/Default 1\. After the first/)).toBeTruthy();
    expect(screen.getByText(/Default 60 minutes\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveEntityCommand).toHaveBeenCalled());
    expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
      entityType: "settings",
      entity: { pulseUnknownToOffMinutes: null, pulseFurtherPrompts: null, pulseUnknownHardOffMinutes: null }
    });
  });

  it("sends custom values, and refuses out-of-range or crossed numbers before saving", async () => {
    settings = { pulseUnknownToOffMinutes: 45 };
    saveEntityCommand.mockReset().mockResolvedValue(undefined);
    render(<PulseThresholdsSection />);
    const boxes = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(boxes[0]!.value).toBe("45");
    fireEvent.change(boxes[1]!, { target: { value: "99" } });
    expect(screen.getByText(/Between 0 and 10/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(boxes[1]!, { target: { value: "2" } });
    fireEvent.change(boxes[2]!, { target: { value: "30" } });
    expect(screen.getByText(/cap cannot be shorter/)).toBeTruthy();
    fireEvent.change(boxes[2]!, { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveEntityCommand).toHaveBeenCalled());
    expect(saveEntityCommand.mock.calls[0]![0].entity).toEqual({
      pulseUnknownToOffMinutes: 45,
      pulseFurtherPrompts: 2,
      pulseUnknownHardOffMinutes: 90
    });
  });
});

describe("CheckInAllowanceField", () => {
  it("shows the default, switches to a custom number and back to null", () => {
    const onChange = vi.fn();
    const { rerender } = render(<CheckInAllowanceField value={null} onChange={onChange} />);
    expect(screen.getByRole("option", { name: "Default (+15 min)" })).toBeTruthy();
    expect(screen.queryByLabelText("Check-in allowance in minutes")).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "custom" } });
    expect(onChange).toHaveBeenLastCalledWith(30);
    rerender(<CheckInAllowanceField value={20} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Check-in allowance in minutes"), { target: { value: "0" } });
    expect(onChange).toHaveBeenLastCalledWith(0);
    fireEvent.change(screen.getByLabelText("Check-in allowance in minutes"), { target: { value: "9999" } });
    expect(onChange).toHaveBeenLastCalledWith(480);
    fireEvent.change(screen.getByLabelText("Check-in allowance in minutes"), { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "default" } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

describe("PulseBadge", () => {
  it("renders nothing before the first read, and the words after", () => {
    const { container, rerender } = render(<PulseBadge pulse={undefined} />);
    expect(container.innerHTML).toBe("");
    rerender(
      <PulseBadge
        pulse={{
          state: "unknown",
          since: "2026-10-28T00:00:00.000Z",
          reason: "unconfirmed",
          private: false,
          shares: {
            today: { onPercent: null, countedMinutes: 0 },
            days7: { onPercent: null, countedMinutes: 0 },
            days30: { onPercent: null, countedMinutes: 0 }
          }
        }}
      />
    );
    expect(screen.getByText("Not sure what you're doing")).toBeTruthy();
  });
});
